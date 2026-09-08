"""The live Claude Code executor: one code-owned argv, no shell, no operator environment.

This is the first spec in the registry that starts a real agent, so everything
it touches is written to be provable offline. The flags are literals in this
module; the manifest supplies values only, and each value is checked against a
declared allowlist of shapes before it becomes an argument. No value this
module turns into an argument reaches a shell: `runner.process_spawn` runs the
list with `shell=False`, and a value that could be read as a flag is refused
rather than quoted.

One exception is named rather than hidden: an arm's `settings.hooks` commands
are strings Claude Code itself runs through a shell in the child. That is what
a hooks arm is, the `settings_hash` in every record names them, and the
container the attestation describes is what contains them. This module checks
their shape; it does not pretend they are data. Everything else the fragment
may carry is constrained, because `settings.env` and `settings.permissions`
would otherwise reopen exactly the pins the flags above set.

Three facts about Claude Code 2.1.263 shape the design:

- `--session-id` takes a UUID the caller chooses, so the root session id is
  minted from the trial id before launch. A resumed schedule re-derives the
  same id instead of reading one back out of a stream.
- session persistence must stay on. A live trial's usage lives in the
  persisted transcripts, and a child agent's usage exists nowhere else, so the
  runner reads the transcript directory rather than a stream.
- the transcript tree hangs off `CLAUDE_CONFIG_DIR`, not off `HOME`. The CLI
  builds it as `configDir/projects/<name>`, where `configDir` is
  `CLAUDE_CONFIG_DIR` when set and `HOME/.claude` otherwise, and `<name>` is
  `CLAUDE_CODE_PROJECT_DIR_NAME` when both variables are set and the cwd slug
  otherwise. A trial sets both, so `sessions_dir` names one directory instead
  of guessing.

`artifact.require_isolation` still owns the refusals that cost money: a live
executor is refused in CI, a publishable live run without an isolation
attestation is refused before any spend, and an attestation whose credential
seam is not the variable this executor passes is refused too.
"""

from __future__ import annotations

import dataclasses
import json
import os
import re
import uuid
from pathlib import Path
from typing import Any, Mapping

from urllib.parse import urlsplit

from . import artifact, sha256_json, tenjin_arm, toolchain, verifier
from .discovery import SETUP_PATH
from .executor import REGISTRY, ExecutorError, ExecutorSpec, Launch, LaunchRequest, Provision, ProvisionRequest

NAME = "claude_live"
HARNESS = "claude"
CLI = "claude"
# The provider origin the attestation's network allowlist has to name, or the
# run is refused before it starts.
REQUIRED_ORIGINS = ("api.anthropic.com",)

# Fixed namespace, so a trial id maps to the same session id on every machine
# and in every process. uuid5 is defined by the standard, not by this package.
SESSION_NAMESPACE = uuid.uuid5(uuid.NAMESPACE_URL, "https://github.com/BackTrackCo/tenjin-agent/evals/benchmark")

