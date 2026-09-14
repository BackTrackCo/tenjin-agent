#!/usr/bin/env python3
"""bench-lite: does a team shelf make the SECOND agent cheaper?

One measurement, two sessions. A *producer* task (A) is solved from scratch; a
*consumer* task (B) needs the same finding. Run that pair twice:

    off      A and B each in a fresh worktree, no Tenjin hooks anywhere.
    tenjin   same two tasks, but the CLI is installed in team mode against a
             dedicated bench shelf: A's turn-end hook captures and publishes
             what it learned, and B's prompt hook searches and injects it.

If the loop works, B's token count under `tenjin` is lower than under `off` by
more than A's capture overhead. That delta, per pair, is the whole point.

Everything is isolated from the operator's machine:

    claude --setting-sources project    hooks, permissions and skills come ONLY
                                        from the WORKTREE's own .claude/. The
                                        operator's ~/.claude settings, skills and
                                        CLAUDE.md are all excluded (measured).
    HOME=<worktree> tenjin install      so the CLI writes its hook entries and
                                        skills into that worktree's .claude/
                                        rather than into ~/.claude.
    TENJIN_DATA_DIR=<sandbox>/tenjin    the CLI's config, wallet, ledger and
                                        daemon port are per session. ~/.tenjin is
                                        never touched.

The agent itself runs under the REAL HOME, because that is where its login is:
redirecting HOME (with or without CLAUDE_CONFIG_DIR) returns "Not logged in ·
Please run /login", both measured. `--setting-sources project` is what buys the
isolation instead, and it buys all of it — user hooks, user skills and the user's
global CLAUDE.md were all confirmed absent from a sandbox session.

So the two conditions differ in exactly one thing: whether `tenjin install` ran
against the worktree before the agent did.

Usage:

    python3 evals/bench-lite/run.py prepare
    python3 evals/bench-lite/run.py --pairs evals/bench-lite/pairs.sample.json \\
        --conditions off,tenjin --repeats 3 --model claude-sonnet-5 \\
        --out runs/2026-09-14a --dry-run
    python3 evals/bench-lite/run.py cleanup --out runs/2026-09-14a

Stdlib only. See README.md for the pairs.json schema and the config keys
`prepare` writes.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import shutil
import signal
import sqlite3
import statistics
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

# --------------------------------------------------------------------------
# Machine-local anchors. Every one is overridable by flag or environment so the
# script is not welded to one laptop, but the defaults are this laptop.
# --------------------------------------------------------------------------

WORKSPACE = Path(
    os.environ.get("BENCH_LITE_WORKSPACE", "/Users/vraspar/IdeaProjects/tenjin-workspace")
)

# `repo` in pairs.json maps to one of these checkouts. Worktrees are cut FROM
# them (`git worktree add --detach`), so a bench run never checks anything out
# in the checkout itself.
CHECKOUTS = {
    "tenjin": WORKSPACE / "tenjin",
    "tenjin-agent": WORKSPACE / "tenjin-agent",
}

SCRATCH_ROOT = Path(
    os.environ.get(
        "BENCH_LITE_SCRATCH",
        "/private/tmp/claude-501/-Users-vraspar-IdeaProjects-tenjin-workspace"
        "/225615cf-3785-40b7-bf47-5c5322385a7b/scratchpad/bench-lite-runs",
    )
)

# Where the bench shelf's origin and Vercel protection-bypass secret live. Read,
# never echoed: both values are registered with the redactor on load.
BENCH_ENV_FILE = Path(os.environ.get("BENCH_LITE_ENV_FILE", str(WORKSPACE / "tenjin-bench.env")))

# The data dir `prepare` builds once and every `tenjin` session copies.
TEMPLATE_DATA_DIR = SCRATCH_ROOT / "template-data"

# THE REAL BINARY. `claude` first on PATH is a cmux shim that makes harness
# detection pick Codex; never use it.
DEFAULT_CLAUDE_BIN = os.environ.get("BENCH_LITE_CLAUDE_BIN", "/Users/vraspar/.local/bin/claude")
DEFAULT_TENJIN_BIN = os.environ.get("BENCH_LITE_TENJIN_BIN", "tenjin")

DEFAULT_MODEL = "claude-sonnet-5"
# The wall-clock cap on ONE agent session. Smoke-1 capped a producer at 1800s
# while it was still actively working (192 turns, 35 edits), so the default is
# an hour; a pair may raise or lower it per session with `cap_s`.
DEFAULT_CAP_S = 3600
PNPM_TIMEOUT_S = 30 * 60
ORACLE_TIMEOUT_S = 20 * 60
CLI_TIMEOUT_S = 180

ROLES = ("producer", "consumer")
CONDITIONS = ("off", "tenjin")

UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)

TAIL_CHARS = 4000


# --------------------------------------------------------------------------
# Redaction. The bypass secret and the wallet passphrase pass through argv and
# can come back in a CLI error line; nothing captured reaches a record or the
# terminal without going through here first.
# --------------------------------------------------------------------------

_SECRETS: dict[str, str] = {}
_SECRETS_LOCK = threading.Lock()


def register_secret(value: str | None, label: str) -> None:
    if value is None:
        return
    value = value.strip()
    if len(value) < 6:
        return
    with _SECRETS_LOCK:
        _SECRETS[value] = f"<redacted:{label}>"


def redact(text: str | None) -> str:
    if not text:
        return "" if text is None else text
    with _SECRETS_LOCK:
        items = list(_SECRETS.items())
    for value, mask in items:
        text = text.replace(value, mask)
    return text


def out(msg: str = "") -> None:
    print(redact(msg), flush=True)


def die(msg: str, code: int = 1) -> "NoReturn":  # type: ignore[valid-type]
    print(redact(f"bench-lite: {msg}"), file=sys.stderr, flush=True)
    raise SystemExit(code)


# --------------------------------------------------------------------------
# Small helpers
# --------------------------------------------------------------------------


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def tail(text: str, limit: int = TAIL_CHARS) -> str:
    text = redact(text or "")
    if len(text) <= limit:
        return text
    return "…(truncated)…\n" + text[-limit:]


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def median(values: Iterable[float]) -> float | None:
    vals = [v for v in values if v is not None]
    return round(statistics.median(vals), 4) if vals else None


def shell_quote(arg: str) -> str:
    if re.fullmatch(r"[A-Za-z0-9_@%+=:,./-]+", arg or ""):
        return arg or "''"
    return "'" + arg.replace("'", "'\\''") + "'"


def render_cmd(
    argv: list[str],
    cwd: Path | None,
    env_overlay: dict[str, str] | None,
    stdin_chars: int | None = None,
) -> str:
    parts = []
    for key in sorted(env_overlay or {}):
        value = env_overlay[key]
        if key == "PATH":
            # The full PATH is ~1.5 KB of inherited entries and would bury every
            # command in the log. Only the prefix this runner adds is news.
            prefix = value.split(os.pathsep)[0] if value else ""
            parts.append(f'PATH="{prefix}:$PATH"')
            continue
        parts.append(f"{key}={shell_quote(redact(value))}")
    parts.extend(shell_quote(redact(a)) for a in argv)
    prefix = f"(cd {shell_quote(str(cwd))} && " if cwd else "("
    suffix = f"   # <<< {stdin_chars} chars on stdin" if stdin_chars else ""
    return prefix + " ".join(parts) + ")" + suffix


# --------------------------------------------------------------------------
# Command runner. Every subprocess in this file goes through here so that every
# command is logged, every capture is redacted, and --dry-run is one branch.
# --------------------------------------------------------------------------


class Runner:
    """Runs subprocesses, logs them, and honours --dry-run."""

    def __init__(self, log_path: Path | None, dry_run: bool, verbose: bool = True) -> None:
        self.log_path = log_path
        self.dry_run = dry_run
        self.verbose = verbose
        self._lock = threading.Lock()
        if log_path is not None:
            log_path.parent.mkdir(parents=True, exist_ok=True)

    def log(self, line: str) -> None:
        line = redact(line)
        with self._lock:
            if self.log_path is not None:
                with self.log_path.open("a", encoding="utf-8") as fh:
                    fh.write(line.rstrip("\n") + "\n")
            if self.verbose:
                print(line, flush=True)

    def run(
        self,
        argv: list[str],
        *,
        cwd: Path | None = None,
        env_overlay: dict[str, str] | None = None,
        timeout: int = CLI_TIMEOUT_S,
        stdin_text: str | None = None,
        check: bool = False,
        allow_in_dry_run: bool = False,
        label: str = "",
    ) -> dict[str, Any]:
        rendered = render_cmd(argv, cwd, env_overlay, len(stdin_text) if stdin_text else None)
        self.log(f"$ {label + ' ' if label else ''}{rendered}")

        if self.dry_run and not allow_in_dry_run:
            return {
                "argv": [redact(a) for a in argv],
                "rendered": rendered,
                "exit_code": None,
                "stdout": "",
                "stderr": "",
                "duration_ms": 0,
                "timed_out": False,
                "skipped": "dry-run",
            }

        env = os.environ.copy()
        env.update(env_overlay or {})
        started = time.monotonic()
        timed_out = False
        pid: int | None = None
        killed_group = False
        group_gone: bool | None = None

        # `subprocess.run(timeout=...)` kills only the direct child, so a timed-out
        # `claude` would leave its own tool subprocesses (pnpm, vitest, a dev
        # server) running with nobody to reap them. `start_new_session=True` puts
        # the child in its own process GROUP, and the timeout path signals the
        # whole group.
        try:
            proc = subprocess.Popen(
                argv,
                cwd=str(cwd) if cwd else None,
                env=env,
                stdin=subprocess.PIPE if stdin_text is not None else subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                start_new_session=True,
            )
        except FileNotFoundError as exc:
            code, stdout, stderr = 127, "", str(exc)
        else:
            pid = proc.pid
            try:
                stdout, stderr = proc.communicate(input=stdin_text, timeout=timeout)
                code = proc.returncode
            except subprocess.TimeoutExpired:
                timed_out = True
                killed_group = True
                self.log(f"  ! timeout after {timeout}s; killing process group {pid}")
                _kill_group(pid)
                try:
                    # The pipes are still open in the (now dead) children; drain
                    # what was produced before the kill.
                    stdout, stderr = proc.communicate(timeout=30)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    stdout, stderr = proc.communicate()
                code = proc.returncode
                group_gone = _group_is_gone(pid)
                self.log(f"  ! process group {pid} gone after kill: {group_gone}")
        duration_ms = int((time.monotonic() - started) * 1000)

        result = {
            "argv": [redact(a) for a in argv],
            "rendered": rendered,
            "exit_code": code,
            "pid": pid,
            "killed_process_group": killed_group,
            "process_group_gone": group_gone,
            "stdout": redact(stdout),
            "stderr": redact(stderr),
            # The UNREDACTED stdout, for structured parsing only. Redaction runs
            # at capture, so a masked value inside a JSON envelope would compare
            # unequal to the real one and quietly fail a check. Nothing writes
            # this key to a record or a log; `cli_json` is its only reader.
            "_stdout_raw": stdout,
            "duration_ms": duration_ms,
            "timed_out": timed_out,
        }
        if code != 0:
            self.log(f"  -> exit={code} timed_out={timed_out} ({duration_ms} ms)")
            if stderr.strip():
                self.log("  stderr: " + tail(stderr, 600).replace("\n", "\n  "))
        if check and code != 0:
            die(f"command failed ({label or argv[0]}): exit={code}\n{tail(stderr or stdout, 2000)}")
        return result


def _kill_group(pid: int) -> None:
    """SIGTERM the child's whole process group, then SIGKILL what is left.

    The group, not the pid: a timed-out agent has its own children (pnpm, vitest),
    and killing only the parent orphans them onto a laptop that several sessions
    already share."""
    try:
        pgid = os.getpgid(pid)
    except (ProcessLookupError, PermissionError):
        return
    for sig, grace in ((signal.SIGTERM, 5.0), (signal.SIGKILL, 2.0)):
        try:
            os.killpg(pgid, sig)
        except (ProcessLookupError, PermissionError):
            return
        deadline = time.monotonic() + grace
        while time.monotonic() < deadline:
            if _group_is_gone(pid):
                return
            time.sleep(0.1)


def _group_is_gone(pid: int) -> bool:
    """True when no process remains in the child's group. Signal 0 is the probe."""
    try:
        pgid = os.getpgid(pid)
    except (ProcessLookupError, PermissionError):
        return True
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return True
    except PermissionError:
        return False
    return False


