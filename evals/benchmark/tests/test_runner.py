"""Executing a schedule: settlement, caps, outcomes, sentinels, and resume.

Every case injects the clock, the settlement barrier, and the process
boundary. The one exception is the timeout case, which has to start a real
short-lived process to prove that killing the trial's process group reaches a
grandchild the root left behind.
"""

from __future__ import annotations

import json
import os
import tempfile
import time
import unittest
import urllib.request
from pathlib import Path

from evals.benchmark import artifact, executor, records, reduce as reduce_module, runner, schedule
from evals.benchmark.artifact import IsolationError
from evals.benchmark.executor import ExecutorSpec
from evals.benchmark.manifest import Manifest
from evals.benchmark.tests import support
from evals.benchmark.tests.support import ATTESTED
from evals.benchmark.verifier import VerifierError
from evals.harness.sentinel import start_sentinel

LIVE = "live_only_for_this_test"


class SettlementTest(unittest.TestCase):
    """A root that exits while a child is live is not a complete attempt."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)
        self.session = "fake-settle"
        executor.write_transcripts(self.dir, self.session, "seed", "off")
        self.sessions = self.dir / "sessions"
        self.child = next((self.sessions / self.session / "subagents").glob("agent-*.jsonl"))
        # Drop the child's terminal row: the root has stopped, the child has not.
        self.child.write_text(self.child.read_text(encoding="utf-8").splitlines()[0] + "\n", encoding="utf-8")

    def test_a_root_that_finishes_before_its_child_waits_for_it(self) -> None:
        clock = support.FakeClock()

        def sleep(seconds: float) -> None:
            clock.sleep(seconds)
            if len(clock.slept) == 2:
                executor.settle_child(self.dir, self.session)

        settlement = runner.settle(
            self.sessions, self.session, runner.Runtime(clock=clock, sleep=sleep, settle_cap_s=10.0, settle_interval_s=0.25)
        )
        self.assertTrue(settlement.settled)
        self.assertFalse(settlement.capped)
        self.assertEqual(settlement.unresolved, [])
        self.assertEqual(clock.slept, [0.25, 0.25])
        self.assertEqual(settlement.waited_s, 0.5)

    def test_a_missing_stop_settles_only_at_the_declared_cap(self) -> None:
        clock = support.FakeClock()
        settlement = runner.settle(
            self.sessions,
            self.session,
            runner.Runtime(clock=clock, sleep=clock.sleep, settle_cap_s=1.0, settle_interval_s=0.25),
        )
        self.assertTrue(settlement.capped)
        self.assertFalse(settlement.settled)
        self.assertEqual(settlement.unresolved, [self.child.stem.removeprefix("agent-")])
        self.assertEqual(clock.now, 1.0)
        self.assertEqual(clock.slept, [0.25] * 4)

    def test_a_root_without_a_result_row_is_unresolved_too(self) -> None:
        (self.sessions / f"{self.session}.jsonl").write_text("", encoding="utf-8")
        clock = support.FakeClock()
        settlement = runner.settle(
            self.sessions, self.session, runner.Runtime(clock=clock, sleep=clock.sleep, settle_cap_s=0.5, settle_interval_s=0.25)
        )
        self.assertIn("", settlement.unresolved)
        self.assertEqual(clock.now, 0.5)


class TrialCase(unittest.TestCase):
    """One trial per case, with the executor process replaced by a callable."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)
        self.run_dir = self.dir / "run"

    def manifest(self, **overrides: object) -> Manifest:
        return support.synthetic_manifest(self.dir, **overrides)  # type: ignore[arg-type]

    def runtime(self, **overrides: object) -> runner.Runtime:
        clock = support.FakeClock()
        base = {"clock": clock, "sleep": clock.sleep, "spawn": support.fake_spawn(), "settle_cap_s": 1.0}
        return runner.Runtime(**{**base, **overrides})  # type: ignore[arg-type]

    def one_trial(self, manifest: Manifest, runtime: runner.Runtime, index: int = 0) -> dict:
        trial = schedule.expand(manifest)[index]
        record = runner.run_trial(manifest, trial, self.run_dir, "sha256:schedule", runtime)
        records.validate(record)
        return record