# Declared allowlists. A manifest value outside one of these is a refusal, not
# a quoted argument.
TOOLS = frozenset(
    {"Bash", "Read", "Edit", "Write", "Glob", "Grep", "Agent", "Task", "TodoWrite", "WebFetch", "WebSearch", "NotebookEdit"}
)
# `bypassPermissions` is deliberately absent: a benchmark arm that needs the
# mode which turns the permission system off is not a treatment difference,
# and an allowlist whose widest member is unbounded is not a ceiling.
PERMISSION_MODES = frozenset({"default", "acceptEdits", "dontAsk", "plan"})
# The seam that carries the model credential into the trial. Nothing else from
# the operator's environment crosses.
CREDENTIAL_ENVS = frozenset({"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"})
DEFAULT_CREDENTIAL_ENV = "ANTHROPIC_API_KEY"
# An arm is a settings difference. These are the settings keys a benchmark arm
# may state; anything else would change the harness rather than the treatment.
SETTINGS_KEYS = frozenset({"env", "hooks", "permissions", "overlay"})
# A fixture overlay: files an arm writes into the trial's repository copy before
# the agent starts (a vitest config that wires the product's reporter). Paths
# are relative and inside the repository; the one placeholder is `{data_dir}`,
# where the seeded hooks live. Hashed with the rest of the settings template.
OVERLAY_FILE_LIMIT = 16_000
OVERLAY_PLACEHOLDERS = frozenset({"data_dir"})
# Inside `permissions`: rules that narrow, plus a default mode that has to
# agree with the pinned one. `additionalDirectories` is absent on purpose,
# because it widens the filesystem past the trial's own roots.
PERMISSION_KEYS = frozenset({"allow", "ask", "deny", "defaultMode"})
HOOK_EVENTS = frozenset(
    {
        "PreToolUse",
        "PostToolUse",
        "UserPromptSubmit",
        "Notification",
        "Stop",
        "SubagentStart",
        "SubagentStop",
        "SessionStart",
        "SessionEnd",
        "PreCompact",
        "PostToolUseFailure",
    }
)
HOOK_ENTRY_KEYS = frozenset({"matcher", "hooks"})
COMMAND_HOOK_KEYS = frozenset({"type", "command", "timeout"})
# An `http` hook is a POST from the CLI to a URL. The only URL an arm may name
# is a loopback one: the product's own daemon on this machine, which the
# provisioning seam starts per trial. Any other host is refused.
HTTP_HOOK_KEYS = frozenset({"type", "url", "headers", "timeout"})
LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost"})
HTTP_HEADER_LIMIT = 512
# The values a provisioned arm's settings template resolves to, per trial.
# `settings_hash` is over the template, so it names the treatment once; the
# resolved fragment's hash goes under the record's private hashes.
PLACEHOLDER = re.compile(r"\{(" + "|".join(tenjin_arm.PLACEHOLDERS) + r")\}")
# The variables the CLI genuinely needs that only the parent can supply.
INHERITED = ("PATH", "TERM", "LANG")
# Variables the trial's own roots own, or that would move the model traffic,
# the config directory, or the process loader. An arm names its treatment with
# its own variables; it does not reach these through `settings.env`.
RESERVED_ENV_PREFIXES = ("ANTHROPIC_", "AWS_", "CLAUDE_", "COREPACK_", "DYLD_", "GITHUB_", "LD_", "NODE_", "TENJIN_")
RESERVED_ENV_NAMES = frozenset({"HOME", "PATH", "TERM", "LANG", "SHELL", "PYTHONPATH", artifact.PUBLIC_ORIGIN_VAR})

# `\Z` rather than `$`: in Python `$` also matches before a trailing newline,
# so `$` would let `claude-fable-5-1\n` through as a model id.
MODEL = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}\Z")
# `Name` or `Name(pattern)`, which is the permission syntax Claude Code reads.
# The pattern alphabet excludes the shell metacharacters outright, so a rule
# cannot smuggle one even though no shell ever sees it.
ALLOWED_TOOL = re.compile(r"^(?P<name>[A-Za-z]{1,32})(\((?P<pattern>[A-Za-z0-9 ./*:_-]{1,64})\))?\Z")
ENV_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}\Z")
# The CLI's own validator for `CLAUDE_CODE_PROJECT_DIR_NAME`.
PROJECT_DIR_NAME = re.compile(r"^[A-Za-z0-9_-]{1,64}\Z")
PROJECT_DIR_VAR = "CLAUDE_CODE_PROJECT_DIR_NAME"
# The CLI truncates a slug longer than this and appends a hash this module
# cannot re-derive, which is one reason the trial pins the directory name.
SLUG_LIMIT = 200
PROMPT_LIMIT = 4000
HOOK_COMMAND_LIMIT = 512
# A per-attempt ceiling on `--max-budget-usd`. A manifest that asks for more
# than this is refused: a typo in a pin is otherwise a spend event.
BUDGET_CEILING_USD = 25.0
SETTINGS_FILE = "settings.json"
# `--setting-sources project` is an instruction to read `<cwd>/.claude`. The
# arm's fragment is the only settings channel a record can name, so a fixture
# carrying that directory is refused rather than silently obeyed.
PROJECT_SETTINGS_DIR = ".claude"


class LiveExecutorError(ExecutorError):
    pass


def root_session_id(trial_id: str, phase: str | None = None) -> str:
    """A real UUID, derived from the trial id and the phase, stable across resume."""
    return str(uuid.uuid5(SESSION_NAMESPACE, trial_id if phase is None else f"{trial_id}:{phase}"))


