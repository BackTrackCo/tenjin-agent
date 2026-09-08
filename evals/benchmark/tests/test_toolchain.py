"""The trial's pnpm: shim detection, the pin, an offline per-trial corepack home, and the refusal."""

from __future__ import annotations

import dataclasses
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

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


class ToolchainCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)
        self.fixture = self.dir / "fixture"
        self.fixture.mkdir()

    def pin(self, value: object) -> None:
        (self.fixture / "package.json").write_text(json.dumps({"name": "x", "packageManager": value}), encoding="utf-8")

    def binary(self, script: str) -> dict[str, str]:
        bin_dir = self.dir / "bin"
        bin_dir.mkdir(exist_ok=True)
        (bin_dir / "pnpm").write_text(script, encoding="utf-8")
        (bin_dir / "pnpm").chmod(0o755)
        return {"PATH": str(bin_dir), "HOME": str(self.dir / "home"), "COREPACK_HOME": str(self.dir / "corepack")}


class PinTest(ToolchainCase):
    def test_the_pin_is_read_from_package_json_and_absent_without_one(self) -> None:
        self.assertIsNone(toolchain.package_manager_pin(self.fixture))
        self.pin("pnpm@11.11.0")
        self.assertEqual(toolchain.package_manager_pin(self.fixture), "11.11.0")
        for name, value in (("unpinned", None), ("range", "pnpm@^11"), ("other manager", "yarn@4.0.0"), ("hash suffix", "pnpm@11.11.0+sha512.abc")):
            with self.subTest(name):
                if value is None:
                    (self.fixture / "package.json").write_text('{"name":"x"}', encoding="utf-8")
                else:
                    self.pin(value)
                with self.assertRaises(ToolchainError) as caught:
                    toolchain.package_manager_pin(self.fixture)
                self.assertEqual(caught.exception.code, "pin_missing" if value is None else "pin_shape")

    def test_every_live_fixture_pins_the_validated_pnpm(self) -> None:
        manifest = manifest_module.load(cli.HOOKS_SMOKE_MANIFEST)
        for task in manifest.tasks:
            self.assertEqual(toolchain.package_manager_pin(manifest.fixture_path(task)), "11.11.0")
        smoke = manifest_module.load(cli.SMOKE_MANIFEST)
        self.assertIsNone(toolchain.package_manager_pin(smoke.fixture_path(smoke.tasks[0])))


class DetectionTest(ToolchainCase):
    def test_a_corepack_shim_is_told_from_a_binary_by_its_first_lines(self) -> None:
        environ = self.binary(HOMEBREW_SHIM)
        self.assertEqual(toolchain.kind_of(toolchain.resolve(environ) or Path()), "corepack-shim")
        environ = self.binary("#!/bin/sh\necho 11.11.0\n")
        self.assertEqual(toolchain.kind_of(toolchain.resolve(environ) or Path()), "binary")
        self.assertEqual(toolchain.kind_of(self.dir / "nothing"), "missing")
        self.assertIsNone(toolchain.resolve({"PATH": str(self.dir / "empty")}))

    def test_a_shim_reports_the_pin_only_when_corepack_has_it_cached(self) -> None:
        environ = {**self.binary(HOMEBREW_SHIM), **support.fake_toolchain(self.dir, cached=("10.23.0", "11.11.0"))}
        environ["PATH"] = str(self.dir / "bin")
        manager = toolchain.inspect(environ, "11.11.0", probe_binary=True, cwd=self.dir)
        self.assertEqual((manager.kind, manager.version, manager.cached), ("corepack-shim", "11.11.0", ("10.23.0", "11.11.0")))
        toolchain.check(manager, "11.11.0", toolchain.corepack_home(environ))
        manager = toolchain.inspect(environ, "11.22.0", probe_binary=True, cwd=self.dir)
        self.assertIsNone(manager.version)
        with self.assertRaises(ToolchainError) as caught:
            toolchain.check(manager, "11.22.0", toolchain.corepack_home(environ))
        self.assertEqual(caught.exception.code, "pnpm_uncached")
        self.assertIn("corepack install -g pnpm@11.22.0", caught.exception.detail)
        self.assertIn("10.23.0, 11.11.0", caught.exception.detail)

    def test_a_binary_must_be_the_pinned_version_and_a_dry_run_does_not_probe_it(self) -> None:
        environ = self.binary("#!/bin/sh\necho 11.11.0\n")
        manager = toolchain.inspect(environ, "11.11.0", probe_binary=True, cwd=self.dir)
        self.assertEqual((manager.kind, manager.version), ("binary", "11.11.0"))
        toolchain.check(manager, "11.11.0", toolchain.corepack_home(environ))
        with self.assertRaises(ToolchainError) as caught:
            toolchain.check(manager, "11.22.0", toolchain.corepack_home(environ))
        self.assertEqual(caught.exception.code, "pnpm_version")
        self.assertIn("put a pnpm 11.22.0 binary first on PATH", caught.exception.detail)
        with mock.patch.object(toolchain.subprocess, "run", side_effect=AssertionError("a dry run starts nothing")):
            unprobed = toolchain.inspect(environ, "11.11.0", probe_binary=False, cwd=self.dir)
        self.assertEqual((unprobed.kind, unprobed.version), ("binary", None))
        broken = toolchain.inspect(self.binary("#!/bin/sh\necho not-a-version\n"), "11.11.0", probe_binary=True, cwd=self.dir)
        self.assertIsNone(broken.version)

    def test_no_pnpm_on_path_is_a_refusal(self) -> None:
        manager = toolchain.inspect({"PATH": str(self.dir / "empty")}, "11.11.0", probe_binary=True, cwd=self.dir)
        self.assertEqual(manager.kind, "missing")
        with self.assertRaises(ToolchainError) as caught:
            toolchain.check(manager, "11.11.0", self.dir)
        self.assertEqual(caught.exception.code, "pnpm_missing")

    def test_the_corepack_home_is_the_variable_or_the_default_under_home(self) -> None:
        self.assertEqual(toolchain.corepack_home({"COREPACK_HOME": "/x"}), Path("/x"))
        self.assertEqual(toolchain.corepack_home({"HOME": "/h"}), Path("/h/.cache/node/corepack"))


