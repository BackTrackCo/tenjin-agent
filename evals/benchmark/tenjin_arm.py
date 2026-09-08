"""The Tenjin hooks arm: a seeded data dir and one loop daemon per trial.

The product's hooks read their configuration from `<TENJIN_DATA_DIR>/config.json`
and talk to a loopback daemon that reads `daemon.token` and the bundles under
`<TENJIN_DATA_DIR>/hooks/`. None of that comes from the environment, so an arm
that runs the real hooks cannot be an environment difference: it has to be a
seeded data dir. This module builds one per trial from an operator-supplied
source data dir (`live-run --tenjin-source`), copying exactly `COPIED_KEYS` and
the two bundles, forcing the seeded constants in `SEEDED`, minting a fresh
daemon token, starting one daemon on a free loopback port, and stopping it
before the trial's `loop.db` is read.

The team shelf secret is one of the copied keys. It enters the trial by
construction, so the run says so: `Source.facts` becomes part of the record's
isolation block, the secret's value is a sentinel canary for everything the
agent wrote, and a run that carries it is never publishable. The value is held
in memory here and written to the seeded config only; nothing in this module
logs it, prints it, or hashes it.
"""

from __future__ import annotations

import json
import os
import re
import secrets
import shutil
import signal
import socket
import subprocess
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlsplit

from . import FIXTURES, artifact, runner, sha256_text, signature
from .executor import Provision, ProvisionError, ProvisionRequest

NAME = "tenjin"
CONFIG_FILE = "config.json"
TOKEN_FILE = "daemon.token"
PID_FILE = "daemon.pid"
LOOP_DB = "loop.db"
HOOKS_DIR = "hooks"
DAEMON_BUNDLE = "tenjin-daemon.mjs"
SHIM_BUNDLE = "tenjin-shim.mjs"
BUNDLES = (DAEMON_BUNDLE, SHIM_BUNDLE)
HOOK_PATH = "/hook/claude"
# The only keys copied from the source config. `shelfBypassSecret` is the
# team shelf secret and is what makes a run non-publishable; nothing about a
# wallet, a session key, or a spend ledger is on this list.
COPIED_KEYS = ("baseUrl", "publicShelfUrl", "shelfBypassSecret")
SECRET_KEY = "shelfBypassSecret"
# Forced whatever the source says. Review mode so a capture can never publish
# from a trial, capture off because this is a consumer-only measurement, public
# fallback on because that is the product as shipped and as Bench-3 runs it (a
# team miss then reaches the public marketplace, which is a named origin and a
# counted leg), and a short idle exit so a daemon this module lost track of
# ends itself.
SEEDED: dict[str, Any] = {
    "publish": {"mode": "review"},
    "hooks": {"capture": "off"},
    "team": {"publicFallback": "on"},
    "loop": {"idle_exit_min": 2},
}
HEALTH_TIMEOUT_S = 15.0
HEALTH_POLL_S = 0.05
STOP_GRACE_S = 5.0
WAL_TIMEOUT_S = 5.0
PLACEHOLDERS = ("daemon_url", "daemon_token", "data_dir")
DRY_TOKEN = "minted-at-launch"
# The seeded lesson: one piece per lesson family under `fixtures/live/lessons/`,
# published into the team shelf through the CLI at prepare, under the `sig_v1`
# keys the fixture's failing commands yield, and deleted at stop. The keys are
# frozen beside the body and re-derived at prepare by running those commands
# on a scratch copy of the trial's repository, so drift is a refusal.
LESSONS = FIXTURES / "live" / "lessons"
LESSON_KEYS = frozenset({"family", "title", "commands"})
COMMAND_KEYS = frozenset({"command", "sig_v1", "check", "reason"})
CLI = "tenjin"
PROBE_DIR = "probe"
SEED_DIR = "seed"
PROBE_TIMEOUT_S = 120
CLI_TIMEOUT_S = 180
OUTPUT_LIMIT = 300


@dataclass(frozen=True)
class LessonCommand:
    command: str
    sig_v1: str | None
    check: bool
    reason: str


@dataclass(frozen=True)
class Lesson:
    family: str
    title: str
    body: Path
    commands: tuple[LessonCommand, ...]

    @property
    def keys(self) -> tuple[str, ...]:
        return tuple(entry.sig_v1 for entry in self.commands if entry.sig_v1 is not None)

    @property
    def key_hashes(self) -> list[str]:
        return [key_hash(key) for key in self.keys]


def key_hash(key: str) -> str:
    return sha256_text(f"sig_v1:{key}")[:16]