def project_slug(cwd: Path) -> str:
    """Claude Code's own directory slug: every character outside [A-Za-z0-9] becomes '-'."""
    return re.sub(r"[^A-Za-z0-9]", "-", str(cwd))


def project_dir_name(root_session_id: str) -> str:
    """The transcript directory name the trial pins, instead of the cwd slug.

    Claude Code reads `CLAUDE_CODE_PROJECT_DIR_NAME` when `CLAUDE_CONFIG_DIR`
    is set, which a trial always sets. Pinning it makes the directory a
    function of the trial rather than of how deep the run directory happens to
    be, and it is the same value on resume.
    """
    if not PROJECT_DIR_NAME.match(root_session_id):
        raise LiveExecutorError(f"{root_session_id!r} is not a usable project directory name")
    return root_session_id


def working_dir(roots: artifact.TrialRoots) -> Path:
    """The resolved worktree. The slug has to match the cwd the CLI actually sees."""
    return roots.repo.resolve()


def fallback_slug(roots: artifact.TrialRoots) -> str | None:
    """The cwd slug directory name, when the CLI would write one it can name.

    Past `SLUG_LIMIT` the CLI truncates the slug and appends a hash of the
    path that this module cannot re-derive, so there is no second name to look
    for and the pinned one is the only answer.
    """
    slug = project_slug(working_dir(roots))
    return None if len(slug) > SLUG_LIMIT else slug


def sessions_dir(roots: artifact.TrialRoots, root_session_id: str) -> Path:
    """The real transcript directory, under the trial's own `CLAUDE_CONFIG_DIR`.

    The CLI builds `configDir/projects/<name>`, and the trial's config dir is
    its profile root, not its home. `<name>` is the pinned project directory
    name; `fallback_slug` is the fallback for a CLI that does not read the
    variable, so a trial that was paid for is still read either way. The
    layout inside (`<session>.jsonl` plus `<session>/subagents/agent-<id>.jsonl`)
    is what `claude_usage.parse_session_dir` and `runner.scan` already expect,
    so the live path needs no parser of its own.
    """
    projects = roots.profile / "projects"
    pinned = projects / project_dir_name(root_session_id)
    slug = fallback_slug(roots)
    if not pinned.is_dir() and slug is not None and (projects / slug).is_dir():
        return projects / slug
    return pinned


def settings_path(roots: artifact.TrialRoots) -> Path:
    """Outside the worktree and outside the output root: it is not agent output."""
    return roots.base / SETTINGS_FILE


def _string(where: str, value: Any, limit: int) -> str:
    if not isinstance(value, str) or isinstance(value, bool):
        raise LiveExecutorError(f"{where} must be a plain string")
    if not value.strip():
        raise LiveExecutorError(f"{where} is empty")
    if len(value) > limit:
        raise LiveExecutorError(f"{where} is longer than {limit} characters")
    if "\x00" in value:
        raise LiveExecutorError(f"{where} contains a NUL byte")
    # A value the CLI could read as a flag of its own is refused here rather
    # than escaped, because there is no escaping in an argv list.
    if value.startswith("-"):
        raise LiveExecutorError(f"{where} starts with '-' and would be read as a flag")
    return value


def prompt_of(task: Mapping[str, Any]) -> str:
    if "prompt" not in task:
        raise LiveExecutorError(f"task {task.get('id')!r} has no prompt, which a live executor needs")
    return _string("task prompt", task["prompt"], PROMPT_LIMIT)


def model_of(pins: Mapping[str, Any]) -> str:
    model = _string("pins.model", pins.get("model"), 64)
    if not MODEL.match(model):
        raise LiveExecutorError(f"pins.model {model!r} is not a model id")
    return model


def permission_mode_of(pins: Mapping[str, Any]) -> str:
    mode = _string("pins.permission_mode", pins.get("permission_mode"), 32)
    if mode not in PERMISSION_MODES:
        raise LiveExecutorError(f"pins.permission_mode {mode!r} is not one of {', '.join(sorted(PERMISSION_MODES))}")
    return mode


