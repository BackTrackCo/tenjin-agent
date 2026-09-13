"""Case records for the search-intent experiment: read after settlement, one per fire, replayed through a fake CLI."""

from __future__ import annotations

import contextlib
import io
import json
import re
import sqlite3
import sys
from pathlib import Path
from typing import Iterator
from unittest import mock

import pytest
from inline_snapshot import snapshot

from evals.benchmark import cases, cli, records
from types import SimpleNamespace
from evals.benchmark.tests import support

FAKE_CLI = str(Path(__file__).with_name("fake_cli.py"))
SECRET = "bench1-cases-shelf-secret-0123456789abcdef"


@pytest.fixture
def source_dir(tmp_path: Path) -> Path:
    source = tmp_path / "source"
    source.mkdir()
    return source




@pytest.fixture
def trials(fake_run: Path) -> list[str]:
    return sorted(path.name.removesuffix(".json") for path in (fake_run / "records").glob("*.json") if ".partial." not in path.name)


def read_record(run_dir: Path, trial_id: str) -> dict:
    return json.loads((run_dir / "records" / f"{trial_id}.json").read_text(encoding="utf-8"))


def write_ledger(run_dir: Path, trial_id: str, session: str, agent: str, *, wal: bool = False) -> Path:
    """One prompt fire with a question, one keyed tool failure, and one skipped context fire."""
    data = run_dir / "trials" / trial_id / "data"
    data.mkdir(parents=True, exist_ok=True)
    path = data / "loop.db"
    db = sqlite3.connect(path)
    db.executescript(support.loop_ddl())
    rows = [
        ("f1", 1, "prompt", "prompt", "hit", None, "How do I run one vitest file here?", "team:piece-real"),
        ("f2", 2, "failure", "tool.after", "miss", "502b90852a1505e3", None, None),
        ("f3", 3, "context", "tool.before", "skipped", None, None, None),
    ]
    for fire_id, at, arm, event, reason, key, question, delivered in rows:
        db.execute(
            "INSERT INTO fires (id, at, session, agent, arm, harness, event, prompt_id, cwd, wait, deadline_ms, elapsed_ms, reason, question_key, question, delivered)"
            " VALUES (?, ?, ?, ?, ?, 'claude', ?, 'p1', '/Users/operator/run/repo', 'sync', 1000, 12, ?, ?, ?, ?)",
            (fire_id, at, session, agent, arm, event, reason, key, question, delivered),
        )
    db.execute("INSERT INTO legs (fire_id, stage, shelf, status, outcome, elapsed_ms, search_id, title, url, form, calibration) VALUES ('f1', 0, 'team', 'ok', 'hit', 40, 'search-9', 'The convention piece', 'https://team-shelf.example/p/piece-real', 'inline', 'hybrid-v1')")
    db.execute("INSERT INTO legs (fire_id, stage, shelf, status, outcome, elapsed_ms, search_id) VALUES ('f2', 0, 'keys', 'ok', 'no-answer', 30, NULL)")
    db.execute(
        "INSERT INTO pairings (uid, at, session, project, machine, kind, key, cmd_head, cmd, error_line, error_files, scope, status)"
        " VALUES ('u1', 2, ?, 'proj', 'm', 'sig_v1_test', '502b90852a1505e3', 'pnpm', 'pnpm exec vitest run tests/actor.test.mjs', ?, '[]', 'project', 'open')",
        (session, f"AssertionError: expected 's1:undefined' to be 's1:root' {SECRET}"),
    )
    db.commit()
    db.close()
    if wal:
        path.with_name("loop.db-wal").write_bytes(b"\x37\x7f\x06\x82" + b"\x00" * 28)
    return path


def ledger_for(run_dir: Path, trial_id: str, **kwargs: bool) -> Path:
    """The ledger keyed on the actor the trial's own record names."""
    _harness, session, agent = read_record(run_dir, trial_id)["actors"][0]["key"]
    return write_ledger(run_dir, trial_id, session, agent, **kwargs)