def cli_json(result: dict[str, Any]) -> dict[str, Any] | None:
    """Parse a `--json` CLI envelope out of a captured stdout. Reads the raw
    capture, never the redacted one — see `_stdout_raw`."""
    text = (result.get("_stdout_raw") or result.get("stdout") or "").strip()
    if not text:
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    # A stray banner line before the envelope: take the last complete object.
    start = text.find("{")
    while start != -1:
        try:
            return json.loads(text[start:])
        except json.JSONDecodeError:
            start = text.find("{", start + 1)
    return None


# --------------------------------------------------------------------------
# Bench env + template data dir (the `prepare` subcommand)
# --------------------------------------------------------------------------


def load_bench_env() -> dict[str, str]:
    if not BENCH_ENV_FILE.is_file():
        die(f"bench env file not found: {BENCH_ENV_FILE}")
    values: dict[str, str] = {}
    for raw in BENCH_ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :]
        if "=" not in line:
            continue
        key, _, value = line.partition("=")
        value = value.strip().strip("'\"")
        values[key.strip()] = value
    missing = [k for k in ("TENJIN_BENCH_ORIGIN", "TENJIN_BENCH_BYPASS_SECRET") if not values.get(k)]
    if missing:
        die(f"{BENCH_ENV_FILE} is missing {', '.join(missing)}")
    # ONLY the bypass secret is a secret. The origin is a hostname that appears in
    # every post url this run records and in the funnel it reads back; masking it
    # would gut the records and break cleanup's own origin assertion.
    register_secret(values["TENJIN_BENCH_BYPASS_SECRET"], "bench-bypass-secret")
    return values


def passphrase_file(data_dir: Path) -> Path:
    return data_dir / "bench-wallet-passphrase"


def ensure_passphrase(data_dir: Path, dry_run: bool) -> str:
    """The bench wallet's passphrase, generated once and kept 0600 beside the
    keystore it opens. Headless signing reads it from TENJIN_WALLET_PASSPHRASE,
    so it must survive `prepare` rather than living in the OS keychain (which a
    copied data dir would not carry with it)."""
    env_value = os.environ.get("TENJIN_WALLET_PASSPHRASE", "").strip()
    path = passphrase_file(data_dir)
    if env_value:
        register_secret(env_value, "wallet-passphrase")
        if not dry_run:
            path.write_text(env_value, encoding="utf-8")
            path.chmod(0o600)
        return env_value
    if path.is_file():
        value = path.read_text(encoding="utf-8").strip()
        register_secret(value, "wallet-passphrase")
        return value
    value = secrets.token_urlsafe(32)
    register_secret(value, "wallet-passphrase")
    if not dry_run:
        path.write_text(value, encoding="utf-8")
        path.chmod(0o600)
    return value


def node_path_prefix() -> str:
    """The directory holding the `node` this runner resolves, for prepending to
    PATH.

    Smoke-1 ran its oracle under Node 18.14.2 while the runner itself was on
    24.19.0, and corepack (shipped with node@24) died on `URL.canParse is not a
    function` before a single test loaded. The cause was `bash -lc`: the `-l`
    re-sources the login profile, which rebuilds PATH from scratch and puts an
    older node first. The oracle is now run with `bash -c` so it inherits this
    process's PATH, and this prefix pins the node explicitly on top of that so a
    future profile change cannot silently move it again."""
    found = shutil.which("node")
    return str(Path(found).parent) if found else ""


def base_env(extra: dict[str, str] | None = None) -> dict[str, str]:
    """The env every runner-owned subprocess gets: CI, a pinned node, plus extras."""
    env = {"CI": "true"}
    prefix = node_path_prefix()
    if prefix:
        env["PATH"] = prefix + os.pathsep + os.environ.get("PATH", "")
    env.update(extra or {})
    return env


def probe_node_version(runner: Runner, cwd: Path, env_overlay: dict[str, str]) -> dict[str, Any]:
    """`node --version` and `pnpm --version` as the oracle's own env sees them,
    recorded per session so a version skew is visible in the record rather than
    only in a stack trace."""
    out: dict[str, Any] = {}
    for tool, argv in (("node", ["node", "--version"]), ("pnpm", ["pnpm", "--version"])):
        res = runner.run(
            ["bash", "-c", " ".join(argv)],
            cwd=cwd,
            env_overlay=env_overlay,
            timeout=60,
            label=f"probe.{tool}",
        )
        out[tool] = (res["stdout"] or res["stderr"] or "").strip().splitlines()[:1]
        out[tool] = out[tool][0] if out[tool] else None
    return out


def tenjin_env(data_dir: Path, passphrase: str | None) -> dict[str, str]:
    env = base_env({"TENJIN_DATA_DIR": str(data_dir)})
    if passphrase:
        env["TENJIN_WALLET_PASSPHRASE"] = passphrase
    return env


# The config keys team mode is made of. `shelfBypassSecret` non-empty is the one
# key that flips the CLI into team mode (src/lib/config.ts); `baseUrl` is then
# the team's own shelf, and `team.publicFallback off` stops a team miss from
# falling through to tenjin.blog (which would make the funnel unreadable).
def prepare_config_pairs(origin: str, secret: str) -> list[tuple[str, str]]:
    return [
        ("baseUrl", origin),
        ("shelfBypassSecret", secret),
        ("team.publicFallback", "off"),
        ("publish.mode", "full-auto"),
        ("publish.defaultPrice", "0"),
        ("publish.ackServerWarnings", "on"),
        # Belt and braces: the bench must never be able to spend. Both keys are
        # client-enforced, and both are zero here.
        ("maxAutoSpend", "0"),
        ("sessionBudget", "0"),
        ("sendMaxAmount", "0"),
        # Every arm on. `prompt` is the injection side of the measurement and
        # `publish` is the capture side; the rest ride along so the funnel shows
        # the whole loop rather than a slice of it.
        ("hooks.prompt", "true"),
        ("hooks.publish", "true"),
        ("hooks.primer", "true"),
        ("hooks.subagent", "true"),
        ("hooks.failure", "true"),
        ("hooks.web-search", "true"),
        ("hooks.web-fetch", "true"),
        # A stale update nudge on every session would be noise in the token
        # counts and one more network call per run.
        ("update.mode", "off"),
    ]


def cmd_prepare(args: argparse.Namespace) -> int:
    values = load_bench_env()
    origin = values["TENJIN_BENCH_ORIGIN"].rstrip("/")
    secret = values["TENJIN_BENCH_BYPASS_SECRET"]

    runner = Runner(SCRATCH_ROOT / "prepare.log", args.dry_run)
    data_dir = TEMPLATE_DATA_DIR

    if data_dir.exists() and args.force:
        runner.log(f"# rm -rf {data_dir}")
        if not args.dry_run:
            shutil.rmtree(data_dir)
    if not args.dry_run:
        data_dir.mkdir(parents=True, exist_ok=True)
        data_dir.chmod(0o700)

    passphrase = ensure_passphrase(data_dir, args.dry_run)
    env = tenjin_env(data_dir, passphrase)

    out(f"template data dir: {data_dir}")
    out("setting team-mode config keys …")
    for key, value in prepare_config_pairs(origin, secret):
        runner.run(
            [args.tenjin_bin, "config", "set", key, value, "--json"],
            env_overlay=env,
            check=not args.dry_run,
            label="config.set",
        )

    # The wallet. One dedicated bench wallet, created in the template and copied
    # into every `tenjin` session, so every bench publish carries the same
    # non-operator address and `cleanup` knows exactly whose posts to retract.
    wallet_exists = (data_dir / "wallet.json").is_file()
    if not wallet_exists:
        runner.run(
            [args.tenjin_bin, "wallet", "create", "--json"],
            env_overlay=env,
            check=not args.dry_run,
            label="wallet.create",
        )
    else:
        out("wallet: already present, kept")

    # ---- verification -----------------------------------------------------
    verification: dict[str, Any] = {"at": now_iso(), "checks": []}

    def check(name: str, ok: bool | None, detail: str) -> None:
        verification["checks"].append({"name": name, "ok": ok, "detail": detail})
        mark = "ok " if ok else ("?? " if ok is None else "FAIL")
        out(f"  [{mark}] {name}: {detail}")

    if args.dry_run:
        out("\ndry-run: no verification performed")
        return 0

    out("\nverifying …")
    got = cli_json(
        runner.run([args.tenjin_bin, "config", "get", "baseUrl", "--json"], env_overlay=env)
    )
    base_url = (got or {}).get("data", {}).get("value")
    check(
        "baseUrl is the bench origin",
        base_url == origin,
        "matches TENJIN_BENCH_ORIGIN" if base_url == origin else f"got {redact(str(base_url))}",
    )

    got = cli_json(
        runner.run(
            [args.tenjin_bin, "config", "get", "shelfBypassSecret", "--json"], env_overlay=env
        )
    )
    secret_view = (got or {}).get("data", {}).get("value")
    check(
        "shelfBypassSecret set (team mode on)",
        bool(secret_view),
        "present (value redacted by the CLI)" if secret_view else "empty — still public mode",
    )

    for key, expected in (
        ("team.publicFallback", "off"),
        ("publish.mode", "full-auto"),
        ("update.mode", "off"),
    ):
        got = cli_json(runner.run([args.tenjin_bin, "config", "get", key, "--json"], env_overlay=env))
        value = (got or {}).get("data", {}).get("value")
        check(key, value == expected, f"{value!r} (want {expected!r})")

    got = cli_json(
        runner.run([args.tenjin_bin, "config", "get", "publish.defaultPrice", "--json"], env_overlay=env)
    )
    price = (got or {}).get("data", {}).get("value")
    price_atomic = price.get("atomic") if isinstance(price, dict) else price
    check("publish.defaultPrice", str(price_atomic) == "0", f"atomic {price_atomic}")

    got = cli_json(runner.run([args.tenjin_bin, "wallet", "show", "--json"], env_overlay=env))
    address = (got or {}).get("data", {}).get("address")
    check("bench wallet", bool(address), str(address))
    verification["wallet_address"] = address

    # The live check: a search must reach the bench origin, and in team mode the
    # envelope names every shelf leg it asked.
    probe = args.probe
    search = runner.run(
        [args.tenjin_bin, "search", probe, "--json", "--limit", "1"],
        env_overlay=env,
        timeout=CLI_TIMEOUT_S,
        label="search",
    )
    envelope = cli_json(search)
    shelves = ((envelope or {}).get("data") or {}).get("shelves")
    if isinstance(shelves, list) and shelves:
        team_leg = next(
            (s for s in shelves if isinstance(s, dict) and s.get("shelf") == "team"), None
        )
        team_base = (team_leg or {}).get("baseUrl") or ""
        team_ok = team_base.rstrip("/") == origin
        check(
            "search asked the bench shelf",
            team_ok,
            f"team leg baseUrl is the bench origin ({len(shelves)} leg(s) total)"
            if team_ok
            else f"team leg baseUrl is {team_base!r}",
        )
        # NOT a failure. `team.publicFallback: off` filters the DAEMON's legs
        # (src/hooks/ask.ts), which is the path the benchmark measures. The
        # `tenjin search` verb asks both shelves in team mode regardless, so a
        # public leg here says nothing about what the hooks will do.
        other = [
            s.get("shelf")
            for s in shelves
            if isinstance(s, dict) and (s.get("baseUrl") or "").rstrip("/") != origin
        ]
        check(
            "public leg (informational)",
            True,
            "none" if not other else f"the search VERB also asked: {', '.join(map(str, other))}"
            " — the hook path drops it under team.publicFallback: off",
        )
        errors = [s.get("error") for s in shelves if isinstance(s, dict) and s.get("error")]
        check("shelf legs answered", not errors, "no leg errors" if not errors else redact(str(errors)))
    else:
        check(
            "search asked the bench shelf",
            False,
            f"no `shelves` in the envelope (exit={search['exit_code']}): {tail(search['stderr'] or search['stdout'], 500)}",
        )
    verification["search_shelves"] = shelves
    verification["config_keys_set"] = [k for k, _ in prepare_config_pairs(origin, secret)]

    write_json(data_dir / "bench-prepare.json", verification)
    ok = all(c["ok"] for c in verification["checks"])
    out(f"\nprepare {'OK' if ok else 'FINISHED WITH FAILURES'} — record: {data_dir / 'bench-prepare.json'}")
    return 0 if ok else 1


