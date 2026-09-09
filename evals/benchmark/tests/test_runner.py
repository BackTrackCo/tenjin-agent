"""Executing a schedule: settlement, caps, outcomes, sentinels, resume, and concurrency.

Every case injects the clock, the settlement barrier, and the process
boundary. Two exceptions start a real short-lived process: the timeout case,
which proves that killing the trial's process group reaches a grandchild the
root left behind, and the concurrent failure case, which proves the run that
ends on one trial's exception leaves nothing of another trial's alive. The
concurrency cases run on the real clock, because a clock a test advances by
hand cannot be shared by threads.
"""

from __future__ import annotations

import json
import os
import threading
import time
import urllib.request
from pathlib import Path
from typing import Callable

import pytest

from evals.benchmark import artifact, cli, executor, loop_join, reap, records, reduce as reduce_module, runner, schedule
from evals.benchmark.artifact import IsolationError
from evals.benchmark.executor import ExecutorSpec
from evals.benchmark.manifest import Manifest
from evals.benchmark.tests import support
from evals.benchmark.tests.support import ATTESTED
from evals.benchmark.usage import AuxiliaryReceipt
from evals.benchmark.verifier import VerifierError
from evals.harness.sentinel import start_sentinel

LIVE = "live_only_for_this_test"

MakeManifest = Callable[..., Manifest]
MakeRuntime = Callable[..., runner.Runtime]
OneTrial = Callable[..., dict]


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


@pytest.fixture
def run_dir(tmp_path: Path) -> Path:
    return tmp_path / "run"


@pytest.fixture
def make_manifest(tmp_path: Path) -> MakeManifest:
    def build(**overrides: object) -> Manifest:
        return support.synthetic_manifest(tmp_path, **overrides)  # type: ignore[arg-type]

    return build


@pytest.fixture
def make_runtime() -> MakeRuntime:
    """A runtime whose clock, settlement barrier and process boundary are injected."""

    def build(**overrides: object) -> runner.Runtime:
        clock = support.FakeClock()
        base = {"clock": clock, "sleep": clock.sleep, "spawn": support.fake_spawn(), "settle_cap_s": 1.0}
        return runner.Runtime(**{**base, **overrides})  # type: ignore[arg-type]

    return build


@pytest.fixture
def one_trial(run_dir: Path) -> OneTrial:
    def run(manifest: Manifest, runtime: runner.Runtime, index: int = 0) -> dict:
        record = runner.run_trial(manifest, schedule.expand(manifest)[index], run_dir, "sha256:schedule", runtime)
        records.validate(record)
        return record

    return run


# A root that exits while a child is live is not a complete attempt.


@pytest.fixture
def unsettled(tmp_path: Path) -> tuple[Path, str, Path]:
    """Transcripts whose root has stopped and whose child has not."""
    session = "fake-settle"
    executor.write_transcripts(tmp_path, session, "seed", "off")
    sessions = tmp_path / "sessions"
    child = next((sessions / session / "subagents").glob("agent-*.jsonl"))
    child.write_text(child.read_text(encoding="utf-8").splitlines()[0] + "\n", encoding="utf-8")
    return sessions, session, child


def test_a_root_that_finishes_before_its_child_waits_for_it(tmp_path: Path, unsettled) -> None:
    sessions, session, _child = unsettled
    clock = support.FakeClock()

    def sleep(seconds: float) -> None:
        clock.sleep(seconds)
        if len(clock.slept) == 2:
            executor.settle_child(tmp_path, session)

    settlement = runner.settle(sessions, session, runner.Runtime(clock=clock, sleep=sleep, settle_cap_s=10.0, settle_interval_s=0.25))
    assert settlement.settled
    assert not settlement.capped
    assert settlement.unresolved == []
    # Two polls at the declared interval, and the wait is their sum; the literal interval is not the contract.
    assert len(clock.slept) == 2
    assert all(slept == 0.25 for slept in clock.slept)
    assert settlement.waited_s == pytest.approx(sum(clock.slept))


def test_a_missing_stop_settles_only_at_the_declared_cap(unsettled) -> None:
    sessions, session, child = unsettled
    clock = support.FakeClock()
    settlement = runner.settle(sessions, session, runner.Runtime(clock=clock, sleep=clock.sleep, settle_cap_s=1.0, settle_interval_s=0.25))
    assert settlement.capped
    assert not settlement.settled
    assert settlement.unresolved == [child.stem.removeprefix("agent-")]
    assert clock.now == 1.0
    assert sum(clock.slept) == 1.0


def test_a_root_without_a_result_row_is_unresolved_too(unsettled) -> None:
    sessions, session, _child = unsettled
    (sessions / f"{session}.jsonl").write_text("", encoding="utf-8")
    clock = support.FakeClock()
    settlement = runner.settle(sessions, session, runner.Runtime(clock=clock, sleep=clock.sleep, settle_cap_s=0.5, settle_interval_s=0.25))
    assert "" in settlement.unresolved
    assert clock.now == 0.5