def budget_of(pins: Mapping[str, Any]) -> str:
    value = pins.get("max_budget_usd")
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise LiveExecutorError("pins.max_budget_usd must be a number")
    if not 0 < value <= BUDGET_CEILING_USD:
        raise LiveExecutorError(f"pins.max_budget_usd must be above 0 and at most {BUDGET_CEILING_USD}")
    # Formatted by this module, so no manifest string reaches the argument.
    return f"{float(value):.2f}"


def pins_for(pins: Mapping[str, Any], task: Mapping[str, Any] | None) -> dict[str, Any]:
    """The pins with a task's own `tools` and `allowed_tools` in place of the manifest's, when the task states them.

    A recursive-slice task is the one case: it may hand the agent the subagent
    tool, and only that task does, so the override is per task and never widens
    another task's pins.
    """
    merged = dict(pins)
    for key in ("tools", "allowed_tools"):
        if task is not None and key in task:
            merged[key] = task[key]
    return merged


def tools_of(pins: Mapping[str, Any]) -> list[str]:
    values = pins.get("tools")
    if not isinstance(values, list) or not values:
        raise LiveExecutorError("pins.tools must be a non-empty list")
    tools = []
    for value in values:
        tool = _string("a tool name", value, 32)
        if tool not in TOOLS:
            raise LiveExecutorError(f"tool {tool!r} is not in the declared tool set")
        tools.append(tool)
    return tools


def _rule(where: str, value: Any, tools: list[str]) -> str:
    rule = _string(where, value, 96)
    match = ALLOWED_TOOL.match(rule)
    if match is None or match.group("name") not in TOOLS:
        raise LiveExecutorError(f"{where} {rule!r} is not a declared tool with an optional pattern")
    # A rule for a tool the trial does not pass to `--tools` is a widening
    # that the argv would not otherwise allow.
    if match.group("name") not in tools:
        raise LiveExecutorError(f"{where} {rule!r} names a tool outside pins.tools")
    return rule


def allowed_tools_of(pins: Mapping[str, Any]) -> list[str]:
    values = pins.get("allowed_tools")
    if not isinstance(values, list) or not values:
        raise LiveExecutorError("pins.allowed_tools must be a non-empty list")
    tools = tools_of(pins)
    return [_rule("an allowed tool rule", value, tools) for value in values]


def credential_env_of(pins: Mapping[str, Any]) -> str:
    name = pins.get("credential_env", DEFAULT_CREDENTIAL_ENV)
    # Shape before membership: `name in CREDENTIAL_ENVS` raises TypeError on an
    # unhashable value, which would escape this module's refusal contract.
    name = _string("pins.credential_env", name, 64)
    if name not in CREDENTIAL_ENVS:
        raise LiveExecutorError(f"pins.credential_env must be one of {', '.join(sorted(CREDENTIAL_ENVS))}")
    return name


def _settings_env(env: Any) -> None:
    """An arm may add its own variables. It may not reach the trial's own."""
    if not isinstance(env, dict):
        raise LiveExecutorError("arm settings.env must be an object")
    for name, value in env.items():
        if not isinstance(name, str) or not ENV_NAME.match(name):
            raise LiveExecutorError(f"arm settings.env name {name!r} is not an environment variable name")
        if name in RESERVED_ENV_NAMES or name.startswith(RESERVED_ENV_PREFIXES):
            raise LiveExecutorError(f"arm settings.env may not set {name}: the trial's own roots and seams own it")
        _string(f"arm settings.env {name}", value, 512)


def _settings_permissions(permissions: Any, pins: Mapping[str, Any]) -> None:
    """Permission rules may narrow the flag pins. They may not widen them."""
    if not isinstance(permissions, dict):
        raise LiveExecutorError("arm settings.permissions must be an object")
    unknown = sorted(key for key in permissions if key not in PERMISSION_KEYS)
    if unknown:
        raise LiveExecutorError(f"arm settings.permissions has unknown keys: {', '.join(unknown)}")
    mode = permissions.get("defaultMode")
    if mode is not None and mode != permission_mode_of(pins):
        raise LiveExecutorError("arm settings.permissions.defaultMode disagrees with pins.permission_mode")
    tools = tools_of(pins)
    for key in ("allow", "ask"):
        rules = permissions.get(key, [])
        if not isinstance(rules, list):
            raise LiveExecutorError(f"arm settings.permissions.{key} must be a list")
        for rule in rules:
            _rule(f"arm settings.permissions.{key} rule", rule, tools)
    deny = permissions.get("deny", [])
    if not isinstance(deny, list) or not all(isinstance(rule, str) for rule in deny):
        raise LiveExecutorError("arm settings.permissions.deny must be a list of strings")