# --------------------------------------------------------------------------
# pairs.json
# --------------------------------------------------------------------------


def load_pairs(path: Path, only: list[str] | None) -> list[dict[str, Any]]:
    if not path.is_file():
        die(f"pairs file not found: {path}")
    try:
        pairs = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        die(f"{path} is not valid JSON: {exc}")
    if not isinstance(pairs, list):
        die(f"{path} must hold a JSON array of pairs")
    seen: set[str] = set()
    for pair in pairs:
        pid = pair.get("id")
        if not pid:
            die("every pair needs an `id`")
        if pid in seen:
            die(f"duplicate pair id: {pid}")
        seen.add(pid)
        for role in ROLES:
            spec = pair.get(role)
            if not isinstance(spec, dict):
                die(f"pair {pid}: missing `{role}` object")
            for key in ("repo", "base_commit", "prompt_file", "oracle"):
                if key not in spec:
                    die(f"pair {pid}.{role}: missing `{key}`")
            if spec["repo"] not in CHECKOUTS:
                die(f"pair {pid}.{role}: repo must be one of {sorted(CHECKOUTS)}")
            oracle = spec["oracle"]
            if not isinstance(oracle, dict) or "command" not in oracle:
                die(f"pair {pid}.{role}: oracle needs a `command`")
            if is_whole_suite(oracle["command"]):
                die(
                    f"pair {pid}.{role}: the oracle command looks like a whole-suite run. "
                    "Name the test files."
                )
            for item in oracle.get("copy", []) or []:
                if not isinstance(item, dict) or "from" not in item or "to" not in item:
                    die(f"pair {pid}.{role}: every oracle.copy entry needs `from` and `to`")
                # The destination is resolved against the worktree, so an absolute
                # path or a `..` would escape it. The upstream bench3 harness
                # stages a file at the container-absolute `/benchmark-database.mjs`;
                # a local runner must never write there, so this is refused at load
                # rather than discovered as a permission error mid-run.
                dest = Path(item["to"])
                if dest.is_absolute() or ".." in dest.parts:
                    die(
                        f"pair {pid}.{role}: oracle.copy destination must stay inside the "
                        f"worktree, got {item['to']!r}"
                    )
                src = resolve_rel(path.parent, item["from"])
                if not src.is_file():
                    die(f"pair {pid}.{role}: oracle.copy source not found: {src}")
            prompt = resolve_rel(path.parent, spec["prompt_file"])
            if not prompt.is_file():
                die(f"pair {pid}.{role}: prompt file not found: {prompt}")
    if only:
        pairs = [p for p in pairs if p["id"] in set(only)]
        missing = set(only) - {p["id"] for p in pairs}
        if missing:
            die(f"--only named unknown pair id(s): {', '.join(sorted(missing))}")
    if not pairs:
        die("no pairs selected")
    return pairs


def resolve_rel(base: Path, value: str) -> Path:
    p = Path(value)
    return p if p.is_absolute() else (base / p)


# --------------------------------------------------------------------------
# git worktrees
# --------------------------------------------------------------------------

_GIT_LOCK = threading.Lock()


def ensure_commit(runner: Runner, checkout: Path, commit: str) -> None:
    probe = runner.run(
        ["git", "-C", str(checkout), "cat-file", "-e", f"{commit}^{{commit}}"],
        allow_in_dry_run=True,
        label="git.cat-file",
    )
    if probe["exit_code"] == 0:
        return
    runner.log(f"# commit {commit} not present in {checkout}; fetching")
    runner.run(
        ["git", "-C", str(checkout), "fetch", "--all", "--tags", "--quiet"],
        timeout=600,
        label="git.fetch",
    )
    again = runner.run(
        ["git", "-C", str(checkout), "cat-file", "-e", f"{commit}^{{commit}}"],
        allow_in_dry_run=True,
        label="git.cat-file",
    )
    if again["exit_code"] != 0 and not runner.dry_run:
        die(f"commit {commit} is not reachable in {checkout} even after a fetch")


def add_worktree(runner: Runner, checkout: Path, commit: str, dest: Path) -> dict[str, Any]:
    with _GIT_LOCK:  # `git worktree add` takes a repo-wide lock; serialize.
        ensure_commit(runner, checkout, commit)
        if not runner.dry_run:  # a dry run must create nothing
            dest.parent.mkdir(parents=True, exist_ok=True)
        return runner.run(
            ["git", "-C", str(checkout), "worktree", "add", "--detach", str(dest), commit],
            timeout=600,
            label="git.worktree.add",
        )


def remove_worktree(runner: Runner, checkout: Path, dest: Path) -> None:
    with _GIT_LOCK:
        runner.run(
            ["git", "-C", str(checkout), "worktree", "remove", "--force", str(dest)],
            timeout=300,
            label="git.worktree.remove",
        )
        runner.run(
            ["git", "-C", str(checkout), "worktree", "prune"],
            timeout=120,
            label="git.worktree.prune",
        )


def capture_patch(runner: Runner, worktree: Path, dest: Path) -> dict[str, Any]:
    """The agent's diff, kept after the worktree is gone. `git add -A` stages new
    files too (node_modules is gitignored, so an install does not land here).

    `.claude` is excluded in BOTH conditions: under `tenjin` it holds the hook
    entries and the skills `install` wrote, which is harness scaffolding rather
    than the agent's work, and excluding it in only one condition would make the
    two patches incomparable."""
    exclude = [":(exclude).claude"]
    runner.run(
        ["git", "-C", str(worktree), "add", "-A", "--", ".", *exclude],
        timeout=300,
        label="git.add",
    )
    res = runner.run(
        ["git", "-C", str(worktree), "diff", "--cached", "--binary"],
        timeout=300,
        label="git.diff",
    )
    if not runner.dry_run and res["exit_code"] == 0:
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(res["stdout"], encoding="utf-8")
    stat = runner.run(
        ["git", "-C", str(worktree), "diff", "--cached", "--stat"], timeout=300, label="git.diffstat"
    )
    return {
        "patch_path": str(dest),
        "changed_files": len([l for l in (stat["stdout"] or "").splitlines() if " | " in l]),
        "diffstat_tail": tail(stat["stdout"], 2000),
    }


# --------------------------------------------------------------------------
# Sandbox HOME + Claude settings
# --------------------------------------------------------------------------


def ensure_project_settings(runner: Runner, root: Path) -> None:
    """Guarantee the worktree has a `.claude/settings.json`, so that
    `--setting-sources project` has a file to load and the `off` condition is an
    explicit empty settings file rather than an absent one. A settings file the
    repo already ships at the base commit is LEFT ALONE: it is part of the
    checkout under test, and both conditions get it."""
    path = root / ".claude" / "settings.json"
    if runner.dry_run:
        runner.log(f"# ensure {path} exists (empty `{{}}` if the repo ships none)")
        return
    if path.is_file():
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{}\n", encoding="utf-8")


def settings_hook_summary(root: Path) -> dict[str, Any]:
    path = root / ".claude" / "settings.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"path": str(path), "readable": False}
    hooks = data.get("hooks") or {}
    entries = {event: len(v or []) for event, v in hooks.items()} if isinstance(hooks, dict) else {}
    return {
        "path": str(path),
        "readable": True,
        "hook_events": entries,
        "hook_entry_total": sum(entries.values()),
        "permission_allow_count": len((data.get("permissions") or {}).get("allow") or []),
    }


# --------------------------------------------------------------------------
# The Tenjin side of a session
# --------------------------------------------------------------------------


def copy_template_data_dir(runner: Runner, dest: Path) -> str:
    if not TEMPLATE_DATA_DIR.is_dir() and not runner.dry_run:
        die(f"no template data dir at {TEMPLATE_DATA_DIR}; run `run.py prepare` first")
    runner.log(f"# cp -R {TEMPLATE_DATA_DIR} {dest}")
    if runner.dry_run:
        return ""
    dest.parent.mkdir(parents=True, exist_ok=True)
    # The template's own bench-prepare.json and any stale daemon/ledger state are
    # dropped: a session starts with config + wallet and nothing else, so its
    # ledger holds only this session's fires.
    shutil.copytree(
        TEMPLATE_DATA_DIR,
        dest,
        ignore=shutil.ignore_patterns(
            "loop.db*", "daemon.*", "hook-health.json", "session.json", "spend.json",
            "update-check.json", "bench-prepare.json", "hooks",
        ),
    )
    dest.chmod(0o700)
    pf = passphrase_file(dest)
    return pf.read_text(encoding="utf-8").strip() if pf.is_file() else ""


def install_tenjin_hooks(
    runner: Runner, args: argparse.Namespace, worktree: Path, data_dir: Path, passphrase: str
) -> dict[str, Any]:
    """Wire the hook entries and the skills into the WORKTREE's own `.claude/`.

    `install` resolves the home with `os.homedir()`, which on POSIX is `$HOME`,
    so pointing HOME at the worktree makes it write `<worktree>/.claude/
    settings.json` and `<worktree>/.claude/skills/` — exactly what
    `--setting-sources project` then loads, and nothing in the operator's
    ~/.claude.

    One install PER SESSION, because `install` bakes this session's data dir into
    the shim path and the daemon's url and token: a shared settings file would
    point every session at one data dir and one daemon."""
    env = tenjin_env(data_dir, passphrase)
    env["HOME"] = str(worktree)
    res = runner.run(
        [args.tenjin_bin, "install", "--harness", "claude", "--publish-mode", "full-auto", "--json"],
        env_overlay=env,
        timeout=600,
        label="tenjin.install",
    )
    return {
        "exit_code": res["exit_code"],
        "duration_ms": res["duration_ms"],
        "stdout_tail": tail(res["stdout"], 2000),
        "stderr_tail": tail(res["stderr"], 2000),
    }


def stop_daemon(runner: Runner, args: argparse.Namespace, data_dir: Path) -> dict[str, Any]:
    """Never leave a server running. The loop daemon is per data dir and would
    otherwise idle for `loop.idle_exit_min` after every session."""
    res = runner.run(
        [args.tenjin_bin, "daemon", "stop", "--json"],
        env_overlay=base_env({"TENJIN_DATA_DIR": str(data_dir)}),
        timeout=120,
        label="tenjin.daemon.stop",
    )
    return {"exit_code": res["exit_code"], "stdout_tail": tail(res["stdout"], 800)}


# --------------------------------------------------------------------------
# The ledger (loop.db) → the delivery funnel
# --------------------------------------------------------------------------