def test_a_task_failure_and_an_infrastructure_failure_are_different_outcomes(one_trial: OneTrial, make_manifest, make_runtime) -> None:
    failed = one_trial(make_manifest(), make_runtime(spawn=support.fake_spawn(answer="41\n")))
    assert failed["outcome"] == "fail"
    assert failed["invalid_reason"] is None
    assert failed["verifier"] == {"id": "fake_answer_file", "exit_code": 1}
    # A failed task keeps every token it spent.
    assert len(failed["usage"]) == 3

    broken = one_trial(make_manifest(), make_runtime(spawn=support.fake_spawn(returncode=3)), index=1)
    assert broken["outcome"] == "invalid"
    assert broken["invalid_reason"] == "executor:exit_3"
    assert broken["verifier"] is None

    reduction = reduce_module.reduce({record["trial_id"]: record for record in (failed, broken)}, [])
    scored = [arm for arm in reduction["arms"].values() if arm["tasks"]]
    assert len(scored) == 1
    assert scored[0]["outcomes"]["fail"] == 1
    assert [item["trial_id"] for item in reduction["invalid"]] == [broken["trial_id"]]
    assert scored[0]["tokens_per_verified_resolution"] is None


def test_a_verifier_that_cannot_decide_invalidates_the_attempt(one_trial: OneTrial, make_manifest, make_runtime) -> None:
    record = one_trial(make_manifest(verifier_name="fake_crash"), make_runtime())
    assert record["outcome"] == "invalid"
    assert record["invalid_reason"] == "verifier:fake_crash"
    assert record["verifier"] == {"id": "fake_crash", "exit_code": 3}


def test_an_unknown_verifier_is_refused_before_any_spend(one_trial: OneTrial, make_manifest, make_runtime, run_dir: Path) -> None:
    with pytest.raises(VerifierError):
        one_trial(make_manifest(verifier_name="absent"), make_runtime())
    assert not (run_dir / "trials").exists()


def test_a_child_that_never_stops_makes_the_attempt_interrupted(one_trial: OneTrial, make_manifest, make_runtime) -> None:
    record = one_trial(make_manifest(), make_runtime(spawn=support.fake_spawn(settled=False)))
    assert record["outcome"] == "interrupted"
    assert record["stop_reason"] == "interrupted"
    assert len(record["unresolved_actors"]) == 2
    assert "" in record["unresolved_actors"]
    # The partial usage the root did emit is retained.
    assert len(record["usage"]) == 2
    assert record["usage_reconciliation"]["status"] == "no_envelope"


def test_hidden_verifier_bytes_are_unavailable_before_agent_shutdown(one_trial: OneTrial, make_manifest, make_runtime, run_dir: Path) -> None:
    seen: list[tuple[bool, str]] = []

    def before(launch: executor.Launch, roots: artifact.TrialRoots) -> None:
        try:
            roots.hidden_copy()
            seen.append((roots.verify.exists(), "copied"))
        except artifact.ArtifactError as error:
            seen.append((roots.verify.exists(), error.code))

    record = one_trial(make_manifest(), make_runtime(spawn=support.fake_spawn(before=before)))
    assert seen == [(False, "agent_live")]
    assert record["outcome"] == "pass"
    trial_dir = run_dir / "trials" / record["trial_id"]
    assert (trial_dir / "verify" / "answer.txt").is_file()
    assert not (trial_dir / "repo" / "verify").exists()


def test_a_symlink_escape_makes_the_attempt_invalid(one_trial: OneTrial, make_manifest, make_runtime, run_dir: Path, tmp_path: Path) -> None:
    def before(launch: executor.Launch, roots: artifact.TrialRoots) -> None:
        (roots.repo / "escape").symlink_to(tmp_path / "fixture" / "TASK.md")

    record = one_trial(make_manifest(), make_runtime(spawn=support.fake_spawn(before=before)))
    assert record["outcome"] == "invalid"
    assert record["invalid_reason"] == "isolation:symlink_escape"
    assert record["verifier"] is None
    assert not (run_dir / "trials" / record["trial_id"] / "verify").exists()


def test_a_credential_that_leaves_the_disposable_home_makes_the_attempt_invalid(one_trial: OneTrial, make_manifest, make_runtime) -> None:
    def before(launch: executor.Launch, roots: artifact.TrialRoots) -> None:
        secret = (roots.home / artifact.CREDENTIAL_FILE).read_text(encoding="utf-8")
        (roots.repo / "notes.md").write_text(secret, encoding="utf-8")

    record = one_trial(make_manifest(), make_runtime(spawn=support.fake_spawn(before=before)))
    assert record["outcome"] == "invalid"
    assert record["invalid_reason"] == "sentinel:credential_exposure"
    assert record["sentinel"] == {"public_requests": 0, "credential_exposures": 1}