def _hook_url(where: str, url: Any, templated: bool) -> None:
    """A loopback URL, or the daemon placeholder in a template. Nothing else."""
    if not isinstance(url, str) or not url.strip() or "\x00" in url or len(url) > HOOK_COMMAND_LIMIT:
        raise LiveExecutorError(f"{where} url must be a plain string")
    if url == "{daemon_url}":
        if not templated:
            raise LiveExecutorError(f"{where} url placeholder was never resolved")
        return
    parts = urlsplit(url)
    if parts.scheme != "http" or parts.hostname not in LOOPBACK_HOSTS or parts.port is None:
        raise LiveExecutorError(f"{where} url must be http on 127.0.0.1 or localhost with a port")


def _hook_handler(where: str, handler: Any, templated: bool) -> None:
    if not isinstance(handler, dict):
        raise LiveExecutorError(f"{where} entries must be objects")
    kind = handler.get("type")
    if kind == "command":
        if set(handler) - COMMAND_HOOK_KEYS:
            raise LiveExecutorError(f"{where} command entries hold {', '.join(sorted(COMMAND_HOOK_KEYS))} only")
        text = handler.get("command")
        if not isinstance(text, str) or not text.strip() or len(text) > HOOK_COMMAND_LIMIT or "\x00" in text:
            raise LiveExecutorError(f"{where} command must be a plain string")
    elif kind == "http":
        if set(handler) - HTTP_HOOK_KEYS:
            raise LiveExecutorError(f"{where} http entries hold {', '.join(sorted(HTTP_HOOK_KEYS))} only")
        _hook_url(where, handler.get("url"), templated)
        headers = handler.get("headers", {})
        if not isinstance(headers, dict):
            raise LiveExecutorError(f"{where} headers must be an object")
        for name, value in headers.items():
            if not isinstance(name, str) or not re.match(r"^[A-Za-z][A-Za-z0-9-]{0,63}\Z", name):
                raise LiveExecutorError(f"{where} header name {name!r} is not a header name")
            if not isinstance(value, str) or "\x00" in value or "\n" in value or len(value) > HTTP_HEADER_LIMIT:
                raise LiveExecutorError(f"{where} header {name} must be a plain string")
    else:
        raise LiveExecutorError(f"{where} entries must be {{type: command, ...}} or {{type: http, url: ...}}")
    timeout = handler.get("timeout", 1)
    if isinstance(timeout, bool) or not isinstance(timeout, int) or timeout <= 0:
        raise LiveExecutorError(f"{where} timeout must be a positive integer")


def _settings_overlay(overlay: Any) -> None:
    if not isinstance(overlay, dict) or not overlay:
        raise LiveExecutorError("arm settings.overlay must be a non-empty object of relative path to file text")
    for path, text in overlay.items():
        if not isinstance(path, str) or not path or Path(path).is_absolute() or ".." in Path(path).parts or path.startswith("/"):
            raise LiveExecutorError(f"arm settings.overlay path {path!r} must be relative and inside the repository")
        if not isinstance(text, str) or not text or len(text) > OVERLAY_FILE_LIMIT:
            raise LiveExecutorError(f"arm settings.overlay {path!r} must be a non-empty string under {OVERLAY_FILE_LIMIT} characters")
        foreign = placeholders_of(text) - OVERLAY_PLACEHOLDERS
        if foreign:
            raise LiveExecutorError(f"arm settings.overlay {path!r} names {', '.join(sorted(foreign))}; an overlay may name {{data_dir}} only")


def overlay_of(arm: Mapping[str, Any], roots: artifact.TrialRoots) -> dict[str, str]:
    """The arm's overlay with `{data_dir}` resolved to this trial's data dir, or empty."""
    overlay = (arm.get("settings") or {}).get("overlay")
    if not isinstance(overlay, dict):
        return {}
    _settings_overlay(overlay)
    return {path: resolve_settings(text, {"data_dir": str(roots.data_dir)}) for path, text in overlay.items()}


