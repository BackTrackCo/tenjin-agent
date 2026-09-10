"""Hidden verifiers: code-owned argv, bounded output, and four ways to fail closed."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any
from unittest import mock

import pytest

from evals.benchmark import artifact, executor, manifest as manifest_module, verifier
from evals.benchmark.manifest import ManifestError
from evals.benchmark.tests import support
from evals.benchmark.verifier import VerifierError, VerifierSpec

ACTOR_FIXTURE = verifier.HIDDEN.parent / "fixtures" / "live" / "actor"
SHELL_SHAPED = ("$(curl http://example.test)", "fake; rm -rf /", "`id`", "fake && echo", "../../bin/sh")


def _echo(length: int) -> VerifierSpec:
    program = f"print('x' * {length}); raise SystemExit(1)"
    return VerifierSpec(name="echo", argv=lambda repo: [sys.executable, "-c", program], timeout_s=30)


def _write_marker(repo: Path, name: str, **overrides: Any) -> None:
    """The marker the fixture's reporter would write for task `name`, with fields overridden."""
    marker = {"task": name, "files": [f"tests/{name}.test.mjs"], "passed": 2, "failed": 0, **overrides}
    path = verifier.marker_path(repo, name)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(marker), encoding="utf-8")


@pytest.fixture
def run_dir(tmp_path: Path) -> Path:
    return tmp_path / "run"


@pytest.fixture
def repo(run_dir: Path) -> Path:
    path = run_dir / "trials" / "trial-a" / "verify"
    path.mkdir(parents=True)
    return path


@pytest.mark.parametrize("name", ("absent", "fake_answer_file; rm -rf /", "../verifier"))
def test_an_unknown_verifier_fails_closed(name: str) -> None:
    with pytest.raises(VerifierError):
        verifier.lookup(name)


def test_the_registry_owns_argv_and_never_a_shell_string(repo: Path, run_dir: Path) -> None:
    for spec in verifier.REGISTRY.values():
        argv = spec.argv(repo)
        assert isinstance(argv, list)
        assert argv[0] == sys.executable
        assert all(isinstance(item, str) for item in argv)
    broken = VerifierSpec(name="broken", argv=lambda repo: f"python {repo}", timeout_s=5)  # type: ignore[arg-type,return-value]
    with pytest.raises(VerifierError):
        verifier.run(broken, repo, run_dir)


def test_a_target_outside_the_run_directory_fails_closed(repo: Path, run_dir: Path, tmp_path: Path) -> None:
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    spec = verifier.lookup("fake_answer_file")
    for target in (outside, run_dir / ".." / "elsewhere", repo / ".." / ".." / ".." / "elsewhere"):
        with pytest.raises(VerifierError):
            verifier.run(spec, target, run_dir)


def test_a_symlinked_target_that_escapes_fails_closed(repo: Path, run_dir: Path, tmp_path: Path) -> None:
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    (outside / "answer.txt").write_text("42\n", encoding="utf-8")
    link = run_dir / "link"
    link.symlink_to(outside, target_is_directory=True)
    with pytest.raises(VerifierError):
        verifier.run(verifier.lookup("fake_answer_file"), link, run_dir)


def test_a_missing_target_fails_closed(repo: Path, run_dir: Path) -> None:
    with pytest.raises(VerifierError):
        verifier.run(verifier.lookup("fake_answer_file"), run_dir / "absent", run_dir)


def test_pass_fail_and_undecided_are_three_outcomes(repo: Path, run_dir: Path) -> None:
    spec = verifier.lookup("fake_answer_file")
    assert verifier.run(spec, repo, run_dir).outcome == "fail"
    (repo / "answer.txt").write_text("41\n", encoding="utf-8")
    assert verifier.run(spec, repo, run_dir).outcome == "fail"
    (repo / "answer.txt").write_text("42\n", encoding="utf-8")
    verdict = verifier.run(spec, repo, run_dir)
    assert (verdict.outcome, verdict.exit_code) == ("pass", 0)
    # An exit code that is neither 0 nor 1 means the verifier could not
    # decide: the measurement broke, not the task.
    crashed = verifier.run(verifier.lookup("fake_crash"), repo, run_dir)
    assert (crashed.outcome, crashed.exit_code) == ("invalid", 3)