def test_a_public_request_makes_only_its_own_attempt_invalid(make_manifest, make_runtime, run_dir: Path) -> None:
    # Loopback only, one server for this case, stopped when it ends.
    sentinel = start_sentinel()
    try:
        calls: list[int] = []

        def before(launch: executor.Launch, roots: artifact.TrialRoots) -> None:
            calls.append(1)
            if len(calls) == 1:
                urllib.request.urlopen(f"{roots.public_origin}/collect", data=b"[redacted]", timeout=5).read()

        manifest = make_manifest()
        runtime = make_runtime(spawn=support.fake_spawn(before=before), sentinel=sentinel)
        results = runner.run(manifest, schedule.expand(manifest), run_dir, "sha256:schedule", runtime)
        assert [result.outcome for result in results] == ["invalid", "pass"]
        first, second = (json.loads(result.path.read_text(encoding="utf-8")) for result in results)
        assert first["invalid_reason"] == "sentinel:public_request"
        assert first["sentinel"]["public_requests"] == 1
        # The second trial is not charged for the first trial's hit.
        assert second["sentinel"]["public_requests"] == 0
        assert len(sentinel.hits) == 1
    finally:
        sentinel.stop()


# The CLI's own budget and turn stops: a failed attempt with its spend, never an invalid one.


