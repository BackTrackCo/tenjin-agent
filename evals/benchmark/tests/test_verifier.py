"""Hidden verifiers: code-owned argv, bounded output, and four ways to fail closed."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path
from unittest import mock

import pytest

from evals.benchmark import executor, manifest as manifest_module, verifier
from evals.benchmark.manifest import ManifestError
from evals.benchmark.tests import support
from evals.benchmark.verifier import VerifierError, VerifierSpec

SHELL_SHAPED = ("$(curl http://example.test)", "fake; rm -rf /", "`id`", "fake && echo", "../../bin/sh")


def _echo(length: int) -> VerifierSpec:
    program = f"print('x' * {length}); raise SystemExit(1)"
    return VerifierSpec(name="echo", argv=lambda repo: [sys.executable, "-c", program], timeout_s=30)


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
