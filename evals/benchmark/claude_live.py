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

from . import protocol, artifact, container, images, sha256_json, tenjin_arm, verifier
from .discovery import SETUP_PATH
from .schema import check, enum
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
# An `http` hook is a POST from the CLI to a URL. The only URL an arm may name
# is a loopback one: the product's own daemon on this machine, which the
# provisioning seam starts per trial. Any other host is refused.
LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost"})
HTTP_HEADER_LIMIT = 512
# The values a provisioned arm's settings template resolves to, per trial.
# `settings_hash` is over the template, so it names the treatment once; the
# resolved fragment's hash goes under the record's private hashes.
PLACEHOLDER = re.compile(r"\{(" + "|".join(tenjin_arm.PLACEHOLDERS) + r")\}")
# The variables the CLI genuinely needs that the image does not supply. `PATH`
# is not among them any more: the agent, the CLI and pnpm are the image's, and
# the operator's PATH names darwin binaries no container can run.
INHERITED = ("LANG",)
# What the docker client itself needs from the operator's shell: how to reach
# the daemon, and where its own configuration is. The credential seam rides
# here too, and `docker run --env NAME` forwards it into the container without
# ever putting the value in an argv.
# Variables the trial's own roots own, or that would move the model traffic,
# the config directory, or the process loader. An arm names its treatment with
# its own variables; it does not reach these through `settings.env`.
RESERVED_ENV_PREFIXES = ("ANTHROPIC_", "AWS_", "CLAUDE_", "COREPACK_", "DYLD_", "GITHUB_", "LD_", "NODE_", "TENJIN_")
RESERVED_ENV_NAMES = frozenset({"HOME", "PATH", "TERM", "LANG", "SHELL", "PYTHONPATH"})
# Where Harbor's own trial directory goes: under the attempt's base, beside the
# roots, so it is thrown away with them. `environment` is the directory Harbor
# resolves for `--project-directory`; with a prebuilt image nothing in it is
# read, but it has to exist.
HARBOR_DIR = "harbor"
ENVIRONMENT_DIR = "environment"

# `\Z` rather than `$`: in Python `$` also matches before a trailing newline,
# so `$` would let `claude-fable-5-1\n` through as a model id.
MODEL = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}\Z")
# `Name` or `Name(pattern)`, which is the permission syntax Claude Code reads.
# The pattern alphabet excludes the shell metacharacters outright, so a rule
# cannot smuggle one even though no shell ever sees it.
ALLOWED_TOOL = re.compile(r"^(?P<name>[A-Za-z]{1,32})(\((?P<pattern>[A-Za-z0-9 ./*:_-]{1,64})\))?\Z")
ENV_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}\Z")
HEADER_NAME = r"^[A-Za-z][A-Za-z0-9-]{0,63}\Z"
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


def argv_value(limit: int) -> dict[str, Any]:
    """A string this module turns into an argument.

    Non-blank, bounded, no NUL, and not readable as a flag of its own: there is
    no escaping in an argv list, so a value that could be read as a flag is
    refused here rather than quoted.
    """
    return {"type": "string", "maxLength": limit, "pattern": r"\S", "not": {"anyOf": [{"pattern": "\x00"}, {"pattern": "^-"}]}}


# Values the manifest supplies. Membership in a declared set is an `enum`, and
# a shape the argv depends on is a `pattern`, so both are the schema's.
PROMPT = argv_value(PROMPT_LIMIT)
MODEL_ID = {"type": "string", "maxLength": 64, "pattern": MODEL.pattern}
PERMISSION_MODE = enum(PERMISSION_MODES)
CREDENTIAL_ENV = enum(CREDENTIAL_ENVS)
BUDGET = {"type": "number", "exclusiveMinimum": 0, "maximum": BUDGET_CEILING_USD}
TOOL_LIST = {"type": "array", "minItems": 1, "items": enum(TOOLS)}
# `Name` or `Name(pattern)`. The pattern alphabet excludes the shell
# metacharacters outright, and the whole-string match is what makes a blank, a
# NUL byte or a leading `-` a non-rule.
RULE = {"type": "string", "maxLength": 96, "pattern": ALLOWED_TOOL.pattern}
RULE_LIST = {"type": "array", "minItems": 1, "items": RULE}