def test_the_verifier_process_gets_an_allowlist_not_the_operators_environment() -> None:
    parent = {
        "PATH": "/usr/bin:/bin",
        "LANG": "en_US.UTF-8",
        "TENJIN_WALLET_PRIVATE_KEY": "0xdead",
        "TENJIN_SHELF_TOKEN": "shelf-secret",
        "ANTHROPIC_API_KEY": "sk-operator-key",
        "HOME": "/Users/operator",
    }
    env = verifier.child_environment(parent)
    assert sorted(env) == ["LANG", "PATH"]
    for denied in ("TENJIN_WALLET_PRIVATE_KEY", "TENJIN_SHELF_TOKEN", "ANTHROPIC_API_KEY", "HOME"):
        assert denied not in env


def test_the_run_hands_that_allowlist_to_the_process(repo: Path, run_dir: Path) -> None:
    # The environment is not just built, it is the one the child gets.
    with mock.patch.dict(os.environ, {"TENJIN_SHELF_TOKEN": "shelf-secret"}):
        with mock.patch.object(verifier.subprocess, "run", wraps=verifier.subprocess.run) as spawned:
            verifier.run(verifier.lookup("fake_answer_file"), repo, run_dir)
    passed = spawned.call_args.kwargs["env"]
    assert "TENJIN_SHELF_TOKEN" not in passed
    assert "PATH" in passed


def test_the_node_test_verifier_decides_from_its_hidden_layer_and_fails_closed_without_it(run_dir: Path) -> None:
    spec = verifier.lookup("node_test_actor")
    roots = artifact.create(run_dir, "trial-node", ACTOR_FIXTURE)
    roots.mark_stopped()
    copy = roots.hidden_copy(spec.hidden_layer)
    # The hidden layer is on the copy and nowhere near the agent's mount.
    assert (copy / verifier.HIDDEN_TESTS / "actor.test.mjs").is_file()
    assert not (roots.repo / verifier.HIDDEN_TESTS).exists()
    unfixed = verifier.run(spec, copy, run_dir)
    assert (unfixed.outcome, unfixed.exit_code) == ("fail", 1)
    (copy / "src" / "actor.mjs").write_text("export function actorKey(session, agent) {\n  return `${session}:${agent ?? 'root'}`;\n}\n", encoding="utf-8")
    # A correct edit alone is not a pass: the named test has to have run green in the trial.
    unrun = verifier.run(spec, copy, run_dir)
    assert (unrun.outcome, unrun.exit_code) == ("fail", 1)
    assert "no run marker" in unrun.detail
    _write_marker(copy, "actor", files=["tests/actor.test.mjs"])
    assert verifier.run(spec, copy, run_dir).outcome == "pass"
    (copy / verifier.HIDDEN_TESTS / "actor.test.mjs").unlink()
    undecided = verifier.run(spec, copy, run_dir)
    assert (undecided.outcome, undecided.exit_code) == ("invalid", 3)


@pytest.mark.parametrize(
    "overrides",
    [
        pytest.param(dict(files=["tests/other.test.mjs"]), id="wrong file"),
        pytest.param(dict(files=["tests/actor.test.mjs", "unrelated/shard-1.test.mjs"]), id="the whole set"),
        pytest.param(dict(files=[]), id="no files"),
        pytest.param(dict(task="budget"), id="wrong task"),
        pytest.param(dict(passed=0), id="nothing passed"),
        pytest.param(dict(failed=1), id="a failure"),
        pytest.param(dict(passed=True), id="a boolean count"),
    ],
)
def test_a_run_marker_that_does_not_name_one_green_test_is_refused(repo: Path, overrides: dict) -> None:
    _write_marker(repo, "actor", **overrides)
    assert verifier.check_marker(repo, "actor") is not None


