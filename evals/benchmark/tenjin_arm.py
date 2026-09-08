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
import secrets
import signal
import socket
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlsplit

from . import artifact, runner
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
            raise
        port = live["port"]
        stop_state = {"started": started, "pid": live["pid"], "port": port}
    return Provision(
        values={"daemon_url": f"http://127.0.0.1:{port}{HOOK_PATH}", "daemon_token": token, "data_dir": str(roots.data_dir)},
        secrets=source.secrets,
        origins=source.origins,
        facts=source.facts,
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
    return report