def lesson_for(family: str, lessons: Path | None = None) -> Lesson | None:
    """The family's lesson, or None when the benchmark holds none for it (the plumbing smoke)."""
    lessons = LESSONS if lessons is None else lessons
    record = lessons / f"{family}.json"
    body = lessons / f"{family}.md"
    if not record.is_file():
        return None
    try:
        data = json.loads(record.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ProvisionError(f"lesson {family!r} is unreadable: {error.__class__.__name__}") from error
    if not isinstance(data, dict) or set(data) != LESSON_KEYS or data["family"] != family or not body.is_file():
        raise ProvisionError(f"lesson {family!r} must be {record.name} with family, title, commands, and {body.name} beside it")
    commands = []
    for entry in data["commands"]:
        if not isinstance(entry, dict) or set(entry) != COMMAND_KEYS or not isinstance(entry["check"], bool):
            raise ProvisionError(f"lesson {family!r} has a malformed command entry")
        if entry["sig_v1"] is not None and not re.fullmatch(r"[0-9a-f]{16}", str(entry["sig_v1"])):
            raise ProvisionError(f"lesson {family!r} names a key that is not 16 hex characters")
        commands.append(LessonCommand(str(entry["command"]), entry["sig_v1"], entry["check"], str(entry["reason"])))
    if not any(entry.sig_v1 is not None for entry in commands):
        raise ProvisionError(f"lesson {family!r} has no keyed command")
    return Lesson(family=family, title=str(data["title"]), body=body, commands=tuple(commands))


def probe_keys(roots: artifact.TrialRoots, lesson: Lesson, task_id: str, environment: dict[str, str]) -> dict[str, str | None]:
    """Run each of the lesson's commands on a scratch copy of the trial's repository and key its output the product's way."""
    probe = roots.base / PROBE_DIR
    if probe.exists():
        shutil.rmtree(probe)
    shutil.copytree(roots.repo, probe, symlinks=False)
    probed: dict[str, str | None] = {}
    try:
        for entry in lesson.commands:
            command = entry.command.replace("{task}", task_id)
            try:
                completed = subprocess.run(
                    command.split(" "), cwd=probe, env=environment, capture_output=True, text=True, timeout=PROBE_TIMEOUT_S, shell=False, check=False
                )
            except (OSError, subprocess.TimeoutExpired) as error:
                raise ProvisionError(f"the seed probe could not run {command!r}: {error.__class__.__name__}") from error
            probed[command] = signature.key_of((completed.stdout or "") + "\n" + (completed.stderr or ""))["key"]
    finally:
        shutil.rmtree(probe, ignore_errors=True)
    return probed


def check_keys(lesson: Lesson, task_id: str, probed: dict[str, str | None]) -> None:
    """The frozen keys must be what the trial's own commands yield today, or the seed is a lie."""
    for entry in lesson.commands:
        if not entry.check:
            continue
        command = entry.command.replace("{task}", task_id)
        if probed.get(command) != entry.sig_v1:
            raise ProvisionError(
                f"seed key drift: {command!r} keys to {probed.get(command)!r}, the lesson records {entry.sig_v1!r}; "
                f"re-derive {lesson.family}.json before seeding"
            )


def publish_argv(body: Path, keys: tuple[str, ...]) -> list[str]:
    argv = [CLI, "publish", str(body), "--yes", "--json"]
    for key in keys:
        argv += ["--key", f"fingerprint=sig_v1:{key}"]
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


def cli_environment(source: Source, parent: dict[str, str] | None = None) -> dict[str, str]:
    """The operator's own data dir (its wallet signs the publish), and nothing else of the operator's."""
    parent = os.environ if parent is None else parent
    env = {"PATH": parent.get("PATH", ""), "HOME": parent.get("HOME", ""), "TENJIN_DATA_DIR": os.path.abspath(source.path)}
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
    raise ProvisionError(f"seeding the lesson failed: tenjin publish exited {code}: {tail or 'no output'}")


def delete_lesson(source: Source, piece_id: str) -> str | None:
    """Delete the seeded piece. Returns None on success, else the reason, so the record can say it."""
    code, payload, tail = _run_cli(DELETE_ARGV(piece_id), cli_environment(source), source.secrets)
    if code == 0 and _find(payload, "deleted") is True:
        return None
    return f"tenjin delete exited {code}: {tail or 'no output'}"


def seed_facts(lesson: Lesson, source: Source, piece_id: str | None, probed: dict[str, str | None] | None, nonce: str | None) -> dict[str, Any]:
    return {
        "title": lesson.title,
        "nonce": nonce,
        "key_hashes": lesson.key_hashes,
        "keys": len(lesson.keys),
        "shelf_origin": source.shelf_origin,
        "piece_id": piece_id,
        "published": piece_id is not None,
        # Hashes, like `key_hashes`: the record names which command keyed and which did not, never the key itself.
        "probe": None if probed is None else {command: None if key is None else key_hash(key) for command, key in probed.items()},
        "deleted": None,
        "delete_error": None,
    }


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
        return _host(self.config.get("publicShelfUrl"))

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


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def data_dir_string(roots: artifact.TrialRoots) -> str:
    """The data dir as the product spells it: absolute, symlinks kept.

    The daemon compares `TENJIN_DATA_DIR` strings, not inodes, and the shim
    respawns a daemon whose `/health` names a different string. Node's
    `path.resolve` keeps symlinks, so this must too.
    """
    return os.path.abspath(roots.data_dir)


def seeded_config(source: Source, port: int, *, with_secret: bool = True) -> dict[str, Any]:
    config = {key: value for key, value in source.config.items() if with_secret or key != SECRET_KEY}
    return {**config, **SEEDED, "loop": {**SEEDED["loop"], "port": port}}


def daemon_argv(roots: artifact.TrialRoots) -> list[str]:
    return ["node", str(roots.data_dir / HOOKS_DIR / DAEMON_BUNDLE)]


# The seam a test replaces with a fake daemon. Code-owned: the manifest never
# names a program.
DAEMON_ARGV: Callable[[artifact.TrialRoots], list[str]] = daemon_argv


def daemon_environment(roots: artifact.TrialRoots, parent: dict[str, str] | None = None) -> dict[str, str]:
    """The daemon's allowlist: the trial's own roots and the locale names, nothing of the operator's."""
    parent = os.environ if parent is None else parent
    env = {"PATH": parent.get("PATH", ""), "HOME": str(roots.home), "TENJIN_DATA_DIR": data_dir_string(roots)}
    for name in ("LANG", "TMPDIR"):
        if parent.get(name):
            env[name] = parent[name]
    return env


def read_pid(data_dir: Path) -> dict[str, Any] | None:
    try:
        record = json.loads((data_dir / PID_FILE).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(record, dict) or not isinstance(record.get("pid"), int) or not isinstance(record.get("port"), int):
        return None
    return record


def health(port: int, timeout_s: float = 0.5) -> dict[str, Any] | None:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=timeout_s) as response:
            body = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError):
        return None
    if not isinstance(body, dict) or not isinstance(body.get("pid"), int) or not isinstance(body.get("data_dir"), str):
        return None
    return body


