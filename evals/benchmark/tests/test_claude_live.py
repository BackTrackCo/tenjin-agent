"""The live executor and the operator live command, proven without spending anything.

No case here starts `claude`. The two process boundaries in the package,
`runner.process_spawn` and `verifier.run`, are replaced or asserted unused, so
a missing binary can never turn a case into a silent skip: the assertions are
about the argv, the roots, the environment, and the refusals.
"""

from __future__ import annotations

import contextlib
import dataclasses
import io
import json
import shlex
import shutil
import tempfile
import unittest
import uuid
from pathlib import Path
from typing import Any
from unittest import mock

from evals.benchmark import artifact, claude_live, cli, executor, manifest as manifest_module, records, runner, schedule, verifier
from evals.benchmark.artifact import IsolationError
from evals.benchmark.claude_live import LiveExecutorError
from evals.benchmark.tests import support
from evals.benchmark.tests.support import ATTESTED

# The smoke manifest's own provider origin, which `SPEC.required_origins`
# makes the attestation state.
LIVE_ATTESTED = dataclasses.replace(ATTESTED, network_allowlist=("api.anthropic.com",))
ATTESTATION_JSON = {
    "kind": "container",
    "instance_id": "bench1-smoke-01",
    "image": "ghcr.io/example/bench1@sha256:0000",
    "fresh_roots": True,
    "wallet_present": False,
    "credential_seam": "ANTHROPIC_API_KEY",
    "network_allowlist": ["api.anthropic.com"],
}


def smoke() -> manifest_module.Manifest:
    return manifest_module.load(cli.SMOKE_MANIFEST)


class LiveCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)
        self.run_dir = self.dir / "run"

    def request(self, manifest: manifest_module.Manifest, index: int = 0) -> executor.LaunchRequest:
        trial = schedule.expand(manifest)[index]
        task = next(item for item in manifest.tasks if item["id"] == trial.task_id)
        arm = next(item for item in manifest.arms if item["id"] == trial.arm_id)
        roots = artifact.create(self.run_dir, trial.trial_id, manifest.fixture_path(task))
        return executor.LaunchRequest(trial.trial_id, roots, task, arm, manifest.pins)

    def edited(self, *, pins: dict[str, Any] | None = None, task: dict[str, Any] | None = None, arm: dict[str, Any] | None = None):
        """One launch request off the smoke manifest with named fields replaced."""
        request = self.request(smoke())
        return dataclasses.replace(
            request,
            pins={**request.pins, **(pins or {})},
            task={**request.task, **(task or {})},
            arm={**request.arm, **(arm or {})},
        )


class ArgvTest(LiveCase):
    def test_the_argv_is_exactly_the_command_the_operator_would_run(self) -> None:
        request = self.request(smoke())
        launch = claude_live.launch(request)
        settings = claude_live.settings_path(request.roots)
        self.assertEqual(
            launch.argv,
            [
                "claude",
                "-p",
                "Write the single line 42 into a file named answer.txt in this directory. Change nothing else.",
                "--output-format",
                "stream-json",
                "--verbose",
                "--include-hook-events",
                "--model",
                "claude-fable-5-1",
                "--max-budget-usd",
                "0.50",
                "--strict-mcp-config",
                "--setting-sources",
                "project",
                "--settings",
                str(settings),
                "--tools",
                "Read,Edit,Write,Glob,Grep",
                "--allowedTools",
                "Read(./**)",
                "Edit(./**)",
                "Write(./**)",
                "Glob(./**)",
                "Grep(./**)",
                "--permission-mode",
                "dontAsk",
                "--session-id",
                claude_live.root_session_id(request.trial_id),
            ],
        )
        self.assertEqual(launch.cwd, request.roots.repo.resolve())
        # Session persistence is not disabled: a child agent's usage exists
        # only in the persisted transcripts.
        self.assertNotIn("--no-session-persistence", launch.argv)

    def test_the_arm_fragment_becomes_the_trials_own_settings_file(self) -> None:
        request = self.request(smoke())
        claude_live.launch(request)
        written = json.loads(claude_live.settings_path(request.roots).read_text(encoding="utf-8"))
        self.assertEqual(written, request.arm["settings"])
        # Not in the worktree and not in the output root: it is not agent output.
        self.assertFalse((request.roots.repo / "settings.json").exists())


