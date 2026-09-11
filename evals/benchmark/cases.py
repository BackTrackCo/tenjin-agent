"""Case records for the search-intent experiment (tenjin-notes `loop-redesign/14-search-intent.md`).

`python3 -m evals.benchmark.cli cases --run <dir> --tenjin-source <dir> --out <file.jsonl>`
reads a settled run and writes one JSONL record per hook fire that carried a
question or a question key: the prompt as fired, or for a failure fire the
command head and error line the ledger holds as the observed situation packet,
the context the benchmark knows about the trial, the baseline's own outcome
from the ledger, and the shelf's shortlist for the same question (post-floor,
top ten). Human labels are not filled in here; the schema note says what a
labeller writes.

The shortlist comes from the trial's own `output/shortlist.json` where the arm
took one at stop, and only otherwise from a `tenjin search` run here.
`replay.source` says which: `in_run_snapshot` or `post_run_replay`. The
preference is the whole point. The seeded pieces are deleted when a trial
stops, so a search run after the run cannot return one and measures precision
alone; only the in-run snapshot can say whether the right piece was there.

A run whose manifest file is gone or has since been rewritten is still
exportable, on the hash the run recorded for it (`cli.load_run`). The fields
only the manifest knew are then empty and `revisions.manifest_body_absent`
says why; nothing is read out of a file that hashes to something else.

It runs only after settlement: a live process from the run or a live WAL on a
trial ledger is a refusal, never a read. Seeded pieces are marked apart from
real ones, by the trial's own `isolation.seed` ids, so a seeded positive is
reported separately as the plan asks. Nothing here changes a record.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import time
from pathlib import Path
from typing import Any, Callable

from . import loop_join, records, tenjin_arm
from .manifest import Manifest

SEARCH_LIMIT = tenjin_arm.SEARCH_LIMIT
METHOD = "baseline"
SNAPSHOT = "in_run_snapshot"
REPLAY = "post_run_replay"
KEY_ONLY = "the fire carried a key and no question text; a keys resolve is not a search"
LABELS_SCHEMA = (
    "human-supplied after reading the candidate bodies: applicable | not_applicable | ambiguous, "
    "with a reason; titles alone are not ground truth, and an empty applicable set is a valid label"
)
FIRE_COLUMNS = ("id", "at", "session", "agent", "arm", "harness", "event", "prompt_id", "reason", "question_key", "question", "delivered", "error")
LEG_COLUMNS = ("stage", "shelf", "status", "outcome", "elapsed_ms", "search_id", "title", "url", "form", "calibration")
PAIRING_COLUMNS = ("kind", "key", "cmd_head", "cmd", "error_line", "error_files", "status", "post_id")

Replay = Callable[[str], dict[str, Any]]


class CasesError(RuntimeError):
    pass


FILE_NAME_RE = re.compile(r"[A-Za-z0-9_./-]*[A-Za-z0-9_-]+\.[A-Za-z0-9]{1,5}\b")


def shared_file_names(prompt: str, body: str) -> list[str]:
    """File names (and their stems) the prompt names that the body also names: what lets a search vouch a piece on words alone."""
    names = set()
    for match in FILE_NAME_RE.findall(prompt):
        base = match.split("/")[-1]
        names.add(base.lower())
        names.add(base.split(".")[0].lower())
    lowered = body.lower()
    return sorted(name for name in names if name and name in lowered)


def _mask(value: Any, secrets: tuple[str, ...], home: str) -> Any:
    """Every string in the record with the shelf secret and the home path removed."""
    if isinstance(value, str):
        for secret in secrets:
            if secret:
                value = value.replace(secret, "[secret]")
        return value.replace(home, "~") if len(home) > 1 else value
    if isinstance(value, dict):
        return {key: _mask(item, secrets, home) for key, item in value.items()}
    if isinstance(value, list):
        return [_mask(item, secrets, home) for item in value]
    return value


def refuse_live(run_dir: Path, trial_ids: list[str]) -> None:
    """After settlement only: no live WAL on any trial ledger.

    The WAL is the settlement fact this export depends on, and it is per trial.
    A run that is still going has one; a run whose harness died has none, and
    the questions it recorded are as replayable as any other.
    """
    for trial_id in trial_ids:
        if loop_join.wal_live(run_dir / "trials" / trial_id / "data" / "loop.db"):
            raise CasesError(f"trial {trial_id} has a live loop.db WAL: settlement has not completed")


def ledger(loop_db: Path) -> dict[str, Any] | None:
    """The trial's fires, their legs, and the pairings by key, read only; None when the trial has no ledger."""
    if not loop_db.is_file():
        return None
    uri = f"file:{loop_db.resolve().as_posix()}?mode=ro&immutable=1"
    connection = sqlite3.connect(uri, uri=True)
    try:
        connection.row_factory = sqlite3.Row
        fires = [dict(row) for row in connection.execute(f"SELECT {', '.join(FIRE_COLUMNS)} FROM fires ORDER BY at, id")]
        legs: dict[str, list[dict[str, Any]]] = {}
        for row in connection.execute(f"SELECT fire_id, {', '.join(LEG_COLUMNS)} FROM legs ORDER BY fire_id, stage, shelf"):
            legs.setdefault(row["fire_id"], []).append({name: row[name] for name in LEG_COLUMNS})
        pairings: dict[str, list[dict[str, Any]]] = {}
        try:
            for row in connection.execute(f"SELECT {', '.join(PAIRING_COLUMNS)} FROM pairings ORDER BY at, id"):
                pairings.setdefault(row["key"], []).append({name: row[name] for name in PAIRING_COLUMNS})
        except sqlite3.Error:
            pairings = {}
    except sqlite3.Error as error:
        raise CasesError(f"cannot read {loop_db}: {error}") from error
    finally:
        connection.close()
    return {"fires": fires, "legs": legs, "pairings": pairings}