def inject_cases(roots: artifact.TrialRoots, task: Mapping[str, Any]) -> Path | None:
    """Write the task's test cases from the hidden layer into the trial copy as a Vitest setup file.

    The expected values are only observable by running the test: nothing
    committed holds them, the fixture's config names this setup file, and the
    runner materializes it here, after the fixture copy and before the spawn.
    """
    cases = verifier.HIDDEN / str(task.get("id", "")) / "cases.json"
    if not cases.is_file():
        return None
    target = roots.repo / SETUP_PATH
    target.parent.mkdir(parents=True, exist_ok=True)
    payload = {str(task["id"]): json.loads(cases.read_text(encoding="utf-8"))}
    target.write_text("// Written by the benchmark runner at launch; the test reads it through globalThis.\n" f"globalThis.__bench1Cases = {json.dumps(payload)};\n", encoding="utf-8")
    return target


def apply_overlay(roots: artifact.TrialRoots, overlay: Mapping[str, str]) -> list[str]:
    """Write the overlay into the trial's repository copy. Idempotent: the provisioner and the launch both call it."""
    written = []
    for path, text in sorted(overlay.items()):
        target = roots.repo / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8")
        written.append(path)
    return written


def _settings_hooks(hooks: Any, templated: bool = True) -> None:
    """Shape only. A hook command is operator-authored code, and it says so.

    `templated` is whether the daemon placeholders may still stand in for
    values: true for the arm's declared fragment, false for the resolved one
    the child reads.
    """
    if not isinstance(hooks, dict):
        raise LiveExecutorError("arm settings.hooks must be an object")
    for event, entries in hooks.items():
        if event not in HOOK_EVENTS:
            raise LiveExecutorError(f"arm settings.hooks names an unknown event {event!r}")
        if not isinstance(entries, list):
            raise LiveExecutorError(f"arm settings.hooks.{event} must be a list")
        for entry in entries:
            if not isinstance(entry, dict) or set(entry) - HOOK_ENTRY_KEYS:
                raise LiveExecutorError(f"arm settings.hooks.{event} entries hold {', '.join(sorted(HOOK_ENTRY_KEYS))} only")
            matcher = entry.get("matcher", "")
            # An empty matcher is the CLI's own "every tool", so this is a
            # shape check rather than the non-empty rule an argument gets.
            if not isinstance(matcher, str) or len(matcher) > 128 or "\x00" in matcher:
                raise LiveExecutorError(f"arm settings.hooks.{event} matcher must be a plain string")
            handlers = entry.get("hooks")
            if not isinstance(handlers, list) or not handlers:
                raise LiveExecutorError(f"arm settings.hooks.{event} needs a non-empty hooks list")
            for handler in handlers:
                _hook_handler(f"arm settings.hooks.{event}", handler, templated)


def placeholders_of(value: Any) -> set[str]:
    """Every daemon placeholder a fragment names, wherever a string holds one."""
    if isinstance(value, str):
        return set(PLACEHOLDER.findall(value))
    if isinstance(value, dict):
        return set().union(*(placeholders_of(item) for item in value.values())) if value else set()
    if isinstance(value, list):
        return set().union(*(placeholders_of(item) for item in value)) if value else set()
    return set()


def resolve_settings(settings: Any, values: Mapping[str, str]) -> Any:
    """The fragment with each placeholder replaced by its per-trial value. Strings only, no format."""
    if isinstance(settings, str):
        return PLACEHOLDER.sub(lambda match: values[match.group(1)], settings)
    if isinstance(settings, dict):
        return {key: resolve_settings(item, values) for key, item in settings.items()}
    if isinstance(settings, list):
        return [resolve_settings(item, values) for item in settings]
    return settings