def read_ledger(data_dir: Path) -> dict[str, Any]:
    """Read the loop ledger read-only. `immutable=1` is safe only once the
    daemon is stopped, which the caller does first; it avoids taking any lock on
    a file another profile's CLI may also open."""
    db = data_dir / "loop.db"
    if not db.is_file():
        return {"present": False}
    uri = f"file:{db}?mode=ro&immutable=1"
    funnel: dict[str, Any] = {"present": True, "db_path": str(db)}
    try:
        conn = sqlite3.connect(uri, uri=True, timeout=10)
        conn.row_factory = sqlite3.Row
    except sqlite3.Error as exc:
        return {"present": True, "error": redact(str(exc))}
    try:
        def table_exists(name: str) -> bool:
            row = conn.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
            ).fetchone()
            return row is not None

        fires: list[dict[str, Any]] = []
        if table_exists("fires"):
            for row in conn.execute(
                "SELECT id, at, session, agent, arm, harness, event, wait, deadline_ms,"
                " elapsed_ms, reason, question, delivered, error FROM fires ORDER BY at"
            ):
                fires.append(
                    {
                        "id": row["id"],
                        "at": row["at"],
                        "session": row["session"],
                        "agent": row["agent"],
                        "arm": row["arm"],
                        "harness": row["harness"],
                        "event": row["event"],
                        "wait": row["wait"],
                        "deadline_ms": row["deadline_ms"],
                        "elapsed_ms": row["elapsed_ms"],
                        "reason": row["reason"],
                        # fires.question is the 512-char head the daemon stored,
                        # not the full question: never treat it as complete text.
                        "question_head": redact(row["question"] or ""),
                        "delivered": redact(row["delivered"] or ""),
                        "error": redact(row["error"] or ""),
                    }
                )
        funnel["fires"] = fires

        legs: list[dict[str, Any]] = []
        if table_exists("legs"):
            for row in conn.execute(
                "SELECT fire_id, stage, shelf, status, outcome, elapsed_ms, search_id,"
                " title, url, form FROM legs ORDER BY fire_id, stage"
            ):
                legs.append(
                    {
                        "fire_id": row["fire_id"],
                        "stage": row["stage"],
                        "shelf": row["shelf"],
                        "status": row["status"],
                        "outcome": row["outcome"],
                        "elapsed_ms": row["elapsed_ms"],
                        "search_id": row["search_id"],
                        "title": redact(row["title"] or ""),
                        "url": redact(row["url"] or ""),
                        "form": row["form"],
                    }
                )
        funnel["legs"] = legs

        searches: list[dict[str, Any]] = []
        if table_exists("searches"):
            for row in conn.execute(
                "SELECT search_id, at, session, question, decision, source, shelf_base_url,"
                " paid_browse_count, resolved_by FROM searches ORDER BY at"
            ):
                searches.append(
                    {
                        "search_id": row["search_id"],
                        "at": row["at"],
                        "question": redact(row["question"] or ""),
                        "decision": row["decision"],
                        "source": row["source"],
                        "shelf_base_url": redact(row["shelf_base_url"] or ""),
                        "paid_browse_count": row["paid_browse_count"],
                        "resolved_by": row["resolved_by"],
                    }
                )
        funnel["searches"] = searches

        published: list[dict[str, Any]] = []
        if table_exists("facts"):
            for row in conn.execute(
                "SELECT key, value, at FROM facts WHERE key LIKE 'published:%'"
                " OR key LIKE 'agent_published:%' ORDER BY at"
            ):
                published.append(
                    {"key": row["key"], "url": redact(row["value"] or ""), "at": row["at"]}
                )
        funnel["published"] = published
    finally:
        conn.close()

    by_arm: dict[str, int] = {}
    for fire in funnel.get("fires", []):
        by_arm[fire["arm"]] = by_arm.get(fire["arm"], 0) + 1
    by_status: dict[str, int] = {}
    for leg in funnel.get("legs", []):
        by_status[leg["status"]] = by_status.get(leg["status"], 0) + 1
    by_outcome: dict[str, int] = {}
    for leg in funnel.get("legs", []):
        key = leg["outcome"] or "(none)"
        by_outcome[key] = by_outcome.get(key, 0) + 1
    by_decision: dict[str, int] = {}
    for s in funnel.get("searches", []):
        by_decision[s["decision"] or "(none)"] = by_decision.get(s["decision"] or "(none)", 0) + 1

    funnel["counts"] = {
        "fires": len(funnel.get("fires", [])),
        "fires_by_arm": by_arm,
        "fires_with_error": sum(1 for f in funnel.get("fires", []) if f["error"]),
        "fires_delivered": sum(1 for f in funnel.get("fires", []) if f["delivered"]),
        "legs": len(funnel.get("legs", [])),
        "legs_by_status": by_status,
        "legs_by_outcome": by_outcome,
        "legs_with_candidate": sum(1 for l in funnel.get("legs", []) if l["url"]),
        "searches": len(funnel.get("searches", [])),
        "searches_by_decision": by_decision,
        "published": len([p for p in funnel.get("published", []) if p["key"].startswith("published:")]),
    }
    return funnel


# --------------------------------------------------------------------------
# The agent call
# --------------------------------------------------------------------------


# --------------------------------------------------------------------------
# Transcript usage. The `--output-format json` result reports the MAIN agent
# only; a session that delegated to a subagent under-reports badly. Smoke-3's
# tenjin consumer showed 8 turns and 1.9M tokens against $8.16 of cost after
# one dispatch. The transcripts on disk have the rest.
# --------------------------------------------------------------------------

USAGE_FIELDS = (
    "input_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
    "output_tokens",
)


# The turn-end ask, verbatim from `src/hooks/prose.ts` CAPTURE_ASK as the
# installed CLI rendered it into smoke-3's ledger (publish.mode full-auto, a root
# session so no `--agent` flag). Used only when the session's own ledger has no
# stop-arm emit to copy.
CAPTURE_ASK_FALLBACK = (
    "Tenjin: this turn did work worth a second look. If it settled something reusable "
    "(a probe result, a version gotcha, a tested workaround; on the team shelf also a "
    "decision and why, or a code map), publish it now: `tenjin publish <file>`, title as "
    "the first `# ` heading, one file per finding; publish.mode is full-auto. The "
    "tenjin-publish skill has the rest. If nothing durable, just finish.\n"
    "If publish refuses or you cannot run it, put the finding in your final answer inside "
    "a ```tenjin-finding fence, first line `# <title>`; it is kept locally for a person."
)


def stop_ask_from_ledger(data_dir: Path) -> str | None:
    """The exact text this session's own Stop arm emitted.

    Preferred over the constant above: it is the product's current wording, under
    this run's own config, rather than a copy that drifts. Smoke-3's producer
    shows the arm firing with reason `no-question` and a full `context` payload
    that simply had no next turn to land in under `claude -p` — this reads that
    payload back and gives it one.
    """
    db = data_dir / "loop.db"
    if not db.is_file():
        return None
    try:
        conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=10)
    except sqlite3.Error:
        return None
    try:
        rows = conn.execute(
            "SELECT emit FROM fires WHERE arm = 'stop' AND emit IS NOT NULL"
            " AND emit != '' ORDER BY at DESC"
        ).fetchall()
    except sqlite3.Error:
        return None
    finally:
        conn.close()
    for (emit,) in rows:
        try:
            context = (json.loads(emit) or {}).get("context")
        except json.JSONDecodeError:
            continue
        if isinstance(context, str) and context.strip():
            return context
    return None


def project_slug(cwd: Path) -> str:
    """Claude Code's directory name for a project: every `/` and `_` becomes `-`.

    Verified against smoke-3, whose worktree
    `/private/tmp/.../smoke-3/tenjin-746-748-confidence__tenjin__r1__consumer/repo`
    is stored as `-private-tmp-...-tenjin-746-748-confidence--tenjin--r1--consumer-repo`.
    """
    return str(cwd).replace("/", "-").replace("_", "-")


def transcript_dir(cwd: Path, home: Path | None = None) -> Path:
    base = (home or Path.home()) / ".claude" / "projects"
    return base / project_slug(cwd)


def sum_transcript_usage(path: Path) -> dict[str, int]:
    """Token totals over one transcript's assistant rows.

    DEDUPED ON requestId (falling back to the message id): a transcript records a
    row per streamed API block, and several rows can carry the same request's
    usage. Counting rows rather than requests multiplies the total.
    """
    totals = {f: 0 for f in USAGE_FIELDS}
    totals["assistant_rows"] = 0
    totals["requests"] = 0
    seen: set[str] = set()
    try:
        handle = path.open(encoding="utf-8", errors="replace")
    except OSError:
        return totals
    with handle:
        for line in handle:
            line = line.strip()
            if not line or not line.startswith("{"):
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if row.get("type") != "assistant":
                continue
            totals["assistant_rows"] += 1
            message = row.get("message") or {}
            usage = message.get("usage") or {}
            if not usage:
                continue
            key = row.get("requestId") or message.get("id")
            if key is None or key in seen:
                continue
            seen.add(key)
            totals["requests"] += 1
            for field in USAGE_FIELDS:
                value = usage.get(field)
                if isinstance(value, (int, float)):
                    totals[field] += int(value)
    return totals


def zero_usage() -> dict[str, int]:
    return {f: 0 for f in USAGE_FIELDS} | {"assistant_rows": 0, "requests": 0}


def add_usage(a: dict[str, int], b: dict[str, int]) -> dict[str, int]:
    return {k: a.get(k, 0) + b.get(k, 0) for k in set(a) | set(b)}


def with_total(usage: dict[str, int]) -> dict[str, int]:
    """Add the one number the report compares on."""
    out = dict(usage)
    out["total"] = sum(out.get(f, 0) for f in USAGE_FIELDS)
    return out


def collect_session_usage(cwd: Path, session_ids: list[str]) -> dict[str, Any]:
    """Main-agent and subagent token totals for one bench session.

    `session_ids` is every id this bench session produced — the main call plus a
    capture turn, which `--resume` may or may not file under a new id.
    """
    root = transcript_dir(cwd)
    main = zero_usage()
    subs = zero_usage()
    main_files: list[str] = []
    sub_files: list[str] = []

    for sid in session_ids:
        if not sid:
            continue
        transcript = root / f"{sid}.jsonl"
        if transcript.is_file():
            main = add_usage(main, sum_transcript_usage(transcript))
            main_files.append(str(transcript))
        # Subagent transcripts live under <project>/<session id>/subagents/.
        sub_dir = root / sid / "subagents"
        if sub_dir.is_dir():
            for f in sorted(sub_dir.glob("*.jsonl")):
                subs = add_usage(subs, sum_transcript_usage(f))
                sub_files.append(str(f))

    return {
        "transcript_dir": str(root),
        "usage_main": with_total(main),
        "usage_subagents": with_total(subs),
        "usage_total": with_total(add_usage(main, subs)),
        "subagent_files": len(sub_files),
        "main_transcripts": main_files,
        "subagent_transcripts": sub_files,
    }


def claude_argv(args: argparse.Namespace, extra: list[str] | None = None) -> list[str]:
    argv = [
        args.claude_bin,
        "-p",
        "--model",
        args.model,
        "--output-format",
        "json",
        # THE ISOLATION. Hooks, permissions and skills come only from the
        # worktree's own .claude/. Measured: with this flag a sandbox session
        # sees none of the operator's user hooks, none of their user skills, and
        # not their global CLAUDE.md — while the login, which lives outside the
        # settings system, keeps working.
        "--setting-sources",
        "project",
        "--strict-mcp-config",
        "--permission-mode",
        args.permission_mode,
    ]
    if args.max_budget_usd:
        argv += ["--max-budget-usd", str(args.max_budget_usd)]
    argv += extra or []
    return argv