def write_snapshot(run_dir: Path, trial_id: str, entries: list[dict], seeded_ids: list[str]) -> Path:
    """The shortlist the arm's stop path would have left in the trial's output."""
    output = run_dir / "trials" / trial_id / "output"
    output.mkdir(parents=True, exist_ok=True)
    path = output / cases.SHORTLIST_FILE
    payload = {"trial_id": trial_id, "phase": None, "at": "2026-09-09T00:00:00Z", "shelf_origin": "team-shelf.example", "limit": 10, "seeded_piece_ids": seeded_ids, "entries": entries}
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def snapshot_entry(question: str, key: str | None, candidates: list[dict]) -> dict:
    return {
        "question": question,
        "question_key": key,
        "fire_id": "f1",
        "fire_event": "prompt",
        "hook_arm": "prompt",
        "at": "2026-09-09T00:00:00Z",
        "search": {"exit": 0, "search_id": "search-in-run", "candidates": candidates, "error": None, "limit": 10, "post_floor": True},
    }


def seeded(run_dir: Path, trial_id: str, piece_id: str) -> None:
    record = read_record(run_dir, trial_id)
    seed = {"lesson": "fam", "title": "The lesson", "nonce": "20260908T000000Z-0badf00d", "key_hashes": ["abcd"], "keys": 1, "shelf_origin": "team-shelf.example", "piece_id": piece_id, "published": True, "probe": None, "deleted": True, "delete_error": None}
    record["isolation"] = {**record["isolation"], "seed": [seed]}
    records.validate(record)
    (run_dir / "records" / f"{trial_id}.json").write_text(json.dumps(record), encoding="utf-8")


def test_one_record_per_fire_with_a_question_or_a_key_replayed_and_seeded_marked_apart(
    fake_run: Path, source_dir: Path, trials: list[str], tmp_path: Path
) -> None:
    trial = trials[0]
    ledger_for(fake_run, trial)
    seeded(fake_run, trial, "piece-seeded")
    (source_dir / "search-items.json").write_text(
        json.dumps([
            {"resourceId": "piece-seeded", "title": "The lesson", "url": "https://team-shelf.example/p/piece-seeded", "strong": True, "confidence": 0.9, "corroborated": True, "calibration": "hybrid-v1"},
            {"resourceId": "piece-real", "title": "The convention piece", "url": "https://team-shelf.example/p/piece-real", "strong": False},
        ]),
        encoding="utf-8",
    )
    out = tmp_path / "cases.jsonl"
    summary = export(fake_run, source_dir, out)
    assert (summary["cases"], summary["replayed"], summary["seeded_candidates"]) == (2, 1, 1)
    prompt, failure = [json.loads(line) for line in out.read_text(encoding="utf-8").splitlines()]
    nonce = json.loads((fake_run / "manifest.json").read_text(encoding="utf-8"))["nonce"]
    assert prompt["case_id"] == f"{nonce}:{trial}:f1"
    assert sorted(prompt) == ["attempt", "baseline", "case_id", "context_packet", "corpus_snapshot", "human_label", "labels_schema", "method", "prompt", "replay", "revisions", "seeded_piece_ids", "source", "trigger"]
    assert (prompt["trigger"], prompt["prompt"]["text"], prompt["method"], prompt["human_label"]) == ("prompt", "How do I run one vitest file here?", "baseline", None)
    assert prompt["baseline"]["rank1_title"] == "The convention piece"
    assert (prompt["baseline"]["hit"], prompt["baseline"]["delivered_piece_id"], prompt["baseline"]["delivered_seeded"]) == (True, "piece-real", False)
    assert [(c["rank"], c["id"], c["seeded"], c["strong"], c["confidence"], c["corroborated"], c["calibration"]) for c in prompt["replay"]["candidates"]] == snapshot(
        [
            (1, "piece-seeded", True, True, 0.9, True, "hybrid-v1"),
            (2, "piece-real", False, False, None, None, None),
        ]
    )
    assert (prompt["replay"]["post_floor"], prompt["replay"]["limit"], prompt["replay"]["search_id"]) == (True, 10, "search-1")
    # No trial snapshot on disk, so the shortlist is this command's own search.
    assert (prompt["replay"]["source"], summary["from_snapshot"]) == ("post_run_replay", 0)
    assert re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$", prompt["corpus_snapshot"]["replayed_at"])
    assert prompt["corpus_snapshot"]["shelf_origin"] == "team-shelf.example"
    assert prompt["revisions"]["run_nonce"] == nonce
    assert prompt["seeded_piece_ids"] == ["piece-seeded"]
    assert prompt["attempt"]["tokens"] is not None
    assert (failure["trigger"], failure["prompt"]["text"], failure["prompt"]["question_key"]) == ("failure", None, "502b90852a1505e3")
    situation = failure["context_packet"]["situation"]
    assert (situation["command_head"], situation["command"], situation["key_kind"]) == ("pnpm", "pnpm exec vitest run tests/actor.test.mjs", "sig_v1_test")
    assert situation["source"]["error_line"] == "pairings.error_line"
    assert "skipped" in failure["replay"]
    text = out.read_text(encoding="utf-8")
    assert SECRET not in text
    assert "[secret]" in text
    assert "/Users/operator" not in text


