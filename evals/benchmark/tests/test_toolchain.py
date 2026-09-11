"""The trial's pnpm: shim detection, the pin, an offline per-trial corepack home, and the refusal."""

from __future__ import annotations

import dataclasses
import json
import os
import shutil
from pathlib import Path
from typing import Callable
from unittest import mock

import pytest

from evals.benchmark import artifact, claude_live, cli, manifest as manifest_module, records, schedule, toolchain
from evals.benchmark.claude_live import LiveExecutorError
from evals.benchmark.records import RecordError
from evals.benchmark.tests import support
from evals.benchmark.toolchain import ToolchainError

HOMEBREW_SHIM = (
    "#!/usr/bin/env node\n"
    "process.env.COREPACK_ENABLE_DOWNLOAD_PROMPT??='1'\n"
    "require('module').enableCompileCache?.();\n"
    "require('./lib/corepack.cjs').runMain(['pnpm', ...process.argv.slice(2)]);\n"
)

Binary = Callable[[str], dict[str, str]]


@pytest.fixture
def fixture(tmp_path: Path) -> Path:
    path = tmp_path / "fixture"
    path.mkdir()
    return path


@pytest.fixture
def binary(tmp_path: Path) -> Binary:
    """A `pnpm` of the given script first on PATH, with the trial's own homes."""

    def write(script: str) -> dict[str, str]:
        bin_dir = tmp_path / "bin"
        bin_dir.mkdir(exist_ok=True)
        (bin_dir / "pnpm").write_text(script, encoding="utf-8")
        (bin_dir / "pnpm").chmod(0o755)
        return {"PATH": str(bin_dir), "HOME": str(tmp_path / "home"), "COREPACK_HOME": str(tmp_path / "corepack")}

    return write


def pin(fixture: Path, value: object) -> None:
    (fixture / "package.json").write_text(json.dumps({"name": "x", "packageManager": value}), encoding="utf-8")


def test_the_pin_is_read_from_package_json_and_absent_without_one(fixture: Path) -> None:
    assert toolchain.package_manager_pin(fixture) is None
    pin(fixture, "pnpm@11.11.0")
    assert toolchain.package_manager_pin(fixture) == "11.11.0"


@pytest.mark.parametrize(
    ("value", "code"),
    [
        pytest.param(None, "pin_missing", id="unpinned"),
        pytest.param("pnpm@^11", "pin_shape", id="range"),
        pytest.param("yarn@4.0.0", "pin_shape", id="other manager"),
        pytest.param("pnpm@11.11.0+sha512.abc", "pin_shape", id="hash suffix"),
    ],
)
def test_an_unusable_pin_is_refused_by_code(fixture: Path, value: str | None, code: str) -> None:
    if value is None:
        (fixture / "package.json").write_text('{"name":"x"}', encoding="utf-8")
    else:
        pin(fixture, value)
    with pytest.raises(ToolchainError) as caught:
        toolchain.package_manager_pin(fixture)
    assert caught.value.code == code




def test_a_corepack_shim_is_told_from_a_binary_by_its_first_lines(tmp_path: Path, binary: Binary) -> None:
    assert toolchain.kind_of(toolchain.resolve(binary(HOMEBREW_SHIM)) or Path()) == "corepack-shim"
    assert toolchain.kind_of(toolchain.resolve(binary("#!/bin/sh\necho 11.11.0\n")) or Path()) == "binary"
    assert toolchain.kind_of(tmp_path / "nothing") == "missing"
    assert toolchain.resolve({"PATH": str(tmp_path / "empty")}) is None


