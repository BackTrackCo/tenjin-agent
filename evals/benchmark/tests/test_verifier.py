"""Hidden verifiers: code-owned argv, bounded output, and four ways to fail closed."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

from evals.benchmark import executor, manifest as manifest_module, verifier
from evals.benchmark.manifest import ManifestError
from evals.benchmark.tests import support
from evals.benchmark.verifier import VerifierError, VerifierSpec


def _echo(length: int) -> VerifierSpec:
    program = f"print('x' * {length}); raise SystemExit(1)"
    return VerifierSpec(name="echo", argv=lambda repo: [sys.executable, "-c", program], timeout_s=30)


class VerifierRegistryTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)
        self.run_dir = self.dir / "run"
        self.repo = self.run_dir / "trials" / "trial-a" / "verify"
        self.repo.mkdir(parents=True)

    def test_an_unknown_verifier_fails_closed(self) -> None:
        for name in ("absent", "fake_answer_file; rm -rf /", "../verifier"):
            with self.subTest(name=name), self.assertRaises(VerifierError):
                verifier.lookup(name)

    def test_the_registry_owns_argv_and_never_a_shell_string(self) -> None:
        for spec in verifier.REGISTRY.values():
            argv = spec.argv(self.repo)
            self.assertIsInstance(argv, list)
            self.assertEqual(argv[0], sys.executable)
            self.assertTrue(all(isinstance(item, str) for item in argv))
        broken = VerifierSpec(name="broken", argv=lambda repo: f"python {repo}", timeout_s=5)  # type: ignore[arg-type,return-value]
        with self.assertRaises(VerifierError):
            verifier.run(broken, self.repo, self.run_dir)

    def test_a_target_outside_the_run_directory_fails_closed(self) -> None:
        outside = self.dir / "elsewhere"
        outside.mkdir()
        spec = verifier.lookup("fake_answer_file")
        for target in (outside, self.run_dir / ".." / "elsewhere", self.repo / ".." / ".." / ".." / "elsewhere"):
            with self.subTest(target=str(target)), self.assertRaises(VerifierError):
                verifier.run(spec, target, self.run_dir)

    def test_a_symlinked_target_that_escapes_fails_closed(self) -> None:
        outside = self.dir / "elsewhere"
        outside.mkdir()
        (outside / "answer.txt").write_text("42\n", encoding="utf-8")
        link = self.run_dir / "link"
        link.symlink_to(outside, target_is_directory=True)
        with self.assertRaises(VerifierError):
            verifier.run(verifier.lookup("fake_answer_file"), link, self.run_dir)

    def test_a_missing_target_fails_closed(self) -> None:
        with self.assertRaises(VerifierError):
            verifier.run(verifier.lookup("fake_answer_file"), self.run_dir / "absent", self.run_dir)

    def test_pass_fail_and_undecided_are_three_outcomes(self) -> None:
        spec = verifier.lookup("fake_answer_file")
        self.assertEqual(verifier.run(spec, self.repo, self.run_dir).outcome, "fail")
        (self.repo / "answer.txt").write_text("41\n", encoding="utf-8")
        self.assertEqual(verifier.run(spec, self.repo, self.run_dir).outcome, "fail")
        (self.repo / "answer.txt").write_text("42\n", encoding="utf-8")
        verdict = verifier.run(spec, self.repo, self.run_dir)
        self.assertEqual((verdict.outcome, verdict.exit_code), ("pass", 0))
        # An exit code that is neither 0 nor 1 means the verifier could not
        # decide: the measurement broke, not the task.
        crashed = verifier.run(verifier.lookup("fake_crash"), self.repo, self.run_dir)
        self.assertEqual((crashed.outcome, crashed.exit_code), ("invalid", 3))

    def test_verifier_output_is_bounded(self) -> None:
        verdict = verifier.run(_echo(5000), self.repo, self.run_dir)
        self.assertEqual(verdict.outcome, "fail")
        self.assertEqual(len(verdict.detail), verifier.OUTPUT_LIMIT)


class ShellShapedManifestTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)
        self.data = support.synthetic_manifest(self.dir).data

    def test_shell_shaped_manifest_values_fail_closed(self) -> None:
        manifest_module.validate(self.data, self.dir)
        shell_shaped = ("$(curl http://example.test)", "fake; rm -rf /", "`id`", "fake && echo", "../../bin/sh")
        for value in shell_shaped:
            with self.subTest(value=value):
                task = {**self.data["tasks"][0], "verifier": value}
                with self.assertRaises(ManifestError):
                    manifest_module.validate({**self.data, "tasks": [task]}, self.dir)
                arm = {**self.data["arms"][0], "executor": value}
                with self.assertRaises(ManifestError):
                    manifest_module.validate({**self.data, "arms": [arm, self.data["arms"][1]]}, self.dir)
                # Even if a value reached the registry, nothing evaluates it.
                with self.assertRaises(verifier.VerifierError):
                    verifier.lookup(value)
                with self.assertRaises(executor.ExecutorError):
                    executor.lookup(value)

    def test_a_fixture_path_cannot_climb_out_of_the_manifest_directory(self) -> None:
        for value in ("../fixture", "/etc", ""):
            with self.subTest(value=value):
                task = {**self.data["tasks"][0], "fixture": value}
                with self.assertRaises(ManifestError):
                    manifest_module.validate({**self.data, "tasks": [task]}, self.dir)


if __name__ == "__main__":
    unittest.main()