class RefusalTest(LiveCase):
    def test_a_manifest_value_cannot_inject_a_flag_or_a_shell_fragment(self) -> None:
        cases = {
            "model with a shell fragment": {"pins": {"model": "claude-fable-5-1; rm -rf /"}},
            "model shaped like a flag": {"pins": {"model": "--dangerously-skip-permissions"}},
            "tool outside the declared set": {"pins": {"tools": ["Bash,--dangerously-skip-permissions"]}},
            "tool that is not a string": {"pins": {"tools": [True]}},
            "allowed rule with a substitution": {"pins": {"allowed_tools": ["Write($(cat /etc/passwd))"]}},
            "permission mode with an extra flag": {"pins": {"permission_mode": "dontAsk --add-dir /"}},
            "budget as a string": {"pins": {"max_budget_usd": "0.50"}},
            "budget above the ceiling": {"pins": {"max_budget_usd": 1000}},
            "credential variable off the seam list": {"pins": {"credential_env": "AWS_SECRET_ACCESS_KEY"}},
            "prompt that is not a string": {"task": {"prompt": 42}},
            "prompt shaped like a flag": {"task": {"prompt": "--resume"}},
            "settings key outside the declared set": {"arm": {"settings": {"apiKeyHelper": "cat /op/key"}}},
        }
        for name, edit in cases.items():
            with self.subTest(name):
                with self.assertRaises(LiveExecutorError):
                    claude_live.launch(self.edited(**edit))

    def test_a_settings_fragment_that_does_not_hash_to_its_declared_hash_is_refused(self) -> None:
        with self.assertRaises(LiveExecutorError):
            claude_live.launch(self.edited(arm={"settings": {"env": {"BENCH1_SMOKE_ARM": "tampered"}}}))

    def test_a_prompt_holding_shell_text_stays_one_argument(self) -> None:
        prompt = "Explain why `rm -rf / && echo $HOME` is dangerous, then write 42 into answer.txt."
        launch = claude_live.launch(self.edited(task={"prompt": prompt}))
        # One element, unquoted and unsplit. `runner.process_spawn` runs the
        # list with shell=False, so there is nothing for a shell to read.
        self.assertEqual(launch.argv.count(prompt), 1)
        self.assertEqual(launch.argv[launch.argv.index("-p") + 1], prompt)


class SessionIdTest(unittest.TestCase):
    def test_the_root_session_id_is_a_stable_distinct_uuid(self) -> None:
        first = claude_live.root_session_id("trial-a")
        self.assertEqual(first, claude_live.root_session_id("trial-a"))
        self.assertNotEqual(first, claude_live.root_session_id("trial-b"))
        self.assertEqual(str(uuid.UUID(first)), first)

    def test_every_trial_in_the_smoke_schedule_gets_its_own_session_id(self) -> None:
        trials = schedule.expand(smoke())
        ids = [claude_live.root_session_id(trial.trial_id) for trial in trials]
        self.assertEqual(len(set(ids)), len(trials))


class SessionsResolverTest(LiveCase):
    def test_the_live_spec_resolves_the_real_projects_directory(self) -> None:
        request = self.request(smoke())
        session_id = claude_live.root_session_id(request.trial_id)
        resolved = claude_live.SPEC.sessions(request.roots, session_id)
        cwd = request.roots.repo.resolve()
        self.assertEqual(resolved, request.roots.home / ".claude" / "projects" / claude_live.project_slug(cwd))
        # The slug is the cwd with every character outside [A-Za-z0-9] replaced.
        self.assertNotIn("/", resolved.name)
        self.assertTrue(all(char.isalnum() or char == "-" for char in resolved.name))

    def test_a_fake_spec_still_resolves_the_output_directory(self) -> None:
        request = self.request(support.synthetic_manifest(self.dir))
        spec = executor.lookup("fake")
        self.assertFalse(spec.live)
        self.assertEqual(spec.sessions(request.roots, "fake-session"), request.roots.output / "sessions")