def settings_of(arm: Mapping[str, Any], pins: Mapping[str, Any]) -> dict[str, Any]:
    """The arm's settings fragment, checked to the leaf and against its own hash."""
    settings = arm.get("settings")
    if not isinstance(settings, dict):
        raise LiveExecutorError(f"arm {arm.get('id')!r} has no settings object, which a live executor needs")
    unknown = sorted(key for key in settings if key not in SETTINGS_KEYS)
    if unknown:
        raise LiveExecutorError(f"arm settings has unknown top-level keys: {', '.join(unknown)}")
    if "env" in settings:
        _settings_env(settings["env"])
    if "permissions" in settings:
        _settings_permissions(settings["permissions"], pins)
    if "hooks" in settings:
        _settings_hooks(settings["hooks"])
    if "overlay" in settings:
        _settings_overlay(settings["overlay"])
    try:
        digest = "sha256:" + sha256_json(settings)
    except (TypeError, ValueError) as error:
        raise LiveExecutorError(f"arm settings is not JSON data: {error}") from error
    # The record carries `settings_hash` as the identity of the treatment, so
    # a fragment that does not hash to it would misname what actually ran. The
    # hash proves identity, never safety: the checks above are what bound it.
    if arm.get("settings_hash") != digest:
        raise LiveExecutorError(f"arm {arm.get('id')!r} settings_hash does not match its settings fragment")
    return settings


def provision_of(arm: Mapping[str, Any]) -> str | None:
    """The provisioner an arm declares. Only the Tenjin one exists."""
    name = arm.get("provision")
    if name is None:
        return None
    if name != tenjin_arm.NAME:
        raise LiveExecutorError(f"arm {arm.get('id')!r} declares unknown provision {name!r}")
    return name


def settings_for_launch(request: LaunchRequest) -> tuple[dict[str, Any], str | None]:
    """The fragment the child reads, and its hash when it differs from the declared one."""
    settings = settings_of(request.arm, pins_for(request.pins, request.task))
    # The overlay is the repository's, not the child's settings file: it is
    # applied to the trial copy and left out of what Claude Code reads.
    settings = {key: value for key, value in settings.items() if key != "overlay"}
    placeholders = placeholders_of(settings)
    if request.provision is None:
        if placeholders:
            raise LiveExecutorError(
                f"arm {request.arm.get('id')!r} names {', '.join(sorted(placeholders))} but declares no provision"
            )
        return settings, None
    resolved = resolve_settings(settings, request.provision.values)
    if placeholders_of(resolved):
        raise LiveExecutorError("the provision left a placeholder unresolved")
    if "hooks" in resolved:
        _settings_hooks(resolved["hooks"], templated=False)
    return resolved, "sha256:" + sha256_json(resolved)


def refuse_project_settings(repo: Path) -> None:
    """A fixture may not carry `.claude`: `--setting-sources project` reads it."""
    for parent, names, files in os.walk(repo, followlinks=False):
        for name in list(names) + list(files):
            if name == PROJECT_SETTINGS_DIR:
                relative = (Path(parent) / name).relative_to(repo).as_posix()
                raise LiveExecutorError(f"the task fixture carries {relative}, which --setting-sources project would load")


def child_environment(
    roots: artifact.TrialRoots, parent: Mapping[str, str], credential_env: str, project_dir: str
) -> dict[str, str]:
    """An allowlist built from the trial's own roots, plus three inherited names.

    The parent environment is read for `PATH`, `TERM`, `LANG`, and the one
    credential variable the seam names. A wallet key, a shelf secret, and the
    operator's own `CLAUDE_CONFIG_DIR` have no way through: they are not on
    the list, and the trial's own profile is what `CLAUDE_CONFIG_DIR` gets.
    The arm's `settings.env` is the other way into this process, which is why
    `_settings_env` refuses every name this function owns.
    """
    if credential_env not in CREDENTIAL_ENVS:
        raise LiveExecutorError(f"{credential_env!r} is not a declared credential seam variable")
    env = roots.environment(parent.get("PATH", ""))
    env[PROJECT_DIR_VAR] = project_dir_name(project_dir)
    for name in INHERITED:
        value = parent.get(name)
        if value:
            env[name] = value
    credential = parent.get(credential_env)
    if credential:
        env[credential_env] = credential
    env.update(toolchain.child_variables(roots.corepack_home))
    return env