def test_a_shim_reports_the_pin_only_when_corepack_has_it_cached(tmp_path: Path, binary: Binary) -> None:
    environ = {**binary(HOMEBREW_SHIM), **support.fake_toolchain(tmp_path, cached=("10.23.0", "11.11.0"))}
    environ["PATH"] = str(tmp_path / "bin")
    manager = toolchain.inspect(environ, "11.11.0", probe_binary=True, cwd=tmp_path)
    assert (manager.kind, manager.version, manager.cached) == ("corepack-shim", "11.11.0", ("10.23.0", "11.11.0"))
    toolchain.check(manager, "11.11.0", toolchain.corepack_home(environ))
    manager = toolchain.inspect(environ, "11.22.0", probe_binary=True, cwd=tmp_path)
    assert manager.version is None
    with pytest.raises(ToolchainError) as caught:
        toolchain.check(manager, "11.22.0", toolchain.corepack_home(environ))
    assert caught.value.code == "pnpm_uncached"
    assert "corepack install -g pnpm@11.22.0" in caught.value.detail
    assert "10.23.0, 11.11.0" in caught.value.detail


def test_a_binary_must_be_the_pinned_version_and_a_dry_run_does_not_probe_it(tmp_path: Path, binary: Binary) -> None:
    environ = binary("#!/bin/sh\necho 11.11.0\n")
    manager = toolchain.inspect(environ, "11.11.0", probe_binary=True, cwd=tmp_path)
    assert (manager.kind, manager.version) == ("binary", "11.11.0")
    toolchain.check(manager, "11.11.0", toolchain.corepack_home(environ))
    with pytest.raises(ToolchainError) as caught:
        toolchain.check(manager, "11.22.0", toolchain.corepack_home(environ))
    assert caught.value.code == "pnpm_version"
    assert "put a pnpm 11.22.0 binary first on PATH" in caught.value.detail
    with mock.patch.object(toolchain.subprocess, "run", side_effect=AssertionError("a dry run starts nothing")):
        unprobed = toolchain.inspect(environ, "11.11.0", probe_binary=False, cwd=tmp_path)
    assert (unprobed.kind, unprobed.version) == ("binary", None)
    broken = toolchain.inspect(binary("#!/bin/sh\necho not-a-version\n"), "11.11.0", probe_binary=True, cwd=tmp_path)
    assert broken.version is None


def test_no_pnpm_on_path_is_a_refusal(tmp_path: Path) -> None:
    manager = toolchain.inspect({"PATH": str(tmp_path / "empty")}, "11.11.0", probe_binary=True, cwd=tmp_path)
    assert manager.kind == "missing"
    with pytest.raises(ToolchainError) as caught:
        toolchain.check(manager, "11.11.0", tmp_path)
    assert caught.value.code == "pnpm_missing"


def test_the_corepack_home_is_the_variable_or_the_default_under_home() -> None:
    assert toolchain.corepack_home({"COREPACK_HOME": "/x"}) == Path("/x")
    assert toolchain.corepack_home({"HOME": "/h"}) == Path("/h/.cache/node/corepack")


def test_the_trial_gets_one_pinned_version_copied_and_network_off(tmp_path: Path) -> None:
    environ = support.fake_toolchain(tmp_path, cached=("10.23.0", "11.11.0"))
    destination = tmp_path / "trial" / "corepack"
    toolchain.seed(Path(environ["COREPACK_HOME"]), destination, "11.11.0")
    assert toolchain.cached_versions(destination) == ("11.11.0",)
    assert (destination / "v1" / "pnpm" / "11.11.0" / "bin" / "pnpm.cjs").is_file()
    assert toolchain.child_variables(destination) == {"COREPACK_HOME": os.path.abspath(destination), "COREPACK_ENABLE_NETWORK": "0"}


SMOKE_MANIFEST: Path
HOOKS_SMOKE_MANIFEST: Path

# What `claude_live.launch` does with the pin: seeds and records on a live
# launch, reports on a dry run, refuses a miss.


@pytest.fixture
def hooks_smoke() -> manifest_module.Manifest:
    return manifest_module.load(HOOKS_SMOKE_MANIFEST)