# Strings the CLI reads that this module never turns into an argument, so the
# flag guard does not apply to them.
HOOK_COMMAND = {"type": "string", "maxLength": HOOK_COMMAND_LIMIT, "pattern": r"\S", "not": {"pattern": "\x00"}}
HOOK_URL = {"type": "string", "maxLength": HOOK_COMMAND_LIMIT, "pattern": r"\S", "not": {"pattern": "\x00"}}
# An empty matcher is the CLI's own "every tool", so this is a shape check
# rather than the non-blank rule an argument gets.
MATCHER = {"type": "string", "maxLength": 128, "not": {"pattern": "\x00"}}
HEADER_VALUE = {"type": "string", "maxLength": HTTP_HEADER_LIMIT, "not": {"pattern": "[\x00\n]"}}
TIMEOUT = {"type": "integer", "minimum": 1}

HOOK_HANDLER = {
    "type": "object",
    "required": ["type"],
    "oneOf": [
        {
            "additionalProperties": False,
            "required": ["command"],
            "properties": {"type": {"const": "command"}, "command": HOOK_COMMAND, "timeout": TIMEOUT},
        },
        {
            "additionalProperties": False,
            "required": ["url"],
            "properties": {
                "type": {"const": "http"},
                # Which URL is `_hook_url`: a loopback one, or the daemon
                # placeholder while the fragment is still a template.
                "url": HOOK_URL,
                "headers": {"type": "object", "propertyNames": {"pattern": HEADER_NAME}, "additionalProperties": HEADER_VALUE},
                "timeout": TIMEOUT,
            },
        },
    ],
}
HOOKS_SCHEMA = {
    "type": "object",
    "propertyNames": enum(HOOK_EVENTS),
    "additionalProperties": {
        "type": "array",
        "items": {
            "type": "object",
            "additionalProperties": False,
            "required": ["hooks"],
            "properties": {"matcher": MATCHER, "hooks": {"type": "array", "minItems": 1, "items": HOOK_HANDLER}},
        },
    },
}
ENV_SCHEMA = {"type": "object", "propertyNames": {"pattern": ENV_NAME.pattern}, "additionalProperties": argv_value(512)}
# Rules that narrow, plus a default mode that has to agree with the pinned
# one. `additionalDirectories` is absent on purpose, because it widens the
# filesystem past the trial's own roots.
PERMISSIONS_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "allow": {"type": "array", "items": RULE},
        "ask": {"type": "array", "items": RULE},
        "deny": {"type": "array", "items": {"type": "string"}},
        "defaultMode": {"type": "string"},
    },
}
# Paths are relative and inside the repository, transcribed from
# `Path(value).is_absolute()` and `".." in Path(value).parts`.
OVERLAY_SCHEMA = {
    "type": "object",
    "minProperties": 1,
    "propertyNames": {"type": "string", "pattern": r"^[^/]", "not": {"pattern": r"(^|/)\.\.(/|$)"}},
    "additionalProperties": {"type": "string", "minLength": 1, "maxLength": OVERLAY_FILE_LIMIT},
}
# Which keys an arm may name. Each key's own shape belongs to the function
# below that also owns its cross-field rules.
SETTINGS_SCHEMA = {"type": "object", "additionalProperties": False, "properties": {key: True for key in sorted(SETTINGS_KEYS)}}


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


def prompt_of(task: Mapping[str, Any]) -> str:
    if "prompt" not in task:
        raise LiveExecutorError(f"task {task.get('id')!r} has no prompt, which a live executor needs")
    check("task prompt", task["prompt"], PROMPT, LiveExecutorError)
    return str(task["prompt"])


def model_of(pins: Mapping[str, Any]) -> str:
    check("pins.model", pins.get("model"), MODEL_ID, LiveExecutorError)
    return str(pins["model"])


def permission_mode_of(pins: Mapping[str, Any]) -> str:
    check("pins.permission_mode", pins.get("permission_mode"), PERMISSION_MODE, LiveExecutorError)
    return str(pins["permission_mode"])


