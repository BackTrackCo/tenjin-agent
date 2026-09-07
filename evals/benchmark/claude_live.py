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

import json
import os
import re
import uuid
from pathlib import Path
from typing import Any, Mapping

from . import artifact, sha256_json
from .executor import REGISTRY, ExecutorError, ExecutorSpec, Launch, LaunchRequest

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
    {"Bash", "Read", "Edit", "Write", "Glob", "Grep", "Task", "TodoWrite", "WebFetch", "WebSearch", "NotebookEdit"}
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
SETTINGS_KEYS = frozenset({"env", "hooks", "permissions"})
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
    }
)
HOOK_ENTRY_KEYS = frozenset({"matcher", "hooks"})
HOOK_KEYS = frozenset({"type", "command", "timeout"})
# The variables the CLI genuinely needs that only the parent can supply.
INHERITED = ("PATH", "TERM", "LANG")
# Variables the trial's own roots own, or that would move the model traffic,
# the config directory, or the process loader. An arm names its treatment with
# its own variables; it does not reach these through `settings.env`.
RESERVED_ENV_PREFIXES = ("ANTHROPIC_", "AWS_", "CLAUDE_", "DYLD_", "GITHUB_", "LD_", "NODE_", "TENJIN_")
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


def root_session_id(trial_id: str) -> str:
    """A real UUID, derived from the trial id, stable across resume."""
    return str(uuid.uuid5(SESSION_NAMESPACE, trial_id))


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


def _settings_hooks(hooks: Any) -> None:
    """Shape only. A hook command is operator-authored code, and it says so."""
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
            commands = entry.get("hooks")
            if not isinstance(commands, list) or not commands:
                raise LiveExecutorError(f"arm settings.hooks.{event} needs a non-empty hooks list")
            for command in commands:
                if not isinstance(command, dict) or set(command) - HOOK_KEYS or command.get("type") != "command":
                    raise LiveExecutorError(f"arm settings.hooks.{event} entries must be {{type: command, command: ...}}")
                text = command.get("command")
                if not isinstance(text, str) or not text.strip() or len(text) > HOOK_COMMAND_LIMIT or "\x00" in text:
                    raise LiveExecutorError(f"arm settings.hooks.{event} command must be a plain string")
                timeout = command.get("timeout", 1)
                if isinstance(timeout, bool) or not isinstance(timeout, int) or timeout <= 0:
                    raise LiveExecutorError(f"arm settings.hooks.{event} timeout must be a positive integer")


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
    return env


def build_argv(request: LaunchRequest, settings: Path, session_id: str) -> list[str]:
    """The whole command. Every flag is a literal here; every value is checked above."""
    pins = request.pins
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
    settings = settings_of(request.arm, request.pins)
    credential_env = credential_env_of(request.pins)
    refuse_project_settings(request.roots.repo)
    session_id = root_session_id(request.trial_id)
    path = settings_path(request.roots)
    path.write_text(json.dumps(settings, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return Launch(
        argv=build_argv(request, path, session_id),
        cwd=working_dir(request.roots),
        root_session_id=session_id,
        env=child_environment(request.roots, os.environ, credential_env, session_id),
    )


SPEC = ExecutorSpec(
    name=NAME,
    harness=HARNESS,
    launch=launch,
    live=True,
    required_origins=REQUIRED_ORIGINS,
    sessions=sessions_dir,
    credential_seam=credential_env_of,
)

REGISTRY[NAME] = SPEC
