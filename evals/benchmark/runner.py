"""Execute a schedule: one fresh root per trial, settle, verify, record.

An attempt closes only when the root has exited and every discovered child has
a terminal row, or when a declared cap ends the wait. Two caps, two outcomes:
the wall-clock budget kills the whole process group and the attempt is
`capped`; the settlement cap ends a wait for descendants that never stopped
and the attempt is `interrupted`. Both retain the usage observed so far and
name the actors that never settled.

The process boundary, the clock, and the settlement barrier are injected, so
every case except the process-group kill runs without real time or a real
agent. A trial with a valid final record for the current manifest and schedule
hashes is skipped on resume, and an interrupted run publishes nothing for the
trial it was inside.
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from . import artifact, claude_usage, executor, loop_join, records, sha256_dir, sha256_file, sha256_json, sha256_text, usage, verifier
from .manifest import Manifest
from . import reap
from .schedule import Trial

Clock = Callable[[], float]
Sleep = Callable[[float], None]
# The auxiliary seam: a runtime that knows how a memory product logs its own
# model calls returns them as receipts for one trial. The benchmark owns the
# receipts; nothing in the manifest or the agent's output can mint one.
Receipts = Callable[[str, artifact.TrialRoots], list[usage.AuxiliaryReceipt]]


@dataclass(frozen=True)
class Completed:
    returncode: int
    stderr: str
    timed_out: bool


Spawn = Callable[[executor.Launch, artifact.TrialRoots, float], Completed]


@dataclass(frozen=True)
class TrialResult:
    trial_id: str
    outcome: str
    resumed: bool
    path: Path


def process_spawn(launch: executor.Launch, roots: artifact.TrialRoots, timeout_s: float) -> Completed:
    """The only place this package starts a process. Own session, no shell.

    The group is recorded before it is waited on and released only once it is
    dead, so a leftover is a file under `<run>/pids/` that `cli.py cleanup`
    acts on. Nothing here, and nothing an operator or an agent has to do
    afterwards, matches a process by name: that is how a cleanup aimed at one
    trial reaches an unrelated session.
    """
    process = subprocess.Popen(
        launch.argv,
        cwd=launch.cwd,
        # A launch that owns its environment has already allowlisted it; the
        # roots' default is what every executor without that need gets.
        env=launch.env if launch.env is not None else roots.environment(os.environ.get("PATH", "")),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
        shell=False,
    )
    reap.register(roots.run_dir, roots.trial_id, process.pid, launch.argv[0])
    timed_out = False
    try:
        try:
            _, stderr = process.communicate(timeout=timeout_s)
        except subprocess.TimeoutExpired:
            timed_out = True
            _kill_group(process)
            _, stderr = process.communicate()
    finally:
        # An exception on the way out, an interrupt included, must not leave a
        # paid agent running. This is the guarantee that makes a manual kill
        # unnecessary rather than merely discouraged.
        if process.poll() is None:
            _kill_group(process)
            try:
                process.communicate(timeout=_ORPHAN_WAIT_S)
            except subprocess.TimeoutExpired:  # pragma: no cover - the group is already SIGKILLed
                pass
        reap.release(roots.run_dir, roots.trial_id)
    return Completed(returncode=process.returncode, stderr=stderr or "", timed_out=timed_out)


# How long the finally-path waits for a SIGKILLed group before giving up on
# collecting its output. The signal has already been sent; this only bounds the
# read.
_ORPHAN_WAIT_S = 5.0


def _kill_group(process: subprocess.Popen[str]) -> None:
    """Kill the trial's whole process group: a live grandchild still spends."""
    try:
        os.killpg(os.getpgid(process.pid), signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        process.kill()


@dataclass(frozen=True)
class Runtime:
    clock: Clock = time.monotonic
    sleep: Sleep = time.sleep
    # Resolved when a Runtime is built, not when this class is defined. A
    # plain default would bind the function object once and for all, and a
    # test that replaces `runner.process_spawn` to prove nothing starts would
    # then be guarding a name the runtime no longer reads.
    spawn: Spawn = field(default_factory=lambda: process_spawn)
    settle_cap_s: float = 30.0
    settle_interval_s: float = 0.25
    sentinel: artifact.SentinelLike | None = None
    receipts: Receipts | None = None
    attestation: artifact.Attestation | None = None
    publishable: bool = True
    ci: bool = field(default_factory=lambda: bool(os.environ.get("CI")))


@dataclass(frozen=True)
class Settlement:
    result_row: dict[str, Any] | None
    unresolved: list[str]
    waited_s: float
    capped: bool

    @property
    def settled(self) -> bool:
        return self.result_row is not None and not self.unresolved


def _terminal(path: Path) -> dict[str, Any] | None:
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        event = json.loads(line)
        if event.get("type") == "result":
            return event
    return None


def scan(sessions: Path, root_session_id: str) -> tuple[dict[str, Any] | None, list[str]]:
    """The root's result row, plus every actor still without a terminal row."""
    root = sessions / f"{root_session_id}.jsonl"
    if not root.is_file():
        return None, [""]
    unresolved = [
        child.stem.removeprefix("agent-")
        for child in sorted((sessions / root_session_id / "subagents").glob("agent-*.jsonl"))
        if _terminal(child) is None
    ]
    result_row = _terminal(root)
    return result_row, ([""] if result_row is None else []) + unresolved


def settle(sessions: Path, root_session_id: str, runtime: Runtime) -> Settlement:
    """Wait for descendants to stop, up to the declared settlement cap.

    A root that exits while a child is live is not a complete attempt, so the
    wait is the default and the cap is the exception.
    """
    started = runtime.clock()
    while True:
        result_row, unresolved = scan(sessions, root_session_id)
        waited = runtime.clock() - started
        if result_row is not None and not unresolved:
            return Settlement(result_row, [], waited, False)
        if waited >= runtime.settle_cap_s:
            return Settlement(result_row, unresolved, waited, True)
        runtime.sleep(min(runtime.settle_interval_s, runtime.settle_cap_s - waited))


def run_trial(manifest: Manifest, trial: Trial, run_dir: Path, schedule_hash: str, runtime: Runtime = Runtime()) -> dict[str, Any]:
    task = next(item for item in manifest.tasks if item["id"] == trial.task_id)
    arm = next(item for item in manifest.arms if item["id"] == trial.arm_id)
    spec = executor.lookup(arm["executor"])
    if spec.harness != manifest.harness:
        raise executor.ExecutorError(f"executor {spec.name!r} runs {spec.harness!r}, manifest pins {manifest.harness!r}")
    verifier_spec = verifier.lookup(task["verifier"])
    isolation = artifact.require_isolation(
        live=spec.live,
        publishable=runtime.publishable,
        attestation=runtime.attestation,
        required_origins=spec.required_origins,
        credential_seam=None if spec.credential_seam is None else spec.credential_seam(manifest.pins),
        ci=runtime.ci,
    )
    origin = None if runtime.sentinel is None else runtime.sentinel.origin
    roots = artifact.create(run_dir, trial.trial_id, manifest.fixture_path(task), public_origin=origin)
    launch = spec.launch(executor.LaunchRequest(trial.trial_id, roots, task, arm, manifest.pins))
    hits_before = 0 if runtime.sentinel is None else len(runtime.sentinel.hits)

    started = runtime.clock()
    completed = runtime.spawn(launch, roots, float(manifest.pins["wall_clock_s"]))
    # The spec says where its harness left the transcripts; the parser and the
    # settlement scan read that directory whatever the harness is.
    sessions = spec.sessions(roots, launch.root_session_id)
    if completed.timed_out:
        result_row, unresolved = scan(sessions, launch.root_session_id)
        settlement = Settlement(result_row, unresolved, 0.0, False)
        stop_reason = "timeout"
    else:
        settlement = settle(sessions, launch.root_session_id, runtime)
        stop_reason = "interrupted" if settlement.capped else "exit"
    roots.mark_stopped()
    wall_time_s = runtime.clock() - started

    isolation_reason: str | None = None
    try:
        roots.audit()
    except artifact.ArtifactError as error:
        isolation_reason = f"isolation:{error.code}"
    hits = 0 if runtime.sentinel is None else len(runtime.sentinel.hits) - hits_before
    sentinel = artifact.scan_sentinels(roots, hits)

    session: claude_usage.SessionUsage | None = None
    usage_reason: str | None = None
    try:
        session = claude_usage.parse_session_dir(sessions, launch.root_session_id, trial.trial_id)
        usage_reason = session.invalid_reason
    except claude_usage.ClaudeUsageError as error:
        usage_reason = f"usage:{error.code}"
    actors = [] if session is None else session.actors
    try:
        delivery = loop_join.project(roots.data_dir / "loop.db", actors)
    except loop_join.LoopJoinError:
        delivery = loop_join.unavailable()
        usage_reason = usage_reason or "delivery:wal_live"
    if delivery["unmatched_fires"]:
        usage_reason = usage_reason or "delivery:fire_without_usage"

    auxiliary: list[dict[str, Any]] = []
    if runtime.receipts is not None:
        collected = runtime.receipts(trial.trial_id, roots)
        try:
            if any(receipt.trial_id != trial.trial_id for receipt in collected):
                raise usage.UsageError("foreign_trial", "an auxiliary receipt names another trial")
            usage.check_receipts(collected, [] if session is None else session.records)
        except usage.UsageError as error:
            # A contradictory receipt set is not a fact a record can carry, so
            # the attempt is invalid and names the code instead of publishing
            # spend it cannot attribute.
            usage_reason = usage_reason or f"auxiliary:{error.code}"
        else:
            auxiliary = [receipt.to_json() for receipt in collected]

    # Isolation first: an attempt that reached outside its roots is invalid
    # whatever else it did. A sentinel hit outranks an accounting gap for the
    # same reason.
    invalid_reason = isolation_reason or sentinel.reason or usage_reason
    outcome = "invalid"
    verdict: verifier.Verdict | None = None
    patch_hash: str | None = None
    if invalid_reason is not None:
        pass
    elif completed.timed_out:
        outcome = "capped"
    elif completed.returncode != 0:
        invalid_reason = f"executor:exit_{completed.returncode}"
    elif settlement.capped:
        outcome = "interrupted"
    elif session is not None and session.envelope is not None and session.envelope.capped:
        outcome = "capped"
    elif session is not None and session.envelope is not None and session.envelope.is_error:
        invalid_reason = f"harness:{session.envelope.subtype}"
    else:
        try:
            copy = roots.hidden_copy(verifier_spec.hidden_layer)
        except artifact.ArtifactError as error:
            copy = None
            invalid_reason = f"isolation:{error.code}"
        if copy is not None:
            patch_hash = "sha256:" + sha256_dir(copy)
            verdict = verifier.run(verifier_spec, copy, run_dir)
            outcome = verdict.outcome
            if outcome == "invalid":
                invalid_reason = f"verifier:{verdict.verifier_id}"
    if invalid_reason is not None:
        outcome = "invalid"

    root_transcript = sessions / f"{launch.root_session_id}.jsonl"
    usage_fields = (
        {
            "native_root_id": launch.root_session_id,
            "actors": [],
            "parent_edges": [],
            "usage": [],
            "usage_reconciliation": {"status": "unparsed"},
            "tool_counts": {},
            "turns": None,
            "cost_usd": None,
        }
        if session is None
        else session.record_fields()
    )
    return {
        "schema": records.RECORD_SCHEMA,
        "trial_id": trial.trial_id,
        "manifest_hash": manifest.hash,
        "schedule_hash": schedule_hash,
        "task_id": trial.task_id,
        "arm_id": trial.arm_id,
        "repeat": trial.repeat,
        "position": trial.position,
        "settings_hash": arm["settings_hash"],
        "environment_hash": "sha256:" + sha256_json(manifest.pins),
        "harness": spec.harness,
        **usage_fields,
        "auxiliary": auxiliary,
        "outcome": outcome,
        "invalid_reason": invalid_reason,
        "verifier": None if verdict is None else {"id": verdict.verifier_id, "exit_code": verdict.exit_code},
        "patch_hash": patch_hash,
        "stop_reason": stop_reason,
        "wall_time_s": wall_time_s,
        "unresolved_actors": settlement.unresolved,
        "delivery": delivery,
        "sentinel": sentinel.counts(),
        "isolation": isolation,
        "private_hashes": {
            "root_transcript": sha256_file(root_transcript) if root_transcript.is_file() else None,
            "executor_stderr": sha256_text(completed.stderr) if completed.stderr else None,
        },
    }


def run(
    manifest: Manifest, trials: list[Trial], run_dir: Path, schedule_hash: str, runtime: Runtime = Runtime()
) -> list[TrialResult]:
    records_dir = run_dir / "records"
    accepted, _ = records.select(records_dir, manifest.hash, schedule_hash)
    results: list[TrialResult] = []
    for trial in trials:
        if trial.trial_id in accepted:
            results.append(
                TrialResult(
                    trial.trial_id, accepted[trial.trial_id]["outcome"], True, records.final_path(records_dir, trial.trial_id)
                )
            )
            continue
        # An interruption inside a trial publishes nothing: the next run finds
        # no final record for it and executes it once, from the top.
        record = run_trial(manifest, trial, run_dir, schedule_hash, runtime)
        path, won = records.publish(records_dir, record)
        if not won:
            raise records.RecordError(f"another writer published trial {trial.trial_id} first")
        results.append(TrialResult(trial.trial_id, record["outcome"], False, path))
    return results