def situation(fire: dict[str, Any], pairings: dict[str, list[dict[str, Any]]]) -> dict[str, Any] | None:
    """A failure fire's observed situation: the command head and the error line the pairing row kept, each with its source."""
    key = fire.get("question_key")
    rows = pairings.get(key or "", [])
    if not rows:
        return None if fire.get("event") != "tool.after" and fire.get("arm") != "failure" else {"command_head": None, "command": None, "error_line": None, "source": "no pairings row for the fire's question_key"}
    row = rows[-1]
    return {
        "command_head": row["cmd_head"],
        "command": row["cmd"],
        "error_line": row["error_line"],
        "error_files": row["error_files"],
        "key_kind": row["kind"],
        "source": {"command_head": "pairings.cmd_head", "command": "pairings.cmd", "error_line": "pairings.error_line", "key": "fires.question_key = pairings.key"},
    }


def delivered_piece(delivered: Any) -> str | None:
    """`fires.delivered` is `<shelf>:<resource id>`; the id half, or None."""
    if not isinstance(delivered, str) or ":" not in delivered:
        return None
    return delivered.split(":", 1)[1] or None


def baseline_outcome(fire: dict[str, Any], legs: list[dict[str, Any]], seeded: set[str]) -> dict[str, Any]:
    sent = [leg for leg in legs if leg.get("status") != loop_join.SKIPPED]
    ranked = [leg for leg in sent if leg.get("title")]
    piece = delivered_piece(fire.get("delivered"))
    return {
        "reason": fire.get("reason"),
        "delivered": fire.get("delivered"),
        "delivered_piece_id": piece,
        "delivered_seeded": piece in seeded if piece is not None else None,
        "rank1_title": ranked[0]["title"] if ranked else None,
        "legs": [
            {name: leg.get(name) for name in ("stage", "shelf", "status", "outcome", "title", "calibration", "search_id", "elapsed_ms")}
            for leg in sent
        ],
        "hit": any(leg.get("outcome") == loop_join.HIT for leg in sent),
        "source": "fires and legs rows of the trial's loop.db",
    }


