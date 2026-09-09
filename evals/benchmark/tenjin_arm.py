"""The Tenjin hooks arm: a seeded data dir and one loop daemon per trial.

The product's hooks read their configuration from `<TENJIN_DATA_DIR>/config.json`
and talk to a loopback daemon that reads `daemon.token` and the bundles under
`<TENJIN_DATA_DIR>/hooks/`. None of that comes from the environment, so an arm
that runs the real hooks cannot be an environment difference: it has to be a
seeded data dir. This module builds one per trial from an operator-supplied
source data dir (`live-run --tenjin-source`), copying exactly `COPIED_KEYS` and
the two bundles, forcing the seeded constants in `SEEDED`, and minting a fresh
daemon token.

The daemon itself is the container's: the trial's entrypoint starts it on the
mounted data dir, waits for `/health`, stops it when the agent exits, and
leaves `daemon.json` in the trial's output root. So the port is a constant
rather than a free host port, and what this module used to observe by
signalling a pid it started it now reads back out of that file.

Stop also snapshots the shelf before it deletes. The seeded pieces are what a
retrieval reading of the run is about, and a search run after the delete can
never return one, so `stop` asks the shelf every question the trial's ledger
holds and writes the answers to `output/shortlist.json` first. `cases` prefers
that file to a replay of its own; without it, recall is not measurable.

The team shelf secret is one of the copied keys. It enters the trial by
construction, so the run says so: `Source.facts` becomes part of the record's
isolation block, the secret's value is a sentinel canary for everything the
agent wrote, and a run that carries it is never publishable. The value is held
in memory here and written to the seeded config only; nothing in this module
logs it, prints it, or hashes it.
"""

from __future__ import annotations

import dataclasses
import json
import os
import re
import secrets
import shutil
import sqlite3
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlsplit

from . import FIXTURES, artifact, container, sha256_text, signature
from .executor import Provision, ProvisionError, ProvisionRequest

NAME = "tenjin"
CONFIG_FILE = "config.json"
TOKEN_FILE = "daemon.token"
PID_FILE = "daemon.pid"
LOOP_DB = "loop.db"
HOOKS_DIR = "hooks"
DAEMON_BUNDLE = "tenjin-daemon.mjs"
SHIM_BUNDLE = "tenjin-shim.mjs"
REPORTER_BUNDLE = "tenjin-vitest-reporter.mjs"
BUNDLES = (DAEMON_BUNDLE, SHIM_BUNDLE, REPORTER_BUNDLE)
HOOK_PATH = "/hook/claude"
# The only keys copied from the source config. `shelfBypassSecret` is the
# team shelf secret and is what makes a run non-publishable; nothing about a
# wallet, a session key, or a spend ledger is on this list.
COPIED_KEYS = ("baseUrl", "publicShelfUrl", "shelfBypassSecret")
SECRET_KEY = "shelfBypassSecret"
# Forced whatever the source says. Every hook arm on, which is the product as
# shipped (`hooks.capture` is not a product key; the turn-end capture ask is
# the `publish` arm), except the arms the manifest's `hooks_disabled` names:
# a consumption arm runs no publish nudge, because it captures nothing and the
# nudge is a real cost with nothing to show for it there. Review mode so the
# consumer's capture ask can never publish from a trial; public fallback on
# because that is the product as shipped and as Bench-3 runs it (a team miss
# then reaches the public marketplace, which is a named origin and a counted
# leg); and a short idle exit so a daemon this module lost track of ends itself.
HOOK_ARMS = ("prompt", "web-search", "web-fetch", "subagent", "failure", "publish", "primer")
SEEDED: dict[str, Any] = {
    "publish": {"mode": "review"},
    "hooks": {arm: True for arm in HOOK_ARMS},
    "team": {"publicFallback": "on"},
    "loop": {"idle_exit_min": 2},
}
# The two configs a trial's daemon runs under. `consumer` is the arm as
# shipped. `producer` is the same with the capture ask in auto mode, so the
# natural arm's producer is told to publish rather than asked.
MODES = ("consumer", "producer")
# The daemon's port inside the trial's container, which has its own loopback.
# A constant, because a free port on the host says nothing about that namespace.
DAEMON_PORT = 45871
DAEMON_REPORT = "daemon.json"
HEALTH_POLL_S = 0.05
WAL_TIMEOUT_S = 5.0
PLACEHOLDERS = ("daemon_url", "daemon_token", "data_dir")
DRY_TOKEN = "minted-at-launch"
# The seeded lesson: one piece per lesson family under `fixtures/live/lessons/`,
# published into the team shelf through the CLI at prepare, under the `sig_v1`
# keys the fixture's failing commands yield, and deleted at stop. The keys are
# frozen beside the body and re-derived at prepare by running those commands
# on a scratch copy of the trial's repository, so drift is a refusal.
LESSONS = FIXTURES / "live" / "lessons"
LESSON_KEYS = frozenset({"id", "title", "commands"})
COMMAND_KEYS = frozenset({"command", "kind", "key", "check", "reason"})
KEY_KINDS = frozenset({"sig_v1", "sig_v1_test"})
FIX_SUFFIX = "-fix"
CLI = "tenjin"
PROBE_DIR = "probe"
PROBE_OUTPUT_DIR = "probe-output"
SEED_DIR = "seed"
PROBE_TIMEOUT_S = 120
CLI_TIMEOUT_S = 180
OUTPUT_LIMIT = 300