class OutcomeTest(TrialCase):
    def test_a_task_failure_and_an_infrastructure_failure_are_different_outcomes(self) -> None:
        failed = self.one_trial(self.manifest(), self.runtime(spawn=support.fake_spawn(answer="41\n")))
        self.assertEqual(failed["outcome"], "fail")
        self.assertIsNone(failed["invalid_reason"])
        self.assertEqual(failed["verifier"], {"id": "fake_answer_file", "exit_code": 1})
        # A failed task keeps every token it spent.
        self.assertEqual(len(failed["usage"]), 3)

        broken = self.one_trial(self.manifest(), self.runtime(spawn=support.fake_spawn(returncode=3)), index=1)
        self.assertEqual(broken["outcome"], "invalid")
        self.assertEqual(broken["invalid_reason"], "executor:exit_3")
        self.assertIsNone(broken["verifier"])

        reduction = reduce_module.reduce({record["trial_id"]: record for record in (failed, broken)}, [])
        scored = [arm for arm in reduction["arms"].values() if arm["tasks"]]
        self.assertEqual(len(scored), 1)
        self.assertEqual(scored[0]["outcomes"]["fail"], 1)
        self.assertEqual([item["trial_id"] for item in reduction["invalid"]], [broken["trial_id"]])
        self.assertIsNone(scored[0]["tokens_per_verified_resolution"])

    def test_a_verifier_that_cannot_decide_invalidates_the_attempt(self) -> None:
        record = self.one_trial(self.manifest(verifier_name="fake_crash"), self.runtime())
        self.assertEqual(record["outcome"], "invalid")
        self.assertEqual(record["invalid_reason"], "verifier:fake_crash")
        self.assertEqual(record["verifier"], {"id": "fake_crash", "exit_code": 3})

    def test_an_unknown_verifier_is_refused_before_any_spend(self) -> None:
        with self.assertRaises(VerifierError):
            self.one_trial(self.manifest(verifier_name="absent"), self.runtime())
        self.assertFalse((self.run_dir / "trials").exists())

    def test_a_child_that_never_stops_makes_the_attempt_interrupted(self) -> None:
        record = self.one_trial(self.manifest(), self.runtime(spawn=support.fake_spawn(settled=False)))
        self.assertEqual(record["outcome"], "interrupted")
        self.assertEqual(record["stop_reason"], "interrupted")
        self.assertEqual(len(record["unresolved_actors"]), 2)
        self.assertIn("", record["unresolved_actors"])
        # The partial usage the root did emit is retained.
        self.assertEqual(len(record["usage"]), 2)
        self.assertEqual(record["usage_reconciliation"]["status"], "no_envelope")

    def test_hidden_verifier_bytes_are_unavailable_before_agent_shutdown(self) -> None:
        seen: list[tuple[bool, str]] = []

        def before(launch: executor.Launch, roots: artifact.TrialRoots) -> None:
            try:
                roots.hidden_copy()
                seen.append((roots.verify.exists(), "copied"))
            except artifact.ArtifactError as error:
                seen.append((roots.verify.exists(), error.code))

        record = self.one_trial(self.manifest(), self.runtime(spawn=support.fake_spawn(before=before)))
        self.assertEqual(seen, [(False, "agent_live")])
        self.assertEqual(record["outcome"], "pass")
        trial_dir = self.run_dir / "trials" / record["trial_id"]
        self.assertTrue((trial_dir / "verify" / "answer.txt").is_file())
        self.assertFalse((trial_dir / "repo" / "verify").exists())

    def test_a_symlink_escape_makes_the_attempt_invalid(self) -> None:
        def before(launch: executor.Launch, roots: artifact.TrialRoots) -> None:
            (roots.repo / "escape").symlink_to(self.dir / "fixture" / "TASK.md")

        record = self.one_trial(self.manifest(), self.runtime(spawn=support.fake_spawn(before=before)))
        self.assertEqual(record["outcome"], "invalid")
        self.assertEqual(record["invalid_reason"], "isolation:symlink_escape")
        self.assertIsNone(record["verifier"])
        self.assertFalse((self.run_dir / "trials" / record["trial_id"] / "verify").exists())

    def test_a_credential_that_leaves_the_disposable_home_makes_the_attempt_invalid(self) -> None:
        def before(launch: executor.Launch, roots: artifact.TrialRoots) -> None:
            secret = (roots.home / artifact.CREDENTIAL_FILE).read_text(encoding="utf-8")
            (roots.repo / "notes.md").write_text(secret, encoding="utf-8")

        record = self.one_trial(self.manifest(), self.runtime(spawn=support.fake_spawn(before=before)))
        self.assertEqual(record["outcome"], "invalid")
        self.assertEqual(record["invalid_reason"], "sentinel:credential_exposure")
        self.assertEqual(record["sentinel"], {"public_requests": 0, "credential_exposures": 1})