def parse_agent_json(stdout: str) -> dict[str, Any]:
    """Pull the usage/cost/turns block out of `--output-format json`."""
    parsed: dict[str, Any] = {"parsed": False}
    text = (stdout or "").strip()
    if not text:
        return parsed
    payload: Any = None
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        for line in reversed(text.splitlines()):
            line = line.strip()
            if line.startswith("{"):
                try:
                    payload = json.loads(line)
                    break
                except json.JSONDecodeError:
                    continue
    if payload is None:
        return parsed
    if isinstance(payload, list):
        results = [p for p in payload if isinstance(p, dict) and p.get("type") == "result"]
        payload = results[-1] if results else (payload[-1] if payload else None)
    if not isinstance(payload, dict):
        return parsed

    usage = payload.get("usage") or {}
    if not isinstance(usage, dict):
        usage = {}
    tokens = {
        "input": int(usage.get("input_tokens") or 0),
        "cache_creation": int(usage.get("cache_creation_input_tokens") or 0),
        "cache_read": int(usage.get("cache_read_input_tokens") or 0),
        "output": int(usage.get("output_tokens") or 0),
    }
    tokens["input_side_total"] = tokens["input"] + tokens["cache_creation"] + tokens["cache_read"]
    tokens["total"] = tokens["input_side_total"] + tokens["output"]

    result_text = payload.get("result")
    parsed.update(
        {
            "parsed": True,
            "type": payload.get("type"),
            "subtype": payload.get("subtype"),
            "is_error": payload.get("is_error"),
            "session_id": payload.get("session_id"),
            "uuid": payload.get("uuid"),
            "num_turns": payload.get("num_turns"),
            "duration_ms": payload.get("duration_ms"),
            "duration_api_ms": payload.get("duration_api_ms"),
            "total_cost_usd": payload.get("total_cost_usd"),
            "stop_reason": payload.get("stop_reason") or payload.get("subtype"),
            "permission_denials": len(payload.get("permission_denials") or []),
            "usage": {k: v for k, v in usage.items() if isinstance(v, (int, float, str))},
            "tokens": tokens,
            "result_tail": tail(result_text if isinstance(result_text, str) else "", 2000),
        }
    )
    if isinstance(payload.get("modelUsage"), dict):
        parsed["model_usage"] = payload["modelUsage"]
    return parsed


# --------------------------------------------------------------------------
# One session
# --------------------------------------------------------------------------


def run_session(
    runner: Runner,
    args: argparse.Namespace,
    run_dir: Path,
    pairs_dir: Path,
    pair: dict[str, Any],
    role: str,
    condition: str,
    repeat: int,
    run_id: str,
) -> dict[str, Any]:
    spec = pair[role]
    tag = f"{pair['id']}/{condition}/r{repeat}/{role}"
    out(f"\n=== {tag} ===")

    session_dir = run_dir / "sessions" / pair["id"] / condition / f"r{repeat}" / role
    sandbox = SCRATCH_ROOT / run_id / f"{pair['id']}__{condition}__r{repeat}__{role}"
    worktree = sandbox / "repo"
    data_dir = sandbox / "tenjin"
    checkout = CHECKOUTS[spec["repo"]]
    prompt_path = resolve_rel(pairs_dir, spec["prompt_file"])

    record: dict[str, Any] = {
        "run_id": run_id,
        "pair_id": pair["id"],
        "role": role,
        "condition": condition,
        "repeat": repeat,
        "repo": spec["repo"],
        "base_commit": spec["base_commit"],
        "prompt_file": str(prompt_path),
        "model": args.model,
        "started_at": now_iso(),
        "errors": [],
        "paths": {
            "session_dir": str(session_dir),
            "sandbox": str(sandbox),
            "worktree": str(worktree),
            "data_dir": str(data_dir),
        },
    }

    if not prompt_path.is_file() and not runner.dry_run:
        record["errors"].append(f"prompt file not found: {prompt_path}")
        record["finished_at"] = now_iso()
        return record
    prompt = prompt_path.read_text(encoding="utf-8") if prompt_path.is_file() else "(dry-run)"
    record["prompt_chars"] = len(prompt)

    if not runner.dry_run:
        session_dir.mkdir(parents=True, exist_ok=True)

    # ---- worktree ---------------------------------------------------------
    wt = add_worktree(runner, checkout, spec["base_commit"], worktree)
    record["worktree_add"] = {"exit_code": wt["exit_code"], "stderr_tail": tail(wt["stderr"], 800)}
    if wt["exit_code"] not in (0, None):
        record["errors"].append("git worktree add failed")
        record["finished_at"] = now_iso()
        return record

    daemon_stopped = False
    patch_taken = False
    try:
        # ---- the settings surface the agent will read ----------------------
        ensure_project_settings(runner, worktree)

        passphrase = ""
        if condition == "tenjin":
            passphrase = copy_template_data_dir(runner, data_dir)
            record["install"] = install_tenjin_hooks(runner, args, worktree, data_dir, passphrase)
        else:
            # The off condition still gets an isolated (empty) data dir: if the
            # agent reaches for the `tenjin` binary on its own, it must not find
            # the operator's config, wallet or team shelf.
            if not runner.dry_run:
                data_dir.mkdir(parents=True, exist_ok=True)
                data_dir.chmod(0o700)
            else:
                runner.log(f"# mkdir -p {data_dir}   (off: empty, public mode, no wallet)")
        if not runner.dry_run:
            record["claude_settings"] = settings_hook_summary(worktree)

        # ---- dependencies -------------------------------------------------
        if args.skip_install:
            record["pnpm_install"] = {"skipped": "--skip-install"}
        else:
            pnpm = runner.run(
                ["pnpm", "install", "--frozen-lockfile", "--prefer-offline"],
                cwd=worktree,
                env_overlay=base_env(),
                timeout=PNPM_TIMEOUT_S,
                label="pnpm.install",
            )
            record["pnpm_install"] = {
                "exit_code": pnpm["exit_code"],
                "duration_ms": pnpm["duration_ms"],
                "timed_out": pnpm["timed_out"],
                "stderr_tail": tail(pnpm["stderr"], 1500),
            }
            if pnpm["exit_code"] not in (0, None):
                record["errors"].append("pnpm install failed")

        # ---- what runtime will the oracle actually see ---------------------
        # Recorded per session because smoke-1's oracle silently ran on a
        # different node than the runner, and the only evidence was a corepack
        # stack trace.
        if not runner.dry_run:
            record["runtime"] = probe_node_version(runner, worktree, base_env())
        else:
            runner.log("# probe node --version / pnpm --version in the oracle env")

        # ---- the agent ----------------------------------------------------
        # NOTE: no HOME override here. The agent runs under the real HOME because
        # that is where its login lives; the isolation comes from
        # `--setting-sources project` plus a per-session data dir.
        # The agent gets the pinned node too, so that a test it runs itself sees
        # the same runtime the oracle will. Identical in both conditions.
        env_overlay = base_env({"TENJIN_DATA_DIR": str(data_dir)})
        if condition == "tenjin" and passphrase:
            env_overlay["TENJIN_WALLET_PASSPHRASE"] = passphrase

        cap_s = int(spec.get("cap_s") or args.cap_s)
        record["cap_s"] = cap_s
        record["cap_source"] = "pairs.json" if spec.get("cap_s") else "--cap-s"
        timeout_s = cap_s
        started = time.monotonic()
        agent = runner.run(
            claude_argv(args),
            cwd=worktree,
            env_overlay=env_overlay,
            timeout=timeout_s,
            stdin_text=prompt,
            label="claude",
        )
        wall_ms = int((time.monotonic() - started) * 1000)

        parsed = parse_agent_json(agent["stdout"])
        record["wall_ms"] = wall_ms
        record["capped"] = bool(agent["timed_out"])
        record["timeout_ms"] = timeout_s * 1000
        record["agent"] = {
            "exit_code": agent["exit_code"],
            "timed_out": agent["timed_out"],
            "pid": agent.get("pid"),
            "killed_process_group": agent.get("killed_process_group"),
            "process_group_gone": agent.get("process_group_gone"),
            "stderr_tail": tail(agent["stderr"], 2000),
            **parsed,
        }
        record["tokens"] = parsed.get("tokens")
        record["cost_usd"] = parsed.get("total_cost_usd")
        record["num_turns"] = parsed.get("num_turns")
        if not parsed.get("parsed") and not runner.dry_run:
            record["errors"].append("could not parse the agent's JSON result")
        if not runner.dry_run:
            (session_dir / "agent-stdout.json").write_text(
                redact(agent["stdout"]), encoding="utf-8"
            )
            if agent["stderr"].strip():
                (session_dir / "agent-stderr.txt").write_text(
                    redact(agent["stderr"]), encoding="utf-8"
                )

        # ---- the agent's diff, kept ---------------------------------------
        # Taken BEFORE the capture turn, so the recorded patch is the task work
        # and not the finding the capture turn may write. Also attempted in the
        # `finally` below, so an exception anywhere above cannot cost it.
        record["diff"] = capture_patch(runner, worktree, session_dir / "agent.patch")
        patch_taken = True

        # ---- the capture turn ---------------------------------------------
        # THE PRODUCT'S STOP NUDGE HAS NOWHERE TO LAND UNDER `claude -p`. The Stop
        # arm fires and emits its "publish it now" context, but a headless run
        # ends at that moment, so a producer captures nothing while an
        # interactive session would have published. Smoke-3 showed exactly that:
        # the producer's stop arm fired twice, published 0, while the consumer —
        # which had mid-session turns to act in — published 2.
        #
        # So the producer gets one more turn, resuming the same session, carrying
        # the same ask the arm emitted. `--resume` keeps the session id and
        # appends to the same transcript (verified), so the transcript totals
        # below cover it without extra bookkeeping.
        capture_wanted = (
            condition == "tenjin"
            and role == "producer"
            and args.capture_turn
            and not record.get("capped")
        )
        if capture_wanted and runner.dry_run:
            runner.log(
                "$ claude.capture (same flags + --resume <session id>, stdin = the Stop arm's "
                "own ask read back from loop.db)"
            )
        capture_session = capture_wanted and bool(parsed.get("session_id"))
        if capture_session:
            ask = stop_ask_from_ledger(data_dir) or CAPTURE_ASK_FALLBACK
            cap_started = time.monotonic()
            cap = runner.run(
                claude_argv(args, ["--resume", str(parsed["session_id"])]),
                cwd=worktree,
                env_overlay=env_overlay,
                timeout=args.capture_cap_s,
                stdin_text=ask,
                label="claude.capture",
            )
            cap_parsed = parse_agent_json(cap["stdout"])
            record["capture"] = {
                "ran": True,
                "ask_source": "ledger" if stop_ask_from_ledger(data_dir) else "fallback",
                "ask_chars": len(ask),
                "exit_code": cap["exit_code"],
                "timed_out": cap["timed_out"],
                "capped": bool(cap["timed_out"]),
                "pid": cap.get("pid"),
                "wall_ms": int((time.monotonic() - cap_started) * 1000),
                "session_id": cap_parsed.get("session_id"),
                "num_turns": cap_parsed.get("num_turns"),
                "cost_usd": cap_parsed.get("total_cost_usd"),
                "tokens": cap_parsed.get("tokens"),
                "result_tail": cap_parsed.get("result_tail"),
                "stderr_tail": tail(cap["stderr"], 1200),
            }
            if not runner.dry_run:
                (session_dir / "capture-stdout.json").write_text(
                    redact(cap["stdout"]), encoding="utf-8"
                )
            # A second diffstat: the capture turn should only write a finding
            # file, but if it touched code the oracle below grades that too, so
            # make it visible rather than silent.
            record["capture"]["diff_after"] = capture_patch(
                runner, worktree, session_dir / "after-capture.patch"
            )
        elif condition == "tenjin" and role == "producer":
            record["capture"] = {
                "ran": False,
                "why": "capped" if record.get("capped") else (
                    "--no-capture-turn" if not args.capture_turn else "no session id"
                ),
            }

        # ---- the oracle ---------------------------------------------------
        record["oracle"] = run_oracle(runner, args, spec["oracle"], pairs_dir, worktree)

        # ---- usage, main + subagents, from the transcripts ------------------
        if not runner.dry_run:
            ids = [parsed.get("session_id")]
            cap_id = (record.get("capture") or {}).get("session_id")
            if cap_id and cap_id not in ids:
                ids.append(cap_id)
            usage = collect_session_usage(worktree, [i for i in ids if i])
            record["usage"] = usage
            record["usage_total"] = usage["usage_total"]
            # `tokens` stays the main agent's JSON block, for comparison; the
            # report compares on usage_total.
            record["tokens_json"] = record.get("tokens")
        else:
            runner.log("# sum usage from ~/.claude/projects/<slug>/ + subagents/")

        # ---- the funnel ---------------------------------------------------
        if condition == "tenjin":
            # Stop the daemon BEFORE reading the ledger: `immutable=1` assumes
            # nothing else is writing, and a live daemon would outlive the run.
            record["daemon_stop"] = stop_daemon(runner, args, data_dir)
            daemon_stopped = True
            if not runner.dry_run:
                funnel = read_ledger(data_dir)
                record["funnel"] = funnel
                record["published"] = funnel.get("published", [])
                write_json(session_dir / "funnel.json", funnel)
            else:
                runner.log(f"# read ledger {data_dir}/loop.db (mode=ro&immutable=1)")
    finally:
        # THE DIFF IS TAKEN BEFORE THE WORKTREE GOES, ALWAYS. A capped or crashed
        # session still did real work, and the patch is the only copy of it once
        # the worktree is removed.
        if not patch_taken and not runner.dry_run and worktree.is_dir():
            try:
                record["diff"] = capture_patch(runner, worktree, session_dir / "agent.patch")
                record["diff"]["taken_in_finally"] = True
            except Exception as exc:  # never let cleanup lose the daemon stop
                record["errors"].append(f"could not capture the diff: {exc}")
        if condition == "tenjin" and not daemon_stopped:
            # Belt and braces: a failure above must not strand a daemon.
            stop_daemon(runner, args, data_dir)
        if not args.keep_worktrees:
            remove_worktree(runner, checkout, worktree)
        else:
            runner.log(f"# --keep-worktrees: {worktree} left in place")

    record["finished_at"] = now_iso()
    if not runner.dry_run:
        write_json(session_dir / "record.json", record)
    return record