def replay_search(source: tenjin_arm.Source, question: str) -> dict[str, Any]:
    """The same question through `tenjin search --json --limit 10` on the source data dir's shelf, now: the shelf without the seeded pieces."""
    return tenjin_arm.search_shortlist(source, question)


def snapshot_of(run_dir: Path, trial_id: str) -> dict[tuple[str, Any], dict[str, Any]]:
    """The trial's own in-run shortlist keyed by the question and question key it was taken for, or empty when the trial left none.

    An unreadable or malformed file is empty rather than a refusal: the fall
    back is a replay, which is what every run before the snapshot had.
    """
    path = run_dir / "trials" / trial_id / "output" / tenjin_arm.SHORTLIST_FILE
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    entries = payload.get("entries") if isinstance(payload, dict) else None
    found = {}
    for entry in entries if isinstance(entries, list) else []:
        if isinstance(entry, dict) and isinstance(entry.get("search"), dict) and entry.get("question"):
            found.setdefault((entry["question"], entry.get("question_key")), entry)
    return found


def tokens_of(record: dict[str, Any]) -> int | None:
    usage = record.get("usage")
    if not isinstance(usage, list):
        return None
    total = 0
    for row in usage:
        if isinstance(row, dict):
            total += int(row.get("input_total", 0) or 0) + int(row.get("output_total", 0) or 0)
    return total


def trial_cases(manifest: Manifest, run_dir: Path, nonce: str | None, record: dict[str, Any], shelf_origin: str | None) -> list[dict[str, Any]]:
    """Every case one accepted attempt yields, without the replay."""
    trial_id = record["trial_id"]
    rows = ledger(run_dir / "trials" / trial_id / "data" / "loop.db")
    if rows is None:
        return []
    # A run whose manifest body is gone keeps every field the ledger and the
    # record hold; what the manifest alone knew is empty and says so, rather
    # than being guessed from a file that is now a different manifest.
    task: dict[str, Any] = {"id": record["task_id"]}
    arm: dict[str, Any] = {"id": record["arm_id"]}
    pins: dict[str, Any] = {}
    if manifest.absent is None:
        task = next(item for item in manifest.tasks if item["id"] == record["task_id"])
        arm = next(item for item in manifest.arms if item["id"] == record["arm_id"])
        pins = manifest.pins
    isolation = record.get("isolation", {})
    seeds = isolation.get("seed") or []
    seeded_ids = {seed["piece_id"] for seed in seeds if seed.get("piece_id")}
    cases = []
    for fire in rows["fires"]:
        question = fire.get("question")
        key = fire.get("question_key")
        if not question and not key:
            continue
        failure = fire.get("arm") == "failure"
        packet = {
            "fixture": task["id"],
            "fixture_hash": task.get("fixture_hash"),
            "family": task.get("family"),
            "transfer_distance": task.get("transfer_distance"),
            "situation": situation(fire, rows["pairings"]) if failure else None,
            "runner": {
                "package_manager": isolation.get("package_manager"),
                "vendor": task.get("vendor"),
                "harness_version": pins.get("harness_version"),
                "model": pins.get("model"),
            },
        }
        cases.append(
            {
                "case_id": f"{nonce or 'no-nonce'}:{trial_id}:{fire['id']}",
                "source": {
                    "trial_id": trial_id,
                    "arm_id": record["arm_id"],
                    "task_id": record["task_id"],
                    "harness": record.get("harness"),
                    "fire_id": fire["id"],
                    "fire_event": fire.get("event"),
                    "hook_arm": fire.get("arm"),
                    "session": fire.get("session"),
                    "agent": fire.get("agent"),
                },
                "trigger": "failure" if failure else str(fire.get("arm")),
                "prompt": {"text": question, "question_key": key, "source": "fires.question / fires.question_key"},
                "context_packet": packet,
                "human_label": None,
                "labels_schema": LABELS_SCHEMA,
                "corpus_snapshot": {"shelf_origin": shelf_origin, "post_floor": True, "limit": SEARCH_LIMIT, "replayed_at": None},
                "revisions": {
                    "benchmark_version": manifest.data.get("benchmark_version"),
                    "manifest_hash": manifest.hash,
                    "manifest_body_absent": manifest.absent,
                    "schedule_hash": record.get("schedule_hash"),
                    "product_version": arm.get("product_version"),
                    "run_nonce": nonce,
                },
                "method": METHOD,
                "seeded_piece_ids": sorted(seeded_ids),
                "baseline": baseline_outcome(fire, rows["legs"].get(fire["id"], []), seeded_ids),
                "replay": None,
                "attempt": {
                    "outcome": record.get("outcome"),
                    "tokens": tokens_of(record),
                    "cost_usd": record.get("cost_usd"),
                    "wall_time_s": record.get("wall_time_s"),
                    "turns": record.get("turns"),
                },
            }
        )
    return cases