def budget_of(pins: Mapping[str, Any]) -> str:
    check("pins.max_budget_usd", pins.get("max_budget_usd"), BUDGET, LiveExecutorError)
    # Formatted by this module, so no manifest string reaches the argument.
    return f"{float(pins['max_budget_usd']):.2f}"


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
    check("pins.tools", pins.get("tools"), TOOL_LIST, LiveExecutorError)
    return [str(tool) for tool in pins["tools"]]


def _rules(where: str, values: Any, tools: list[str]) -> list[str]:
    """Rule shapes from the schema; which tool a rule may name from the pins.

    A rule for a tool the trial does not pass to `--tools` is a widening that
    the argv would not otherwise allow, and no schema can see the pins from
    inside the fragment being checked.
    """
    check(where, values, RULE_LIST, LiveExecutorError)
    for rule in values:
        name = ALLOWED_TOOL.match(rule).group("name")  # type: ignore[union-attr]
        if name not in tools:
            raise LiveExecutorError(f"{where} {rule!r} names a tool outside pins.tools")
    return [str(rule) for rule in values]


def allowed_tools_of(pins: Mapping[str, Any]) -> list[str]:
    return _rules("pins.allowed_tools", pins.get("allowed_tools"), tools_of(pins))


def credential_env_of(pins: Mapping[str, Any]) -> str:
    name = pins.get("credential_env", DEFAULT_CREDENTIAL_ENV)
    check("pins.credential_env", name, CREDENTIAL_ENV, LiveExecutorError)
    return str(name)


def _settings_env(env: Any) -> None:
    """An arm may add its own variables. It may not reach the trial's own.

    Which names those are is this package's own list, built at import from the
    trial's roots and seams, so it is a rule about the runtime rather than
    about the document and stays here.
    """
    check("arm settings.env", env, ENV_SCHEMA, LiveExecutorError)
    for name in env:
        if name in RESERVED_ENV_NAMES or name.startswith(RESERVED_ENV_PREFIXES):
            raise LiveExecutorError(f"arm settings.env may not set {name}: the trial's own roots and seams own it")


def _settings_permissions(permissions: Any, pins: Mapping[str, Any]) -> None:
    """Permission rules may narrow the flag pins. They may not widen them.

    Both widenings compare the fragment with the pins, which is outside the
    fragment a schema is checking: a default mode that disagrees with the
    pinned one, and a rule for a tool `--tools` never passes.
    """
    check("arm settings.permissions", permissions, PERMISSIONS_SCHEMA, LiveExecutorError)
    if permissions.get("defaultMode") not in (None, permission_mode_of(pins)):
        raise LiveExecutorError("arm settings.permissions.defaultMode disagrees with pins.permission_mode")
    tools = tools_of(pins)
    for key in ("allow", "ask"):
        if permissions.get(key):
            _rules(f"arm settings.permissions.{key}", permissions[key], tools)


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