class PublicRequestTest(TrialCase):
    def setUp(self) -> None:
        super().setUp()
        # Loopback only, one server for this case, stopped when it ends.
        self.sentinel = start_sentinel()
        self.addCleanup(self.sentinel.stop)

    def test_a_public_request_makes_only_its_own_attempt_invalid(self) -> None:
        calls: list[int] = []

        def before(launch: executor.Launch, roots: artifact.TrialRoots) -> None:
            calls.append(1)
            if len(calls) == 1:
                urllib.request.urlopen(f"{roots.public_origin}/collect", data=b"[redacted]", timeout=5).read()

        manifest = self.manifest()
        runtime = self.runtime(spawn=support.fake_spawn(before=before), sentinel=self.sentinel)
        results = runner.run(manifest, schedule.expand(manifest), self.run_dir, "sha256:schedule", runtime)
        outcomes = [result.outcome for result in results]
        self.assertEqual(outcomes, ["invalid", "pass"])
        first, second = (json.loads(result.path.read_text(encoding="utf-8")) for result in results)
        self.assertEqual(first["invalid_reason"], "sentinel:public_request")
        self.assertEqual(first["sentinel"]["public_requests"], 1)
        # The second trial is not charged for the first trial's hit.
        self.assertEqual(second["sentinel"]["public_requests"], 0)
        self.assertEqual(len(self.sentinel.hits), 1)


class ProcessGroupTest(TrialCase):
    def test_a_timeout_kills_the_process_group_and_keeps_partial_usage(self) -> None:
        manifest = self.manifest(executor_name="fake_hang", wall_clock_s=1)
        record = self.one_trial(manifest, runner.Runtime(settle_cap_s=0.0))
        self.assertEqual(record["stop_reason"], "timeout")
        self.assertEqual(record["outcome"], "capped")
        self.assertIsNone(record["invalid_reason"])
        self.assertEqual(record["unresolved_actors"], [""])
        # The one request the root finished before the cap is still counted.
        self.assertEqual(len(record["usage"]), 1)
        self.assertEqual(record["usage"][0]["completion_state"], "partial")
        self.assertGreater(record["usage"][0]["output_total"], 0)

        pids = json.loads((self.run_dir / "trials" / record["trial_id"] / "output" / "pids.json").read_text(encoding="utf-8"))
        for name, pid in pids.items():
            with self.subTest(process=name):
                self.assertTrue(_gone(pid), f"{name} survived the process-group kill")