def run_oracle(
    runner: Runner,
    args: argparse.Namespace,
    oracle: dict[str, Any],
    pairs_dir: Path,
    worktree: Path,
) -> dict[str, Any]:
    """Copy the oracle's files in, then run its command. The command NAMES the
    files it runs (`pnpm vitest run path/to/one.test.ts`); a bare `pnpm test`
    would fork ~35 workers plus testcontainers and is refused here."""
    result: dict[str, Any] = {"command": oracle["command"], "copied": []}

    command = oracle["command"]
    if is_whole_suite(command):
        result["error"] = (
            "oracle command looks like a whole-suite run; name the test files instead"
        )
        result["ran"] = False
        result["passed"] = False
        return result

    for item in oracle.get("copy", []) or []:
        src = resolve_rel(pairs_dir, item["from"])
        dst = worktree / item["to"]
        # Defence in depth; `load_pairs` already refused absolute and `..` paths.
        try:
            dst.resolve().relative_to(worktree.resolve())
        except ValueError:
            result["error"] = f"oracle destination escapes the worktree: {dst}"
            result["ran"] = False
            result["passed"] = False
            return result
        runner.log(f"# cp {src} {dst}")
        if runner.dry_run:
            result["copied"].append({"from": str(src), "to": str(dst), "ok": None})
            continue
        ok = src.is_file()
        if ok:
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(src, dst)
        result["copied"].append({"from": str(src), "to": str(dst), "ok": ok})
        if not ok:
            result["error"] = f"oracle file not found: {src}"

    if result.get("error"):
        result["ran"] = False
        result["passed"] = False
        return result

    if args.skip_oracle:
        result["ran"] = False
        result["skipped"] = "--skip-oracle"
        result["passed"] = None
        return result

    # `bash -c`, NOT `bash -lc`. The login shell re-sources the profile and
    # rebuilds PATH, which is how smoke-1's oracle ended up on Node 18 while the
    # runner was on 24. See node_path_prefix().
    res = runner.run(
        ["bash", "-c", command],
        cwd=worktree,
        env_overlay=base_env(),
        timeout=oracle.get("timeout_s", ORACLE_TIMEOUT_S),
        label="oracle",
    )
    result.update(
        {
            "ran": not runner.dry_run,
            "exit_code": res["exit_code"],
            "timed_out": res["timed_out"],
            "duration_ms": res["duration_ms"],
            "stdout_tail": tail(res["stdout"]),
            "stderr_tail": tail(res["stderr"]),
            # Exit code, never a grep for FAIL: a passing suite prints the word.
            "passed": None if runner.dry_run else res["exit_code"] == 0,
        }
    )
    return result


_WHOLE_SUITE = re.compile(
    r"(pnpm\s+(-s\s+)?test\b(?!\s*[\w./])|vitest\s+run\s*$|pnpm\s+vitest\s*$|\bvitest\s*$)"
)


def is_whole_suite(command: str) -> bool:
    stripped = command.strip()
    for part in re.split(r"&&|\|\||;", stripped):
        part = part.strip()
        if _WHOLE_SUITE.search(part):
            return True
    return False


# --------------------------------------------------------------------------
# The report
# --------------------------------------------------------------------------


def tokens_of(record: dict[str, Any]) -> dict[str, int]:
    """Token counts for one session, SUBAGENTS INCLUDED.

    Prefers the transcript sum (`usage_total`), which covers the main agent, any
    capture turn and every subagent. The `--output-format json` block is the
    fallback for a record written before transcripts were read, and it
    under-reports a delegating session badly: smoke-3's tenjin consumer reported
    1.89M there against 17.44M on disk."""
    u = record.get("usage_total")
    if isinstance(u, dict) and u.get("total"):
        return {
            "input": u.get("input_tokens", 0) or 0,
            "cache_creation": u.get("cache_creation_input_tokens", 0) or 0,
            "cache_read": u.get("cache_read_input_tokens", 0) or 0,
            "output": u.get("output_tokens", 0) or 0,
            "total": u.get("total", 0) or 0,
        }
    t = record.get("tokens") or {}
    return {
        "input": t.get("input", 0) or 0,
        "cache_creation": t.get("cache_creation", 0) or 0,
        "cache_read": t.get("cache_read", 0) or 0,
        "output": t.get("output", 0) or 0,
        "total": t.get("total", 0) or 0,
    }


def cost_of(record: dict[str, Any]) -> float:
    """The JSON cost, plus the capture turn's own cost when there was one."""
    base = record.get("cost_usd") or 0
    cap = (record.get("capture") or {}).get("cost_usd") or 0
    return float(base) + float(cap)


def subagent_note(record: dict[str, Any]) -> str:
    u = record.get("usage") or {}
    n = u.get("subagent_files") or 0
    sub = (u.get("usage_subagents") or {}).get("total") or 0
    return f"{n} ({sub:,})" if n else "—"