def _settings_overlay(overlay: Any) -> None:
    """Paths and file text from the schema; which placeholder a file may name from this package."""
    check("arm settings.overlay", overlay, OVERLAY_SCHEMA, LiveExecutorError)
    for path, text in overlay.items():
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
    package = verifier.TASK_PACKAGES.get(str(task.get("id", "")), "")
    target = (roots.repo / package if package else roots.repo) / SETUP_PATH
    target.parent.mkdir(parents=True, exist_ok=True)
    payload = {str(task["id"]): json.loads(cases.read_text(encoding="utf-8"))}
    # `ensure_ascii=False`, because an escape here would be a leak. A task whose
    # expected value differs from the natural one by an invisible character
    # (`ambient`) hides that character in exactly the way its failure diff does:
    # escaped, the setup file would spell out the answer the run is meant to
    # cost. Every ASCII expectation is written byte for byte as it was before.
    target.write_text("// Written by the benchmark runner at launch; the test reads it through globalThis.\n" f"globalThis.__bench1Cases = {json.dumps(payload, ensure_ascii=False)};\n", encoding="utf-8")
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

    The schema states which events, which keys and which value shapes; what
    stays here is the one rule about the world rather than the document, which
    is where an `http` hook may POST. `templated` is whether the daemon
    placeholders may still stand in for values: true for the arm's declared
    fragment, false for the resolved one the child reads.
    """
    check("arm settings.hooks", hooks, HOOKS_SCHEMA, LiveExecutorError)
    for event, entries in hooks.items():
        for handler in (handler for entry in entries for handler in entry["hooks"]):
            if handler["type"] == "http":
                _hook_url(f"arm settings.hooks.{event}", handler["url"], templated)


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
    check("arm settings", settings, SETTINGS_SCHEMA, LiveExecutorError)
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


def container_environment(
    roots: artifact.TrialRoots, parent: Mapping[str, str], project_dir: str | None = None, daemon: bool = False
) -> dict[str, str]:
    """The variables the container is brought up with: the trial's own roots.

    Everything here is a value this package computed, and it is set at `up`
    rather than at exec because the image's ENTRYPOINT reads it before any
    agent runs. The credential is NOT here: it travels on the agent's exec
    alone, so it is absent from the compose override Harbor writes to disk.
    A wallet key, a shelf secret and the operator's own `CLAUDE_CONFIG_DIR`
    have no way in either, because nothing outside this list crosses, and the
    arm's `settings.env` is refused every name this function owns.

    There are no proxy variables any more. Harbor's egress control is an
    nftables redirect in a sidecar sharing the network namespace, so it
    intercepts what the trial sends whether or not the sender honours a proxy
    setting. The old design had to ask each process to opt in, and a process
    that did not reached nothing at all on an `--internal` network.
    """
    env = roots.environment(parent.get("PATH", ""))
    # The image owns PATH: `claude`, `tenjin`, `node` and `pnpm` are its.
    env.pop("PATH", None)
    if project_dir is not None:
        env[PROJECT_DIR_VAR] = project_dir_name(project_dir)
    env[container.OUTPUT_VAR] = str(roots.output)
    if daemon:
        # What the ENTRYPOINT reads to know it owns a daemon for this attempt.
        # A flag rather than an argument, because Harbor fixes the compose
        # command and the entrypoint only ever sees the keepalive.
        env[container.DAEMON_VAR] = "1"
    # Every tenjin process in the trial, the shim included: the CLI's daily npm
    # check is one request to a host no arm asked for, and the allowlist drops
    # it. The product's own opt-out keeps it from being sent at all.
    env[tenjin_arm.NO_UPDATE_CHECK] = "1"
    # The same three processes, and the reason is the same shape: an unnamed leg
    # is counted as public demand on the marketplace. The value is the run's
    # (`live_run` arms it), and it crosses here so the agent's Bash `tenjin`
    # inherits it from the container; the daemon and any daemon the shim
    # respawns get it from `docker/trial.mjs`, which forwards this name.
    caller = parent.get(tenjin_arm.CALLER_USER_AGENT)
    if caller:
        env[tenjin_arm.CALLER_USER_AGENT] = caller
    # The agent has an updater and a telemetry path of its own, and they reach
    # npm and the vendor from inside the trial. Neither is the arm's traffic.
    # The attempt's model calls are untouched: these turn off what a measured
    # run never wanted.
    env["DISABLE_AUTOUPDATER"] = "1"
    env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] = "1"
    for name in INHERITED:
        value = parent.get(name)
        if value:
            env[name] = value
    return env


def credential_seam(credential_env: str) -> tuple[str, ...]:
    """The one variable an attempt forwards, checked against the declared set."""
    if credential_env not in CREDENTIAL_ENVS:
        raise LiveExecutorError(f"{credential_env!r} is not a declared credential seam variable")
    return (credential_env,)


def package_manager() -> dict[str, Any]:
    """The pnpm a trial runs: the image's, by exact version, installed at build time."""
    return {"kind": "image", "version": images.PNPM_VERSION}


def probe_environment(roots: artifact.TrialRoots, parent: Mapping[str, str]) -> dict[str, str]:
    """What a probe inside the trial's repository copy sees: the trial's roots, no session, no credential, no egress."""
    return container_environment(roots, parent)