class ResumeTest(TrialCase):
    def test_interruption_and_resume_neither_overwrite_nor_duplicate_an_attempt(self) -> None:
        manifest = self.manifest(tasks=2)
        trials = schedule.expand(manifest)
        self.assertEqual(len(trials), 4)
        calls: list[int] = []
        working = support.fake_spawn()

        def spawn(launch: executor.Launch, roots: artifact.TrialRoots, timeout_s: float) -> runner.Completed:
            calls.append(1)
            if len(calls) == 3:
                raise KeyboardInterrupt
            return working(launch, roots, timeout_s)

        with self.assertRaises(KeyboardInterrupt):
            runner.run(manifest, trials, self.run_dir, "sha256:schedule", self.runtime(spawn=spawn))
        records_dir = self.run_dir / "records"
        published = sorted(path.name for path in records_dir.glob("*.json"))
        self.assertEqual(len(published), 2)
        self.assertEqual(published, sorted(f"{trial.trial_id}.json" for trial in trials[:2]))
        before = {path.name: (path.read_bytes(), path.stat().st_ino) for path in records_dir.glob("*.json")}

        results = runner.run(manifest, trials, self.run_dir, "sha256:schedule", self.runtime())
        self.assertEqual([result.resumed for result in results], [True, True, False, False])
        after = {path.name: (path.read_bytes(), path.stat().st_ino) for path in records_dir.glob("*.json")}
        self.assertEqual(len(after), 4)
        for name, value in before.items():
            self.assertEqual(after[name], value, f"{name} was rewritten on resume")
        self.assertEqual(list(records_dir.glob("*.partial.*")), [])
        accepted, excluded = records.select(records_dir, manifest.hash, "sha256:schedule")
        self.assertEqual(len(accepted), 4)
        self.assertEqual(excluded, [])

    def test_a_stale_manifest_cannot_reuse_an_old_result(self) -> None:
        first = self.manifest()
        trials = schedule.expand(first)
        runner.run(first, trials, self.run_dir, "sha256:schedule", self.runtime())
        records_dir = self.run_dir / "records"

        second = Manifest(data=first.data, path=first.path, hash="sha256:manifest-v2")
        accepted, excluded = records.select(records_dir, second.hash, "sha256:schedule")
        self.assertEqual(accepted, {})
        self.assertEqual([item.reason for item in excluded], ["stale", "stale"])

        results = runner.run(second, schedule.expand(second), self.run_dir, "sha256:schedule", self.runtime())
        self.assertEqual([result.resumed for result in results], [False, False])
        self.assertEqual(len(list(records_dir.glob("*.json"))), 4)

        # Relabelling an old record is not a shortcut either: trial_id derives
        # from the manifest hash, so the file stops validating.
        stale = records_dir / f"{trials[0].trial_id}.json"
        record = json.loads(stale.read_text(encoding="utf-8"))
        stale.write_text(json.dumps({**record, "manifest_hash": second.hash}), encoding="utf-8")
        accepted, excluded = records.select(records_dir, second.hash, "sha256:schedule")
        self.assertEqual(len(accepted), 2)
        self.assertTrue(any(item.reason.startswith("invalid: trial_id does not derive") for item in excluded))


class LiveRefusalTest(TrialCase):
    def setUp(self) -> None:
        super().setUp()
        executor.REGISTRY[LIVE] = ExecutorSpec(
            name=LIVE,
            harness="claude",
            launch=executor.REGISTRY["fake"].launch,
            live=True,
            required_origins=("api.provider.example",),
        )
        self.addCleanup(executor.REGISTRY.pop, LIVE)
        self.manifest_live = self.manifest(executor_name=LIVE)

    def test_a_publishable_live_run_is_refused_without_an_isolation_attestation(self) -> None:
        with self.assertRaises(IsolationError) as caught:
            self.one_trial(self.manifest_live, self.runtime(publishable=True, ci=False))
        self.assertEqual(caught.exception.code, "attestation_missing")
        self.assertFalse((self.run_dir / "trials").exists())

    def test_a_live_executor_is_refused_in_ci(self) -> None:
        with self.assertRaises(IsolationError) as caught:
            self.one_trial(self.manifest_live, self.runtime(publishable=False, ci=True, attestation=None))
        self.assertEqual(caught.exception.code, "live_in_ci")

    def test_an_attested_live_run_records_its_attestation(self) -> None:
        record = self.one_trial(self.manifest_live, self.runtime(publishable=True, ci=False, attestation=ATTESTED))
        self.assertEqual(record["isolation"]["live"], True)
        self.assertEqual(record["isolation"]["attested_container"], True)
        self.assertEqual(record["isolation"]["attestation_hash"], ATTESTED.hash())


def _gone(pid: int, deadline_s: float = 5.0) -> bool:
    """Poll until the pid is gone. The kill is a signal, not a promise of speed."""
    end = time.monotonic() + deadline_s
    while time.monotonic() < end:
        try:
            os.kill(pid, 0)
        except (ProcessLookupError, PermissionError):
            return True
        time.sleep(0.02)
    return False


if __name__ == "__main__":
    unittest.main()