def build_report(run_dir: Path, all_records: list[dict[str, Any]], args: argparse.Namespace) -> str:
    # A repeat whose producer was capped or errored is EXCLUDED from every median
    # and total below. In the tenjin condition its consumer never ran at all (the
    # producer's Stop hook captured nothing to find), and letting a zero-token
    # skip into a median would quietly report the shelf as a huge saving.
    invalid_records = [r for r in all_records if r.get("invalid") or r.get("skipped")]
    records = [r for r in all_records if not (r.get("invalid") or r.get("skipped"))]

    by_key: dict[tuple[str, str, int, str], dict[str, Any]] = {}
    for r in records:
        by_key[(r["pair_id"], r["condition"], r["repeat"], r["role"])] = r

    pair_ids: list[str] = []
    for r in records:
        if r["pair_id"] not in pair_ids:
            pair_ids.append(r["pair_id"])
    conditions = [c for c in CONDITIONS if any(r["condition"] == c for r in records)]

    lines: list[str] = []
    lines.append(f"# bench-lite report — {run_dir.name}")
    lines.append("")
    lines.append(f"- generated: {now_iso()}")
    lines.append(f"- model: `{args.model}`")
    lines.append(f"- sessions recorded: {len(all_records)}")
    lines.append(f"- sessions scored: {len(records)}")
    lines.append(f"- repeats: {args.repeats}")
    lines.append(f"- cap per session: {args.cap_s}s")
    if invalid_records:
        lines.append(
            f"- **excluded as invalid: {len(invalid_records)}** (see Invalid repeats below)"
        )
    lines.append("")
    lines.append("Token columns are summed from the session TRANSCRIPTS, not from the agent's")
    lines.append("`--output-format json` block, so they include every subagent and the producer's")
    lines.append("capture turn. `in` is uncached input, `cc` cache-creation input, `cr` cache-read")
    lines.append("input, `out` output; `total` is all four, and is the number to compare across")
    lines.append("conditions. `capture tok` is the producer's follow-up turn, already inside")
    lines.append("`total`. `cost $` is the agent's own reported cost plus the capture turn's.")
    lines.append("")

    lines.append("## Per session (median across repeats)")
    lines.append("")
    lines.append(
        "| pair | condition | session | total tok | in | cc | cr | out | subagents (tok) "
        "| capture tok | wall s | turns | cost $ | oracle |"
    )
    lines.append("|---|---|---|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|---|")
    for pid in pair_ids:
        for cond in conditions:
            for role in ROLES:
                rs = [
                    r
                    for r in records
                    if r["pair_id"] == pid and r["condition"] == cond and r["role"] == role
                ]
                if not rs:
                    continue
                toks = [tokens_of(r) for r in rs]
                passes = [r.get("oracle", {}).get("passed") for r in rs]
                n_pass = sum(1 for p in passes if p is True)
                cap_toks = [
                    ((r.get("capture") or {}).get("tokens") or {}).get("total") or 0 for r in rs
                ]
                lines.append(
                    "| {pid} | {cond} | {role} | {total} | {i} | {cc} | {cr} | {o} | {subs} "
                    "| {captok} | {wall} | {turns} | {cost} | {p}/{n} |".format(
                        pid=pid,
                        cond=cond,
                        role=role,
                        total=median([t["total"] for t in toks]) or 0,
                        i=median([t["input"] for t in toks]) or 0,
                        cc=median([t["cache_creation"] for t in toks]) or 0,
                        cr=median([t["cache_read"] for t in toks]) or 0,
                        o=median([t["output"] for t in toks]) or 0,
                        subs=subagent_note(rs[0]),
                        captok=median(cap_toks) or 0,
                        wall=median([(r.get("wall_ms") or 0) / 1000 for r in rs]) or 0,
                        turns=median([r.get("num_turns") or 0 for r in rs]) or 0,
                        cost=median([cost_of(r) for r in rs]) or 0,
                        p=n_pass,
                        n=len(rs),
                    )
                )
    lines.append("")

    lines.append("## Per pair (A + B, median across repeats)")
    lines.append("")
    lines.append(
        "| pair | condition | A tok | B tok | A+B tok | A+B wall s | A+B cost $ | A oracle | B oracle |"
    )
    lines.append("|---|---|---:|---:|---:|---:|---:|---|---|")
    pair_totals: dict[tuple[str, str], float] = {}
    for pid in pair_ids:
        for cond in conditions:
            per_repeat_total: list[float] = []
            per_repeat_wall: list[float] = []
            per_repeat_cost: list[float] = []
            a_tok: list[float] = []
            b_tok: list[float] = []
            a_pass = b_pass = a_n = b_n = 0
            for rep in range(1, args.repeats + 1):
                a = by_key.get((pid, cond, rep, "producer"))
                b = by_key.get((pid, cond, rep, "consumer"))
                if a is None and b is None:
                    continue
                at = tokens_of(a)["total"] if a else 0
                bt = tokens_of(b)["total"] if b else 0
                a_tok.append(at)
                b_tok.append(bt)
                per_repeat_total.append(at + bt)
                per_repeat_wall.append(
                    ((a.get("wall_ms") or 0) if a else 0) + ((b.get("wall_ms") or 0) if b else 0)
                )
                per_repeat_cost.append(
                    (cost_of(a) if a else 0) + (cost_of(b) if b else 0)
                )
                if a:
                    a_n += 1
                    a_pass += 1 if a.get("oracle", {}).get("passed") is True else 0
                if b:
                    b_n += 1
                    b_pass += 1 if b.get("oracle", {}).get("passed") is True else 0
            if not per_repeat_total:
                continue
            total_med = median(per_repeat_total) or 0
            pair_totals[(pid, cond)] = total_med
            lines.append(
                "| {pid} | {cond} | {a} | {b} | {t} | {w} | {c} | {ap}/{an} | {bp}/{bn} |".format(
                    pid=pid,
                    cond=cond,
                    a=median(a_tok) or 0,
                    b=median(b_tok) or 0,
                    t=total_med,
                    w=round((median(per_repeat_wall) or 0) / 1000, 1),
                    c=median(per_repeat_cost) or 0,
                    ap=a_pass,
                    an=a_n,
                    bp=b_pass,
                    bn=b_n,
                )
            )
    lines.append("")

    if "off" in conditions and "tenjin" in conditions:
        lines.append("## Reuse delta (tenjin − off, median totals)")
        lines.append("")
        lines.append(
            "| pair | B tok off | B tok tenjin | B delta | A+B off | A+B tenjin | A+B delta "
            "| B oracle off | B oracle tenjin | reading |"
        )
        lines.append("|---|---:|---:|---:|---:|---:|---:|---|---|---|")
        caveats: list[str] = []
        for pid in pair_ids:

            def rows_for(cond: str, role: str) -> list[dict[str, Any]]:
                return [
                    r
                    for r in records
                    if r["pair_id"] == pid and r["condition"] == cond and r["role"] == role
                ]

            def med_role(cond: str, role: str) -> float:
                return median([tokens_of(r)["total"] for r in rows_for(cond, role)]) or 0

            def oracle_tally(cond: str) -> tuple[int, int]:
                rs = rows_for(cond, "consumer")
                return sum(1 for r in rs if (r.get("oracle") or {}).get("passed") is True), len(rs)

            b_off = med_role("off", "consumer")
            b_ten = med_role("tenjin", "consumer")
            t_off = pair_totals.get((pid, "off"), 0)
            t_ten = pair_totals.get((pid, "tenjin"), 0)
            off_pass, off_n = oracle_tally("off")
            ten_pass, ten_n = oracle_tally("tenjin")

            # A TOKEN DELTA BETWEEN TWO FAILED CONSUMERS IS NOT A REUSE WIN. Both
            # sides failed the task, so the cheaper one is only the one that gave
            # up sooner. Say so in the row rather than leaving a tempting number.
            if off_n and ten_n and off_pass == 0 and ten_pass == 0:
                reading = "**NOT A REUSE RESULT — B failed in both conditions**"
                caveats.append(
                    f"- `{pid}`: B's oracle failed in BOTH conditions "
                    f"(off {off_pass}/{off_n}, tenjin {ten_pass}/{ten_n}). The token delta "
                    "compares two failures and says nothing about reuse."
                )
            elif off_n and ten_n and (off_pass == 0) != (ten_pass == 0):
                better = "tenjin" if ten_pass else "off"
                reading = f"B passed only under `{better}`"
                caveats.append(
                    f"- `{pid}`: B's oracle passed only under `{better}` "
                    f"(off {off_pass}/{off_n}, tenjin {ten_pass}/{ten_n}). Compare the outcome "
                    "first; the token delta is secondary."
                )
            elif not off_n or not ten_n:
                reading = "incomplete"
            else:
                reading = "comparable"

            lines.append(
                f"| {pid} | {b_off} | {b_ten} | {round(b_ten - b_off, 2)} | "
                f"{t_off} | {t_ten} | {round(t_ten - t_off, 2)} | "
                f"{off_pass}/{off_n} | {ten_pass}/{ten_n} | {reading} |"
            )
        lines.append("")
        lines.append("A negative B delta is the shelf paying for itself on the consumer side.")
        lines.append("A negative A+B delta means it paid for the capture overhead too.")
        lines.append("")
        lines.append(
            "**Both readings assume B actually did the task.** A delta is only a reuse "
            "result when B's oracle passed; otherwise it compares how much two failures cost."
        )
        if caveats:
            lines.append("")
            lines.extend(caveats)
        lines.append("")

    tenjin_records = [r for r in records if r["condition"] == "tenjin"]
    if tenjin_records:
        lines.append("## Delivery funnel (tenjin condition, from the CLI ledger)")
        lines.append("")
        lines.append(
            "| pair | session | rep | fires | by arm | legs | leg status | searches | decisions | published |"
        )
        lines.append("|---|---|---:|---:|---|---:|---|---:|---|---:|")
        for r in sorted(
            tenjin_records, key=lambda x: (x["pair_id"], x["role"] != "producer", x["repeat"])
        ):
            counts = (r.get("funnel") or {}).get("counts") or {}
            lines.append(
                "| {pid} | {role} | {rep} | {fires} | {arms} | {legs} | {status} | {searches} | {dec} | {pub} |".format(
                    pid=r["pair_id"],
                    role=r["role"],
                    rep=r["repeat"],
                    fires=counts.get("fires", 0),
                    arms=fmt_counter(counts.get("fires_by_arm")),
                    legs=counts.get("legs", 0),
                    status=fmt_counter(counts.get("legs_by_status")),
                    searches=counts.get("searches", 0),
                    dec=fmt_counter(counts.get("searches_by_decision")),
                    pub=counts.get("published", 0),
                )
            )
        lines.append("")
        # Deduplicated by url: the same finding published once can appear in more
        # than one session's ledger rows, and a count of rows would overstate what
        # is actually on the shelf (and what `cleanup` has to retract).
        pub_urls: list[str] = []
        for r in tenjin_records:
            for p in r.get("published") or []:
                if p.get("key", "").startswith("published:") and p.get("url"):
                    if p["url"] not in pub_urls:
                        pub_urls.append(p["url"])
        lines.append(f"Distinct posts published to the bench shelf during this run: **{len(pub_urls)}**.")
        if pub_urls:
            lines.append("")
            for url in pub_urls:
                lines.append(f"- {url}")
            lines.append("")
            lines.append(
                "`python3 evals/bench-lite/run.py cleanup --out <this run dir>` retracts them "
                "from the bench shelf only."
            )
        lines.append("")

    if invalid_records:
        lines.append("## Invalid repeats (excluded from every number above)")
        lines.append("")
        for r in sorted(
            invalid_records, key=lambda x: (x["pair_id"], x["condition"], x["repeat"], x["role"])
        ):
            why = r.get("skipped") or r.get("invalid")
            what = "SKIPPED" if r.get("skipped") else "ran, not scored"
            lines.append(
                f"- {r['pair_id']}/{r['condition']}/r{r['repeat']}/{r['role']}: {what} — {why}"
            )
        lines.append("")
        lines.append(
            "A capped or errored producer never reaches its Stop hook, so in the tenjin "
            "condition nothing was captured and nothing was published. Re-run those repeats "
            "with a higher `--cap-s` before drawing any conclusion from the pair."
        )
        lines.append("")

    runtimes = {
        json.dumps(r.get("runtime"), sort_keys=True)
        for r in all_records
        if r.get("runtime")
    }
    if len(runtimes) > 1:
        lines.append("## Runtime skew")
        lines.append("")
        lines.append("Sessions did not all see the same node/pnpm. Oracle results are suspect.")
        for rt in sorted(runtimes):
            lines.append(f"- `{rt}`")
        lines.append("")

    problems = [r for r in records if r.get("errors") or r.get("capped")]
    lines.append("## Health")
    lines.append("")
    if not problems:
        lines.append("Every scored session ran to completion with no recorded errors.")
    else:
        for r in problems:
            flag = "CAPPED" if r.get("capped") else "ERROR"
            lines.append(
                f"- **{flag}** {r['pair_id']}/{r['condition']}/r{r['repeat']}/{r['role']}: "
                + "; ".join(r.get("errors") or ["timed out"])
            )
    lines.append("")
    return "\n".join(lines)


def fmt_counter(counter: dict[str, int] | None) -> str:
    if not counter:
        return "—"
    return " ".join(f"{k}:{v}" for k, v in sorted(counter.items()))


# --------------------------------------------------------------------------
# The `run` subcommand
# --------------------------------------------------------------------------


def preflight(runner: Runner, args: argparse.Namespace, run_dir: Path) -> dict[str, Any]:
    """One tiny real agent call with the exact flags the sessions use. It proves
    three things at once: the binary is the real one, the login still works under
    `--setting-sources project`, and `--output-format json` parses."""
    workdir = run_dir / "preflight-cwd"
    if not runner.dry_run:
        workdir.mkdir(parents=True, exist_ok=True)
    ensure_project_settings(runner, workdir)
    res = runner.run(
        claude_argv(args),
        cwd=workdir,
        env_overlay=base_env(),
        stdin_text="reply with the single word ok",
        timeout=300,
        label="claude.preflight",
    )
    parsed = parse_agent_json(res["stdout"])
    ok = res["exit_code"] == 0 and parsed.get("parsed") is True
    return {
        "ok": ok,
        "exit_code": res["exit_code"],
        "parsed": parsed.get("parsed"),
        "session_id": parsed.get("session_id"),
        "tokens": parsed.get("tokens"),
        "cost_usd": parsed.get("total_cost_usd"),
        "result_tail": parsed.get("result_tail"),
        "stderr_tail": tail(res["stderr"], 1200),
    }


def check_binaries(args: argparse.Namespace) -> None:
    claude = Path(args.claude_bin)
    if not claude.is_file() or not os.access(claude, os.X_OK):
        die(f"claude binary not executable: {claude}")
    resolved = shutil.which("claude")
    if resolved and Path(resolved).resolve() != claude.resolve():
        out(
            f"note: `claude` first on PATH is {resolved}; this run uses {claude} "
            "(the PATH one is the cmux shim)."
        )
    if shutil.which(args.tenjin_bin) is None and not Path(args.tenjin_bin).is_file():
        die(f"tenjin binary not found: {args.tenjin_bin}")


