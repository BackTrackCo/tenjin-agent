"""Subscription-only Codex launch on the shared Harbor container boundary."""
from __future__ import annotations

import json
import os
from pathlib import Path
import selectors
import shlex
import subprocess
import time

from . import claude_live, codex_usage, container, images, sha256_json, tenjin_arm
from .executor import REGISTRY, ExecutorError, ExecutorSpec, Launch, LaunchRequest

NAME = "codex_live"
AUTH_ENV = "CODEX_BENCH_AUTH_FILE"
ORIGINS = ("chatgpt.com", "auth.openai.com")
EVENTS = ("SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "SubagentStart", "SubagentStop", "Stop")


def validate_pins(pins):
    required = {"model": codex_usage.MODEL, "harness_version": codex_usage.VERSION,
                "permission_mode": "workspace-write", "credential_env": AUTH_ENV,
                "agent_package": "@openai/codex", "billing_mode": "subscription"}
    if any(pins.get(key) != value for key, value in required.items()):
        raise ExecutorError("Codex requires the pinned Sol model, CLI, subscription auth and workspace sandbox")
    if pins.get("effort") not in {"low", "medium", "high", "xhigh", "max"}:
        raise ExecutorError("Codex reasoning effort must be explicit; ultra delegates outside the core protocol")
    if pins.get("turn_budget") is not None or pins.get("max_budget_usd") is not None:
        raise ExecutorError("Codex has no Claude turn/dollar cap; declare null and use the shared wall-clock cap")
    if pins.get("concurrency", 1) != 1:
        raise ExecutorError("one managed subscription credential requires a serialized Codex job stream")
    if pins.get("speed_mode", "standard") not in {"standard", "fast"}:
        raise ExecutorError("unknown Codex speed mode")


def credential_seam(pins):
    validate_pins(pins)
    return AUTH_ENV


def auth_path(roots, *, dry_run=False):
    if dry_run:
        return roots.run_dir.parent / "subscription-auth" / "auth.json"
    value = os.environ.get(AUTH_ENV)
    if not value:
        raise ExecutorError(f"{AUTH_ENV} must name an auth-only subscription file outside the run")
    path = Path(value).resolve()
    if path.is_relative_to(roots.run_dir.resolve()) or not path.is_file() or path.stat().st_mode & 0o077:
        raise ExecutorError("subscription auth must be a private 0600 file outside benchmark artifacts")
    try:
        auth = json.loads(path.read_text())
    except (OSError, ValueError) as error:
        raise ExecutorError("subscription auth file is unreadable") from error
    if auth.get("auth_mode") != "chatgpt" or auth.get("OPENAI_API_KEY") or not (auth.get("tokens") or {}).get("access_token"):
        raise ExecutorError("benchmark refuses API-key or non-ChatGPT authentication")
    return path


def hooks(roots):
    command = "node " + shlex.quote(str(roots.data_dir / tenjin_arm.HOOKS_DIR / tenjin_arm.SHIM_BUNDLE)) + " --harness codex"
    return {"hooks": {event: [{**({"matcher": "Bash|apply_patch"} if event == "PreToolUse" else {"matcher": "Bash"} if event == "PostToolUse" else {}),
                              "hooks": [{"type": "command", "command": command, "timeout": 5}]}] for event in EVENTS}}


def trust_hooks(roots, expected):
    """Ask the pinned native catalog for identities; trust only our exact handlers.

    The profile has no auth file on the host. The native process only lists and
    writes hook settings, never starts a model. Container mount paths are the
    same absolute paths, so its hook catalog sees the same trusted identities.
    """
    env = {"PATH": os.environ.get("PATH", ""), "HOME": str(roots.home), "CODEX_HOME": str(roots.profile)}
    version = subprocess.run(["codex", "--version"], env=env, capture_output=True, text=True, timeout=10, check=True)
    if version.stdout.strip() != f"codex-cli {codex_usage.VERSION}":
        raise ExecutorError("native hook trust setup requires the pinned Codex CLI")
    process = subprocess.Popen(["codex", "app-server"], cwd=roots.repo, env=env, stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    sequence = 0
    def rpc(method, params):
        nonlocal sequence
        sequence += 1
        process.stdin.write(json.dumps({"id": sequence, "method": method, "params": params}) + "\n")
        process.stdin.flush()
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if not selector.select(max(0, deadline - time.monotonic())):
                break
            line = process.stdout.readline()
            if not line:
                raise ExecutorError("native hook catalog exited before replying")
            reply = json.loads(line)
            if reply.get("id") == sequence:
                if "error" in reply:
                    raise ExecutorError("native hook catalog refused the configuration")
                return reply["result"]
        raise ExecutorError("native hook catalog did not answer before its deadline")
    def catalog():
        result = rpc("hooks/list", {"cwds": [str(roots.repo)]})
        if len(result["data"]) != 1 or result["data"][0]["errors"]:
            raise ExecutorError("generated Codex hook configuration was not accepted")
        found = result["data"][0]["hooks"]
        wanted = {(event[0].lower() + event[1:], entries[0].get("matcher"), entries[0]["hooks"][0]["command"]) for event, entries in expected["hooks"].items()}
        if len(found) != len(wanted) or {(item["eventName"], item.get("matcher"), item.get("command")) for item in found} != wanted:
            raise ExecutorError("native hook catalog differs from the benchmark's generated handlers")
        if any(Path(item["sourcePath"]).resolve() != (roots.profile / "hooks.json").resolve() or item["handlerType"] != "command" for item in found):
            raise ExecutorError("refusing to trust a hook from outside the generated profile")
        return found
    try:
        rpc("initialize", {"clientInfo": {"name": "tenjin-benchmark", "version": "1"}, "capabilities": {"experimentalApi": True}})
        process.stdin.write('{"method":"initialized"}\n'); process.stdin.flush()
        found = catalog()
        rpc("config/batchWrite", {"edits": [{"keyPath": "hooks.state", "mergeStrategy": "upsert",
             "value": {item["key"]: {"trusted_hash": item["currentHash"]} for item in found}}]})
        if any(item["trustStatus"] != "trusted" for item in catalog()):
            raise ExecutorError("native hook trust was not persisted")
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill(); process.wait(timeout=5)
        selector.close()


def launch(request: LaunchRequest) -> Launch:
    validate_pins(request.pins)
    roots, pins = request.roots, request.pins
    if any(path.name == ".codex" for path in roots.repo.rglob(".codex")):
        raise ExecutorError("fixtures may not override the generated Codex configuration")
    instructions = roots.repo / "CLAUDE.md"
    if instructions.is_file():
        target_instructions = roots.repo / "AGENTS.md"
        if target_instructions.exists():
            raise ExecutorError("fixture carries conflicting harness instruction files")
        target_instructions.write_text(instructions.read_text())
    settings = claude_live.settings_of(request.arm, pins)
    if settings.get("env"):
        raise ExecutorError("Codex benchmark arms may not override the generated process environment")
    overlay = claude_live.overlay_of(request.arm, roots)
    if "CLAUDE.md" in overlay:
        overlay = {("AGENTS.md" if key == "CLAUDE.md" else key): value for key, value in overlay.items()}
    claude_live.apply_overlay(roots, overlay)
    claude_live.inject_cases(roots, request.task)
    provisioned = request.provision is not None
    auth = auth_path(roots, dry_run=request.dry_run)
    allow_agents = "Agent" in request.task.get("tools", pins.get("tools", []))
    protected = [roots.repo / name for name in (".git", ".codex", ".agents")]
    for path in protected:
        path.mkdir(exist_ok=True)
    config = '\n'.join([
        'model = "gpt-5.6-sol"', f'model_reasoning_effort = {json.dumps(pins["effort"])}',
        f'service_tier = {json.dumps("fast" if pins.get("speed_mode") == "fast" else "default")}',
        'approval_policy = "never"', 'sandbox_mode = "workspace-write"',
        'forced_login_method = "chatgpt"',
        'cli_auth_credentials_store = "file"', 'web_search = "disabled"',
        '[sandbox_workspace_write]', 'network_access = true',
        '[features]', f'hooks = {str(provisioned).lower()}',
        'use_legacy_landlock = true',
        f'fast_mode = {str(pins.get("speed_mode") == "fast").lower()}',
        f'multi_agent = {str(allow_agents).lower()}', '',
    ])
    (roots.profile / "config.toml").write_text(config)
    generated = hooks(roots) if provisioned else {"hooks": {}}
    (roots.profile / "hooks.json").write_text(json.dumps(generated) + "\n")
    if provisioned and not request.dry_run:
        trust_hooks(roots, generated)
    # Empty host placeholder only. Docker overlays the separately retained
    # auth file; collecting profile artifacts never copies the credential.
    target = roots.profile / "auth.json"
    target.touch(mode=0o600)
    environment = claude_live.container_environment(roots, os.environ, daemon=provisioned)
    environment.pop("CLAUDE_CONFIG_DIR", None)
    environment["CODEX_HOME"] = str(roots.profile)
    recipe = container.Recipe(
        name=container.container_name(request.trial_id, request.phase),
        image=request.image or images.fixture_stem(request.task["id"]), workdir=roots.repo,
        trial_dir=roots.base / claude_live.HARBOR_DIR,
        environment_dir=roots.base / claude_live.HARBOR_DIR / claude_live.ENVIRONMENT_DIR,
        plan=[*container.mounts(roots), container.Mount(auth, target),
              *(container.Mount(path, path, "ro") for path in protected)], environment=environment,
        egress=request.egress or container.plan_egress(()), daemon=provisioned,
    )
    argv = ["codex", "exec", "--json", "--strict-config", "--ignore-rules", "--skip-git-repo-check",
            "--sandbox", "workspace-write", "-m", codex_usage.MODEL, "-C", str(roots.repo), claude_live.prompt_of(request.task)]
    return Launch(argv, roots.repo, "pending-" + request.trial_id, recipe=recipe, separate_streams=True,
                  resolved_settings_hash="sha256:" + sha256_json({"config": config, "hooks": generated}),
                  package_manager=claude_live.package_manager(), container_plan={**recipe.to_json(), "agent": argv})


SPEC = ExecutorSpec(name=NAME, harness="codex", launch=launch, live=True, required_origins=ORIGINS,
    sessions=lambda roots, root: roots.profile / "sessions", credential_seam=credential_seam,
    prepare=claude_live.prepare, stop=tenjin_arm.stop, evidence=codex_usage.EVIDENCE)
REGISTRY[NAME] = SPEC