def test_the_run_marker_must_be_present_and_readable(repo: Path) -> None:
    assert "no run marker" in (verifier.check_marker(repo, "actor") or "")
    verifier.marker_path(repo, "actor").parent.mkdir(parents=True, exist_ok=True)
    verifier.marker_path(repo, "actor").write_text("{not json", encoding="utf-8")
    assert "not readable JSON" in (verifier.check_marker(repo, "actor") or "")
    _write_marker(repo, "actor")
    assert verifier.check_marker(repo, "actor") is None


def test_the_package_test_script_never_forwards_the_file_argument(tmp_path: Path) -> None:
    # The trap, on a fake vitest that records its argv: `pnpm test -- <file>`
    # reaches `scripts/all-tests.mjs`, and the file never reaches vitest.
    trap = tmp_path / "trap"
    (trap / "scripts").mkdir(parents=True)
    (trap / "node_modules" / "vitest").mkdir(parents=True)
    shutil.copy(ACTOR_FIXTURE / "scripts" / "all-tests.mjs", trap / "scripts" / "all-tests.mjs")
    (trap / "node_modules" / "vitest" / "vitest.mjs").write_text(
        "import { writeFileSync } from 'node:fs';\nwriteFileSync('argv.json', JSON.stringify(process.argv.slice(2)));\nprocess.exit(1);\n",
        encoding="utf-8",
    )
    completed = subprocess.run(
        ["node", "scripts/all-tests.mjs", "--", "tests/actor.test.mjs"],
        cwd=trap,
        env=verifier.child_environment(),
        capture_output=True,
        text=True,
        shell=False,
        check=False,
    )
    assert completed.returncode == 1, completed.stderr
    assert json.loads((trap / "argv.json").read_text(encoding="utf-8")) == ["run"]
    assert "not forwarded" in completed.stderr


# The honest barrier: `npx vitest` and a bare `node node_modules/vitest/...`
# reach the config with no pnpm agent and stop on a repository reason;
# `pnpm exec vitest` and `pnpm vitest` carry `npm_config_user_agent=pnpm/...`
# and load it. Importing the config is the whole check, so no vitest boots.
@pytest.mark.parametrize(
    ("through_pnpm", "extra"),
    [
        pytest.param(False, {}, id="bare node"),
        pytest.param(False, {"npm_config_user_agent": "npm/11.0.0 node/v24.0.0 darwin arm64 workspaces/false"}, id="npx"),
        pytest.param(True, {"npm_config_user_agent": "pnpm/11.0.0 npm/? node/v24.0.0 darwin arm64"}, id="pnpm"),
    ],
)
def test_the_vitest_config_refuses_a_runner_that_did_not_come_through_pnpm(tmp_path: Path, through_pnpm: bool, extra: dict) -> None:
    config = tmp_path / "config"
    config.mkdir()
    shutil.copy(ACTOR_FIXTURE / "vitest.config.mjs", config / "vitest.config.mjs")
    completed = subprocess.run(
        ["node", "--input-type=module", "-e", "await import('./vitest.config.mjs')"],
        cwd=config,
        env={**verifier.child_environment(), **extra},
        capture_output=True,
        text=True,
        shell=False,
        check=False,
    )
    if through_pnpm:
        assert completed.returncode == 0, completed.stderr
    else:
        assert completed.returncode == 1
        assert support.PNPM_GUARD_MESSAGE in completed.stderr
        assert "pnpm exec" not in completed.stderr


def _unfixed_verdict(task: str, run_dir: Path, tmp_path: Path) -> verifier.Verdict:
    live = verifier.HIDDEN.parent / "fixtures" / "live"
    spec = verifier.lookup(f"node_test_{task}")
    # The committed fixture without its dependency tree: a hidden
    # test imports the source, or the workspace package a consumer
    # imports, and never a dependency, so the 24 MB vitest tree an
    # image holds is not needed and is not copied ten times.
    copy = tmp_path / f"fixture-{task}"
    shutil.copytree(live / task, copy, ignore=shutil.ignore_patterns("node_modules"))
    roots = artifact.create(run_dir, f"trial-{task}", copy)
    support.link_workspace_packages(roots.repo)
    roots.mark_stopped()
    return verifier.run(spec, roots.hidden_copy(spec.hidden_layer), run_dir)