class RunnerReadsTheResolverTest(LiveCase):
    """A live trial's usage comes from the resolved directory, not the old path."""

    def spawn(self) -> runner.Spawn:
        def spawn(launch: executor.Launch, roots: artifact.TrialRoots, timeout_s: float) -> runner.Completed:
            # Stand in for the CLI: leave the transcripts where it leaves them.
            staging = roots.base / "staging"
            executor.write_transcripts(staging, launch.root_session_id, launch.root_session_id, "off")
            target = claude_live.SPEC.sessions(roots, launch.root_session_id)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(staging / "sessions", target)
            shutil.rmtree(staging)
            (roots.repo / "answer.txt").write_text("42\n", encoding="utf-8")
            return runner.Completed(returncode=0, stderr="", timed_out=False)

        return spawn

    def test_a_live_trial_is_parsed_from_the_home_transcripts(self) -> None:
        manifest = smoke()
        trial = schedule.expand(manifest)[0]
        clock = support.FakeClock()
        runtime = runner.Runtime(
            clock=clock,
            sleep=clock.sleep,
            spawn=self.spawn(),
            settle_cap_s=1.0,
            attestation=LIVE_ATTESTED,
            ci=False,
        )
        record = runner.run_trial(manifest, trial, self.run_dir, "sha256:schedule", runtime)
        records.validate(record)
        self.assertEqual(record["outcome"], "pass")
        self.assertEqual(record["native_root_id"], claude_live.root_session_id(trial.trial_id))
        self.assertEqual([item["native_request_id"] for item in record["usage"]], ["req_1", "req_2", "req_c1"])
        self.assertEqual(record["isolation"]["attestation_hash"], LIVE_ATTESTED.hash())
        # The old hardcoded path holds nothing; the resolver is the only route.
        self.assertFalse((self.run_dir / "trials" / trial.trial_id / "output" / "sessions").exists())

    def test_an_attestation_that_omits_the_provider_origin_is_refused(self) -> None:
        manifest = smoke()
        trial = schedule.expand(manifest)[0]
        with self.assertRaises(IsolationError) as caught:
            runner.run_trial(
                manifest, trial, self.run_dir, "sha256:schedule", runner.Runtime(spawn=self.spawn(), attestation=ATTESTED, ci=False)
            )
        self.assertEqual(caught.exception.code, "allowlist_gap")