def stopped(subtype: str, *, scale: int = 2) -> support.Before:
    def edit(launch: executor.Launch, roots: artifact.TrialRoots) -> None:
        path = roots.output / "sessions" / f"{launch.root_session_id}.jsonl"
        rows = support.read_rows(path)
        # What a capped session leaves: the stop named, is_error set, and an
        # envelope that has not folded the last requests in.
        rows[-1]["subtype"] = subtype
        rows[-1]["is_error"] = True
        rows[-1]["usage"] = {name: value // scale for name, value in rows[-1]["usage"].items()}
        support.write_rows(path, rows)

    return edit


def test_a_budget_stop_is_capped_with_its_spend_and_its_verdict(one_trial: OneTrial, make_manifest, make_runtime) -> None:
    record = one_trial(make_manifest(), make_runtime(spawn=support.fake_spawn(after=stopped("error_max_budget_usd"))))
    assert (record["outcome"], record["stop_reason"], record["invalid_reason"]) == ("capped", "budget", None)
    assert record["usage_reconciliation"]["status"] == "envelope_partial"
    assert record["usage_reconciliation"]["envelope"] == "partial"
    # Every request the transcript holds is counted, and the envelope's
    # own totals are kept beside them.
    assert len(record["usage"]) == 3
    assert all(item["delta"] <= 0 for item in record["usage_reconciliation"]["categories"].values())
    # The edit landed before the cap: the verifier says so, and the outcome
    # is still the cap. A pass-with-cap is a diagnostic, not a pass.
    assert record["verifier"] == {"id": "fake_answer_file", "exit_code": 0}
    assert record["patch_hash"] is not None
    reduction = reduce_module.reduce({record["trial_id"]: record}, [])
    arm = reduction["arms"][record["arm_id"]]
    assert arm["outcomes"]["capped"] == 1
    assert arm["accounting"] == "partial_by_cap"
    assert arm["tasks"][record["task_id"]]["passes"] == 0
    assert arm["tokens"] > 0
    assert reduction["invalid"] == []


def test_a_turn_stop_and_a_non_zero_exit_are_the_same_cap(one_trial: OneTrial, make_manifest, make_runtime) -> None:
    # The CLI reports its own stop as an error exit; the envelope names
    # the cap, and the cap outranks the exit code.
    record = one_trial(make_manifest(), make_runtime(spawn=support.fake_spawn(after=stopped("error_max_turns"), returncode=1, answer="41\n")))
    assert (record["outcome"], record["stop_reason"], record["invalid_reason"]) == ("capped", "turns", None)
    assert record["verifier"] == {"id": "fake_answer_file", "exit_code": 1}


def test_a_capped_envelope_that_counts_more_than_the_transcript_is_still_invalid(one_trial: OneTrial, make_manifest, make_runtime) -> None:
    def edit(launch: executor.Launch, roots: artifact.TrialRoots) -> None:
        path = roots.output / "sessions" / f"{launch.root_session_id}.jsonl"
        rows = support.read_rows(path)
        rows[-1]["subtype"] = "error_max_budget_usd"
        rows[-1]["usage"]["output_tokens"] += 1000
        support.write_rows(path, rows)

    record = one_trial(make_manifest(), make_runtime(spawn=support.fake_spawn(after=edit)))
    assert (record["outcome"], record["invalid_reason"], record["stop_reason"]) == ("invalid", "usage:mismatch", "budget")
    assert record["verifier"] is None


def test_verify_reads_a_capped_attempt_against_its_recorded_verdict(make_manifest, make_runtime, run_dir: Path) -> None:
    manifest = make_manifest()
    payload = cli.execute(manifest, schedule.expand(manifest), run_dir, make_runtime(spawn=support.fake_spawn(after=stopped("error_max_budget_usd"))))
    assert set(payload["outcomes"].values()) == {"capped"}
    verified = cli.do_verify(run_dir)
    assert verified["disagreements"] == []
    assert {entry["recorded"] for entry in verified["trials"].values()} == {"pass"}
    assert all(entry["agrees"] for entry in verified["trials"].values())


def test_a_timeout_kills_the_process_group_and_keeps_partial_usage(one_trial: OneTrial, make_manifest, run_dir: Path) -> None:
    record = one_trial(make_manifest(executor_name="fake_hang", wall_clock_s=1), runner.Runtime(settle_cap_s=0.0))
    assert record["stop_reason"] == "timeout"
    assert record["outcome"] == "capped"
    assert record["invalid_reason"] is None
    assert record["unresolved_actors"] == [""]
    # The worktree is final once the group is dead, so the verdict is recorded beside the cap.
    assert record["verifier"] == {"id": "fake_answer_file", "exit_code": 1}
    # The one request the root finished before the cap is still counted.
    assert len(record["usage"]) == 1
    assert record["usage"][0]["completion_state"] == "partial"
    assert record["usage"][0]["output_total"] > 0

    pids = json.loads((run_dir / "trials" / record["trial_id"] / "output" / "pids.json").read_text(encoding="utf-8"))
    for name, pid in pids.items():
        assert _gone(pid), f"{name} survived the process-group kill"


def test_interruption_and_resume_neither_overwrite_nor_duplicate_an_attempt(make_manifest, make_runtime, run_dir: Path) -> None:
    manifest = make_manifest(tasks=2)
    trials = schedule.expand(manifest)
    assert len(trials) == 4
    calls: list[int] = []
    working = support.fake_spawn()

    def spawn(launch: executor.Launch, roots: artifact.TrialRoots, timeout_s: float) -> runner.Completed:
        calls.append(1)
        if len(calls) == 3:
            raise KeyboardInterrupt
        return working(launch, roots, timeout_s)

    with pytest.raises(KeyboardInterrupt):
        runner.run(manifest, trials, run_dir, "sha256:schedule", make_runtime(spawn=spawn))
    records_dir = run_dir / "records"
    published = sorted(path.name for path in records_dir.glob("*.json"))
    assert len(published) == 2
    assert published == sorted(f"{trial.trial_id}.json" for trial in trials[:2])
    before = {path.name: (path.read_bytes(), path.stat().st_ino) for path in records_dir.glob("*.json")}

    results = runner.run(manifest, trials, run_dir, "sha256:schedule", make_runtime())
    assert [result.resumed for result in results] == [True, True, False, False]
    after = {path.name: (path.read_bytes(), path.stat().st_ino) for path in records_dir.glob("*.json")}
    assert len(after) == 4
    for name, value in before.items():
        assert after[name] == value, f"{name} was rewritten on resume"
    assert list(records_dir.glob("*.partial.*")) == []
    accepted, excluded = records.select(records_dir, manifest.hash, "sha256:schedule")
    assert len(accepted) == 4
    assert excluded == []


def test_a_three_level_actor_tree_survives_interruption_and_resume(make_manifest, make_runtime, run_dir: Path) -> None:
    manifest = make_manifest(tasks=2)
    trials = schedule.expand(manifest)
    calls: list[int] = []
    working = support.fake_spawn(grandchild=True)

    def spawn(launch: executor.Launch, roots: artifact.TrialRoots, timeout_s: float) -> runner.Completed:
        calls.append(1)
        if len(calls) == 3:
            raise KeyboardInterrupt
        return working(launch, roots, timeout_s)

    with pytest.raises(KeyboardInterrupt):
        runner.run(manifest, trials, run_dir, "sha256:schedule", make_runtime(spawn=spawn))
    records_dir = run_dir / "records"
    published = sorted(path.name for path in records_dir.glob("*.json"))
    assert published == sorted(f"{trial.trial_id}.json" for trial in trials[:2])
    before = {path.name: (path.read_bytes(), path.stat().st_ino) for path in records_dir.glob("*.json")}

    # Expand the schedule again rather than reusing the list: resume has to
    # re-derive the same ids from the manifest, not remember them.
    resumed_trials = schedule.expand(manifest)
    assert [trial.trial_id for trial in resumed_trials] == [trial.trial_id for trial in trials]
    results = runner.run(manifest, resumed_trials, run_dir, "sha256:schedule", make_runtime(spawn=working))
    assert [result.resumed for result in results] == [True, True, False, False]
    assert sorted(f"{result.trial_id}.json" for result in results[:2]) == published
    after = {path.name: (path.read_bytes(), path.stat().st_ino) for path in records_dir.glob("*.json")}
    assert len(after) == 4
    for name, value in before.items():
        assert after[name] == value, f"{name} was rewritten on resume"
    assert list(records_dir.glob("*.partial.*")) == []

    accepted, excluded = records.select(records_dir, manifest.hash, "sha256:schedule")
    assert len(accepted) == 4
    assert excluded == []
    for trial_id, record in sorted(accepted.items()):
        root, child, grand = (entry["key"][2] for entry in record["actors"])
        assert root == "", trial_id
        assert child.startswith("child-") and grand.startswith("grand-"), trial_id
        edges = {entry["key"][2]: (entry["parent_actor_key"], entry["parent_provenance"]) for entry in record["actors"]}
        assert edges[grand] == (record["actors"][1]["key"], "native")
        assert edges[child] == (record["actors"][0]["key"], "native")
        assert edges[""] == (None, "unavailable")
        assert {edge["provenance"] for edge in record["parent_edges"]} == {"native"}
        # The grandchild's own request is counted once, under the grandchild,
        # and the resume did not re-emit or drop it.
        grand_requests = [item for item in record["usage"] if item["actor_key"][2] == grand]
        assert [item["native_request_id"] for item in grand_requests] == ["req_g1"]
        assert [item["native_request_id"] for item in record["usage"]].count("req_g1") == 1
        assert record["outcome"] == "pass"


def test_a_stale_manifest_cannot_reuse_an_old_result(make_manifest, make_runtime, run_dir: Path) -> None:
    first = make_manifest()
    trials = schedule.expand(first)
    runner.run(first, trials, run_dir, "sha256:schedule", make_runtime())
    records_dir = run_dir / "records"

    second = Manifest(data=first.data, path=first.path, hash="sha256:manifest-v2")
    accepted, excluded = records.select(records_dir, second.hash, "sha256:schedule")
    assert accepted == {}
    assert [item.reason for item in excluded] == ["stale", "stale"]

    results = runner.run(second, schedule.expand(second), run_dir, "sha256:schedule", make_runtime())
    assert [result.resumed for result in results] == [False, False]
    assert len(list(records_dir.glob("*.json"))) == 4

    # Relabelling an old record is not a shortcut either: trial_id derives
    # from the manifest hash, so the file stops validating.
    stale = records_dir / f"{trials[0].trial_id}.json"
    record = json.loads(stale.read_text(encoding="utf-8"))
    stale.write_text(json.dumps({**record, "manifest_hash": second.hash}), encoding="utf-8")
    accepted, excluded = records.select(records_dir, second.hash, "sha256:schedule")
    assert len(accepted) == 2
    assert any(item.reason.startswith("invalid: trial_id does not derive") for item in excluded)


# An attempt whose spend cannot be counted once is invalid, not cheap.


def test_an_envelope_that_disagrees_with_the_records_fails_the_attempt_closed(one_trial: OneTrial, make_manifest, make_runtime) -> None:
    def edit(launch: executor.Launch, roots: artifact.TrialRoots) -> None:
        path = roots.output / "sessions" / f"{launch.root_session_id}.jsonl"
        rows = support.read_rows(path)
        rows[-1]["usage"] = {name: value + 1000 for name, value in rows[-1]["usage"].items()}
        support.write_rows(path, rows)

    record = one_trial(make_manifest(), make_runtime(spawn=support.fake_spawn(after=edit)))
    assert record["outcome"] == "invalid"
    assert record["invalid_reason"] == "usage:mismatch"
    assert record["usage_reconciliation"]["status"] == "mismatch"
    assert record["verifier"] is None


def test_one_request_id_under_two_actors_fails_the_attempt(one_trial: OneTrial, make_manifest, make_runtime) -> None:
    def edit(launch: executor.Launch, roots: artifact.TrialRoots) -> None:
        child = next((roots.output / "sessions" / launch.root_session_id / "subagents").glob("agent-*.jsonl"))
        rows = support.read_rows(child)
        rows[0]["requestId"] = "req_2"
        support.write_rows(child, rows)

    record = one_trial(make_manifest(), make_runtime(spawn=support.fake_spawn(after=edit)))
    assert record["outcome"] == "invalid"
    assert record["invalid_reason"] == "usage:duplicate_request"
    # Nothing was parsed, so nothing is presented as observed usage.
    assert record["usage"] == []
    assert record["usage_reconciliation"] == {"status": "unparsed"}


def test_a_forwarded_child_row_that_disagrees_with_the_child_fails_the_attempt(one_trial: OneTrial, make_manifest, make_runtime) -> None:
    def edit(launch: executor.Launch, roots: artifact.TrialRoots) -> None:
        sessions = roots.output / "sessions"
        child = next((sessions / launch.root_session_id / "subagents").glob("agent-*.jsonl"))
        echo = dict(support.read_rows(child)[0])
        echo["message"] = {**echo["message"], "usage": {**echo["message"]["usage"], "output_tokens": 99999}}
        root = sessions / f"{launch.root_session_id}.jsonl"
        rows = support.read_rows(root)
        support.write_rows(root, rows[:-1] + [echo] + rows[-1:])

    record = one_trial(make_manifest(), make_runtime(spawn=support.fake_spawn(after=edit)))
    assert record["outcome"] == "invalid"
    assert record["invalid_reason"] == "usage:conflicting_records"


def test_a_live_loop_db_wal_means_settlement_is_incomplete(one_trial: OneTrial, make_manifest, make_runtime) -> None:
    def edit(launch: executor.Launch, roots: artifact.TrialRoots) -> None:
        support.write_loop_db(roots.data_dir / "loop.db", [("fire-root", launch.root_session_id, "")])
        (roots.data_dir / "loop.db-wal").write_bytes(b"\x37\x7f\x06\x82" + b"\x00" * 28)

    record = one_trial(make_manifest(), make_runtime(spawn=support.fake_spawn(after=edit)))
    assert record["outcome"] == "invalid"
    assert record["invalid_reason"] == "delivery:wal_live"
    assert record["delivery"] == loop_join.unavailable()


def test_a_fire_for_an_actor_with_no_usage_is_an_attribution_error(one_trial: OneTrial, make_manifest, make_runtime) -> None:
    def edit(launch: executor.Launch, roots: artifact.TrialRoots) -> None:
        session = launch.root_session_id
        support.write_loop_db(roots.data_dir / "loop.db", [("fire-root", session, ""), ("fire-ghost", session, "ghost01")])

    record = one_trial(make_manifest(), make_runtime(spawn=support.fake_spawn(after=edit)))
    assert record["outcome"] == "invalid"
    assert record["invalid_reason"] == "delivery:fire_without_usage"
    assert [fire["fire_id"] for fire in record["delivery"]["fires"]] == ["fire-root"]
    assert [fire["fire_id"] for fire in record["delivery"]["unmatched_fires"]] == ["fire-ghost"]


# The auxiliary seam: benchmark-owned receipts for memory-product spend.


def collector(*ids: str, trial: str | None = None) -> runner.Receipts:
    def collect(trial_id: str, roots: artifact.TrialRoots) -> list[AuxiliaryReceipt]:
        return [
            AuxiliaryReceipt(
                trial_id=trial or trial_id,
                component="observer",
                phase="consumer",
                native_request_id=request_id,
                input_total=400,
                output_total=100,
                source_hash="sha256:receipt",
            )
            for request_id in ids
        ]

    return collect


def test_collected_receipts_enter_the_record_and_the_numerator(one_trial: OneTrial, make_manifest, make_runtime) -> None:
    record = one_trial(make_manifest(), make_runtime(receipts=collector("aux_1", "aux_2")))
    assert record["outcome"] == "pass"
    assert [item["native_request_id"] for item in record["auxiliary"]] == ["aux_1", "aux_2"]
    reduction = reduce_module.reduce({record["trial_id"]: record}, [])
    cell = reduction["arms"][record["arm_id"]]["tasks"][record["task_id"]]
    assert cell["diagnostics"]["auxiliary_consumer_tokens"] == 1000
    assert cell["tokens"] == sum(item["input_total"] + item["output_total"] for item in record["usage"]) + 1000


@pytest.mark.parametrize(
    ("code", "receipts"),
    [("duplicate_request", collector("aux_1", "aux_1")), ("foreign_trial", collector("aux_1", trial="another-trial"))],
)
def test_a_receipt_that_cannot_be_counted_once_makes_the_attempt_invalid(
    one_trial: OneTrial, make_manifest, make_runtime, code: str, receipts: runner.Receipts
) -> None:
    record = one_trial(make_manifest(), make_runtime(receipts=receipts))
    assert record["outcome"] == "invalid"
    assert record["invalid_reason"] == f"auxiliary:{code}"
    # A contradictory receipt set is never published as observed spend.
    assert record["auxiliary"] == []


def test_a_receipt_reusing_a_consumer_request_id_makes_the_attempt_invalid(one_trial: OneTrial, make_manifest, make_runtime) -> None:
    record = one_trial(make_manifest(), make_runtime(receipts=collector("req_1")))
    assert record["outcome"] == "invalid"
    assert record["invalid_reason"] == "auxiliary:duplicate_request"


def test_a_refused_prepare_invalidates_its_trial_and_the_run_goes_on(
    tmp_path: Path, make_runtime, run_dir: Path, register_executor
) -> None:
    """One trial's provisioning refused: that trial is invalid under the reason, and the next trial runs."""
    prepared: list[str] = []

    def prepare(request: executor.ProvisionRequest) -> executor.Provision:
        prepared.append(request.trial_id)
        if len(prepared) == 1:
            raise executor.ProvisionError("seed key drift: the lesson records another key", code="seed_key_drift")
        return executor.Provision()

    name = register_executor(
        "provisioned_only_for_this_test",
        ExecutorSpec(name="provisioned_only_for_this_test", harness="claude", launch=executor.REGISTRY["fake"].launch, prepare=prepare),
    )
    manifest = support.synthetic_manifest(tmp_path, executor_name=name, arms=("on", "on2"))
    for arm in manifest.data["arms"]:
        arm["provision"] = "tenjin"
    results = runner.run(manifest, schedule.expand(manifest), run_dir, "sha256:schedule", make_runtime())
    assert [result.outcome for result in results] == ["invalid", "pass"]
    assert len(prepared) == 2
    first = json.loads(results[0].path.read_text(encoding="utf-8"))
    records.validate(first)
    assert (first["invalid_reason"], first["usage"], first["actors"], first["stop_reason"]) == ("provision:seed_key_drift", [], [], "exit")
    assert "seed key drift" in (run_dir / "trials" / results[0].trial_id / "output" / "provision-refusal.txt").read_text(encoding="utf-8")
    assert "seed key drift" not in json.dumps(first)
    # The default code, for a provisioner that names none.
    assert executor.ProvisionError("plain").code == "refused"


@pytest.fixture
def live_manifest(make_manifest, register_executor) -> Manifest:
    register_executor(
        LIVE,
        ExecutorSpec(
            name=LIVE,
            harness="claude",
            launch=executor.REGISTRY["fake"].launch,
            live=True,
            required_origins=("api.provider.example",),
        ),
    )
    return make_manifest(executor_name=LIVE)


def test_a_publishable_live_run_is_refused_without_an_isolation_attestation(
    one_trial: OneTrial, live_manifest: Manifest, make_runtime, run_dir: Path
) -> None:
    with pytest.raises(IsolationError) as caught:
        one_trial(live_manifest, make_runtime(publishable=True, ci=False))
    assert caught.value.code == "attestation_missing"
    assert not (run_dir / "trials").exists()


def test_a_live_run_in_ci_that_is_not_stamped_automated_is_refused(one_trial: OneTrial, live_manifest: Manifest, make_runtime) -> None:
    with pytest.raises(IsolationError) as caught:
        one_trial(live_manifest, make_runtime(publishable=False, ci=True, attestation=None))
    assert caught.value.code == "automated_unstamped"


def test_an_automated_plumbing_run_is_allowed_in_ci_and_stamped(one_trial: OneTrial, live_manifest: Manifest, make_runtime) -> None:
    record = one_trial(live_manifest, make_runtime(publishable=False, ci=True, automated=True))
    assert record["isolation"]["live"] is True
    assert record["isolation"]["publishable"] is False
    assert record["isolation"]["automated"] is True
    assert record["isolation"]["attested_container"] is False


def test_an_automated_run_that_claims_publishable_without_an_attestation_is_refused_before_any_root_exists(
    one_trial: OneTrial, live_manifest: Manifest, make_runtime, run_dir: Path
) -> None:
    with pytest.raises(IsolationError) as caught:
        one_trial(live_manifest, make_runtime(publishable=True, ci=True, automated=True))
    assert caught.value.code == "attestation_missing"
    assert not (run_dir / "trials").exists()


def test_an_attested_automated_run_is_publishable_and_still_stamped_automated(
    one_trial: OneTrial, live_manifest: Manifest, make_runtime
) -> None:
    # The contract the bench lane rests on: the attestation carries
    # publishability, and `automated` stays in the record as a fact a
    # reader sees rather than as a bar on the run.
    record = one_trial(live_manifest, make_runtime(publishable=True, ci=True, automated=True, attestation=ATTESTED))
    assert record["isolation"]["publishable"] is True
    assert record["isolation"]["automated"] is True
    assert record["isolation"]["attested_container"] is True
    assert record["isolation"]["attestation_hash"] == ATTESTED.hash()


def test_an_attested_live_run_records_its_attestation(one_trial: OneTrial, live_manifest: Manifest, make_runtime) -> None:
    record = one_trial(live_manifest, make_runtime(publishable=True, ci=False, attestation=ATTESTED))
    assert record["isolation"]["live"] is True
    assert record["isolation"]["attested_container"] is True
    assert record["isolation"]["attestation_hash"] == ATTESTED.hash()


class Shelf:
    """A stand-in for the one shelf a provisioning arm seeds, searches, and clears.

    `prepare` opens a seeded window and `stop` closes it, exactly where
    `tenjin_arm.py` publishes and deletes. `peak` is how many were ever open at
    once, which is the whole property under test, and the agent's turn holds
    its window open long enough that a second one would land inside it.
    """

    def __init__(self, hold_s: float = 0.05) -> None:
        self.lock = threading.Lock()
        self.open = 0
        self.peak = 0
        self.events: list[str] = []
        self.hold_s = hold_s

    def prepare(self, request: executor.ProvisionRequest) -> executor.Provision:
        with self.lock:
            self.open += 1
            self.peak = max(self.peak, self.open)
            self.events.append("seed")
        return executor.Provision()

    def stop(self, roots: artifact.TrialRoots, provision: executor.Provision) -> dict:
        with self.lock:
            self.open -= 1
            self.events.append("delete")
        return {}

    def spawn(self, launch: executor.Launch, roots: artifact.TrialRoots, timeout_s: float) -> runner.Completed:
        time.sleep(self.hold_s)
        return support.fake_spawn()(launch, roots, timeout_s)


# `pins.concurrency` trials at once, and never two inside a seeded window.


@pytest.fixture
def provisioning(register_executor) -> Callable[[Shelf, str], str]:
    def register(shelf: Shelf, name: str) -> str:
        return register_executor(
            name,
            ExecutorSpec(name=name, harness="claude", launch=executor.REGISTRY["fake"].launch, prepare=shelf.prepare, stop=shelf.stop),
        )

    return register


@pytest.fixture
def execute(run_dir: Path) -> Callable[[Manifest, runner.Spawn], list[runner.TrialResult]]:
    def run(manifest: Manifest, spawn: runner.Spawn) -> list[runner.TrialResult]:
        return runner.run(manifest, schedule.expand(manifest), run_dir, "sha256:schedule", runner.Runtime(spawn=spawn, settle_cap_s=5.0))

    return run


def test_two_trials_that_seed_the_shelf_never_overlap(tmp_path: Path, provisioning, execute) -> None:
    shelf = Shelf()
    manifest = support.synthetic_manifest(
        tmp_path, executor_name=provisioning(shelf, "provisioned_no_overlap"), arms=("on", "on2"), repeats=3, concurrency=4
    )
    for arm in manifest.data["arms"]:
        arm["provision"] = "tenjin"
    assert [result.outcome for result in execute(manifest, shelf.spawn)] == ["pass"] * 6
    assert shelf.peak == 1
    # Six windows, one at a time: the deletion of each precedes the next seed.
    assert shelf.events == ["seed", "delete"] * 6


def test_trials_that_seed_nothing_run_at_the_same_time(tmp_path: Path, execute) -> None:
    # The barrier releases only with a second trial inside it at the same
    # moment, so a runner that serialized would fail on its timeout rather
    # than pass on a sleep that happened to be long enough.
    barrier = threading.Barrier(2, timeout=20)

    def spawn(launch: executor.Launch, roots: artifact.TrialRoots, timeout_s: float) -> runner.Completed:
        barrier.wait()
        return support.fake_spawn()(launch, roots, timeout_s)

    manifest = support.synthetic_manifest(tmp_path, arms=("off", "off2"), concurrency=2)
    assert [result.outcome for result in execute(manifest, spawn)] == ["pass", "pass"]


def test_a_trial_that_seeds_nothing_runs_inside_another_trials_seeded_window(tmp_path: Path, provisioning, execute) -> None:
    shelf = Shelf()
    barrier = threading.Barrier(2, timeout=20)

    def spawn(launch: executor.Launch, roots: artifact.TrialRoots, timeout_s: float) -> runner.Completed:
        barrier.wait()
        return support.fake_spawn()(launch, roots, timeout_s)

    manifest = support.synthetic_manifest(
        tmp_path, executor_name=provisioning(shelf, "provisioned_inside_window"), arms=("off", "on"), concurrency=2
    )
    for arm in manifest.data["arms"]:
        if arm["id"] == "on":
            arm["provision"] = "tenjin"
    assert [result.outcome for result in execute(manifest, spawn)] == ["pass", "pass"]
    assert shelf.peak == 1


def test_the_schedule_is_unchanged_and_the_results_come_back_in_its_order(tmp_path: Path, run_dir: Path) -> None:
    serial = support.synthetic_manifest(tmp_path, arms=("off", "on"), repeats=2)
    concurrent = support.synthetic_manifest(tmp_path, arms=("off", "on"), repeats=2, concurrency=4)

    def assignment(trials: list[schedule.Trial]) -> list[tuple]:
        return [(trial.task_id, trial.arm_id, trial.repeat, trial.position) for trial in trials]

    # The pin is not an input to the expansion: same seeded task order,
    # same rotated arm order, same positions.
    trials = schedule.expand(concurrent)
    assert assignment(trials) == assignment(schedule.expand(serial))

    released = threading.Event()
    lock = threading.Lock()
    finished: list[str] = []

    def spawn(launch: executor.Launch, roots: artifact.TrialRoots, timeout_s: float) -> runner.Completed:
        # The first trial assigned is made to finish after another one.
        if roots.trial_id == trials[0].trial_id:
            released.wait(timeout=20)
        completed = support.fake_spawn()(launch, roots, timeout_s)
        with lock:
            finished.append(roots.trial_id)
        released.set()
        return completed

    results = runner.run(concurrent, trials, run_dir, "sha256:schedule", runner.Runtime(spawn=spawn, settle_cap_s=5.0))
    assert len(finished) == 4
    assert finished[0] != trials[0].trial_id
    assert [result.trial_id for result in results] == [trial.trial_id for trial in trials]


def test_a_failing_trial_ends_the_run_without_stranding_another(tmp_path: Path, run_dir: Path) -> None:
    manifest = support.synthetic_manifest(tmp_path, arms=("off", "on"), concurrency=2)
    trials = schedule.expand(manifest)
    doomed, healthy = trials[0].trial_id, trials[1].trial_id
    started = threading.Event()

    def spawn(launch: executor.Launch, roots: artifact.TrialRoots, timeout_s: float) -> runner.Completed:
        if roots.trial_id == doomed:
            # The other trial is already inside its own attempt, so what
            # this case proves is not a cancellation race.
            started.wait(timeout=20)
            raise RuntimeError("the executor seam broke")
        started.set()
        return runner.process_spawn(launch, roots, timeout_s)

    with pytest.raises(RuntimeError):
        runner.run(manifest, trials, run_dir, "sha256:schedule", runner.Runtime(spawn=spawn, settle_cap_s=5.0))
    # The trial that was running finished and published; the one that
    # failed published nothing, and no process or ledger entry outlived
    # either of them for a person to clean up by hand.
    assert records.final_path(run_dir / "records", healthy).is_file()
    assert not records.final_path(run_dir / "records", doomed).exists()
    assert reap.survivors(run_dir) == []
    assert reap.read_records(run_dir) == []


def test_a_run_with_a_sentinel_refuses_more_than_one_trial_at_a_time(tmp_path: Path, run_dir: Path) -> None:
    # The sentinel is one server for the run and its hits name no trial, so
    # a trial claims whatever arrived while it ran. Two overlapping trials
    # make that the wrong trial, and a hit invalidates an attempt.
    sentinel = start_sentinel()
    try:
        manifest = support.synthetic_manifest(tmp_path, concurrency=2)
        with pytest.raises(runner.ConcurrencyError):
            runner.run(
                manifest,
                schedule.expand(manifest),
                run_dir,
                "sha256:schedule",
                runner.Runtime(spawn=support.fake_spawn(), sentinel=sentinel),
            )
        assert not run_dir.exists()
    finally:
        sentinel.stop()