def test_the_trials_own_snapshot_is_preferred_and_the_record_says_which_source_it_came_from(
    fake_run: Path, source_dir: Path, trials: list[str], tmp_path: Path
) -> None:
    trial = trials[0]
    ledger_for(fake_run, trial)
    seeded(fake_run, trial, "piece-seeded")
    write_snapshot(
        fake_run,
        trial,
        [
            snapshot_entry(
                "How do I run one vitest file here?",
                None,
                [
                    {"id": "piece-seeded", "rank": 1, "title": "The lesson", "url": "https://team-shelf.example/p/piece-seeded", "strong": True, "confidence": 0.9, "corroborated": True, "calibration": "hybrid-v1", "score": None, "match_reasons": None},
                    {"id": "piece-real", "rank": 2, "title": "The convention piece", "url": "https://team-shelf.example/p/piece-real", "strong": False, "confidence": None, "corroborated": None, "calibration": None, "score": None, "match_reasons": None},
                ],
            )
        ],
        ["piece-seeded"],
    )
    out = tmp_path / "cases.jsonl"
    with mock.patch(__name__ + ".replay_saved", side_effect=AssertionError("a case with a snapshot is never replayed")):
        summary = export(fake_run, source_dir, out)
    assert (summary["from_snapshot"], summary["replayed"], summary["seeded_candidates"]) == (1, 1, 1)
    prompt, failure = [json.loads(line) for line in out.read_text(encoding="utf-8").splitlines()]
    assert (prompt["replay"]["source"], prompt["replay"]["search_id"]) == ("in_run_snapshot", "search-in-run")
    # The snapshot's own time, not the export's: it says when the shelf was read.
    assert prompt["corpus_snapshot"]["replayed_at"] == "2026-09-09T00:00:00Z"
    assert (prompt["replay"]["limit"], prompt["replay"]["post_floor"], prompt["replay"]["exit"]) == (10, True, 0)
    assert [(c["rank"], c["id"], c["seeded"]) for c in prompt["replay"]["candidates"]] == [(1, "piece-seeded", True), (2, "piece-real", False)]
    assert "skipped" in failure["replay"]


def test_the_seeded_flag_comes_from_the_trials_own_seed_list(fake_run: Path, source_dir: Path, trials: list[str], tmp_path: Path) -> None:
    trial = trials[0]
    ledger_for(fake_run, trial)
    # The record says this trial seeded `piece-other`; the snapshot's own header says something else.
    seeded(fake_run, trial, "piece-other")
    write_snapshot(
        fake_run,
        trial,
        [
            snapshot_entry(
                "How do I run one vitest file here?",
                None,
                [{"id": "piece-seeded", "rank": 1, "title": "The lesson", "url": "u", "strong": True}, {"id": "piece-other", "rank": 2, "title": "The other", "url": "u", "strong": False}],
            )
        ],
        ["piece-seeded"],
    )
    out = tmp_path / "cases.jsonl"
    with mock.patch(__name__ + ".replay_saved", side_effect=AssertionError("a case with a snapshot is never replayed")):
        summary = export(fake_run, source_dir, out)
    prompt = json.loads(out.read_text(encoding="utf-8").splitlines()[0])
    assert prompt["seeded_piece_ids"] == ["piece-other"]
    assert [(c["id"], c["seeded"]) for c in prompt["replay"]["candidates"]] == [("piece-seeded", False), ("piece-other", True)]
    assert summary["seeded_candidates"] == 1