class ChildEnvironmentTest(LiveCase):
    def parent(self) -> dict[str, str]:
        return {
            "PATH": "/usr/bin:/bin",
            "TERM": "xterm-256color",
            "LANG": "en_US.UTF-8",
            "ANTHROPIC_API_KEY": "sk-operator-key",
            "HOME": "/Users/operator",
            "CLAUDE_CONFIG_DIR": "/Users/operator/.claude",
            "TENJIN_WALLET_PRIVATE_KEY": "0xdead",
            "TENJIN_SHELF_TOKEN": "shelf-secret",
            "AWS_SECRET_ACCESS_KEY": "aws-secret",
            "GITHUB_TOKEN": "gh-secret",
        }

    def environment(self) -> dict[str, str]:
        roots = self.request(smoke()).roots
        self.roots = roots
        return claude_live.child_environment(roots, self.parent(), "ANTHROPIC_API_KEY")

    def test_the_child_gets_the_allowlist_and_the_trials_own_roots(self) -> None:
        env = self.environment()
        self.assertEqual(
            sorted(env),
            ["ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR", "HOME", "LANG", "PATH", "TENJIN_DATA_DIR", "TENJIN_PUBLISH_MODE", "TERM"],
        )
        self.assertEqual(env["HOME"], str(self.roots.home))
        self.assertEqual(env["TENJIN_DATA_DIR"], str(self.roots.data_dir))
        self.assertEqual(env["ANTHROPIC_API_KEY"], "sk-operator-key")

    def test_the_child_gets_no_wallet_no_shelf_secret_and_not_the_operators_profile(self) -> None:
        env = self.environment()
        for denied in ("TENJIN_WALLET_PRIVATE_KEY", "TENJIN_SHELF_TOKEN", "AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN"):
            self.assertNotIn(denied, env)
        self.assertEqual(env["CLAUDE_CONFIG_DIR"], str(self.roots.profile))
        self.assertNotIn("/Users/operator", " ".join(env.values()))

    def test_a_credential_variable_off_the_seam_list_is_refused(self) -> None:
        with self.assertRaises(LiveExecutorError):
            claude_live.child_environment(self.request(smoke()).roots, self.parent(), "GITHUB_TOKEN")

    def test_the_launch_carries_the_environment_the_runner_will_use(self) -> None:
        request = self.request(smoke())
        launch = claude_live.launch(request)
        self.assertIsNotNone(launch.env)
        self.assertEqual(launch.env["HOME"], str(request.roots.home))


class NoProcess:
    """Any process this package could start, replaced by a failing assertion."""

    def __init__(self, case: unittest.TestCase) -> None:
        self.case = case

    def __enter__(self) -> None:
        def refuse(*args: object, **kwargs: object) -> None:
            self.case.fail("the dry run started a process")

        self.patches = [mock.patch.object(runner, "process_spawn", refuse), mock.patch.object(verifier, "run", refuse)]
        for patch in self.patches:
            patch.start()

    def __exit__(self, *exc: object) -> None:
        for patch in self.patches:
            patch.stop()


class DryRunTest(LiveCase):
    def test_the_dry_run_prints_every_trials_argv_and_roots_and_starts_nothing(self) -> None:
        stream = io.StringIO()
        with NoProcess(self):
            payload = cli.live_run(self.run_dir, cli.SMOKE_MANIFEST, dry_run=True, stream=stream, environ={})
        printed = stream.getvalue()
        trials = schedule.expand(smoke())
        self.assertEqual(len(payload["trials"]), len(trials))
        for plan in payload["trials"]:
            self.assertIn(plan["trial_id"], printed)
            self.assertIn(plan["roots"]["sessions"], printed)
            # The whole argv is one copyable line, in the order the CLI receives it.
            self.assertIn(shlex.join(plan["argv"]), printed)
            self.assertEqual(plan["argv"][0], "claude")
        self.assertIn("nothing was started", printed)

    def test_the_dry_run_is_the_only_live_behavior_an_automated_environment_reaches(self) -> None:
        stream = io.StringIO()
        with NoProcess(self):
            cli.live_run(self.run_dir, cli.SMOKE_MANIFEST, dry_run=True, stream=stream, environ={"CI": "1"})
        self.assertIn("claude -p", stream.getvalue().replace("'", ""))

    def test_the_command_line_dry_run_exits_zero(self) -> None:
        printed = io.StringIO()
        with NoProcess(self), contextlib.redirect_stdout(printed):
            code = cli.main(["live-run", "--manifest", str(cli.SMOKE_MANIFEST), "--out", str(self.run_dir), "--dry-run"])
        self.assertEqual(code, 0)
        self.assertIn("claude", printed.getvalue())