@dataclass(frozen=True)
class LessonCommand:
    command: str
    kind: str
    key: str | None
    check: bool
    reason: str

    @property
    def kind_key(self) -> str | None:
        return None if self.key is None else f"{self.kind}:{self.key}"


@dataclass(frozen=True)
class Lesson:
    id: str
    title: str
    body: Path
    commands: tuple[LessonCommand, ...]

    @property
    def keys(self) -> tuple[str, ...]:
        """`<kind>:<key>` for every keyed command, the exact `--key fingerprint=` values the piece is bound to."""
        return tuple(dict.fromkeys(entry.kind_key for entry in self.commands if entry.kind_key is not None))

    @property
    def key_hashes(self) -> list[str]:
        return [key_hash(key) for key in self.keys]


def key_hash(kind_key: str) -> str:
    return sha256_text(kind_key)[:16]


def lesson_named(name: str, lessons: Path | None = None) -> Lesson | None:
    """The lesson `<name>.json` and `<name>.md` describe, or None when the benchmark holds none by that name."""
    lessons = LESSONS if lessons is None else lessons
    record = lessons / f"{name}.json"
    body = lessons / f"{name}.md"
    if not record.is_file():
        return None
    try:
        data = json.loads(record.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ProvisionError(f"lesson {name!r} is unreadable: {error.__class__.__name__}") from error
    if not isinstance(data, dict) or set(data) != LESSON_KEYS or data["id"] != name or not body.is_file():
        raise ProvisionError(f"lesson {name!r} must be {record.name} with id, title, commands, and {body.name} beside it")
    commands = []
    for entry in data["commands"]:
        if not isinstance(entry, dict) or set(entry) != COMMAND_KEYS or not isinstance(entry["check"], bool) or entry["kind"] not in KEY_KINDS:
            raise ProvisionError(f"lesson {name!r} has a malformed command entry")
        if entry["key"] is not None and not re.fullmatch(r"[0-9a-f]{16}", str(entry["key"])):
            raise ProvisionError(f"lesson {name!r} names a key that is not 16 hex characters")
        commands.append(LessonCommand(str(entry["command"]), str(entry["kind"]), entry["key"], entry["check"], str(entry["reason"])))
    return Lesson(id=name, title=str(data["title"]), body=body, commands=tuple(commands))


def lessons_for(task: dict[str, Any], lessons: Path | None = None, selected: list[str] | None = None) -> list[Lesson]:
    """The task's lessons: by default the family's convention lesson (the prompt path) and the task's own fix (the failure path); an arm's `lessons` list names exactly which."""
    if selected is not None:
        chosen = []
        for name in selected:
            lesson = lesson_named(name, lessons)
            if lesson is None:
                raise ProvisionError(f"arm names lesson {name!r}, which the benchmark does not hold")
            chosen.append(lesson)
        return chosen
    found = []
    for name in (str(task.get("family", "")), f"{task.get('id', '')}{FIX_SUFFIX}"):
        lesson = lesson_named(name, lessons) if name else None
        if lesson is not None:
            found.append(lesson)
    return found


def probe_argv(image: str, probe: Path, command: str, environment: dict[str, str]) -> list[str]:
    """One command from a lesson, run in the task's own image with no network at all.

    Through the image's entrypoint, which is what a trial runs under, so it
    needs an output root: the probe's own, beside the repository copy, never
    the trial's, and mounted because nothing outside a mount exists in there.
    """
    output = Path(environment[container.OUTPUT_VAR])
    return container.run_argv(
        image=image,
        name=f"{container.TRIAL_PREFIX}probe-{secrets.token_hex(4)}",
        workdir=probe,
        plan=[container.Mount(probe, probe), container.Mount(output, output)],
        environment=environment,
        network="none",
        command=command.split(" "),
    )


def probe_run(image: str, probe: Path, command: str, environment: dict[str, str]) -> "subprocess.CompletedProcess[str]":
    """Run one probe command in its container, and stop that container whatever happens."""
    argv = probe_argv(image, probe, command, environment)
    name = argv[argv.index("--name") + 1]
    try:
        return subprocess.run(argv, capture_output=True, text=True, timeout=PROBE_TIMEOUT_S, shell=False, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        container.stop(name)
        raise ProvisionError(f"the seed probe could not run {command!r}: {error.__class__.__name__}") from error


# The seam a test replaces to run a probe command directly, so the offline
# suite proves the keying without a container. Code-owned, like the CLI argv
# seams below: the manifest never names a program.
PROBE_RUN: Callable[[str, Path, str, dict[str, str]], "subprocess.CompletedProcess[str]"] = probe_run


def probe_keys(
    roots: artifact.TrialRoots, commands: list[str], environment: dict[str, str], image: str | None
) -> dict[str, dict[str, str | None]]:
    """Run each command on a scratch copy of the trial's repository and key its output both ways the product does.

    In the trial's own image, because the tree the commands run against is the
    image's and the host cannot execute it. `--network none`, because a probe
    that reached anything would be a leg the record could not name.
    """
    if image is None:
        raise ProvisionError("the seed probe needs the task's image; live-run resolves it before any trial")
    probe = roots.base / PROBE_DIR
    if probe.exists():
        shutil.rmtree(probe)
    # Symlinks kept: a pnpm tree is symlinks, all of them relative, and
    # dereferencing them copies each `.bin` shim out of the directory its own
    # relative import resolves from, so `pnpm exec` fails to find its entry
    # point instead of running the fixture's failure.
    shutil.copytree(roots.repo, probe, symlinks=True)
    # The entrypoint's output root, the probe's own: what a command writes
    # there is not the attempt's, and the copy leaves with the probe.
    output = roots.base / PROBE_OUTPUT_DIR
    output.mkdir(parents=True, exist_ok=True)
    environment = {**environment, container.OUTPUT_VAR: str(output)}
    probed: dict[str, dict[str, str | None]] = {}
    try:
        for command in commands:
            if command in probed:
                continue
            completed = PROBE_RUN(image, probe, command, environment)
            text = (completed.stdout or "") + "\n" + (completed.stderr or "")
            found = signature.key_of(text)
            probed[command] = {"sig_v1": found["key"], "sig_v1_test": found["test_key"], "text": text}
    finally:
        shutil.rmtree(probe, ignore_errors=True)
        shutil.rmtree(output, ignore_errors=True)
    return probed


def check_keys(lesson: Lesson, task_id: str, probed: dict[str, dict[str, str | None]]) -> None:
    """The frozen keys must be what the trial's own commands yield today, or the seed is a lie."""
    for entry in lesson.commands:
        if not entry.check:
            continue
        command = entry.command.replace("{task}", task_id)
        found = probed.get(command, {}).get(entry.kind)
        if found != entry.key:
            raise ProvisionError(
                f"seed key drift: {command!r} keys to {entry.kind} {found!r}, the lesson records {entry.key!r}; re-derive {lesson.id}.json before seeding",
                code="seed_key_drift",
            )


def publish_argv(body: Path, keys: tuple[str, ...]) -> list[str]:
    argv = [CLI, "publish", str(body), "--yes", "--json"]
    for kind_key in keys:
        argv += ["--key", f"fingerprint={kind_key}"]
    return argv


def delete_argv(piece_id: str) -> list[str]:
    return [CLI, "delete", piece_id, "--yes", "--json"]


def search_argv(query: str) -> list[str]:
    return [CLI, "search", query, "--json", "--limit", str(SEARCH_LIMIT)]


# The seams a test replaces with a fake CLI. Code-owned: the manifest never
# names a program, and the arguments above are the only ones ever passed.
PUBLISH_ARGV: Callable[[Path, tuple[str, ...]], list[str]] = publish_argv
DELETE_ARGV: Callable[[str], list[str]] = delete_argv
SEARCH_ARGV: Callable[[str], list[str]] = search_argv
SEARCH_LIMIT = 10
ENVELOPE_KEYS = frozenset({"ok", "data", "resourceId", "postId", "deleted", "candidates"})
SEED_NOTE = "seed.json"
CANDIDATE_FIELDS = ("confidence", "corroborated", "calibration", "score")
SHORTLIST_FILE = "shortlist.json"
# The CLI asks npm for its own dist-tags once a day. On a run whose only route
# out is the allowlist proxy that request is refused, the refusal is what the
# sentinel counts, and the trial is thrown away for an egress the arm never
# wanted. The product's own opt-out (`update-check.ts`) turns it off.
NO_UPDATE_CHECK = "TENJIN_NO_UPDATE_CHECK"
# The product's default `publicShelfUrl` (`src/lib/production-origin.ts`). A pin,
# like the versions in `images.py`: if the product's default moves, this moves.
PRODUCT_PUBLIC_ORIGIN = "https://tenjin.blog"
SHORTLIST_FIRE_COLUMNS = ("id", "at", "arm", "event", "question", "question_key")


def cli_environment(source: Source, parent: dict[str, str] | None = None) -> dict[str, str]:
    """The operator's own data dir (its wallet signs the publish), and nothing else of the operator's."""
    parent = os.environ if parent is None else parent
    env = {
        "PATH": parent.get("PATH", ""),
        "HOME": parent.get("HOME", ""),
        "TENJIN_DATA_DIR": os.path.abspath(source.path),
        NO_UPDATE_CHECK: "1",
    }
    for name in ("LANG", "TMPDIR"):
        if parent.get(name):
            env[name] = parent[name]
    return env


def _find(value: Any, name: str) -> Any:
    if isinstance(value, dict):
        if name in value:
            return value[name]
        for item in value.values():
            found = _find(item, name)
            if found is not None:
                return found
    if isinstance(value, list):
        for item in value:
            found = _find(item, name)
            if found is not None:
                return found
    return None


def envelope_of(*streams: str) -> Any:
    """The CLI's JSON envelope wherever it landed: the first object of envelope shape on either stream, whole or per line.

    The output contract says stdout, and 0.1.0-alpha.15 writes `publish` and
    `delete` envelopes to stderr; the fifth hooks smoke aborted on that. So
    the parse is by shape, not by stream and not by last line.
    """
    for stream in streams:
        text = (stream or "").strip()
        if not text:
            continue
        candidates = [text] + [line.strip() for line in text.splitlines() if line.strip().startswith("{")]
        for candidate in candidates:
            try:
                value = json.loads(candidate)
            except json.JSONDecodeError:
                continue
            if isinstance(value, dict) and ENVELOPE_KEYS & set(value):
                return value
    return None


def piece_id_of(payload: Any) -> str | None:
    """The published piece's id, by the shapes the receipt has had: `data.resourceId`, `resourceId`, `data.post.id`, `postId`."""
    if not isinstance(payload, dict):
        return None
    data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
    post = data.get("post") if isinstance(data.get("post"), dict) else {}
    for value in (data.get("resourceId"), payload.get("resourceId"), post.get("id"), data.get("postId"), payload.get("postId")):
        if isinstance(value, str) and value:
            return value
    return None


def _mask(text: str, secrets_: tuple[str, ...]) -> str:
    for secret in secrets_:
        text = text.replace(secret, "[secret]")
    return text


def _run_cli(argv: list[str], env: dict[str, str], secrets_: tuple[str, ...]) -> tuple[int, Any, str]:
    """One CLI call: exit code, the envelope parsed off either stream (or None), and the masked tail of both streams."""
    try:
        completed = subprocess.run(argv, env=env, capture_output=True, text=True, timeout=CLI_TIMEOUT_S, shell=False, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        return 1, None, f"{argv[0]} could not run: {error.__class__.__name__}"
    tail = _mask(("stderr: " + (completed.stderr or "").strip() + " stdout: " + (completed.stdout or "").strip()).strip(), secrets_)[-OUTPUT_LIMIT:]
    return completed.returncode, envelope_of(completed.stdout, completed.stderr), tail


def seed_body(lesson: Lesson, roots: artifact.TrialRoots, nonce: str, trial_id: str) -> Path:
    """The lesson with the run stamp, written outside the agent's roots."""
    target = roots.base / SEED_DIR / lesson.body.name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(lesson.body.read_text(encoding="utf-8").rstrip("\n") + f"\n\n{stamp_of(nonce, trial_id)}\n", encoding="utf-8")
    return target


def stamp_of(nonce: str, trial_id: str) -> str:
    """Unique per run and trial: the CLI dedups a body per machine by its content hash, and `tenjin delete` leaves that record."""
    return f"Benchmark seed: run {nonce} trial {trial_id}."


def sweep_stamped(source: Source, lesson: Lesson) -> dict[str, Any]:
    """Find every piece on the shelf carrying the lesson's title and delete it. Owner-scoped: the CLI refuses another wallet's piece."""
    code, payload, tail = _run_cli(SEARCH_ARGV(lesson.title), cli_environment(source), source.secrets)
    found = _find(payload, "candidates")
    matches = [item for item in (found if isinstance(found, list) else []) if isinstance(item, dict) and item.get("title") == lesson.title and isinstance(item.get("resourceId"), str)]
    deleted: list[str] = []
    failed: dict[str, str] = {}
    for item in matches:
        error = delete_lesson(source, item["resourceId"])
        if error is None:
            deleted.append(item["resourceId"])
        else:
            failed[item["resourceId"]] = error
    return {"search_exit": code, "search_tail": tail if code != 0 else "", "matched": len(matches), "deleted": deleted, "failed": failed}


def publish_lesson(source: Source, roots: artifact.TrialRoots, lesson: Lesson, nonce: str, trial_id: str) -> str:
    """Publish the lesson under its keys through the CLI, the way a producer's turn end would. Returns the piece id.

    Fails closed: a publish whose id cannot be read may still have landed, so
    every piece with the lesson's title is deleted before the refusal, and the
    trial's output keeps a note saying the publish outcome was unknown.
    """
    body = seed_body(lesson, roots, nonce, trial_id)
    code, payload, tail = _run_cli(PUBLISH_ARGV(body, lesson.keys), cli_environment(source), source.secrets)
    piece_id = piece_id_of(payload)
    stamp = stamp_of(nonce, trial_id)
    if code == 0 and _find(payload, "alreadyPublished") is True:
        # Nothing landed: the CLI answered with the url of a body this machine
        # published before, which a delete does not clear (0.1.0-alpha.15).
        note = {"title": lesson.title, "stamp": stamp, "published": False, "exit": code, "tail": tail, "already_published_url": _find(payload, "url")}
        roots.output.mkdir(parents=True, exist_ok=True)
        (roots.output / SEED_NOTE).write_text(json.dumps(note, indent=2) + "\n", encoding="utf-8")
        raise ProvisionError(
            "seeding the lesson failed: the CLI's publish dedup matched a body this machine already published; "
            f"the stamp must be unique per run (stamp {stamp!r}, dedup url in {roots.output / SEED_NOTE})"
        )
    if code == 0 and piece_id is not None:
        return piece_id
    note = {"title": lesson.title, "stamp": stamp, "published": "unknown" if code == 0 else False, "exit": code, "tail": tail}
    if code == 0:
        note["sweep"] = sweep_stamped(source, lesson)
    roots.output.mkdir(parents=True, exist_ok=True)
    (roots.output / SEED_NOTE).write_text(json.dumps(note, indent=2) + "\n", encoding="utf-8")
    if code == 0:
        sweep = note["sweep"]
        raise ProvisionError(
            f"seeding the lesson failed: tenjin publish exited 0 but no piece id could be read ({tail or 'no output'}); "
            f"swept the shelf by title: {sweep['matched']} matched, {len(sweep['deleted'])} deleted, {len(sweep['failed'])} failed; see {roots.output / SEED_NOTE}"
        )
    raise ProvisionError(f"seeding the lesson failed: tenjin publish exited {code}: {tail or 'no output'}", code="seed_publish")


def utc_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def search_shortlist(source: Source, question: str) -> dict[str, Any]:
    """One question through `tenjin search --json --limit 10` on that data dir's team shelf: post-floor, top ten, in rank order.

    The one place the envelope becomes a candidate list, so an in-run snapshot
    and a post-run replay are the same shape and a reader of `cases` never has
    to tell the two apart by their fields.
    """
    code, payload, tail = _run_cli(SEARCH_ARGV(question), cli_environment(source), source.secrets)
    items = _find(payload, "items")
    if not isinstance(items, list):
        items = _find(payload, "candidates")
    candidates = []
    for rank, item in enumerate(items if isinstance(items, list) else [], start=1):
        if not isinstance(item, dict):
            continue
        candidates.append(
            {
                "id": item.get("resourceId"),
                "rank": rank,
                "title": item.get("title"),
                "url": item.get("url"),
                "strong": item.get("strong"),
                **{name: item.get(name) for name in CANDIDATE_FIELDS},
                "match_reasons": item.get("matchReasons"),
            }
        )
    return {
        "exit": code,
        "search_id": _find(payload, "searchId"),
        "candidates": candidates,
        "error": None if code == 0 else tail,
        "limit": SEARCH_LIMIT,
        "post_floor": True,
    }


def asked_questions(loop_db: Path) -> list[dict[str, Any]]:
    """The distinct question and question key the trial's ledger recorded, in fire order, each with the fire that first carried it.

    A fire that carried a key and no question text is not here: a keys resolve
    is not a search, and there is nothing to ask the shelf.
    """
    if not loop_db.is_file():
        return []
    uri = f"file:{loop_db.resolve().as_posix()}?mode=ro&immutable=1"
    connection = sqlite3.connect(uri, uri=True)
    try:
        connection.row_factory = sqlite3.Row
        rows = connection.execute(f"SELECT {', '.join(SHORTLIST_FIRE_COLUMNS)} FROM fires ORDER BY at, id").fetchall()
    finally:
        connection.close()
    found: dict[tuple[str, Any], dict[str, Any]] = {}
    for row in rows:
        question = row["question"]
        if not question:
            continue
        found.setdefault(
            (question, row["question_key"]),
            {"question": question, "question_key": row["question_key"], "fire_id": row["id"], "fire_event": row["event"], "hook_arm": row["arm"]},
        )
    return list(found.values())


def shortlist(roots: artifact.TrialRoots, source: Source, pieces: list[str]) -> dict[str, Any]:
    """What the shelf answers today for every question this trial asked, with the seeded pieces named as live."""
    entries = []
    for entry in asked_questions(roots.data_dir / LOOP_DB):
        entries.append({**entry, "at": utc_now(), "search": search_shortlist(source, entry["question"])})
    return {
        "trial_id": roots.trial_id,
        "phase": roots.phase,
        "at": utc_now(),
        "shelf_origin": source.shelf_origin,
        "limit": SEARCH_LIMIT,
        "seeded_piece_ids": sorted(pieces),
        "entries": entries,
    }


def write_shortlist(roots: artifact.TrialRoots, source: Source, pieces: list[str]) -> dict[str, Any]:
    """Take the shortlist and write it beside the daemon report. Never raises: the trial's own result does not depend on it."""
    try:
        payload = shortlist(roots, source, pieces)
        roots.output.mkdir(parents=True, exist_ok=True)
        text = _mask(json.dumps(payload, indent=2, sort_keys=True), source.secrets)
        (roots.output / SHORTLIST_FILE).write_text(text + "\n", encoding="utf-8")
    except (OSError, sqlite3.Error, ValueError) as error:
        return {"written": False, "questions": 0, "failed": 0, "error": f"{error.__class__.__name__}: {error}"}
    failed = sum(1 for entry in payload["entries"] if entry["search"]["exit"] != 0)
    return {"written": True, "questions": len(payload["entries"]), "failed": failed, "error": None}


def delete_lesson(source: Source, piece_id: str) -> str | None:
    """Delete the seeded piece. Returns None on success, else the reason, so the record can say it."""
    code, payload, tail = _run_cli(DELETE_ARGV(piece_id), cli_environment(source), source.secrets)
    if code == 0 and _find(payload, "deleted") is True:
        return None
    return f"tenjin delete exited {code}: {tail or 'no output'}"


def seed_facts(lesson: Lesson, source: Source, piece_id: str | None, probed: dict[str, dict[str, str | None]] | None, nonce: str | None, task_id: str) -> dict[str, Any]:
    probe = None
    if probed is not None:
        # Hashes, like `key_hashes`: the record names which command keyed under the lesson's kind and which did not, never the key.
        probe = {}
        for entry in lesson.commands:
            command = entry.command.replace("{task}", task_id)
            found = probed.get(command, {}).get(entry.kind)
            probe[command] = None if found is None else key_hash(f"{entry.kind}:{found}")
    return {
        "lesson": lesson.id,
        "title": lesson.title,
        "nonce": nonce,
        "key_hashes": lesson.key_hashes,
        "keys": len(lesson.keys),
        "shelf_origin": source.shelf_origin,
        "piece_id": piece_id,
        "published": piece_id is not None,
        "probe": probe,
        "deleted": None,
        "delete_error": None,
    }


def disabled_arms(arm: dict[str, Any]) -> tuple[str, ...]:
    """The product hook arms this benchmark arm runs with off, in the product's own order.

    A name the product has no arm for is refused rather than dropped: a
    silently ignored switch is a record that says the wrong thing.
    """
    named = set(arm.get("hooks_disabled") or ())
    unknown = sorted(named - set(HOOK_ARMS))
    if unknown:
        raise ProvisionError(f"hooks_disabled names {', '.join(unknown)}, which the product's config has no arm for")
    return tuple(name for name in HOOK_ARMS if name in named)


def dry_source() -> "Source":
    """What a dry run without `--tenjin-source` provisions from: no bundles, no secret, a loopback shelf."""
    return Source(path=Path("."), config={"baseUrl": "http://127.0.0.1", "publicShelfUrl": "http://127.0.0.1"}, bundles={})


@dataclass(frozen=True)
class Source:
    """The operator's data dir, read once. Holds the secret; never shows it."""

    path: Path
    config: dict[str, Any]
    bundles: dict[str, Path]

    @property
    def shelf_secret(self) -> str:
        return str(self.config.get(SECRET_KEY) or "")

    @property
    def shelf_secret_present(self) -> bool:
        return bool(self.shelf_secret)

    @property
    def shelf_origin(self) -> str | None:
        return _host(self.config.get("baseUrl"))

    @property
    def origins(self) -> tuple[str, ...]:
        """The two named origins the arm may reach: the team shelf and the public marketplace."""
        return tuple(host for host in (self.shelf_origin, self.public_origin) if host is not None)

    @property
    def public_origin(self) -> str | None:
        """The public marketplace the arm will reach, config or product default.

        A config that names no `publicShelfUrl` does not mean the arm makes no
        public request: the product falls back to its own production origin. The
        allowlist is built from this, so reading only the config left the origin
        the public leg actually used off the list. The proxy then refused it, and
        the refusal invalidated the trial as a public request the arm never made
        on purpose. Found 2026-09-09.
        """
        return _host(self.config.get("publicShelfUrl") or PRODUCT_PUBLIC_ORIGIN)

    @property
    def facts(self) -> dict[str, Any]:
        return {
            "shelf_secret_present": self.shelf_secret_present,
            "shelf_origin": self.shelf_origin,
            "public_origin": self.public_origin,
        }

    @property
    def secrets(self) -> tuple[str, ...]:
        return (self.shelf_secret,) if self.shelf_secret_present else ()


def _host(url: Any) -> str | None:
    if not isinstance(url, str) or not url:
        return None
    return urlsplit(url).hostname or None


def load_source(path: Path) -> Source:
    """Read the copied keys and locate the bundles. Everything else in the dir is left unread."""
    config_path = path / CONFIG_FILE
    try:
        raw = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ProvisionError(f"--tenjin-source has no readable {CONFIG_FILE}: {error.__class__.__name__}") from error
    if not isinstance(raw, dict):
        raise ProvisionError(f"--tenjin-source {CONFIG_FILE} must be a JSON object")
    config: dict[str, Any] = {}
    for key in COPIED_KEYS:
        if key not in raw:
            continue
        value = raw[key]
        if not isinstance(value, str):
            raise ProvisionError(f"--tenjin-source {CONFIG_FILE} {key} must be a string")
        config[key] = value
    if _host(config.get("baseUrl")) is None:
        raise ProvisionError(f"--tenjin-source {CONFIG_FILE} has no baseUrl")
    bundles = {name: path / HOOKS_DIR / name for name in BUNDLES}
    missing = sorted(name for name, bundle in bundles.items() if not bundle.is_file())
    if missing:
        raise ProvisionError(f"--tenjin-source has no {', '.join(missing)} under {HOOKS_DIR}/; run `tenjin daemon start` there")
    return Source(path=path, config=config, bundles=bundles)


def data_dir_string(roots: artifact.TrialRoots) -> str:
    """The data dir as the product spells it: absolute, symlinks kept.

    The daemon compares `TENJIN_DATA_DIR` strings, not inodes, and the shim
    respawns a daemon whose `/health` names a different string. Node's
    `path.resolve` keeps symlinks, so this must too.
    """
    return os.path.abspath(roots.data_dir)


def seeded_config(source: Source, port: int, *, with_secret: bool = True, mode: str = "consumer", disabled: tuple[str, ...] = ()) -> dict[str, Any]:
    if mode not in MODES:
        raise ProvisionError(f"unknown daemon config mode {mode!r}")
    unknown = sorted(set(disabled) - set(HOOK_ARMS))
    if unknown:
        raise ProvisionError(f"hooks_disabled names {', '.join(unknown)}, which the product's config has no arm for")
    config = {key: value for key, value in source.config.items() if with_secret or key != SECRET_KEY}
    seeded = {**config, **SEEDED, "hooks": {arm: arm not in disabled for arm in HOOK_ARMS}, "loop": {**SEEDED["loop"], "port": port}}
    if mode == "producer":
        seeded["publish"] = {"mode": "auto"}
    return seeded


def write_config(roots: artifact.TrialRoots, source: Source, port: int, *, with_secret: bool, mode: str, disabled: tuple[str, ...] = ()) -> None:
    config_path = roots.data_dir / CONFIG_FILE
    config_path.write_text(
        json.dumps(seeded_config(source, port, with_secret=with_secret, mode=mode, disabled=disabled), indent=2) + "\n", encoding="utf-8"
    )
    config_path.chmod(0o600)


def daemon_argv(roots: artifact.TrialRoots) -> list[str]:
    return ["node", str(roots.data_dir / HOOKS_DIR / DAEMON_BUNDLE)]


# The seam a test replaces with a fake daemon. Code-owned: the manifest never
# names a program.
DAEMON_ARGV: Callable[[artifact.TrialRoots], list[str]] = daemon_argv


# The run's only route out is the allowlist proxy, and a daemon told nothing
# about it dials each host directly. On an `--internal` network that reaches
# nothing, so every shelf leg fails as a bare `error` with no search id and the
# arm delivers nothing while the run still reports four healthy attempts. Node
# 24 reads the addresses for `fetch` only under `NODE_USE_ENV_PROXY`, so the
# flag travels with them or none of them count.
PROXY_NAMES = (
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "NODE_USE_ENV_PROXY",
)


def daemon_environment(roots: artifact.TrialRoots, parent: dict[str, str] | None = None) -> dict[str, str]:
    """The daemon's allowlist: the trial's own roots, the run's proxy and the locale names, nothing of the operator's."""
    parent = os.environ if parent is None else parent
    env = {
        "PATH": parent.get("PATH", ""),
        "HOME": str(roots.home),
        "TENJIN_DATA_DIR": data_dir_string(roots),
        NO_UPDATE_CHECK: "1",
    }
    for name in ("LANG", "TMPDIR", *PROXY_NAMES):
        if parent.get(name):
            env[name] = parent[name]
    return env


def read_report(output: Path) -> dict[str, Any] | None:
    """What the container's entrypoint left about the daemon it ran, or None."""
    try:
        payload = json.loads((output / DAEMON_REPORT).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def settle_daemon(roots: artifact.TrialRoots, output: Path) -> dict[str, Any]:
    """The stopped daemon's facts, read off the entrypoint's report, with the WAL confirmed here.

    The container stopped the daemon it started, and any daemon the shim
    respawned inside it, before it exited; both are gone with the container
    either way. What the host still has to establish is that `loop.db` has
    settled, because it is about to be read.
    """
    report = read_report(output) or {}
    wal = roots.data_dir / f"{LOOP_DB}-wal"
    end = time.monotonic() + WAL_TIMEOUT_S
    while wal.exists() and time.monotonic() < end:
        time.sleep(HEALTH_POLL_S)
    return {
        "respawned": bool(report.get("respawned", False)),
        "started": bool(report.get("started", False)),
        "daemon_error": report.get("error"),
        "wal_live": wal.exists(),
    }


def _values(roots: artifact.TrialRoots, port: int, token: str) -> dict[str, str]:
    return {"daemon_url": f"http://127.0.0.1:{port}{HOOK_PATH}", "daemon_token": token, "data_dir": str(roots.data_dir)}


def start_phase(roots: artifact.TrialRoots, provision: Provision, mode: str) -> Provision:
    """Between phases: rewrite the config for `mode`, on the same data dir and the same token.

    The next phase is the next container, and it starts its own daemon from
    this config. Nothing is running between the two.
    """
    state = provision.stop_state
    source: Source = state["source"]
    write_config(roots, source, DAEMON_PORT, with_secret=True, mode=mode, disabled=state.get("disabled", ()))
    return dataclasses.replace(provision, values=_values(roots, DAEMON_PORT, state["token"]), stop_state={**state, "mode": mode})


def prepare(request: ProvisionRequest) -> Provision:
    """Seed the trial's data dir. The daemon that reads it is the container's, started by the entrypoint."""
    source = request.source
    if not isinstance(source, Source):
        raise ProvisionError(f"arm {request.arm.get('id')!r} declares provision {NAME!r}, which needs live-run --tenjin-source")
    roots = request.roots
    hooks = roots.data_dir / HOOKS_DIR
    hooks.mkdir(parents=True, exist_ok=True)
    for name, bundle in source.bundles.items():
        (hooks / name).write_bytes(bundle.read_bytes())
    # A producer arm seeds nothing: what its consumer finds is what its
    # producer left. Every other provisioned arm seeds the task's lessons on
    # the team shelf.
    mode = "producer" if request.arm.get("producer") else "consumer"
    # A dry run mints nothing: its settings file may be read by anyone
    # reviewing the plan, so the token there is a label and not a secret.
    token = DRY_TOKEN if request.dry_run else secrets.token_hex(32)
    if not request.dry_run:
        token_path = roots.data_dir / TOKEN_FILE
        token_path.write_text(token, encoding="utf-8")
        token_path.chmod(0o600)
    # The port is the same in a dry run: it is the container's, and a plan
    # that prints the URL a hook would post to is the point of a dry run.
    port = DAEMON_PORT
    disabled = disabled_arms(request.arm)
    write_config(roots, source, port, with_secret=not request.dry_run, mode=mode, disabled=disabled)
    facts: dict[str, Any] = {**source.facts, "daemon_mode": mode, "hooks_disabled": list(disabled)}
    lessons = [] if request.task is None or mode == "producer" else lessons_for(request.task, selected=request.arm.get("lessons"))
    task_id = str(request.task["id"]) if request.task is not None else ""
    pieces: list[str] = []
    probed: dict[str, dict[str, str | None]] | None = None
    if lessons and not request.dry_run:
        if request.environment is None:
            raise ProvisionError("seeding needs the trial's child environment to probe the fixture's commands")
        commands = [entry.command.replace("{task}", task_id) for lesson in lessons for entry in lesson.commands]
        probed = probe_keys(roots, commands, request.environment, request.image)
        for lesson in lessons:
            check_keys(lesson, task_id, probed)
    if lessons:
        # The lesson: keyed, published through the CLI before the daemon
        # starts, so a publish that fails costs no daemon and no spend. A dry
        # run states the title and the key hashes and publishes nothing.
        if not request.dry_run and not request.nonce:
            raise ProvisionError("seeding needs the run nonce (`cli.run_nonce`) so the body differs from every earlier run's")
        seeds = []
        for lesson in lessons:
            piece_id: str | None = None
            if not request.dry_run:
                try:
                    piece_id = publish_lesson(source, roots, lesson, str(request.nonce), request.trial_id)
                except ProvisionError:
                    # A second piece that fails leaves no first piece behind.
                    for published in pieces:
                        delete_lesson(source, published)
                    raise
                pieces.append(piece_id)
            seeds.append(seed_facts(lesson, source, piece_id, probed, request.nonce, task_id))
        facts["seed"] = seeds
    stop_state: dict[str, Any] = {}
    if not request.dry_run:
        stop_state = {"port": port, "pieces": pieces, "source": source, "token": token, "mode": mode, "disabled": disabled}
    return Provision(
        values=_values(roots, port, token),
        secrets=source.secrets,
        origins=source.origins,
        facts=facts,
        stop_state=stop_state,
    )


def stop(roots: artifact.TrialRoots, provision: Provision) -> dict[str, Any]:
    """Read the container's daemon report, wait for the WAL, snapshot the shelf, and take the seeded pieces off it."""
    state = provision.stop_state
    report = settle_daemon(roots, roots.output)
    # The seeded piece leaves the shelf with the trial. A delete that fails is
    # a fact in the record, never a retry loop and never silence.
    pieces = state.get("pieces")
    source = state.get("source")
    if isinstance(pieces, list) and pieces and isinstance(source, Source):
        # The shortlist first, while the pieces are still on the shelf. After
        # the delete the same question cannot return them, so a later replay
        # measures precision and nothing about recall. The WAL has settled
        # above, which is what makes the ledger readable here.
        report["shortlist"] = write_shortlist(roots, source, pieces)
        report["seed_deleted"] = {piece_id: delete_lesson(source, piece_id) for piece_id in pieces}
    return report