def test_a_snapshot_that_does_not_hold_the_question_falls_back_to_a_replay(fake_run: Path, source_dir: Path, trials: list[str], tmp_path: Path) -> None:
    trial = trials[0]
    ledger_for(fake_run, trial)
    write_snapshot(fake_run, trial, [snapshot_entry("a question this trial never asked", None, [])], [])
    (source_dir / "search-items.json").write_text(json.dumps([{"resourceId": "piece-real", "title": "The convention piece", "url": "u", "strong": False}]), encoding="utf-8")
    out = tmp_path / "cases.jsonl"
    summary = export(fake_run, source_dir, out)
    prompt = json.loads(out.read_text(encoding="utf-8").splitlines()[0])
    assert (summary["from_snapshot"], prompt["replay"]["source"], prompt["replay"]["search_id"]) == (0, "post_run_replay", "search-1")
    # A file that is not a shortlist at all is a fall back too, never a refusal.
    (fake_run / "trials" / trial / "output" / cases.SHORTLIST_FILE).write_text("{", encoding="utf-8")
    assert export(fake_run, source_dir, out)["from_snapshot"] == 0






def test_a_trial_without_a_ledger_yields_no_case(fake_run: Path, source_dir: Path, trials: list[str], tmp_path: Path) -> None:
    out = tmp_path / "empty.jsonl"
    summary = export(fake_run, source_dir, out)
    # Every trial in the run was read, and none of them held a ledger.
    assert (summary["cases"], summary["trials"]) == (0, len(trials))
    assert out.read_text(encoding="utf-8") == ""


def replay_saved(source: Path, question: str) -> dict:
    path = source / "search-items.json"
    rows = json.loads(path.read_text()) if path.exists() else []
    candidates = [{"id": row["resourceId"], "rank": rank, **{key: row.get(key) for key in ("title", "url", "strong", "confidence", "corroborated", "calibration", "score", "match_reasons")}} for rank, row in enumerate(rows, 1)]
    return {"exit": 0, "search_id": "search-1", "candidates": candidates, "error": None, "limit": 10, "post_floor": True}


def export(run_dir: Path, source_path: Path | None, out: Path | None, *, dry_run: bool = False) -> dict:
    manifest, digest = cli.load_run(run_dir)
    metadata = SimpleNamespace(shelf_origin="team-shelf.example", secrets=(SECRET,))
    replay = None if source_path is None else lambda question: replay_saved(source_path, question)
    return cases.export(manifest, digest, run_dir, out, metadata, dry_run=dry_run, replay=replay)


def test_export_refuses_live_ledgers_and_missing_replay(fake_run: Path, source_dir: Path, trials: list[str], tmp_path: Path) -> None:
    ledger = ledger_for(fake_run, trials[0], wal=True)
    out = tmp_path / "cases.jsonl"
    with pytest.raises(cases.CasesError, match="live loop.db WAL"):
        export(fake_run, source_dir, out)
    ledger.with_name("loop.db-wal").write_bytes(b"")
    assert export(fake_run, None, None, dry_run=True)["cases"] == 2
    with pytest.raises(cases.CasesError, match="no saved shortlist"):
        export(fake_run, None, out)
    assert not out.exists()


def test_saved_cases_need_no_replay_source(fake_run: Path, trials: list[str], tmp_path: Path) -> None:
    ledger_for(fake_run, trials[0])
    write_snapshot(fake_run, trials[0], [snapshot_entry("How do I run one vitest file here?", None, [])], [])
    assert export(fake_run, None, tmp_path / "saved.jsonl")["from_snapshot"] == 1
