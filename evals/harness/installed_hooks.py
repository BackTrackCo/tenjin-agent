#!/usr/bin/env python3
"""Helpers for the output runner's explicit installed-hooks lane.

This lane is intentionally unlike the default, isolated output eval.  It loads
the caller's ordinary Claude settings and Tenjin environment and can write to
the configured team shelf.  These helpers keep that exception narrow:

* the installed setup is checked through Tenjin's own read-only machine
  surfaces before Claude starts;
* the runner never supplies a data-directory or publish-mode override;
* raw prompts, bodies, receipts, session ids, and grader evidence stay out of
  the emitted report; and
* a publish is attributed only from the Bash tool's ordinary Tenjin receipt.

The executor transcript is still redacted by ``run_output_eval.py`` and kept in
the local runner workspace.  Claude's native transcript is retained because the
installed lane deliberately omits ``--no-session-persistence``.
"""

from __future__ import annotations

import json
import hashlib
import math
import os
import re
import shlex
import shutil
import stat
import subprocess
import sys
import time
from collections import Counter
from pathlib import Path
from typing import Callable
from urllib.parse import urlparse


CAPTURE_ASK_MARKER = "Before ending: if this session settled anything"
TEAM_CAPTURE_ASK_MARKER = "anything a teammate on this project would reuse"
RECEIPT_CLASSES = (
    "published",
    "duplicate",
    "dry_run",
    "needs_confirmation",
    "blocked",
    "permission_denied",
    "failed",
    "unknown",
)
FORBIDDEN_REPORT_KEYS = frozenset(
    {
        "prompt",
        "question",
        "questions",
        "body",
        "bodyMd",
        "evidence",
        "excerpt",
        "requester",
        "wallet",
        "credential",
        "transcript",
        "sessionId",
        "session_id",
        "resourceId",
        "url",
    }
)

# Configuration locations/overrides the installed Tenjin and Claude setup
# documents. Wallet/provider/cloud credentials are deliberately absent: the
# controlled lane requires doctor to pass through the installed file + OS
# credential-store setup under this same environment.
INSTALLED_ENV_PASSTHROUGH = (
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LC_ALL",
    "TERM",
    "TMPDIR",
    "CLAUDE_CONFIG_DIR",
    "TENJIN_DATA_DIR",
    "TENJIN_BASE_URL",
    "TENJIN_PUBLISH_MODE",
)
EXPECTED_PUSH_HOOKS = (
    ("UserPromptSubmit", None, "tenjin-push-prompt.mjs"),
    ("PostToolUse", "Bash", "tenjin-push-failure.mjs"),
    ("PostToolUseFailure", "Bash", "tenjin-push-failure.mjs"),
    ("SubagentStart", None, "tenjin-push-subagent.mjs"),
    ("SubagentStop", None, "tenjin-push-subagent.mjs"),
    ("PostToolUse", "Read", "tenjin-push-context.mjs"),
    ("PreToolUse", "Edit|Write|MultiEdit", "tenjin-push-context.mjs"),
)
PUSH_HOOK_FILES = frozenset(item[2] for item in EXPECTED_PUSH_HOOKS)
GENERATED_HOOK_FILES = (
    "tenjin-dispatch.mjs",
    "tenjin-push-context.mjs",
    "tenjin-push-failure.mjs",
    "tenjin-push-prompt.mjs",
    "tenjin-push-subagent.mjs",
    "tenjin-sessionstart.mjs",
    "tenjin-stop.mjs",
    "tenjin-websearch.mjs",
)
CONTROLLED_INSTRUCTIONS = """# Controlled Tenjin publication eval

First inspect the fresh synthetic repository with exactly `git status --short`,
then answer the user's investigation normally. Do not run other shell commands.

Only if an ordinary installed hook later asks you to publish a finding, write
its complete Markdown to exactly `./tenjin-candidate.md`, then invoke exactly:

`tenjin publish ./tenjin-candidate.md --json`

Do not publish merely because this file explains the mechanics: wait for the
hook continuation. Do not add flags, chain commands, redirect, substitute shell
input, change Tenjin configuration, or retry an ambiguous result. The runner
has already verified the effective team shelf and `auto` mode. If there is no
publishable finding, do not create the file and do not run Tenjin.
"""


class InstalledHooksPreflightError(RuntimeError):
    """A bounded, non-sensitive reason the live lane must not start."""


def installed_child_env() -> dict[str, str]:
    """Return only the documented config/auth-location environment.

    The default eval deliberately pins ``TENJIN_DATA_DIR`` and
    ``TENJIN_PUBLISH_MODE``.  Doing either here would stop measuring the setup
    whose standing consent and hook bundle are under test, so existing values
    are copied byte-for-byte and absent values stay absent. Provider secrets,
    cloud credentials, and arbitrary caller variables do not enter Claude's
    shell; doctor must pass using installed files and the OS credential store.
    """

    return {key: os.environ[key] for key in INSTALLED_ENV_PASSTHROUGH if key in os.environ}


def _settings_path(child: dict[str, str], status_path: object) -> Path:
    """Resolve the exact ordinary Claude settings file reported by Tenjin.

    Status is the authority because a non-default Claude configuration directory
    is supported.  The environment-derived path is only a cross-check: reading a
    different settings file here would validate hooks other than the ones Claude
    is about to load.
    """

    if not isinstance(status_path, str) or not status_path:
        raise InstalledHooksPreflightError("tenjin push status named no Claude settings file")
    reported = Path(status_path).expanduser()
    config_root = child.get("CLAUDE_CONFIG_DIR")
    if config_root:
        expected = Path(config_root).expanduser() / "settings.json"
    else:
        home = child.get("HOME")
        if not home:
            raise InstalledHooksPreflightError("installed environment has no HOME")
        expected = Path(home).expanduser() / ".claude" / "settings.json"
    try:
        if reported.resolve(strict=True) != expected.resolve(strict=True):
            raise InstalledHooksPreflightError(
                "tenjin status and Claude configuration resolve to different settings files"
            )
    except OSError:
        raise InstalledHooksPreflightError("Claude settings file is missing or inaccessible") from None
    return reported


def _hook_script(command: object) -> Path | None:
    if not isinstance(command, str) or "\n" in command or "\r" in command:
        return None
    try:
        parts = shlex.split(command)
    except ValueError:
        return None
    if len(parts) != 2 or parts[0] != "node":
        return None
    script = Path(parts[1])
    if not script.is_absolute() or script.parent.name != "hooks":
        return None
    return script