def wait_healthy(roots: artifact.TrialRoots, started: runner.Started, deadline_s: float) -> dict[str, Any]:
    """Poll `daemon.pid` and `/health` until the daemon for this data dir answers."""
    expected = data_dir_string(roots)
    end = time.monotonic() + deadline_s
    while time.monotonic() < end:
        if started.process.poll() is not None:
            raise ProvisionError(f"the daemon exited with {started.process.returncode} before it was healthy; see {roots.output / 'daemon.log'}")
        record = read_pid(roots.data_dir)
        if record is not None:
            body = health(record["port"])
            if body is not None and body["data_dir"] == expected and body["pid"] == started.process.pid:
                return {"pid": body["pid"], "port": record["port"]}
        time.sleep(HEALTH_POLL_S)
    raise ProvisionError(f"the daemon did not answer /health within {deadline_s:.0f}s; see {roots.output / 'daemon.log'}")


def prepare(request: ProvisionRequest) -> Provision:
    """Seed the trial's data dir and, unless this is a dry run, start its daemon."""
    source = request.source
    if not isinstance(source, Source):
        raise ProvisionError(f"arm {request.arm.get('id')!r} declares provision {NAME!r}, which needs live-run --tenjin-source")
    roots = request.roots
    hooks = roots.data_dir / HOOKS_DIR
    hooks.mkdir(parents=True, exist_ok=True)
    for name, bundle in source.bundles.items():
        (hooks / name).write_bytes(bundle.read_bytes())
    # A dry run mints nothing: its settings file may be read by anyone
    # reviewing the plan, so the token there is a label and not a secret.
    token = DRY_TOKEN if request.dry_run else secrets.token_hex(32)
    if not request.dry_run:
        token_path = roots.data_dir / TOKEN_FILE
        token_path.write_text(token, encoding="utf-8")
        token_path.chmod(0o600)
    port = 0 if request.dry_run else free_port()
    config_path = roots.data_dir / CONFIG_FILE
    config_path.write_text(json.dumps(seeded_config(source, port, with_secret=not request.dry_run), indent=2) + "\n", encoding="utf-8")
    config_path.chmod(0o600)
    # The lesson: keyed, published through the CLI before the daemon starts,
    # so a publish that fails costs no daemon and no spend. A dry run states
    # the title and the key hashes and publishes nothing.
    facts: dict[str, Any] = dict(source.facts)
    lesson = None if request.task is None else lesson_for(str(request.task.get("family", "")))
    piece_id: str | None = None
    if lesson is not None:
        task_id = str(request.task["id"]) if request.task is not None else ""
        probed = None
        if not request.dry_run:
            if request.environment is None:
                raise ProvisionError("seeding needs the trial's child environment to probe the fixture's commands")
            if not request.nonce:
                raise ProvisionError("seeding needs the run nonce (`cli.run_nonce`) so the body differs from every earlier run's")
            probed = probe_keys(roots, lesson, task_id, request.environment)
            check_keys(lesson, task_id, probed)
            piece_id = publish_lesson(source, roots, lesson, request.nonce, request.trial_id)
        facts["seed"] = seed_facts(lesson, source, piece_id, probed, request.nonce)
    stop_state: dict[str, Any] = {}
    if not request.dry_run:
        started = runner.process_start(
            DAEMON_ARGV(roots),
            cwd=roots.data_dir,
            env=daemon_environment(roots),
            roots=roots,
            ledger_id=f"{roots.trial_id}.daemon",
            log=roots.output / "daemon.log",
        )
        try:
            live = wait_healthy(roots, started, HEALTH_TIMEOUT_S)
        except ProvisionError:
            runner.process_stop(started, roots.run_dir, STOP_GRACE_S)
            if piece_id is not None:
                delete_lesson(source, piece_id)
            raise
        port = live["port"]
        stop_state = {"started": started, "pid": live["pid"], "port": port, "piece_id": piece_id, "source": source}
    return Provision(
        values={"daemon_url": f"http://127.0.0.1:{port}{HOOK_PATH}", "daemon_token": token, "data_dir": str(roots.data_dir)},
        secrets=source.secrets,
        origins=source.origins,
        facts=facts,
        stop_state=stop_state,
    )