def export(
    manifest: Manifest,
    schedule_hash: str,
    run_dir: Path,
    out: Path | None,
    source: tenjin_arm.Source | None,
    *,
    dry_run: bool = False,
    replay: Replay | None = None,
    now: Callable[[], float] = time.time,
) -> dict[str, Any]:
    """Every case of the run, replayed through the shelf unless this is a dry run, written as JSONL."""
    accepted, _ = records.select(run_dir / "records", manifest.hash, schedule_hash)
    refuse_live(run_dir, sorted(accepted))
    try:
        nonce = json.loads((run_dir / "manifest.json").read_text(encoding="utf-8")).get("nonce")
    except (OSError, json.JSONDecodeError, AttributeError):
        nonce = None
    shelf_origin = None if source is None else source.shelf_origin
    secrets = () if source is None else source.secrets
    home = os.path.expanduser("~")
    cases: list[dict[str, Any]] = []
    for trial_id in sorted(accepted):
        cases.extend(trial_cases(manifest, run_dir, nonce, accepted[trial_id], shelf_origin))
    seeded_candidates = 0
    from_snapshot = 0
    if not dry_run:
        if source is None:
            raise CasesError("replaying the cases needs --tenjin-source: the search runs on that data dir's team shelf")
        snapshots = {trial_id: snapshot_of(run_dir, trial_id) for trial_id in sorted(accepted)}
        do_replay = replay or (lambda question: replay_search(source, question))
        for case in cases:
            question = case["prompt"]["text"]
            if not question:
                case["replay"] = {"skipped": KEY_ONLY}
                continue
            # The trial's own snapshot wins: it was taken while the seeded
            # pieces were on the shelf, and a replay now cannot be.
            entry = snapshots.get(case["source"]["trial_id"], {}).get((question, case["prompt"]["question_key"]))
            if entry is None:
                result = {**do_replay(question), "source": REPLAY}
                taken_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now()))
            else:
                result = {**entry["search"], "source": SNAPSHOT}
                taken_at = entry.get("at")
                from_snapshot += 1
            for candidate in result.get("candidates", []):
                candidate["seeded"] = candidate.get("id") in case["seeded_piece_ids"]
                seeded_candidates += int(candidate["seeded"])
            case["replay"] = result
            case["corpus_snapshot"]["replayed_at"] = taken_at
    cases = [_mask(case, secrets, home) for case in cases]
    if out is not None and not dry_run:
        out.parent.mkdir(parents=True, exist_ok=True)
        with out.open("w", encoding="utf-8") as handle:
            for case in cases:
                handle.write(json.dumps(case, sort_keys=True) + "\n")
    return {
        "cases": len(cases),
        "trials": len(accepted),
        "manifest_body_absent": manifest.absent,
        "replayed": 0 if dry_run else sum(1 for case in cases if case["replay"] and "candidates" in case["replay"]),
        "from_snapshot": from_snapshot,
        "seeded_candidates": seeded_candidates,
        "dry_run": dry_run,
        "out": None if dry_run or out is None else str(out),
        "listing": [
            {"case_id": case["case_id"], "trigger": case["trigger"], "question": case["prompt"]["text"], "command_head": ((case["context_packet"].get("situation") or {}).get("command_head"))}
            for case in cases
        ],
    }