@pytest.fixture
def request_for(hooks_smoke: manifest_module.Manifest, tmp_path: Path) -> Callable[..., claude_live.LaunchRequest]:
    def build(dry_run: bool = False) -> claude_live.LaunchRequest:
        trial = next(trial for trial in schedule.expand(hooks_smoke) if trial.arm_id == "off")
        task = next(item for item in hooks_smoke.tasks if item["id"] == trial.task_id)
        arm = next(item for item in hooks_smoke.arms if item["id"] == trial.arm_id)
        roots = artifact.create(tmp_path / "run", trial.trial_id, hooks_smoke.fixture_path(task))
        return dataclasses.replace(claude_live.LaunchRequest(trial.trial_id, roots, task, arm, hooks_smoke.pins), dry_run=dry_run)

    return build


def test_a_live_launch_seeds_the_pinned_pnpm_and_records_what_runs(tmp_path: Path, request_for) -> None:
    environ = support.fake_toolchain(tmp_path, cached=("10.23.0", "11.11.0"))
    request = request_for()
    with mock.patch.dict(os.environ, {**environ, "CLAUDE_CODE_OAUTH_TOKEN": "not-a-real-token"}):
        launch = claude_live.launch(request)
    assert launch.package_manager == {"kind": "corepack-shim", "version": "11.11.0"}
    assert launch.env is not None
    assert launch.env["COREPACK_HOME"] == str(request.roots.corepack_home)
    assert launch.env["COREPACK_ENABLE_NETWORK"] == "0"
    assert toolchain.cached_versions(request.roots.corepack_home) == ("11.11.0",)
    assert environ["COREPACK_HOME"] not in launch.env.values()


def test_a_dry_run_reports_and_neither_seeds_nor_refuses(tmp_path: Path, request_for) -> None:
    environ = support.fake_toolchain(tmp_path, cached=("10.23.0",))
    request = request_for(dry_run=True)
    with mock.patch.dict(os.environ, environ):
        launch = claude_live.launch(request)
    assert launch.package_manager == {"kind": "corepack-shim", "version": None}
    assert not request.roots.corepack_home.exists()


def test_a_shim_without_the_pin_cached_refuses_the_launch_naming_the_fix(tmp_path: Path, request_for) -> None:
    environ = support.fake_toolchain(tmp_path, cached=("10.23.0",))
    with mock.patch.dict(os.environ, environ), pytest.raises(LiveExecutorError) as caught:
        claude_live.launch(request_for())
    assert "corepack install -g pnpm@11.11.0" in str(caught.value)


def test_an_arm_cannot_reach_corepack_through_its_settings() -> None:
    with pytest.raises(LiveExecutorError):
        claude_live._settings_env({"COREPACK_HOME": "/elsewhere"})


def test_the_cli_refuses_before_any_root_and_passes_a_pinning_fixture_with_the_pin_cached(
    tmp_path: Path, hooks_smoke: manifest_module.Manifest
) -> None:
    with pytest.raises(cli.CliError) as caught:
        cli.refuse_package_manager(hooks_smoke, support.fake_toolchain(tmp_path, cached=("10.23.0",)))
    assert "task 'actor'" in str(caught.value)
    assert "corepack install -g pnpm@11.11.0" in str(caught.value)
    shutil.rmtree(tmp_path / "toolchain")
    cli.refuse_package_manager(hooks_smoke, support.fake_toolchain(tmp_path, cached=("11.11.0",)))
    cli.refuse_package_manager(manifest_module.load(SMOKE_MANIFEST), {"PATH": str(tmp_path / "empty")})


def test_the_record_keeps_the_package_manager_in_its_isolation_block(family_session) -> None:
    record = support.attempt_record(family_session)
    record["isolation"] = {**record["isolation"], "package_manager": {"kind": "corepack-shim", "version": "11.11.0"}}
    records.validate(record)


@pytest.mark.parametrize("bad", ({"kind": "npm", "version": "1"}, {"kind": "binary"}, {"kind": "binary", "version": ""}, "corepack"))
def test_an_unreadable_package_manager_block_is_refused(family_session, bad: object) -> None:
    record = support.attempt_record(family_session)
    with pytest.raises(RecordError):
        records.validate({**record, "isolation": {**record["isolation"], "package_manager": bad}})