class SeedTest(ToolchainCase):
    def test_the_trial_gets_one_pinned_version_copied_and_network_off(self) -> None:
        environ = support.fake_toolchain(self.dir, cached=("10.23.0", "11.11.0"))
        destination = self.dir / "trial" / "corepack"
        toolchain.seed(Path(environ["COREPACK_HOME"]), destination, "11.11.0")
        self.assertEqual(toolchain.cached_versions(destination), ("11.11.0",))
        self.assertTrue((destination / "v1" / "pnpm" / "11.11.0" / "bin" / "pnpm.cjs").is_file())
        variables = toolchain.child_variables(destination)
        self.assertEqual(variables, {"COREPACK_HOME": os.path.abspath(destination), "COREPACK_ENABLE_NETWORK": "0"})


class LaunchTest(unittest.TestCase):
    """What `claude_live.launch` does with the pin: seeds and records on a live launch, reports on a dry run, refuses a miss."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)
        self.manifest = manifest_module.load(cli.HOOKS_SMOKE_MANIFEST)

    def request(self, dry_run: bool = False) -> object:
        trial = next(trial for trial in schedule.expand(self.manifest) if trial.arm_id == "off")
        task = next(item for item in self.manifest.tasks if item["id"] == trial.task_id)
        arm = next(item for item in self.manifest.arms if item["id"] == trial.arm_id)
        roots = artifact.create(self.dir / "run", trial.trial_id, self.manifest.fixture_path(task))
        return dataclasses.replace(claude_live.LaunchRequest(trial.trial_id, roots, task, arm, self.manifest.pins), dry_run=dry_run)

    def test_a_live_launch_seeds_the_pinned_pnpm_and_records_what_runs(self) -> None:
        environ = support.fake_toolchain(self.dir, cached=("10.23.0", "11.11.0"))
        request = self.request()
        with mock.patch.dict(os.environ, {**environ, "CLAUDE_CODE_OAUTH_TOKEN": "not-a-real-token"}):
            launch = claude_live.launch(request)  # type: ignore[arg-type]
        self.assertEqual(launch.package_manager, {"kind": "corepack-shim", "version": "11.11.0"})
        assert launch.env is not None
        self.assertEqual(launch.env["COREPACK_HOME"], str(request.roots.corepack_home))  # type: ignore[attr-defined]
        self.assertEqual(launch.env["COREPACK_ENABLE_NETWORK"], "0")
        self.assertEqual(toolchain.cached_versions(request.roots.corepack_home), ("11.11.0",))  # type: ignore[attr-defined]
        self.assertNotIn(environ["COREPACK_HOME"], launch.env.values())

    def test_a_dry_run_reports_and_neither_seeds_nor_refuses(self) -> None:
        environ = support.fake_toolchain(self.dir, cached=("10.23.0",))
        request = self.request(dry_run=True)
        with mock.patch.dict(os.environ, environ):
            launch = claude_live.launch(request)  # type: ignore[arg-type]
        self.assertEqual(launch.package_manager, {"kind": "corepack-shim", "version": None})
        self.assertFalse(request.roots.corepack_home.exists())  # type: ignore[attr-defined]

    def test_a_shim_without_the_pin_cached_refuses_the_launch_naming_the_fix(self) -> None:
        environ = support.fake_toolchain(self.dir, cached=("10.23.0",))
        with mock.patch.dict(os.environ, environ), self.assertRaises(LiveExecutorError) as caught:
            claude_live.launch(self.request())  # type: ignore[arg-type]
        self.assertIn("corepack install -g pnpm@11.11.0", str(caught.exception))

    def test_an_arm_cannot_reach_corepack_through_its_settings(self) -> None:
        with self.assertRaises(LiveExecutorError):
            claude_live._settings_env({"COREPACK_HOME": "/elsewhere"})

    def test_the_cli_refuses_before_any_root_and_passes_a_pinning_fixture_with_the_pin_cached(self) -> None:
        with self.assertRaises(cli.CliError) as caught:
            cli.refuse_package_manager(self.manifest, support.fake_toolchain(self.dir, cached=("10.23.0",)))
        self.assertIn("task 'actor'", str(caught.exception))
        self.assertIn("corepack install -g pnpm@11.11.0", str(caught.exception))
        shutil.rmtree(self.dir / "toolchain")
        cli.refuse_package_manager(self.manifest, support.fake_toolchain(self.dir, cached=("11.11.0",)))
        cli.refuse_package_manager(manifest_module.load(cli.SMOKE_MANIFEST), {"PATH": str(self.dir / "empty")})

    def test_the_record_keeps_the_package_manager_in_its_isolation_block(self) -> None:
        record = support.attempt_record(support.parse("sess-family"))
        record["isolation"] = {**record["isolation"], "package_manager": {"kind": "corepack-shim", "version": "11.11.0"}}
        records.validate(record)
        for bad in ({"kind": "npm", "version": "1"}, {"kind": "binary"}, {"kind": "binary", "version": ""}, "corepack"):
            with self.subTest(str(bad)), self.assertRaises(RecordError):
                records.validate({**record, "isolation": {**record["isolation"], "package_manager": bad}})


if __name__ == "__main__":
    unittest.main()