def _installed_hook_identities(settings_path: Path) -> dict:
    """Verify the seven push identities and the Stop entry structurally.

    Counts alone are insufficient: two entries share PostToolUse and an old
    installation can therefore report seven handlers while the prompt or context
    arm points at the wrong script/matcher.  Only Tenjin-owned script basenames
    participate; unrelated user hooks may coexist.
    """

    try:
        settings = json.loads(settings_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        raise InstalledHooksPreflightError("Claude settings are unreadable or invalid") from None
    hooks = settings.get("hooks") if isinstance(settings, dict) else None
    if not isinstance(hooks, dict):
        raise InstalledHooksPreflightError("Claude settings have no hook table")

    found: list[tuple[str, str | None, str]] = []
    roots: set[Path] = set()
    stop_entries = 0
    for event, entries in hooks.items():
        if not isinstance(event, str) or not isinstance(entries, list):
            continue
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            handlers = entry.get("hooks")
            if not isinstance(handlers, list):
                continue
            for handler in handlers:
                if not isinstance(handler, dict):
                    continue
                script = _hook_script(handler.get("command"))
                if script is None:
                    continue
                name = script.name
                if name not in PUSH_HOOK_FILES and name != "tenjin-stop.mjs":
                    continue
                if set(handler) != {"type", "command", "timeout"}:
                    raise InstalledHooksPreflightError("installed Tenjin hook handler shape drifted")
                if handler.get("type") != "command":
                    raise InstalledHooksPreflightError("installed Tenjin hook is not a command handler")
                expected_timeout = 8 if name in PUSH_HOOK_FILES else 5
                if handler.get("timeout") != expected_timeout:
                    raise InstalledHooksPreflightError("installed Tenjin hook timeout drifted")
                try:
                    metadata = os.lstat(script)
                    if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
                        raise InstalledHooksPreflightError(
                            "installed Tenjin hook is not a regular non-symlink file"
                        )
                    body = script.read_bytes()
                except OSError:
                    raise InstalledHooksPreflightError(
                        "installed Tenjin hook script is missing or inaccessible"
                    ) from None
                roots.add(script.parent.resolve(strict=True))
                matcher = entry.get("matcher")
                if name == "tenjin-stop.mjs":
                    if event != "Stop" or matcher is not None or set(entry) != {"hooks"}:
                        raise InstalledHooksPreflightError("installed Tenjin Stop hook identity drifted")
                    stop_entries += 1
                    continue
                expected_keys = {"hooks"} if matcher is None else {"hooks", "matcher"}
                if set(entry) != expected_keys:
                    raise InstalledHooksPreflightError("installed Tenjin push hook entry shape drifted")
                found.append((event, matcher if isinstance(matcher, str) else None, name))

    if sorted(found) != sorted(EXPECTED_PUSH_HOOKS):
        raise InstalledHooksPreflightError(
            "installed Claude hooks do not match the seven planned event/matcher/script identities"
        )
    if stop_entries != 1:
        raise InstalledHooksPreflightError("installed Claude settings need exactly one Tenjin Stop hook")
    if len(roots) != 1:
        raise InstalledHooksPreflightError("installed Tenjin hooks do not share one hooks directory")
    hook_root = next(iter(roots))
    normalized: list[str] = []
    data_dirs: set[Path] = set()
    for name in GENERATED_HOOK_FILES:
        script = hook_root / name
        try:
            metadata = os.lstat(script)
            if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
                raise OSError
            body = script.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            raise InstalledHooksPreflightError(
                "installed generated hook bundle is incomplete or inaccessible"
            ) from None
        match = re.search(r"^const DATA_DIR = (.+);$", body, flags=re.MULTILINE)
        if match is None:
            raise InstalledHooksPreflightError("installed generated hook has no DATA_DIR stamp")
        try:
            raw_data_dir = json.loads(match.group(1))
            if not isinstance(raw_data_dir, str) or not Path(raw_data_dir).is_absolute():
                raise ValueError
            data_dirs.add(Path(raw_data_dir).resolve(strict=True))
        except (OSError, RuntimeError, ValueError, json.JSONDecodeError):
            raise InstalledHooksPreflightError(
                "installed generated hook has an invalid DATA_DIR stamp"
            ) from None
        body = body[: match.start()] + 'const DATA_DIR = "<DISPOSABLE_DATA_DIR>";' + body[match.end() :]
        normalized.append(f"{name}\n{body}")
    if len(data_dirs) != 1:
        raise InstalledHooksPreflightError(
            "installed generated hook bundle does not share one data directory"
        )
    digest = hashlib.sha256("\n".join(normalized).encode("utf-8")).hexdigest()
    return {
        "pushIdentityCount": 7,
        "pushIdentitiesExact": True,
        "stopIdentityExact": True,
        "installedHookSetSha256": digest,
        "installedHookScriptCount": len(GENERATED_HOOK_FILES),
        # Private runner input. installed_hooks_preflight deliberately omits it
        # from the bounded report shape.
        "installedDataDir": next(iter(data_dirs)),
    }


def installed_capture_state_db(
    *, env: dict[str, str], expected_hook_sha256: str
) -> Path:
    """Resolve the installed Stop hook's state DB without exposing its path.

    This repeats the exact identity/byte check after preflight and returns a
    private runner value only. Reports receive the content-free hook digest, not
    the machine-local data-directory path.
    """

    config_root = env.get("CLAUDE_CONFIG_DIR")
    if config_root:
        expected_settings = Path(config_root).expanduser() / "settings.json"
    else:
        home = env.get("HOME")
        if not home:
            raise InstalledHooksPreflightError("installed environment has no HOME")
        expected_settings = Path(home).expanduser() / ".claude" / "settings.json"
    identity = _installed_hook_identities(
        _settings_path(env, str(expected_settings.resolve(strict=True)))
    )
    if identity["installedHookSetSha256"] != expected_hook_sha256:
        raise InstalledHooksPreflightError(
            "installed hook bundle changed after controlled preflight"
        )
    state_db = Path(identity["installedDataDir"]) / "state.db"
    try:
        metadata = os.lstat(state_db)
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
            raise OSError
        resolved = state_db.resolve(strict=True)
    except (OSError, RuntimeError):
        raise InstalledHooksPreflightError(
            "installed capture state database is missing or unsafe"
        ) from None
    return resolved


def write_command_policy(
    *,
    control_dir: Path,
    project: Path,
    state_db: Path,
    not_before_ms: int | None = None,
) -> Path:
    """Write the runner-owned additional settings file outside the case cwd."""

    control_dir.mkdir(parents=True, exist_ok=True)
    root = project.resolve(strict=True)
    if (root / "tenjin-candidate.md").exists():
        raise InstalledHooksPreflightError("controlled case did not start with an empty candidate")
    settings = control_dir / "settings.json"
    try:
        settings.resolve().relative_to(root)
    except ValueError:
        pass
    else:
        raise InstalledHooksPreflightError("command policy must live outside the case directory")
    policy = Path(__file__).resolve().parent / "tenjin_command_policy.py"
    boundary_ms = round(time.time() * 1000) if not_before_ms is None else not_before_ms
    if boundary_ms < 0:
        raise InstalledHooksPreflightError("command policy run boundary is invalid")
    command = (
        f"{shlex.quote(sys.executable)} {shlex.quote(str(policy))} "
        f"--project {shlex.quote(str(root))} "
        f"--state-db {shlex.quote(str(state_db.resolve(strict=True)))} "
        f"--not-before-ms {boundary_ms}"
    )
    payload = {
        "hooks": {
            "PreToolUse": [
                {
                    "matcher": "Bash|Write",
                    "hooks": [{"type": "command", "command": command, "timeout": 5}],
                }
            ]
        }
    }
    settings.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return settings


def _safe_source(value: object) -> str:
    allowed = {"default", "file", "env", "project", "flag"}
    return value if isinstance(value, str) and value in allowed else "other"


def _origin(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return None
    return f"{parsed.scheme.lower()}://{parsed.netloc.lower()}"


def _data(envelope: dict, expected_command: str) -> dict:
    if envelope.get("ok") is not True or envelope.get("command") != expected_command:
        raise InstalledHooksPreflightError(f"tenjin {expected_command} did not report success")
    data = envelope.get("data")
    if not isinstance(data, dict):
        raise InstalledHooksPreflightError(f"tenjin {expected_command} returned no data object")
    return data


def _setting(config: dict, key: str) -> tuple[object, str]:
    entry = config.get(key)
    if not isinstance(entry, dict) or "value" not in entry:
        raise InstalledHooksPreflightError(f"effective config omitted {key}")
    return entry["value"], _safe_source(entry.get("source"))


def installed_hooks_preflight(
    *,
    cwd: Path,
    timeout: int = 120,
    executable: str | None = None,
    runner: Callable[..., subprocess.CompletedProcess[str]] | None = None,
    env: dict[str, str] | None = None,
) -> dict:
    """Verify the exact installed configuration the controlled run will use.

    Doctor and status may contain URLs, paths, balances, or other machine-local
    detail.  None of their payload is returned.  The result is a fixed-shape set
    of booleans, enums, counts, and provenance suitable for a committed thin
    report.
    """

    child = dict(os.environ if env is None else env)
    cli = executable or shutil.which("tenjin", path=child.get("PATH"))
    if cli is None:
        raise InstalledHooksPreflightError("tenjin is not on PATH")
    call = subprocess.run if runner is None else runner

    def invoke(arguments: list[str], expected_command: str) -> dict:
        try:
            completed = call(
                [cli, *arguments, "--json"],
                cwd=cwd,
                stdin=subprocess.DEVNULL,
                capture_output=True,
                text=True,
                timeout=timeout,
                env=child,
            )
        except (OSError, subprocess.TimeoutExpired):
            raise InstalledHooksPreflightError(
                f"tenjin {expected_command} could not complete"
            ) from None
        if completed.returncode != 0:
            raise InstalledHooksPreflightError(f"tenjin {expected_command} failed")
        try:
            envelope = json.loads(completed.stdout)
        except (json.JSONDecodeError, TypeError):
            raise InstalledHooksPreflightError(
                f"tenjin {expected_command} returned no JSON envelope"
            ) from None
        if not isinstance(envelope, dict):
            raise InstalledHooksPreflightError(
                f"tenjin {expected_command} returned a non-object envelope"
            )
        return _data(envelope, expected_command)

    doctor = invoke(["doctor"], "doctor")
    status = invoke(["push", "status"], "push.status")
    config = invoke(["config"], "config")

    if doctor.get("status") != "pass":
        raise InstalledHooksPreflightError("tenjin doctor did not pass")
    checks = doctor.get("checks")
    checks_by_name = (
        {
            str(check.get("name")): check
            for check in checks
            if isinstance(check, dict) and isinstance(check.get("name"), str)
        }
        if isinstance(checks, list)
        else {}
    )
    for check_name in ("team shelf", "push hooks", "skills"):
        if checks_by_name.get(check_name, {}).get("status") != "ok":
            raise InstalledHooksPreflightError(
                f"tenjin doctor did not confirm current {check_name}"
            )

    publish_mode, publish_source = _setting(config, "publish.mode")
    web_search, web_search_source = _setting(config, "hooks.webSearch")
    base_url, _ = _setting(config, "baseUrl")
    public_url, _ = _setting(config, "publicShelfUrl")
    bypass, _ = _setting(config, "shelfBypassSecret")
    if (
        bypass != "set"
        or _origin(base_url) is None
        or _origin(public_url) is None
        or _origin(base_url) == _origin(public_url)
    ):
        raise InstalledHooksPreflightError(
            "effective config is not a distinct authenticated team shelf"
        )
    if publish_mode != "auto":
        raise InstalledHooksPreflightError("effective publish.mode must be auto")
    if web_search != "auto":
        raise InstalledHooksPreflightError("effective hooks.webSearch must be auto")

    entries = status.get("hookEntries")
    if status.get("mode") != "on":
        raise InstalledHooksPreflightError("tenjin push status must report push on")
    if status.get("captureMode") != "block":
        raise InstalledHooksPreflightError("tenjin push status must report capture block")
    if status.get("scriptsWired") is not True:
        raise InstalledHooksPreflightError("tenjin push status must report scripts wired")
    if (
        not isinstance(entries, dict)
        or entries.get("present") != 7
        or entries.get("planned") != 7
        or entries.get("missing") != []
    ):
        raise InstalledHooksPreflightError(
            "tenjin push status must report all seven Claude hook entries"
        )
    identity = _installed_hook_identities(_settings_path(child, entries.get("path")))

    return {
        "doctor": "pass",
        "teamShelfConfigured": True,
        "publishMode": {"value": "auto", "source": publish_source},
        "hooks": {
            "push": "on",
            "capture": "block",
            "webSearch": {"value": "auto", "source": web_search_source},
        },
        "claudePushHookEntries": {
            "present": 7,
            "planned": 7,
            "identitiesExact": identity["pushIdentitiesExact"],
        },
        "stopHookEntryExact": identity["stopIdentityExact"],
        "installedHookSetSha256": identity["installedHookSetSha256"],
        "installedHookScriptCount": identity["installedHookScriptCount"],
        # Doctor's `skills=ok` is the CLI's byte-for-byte comparison of the
        # wired skill directories against this installed build's packaged
        # copies (a warn is refused above), not a version-string inference.
        "installedSkillBytesCurrent": True,
        "scriptsWired": True,
        "tenjinDataDirInherited": "TENJIN_DATA_DIR" in child,
        "publishModeEnvironmentInherited": "TENJIN_PUBLISH_MODE" in child,
    }


def source_provenance(
    repo: Path,
    *,
    runner: Callable[..., subprocess.CompletedProcess[str]] | None = None,
) -> dict:
    """Bind a controlled run to one clean source commit and commit date."""

    call = subprocess.run if runner is None else runner

    def git(*arguments: str) -> str:
        try:
            result = call(
                ["git", *arguments],
                cwd=repo,
                stdin=subprocess.DEVNULL,
                capture_output=True,
                text=True,
                timeout=30,
            )
        except (OSError, subprocess.TimeoutExpired):
            raise InstalledHooksPreflightError("source provenance could not be read") from None
        if result.returncode != 0:
            raise InstalledHooksPreflightError("source provenance could not be read")
        return result.stdout.strip()

    commit = git("rev-parse", "HEAD")
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise InstalledHooksPreflightError("source commit is not a full Git object id")
    if git("status", "--porcelain"):
        raise InstalledHooksPreflightError("controlled installed-hooks runs require a clean checkout")
    commit_date = git("show", "-s", "--format=%cI", commit)
    if not commit_date:
        raise InstalledHooksPreflightError("source commit has no recorded date")
    return {"commit": commit, "commitDate": commit_date}


def _stable(value: object) -> object:
    if isinstance(value, list):
        return [_stable(item) for item in value]
    if isinstance(value, dict):
        return {key: _stable(value[key]) for key in sorted(value)}
    return value


def _canonical_sha256(value: object) -> str:
    body = json.dumps(_stable(value), separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


def _file_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


CONSUMER_USE_BLOCKER = "ordinary_team_prompt_hook_always_queries_public"


def _public_installed_preflight(preflight: dict) -> dict:
    """Copy only the fixed, content-free installed preflight fields."""

    keys = (
        "doctor",
        "teamShelfConfigured",
        "publishMode",
        "hooks",
        "claudePushHookEntries",
        "stopHookEntryExact",
        "installedHookSetSha256",
        "installedHookScriptCount",
        "installedSkillBytesCurrent",
        "scriptsWired",
        "tenjinDataDirInherited",
        "publishModeEnvironmentInherited",
    )
    if any(key not in preflight for key in keys):
        raise InstalledHooksPreflightError("installed preflight is incomplete")
    return {key: preflight[key] for key in keys}


def consumer_fixture_preflight(fixture_dir: Path) -> dict:
    """Bind the complete held-out question set without returning its text."""

    root = fixture_dir.resolve(strict=True)
    names = ("manifest.json", "labels.json", "questions.json", "evaluator.json")
    paths = {name: root / name for name in names}
    lock_path = root / "fixture-lock.json"
    try:
        lock = json.loads(lock_path.read_text(encoding="utf-8"))
        documents = {
            name: json.loads(path.read_text(encoding="utf-8"))
            for name, path in paths.items()
        }
    except (OSError, json.JSONDecodeError):
        raise InstalledHooksPreflightError(
            "consumer lane fixture or lock is missing or invalid"
        ) from None
    if (
        not isinstance(lock, dict)
        or lock.get("status") != "frozen_before_treatment"
        or lock.get("fixtureRole") != "held_out_recorded_archive"
        or set(lock.get("files", {})) != set(names)
    ):
        raise InstalledHooksPreflightError("consumer lane requires the frozen held-out archive")
    actual_hashes = {name: _file_sha256(path) for name, path in paths.items()}
    if actual_hashes != lock["files"]:
        raise InstalledHooksPreflightError("consumer lane frozen input bytes drifted")

    manifest = documents["manifest.json"]
    labels = documents["labels.json"]
    questions = documents["questions.json"]
    evaluator = documents["evaluator.json"]
    if any(not isinstance(item, dict) for item in documents.values()):
        raise InstalledHooksPreflightError("consumer lane frozen input shape drifted")
    cases = manifest.get("cases")
    label_rows = labels.get("labels")
    concepts = questions.get("concepts")
    distractors = questions.get("distractors")
    if not all(isinstance(value, list) for value in (cases, label_rows, concepts, distractors)):
        raise InstalledHooksPreflightError("consumer lane frozen arrays are missing")
    case_ids = [case.get("caseId") for case in cases if isinstance(case, dict)]
    label_ids = [label.get("caseId") for label in label_rows if isinstance(label, dict)]
    if (
        len(cases) != 30
        or len(case_ids) != len(cases)
        or any(not isinstance(value, str) or not value for value in case_ids)
        or len(set(case_ids)) != len(case_ids)
        or set(label_ids) != set(case_ids)
        or manifest.get("casesSha256") != _canonical_sha256(cases)
        or manifest.get("casesSha256") != lock.get("manifestCasesSha256")
    ):
        raise InstalledHooksPreflightError("consumer lane held-out case binding drifted")

    expected_concepts = {
        concept_id
        for label in label_rows
        if isinstance(label, dict)
        for concept_id in label.get("reusableConceptIds", [])
        if isinstance(concept_id, str)
    }
    concept_ids: list[str] = []
    natural_ids: list[str] = []
    for concept in concepts:
        if not isinstance(concept, dict) or not isinstance(concept.get("conceptId"), str):
            raise InstalledHooksPreflightError("consumer lane concept shape drifted")
        concept_ids.append(concept["conceptId"])
        rows = concept.get("questions")
        if not isinstance(rows, list) or len(rows) not in {2, 3}:
            raise InstalledHooksPreflightError("consumer lane natural-question count drifted")
        for row in rows:
            if (
                not isinstance(row, dict)
                or not isinstance(row.get("questionId"), str)
                or not isinstance(row.get("text"), str)
                or not row["text"].strip()
            ):
                raise InstalledHooksPreflightError("consumer lane natural-question shape drifted")
            natural_ids.append(row["questionId"])
    distractor_ids: list[str] = []
    for row in distractors:
        if (
            not isinstance(row, dict)
            or not isinstance(row.get("questionId"), str)
            or not isinstance(row.get("text"), str)
            or not row["text"].strip()
        ):
            raise InstalledHooksPreflightError("consumer lane distractor shape drifted")
        distractor_ids.append(row["questionId"])
    all_question_ids = natural_ids + distractor_ids
    if (
        len(concept_ids) != len(set(concept_ids))
        or set(concept_ids) != expected_concepts
        or len(all_question_ids) != len(set(all_question_ids))
        or evaluator.get("heldOutCaseCount") != len(cases)
        or evaluator.get("reusableConceptCount") != len(concept_ids)
        or evaluator.get("naturalQuestionCount") != len(natural_ids)
        or evaluator.get("distractorCount") != len(distractor_ids)
    ):
        raise InstalledHooksPreflightError("consumer lane frozen denominators drifted")
    return {
        "benchmark": lock["benchmark"],
        "evaluatorVersion": lock["evaluatorVersion"],
        "fixtureRole": lock["fixtureRole"],
        "frozenInputs": {
            "manifestSha256": actual_hashes["manifest.json"],
            "labelsSha256": actual_hashes["labels.json"],
            "questionsSha256": actual_hashes["questions.json"],
            "evaluatorSha256": actual_hashes["evaluator.json"],
            "manifestCasesSha256": lock["manifestCasesSha256"],
            "questionIdsSha256": _canonical_sha256(all_question_ids),
        },
        "fullQuestionSet": {
            "complete": True,
            "cases": len(cases),
            "concepts": len(concept_ids),
            "naturalQuestions": len(natural_ids),
            "distractors": len(distractor_ids),
            "totalQuestions": len(all_question_ids),
        },
    }


def build_blocked_consumer_report(
    *, fixture: dict, preflight: dict, source: dict, parity: dict
) -> dict:
    """Emit an honest thin report when the privacy invariant blocks execution."""

    report = {
        "schemaVersion": 1,
        "benchmark": fixture["benchmark"],
        "evaluatorVersion": fixture["evaluatorVersion"],
        "fixtureRole": fixture["fixtureRole"],
        "lane": "installed_user_prompt_submit_consumer_use",
        "status": "blocked_not_run",
        "blocker": CONSUMER_USE_BLOCKER,
        "source": source,
        "installedParity": parity,
        "preflight": _public_installed_preflight(preflight),
        "frozenInputs": fixture["frozenInputs"],
        "fullQuestionSet": fixture["fullQuestionSet"],
        "networkSafety": {
            "publicRequestsMaximum": 0,
            "publicRequestsObserved": None,
            "status": "not_run",
        },
        "outcomes": {
            "used": None,
            "rejected": None,
            "unobserved": None,
            "ungraded": None,
            "posted": None,
            "coverage": None,
        },
    }
    assert_consumer_report(report)
    return report


def load_controlled_cases(
    *, eval_set: Path, all_cases: list[dict], requested_ids: list[int] | None
) -> tuple[list[dict], dict]:
    """Load the predeclared full controlled subset and its content-free binding.

    ``--only`` is accepted only when it names that exact set once each.  It is a
    convenience for an explicit command, never a way to cherry-pick favorable
    treatment output.
    """

    directory = eval_set.resolve().parent
    declaration_path = directory / "controlled.json"
    try:
        declaration = json.loads(declaration_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        raise InstalledHooksPreflightError(
            "installed-hooks lane requires a valid frozen controlled.json declaration"
        ) from None
    if not isinstance(declaration, dict) or declaration.get("schemaVersion") != 1:
        raise InstalledHooksPreflightError("controlled declaration schema is unsupported")
    fixture_role = declaration.get("fixtureRole")
    if fixture_role not in {"synthetic_smoke_only", "held_out_archive"}:
        raise InstalledHooksPreflightError("controlled declaration has no recognized fixture role")
    entries = declaration.get("cases")
    if not isinstance(entries, list) or not entries:
        raise InstalledHooksPreflightError("controlled declaration has no cases")
    ids: list[int] = []
    tasks: dict[int, str] = {}
    for entry in entries:
        if not isinstance(entry, dict) or set(entry) != {"evalId", "taskPrompt"}:
            raise InstalledHooksPreflightError("controlled declaration case shape drifted")
        eval_id = entry.get("evalId")
        prompt = entry.get("taskPrompt")
        if not isinstance(eval_id, int) or isinstance(eval_id, bool) or not isinstance(prompt, str):
            raise InstalledHooksPreflightError("controlled declaration case is invalid")
        # The ordinary Stop hook must introduce capture.  Even a truthful prompt
        # that merely names the intended mechanism destroys that causal claim.
        if re.search(r"\b(?:stop|capture|publish|hook)\b", prompt, flags=re.IGNORECASE):
            raise InstalledHooksPreflightError(
                "controlled initial task mentions the capture/publication mechanism"
            )
        if eval_id in tasks:
            raise InstalledHooksPreflightError("controlled declaration repeats an eval id")
        ids.append(eval_id)
        tasks[eval_id] = prompt
    declared_hash = _canonical_sha256(entries)
    if declaration.get("casesSha256") != declared_hash:
        raise InstalledHooksPreflightError("controlled declaration casesSha256 drifted")
    if requested_ids is not None and (
        len(requested_ids) != len(set(requested_ids)) or set(requested_ids) != set(ids)
    ):
        raise InstalledHooksPreflightError(
            "--only must name the complete frozen controlled subset exactly once"
        )
    by_id = {
        case.get("id"): case
        for case in all_cases
        if isinstance(case, dict) and isinstance(case.get("id"), int)
    }
    if set(ids) - set(by_id):
        raise InstalledHooksPreflightError("controlled declaration names a missing eval case")
    selected: list[dict] = []
    for eval_id in ids:
        case = dict(by_id[eval_id])
        case["prompt"] = tasks[eval_id]
        selected.append(case)
    return selected, {
        "fixtureRole": fixture_role,
        "benchmarkStatus": declaration.get("benchmarkStatus"),
        "selectedCaseIds": ids,
        "selectedCasesSha256": declared_hash,
        "controlledDeclarationSha256": _file_sha256(declaration_path),
    }


def validate_installed_parity_report(path: Path, source: dict, preflight: dict) -> dict:
    """Validate a content-free report produced by the isolated generator check."""

    try:
        report = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        raise InstalledHooksPreflightError("installed hook parity report is missing or invalid") from None
    if not isinstance(report, dict):
        raise InstalledHooksPreflightError("installed hook parity report is not an object")
    parity = report.get("installedBundleParity")
    if (
        report.get("status") != "complete"
        or report.get("sourceCommit") != source.get("commit")
        or not isinstance(parity, dict)
        or parity.get("verified") is not True
        or parity.get("normalizedBundleSha256") != preflight.get("installedHookSetSha256")
    ):
        raise InstalledHooksPreflightError(
            "installed hook parity report does not bind this source and installed hook set"
        )
    script_count = parity.get("scriptCount")
    if script_count != preflight.get("installedHookScriptCount"):
        raise InstalledHooksPreflightError("installed hook parity report script count drifted")
    return {
        "sourceCommit": source["commit"],
        "hooksMatchPinnedGenerator": True,
        "installedSkillBytesCurrent": preflight.get("installedSkillBytesCurrent") is True,
        "normalizedHookBundleSha256": parity["normalizedBundleSha256"],
        "scriptCount": script_count,
    }


def _event_objects(
    stream: str, line_offsets_ms: list[int] | None = None
) -> list[tuple[dict, int | None]]:
    events: list[tuple[dict, int | None]] = []
    lines = stream.splitlines()
    if line_offsets_ms is not None and len(line_offsets_ms) != len(lines):
        raise ValueError("stream line offsets do not match the captured stream")
    for index, raw in enumerate(lines):
        raw = raw.strip()
        if not raw.startswith("{"):
            continue
        try:
            event = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if isinstance(event, dict):
            events.append((event, None if line_offsets_ms is None else line_offsets_ms[index]))
    return events


def _content_text(value: object) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "\n".join(_content_text(item) for item in value)
    if isinstance(value, dict):
        for key in ("text", "content", "stdout", "stderr"):
            if key in value:
                text = _content_text(value[key])
                if text:
                    return text
        return ""
    return ""


def _json_object(text: str) -> dict | None:
    candidates = [text.strip(), *reversed([line.strip() for line in text.splitlines()])]
    for candidate in candidates:
        if not candidate.startswith("{"):
            continue
        try:
            value = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            # Some harness versions wrap Bash stdout in a structured tool result.
            stdout = value.get("stdout")
            if isinstance(stdout, str):
                nested = _json_object(stdout)
                if nested is not None:
                    return nested
            return value
    return None


def _is_publish_command(command: str) -> bool:
    # The allowed-tools rule already requires the command to begin with tenjin.
    # This parser only attributes a receipt; it grants no permission.
    return re.match(
        r"^\s*tenjin(?:\s+--(?:json|timeout(?:=|\s+)\S+|base-url(?:=|\s+)\S+))*"
        r"\s+publish(?:\s|$)",
        command,
    ) is not None


def _is_dry_run(command: str) -> bool:
    return re.search(r"(?:^|\s)--dry-run(?:\s|$|=)", command) is not None


def _receipt_class(command: str, body: object, is_error: bool) -> str:
    text = _content_text(body)
    envelope = _json_object(text)
    if envelope is not None and isinstance(envelope.get("ok"), bool):
        if envelope["ok"] is True:
            data = envelope.get("data") if isinstance(envelope.get("data"), dict) else {}
            if data.get("dryRun") is True or _is_dry_run(command):
                return "dry_run"
            if data.get("alreadyPublished") is True:
                return "duplicate"
            if isinstance(data.get("resourceId"), str) or isinstance(data.get("url"), str):
                return "published"
            return "unknown"
        error = envelope.get("error") if isinstance(envelope.get("error"), dict) else {}
        code = error.get("code")
        if code == "NEEDS_CONFIRMATION":
            return "needs_confirmation"
        if code == "PUBLISH_BLOCKED":
            return "blocked"
        if code in {"PERMISSION_DENIED", "PERMISSION_REQUIRED"}:
            return "permission_denied"
        if code in {"USAGE", "NOT_FOUND", "CONFIG_INVALID"}:
            return "failed"
        return "unknown"

    lowered = text.lower()
    if _is_dry_run(command) and not is_error:
        return "dry_run"
    if "already published:" in lowered:
        return "duplicate"
    if re.search(r"(?:^|\n)published .+", text, flags=re.IGNORECASE):
        return "published"
    if "needs confirmation" in lowered or "needs_confirmation" in lowered:
        return "needs_confirmation"
    if "publish blocked" in lowered or "publish_blocked" in lowered:
        return "blocked"
    if "permission denied" in lowered or "permission was denied" in lowered:
        return "permission_denied"
    if is_error:
        return "unknown"
    return "unknown"


def _token_usage(event: dict) -> dict[str, int]:
    usage = event.get("usage")
    if not isinstance(usage, dict):
        return {"input": 0, "output": 0, "cacheRead": 0, "cacheCreation": 0}

    def number(*names: str) -> int:
        for name in names:
            value = usage.get(name)
            if isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0:
                return int(value)
        return 0

    return {
        "input": number("input_tokens", "inputTokens"),
        "output": number("output_tokens", "outputTokens"),
        "cacheRead": number("cache_read_input_tokens", "cacheReadInputTokens"),
        "cacheCreation": number(
            "cache_creation_input_tokens", "cacheCreationInputTokens"
        ),
    }


def _assistant_token_usage(event: dict) -> dict[str, int] | None:
    message = event.get("message")
    if not isinstance(message, dict) or not isinstance(message.get("usage"), dict):
        return None
    return _token_usage(message)


def _stop_hook_wall_ms(event: dict) -> int | None:
    """Return only an explicitly attributed Stop-hook duration.

    Arrival deltas around an entire assistant turn are not hook wall time.  A
    duration is accepted only when the stream event structurally names the Stop
    hook and carries a non-negative numeric duration.
    """

    hook = event.get("hook") if isinstance(event.get("hook"), dict) else {}
    names = (
        event.get("hook_name"),
        event.get("hookName"),
        event.get("hook_event"),
        event.get("hookEvent"),
        hook.get("name"),
        hook.get("event"),
    )
    if "Stop" not in names:
        return None
    for owner in (event, hook):
        for key in ("duration_ms", "durationMs"):
            value = owner.get(key)
            if isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0:
                return round(value)
    return None


def observe_installed_stream(
    stream: str, *, line_offsets_ms: list[int] | None = None
) -> dict:
    """Reduce a raw Claude stream to bounded receipt and cost metadata.

    The real session id is returned separately for the caller's completeness
    gate, then deliberately excluded by ``build_controlled_report``.  It remains
    in the redacted executor transcript and Claude's native session archive.
    """

    tools: dict[str, str] = {}
    receipts: list[str] = []
    session_id: str | None = None
    capture_asks = 0
    event_index = 0
    first_capture_ask: int | None = None
    candidate_writes = 0
    premature_writes = 0
    premature_publishes = 0
    publishes_after_ask = 0
    usage = {"input": 0, "output": 0, "cacheRead": 0, "cacheCreation": 0}
    continuation_usage = {"input": 0, "output": 0, "cacheRead": 0, "cacheCreation": 0}
    continuation_usage_events = 0
    first_capture_ask_ms: int | None = None
    publish_latencies_ms: list[int] = []
    stop_hook_wall_ms: list[int] = []

    for event, arrival_ms in _event_objects(stream, line_offsets_ms):
        event_index += 1
        candidate = event.get("session_id")
        if isinstance(candidate, str) and candidate:
            session_id = candidate
        kind = event.get("type")
        if kind in {"system", "user"}:
            rendered = json.dumps(event)
            if CAPTURE_ASK_MARKER in rendered and TEAM_CAPTURE_ASK_MARKER in rendered:
                capture_asks += 1
                if first_capture_ask is None:
                    first_capture_ask = event_index
                    first_capture_ask_ms = arrival_ms
        explicit_hook_wall = _stop_hook_wall_ms(event)
        if explicit_hook_wall is not None:
            stop_hook_wall_ms.append(explicit_hook_wall)
        if kind == "assistant":
            message_usage = _assistant_token_usage(event)
            if first_capture_ask is not None and message_usage is not None:
                continuation_usage_events += 1
                for key in continuation_usage:
                    continuation_usage[key] += message_usage[key]
            for block in event.get("message", {}).get("content", []):
                if not isinstance(block, dict) or block.get("type") != "tool_use":
                    continue
                block_name = block.get("name")
                tool_input = block.get("input") if isinstance(block.get("input"), dict) else {}
                if block_name == "Write":
                    candidate_writes += 1
                    if first_capture_ask is None:
                        premature_writes += 1
                    continue
                if block_name != "Bash" or not isinstance(block.get("id"), str):
                    continue
                command = tool_input.get("command")
                if isinstance(command, str) and _is_publish_command(command):
                    tools[block["id"]] = command
                    if first_capture_ask is None:
                        premature_publishes += 1
                    else:
                        publishes_after_ask += 1
        elif kind == "user":
            for block in event.get("message", {}).get("content", []):
                if not isinstance(block, dict) or block.get("type") != "tool_result":
                    continue
                command = tools.pop(str(block.get("tool_use_id", "")), None)
                if command is not None:
                    receipts.append(
                        _receipt_class(command, block.get("content"), bool(block.get("is_error")))
                    )
                    if first_capture_ask_ms is not None and arrival_ms is not None:
                        publish_latencies_ms.append(max(0, arrival_ms - first_capture_ask_ms))
        elif kind == "result":
            event_usage = _token_usage(event)
            for key in usage:
                usage[key] += event_usage[key]

    # A publish command with no result is exactly the ambiguous class the lane
    # must retain and never automatically retry.
    receipts.extend("unknown" for _ in tools)
    write_attempts = sum(1 for receipt in receipts if receipt != "dry_run")
    return {
        "session_id": session_id,
        "sessionRetained": session_id is not None,
        "captureAskCount": capture_asks,
        "candidateWriteCount": candidate_writes,
        "prematureCandidateWriteCount": premature_writes,
        "prematurePublishCommandCount": premature_publishes,
        "publishAfterCaptureAskCount": publishes_after_ask,
        "captureAskBeforeEveryCandidateWrite": premature_writes == 0,
        "captureAskBeforeEveryPublish": premature_publishes == 0,
        "publishCommandCount": len(receipts),
        "writeAttemptCount": write_attempts,
        "receipts": dict(Counter(receipts)),
        "humanInterventionCount": receipts.count("needs_confirmation"),
        "tokens": usage,
        "stopContinuationTokens": {
            "status": (
                "measured_from_post_ask_assistant_usage"
                if continuation_usage_events > 0
                else "unavailable_no_post_ask_assistant_usage"
            ),
            "usageEvents": continuation_usage_events,
            "tokens": continuation_usage,
        },
        "publishLatencyMs": publish_latencies_ms,
        "stopHookWallMs": stop_hook_wall_ms,
    }


def _percentile95(values: list[int]) -> int | None:
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(0, math.ceil(len(ordered) * 0.95) - 1)]


def _fixture_metadata(
    eval_set: Path, cases: list[dict], controlled: dict
) -> tuple[dict, dict[int, dict]]:
    directory = eval_set.resolve().parent
    labels_path = directory / "labels.json"
    evaluator_path = directory / "evaluator.json"
    manifest_path = directory / "manifest.json"
    questions_path = directory / "questions.json"
    required = (labels_path, evaluator_path, manifest_path, questions_path)
    if not all(path.exists() for path in required):
        raise InstalledHooksPreflightError(
            "controlled fixture must include manifest, labels, questions, and evaluator"
        )
    try:
        labels = json.loads(labels_path.read_text(encoding="utf-8"))
        evaluator = json.loads(evaluator_path.read_text(encoding="utf-8"))
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        raise InstalledHooksPreflightError("controlled frozen input JSON is invalid") from None
    by_eval = {
        int(label["evalId"]): label
        for label in labels.get("labels", [])
        if isinstance(label, dict) and isinstance(label.get("evalId"), int)
    }
    missing = [case["id"] for case in cases if case["id"] not in by_eval]
    if missing:
        raise InstalledHooksPreflightError(
            "frozen labels do not cover every selected installed-hooks case"
        )
    return (
        {
            "benchmark": labels.get("benchmark", "output-eval"),
            "evaluatorVersion": evaluator.get(
                "evaluatorVersion", labels.get("evaluatorVersion", "unknown")
            ),
            "fixtureRole": controlled["fixtureRole"],
            "benchmarkStatus": controlled.get("benchmarkStatus"),
            "frozenInputs": {
                "manifestSha256": _file_sha256(manifest_path),
                "labelsSha256": _file_sha256(labels_path),
                "questionsSha256": _file_sha256(questions_path),
                "evaluatorSha256": _file_sha256(evaluator_path),
                "controlledDeclarationSha256": controlled[
                    "controlledDeclarationSha256"
                ],
                "manifestCasesSha256": manifest.get("casesSha256"),
                "selectedCaseIds": controlled["selectedCaseIds"],
                "selectedCasesSha256": controlled["selectedCasesSha256"],
            },
        },
        by_eval,
    )


def _observation_totals(history: list[dict]) -> dict:
    receipts: Counter[str] = Counter()
    tokens = {"input": 0, "output": 0, "cacheRead": 0, "cacheCreation": 0}
    wall: list[int] = []
    publish_latency: list[int] = []
    stop_hook_wall: list[int] = []
    continuation_tokens = {"input": 0, "output": 0, "cacheRead": 0, "cacheCreation": 0}
    continuation_measured_runs = continuation_unavailable_runs = 0
    asks = commands = writes = candidate_writes = interventions = sessions = 0
    premature_candidate_writes = premature_publishes = publishes_after_ask = 0
    for attempt in history:
        observation = attempt.get("installed")
        if not isinstance(observation, dict):
            continue
        asks += int(observation.get("captureAskCount", 0))
        commands += int(observation.get("publishCommandCount", 0))
        writes += int(observation.get("writeAttemptCount", 0))
        candidate_writes += int(observation.get("candidateWriteCount", 0))
        premature_candidate_writes += int(
            observation.get("prematureCandidateWriteCount", 0)
        )
        premature_publishes += int(observation.get("prematurePublishCommandCount", 0))
        publishes_after_ask += int(observation.get("publishAfterCaptureAskCount", 0))
        interventions += int(observation.get("humanInterventionCount", 0))
        sessions += int(observation.get("sessionRetained") is True)
        receipts.update(
            {
                key: int(value)
                for key, value in observation.get("receipts", {}).items()
                if key in RECEIPT_CLASSES and isinstance(value, int) and value >= 0
            }
        )
        attempt_tokens = observation.get("tokens", {})
        for key in tokens:
            value = attempt_tokens.get(key, 0) if isinstance(attempt_tokens, dict) else 0
            tokens[key] += int(value) if isinstance(value, int) and value >= 0 else 0
        continuation = observation.get("stopContinuationTokens", {})
        if (
            isinstance(continuation, dict)
            and continuation.get("status") == "measured_from_post_ask_assistant_usage"
        ):
            continuation_measured_runs += 1
            measured_tokens = continuation.get("tokens", {})
            for key in continuation_tokens:
                value = measured_tokens.get(key, 0) if isinstance(measured_tokens, dict) else 0
                continuation_tokens[key] += (
                    int(value) if isinstance(value, int) and value >= 0 else 0
                )
        else:
            continuation_unavailable_runs += 1
        for value in observation.get("publishLatencyMs", []):
            if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
                publish_latency.append(value)
        for value in observation.get("stopHookWallMs", []):
            if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
                stop_hook_wall.append(value)
        elapsed = attempt.get("wall_time_ms")
        if isinstance(elapsed, int) and elapsed >= 0:
            wall.append(elapsed)
    return {
        "attempts": len(history),
        "captureAskCount": asks,
        "publishCommandCount": commands,
        "writeAttemptCount": writes,
        "candidateWriteCount": candidate_writes,
        "prematureCandidateWriteCount": premature_candidate_writes,
        "prematurePublishCommandCount": premature_publishes,
        "publishAfterCaptureAskCount": publishes_after_ask,
        "humanInterventionCount": interventions,
        "sessionsRetained": sessions,
        "receipts": {key: receipts.get(key, 0) for key in RECEIPT_CLASSES},
        "tokens": tokens,
        "continuationTokens": continuation_tokens,
        "continuationMeasuredRuns": continuation_measured_runs,
        "continuationUnavailableRuns": continuation_unavailable_runs,
        "publishLatencyMs": publish_latency,
        "stopHookWallMs": stop_hook_wall,
        "wall": wall,
        "costUsd": round(sum(float(item.get("cost_usd", 0.0)) for item in history), 4),
    }


def build_controlled_report(
    *,
    eval_set: Path,
    cases: list[dict],
    runs: dict[tuple[int, bool], dict],
    graded: dict[tuple[int, bool], dict],
    preflight: dict,
    source: dict,
    parity: dict,
    controlled: dict,
    skill: str,
    model: str,
    grader_model: str,
) -> dict:
    """Build the only artifact the installed lane emits: a thin aggregation."""

    fixture, labels = _fixture_metadata(eval_set, cases, controlled)
    grade_totals = Counter({"pass": 0, "fail": 0, "ungraded": 0})
    receipts: Counter[str] = Counter()
    tokens = {"input": 0, "output": 0, "cacheRead": 0, "cacheCreation": 0}
    wall: list[int] = []
    publish_latency: list[int] = []
    stop_hook_wall: list[int] = []
    continuation_tokens = {"input": 0, "output": 0, "cacheRead": 0, "cacheCreation": 0}
    continuation_measured_runs = continuation_unavailable_runs = 0
    attempts = asks = commands = writes = candidate_writes = interventions = sessions = 0
    premature_candidate_writes = premature_publishes = publishes_after_ask = 0
    cost = 0.0
    asked_cases = published_cases = duplicate_cases = unknown_cases = 0
    published_expected = 0
    false_publications: Counter[str] = Counter()
    dispositions: dict[str, dict] = {}
    retry_after_unknown = 0

    for case in cases:
        run = runs[(case["id"], True)]
        history = run.get("history", [run])
        observed = _observation_totals(history)
        case_receipts = observed["receipts"]
        label = labels.get(case["id"], {})
        disposition = str(label.get("expectedDisposition", "unlabeled"))
        stratum = str(label.get("stratum", "unlabeled"))
        group = dispositions.setdefault(
            disposition,
            {
                "cases": 0,
                "captureAskedCases": 0,
                "publishedCases": 0,
                "writeAttemptCases": 0,
                "grades": {"pass": 0, "fail": 0, "ungraded": 0},
            },
        )
        group["cases"] += 1
        group["captureAskedCases"] += int(observed["captureAskCount"] > 0)
        group["publishedCases"] += int(case_receipts["published"] > 0)
        group["writeAttemptCases"] += int(observed["writeAttemptCount"] > 0)

        case_grades = graded[(case["id"], True)].get("grades", [])
        for grade in case_grades:
            value = grade.get("grade")
            if value in grade_totals:
                grade_totals[value] += 1
                group["grades"][value] += 1

        attempts += observed["attempts"]
        asks += observed["captureAskCount"]
        commands += observed["publishCommandCount"]
        writes += observed["writeAttemptCount"]
        candidate_writes += observed["candidateWriteCount"]
        premature_candidate_writes += observed["prematureCandidateWriteCount"]
        premature_publishes += observed["prematurePublishCommandCount"]
        publishes_after_ask += observed["publishAfterCaptureAskCount"]
        interventions += observed["humanInterventionCount"]
        sessions += observed["sessionsRetained"]
        cost += observed["costUsd"]
        wall.extend(observed["wall"])
        publish_latency.extend(observed["publishLatencyMs"])
        stop_hook_wall.extend(observed["stopHookWallMs"])
        continuation_measured_runs += observed["continuationMeasuredRuns"]
        continuation_unavailable_runs += observed["continuationUnavailableRuns"]
        receipts.update(case_receipts)
        for key in tokens:
            tokens[key] += observed["tokens"][key]
            continuation_tokens[key] += observed["continuationTokens"][key]
        asked_cases += int(observed["captureAskCount"] > 0)
        published = case_receipts["published"] > 0
        published_cases += int(published)
        duplicate_cases += int(case_receipts["duplicate"] > 0)
        unknown_cases += int(case_receipts["unknown"] > 0)
        if published:
            if disposition == "publish":
                published_expected += 1
            else:
                false_publications[stratum] += 1

        for previous in history[:-1]:
            previous_receipts = previous.get("installed", {}).get("receipts", {})
            if isinstance(previous_receipts, dict) and previous_receipts.get("unknown", 0) > 0:
                retry_after_unknown += 1

    expectations = sum(grade_totals.values())
    report = {
        "schemaVersion": 2,
        **fixture,
        "lane": "installed_hooks_controlled_publication",
        "status": (
            "complete" if controlled["fixtureRole"] == "held_out_archive" else "smoke_complete"
        ),
        "skill": skill,
        "model": model,
        "graderModel": grader_model,
        "source": source,
        "installedParity": parity,
        "preflight": _public_installed_preflight(preflight),
        "benchmarkCompleteness": {
            "fullDeclaredSubset": True,
            "heldOutArchive": controlled["fixtureRole"] == "held_out_archive",
        },
        "denominators": {
            "labeledSessions": len(cases),
            "executorAttempts": attempts,
            "gradedExpectations": expectations,
        },
        "grading": {
            **dict(grade_totals),
            "passRate": None if expectations == 0 else round(grade_totals["pass"] / expectations, 3),
        },
        "capture": {
            "asks": asks,
            "askedSessions": asked_cases,
            "sessionsRetained": sessions,
        },
        "publication": {
            "commands": commands,
            "writeAttempts": writes,
            "candidateWrites": candidate_writes,
            "publishedSessions": published_cases,
            "duplicateSessions": duplicate_cases,
            "unknownWriteSessions": unknown_cases,
            "humanInterventions": interventions,
            "receiptClasses": {key: receipts.get(key, 0) for key in RECEIPT_CLASSES},
            "precision": {
                "numerator": published_expected,
                "denominator": published_cases,
                "rate": None
                if published_cases == 0
                else round(published_expected / published_cases, 3),
            },
            "falsePublicationsByStratum": dict(sorted(false_publications.items())),
            "automaticRetriesAfterUnknownWrite": retry_after_unknown,
        },
        "chronology": {
            "captureAskBeforeEveryCandidateWrite": premature_candidate_writes == 0,
            "captureAskBeforeEveryPublish": premature_publishes == 0,
            "prematureCandidateWrites": premature_candidate_writes,
            "prematurePublishCommands": premature_publishes,
            "publishCommandsAfterCaptureAsk": publishes_after_ask,
        },
        "execution": {
            "executorCostUsd": round(cost, 4),
            "wholeClaudeTurnWallTimeMs": {
                "runs": len(wall),
                "total": sum(wall),
                "mean": None if not wall else round(sum(wall) / len(wall), 1),
                "p95": _percentile95(wall),
            },
            "wholeClaudeTurnTokens": tokens,
            "publishLatency": {
                "status": (
                    "measured_capture_ask_to_publish_receipt"
                    if publish_latency
                    else "unavailable_no_publish_receipt"
                ),
                "samples": len(publish_latency),
                "totalMs": sum(publish_latency),
                "meanMs": (
                    None
                    if not publish_latency
                    else round(sum(publish_latency) / len(publish_latency), 1)
                ),
                "p95Ms": _percentile95(publish_latency),
            },
            "additionalHookWallTime": {
                "status": (
                    "measured_explicit_stop_hook_duration"
                    if stop_hook_wall
                    else "unavailable_no_explicit_stop_hook_duration"
                ),
                "samples": len(stop_hook_wall),
                "totalMs": sum(stop_hook_wall),
                "meanMs": (
                    None
                    if not stop_hook_wall
                    else round(sum(stop_hook_wall) / len(stop_hook_wall), 1)
                ),
                "p95Ms": _percentile95(stop_hook_wall),
            },
            "stopContinuationCost": {
                "status": "unavailable_stream_has_no_per_message_cost"
            },
            "stopContinuationTokens": {
                "status": (
                    "measured_from_post_ask_assistant_usage"
                    if continuation_measured_runs > 0 and continuation_unavailable_runs == 0
                    else (
                        "partial_post_ask_assistant_usage"
                        if continuation_measured_runs > 0
                        else "unavailable_no_post_ask_assistant_usage"
                    )
                ),
                "measuredRuns": continuation_measured_runs,
                "unavailableRuns": continuation_unavailable_runs,
                "tokens": continuation_tokens,
            },
        },
        "expectedDispositions": dispositions,
        "consumerUseLane": {
            "status": "blocked_not_run",
            "blocker": CONSUMER_USE_BLOCKER,
            "zeroPublicTrafficRequired": True,
        },
    }
    assert_thin_report(report)
    return report


def build_invalid_controlled_report(*, broken: list[dict], runs: dict, preflight: dict) -> dict:
    """Operational safety facts for an invalid run, never a scored benchmark."""

    faults = Counter()
    unknown_writes = 0
    write_attempts = 0
    for entry in broken:
        for key in ("executor", "evidence", "grading"):
            if entry.get(key) is not None:
                faults[key] += 1
    for run in runs.values():
        observed = _observation_totals(run.get("history", [run]))
        unknown_writes += observed["receipts"]["unknown"]
        write_attempts += observed["writeAttemptCount"]
    report = {
        "schemaVersion": 1,
        "lane": "installed_hooks_controlled_publication",
        "status": "invalid",
        "benchmarkAggregated": False,
        "preflight": _public_installed_preflight(preflight),
        "unusableConfigurations": {
            "count": len(broken),
            "faults": {key: faults.get(key, 0) for key in ("executor", "evidence", "grading")},
        },
        "writeSafety": {"writeAttempts": write_attempts, "unknownReceipts": unknown_writes},
    }
    assert_thin_report(report)
    return report


def assert_thin_report(report: dict) -> None:
    """Fail closed on content fields *and* undeclared aggregate schema growth."""

    def walk(value: object, path: str = "report") -> None:
        if isinstance(value, list):
            for index, item in enumerate(value):
                walk(item, f"{path}[{index}]")
            return
        if not isinstance(value, dict):
            return
        for key, child in value.items():
            if key in FORBIDDEN_REPORT_KEYS:
                raise ValueError(f"controlled report contains forbidden field {path}.{key}")
            walk(child, f"{path}.{key}")

    walk(report)

    def exact(value: object, keys: set[str], path: str) -> dict:
        if not isinstance(value, dict) or set(value) != keys:
            raise ValueError(f"controlled report shape drifted at {path}")
        return value

    status = report.get("status")
    if status == "invalid":
        exact(
            report,
            {
                "schemaVersion",
                "lane",
                "status",
                "benchmarkAggregated",
                "preflight",
                "unusableConfigurations",
                "writeSafety",
            },
            "report",
        )
        exact(
            report["unusableConfigurations"], {"count", "faults"}, "unusableConfigurations"
        )
        exact(report["writeSafety"], {"writeAttempts", "unknownReceipts"}, "writeSafety")
        return
    if status not in {"complete", "smoke_complete"}:
        raise ValueError("controlled report has an unknown status")
    if report.get("schemaVersion") != 2:
        raise ValueError("controlled report schemaVersion drifted")
    exact(
        report,
        {
            "schemaVersion",
            "benchmark",
            "evaluatorVersion",
            "fixtureRole",
            "benchmarkStatus",
            "frozenInputs",
            "lane",
            "status",
            "skill",
            "model",
            "graderModel",
            "source",
            "installedParity",
            "preflight",
            "benchmarkCompleteness",
            "denominators",
            "grading",
            "capture",
            "publication",
            "chronology",
            "execution",
            "expectedDispositions",
            "consumerUseLane",
        },
        "report",
    )
    exact(report["source"], {"commit", "commitDate"}, "source")
    exact(
        report["installedParity"],
        {
            "sourceCommit",
            "hooksMatchPinnedGenerator",
            "installedSkillBytesCurrent",
            "normalizedHookBundleSha256",
            "scriptCount",
        },
        "installedParity",
    )
    if (
        report["installedParity"]["hooksMatchPinnedGenerator"] is not True
        or report["installedParity"]["installedSkillBytesCurrent"] is not True
        or report["installedParity"]["sourceCommit"] != report["source"]["commit"]
    ):
        raise ValueError("controlled report parity is incomplete")
    exact(
        report["frozenInputs"],
        {
            "manifestSha256",
            "labelsSha256",
            "questionsSha256",
            "evaluatorSha256",
            "controlledDeclarationSha256",
            "manifestCasesSha256",
            "selectedCaseIds",
            "selectedCasesSha256",
        },
        "frozenInputs",
    )
    selected = report["frozenInputs"]["selectedCaseIds"]
    if (
        not isinstance(selected, list)
        or any(not isinstance(item, int) or isinstance(item, bool) for item in selected)
        or len(selected) != len(set(selected))
    ):
        raise ValueError("controlled report selected IDs are not a unique integer list")
    exact(
        report["preflight"],
        {
            "doctor",
            "teamShelfConfigured",
            "publishMode",
            "hooks",
            "claudePushHookEntries",
            "stopHookEntryExact",
            "installedHookSetSha256",
            "installedHookScriptCount",
            "installedSkillBytesCurrent",
            "scriptsWired",
            "tenjinDataDirInherited",
            "publishModeEnvironmentInherited",
        },
        "preflight",
    )
    exact(report["preflight"]["publishMode"], {"value", "source"}, "preflight.publishMode")
    exact(report["preflight"]["hooks"], {"push", "capture", "webSearch"}, "preflight.hooks")
    exact(
        report["preflight"]["hooks"]["webSearch"],
        {"value", "source"},
        "preflight.hooks.webSearch",
    )
    exact(
        report["preflight"]["claudePushHookEntries"],
        {"present", "planned", "identitiesExact"},
        "preflight.claudePushHookEntries",
    )
    if (
        report["preflight"]["doctor"] != "pass"
        or report["preflight"]["teamShelfConfigured"] is not True
        or report["preflight"]["publishMode"]["value"] != "auto"
        or report["preflight"]["hooks"]["push"] != "on"
        or report["preflight"]["hooks"]["capture"] != "block"
        or report["preflight"]["hooks"]["webSearch"]["value"] != "auto"
        or report["preflight"]["claudePushHookEntries"]
        != {"present": 7, "planned": 7, "identitiesExact": True}
        or report["preflight"]["stopHookEntryExact"] is not True
        or report["preflight"]["installedHookScriptCount"] != 8
        or report["preflight"]["installedSkillBytesCurrent"] is not True
        or report["preflight"]["scriptsWired"] is not True
    ):
        raise ValueError("controlled report installed preflight is not safe")
    exact(
        report["benchmarkCompleteness"],
        {"fullDeclaredSubset", "heldOutArchive"},
        "benchmarkCompleteness",
    )
    exact(
        report["denominators"],
        {"labeledSessions", "executorAttempts", "gradedExpectations"},
        "denominators",
    )
    exact(report["grading"], {"pass", "fail", "ungraded", "passRate"}, "grading")
    exact(report["capture"], {"asks", "askedSessions", "sessionsRetained"}, "capture")
    publication = exact(
        report["publication"],
        {
            "commands",
            "writeAttempts",
            "candidateWrites",
            "publishedSessions",
            "duplicateSessions",
            "unknownWriteSessions",
            "humanInterventions",
            "receiptClasses",
            "precision",
            "falsePublicationsByStratum",
            "automaticRetriesAfterUnknownWrite",
        },
        "publication",
    )
    exact(publication["receiptClasses"], set(RECEIPT_CLASSES), "publication.receiptClasses")
    exact(publication["precision"], {"numerator", "denominator", "rate"}, "publication.precision")
    if not isinstance(publication["falsePublicationsByStratum"], dict) or any(
        not isinstance(value, int) or value < 0
        for value in publication["falsePublicationsByStratum"].values()
    ):
        raise ValueError("controlled report false-publication strata are invalid")
    exact(
        report["chronology"],
        {
            "captureAskBeforeEveryCandidateWrite",
            "captureAskBeforeEveryPublish",
            "prematureCandidateWrites",
            "prematurePublishCommands",
            "publishCommandsAfterCaptureAsk",
        },
        "chronology",
    )
    execution = exact(
        report["execution"],
        {
            "executorCostUsd",
            "wholeClaudeTurnWallTimeMs",
            "wholeClaudeTurnTokens",
            "publishLatency",
            "additionalHookWallTime",
            "stopContinuationCost",
            "stopContinuationTokens",
        },
        "execution",
    )
    exact(
        execution["wholeClaudeTurnWallTimeMs"],
        {"runs", "total", "mean", "p95"},
        "execution.wholeClaudeTurnWallTimeMs",
    )
    exact(
        execution["wholeClaudeTurnTokens"],
        {"input", "output", "cacheRead", "cacheCreation"},
        "execution.wholeClaudeTurnTokens",
    )
    for key in ("publishLatency", "additionalHookWallTime"):
        exact(
            execution[key],
            {"status", "samples", "totalMs", "meanMs", "p95Ms"},
            f"execution.{key}",
        )
    exact(execution["stopContinuationCost"], {"status"}, "execution.stopContinuationCost")
    exact(
        execution["stopContinuationTokens"],
        {"status", "measuredRuns", "unavailableRuns", "tokens"},
        "execution.stopContinuationTokens",
    )
    exact(
        execution["stopContinuationTokens"]["tokens"],
        {"input", "output", "cacheRead", "cacheCreation"},
        "execution.stopContinuationTokens.tokens",
    )
    if not isinstance(report["expectedDispositions"], dict):
        raise ValueError("controlled report expectedDispositions is not an object")
    for name, group in report["expectedDispositions"].items():
        if not isinstance(name, str):
            raise ValueError("controlled report disposition name is invalid")
        exact(
            group,
            {"cases", "captureAskedCases", "publishedCases", "writeAttemptCases", "grades"},
            f"expectedDispositions.{name}",
        )
        exact(group["grades"], {"pass", "fail", "ungraded"}, f"expectedDispositions.{name}.grades")
    exact(
        report["consumerUseLane"],
        {"status", "blocker", "zeroPublicTrafficRequired"},
        "consumerUseLane",
    )
    if report["consumerUseLane"] != {
        "status": "blocked_not_run",
        "blocker": CONSUMER_USE_BLOCKER,
        "zeroPublicTrafficRequired": True,
    }:
        raise ValueError("controlled report consumer-use blocker drifted")


def assert_consumer_report(report: dict) -> None:
    """Validate the consumer lane's content-free, blocked/not-run artifact."""

    def exact(value: object, keys: set[str], path: str) -> dict:
        if not isinstance(value, dict) or set(value) != keys:
            raise ValueError(f"consumer report shape drifted at {path}")
        return value

    def walk(value: object, path: str = "report") -> None:
        if isinstance(value, list):
            for index, item in enumerate(value):
                walk(item, f"{path}[{index}]")
        elif isinstance(value, dict):
            for key, child in value.items():
                if key in FORBIDDEN_REPORT_KEYS:
                    raise ValueError(f"consumer report contains forbidden field {path}.{key}")
                walk(child, f"{path}.{key}")

    walk(report)
    exact(
        report,
        {
            "schemaVersion",
            "benchmark",
            "evaluatorVersion",
            "fixtureRole",
            "lane",
            "status",
            "blocker",
            "source",
            "installedParity",
            "preflight",
            "frozenInputs",
            "fullQuestionSet",
            "networkSafety",
            "outcomes",
        },
        "report",
    )
    if (
        report.get("schemaVersion") != 1
        or report.get("status") != "blocked_not_run"
        or report.get("blocker") != CONSUMER_USE_BLOCKER
    ):
        raise ValueError("consumer report status drifted")
    exact(report["source"], {"commit", "commitDate"}, "source")
    parity = exact(
        report["installedParity"],
        {
            "sourceCommit",
            "hooksMatchPinnedGenerator",
            "installedSkillBytesCurrent",
            "normalizedHookBundleSha256",
            "scriptCount",
        },
        "installedParity",
    )
    if (
        parity["sourceCommit"] != report["source"]["commit"]
        or parity["hooksMatchPinnedGenerator"] is not True
        or parity["installedSkillBytesCurrent"] is not True
    ):
        raise ValueError("consumer report parity is incomplete")
    exact(
        report["preflight"],
        {
            "doctor",
            "teamShelfConfigured",
            "publishMode",
            "hooks",
            "claudePushHookEntries",
            "stopHookEntryExact",
            "installedHookSetSha256",
            "installedHookScriptCount",
            "installedSkillBytesCurrent",
            "scriptsWired",
            "tenjinDataDirInherited",
            "publishModeEnvironmentInherited",
        },
        "preflight",
    )
    installed = report["preflight"]
    exact(installed["publishMode"], {"value", "source"}, "preflight.publishMode")
    exact(installed["hooks"], {"push", "capture", "webSearch"}, "preflight.hooks")
    exact(
        installed["hooks"]["webSearch"],
        {"value", "source"},
        "preflight.hooks.webSearch",
    )
    exact(
        installed["claudePushHookEntries"],
        {"present", "planned", "identitiesExact"},
        "preflight.claudePushHookEntries",
    )
    if (
        installed["doctor"] != "pass"
        or installed["teamShelfConfigured"] is not True
        or installed["publishMode"]["value"] != "auto"
        or installed["hooks"].get("push") != "on"
        or installed["hooks"].get("capture") != "block"
        or installed["hooks"].get("webSearch", {}).get("value") != "auto"
        or installed["claudePushHookEntries"]
        != {"present": 7, "planned": 7, "identitiesExact": True}
        or installed["stopHookEntryExact"] is not True
        or installed["installedHookScriptCount"] != 8
        or installed["installedSkillBytesCurrent"] is not True
        or installed["scriptsWired"] is not True
    ):
        raise ValueError("consumer report installed preflight is not safe")
    exact(
        report["frozenInputs"],
        {
            "manifestSha256",
            "labelsSha256",
            "questionsSha256",
            "evaluatorSha256",
            "manifestCasesSha256",
            "questionIdsSha256",
        },
        "frozenInputs",
    )
    full = exact(
        report["fullQuestionSet"],
        {
            "complete",
            "cases",
            "concepts",
            "naturalQuestions",
            "distractors",
            "totalQuestions",
        },
        "fullQuestionSet",
    )
    if full["complete"] is not True or full["totalQuestions"] != (
        full["naturalQuestions"] + full["distractors"]
    ):
        raise ValueError("consumer report does not bind the full question set")
    network = exact(
        report["networkSafety"],
        {"publicRequestsMaximum", "publicRequestsObserved", "status"},
        "networkSafety",
    )
    if network != {
        "publicRequestsMaximum": 0,
        "publicRequestsObserved": None,
        "status": "not_run",
    }:
        raise ValueError("consumer report network status drifted")
    outcomes = exact(
        report["outcomes"],
        {"used", "rejected", "unobserved", "ungraded", "posted", "coverage"},
        "outcomes",
    )
    if any(value is not None for value in outcomes.values()):
        raise ValueError("blocked consumer report invented outcomes")
