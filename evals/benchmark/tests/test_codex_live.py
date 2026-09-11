"""The subscription Codex boundary, without starting a model or using credentials."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from evals.benchmark import artifact, codex_live, executor, images, sha256_json

PINS = {"model": "gpt-5.6-sol", "harness_version": "0.154.0", "permission_mode": "workspace-write",
        "credential_env": "CODEX_BENCH_AUTH_FILE", "agent_package": "@openai/codex",
        "billing_mode": "subscription", "effort": "low", "speed_mode": "fast",
        "turn_budget": None, "concurrency": 1, "tools": ["Bash", "Read", "Edit"]}


def request(tmp_path):
    fixture = tmp_path / "fixture"
    fixture.mkdir()
    (fixture / "CLAUDE.md").write_text("Run the task's tests.\n")
    roots = artifact.create(tmp_path / "run", "trial", fixture)
    return executor.LaunchRequest("trial", roots, {"id": "toy", "prompt": "Fix the failing test."},
        {"settings": {}, "settings_hash": "sha256:" + sha256_json({})}, PINS, dry_run=True)


def test_codex_plan_has_only_subscription_auth_and_generated_configuration(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "must-not-cross")
    item = request(tmp_path)
    result = codex_live.launch(item)
    assert result.argv[:3] == ["codex", "exec", "--json"]
    assert result.recipe.forward == ()
    assert "OPENAI_API_KEY" not in result.recipe.environment
    config = (item.roots.profile / "config.toml").read_text()
    assert 'model = "gpt-5.6-sol"' in config
    assert 'forced_login_method = "chatgpt"' in config
    assert 'service_tier = "fast"' in config
    assert 'use_legacy_landlock = true' in config
    assert {mount.target.name for mount in result.recipe.plan if mount.mode == 'ro'} >= {'.git', '.codex', '.agents'}
    assert (item.roots.repo / "AGENTS.md").read_text() == "Run the task's tests.\n"
    assert (item.roots.profile / "auth.json").read_bytes() == b""
    assert executor.lookup("codex_live") is codex_live.SPEC


@pytest.mark.parametrize("change", [
    {"model": "gpt-5.6"}, {"credential_env": "OPENAI_API_KEY"}, {"billing_mode": "credits"},
    {"agent_package": "arbitrary"}, {"turn_budget": 30}, {"concurrency": 2}, {"effort": "ultra"},
])
def test_codex_refuses_changes_outside_subscription_protocol(change):
    with pytest.raises(executor.ExecutorError):
        codex_live.validate_pins({**PINS, **change})


def test_auth_only_file_is_external_private_and_chatgpt(tmp_path, monkeypatch):
    roots = request(tmp_path).roots
    auth = tmp_path / "auth.json"
    auth.write_text(json.dumps({"auth_mode": "chatgpt", "tokens": {"access_token": "synthetic"}}))
    auth.chmod(0o600)
    monkeypatch.setenv(codex_live.AUTH_ENV, str(auth))
    assert codex_live.auth_path(roots) == auth
    auth.chmod(0o644)
    with pytest.raises(executor.ExecutorError, match="private"):
        codex_live.auth_path(roots)
    auth.chmod(0o600)
    auth.write_text(json.dumps({"auth_mode": "apikey", "OPENAI_API_KEY": "synthetic"}))
    with pytest.raises(executor.ExecutorError, match="API-key"):
        codex_live.auth_path(roots)


def test_project_configuration_cannot_override_subscription_profile(tmp_path):
    item = request(tmp_path)
    (item.roots.repo / ".codex").mkdir()
    with pytest.raises(executor.ExecutorError, match="override"):
        codex_live.launch(item)


def test_codex_image_pins_the_cli_without_changing_model():
    args = images.build_args(PINS)
    assert args["AGENT_PACKAGE"] == "@openai/codex"
    assert args["AGENT_VERSION"] == "0.154.0"
    assert args["AGENT_COMMAND"] == "codex"
    with pytest.raises(images.ImageError):
        images.build_args({**PINS, "agent_package": "other"})


def test_native_stream_excludes_harbor_merged_stderr(tmp_path, monkeypatch):
    from evals.benchmark import container, runner
    item = request(tmp_path)
    launch = codex_live.launch(item)
    class Box:
        def __init__(self, **kwargs):
            pass
        def __enter__(self):
            return self
        def __exit__(self, *args):
            pass
        def exec(self, command, **kwargs):
            assert command[:2] == ["bash", "-c"]
            assert kwargs["stream"] is None
            (item.roots.output / "command.stdout").write_text('{"type":"thread.started","thread_id":"native-root"}\n')
            (item.roots.output / "command.stderr").write_text("native CLI diagnostic\n")
            return container.Completed(returncode=0, stdout="compose diagnostic", stderr="")
    monkeypatch.setattr(container, "Container", Box)
    monkeypatch.setattr(container, "daemon_error", lambda output: None)
    monkeypatch.setattr(container, "stop", lambda name: None)
    result = runner.container_spawn(launch, item.roots, 5)
    assert json.loads(item.roots.stream.read_text())["thread_id"] == "native-root"
    assert result.stderr == "native CLI diagnostic\n"