def build_argv(request: LaunchRequest, settings: Path, session_id: str) -> list[str]:
    """The whole command. Every flag is a literal here; every value is checked above."""
    pins = pins_for(request.pins, request.task)
    return [
        CLI,
        "-p",
        protocol.phase_prompt(request, prompt_of(request.task)),
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
    """Validate the manifest's values, write the trial's settings, and name the container that runs them.

    The whole command is one `docker run`: the trial's roots at their own paths,
    the image by id once the run has resolved it, the entrypoint that owns the
    daemon, and the agent's own argv after `--`. Nothing here starts anything,
    so a dry run builds exactly this and prints it.
    """
    if request.pins.get("speed_mode", "standard") != "standard":
        raise LiveExecutorError("Claude fast mode requires usage credits; subscription benchmarks use standard mode")
    if request.pins.get("billing_mode") == "subscription" and credential_env_of(request.pins) != "CLAUDE_CODE_OAUTH_TOKEN":
        raise LiveExecutorError("subscription benchmarks require Claude subscription OAuth, never API billing")
    provisioned = provision_of(request.arm) is not None
    settings, resolved_hash = settings_for_launch(request)
    credential_env = credential_env_of(request.pins)
    refuse_project_settings(request.roots.repo)
    session_id = root_session_id(request.trial_id, request.phase)
    path = settings_path(request.roots)
    settings = {**settings, "fastMode": False}
    if request.pins.get("billing_mode") == "subscription":
        settings["forceLoginMethod"] = "claudeai"
    path.write_text(json.dumps(settings, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    apply_overlay(request.roots, overlay_of(request.arm, request.roots))
    inject_cases(request.roots, request.task)
    agent = build_argv(request, path, session_id)
    # A resolved run passes the content-addressed name; a dry run has no daemon
    # to ask for the platform the hash covers, so it states the name's stem.
    reference = request.image or images.fixture_stem(str(request.task["id"]))
    name = container.container_name(request.trial_id, request.phase)
    plan = container.mounts(request.roots, settings=path)
    environment = container_environment(request.roots, os.environ, session_id, daemon=provisioned)
    # An attempt with an egress can reach the marketplace, so it does not start
    # unnamed. The failure this refuses is silent: the run succeeds and only the
    # marketplace's demand tables show it, so the check is here, at the seam that
    # builds the environment, rather than in a comment above it.
    if request.egress is not None and not tenjin_arm.leads_with_eval(environment.get(tenjin_arm.CALLER_USER_AGENT)):
        raise LiveExecutorError(
            f"this attempt's environment does not lead with {tenjin_arm.EVAL_PRODUCT!r} in "
            f"{tenjin_arm.CALLER_USER_AGENT}, so its public requests would count as demand"
        )
    workdir = working_dir(request.roots)
    recipe = container.Recipe(
        name=name,
        image=reference,
        workdir=workdir,
        trial_dir=request.roots.base / HARBOR_DIR,
        environment_dir=request.roots.base / HARBOR_DIR / ENVIRONMENT_DIR,
        plan=plan,
        environment=environment,
        egress=container.plan_egress(()) if request.egress is None else request.egress,
        daemon=provisioned,
        forward=credential_seam(credential_env),
    )
    return Launch(
        argv=agent,
        cwd=workdir,
        root_session_id=session_id,
        resolved_settings_hash=resolved_hash,
        package_manager=package_manager(),
        recipe=recipe,
        container_plan={
            **recipe.to_json(),
            "image": {"reference": reference, "resolved": request.image is not None},
            "user": container.user(),
            "agent": list(agent),
        },
    )


def prepare(request: ProvisionRequest) -> Provision:
    """Provision the arm. The seed probe runs the fixture's own commands in the fixture's own image."""
    if provision_of(request.arm) is None:
        raise LiveExecutorError(f"arm {request.arm.get('id')!r} declares no provision")
    # The overlay is in place before the seed probe, so the probe runs the
    # fixture as the agent will see it.
    apply_overlay(request.roots, overlay_of(request.arm, request.roots))
    if request.task is not None:
        inject_cases(request.roots, request.task)
    if request.dry_run:
        return tenjin_arm.prepare(request)
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
)

REGISTRY[NAME] = SPEC