def package_manager_for(roots: artifact.TrialRoots, parent: Mapping[str, str], dry_run: bool) -> toolchain.PackageManager | None:
    """The pnpm this trial runs, refused unless it is the fixture's pin, and seeded into the trial's corepack home.

    A fixture without a package.json (the plumbing smoke) needs no pnpm and
    gets nothing here. A dry run probes and reports, and neither refuses nor
    copies. Seeding is idempotent: the provisioner and the launch both call it.
    """
    pin = toolchain.package_manager_pin(roots.repo)
    if pin is None:
        return None
    manager = toolchain.inspect(parent, pin, probe_binary=not dry_run, cwd=roots.base)
    if dry_run:
        return manager
    toolchain.check(manager, pin, toolchain.corepack_home(parent))
    if manager.kind == "corepack-shim" and pin not in toolchain.cached_versions(roots.corepack_home):
        toolchain.seed(toolchain.corepack_home(parent), roots.corepack_home, pin)
    return manager


def probe_environment(roots: artifact.TrialRoots, parent: Mapping[str, str]) -> dict[str, str]:
    """What a command run inside the trial's repository copy sees before the agent does: the child's allowlist, no credential."""
    env = roots.environment(parent.get("PATH", ""))
    for name in INHERITED:
        value = parent.get(name)
        if value:
            env[name] = value
    env.update(toolchain.child_variables(roots.corepack_home))
    return env


def build_argv(request: LaunchRequest, settings: Path, session_id: str) -> list[str]:
    """The whole command. Every flag is a literal here; every value is checked above."""
    pins = pins_for(request.pins, request.task)
    return [
        CLI,
        "-p",
        prompt_of(request.task),
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-hook-events",
        "--model",
        model_of(pins),
        "--max-budget-usd",
        budget_of(pins),
        "--strict-mcp-config",
        "--setting-sources",
        "project",
        "--settings",
        str(settings),
        "--tools",
        ",".join(tools_of(pins)),
        "--allowedTools",
        *allowed_tools_of(pins),
        "--permission-mode",
        permission_mode_of(pins),
        # Minted, not read back. Session persistence stays on, so the child
        # transcripts this id names are on disk when the trial settles.
        "--session-id",
        session_id,
    ]


def launch(request: LaunchRequest) -> Launch:
    """Validate the manifest's values, write the trial's settings, name the command."""
    provision_of(request.arm)
    settings, resolved_hash = settings_for_launch(request)
    credential_env = credential_env_of(request.pins)
    refuse_project_settings(request.roots.repo)
    session_id = root_session_id(request.trial_id, request.phase)
    path = settings_path(request.roots)
    path.write_text(json.dumps(settings, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    apply_overlay(request.roots, overlay_of(request.arm, request.roots))
    inject_cases(request.roots, request.task)
    try:
        manager = package_manager_for(request.roots, os.environ, request.dry_run)
    except toolchain.ToolchainError as error:
        raise LiveExecutorError(error.detail) from error
    return Launch(
        argv=build_argv(request, path, session_id),
        cwd=working_dir(request.roots),
        root_session_id=session_id,
        env=child_environment(request.roots, os.environ, credential_env, session_id),
        resolved_settings_hash=resolved_hash,
        package_manager=None if manager is None else manager.facts,
    )


def prepare(request: ProvisionRequest) -> Provision:
    """Provision the arm, with the trial's toolchain in place so the seed probe runs the fixture's commands as the agent will."""
    if provision_of(request.arm) is None:
        raise LiveExecutorError(f"arm {request.arm.get('id')!r} declares no provision")
    # The overlay is in place before the seed probe, so the probe runs the
    # fixture as the agent will see it.
    apply_overlay(request.roots, overlay_of(request.arm, request.roots))
    if request.task is not None:
        inject_cases(request.roots, request.task)
    if request.dry_run:
        return tenjin_arm.prepare(request)
    try:
        package_manager_for(request.roots, os.environ, dry_run=False)
    except toolchain.ToolchainError as error:
        raise LiveExecutorError(error.detail) from error
    return tenjin_arm.prepare(dataclasses.replace(request, environment=probe_environment(request.roots, os.environ)))


SPEC = ExecutorSpec(
    name=NAME,
    harness=HARNESS,
    launch=launch,
    live=True,
    required_origins=REQUIRED_ORIGINS,
    sessions=sessions_dir,
    credential_seam=credential_env_of,
    prepare=prepare,
    stop=tenjin_arm.stop,
    session_of=root_session_id,
)

REGISTRY[NAME] = SPEC
