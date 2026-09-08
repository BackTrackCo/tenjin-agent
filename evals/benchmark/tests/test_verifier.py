"""Hidden verifiers: code-owned argv, bounded output, and four ways to fail closed."""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from evals.benchmark import artifact, executor, manifest as manifest_module, verifier
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

    def test_the_verifier_process_gets_an_allowlist_not_the_operators_environment(self) -> None:
        parent = {
            "PATH": "/usr/bin:/bin",
            "LANG": "en_US.UTF-8",
            "TENJIN_WALLET_PRIVATE_KEY": "0xdead",
            "TENJIN_SHELF_TOKEN": "shelf-secret",
            "ANTHROPIC_API_KEY": "sk-operator-key",
            "HOME": "/Users/operator",
        }
        env = verifier.child_environment(parent)
        self.assertEqual(sorted(env), ["LANG", "PATH"])
        for denied in ("TENJIN_WALLET_PRIVATE_KEY", "TENJIN_SHELF_TOKEN", "ANTHROPIC_API_KEY", "HOME"):
            self.assertNotIn(denied, env)

    def test_the_run_hands_that_allowlist_to_the_process(self) -> None:
        # The environment is not just built, it is the one the child gets.
        with mock.patch.dict(os.environ, {"TENJIN_SHELF_TOKEN": "shelf-secret"}):
            with mock.patch.object(verifier.subprocess, "run", wraps=verifier.subprocess.run) as spawned:
                verifier.run(verifier.lookup("fake_answer_file"), self.repo, self.run_dir)
        passed = spawned.call_args.kwargs["env"]
        self.assertNotIn("TENJIN_SHELF_TOKEN", passed)
        self.assertIn("PATH", passed)

    def test_the_node_test_verifier_decides_from_its_hidden_layer_and_fails_closed_without_it(self) -> None:
        spec = verifier.lookup("node_test_actor")
        fixture = verifier.HIDDEN.parent / "fixtures" / "live" / "actor"
        roots = artifact.create(self.run_dir, "trial-node", fixture)
        roots.mark_stopped()
        copy = roots.hidden_copy(spec.hidden_layer)
        # The hidden layer is on the copy and nowhere near the agent's mount.
        self.assertTrue((copy / verifier.HIDDEN_TESTS / "actor.test.mjs").is_file())
        self.assertFalse((roots.repo / verifier.HIDDEN_TESTS).exists())
        unfixed = verifier.run(spec, copy, self.run_dir)
        self.assertEqual((unfixed.outcome, unfixed.exit_code), ("fail", 1))
        (copy / "src" / "actor.mjs").write_text("export function actorKey(session, agent) {\n  return `${session}:${agent ?? 'root'}`;\n}\n", encoding="utf-8")
        self.assertEqual(verifier.run(spec, copy, self.run_dir).outcome, "pass")
        (copy / verifier.HIDDEN_TESTS / "actor.test.mjs").unlink()
        undecided = verifier.run(spec, copy, self.run_dir)
        self.assertEqual((undecided.outcome, undecided.exit_code), ("invalid", 3))

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