class LiveRunRefusalTest(LiveCase):
    def test_a_live_run_without_an_attestation_is_refused(self) -> None:
        with NoProcess(self), self.assertRaises(cli.CliError) as caught:
            cli.live_run(self.run_dir, cli.SMOKE_MANIFEST, None, environ={})
        self.assertIn("--attestation", str(caught.exception))
        self.assertFalse(self.run_dir.exists())

    def test_a_live_run_in_an_automated_environment_is_refused(self) -> None:
        for name in cli.AUTOMATION_ENV:
            with self.subTest(name):
                path = self.dir / "attestation.json"
                path.write_text(json.dumps(ATTESTATION_JSON), encoding="utf-8")
                with NoProcess(self), self.assertRaises(cli.CliError) as caught:
                    cli.live_run(self.run_dir, cli.SMOKE_MANIFEST, path, environ={name: "1"})
                self.assertIn(name, str(caught.exception))

    def test_live_run_refuses_a_fake_executor_manifest(self) -> None:
        with NoProcess(self), self.assertRaises(cli.CliError) as caught:
            cli.live_run(self.run_dir, cli.FAKE_MANIFEST, dry_run=True, environ={})
        self.assertIn("is fake", str(caught.exception))

    def test_fake_run_refuses_a_live_executor_manifest(self) -> None:
        with NoProcess(self), self.assertRaises(cli.CliError) as caught:
            cli.fake_run(self.run_dir, cli.SMOKE_MANIFEST)
        self.assertIn("is live", str(caught.exception))

    def test_a_refusal_exits_two_instead_of_raising_at_the_operator(self) -> None:
        stderr = io.StringIO()
        with NoProcess(self), contextlib.redirect_stderr(stderr):
            code = cli.main(["live-run", "--manifest", str(cli.SMOKE_MANIFEST), "--out", str(self.run_dir)])
        self.assertEqual(code, 2)
        self.assertIn("--attestation", stderr.getvalue())


class AttestationFileTest(LiveCase):
    def test_the_documented_attestation_file_loads_and_satisfies_the_live_gate(self) -> None:
        path = self.dir / "attestation.json"
        path.write_text(json.dumps(ATTESTATION_JSON, indent=2), encoding="utf-8")
        attestation = artifact.load_attestation(path)
        self.assertEqual(attestation.network_allowlist, ("api.anthropic.com",))
        artifact.check_attestation(attestation, claude_live.SPEC.required_origins)

    def test_an_attestation_missing_a_field_is_refused(self) -> None:
        path = self.dir / "attestation.json"
        path.write_text(json.dumps({key: value for key, value in ATTESTATION_JSON.items() if key != "image"}), encoding="utf-8")
        with self.assertRaises(IsolationError) as caught:
            artifact.load_attestation(path)
        self.assertEqual(caught.exception.code, "attestation_shape")


class SmokeManifestTest(unittest.TestCase):
    def test_the_smoke_manifest_validates_and_expands_to_a_balanced_schedule(self) -> None:
        manifest = smoke()
        trials = schedule.expand(manifest)
        # Gate 3 is four to eight attempts. This is the floor, on purpose.
        self.assertEqual(len(trials), 4)
        self.assertEqual({trial.arm_id for trial in trials}, {"off", "on"})
        schedule.check_balance(trials, [arm["id"] for arm in manifest.arms])
        self.assertTrue(all(executor.lookup(arm["executor"]).live for arm in manifest.arms))

    def test_the_smoke_fixture_hides_the_verifier_from_the_agent(self) -> None:
        manifest = smoke()
        fixture = manifest.fixture_path(manifest.tasks[0])
        self.assertEqual(sorted(path.name for path in fixture.iterdir()), ["TASK.md"])
        self.assertNotIn("42", (fixture / "TASK.md").read_text(encoding="utf-8"))


class LiveExecutorRegistryTest(unittest.TestCase):
    def test_the_registry_finds_the_live_spec_by_name_alone(self) -> None:
        spec = executor.lookup(claude_live.NAME)
        self.assertIs(spec, claude_live.SPEC)
        self.assertTrue(spec.live)
        self.assertEqual(spec.harness, "claude")

    def test_the_fake_specs_stay_offline(self) -> None:
        self.assertFalse(any(executor.lookup(name).live for name in ("fake", "fake_hang")))


if __name__ == "__main__":
    unittest.main()
