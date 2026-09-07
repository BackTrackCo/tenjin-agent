"""The live Claude Code executor: one code-owned argv, no shell, no operator environment.

This is the first spec in the registry that starts a real agent, so everything
it touches is written to be provable offline. The flags are literals in this
module; the manifest supplies values only, and each value is checked against a
declared allowlist of shapes before it becomes an argument. Nothing here is
ever passed to a shell: `runner.process_spawn` runs the list with
`shell=False`, and a value that could be read as a flag is refused rather than
quoted.

Three facts about Claude Code shape the design:

- `--session-id` takes a UUID the caller chooses, so the root session id is
  minted from the trial id before launch. A resumed schedule re-derives the
  same id instead of reading one back out of a stream.
- session persistence must stay on. A live trial's usage lives in the
  persisted transcripts, and a child agent's usage exists nowhere else, so the
  runner reads `HOME/.claude/projects/<cwd slug>/` rather than a stream.
- `--settings` plus `--setting-sources project` plus `--strict-mcp-config` is
  what keeps the operator's own configuration out of a measured run.

`artifact.require_isolation` still owns the refusals that cost money: a live
executor is refused in CI, and a publishable live run without an isolation
attestation is refused before any spend.
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
PERMISSION_MODES = frozenset({"default", "acceptEdits", "dontAsk", "plan", "bypassPermissions"})
# The seam that carries the model credential into the trial. Nothing else from
# the operator's environment crosses.
CREDENTIAL_ENVS = frozenset({"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"})
DEFAULT_CREDENTIAL_ENV = "ANTHROPIC_API_KEY"
# An arm is a settings difference. These are the settings keys a benchmark arm
# may state; anything else would change the harness rather than the treatment.
SETTINGS_KEYS = frozenset({"env", "hooks", "permissions"})
# The variables the CLI genuinely needs that only the parent can supply.
INHERITED = ("PATH", "TERM", "LANG")

MODEL = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$")
# `Name` or `Name(pattern)`, which is the permission syntax Claude Code reads.
# The pattern alphabet excludes the shell metacharacters outright, so a rule
# cannot smuggle one even though no shell ever sees it.
ALLOWED_TOOL = re.compile(r"^(?P<name>[A-Za-z]{1,32})(\((?P<pattern>[A-Za-z0-9 ./*:_-]{1,64})\))?$")
PROMPT_LIMIT = 4000
# A per-attempt ceiling on `--max-budget-usd`. A manifest that asks for more
# than this is refused: a typo in a pin is otherwise a spend event.
BUDGET_CEILING_USD = 25.0
SETTINGS_FILE = "settings.json"


class LiveExecutorError(ExecutorError):
    pass


def root_session_id(trial_id: str) -> str:
    """A real UUID, derived from the trial id, stable across resume."""
    return str(uuid.uuid5(SESSION_NAMESPACE, trial_id))


def project_slug(cwd: Path) -> str:
    """Claude Code's own directory slug: every character outside [A-Za-z0-9] becomes '-'."""
    return re.sub(r"[^A-Za-z0-9]", "-", str(cwd))


def working_dir(roots: artifact.TrialRoots) -> Path:
    """The resolved worktree. The slug has to match the cwd the CLI actually sees."""
    return roots.repo.resolve()


def sessions_dir(roots: artifact.TrialRoots, root_session_id: str) -> Path:
    """The real transcript directory: `<trial home>/.claude/projects/<cwd slug>/`.

    Its layout (`<session>.jsonl` plus `<session>/subagents/agent-<id>.jsonl`)
    is what `claude_usage.parse_session_dir` and `runner.scan` already expect,
    so the live path needs no parser of its own.
    """
    return roots.home / ".claude" / "projects" / project_slug(working_dir(roots))


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


def allowed_tools_of(pins: Mapping[str, Any]) -> list[str]:
    values = pins.get("allowed_tools")
    if not isinstance(values, list) or not values:
        raise LiveExecutorError("pins.allowed_tools must be a non-empty list")
    rules = []
    for value in values:
        rule = _string("an allowed tool rule", value, 96)
        match = ALLOWED_TOOL.match(rule)
        if match is None or match.group("name") not in TOOLS:
            raise LiveExecutorError(f"allowed tool rule {rule!r} is not a declared tool with an optional pattern")
        rules.append(rule)
    return rules


def credential_env_of(pins: Mapping[str, Any]) -> str:
    name = pins.get("credential_env", DEFAULT_CREDENTIAL_ENV)
    if name not in CREDENTIAL_ENVS:
        raise LiveExecutorError(f"pins.credential_env must be one of {', '.join(sorted(CREDENTIAL_ENVS))}")
    return str(name)


def settings_of(arm: Mapping[str, Any]) -> dict[str, Any]:
    """The arm's settings fragment, checked against its own declared hash."""
    settings = arm.get("settings")
    if not isinstance(settings, dict):
        raise LiveExecutorError(f"arm {arm.get('id')!r} has no settings object, which a live executor needs")
    unknown = sorted(key for key in settings if key not in SETTINGS_KEYS)
    if unknown:
        raise LiveExecutorError(f"arm settings has unknown top-level keys: {', '.join(unknown)}")
    try:
        digest = "sha256:" + sha256_json(settings)
    except (TypeError, ValueError) as error:
        raise LiveExecutorError(f"arm settings is not JSON data: {error}") from error
    # The record carries `settings_hash` as the identity of the treatment, so
    # a fragment that does not hash to it would misname what actually ran.
    if arm.get("settings_hash") != digest:
        raise LiveExecutorError(f"arm {arm.get('id')!r} settings_hash does not match its settings fragment")
    return settings


def child_environment(roots: artifact.TrialRoots, parent: Mapping[str, str], credential_env: str) -> dict[str, str]:
    """An allowlist built from the trial's own roots, plus three inherited names.

    The parent environment is read for `PATH`, `TERM`, `LANG`, and the one
    credential variable the seam names. A wallet key, a shelf secret, and the
    operator's own `CLAUDE_CONFIG_DIR` have no way through: they are not on
    the list, and the trial's own profile is what `CLAUDE_CONFIG_DIR` gets.
    """
    if credential_env not in CREDENTIAL_ENVS:
        raise LiveExecutorError(f"{credential_env!r} is not a declared credential seam variable")
    env = roots.environment(parent.get("PATH", ""))
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
    settings = settings_of(request.arm)
    credential_env = credential_env_of(request.pins)
    session_id = root_session_id(request.trial_id)
    path = settings_path(request.roots)
    path.write_text(json.dumps(settings, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return Launch(
        argv=build_argv(request, path, session_id),
        cwd=working_dir(request.roots),
        root_session_id=session_id,
        env=child_environment(request.roots, os.environ, credential_env),
    )


SPEC = ExecutorSpec(
    name=NAME,
    harness=HARNESS,
    launch=launch,
    live=True,
    required_origins=REQUIRED_ORIGINS,
    sessions=sessions_dir,
)

REGISTRY[NAME] = SPEC
