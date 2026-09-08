"""Hidden verifiers: code-owned argv, bounded output, and four ways to fail closed."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest import mock

from evals.benchmark import artifact, executor, manifest as manifest_module, verifier
from evals.benchmark.manifest import ManifestError
from evals.benchmark.tests import support
from evals.benchmark.verifier import VerifierError, VerifierSpec


def _echo(length: int) -> VerifierSpec:
    program = f"print('x' * {length}); raise SystemExit(1)"
    return VerifierSpec(name="echo", argv=lambda repo: [sys.executable, "-c", program], timeout_s=30)


def _write_marker(repo: Path, name: str, **overrides: Any) -> None:
    """The marker the fixture's reporter would write for task `name`, with fields overridden."""
    marker = {"task": name, "files": [f"tests/{name}.test.mjs"], "passed": 2, "failed": 0, **overrides}
    path = verifier.marker_path(repo, name)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(marker), encoding="utf-8")


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
        # A correct edit alone is not a pass: the named test has to have run green in the trial.
        unrun = verifier.run(spec, copy, self.run_dir)
        self.assertEqual((unrun.outcome, unrun.exit_code), ("fail", 1))
        self.assertIn("no run marker", unrun.detail)
        _write_marker(copy, "actor", files=["tests/actor.test.mjs"])
        self.assertEqual(verifier.run(spec, copy, self.run_dir).outcome, "pass")
        (copy / verifier.HIDDEN_TESTS / "actor.test.mjs").unlink()
        undecided = verifier.run(spec, copy, self.run_dir)
        self.assertEqual((undecided.outcome, undecided.exit_code), ("invalid", 3))

    def test_the_run_marker_must_name_exactly_the_one_test_and_a_green_run(self) -> None:
        self.assertIn("no run marker", verifier.check_marker(self.repo, "actor") or "")
        cases = {
            "wrong file": dict(files=["tests/other.test.mjs"]),
            "the whole set": dict(files=["tests/actor.test.mjs", "unrelated/shard-1.test.mjs"]),
            "no files": dict(files=[]),
            "wrong task": dict(task="budget"),
            "nothing passed": dict(passed=0),
            "a failure": dict(failed=1),
            "a boolean count": dict(passed=True),
        }
        for name, overrides in cases.items():
            with self.subTest(case=name):
                _write_marker(self.repo, "actor", **overrides)
                self.assertIsNotNone(verifier.check_marker(self.repo, "actor"))
        verifier.marker_path(self.repo, "actor").write_text("{not json", encoding="utf-8")
        self.assertIn("not readable JSON", verifier.check_marker(self.repo, "actor") or "")
        _write_marker(self.repo, "actor")
        self.assertIsNone(verifier.check_marker(self.repo, "actor"))
        # A TypeScript test file is the same one file; a workspace package's marker lives under the package.
        _write_marker(self.repo, "alias", files=["tests/alias.test.ts"])
        self.assertIsNone(verifier.check_marker(self.repo, "alias"))
        self.assertIn("packages/core/.bench1", verifier.check_marker(self.repo, "core", "packages/core") or "")
        package = self.repo / "packages" / "core"
        package.mkdir(parents=True)
        _write_marker(package, "core")
        self.assertIsNone(verifier.check_marker(self.repo, "core", "packages/core"))
        self.assertIsNotNone(verifier.check_marker(self.repo, "core"))
        self.assertIn("--package", verifier.lookup("node_test_core").argv(self.repo))

    def test_the_package_test_script_never_forwards_the_file_argument(self) -> None:
        # The trap, on a fake vitest that records its argv: `pnpm test -- <file>`
        # reaches `scripts/all-tests.mjs`, and the file never reaches vitest.
        fixture = verifier.HIDDEN.parent / "fixtures" / "live" / "actor"
        trap = self.dir / "trap"
        (trap / "scripts").mkdir(parents=True)
        (trap / "node_modules" / "vitest").mkdir(parents=True)
        shutil.copy(fixture / "scripts" / "all-tests.mjs", trap / "scripts" / "all-tests.mjs")
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
        self.assertEqual(completed.returncode, 1, completed.stderr)
        self.assertEqual(json.loads((trap / "argv.json").read_text(encoding="utf-8")), ["run"])
        self.assertIn("not forwarded", completed.stderr)

    def test_the_vitest_config_refuses_a_runner_that_did_not_come_through_pnpm(self) -> None:
        # The honest barrier: `npx vitest` and a bare `node node_modules/vitest/...`
        # reach the config with no pnpm agent and stop on a repository reason;
        # `pnpm exec vitest` and `pnpm vitest` carry `npm_config_user_agent=pnpm/...`
        # and load it. Importing the config is the whole check, so no vitest boots.
        fixture = verifier.HIDDEN.parent / "fixtures" / "live" / "actor"
        config = self.dir / "config"
        config.mkdir()
        shutil.copy(fixture / "vitest.config.mjs", config / "vitest.config.mjs")
        cases = {
            "bare node": {},
            "npx": {"npm_config_user_agent": "npm/11.0.0 node/v24.0.0 darwin arm64 workspaces/false"},
            "pnpm": {"npm_config_user_agent": "pnpm/11.0.0 npm/? node/v24.0.0 darwin arm64"},
        }
        for name, extra in cases.items():
            with self.subTest(runner=name):
                completed = subprocess.run(
                    ["node", "--input-type=module", "-e", "await import('./vitest.config.mjs')"],
                    cwd=config,
                    env={**verifier.child_environment(), **extra},
                    capture_output=True,
                    text=True,
                    shell=False,
                    check=False,
                )
                if name == "pnpm":
                    self.assertEqual(completed.returncode, 0, completed.stderr)
                else:
                    self.assertEqual(completed.returncode, 1)
                    self.assertIn(support.PNPM_GUARD_MESSAGE, completed.stderr)
                    self.assertNotIn("pnpm exec", completed.stderr)

    def test_every_task_verifier_fails_its_unfixed_fixture_from_its_own_hidden_layer(self) -> None:
        live = verifier.HIDDEN.parent / "fixtures" / "live"
        for task, package in verifier.TASK_PACKAGES.items():
            with self.subTest(task=task):
                spec = verifier.lookup(f"node_test_{task}")
                # Only the unfixed source matters here; the 24 MB vitest tree is not copied eight times.
                source_only = self.dir / f"source-{task}"
                source = (live / task / package if package else live / task) / "src"
                shutil.copytree(source, (source_only / package if package else source_only) / "src")
                roots = artifact.create(self.run_dir, f"trial-{task}", source_only)
                roots.mark_stopped()
                verdict = verifier.run(spec, roots.hidden_copy(spec.hidden_layer), self.run_dir)
                self.assertEqual((verdict.outcome, verdict.exit_code), ("fail", 1))

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