@pytest.mark.parametrize("task", sorted(set(verifier.TASK_PACKAGES) - set(verifier.DEPENDENT_TASKS)))
def test_every_task_verifier_fails_its_unfixed_fixture_from_its_own_hidden_layer(task: str, run_dir: Path, tmp_path: Path) -> None:
    verdict = _unfixed_verdict(task, run_dir, tmp_path)
    assert (verdict.outcome, verdict.exit_code) == ("fail", 1)


@pytest.mark.parametrize("task", sorted(verifier.DEPENDENT_TASKS))
def test_a_task_that_pins_a_third_party_package_is_judged_in_the_image_and_says_so_here(task: str, run_dir: Path, tmp_path: Path) -> None:
    """A dependent task's no-op check belongs to the image, and this states why rather than reading a red run as one.

    `upstream` hides a real behaviour of a pinned package, so its hidden test
    reaches that package through the fixture's source. Offline the copy has no
    dependency tree, so the run is red for a missing module: the same exit code
    the real verdict uses, on a fixture that was never judged. The declaration
    and the reason are asserted here so nobody reads the row above as proof.
    """
    live = verifier.HIDDEN.parent / "fixtures" / "live"
    assert _registry_dependencies(live / task), f"{task} is declared dependent but pins no registry package"
    verdict = _unfixed_verdict(task, run_dir, tmp_path)
    assert verdict.outcome == "fail"
    assert "ERR_MODULE_NOT_FOUND" in verdict.detail, verdict.detail


def _registry_dependencies(fixture: Path) -> dict[str, str]:
    """A fixture's runtime dependencies that come from the registry; a `workspace:` link is the fixture's own code."""
    declared = json.loads((fixture / "package.json").read_text(encoding="utf-8")).get("dependencies") or {}
    return {name: version for name, version in declared.items() if not version.startswith("workspace:")}


def test_only_a_fixture_that_pins_a_registry_package_is_declared_dependent() -> None:
    """The set is derived from the fixtures, so a new dependency cannot quietly opt a task out of the no-op check."""
    live = verifier.HIDDEN.parent / "fixtures" / "live"
    assert {task for task in verifier.TASK_PACKAGES if _registry_dependencies(live / task)} == set(verifier.DEPENDENT_TASKS)


def test_verifier_output_is_bounded(repo: Path, run_dir: Path) -> None:
    verdict = verifier.run(_echo(5000), repo, run_dir)
    assert verdict.outcome == "fail"
    assert len(verdict.detail) == verifier.OUTPUT_LIMIT


@pytest.fixture
def synthetic(tmp_path: Path) -> tuple[dict, Path]:
    return support.synthetic_manifest(tmp_path).data, tmp_path


@pytest.mark.parametrize("value", SHELL_SHAPED)
def test_shell_shaped_manifest_values_fail_closed(synthetic: tuple[dict, Path], value: str) -> None:
    data, directory = synthetic
    manifest_module.validate(data, directory)
    with pytest.raises(ManifestError):
        manifest_module.validate({**data, "tasks": [{**data["tasks"][0], "verifier": value}]}, directory)
    with pytest.raises(ManifestError):
        manifest_module.validate({**data, "arms": [{**data["arms"][0], "executor": value}, data["arms"][1]]}, directory)
    # Even if a value reached the registry, nothing evaluates it.
    with pytest.raises(verifier.VerifierError):
        verifier.lookup(value)
    with pytest.raises(executor.ExecutorError):
        executor.lookup(value)


@pytest.mark.parametrize("value", ("../fixture", "/etc", ""))
def test_a_fixture_path_cannot_climb_out_of_the_manifest_directory(synthetic: tuple[dict, Path], value: str) -> None:
    data, directory = synthetic
    with pytest.raises(ManifestError):
        manifest_module.validate({**data, "tasks": [{**data["tasks"][0], "fixture": value}]}, directory)