def cmd_run(args: argparse.Namespace) -> int:
    pairs_path = Path(args.pairs).resolve()
    pairs = load_pairs(pairs_path, args.only)
    conditions = [c.strip() for c in args.conditions.split(",") if c.strip()]
    for c in conditions:
        if c not in CONDITIONS:
            die(f"unknown condition {c!r}; want one or more of {', '.join(CONDITIONS)}")
    sessions = [s.strip() for s in args.sessions.split(",") if s.strip()]
    for s in sessions:
        if s not in ROLES:
            die(f"unknown session {s!r}; want one or more of {', '.join(ROLES)}")

    check_binaries(args)
    if "tenjin" in conditions:
        load_bench_env()  # registers the secrets with the redactor
        if not TEMPLATE_DATA_DIR.is_dir() and not args.dry_run:
            die(f"no template data dir at {TEMPLATE_DATA_DIR}; run `run.py prepare` first")
        if TEMPLATE_DATA_DIR.is_dir():
            # Registers the wallet passphrase with the redactor before any
            # session can echo it back out of a CLI error line.
            ensure_passphrase(TEMPLATE_DATA_DIR, args.dry_run)

    run_dir = Path(args.out).resolve()
    run_id = run_dir.name
    if not args.dry_run:
        run_dir.mkdir(parents=True, exist_ok=True)
    runner = Runner(run_dir / "commands.log", args.dry_run)

    # A GROUP is one (pair, condition, repeat): the producer and the consumer that
    # depend on each other. Grouping rather than listing flat sessions is what
    # lets a failed producer invalidate its own repeat.
    groups = [
        (pair, cond, rep)
        for pair in pairs
        for cond in conditions
        for rep in range(1, args.repeats + 1)
    ]
    roles_in_play = [r for r in ROLES if r in sessions]
    plan = [(pair, cond, rep, role) for (pair, cond, rep) in groups for role in roles_in_play]

    out(f"bench-lite run {run_id}")
    out(f"  pairs      : {', '.join(p['id'] for p in pairs)}")
    out(f"  conditions : {', '.join(conditions)}")
    out(f"  sessions   : {', '.join(sessions)}")
    out(f"  repeats    : {args.repeats}")
    out(f"  model      : {args.model}")
    out(f"  out        : {run_dir}")
    out(f"  scratch    : {SCRATCH_ROOT / run_id}")
    out(f"  agent calls: {len(plan)}")
    out("")

    manifest = {
        "run_id": run_id,
        "started_at": now_iso(),
        "pairs_file": str(pairs_path),
        "pairs": [p["id"] for p in pairs],
        "conditions": conditions,
        "sessions": sessions,
        "repeats": args.repeats,
        "model": args.model,
        "claude_bin": args.claude_bin,
        "tenjin_bin": args.tenjin_bin,
        "permission_mode": args.permission_mode,
        "cap_s": args.cap_s,
        "capture_turn": args.capture_turn,
        "capture_cap_s": args.capture_cap_s,
        "workers": args.workers,
        "dry_run": args.dry_run,
    }
    if not args.dry_run:
        write_json(run_dir / "manifest.json", manifest)

    if args.preflight and not args.dry_run:
        out("preflight: one tiny agent call through the sandbox …")
        pf = preflight(runner, args, run_dir)
        write_json(run_dir / "preflight.json", pf)
        out(f"  ok={pf['ok']} exit={pf['exit_code']} parsed={pf['parsed']}")
        if not pf["ok"]:
            die("preflight failed; fix the agent invocation before spending a run")

    records: list[dict[str, Any]] = []
    records_path = run_dir / "records.jsonl"
    write_lock = threading.Lock()

    def emit(record: dict[str, Any]) -> None:
        with write_lock:
            records.append(record)
            if not args.dry_run:
                with records_path.open("a", encoding="utf-8") as fh:
                    fh.write(json.dumps(record, sort_keys=True, default=str) + "\n")

    def session_failed(record: dict[str, Any]) -> str | None:
        """Why this session cannot be trusted to have finished its work, or None."""
        if record.get("capped"):
            return "producer_capped"
        if record.get("errors"):
            return "producer_errored"
        agent = record.get("agent") or {}
        if agent.get("exit_code") not in (0, None) or agent.get("is_error") is True:
            return "producer_errored"
        return None

    def run_group(group: tuple[dict[str, Any], str, int]) -> None:
        """One (pair, condition, repeat), producer first.

        A producer that is capped or errored never reached its Stop hook, so in
        the `tenjin` condition nothing was captured and nothing was published —
        and a consumer run against that empty shelf would measure the absence of
        a publish, not the presence of reuse. So the repeat is marked invalid and
        the consumer is SKIPPED there. In `off` there is nothing to publish, so
        the consumer still runs; the repeat is flagged so the pair totals can be
        excluded alongside their tenjin counterpart.
        """
        pair, cond, rep = group
        invalid: str | None = None

        for role in roles_in_play:
            if role == "consumer" and invalid is not None and cond == "tenjin":
                skipped = {
                    "run_id": run_id,
                    "pair_id": pair["id"],
                    "role": role,
                    "condition": cond,
                    "repeat": rep,
                    "skipped": invalid,
                    "invalid": invalid,
                    "errors": [
                        f"consumer not run: the {cond} producer for this repeat was "
                        f"{invalid.replace('producer_', '')}, so its Stop hook never "
                        "captured or published anything"
                    ],
                    "started_at": now_iso(),
                    "finished_at": now_iso(),
                }
                out(f"\n=== {pair['id']}/{cond}/r{rep}/{role} === SKIPPED ({invalid})")
                emit(skipped)
                continue

            record = run_session(
                runner, args, run_dir, pairs_path.parent, pair, role, cond, rep, run_id
            )
            if role == "producer":
                invalid = session_failed(record)
                if invalid:
                    record["invalid"] = invalid
                    out(f"  !! producer {invalid}: this repeat is marked invalid")
            elif invalid is not None:
                record["invalid"] = invalid
            emit(record)

    # Only `off` may be parallel, and the unit of parallelism is the GROUP, so a
    # producer and its consumer stay in order inside one worker. In `tenjin`, B
    # must see what A published, and two loop daemons plus two pnpm installs at
    # once is how a 16 GB laptop swaps to death.
    parallel = [g for g in groups if g[1] == "off"] if args.workers > 1 else []
    serial = [g for g in groups if g not in parallel]

    if parallel:
        out(f"running {len(parallel)} `off` group(s) with {args.workers} worker(s)")
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            list(pool.map(run_group, parallel))
    for group in serial:
        run_group(group)

    if args.dry_run:
        out("\ndry-run complete: no agent was called, nothing was installed, nothing published.")
        return 0

    report = build_report(run_dir, records, args)
    (run_dir / "report.md").write_text(report, encoding="utf-8")
    manifest["finished_at"] = now_iso()
    manifest["sessions_recorded"] = len(records)
    write_json(run_dir / "manifest.json", manifest)
    out(f"\nrecords: {records_path}")
    out(f"report : {run_dir / 'report.md'}")
    failures = [r for r in records if r.get("errors")]
    return 1 if failures else 0


# --------------------------------------------------------------------------
# The `cleanup` subcommand
# --------------------------------------------------------------------------


def cmd_cleanup(args: argparse.Namespace) -> int:
    values = load_bench_env()
    origin = values["TENJIN_BENCH_ORIGIN"].rstrip("/")
    run_dir = Path(args.out).resolve()
    records_path = run_dir / "records.jsonl"
    if not records_path.is_file():
        die(f"no records at {records_path}")
    runner = Runner(run_dir / "cleanup.log", args.dry_run)

    records = [json.loads(line) for line in records_path.read_text(encoding="utf-8").splitlines() if line.strip()]

    # 1. No daemon may outlive the run, whatever else happens below.
    data_dirs = sorted(
        {r["paths"]["data_dir"] for r in records if r.get("condition") == "tenjin" and r.get("paths")}
    )
    for d in data_dirs:
        if Path(d).is_dir():
            stop_daemon(runner, args, Path(d))

    # 2. THE ORIGIN ASSERTION. Deleting is irreversible on the wrong shelf, so
    #    the configured baseUrl must be the bench origin before a single delete.
    passphrase = ensure_passphrase(TEMPLATE_DATA_DIR, args.dry_run)
    env = tenjin_env(TEMPLATE_DATA_DIR, passphrase)
    got = cli_json(runner.run(
        [args.tenjin_bin, "config", "get", "baseUrl", "--json"],
        env_overlay=env, allow_in_dry_run=True, label="config.get",
    ))
    configured = ((got or {}).get("data") or {}).get("value")
    if (configured or "").rstrip("/") != origin:
        die(
            "refusing to delete anything: the template data dir's baseUrl is not the bench "
            f"origin (got {redact(str(configured))}). Nothing was deleted."
        )
    out("origin assertion: baseUrl matches TENJIN_BENCH_ORIGIN — proceeding")

    urls: list[str] = []
    for r in records:
        for p in r.get("published") or []:
            if p.get("key", "").startswith("published:") and p.get("url"):
                if p["url"] not in urls:
                    urls.append(p["url"])
    out(f"{len(urls)} post(s) recorded as published by this run")

    deleted: list[dict[str, Any]] = []
    for url in urls:
        if not url.rstrip("/").startswith(origin):
            out(f"  SKIP (not on the bench origin): {url}")
            deleted.append({"url": url, "skipped": "not-bench-origin"})
            continue
        # `tenjin delete` takes the post uuid; `inspect` hands it over without
        # paying (bench posts are price 0, so this is the free path).
        info = cli_json(runner.run(
            [args.tenjin_bin, "inspect", url, "--json"],
            env_overlay=env, timeout=CLI_TIMEOUT_S, label="inspect",
        ))
        post_id = ((info or {}).get("data") or {}).get("resourceId")
        if not post_id or not UUID_RE.fullmatch(str(post_id)):
            out(f"  SKIP (no post id from inspect): {url}")
            deleted.append({"url": url, "skipped": "no-post-id"})
            continue
        res = runner.run(
            [args.tenjin_bin, "delete", str(post_id), "--yes", "--json"],
            env_overlay=env, timeout=CLI_TIMEOUT_S, label="delete",
        )
        ok = res["exit_code"] == 0
        out(f"  {'deleted' if ok else 'FAILED '} {post_id}  {url}")
        deleted.append({"url": url, "post_id": post_id, "exit_code": res["exit_code"],
                        "stderr_tail": tail(res["stderr"], 800)})

    # 3. Scratch sandboxes (worktrees are already removed per session).
    scratch = SCRATCH_ROOT / run_dir.name
    if args.purge_scratch:
        runner.log(f"# rm -rf {scratch}")
        if not args.dry_run and scratch.is_dir():
            shutil.rmtree(scratch, ignore_errors=True)

    if not args.dry_run:
        write_json(run_dir / "cleanup.json", {"at": now_iso(), "origin_asserted": True,
                                              "deleted": deleted, "data_dirs": data_dirs})
    failed = [d for d in deleted if d.get("exit_code") not in (0, None) and "skipped" not in d]
    return 1 if failed else 0


# --------------------------------------------------------------------------
# argv
# --------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="run.py",
        description="bench-lite: end-to-end team-reuse benchmark for the Tenjin loop",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = p.add_subparsers(dest="command")

    def common(sp: argparse.ArgumentParser) -> None:
        sp.add_argument("--tenjin-bin", default=DEFAULT_TENJIN_BIN, help="tenjin CLI to use")
        sp.add_argument("--dry-run", action="store_true", help="print the plan and every command; run nothing")

    run_p = sub.add_parser("run", help="run the benchmark")
    common(run_p)
    run_p.add_argument("--pairs", required=True, help="path to pairs.json")
    run_p.add_argument("--conditions", default="off,tenjin", help="comma list: off,tenjin")
    run_p.add_argument("--repeats", type=int, default=3)
    run_p.add_argument("--model", default=DEFAULT_MODEL)
    run_p.add_argument("--out", required=True, help="run directory for records and the report")
    run_p.add_argument("--only", action="append", help="restrict to this pair id (repeatable)")
    run_p.add_argument("--sessions", default="producer,consumer", help="comma list: producer,consumer")
    run_p.add_argument("--workers", type=int, default=1, help="parallel workers; `off` sessions only")
    run_p.add_argument(
        "--cap-s",
        type=int,
        default=DEFAULT_CAP_S,
        help="wall-clock cap per agent session in seconds; a pair may override it "
        "per session with `cap_s` in pairs.json",
    )
    run_p.add_argument("--claude-bin", default=DEFAULT_CLAUDE_BIN)
    run_p.add_argument("--permission-mode", default="bypassPermissions",
                       choices=["acceptEdits", "auto", "bypassPermissions", "dontAsk", "plan"])
    run_p.add_argument("--max-budget-usd", default=None, help="per-session API spend cap")
    run_p.add_argument("--skip-install", action="store_true", help="skip pnpm install (deps already present)")
    run_p.add_argument("--skip-oracle", action="store_true", help="copy the oracle files but do not run the command")
    run_p.add_argument("--keep-worktrees", action="store_true", help="leave worktrees in place for debugging")
    run_p.add_argument(
        "--no-capture-turn",
        dest="capture_turn",
        action="store_false",
        help="skip the producer's follow-up capture turn in the tenjin condition",
    )
    run_p.add_argument(
        "--capture-cap-s",
        type=int,
        default=900,
        help="wall-clock cap for the capture turn, in seconds",
    )
    run_p.add_argument("--no-preflight", dest="preflight", action="store_false",
                       help="skip the one-call sandbox/auth/JSON check")
    run_p.set_defaults(func=cmd_run, preflight=True, capture_turn=True)

    prep_p = sub.add_parser("prepare", help="build the template bench data dir and verify it")
    common(prep_p)
    prep_p.add_argument("--force", action="store_true", help="delete and rebuild the template data dir")
    prep_p.add_argument("--probe", default="bench-lite prepare connectivity probe",
                        help="the question `prepare` searches with to prove the shelf answers")
    prep_p.set_defaults(func=cmd_prepare)

    clean_p = sub.add_parser("cleanup", help="stop daemons and retract this run's bench-shelf posts")
    common(clean_p)
    clean_p.add_argument("--out", required=True, help="the run directory to clean up")
    clean_p.add_argument("--purge-scratch", action="store_true", help="also delete the run's scratch sandboxes")
    clean_p.set_defaults(func=cmd_cleanup)

    return p


def main(argv: list[str]) -> int:
    # `run` is the default verb, so the documented form works without it.
    if argv and argv[0] not in {"run", "prepare", "cleanup", "-h", "--help"}:
        argv = ["run"] + argv
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "func", None):
        parser.print_help()
        return 2
    return int(args.func(args) or 0)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