def _terminate(pid: int, grace_s: float) -> bool:
    """SIGTERM one pid we identified by its own `/health`, then SIGKILL. Never by name."""
    try:
        if os.getpgid(pid) == os.getpgid(0):
            return False
        os.kill(pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        return True
    end = time.monotonic() + grace_s
    while time.monotonic() < end:
        try:
            os.kill(pid, 0)
        except (ProcessLookupError, PermissionError):
            return True
        time.sleep(HEALTH_POLL_S)
    try:
        os.kill(pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass
    return True


def stop(roots: artifact.TrialRoots, provision: Provision) -> dict[str, Any]:
    """Stop the trial's daemon, and any daemon the shim respawned for this data dir, then wait for the WAL.

    The shim starts a detached daemon of its own when the one it expects is
    not healthy, and a detached process is outside the trial's process group.
    So this reads `daemon.pid` as it is now, confirms through `/health` that
    the pid serves exactly this data dir, and signals that pid; a pid that
    answers for another directory, or does not answer, is left alone.
    """
    state = provision.stop_state
    started: runner.Started | None = state.get("started")
    expected = data_dir_string(roots)
    report: dict[str, Any] = {"respawned": False, "wal_live": False}
    record = read_pid(roots.data_dir)
    if record is not None and (started is None or record["pid"] != started.process.pid):
        body = health(record["port"])
        if body is not None and body["data_dir"] == expected and body["pid"] == record["pid"]:
            report["respawned"] = True
            _terminate(record["pid"], STOP_GRACE_S)
    if started is not None:
        runner.process_stop(started, roots.run_dir, STOP_GRACE_S)
    wal = roots.data_dir / f"{LOOP_DB}-wal"
    end = time.monotonic() + WAL_TIMEOUT_S
    while wal.exists() and time.monotonic() < end:
        time.sleep(HEALTH_POLL_S)
    report["wal_live"] = wal.exists()
    # The seeded piece leaves the shelf with the trial. A delete that fails is
    # a fact in the record, never a retry loop and never silence.
    piece_id = state.get("piece_id")
    source = state.get("source")
    if isinstance(piece_id, str) and isinstance(source, Source):
        error = delete_lesson(source, piece_id)
        report["seed_deleted"] = error is None
        report["seed_delete_error"] = error
    return report
