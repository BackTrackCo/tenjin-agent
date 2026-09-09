"""Execute a schedule: one fresh root per trial, settle, verify, record.

An attempt closes only when the root has exited and every discovered child has
a terminal row, or when a declared cap ends the wait. Three caps, two outcomes:
the wall-clock budget kills the whole process group and the attempt is
`capped` with stop reason `timeout`; the harness's own budget and turn stops
end the session from inside and the attempt is `capped` with stop reason
`budget` or `turns`; the settlement cap ends a wait for descendants that never
stopped and the attempt is `interrupted`. All retain the usage observed so far,
a capped attempt keeps its spend as a task outcome rather than an invalid one,
and every cap names the actors that never settled.

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

from . import artifact, claude_usage, discovery, executor, loop_join, producer as producer_module, records, sha256_dir, sha256_file, sha256_json, sha256_text, usage, verifier
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
    roots.output.mkdir(parents=True, exist_ok=True)
    stream = roots.stream.open("w", encoding="utf-8")
    process = subprocess.Popen(
        launch.argv,
        cwd=launch.cwd,
        # A launch that owns its environment has already allowlisted it; the
        # roots' default is what every executor without that need gets.
        env=launch.env if launch.env is not None else roots.environment(os.environ.get("PATH", "")),
        stdout=stream,
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
        stream.close()
    return Completed(returncode=process.returncode, stderr=stderr or "", timed_out=timed_out)


# How long the finally-path waits for a SIGKILLed group before giving up on
# collecting its output. The signal has already been sent; this only bounds the
# read.
_ORPHAN_WAIT_S = 5.0


def _kill_group(process: subprocess.Popen[str], sig: int = signal.SIGKILL) -> None:
    """Signal the trial's whole process group: a live grandchild still spends."""
    try:
        os.killpg(os.getpgid(process.pid), sig)
    except (ProcessLookupError, PermissionError):
        process.send_signal(sig)


@dataclass(frozen=True)
class Started:
    """A helper process an arm's provisioning owns for the length of one trial."""

    process: subprocess.Popen[Any]
    ledger_id: str


def process_start(
    argv: list[str], *, cwd: Path, env: dict[str, str], roots: artifact.TrialRoots, ledger_id: str, log: Path
) -> Started:
    """Start a helper the way the agent is started: own session, no shell, in the ledger.

    The one other place a process begins. It exists for a provisioned arm's
    daemon, which has to outlive the launch call and die before `loop.db` is
    read, so it cannot be a child of the agent's group; its own group is
    recorded under the trial's ledger id with a suffix, and `cli.py cleanup`
    reaches it the same way.
    """
    log.parent.mkdir(parents=True, exist_ok=True)
    with log.open("a", encoding="utf-8") as handle:
        process = subprocess.Popen(
            argv,
            cwd=cwd,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=handle,
            stderr=subprocess.STDOUT,
            start_new_session=True,
            shell=False,
        )
    reap.register(roots.run_dir, ledger_id, process.pid, argv[0])
    return Started(process=process, ledger_id=ledger_id)


def process_stop(started: Started, run_dir: Path, grace_s: float) -> int | None:
    """SIGTERM the helper's group, wait, SIGKILL what is left, and clear its ledger entry."""
    process = started.process
    try:
        if process.poll() is None:
            _kill_group(process, signal.SIGTERM)
            try:
                process.wait(timeout=grace_s)
            except subprocess.TimeoutExpired:
                _kill_group(process)
                try:
                    process.wait(timeout=_ORPHAN_WAIT_S)
                except subprocess.TimeoutExpired:  # pragma: no cover - the group is already SIGKILLed
                    pass
    finally:
        reap.release(run_dir, started.ledger_id)
    return process.returncode


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
    automated: bool = False
    # What a provisioned arm is seeded from (`live-run --tenjin-source`). The
    # executor's module reads it; the runner only passes it through and folds
    # its isolation facts into the record.
    source: Any = None
    # The run's nonce (`cli.run_nonce`), handed to a provisioner that seeds a
    # shelf: the CLI dedups a body per machine by content hash, and trial ids
    # repeat across runs of one manifest, so the body has to carry the run.
    run_nonce: str | None = None


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


def scan(sessions: Path, root_session_id: str, stream: Path | None = None) -> tuple[dict[str, Any] | None, list[str]]:
    """The root's result row, plus every actor still without a terminal row.

    The row is looked for in the transcript first and then in the captured
    stream, because a real Claude run puts its envelope only on stdout while
    the fake executors write theirs into the transcript. Either source settles
    the root; neither is read for usage, so nothing is counted twice.
    """
    root = sessions / f"{root_session_id}.jsonl"
    if not root.is_file():
        return None, [""]
    unresolved = [
        child.stem.removeprefix("agent-")
        for child in sorted((sessions / root_session_id / "subagents").glob("agent-*.jsonl"))
        if _terminal(child) is None
    ]
    result_row = _terminal(root)
    if result_row is None and stream is not None and stream.is_file():
        result_row = _terminal(stream)
    return result_row, ([""] if result_row is None else []) + unresolved


def settle(sessions: Path, root_session_id: str, runtime: Runtime, stream: Path | None = None) -> Settlement:
    """Wait for descendants to stop, up to the declared settlement cap.

    A root that exits while a child is live is not a complete attempt, so the
    wait is the default and the cap is the exception.
    """
    started = runtime.clock()
    while True:
        result_row, unresolved = scan(sessions, root_session_id, stream)
        waited = runtime.clock() - started
        if result_row is not None and not unresolved:
            return Settlement(result_row, [], waited, False)
        if waited >= runtime.settle_cap_s:
            return Settlement(result_row, unresolved, waited, True)
        runtime.sleep(min(runtime.settle_interval_s, runtime.settle_cap_s - waited))


def isolation_of(isolation: dict[str, Any], provision: executor.Provision | None, stop: dict[str, Any] | None) -> dict[str, Any]:
    """The record's isolation block: the gate's facts, the daemon's, and what became of the seeded piece."""
    if provision is None:
        return isolation
    out = {**isolation, "daemon_respawned": bool((stop or {}).get("respawned", False))}
    seeds = provision.facts.get("seed")
    if seeds is not None:
        deleted = (stop or {}).get("seed_deleted") or {}
        out["seed"] = []
        for seed in seeds:
            entry = dict(seed)
            piece_id = entry.get("piece_id")
            if piece_id in deleted:
                entry.update({"deleted": deleted[piece_id] is None, "delete_error": deleted[piece_id]})
            out["seed"].append(entry)
    return out


def run_trial(manifest: Manifest, trial: Trial, run_dir: Path, schedule_hash: str, runtime: Runtime = Runtime()) -> dict[str, Any]:
    task = next(item for item in manifest.tasks if item["id"] == trial.task_id)
    arm = next(item for item in manifest.arms if item["id"] == trial.arm_id)
    spec = executor.lookup(arm["executor"])
    if spec.harness != manifest.harness:
        raise executor.ExecutorError(f"executor {spec.name!r} runs {spec.harness!r}, manifest pins {manifest.harness!r}")
    verifier_spec = verifier.lookup(task["verifier"])
    provisioned = spec.prepare is not None and bool(arm.get("provision"))
    # The isolation facts a provisioned arm brings are known before any root
    # exists: they are facts about the source, and the gate reads them first so
    # a run that would carry a shelf secret into a publishable record is
    # refused before spend.
    facts = dict(getattr(runtime.source, "facts", {}) or {}) if provisioned else {}
    source_origins = tuple(getattr(runtime.source, "origins", ()) or ()) if provisioned else ()
    isolation = artifact.require_isolation(
        live=spec.live,
        publishable=runtime.publishable,
        attestation=runtime.attestation,
        required_origins=tuple(spec.required_origins) + source_origins,
        credential_seam=None if spec.credential_seam is None else spec.credential_seam(manifest.pins),
        ci=runtime.ci,
        automated=runtime.automated,
        shelf_secret_present=bool(facts.get("shelf_secret_present", False)),
        shelf_origin=facts.get("shelf_origin"),
    )
    origin = None if runtime.sentinel is None else runtime.sentinel.origin
    roots = artifact.create(run_dir, trial.trial_id, manifest.fixture_path(task), public_origin=origin, vendor=manifest.vendor_for(task))
    # The manifest's slice is identity of the run, stated in every record.
    if manifest.slice is not None:
        isolation = {**isolation, "slice": manifest.slice}
    provision = None
    if provisioned:
        assert spec.prepare is not None
        try:
            provision = spec.prepare(executor.ProvisionRequest(trial.trial_id, roots, arm, runtime.source, task=task, nonce=runtime.run_nonce))
        except executor.ProvisionError as error:
            # One trial's provisioning refused (a seed key that drifted, a
            # publish that failed, a daemon that never answered): the trial is
            # invalid under that reason and the run goes on. Whatever the
            # provisioner half-did it has already undone, fail-closed. A
            # run-wide condition (credential, platform, manifest) is refused
            # before any trial by `live-run`, never here.
            (roots.output / "provision-refusal.txt").write_text(str(error) + "\n", encoding="utf-8")
            return refused_record(manifest, trial, schedule_hash, spec, arm, isolation, f"provision:{error.code}", str(error))
    # The natural arm: a producer session first, on the same store, verified;
    # then the consumer on a fresh repository copy at the same path.
    produced: producer_module.ProducerResult | None = None
    foreign_sessions: tuple[str, ...] = ()
    if provisioned and arm.get("producer"):
        assert provision is not None
        produced = producer_module.run(
            spec=spec,
            trial_id=trial.trial_id,
            task=task,
            arm=arm,
            pins=manifest.pins,
            fixture=manifest.fixture_path(task),
            vendor=manifest.vendor_for(task),
            roots=roots,
            provision=provision,
            runtime=runtime,
            verifier_spec=verifier_spec,
            wall_clock_s=float(manifest.pins["wall_clock_s"]),
        )
        provision = produced.provision
        foreign_sessions = produced.foreign_sessions
        isolation = {**isolation, "producer": produced.facts}
        artifact.refresh_repo(roots, manifest.fixture_path(task), manifest.vendor_for(task))
    launch = spec.launch(executor.LaunchRequest(trial.trial_id, roots, task, arm, manifest.pins, provision))
    if launch.package_manager is not None:
        isolation = {**isolation, "package_manager": launch.package_manager}
    hits_before = 0 if runtime.sentinel is None else len(runtime.sentinel.hits)

    started = runtime.clock()
    try:
        if produced is not None and produced.invalid_reason is not None:
            # The producer left nothing to reuse: no consumer is started, and
            # the attempt is invalid under the producer's own reason.
            completed = Completed(returncode=0, stderr="", timed_out=False)
        else:
            completed = runtime.spawn(launch, roots, float(manifest.pins["wall_clock_s"]))
    finally:
        # The daemon stops as soon as the agent has, before settlement and
        # before anything reads `loop.db`: a stopped daemon is what makes the
        # WAL rule below decidable.
        provision_stop = None if provision is None or spec.stop is None else spec.stop(roots, provision)
    # The spec says where its harness left the transcripts; the parser and the
    # settlement scan read that directory whatever the harness is.
    sessions = spec.sessions(roots, launch.root_session_id)
    if completed.timed_out:
        result_row, unresolved = scan(sessions, launch.root_session_id, roots.stream)
        settlement = Settlement(result_row, unresolved, 0.0, False)
        stop_reason = "timeout"
    else:
        settlement = settle(sessions, launch.root_session_id, runtime, roots.stream)
        stop_reason = "interrupted" if settlement.capped else "exit"
    roots.mark_stopped()
    wall_time_s = runtime.clock() - started

    isolation_reason: str | None = None
    try:
        roots.audit()
    except artifact.ArtifactError as error:
        isolation_reason = f"isolation:{error.code}"
    hits = 0 if runtime.sentinel is None else len(runtime.sentinel.hits) - hits_before
    canaries = () if provision is None else provision.secrets

    session: claude_usage.SessionUsage | None = None
    usage_reason: str | None = None
    try:
        session = claude_usage.parse_session_dir(sessions, launch.root_session_id, trial.trial_id, roots.stream)
        usage_reason = session.invalid_reason
    except claude_usage.ClaudeUsageError as error:
        usage_reason = f"usage:{error.code}"
    actors = [] if session is None else session.actors
    try:
        delivery = loop_join.project(roots.data_dir / "loop.db", actors, foreign_sessions)
    except loop_join.LoopJoinError:
        delivery = loop_join.unavailable()
        usage_reason = usage_reason or "delivery:wal_live"
    if delivery["unmatched_fires"]:
        usage_reason = usage_reason or "delivery:fire_without_usage"
    if delivery.get("failure_key") is not None:
        # The product's test lane reads `.vitest-report.json` in the repository when a reporter is wired; its presence after the run is a fact.
        delivery["failure_key"] = {**delivery["failure_key"], "report_file_present": (roots.repo / ".vitest-report.json").is_file()}
    # The team shelf and the public marketplace are the seeded config's two
    # named origins, listed in the allowlist a provisioned run has to state. A
    # leg to either is the product under test and is counted in the record; a
    # local leg reaches nothing; only a leg to an origin outside that set is a
    # public request for the sentinel.
    hits += delivery["classes"]["other"]
    sentinel = artifact.scan_sentinels(roots, hits, canaries=canaries, exclude=(roots.data_dir / "config.json",))

    auxiliary: list[dict[str, Any]] = []
    collected = [] if produced is None else list(produced.receipts)
    if runtime.receipts is not None:
        collected = collected + list(runtime.receipts(trial.trial_id, roots))
    if collected:
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

    envelope = None if session is None else session.envelope
    # The harness's own stop is read off the envelope it wrote: a session the
    # CLI ended on its budget or turn cap exited on its own terms, so the
    # record names that cap rather than the plain exit.
    if stop_reason == "exit" and envelope is not None and envelope.cap is not None:
        stop_reason = envelope.cap

    # Isolation first: an attempt that reached outside its roots is invalid
    # whatever else it did. A sentinel hit outranks an accounting gap for the
    # same reason.
    invalid_reason = (None if produced is None else produced.invalid_reason) or isolation_reason or sentinel.reason or usage_reason
    outcome = "invalid"
    verdict: verifier.Verdict | None = None
    patch_hash: str | None = None
    if invalid_reason is not None:
        pass
    elif completed.timed_out:
        outcome = "capped"
    elif envelope is not None and envelope.capped:
        # The cap outranks the exit code: the CLI reports its own stop as an
        # error, and that exit is the cap, not a broken executor.
        outcome = "capped"
    elif completed.returncode != 0:
        invalid_reason = f"executor:exit_{completed.returncode}"
    elif settlement.capped:
        outcome = "interrupted"
    elif envelope is not None and envelope.is_error:
        invalid_reason = f"harness:{envelope.subtype}"
    if invalid_reason is None and outcome != "interrupted":
        # The verifier decides pass and fail. On a capped attempt it runs too,
        # because the worktree is final and whether the edit landed before
        # the cap is worth recording; the outcome stays `capped`, a failed
        # task with its spend, and the verdict is the diagnostic beside it.
        try:
            copy = roots.hidden_copy(verifier_spec.hidden_layer)
        except artifact.ArtifactError as error:
            copy = None
            invalid_reason = f"isolation:{error.code}"
        if copy is not None:
            patch_hash = "sha256:" + sha256_dir(copy)
            verdict = verifier.run(verifier_spec, copy, run_dir)
            if outcome != "capped":
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
        "discovery": discovery.derive(sessions, trial.task_id, verifier.TASK_SOURCES.get(trial.task_id)) if spec.live else None,
        "sentinel": sentinel.counts(),
        "isolation": isolation_of(isolation, provision, provision_stop),
        "private_hashes": {
            "root_transcript": sha256_file(root_transcript) if root_transcript.is_file() else None,
            "executor_stderr": sha256_text(completed.stderr) if completed.stderr else None,
            "resolved_settings": None if launch.resolved_settings_hash is None else launch.resolved_settings_hash,
        },
    }


def refused_record(
    manifest: Manifest, trial: Trial, schedule_hash: str, spec: executor.ExecutorSpec, arm: dict[str, Any], isolation: dict[str, Any], reason: str, detail: str
) -> dict[str, Any]:
    """An attempt that never started: no root, no usage, no delivery, invalid under the refusal's reason. The detail's hash, never its text."""
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
        "native_root_id": f"unstarted-{trial.trial_id}",
        "actors": [],
        "parent_edges": [],
        "usage": [],
        "usage_reconciliation": {"status": "unparsed"},
        "tool_counts": {},
        "turns": None,
        "cost_usd": None,
        "auxiliary": [],
        "outcome": "invalid",
        "invalid_reason": reason,
        "verifier": None,
        "patch_hash": None,
        "stop_reason": "exit",
        "wall_time_s": 0.0,
        "unresolved_actors": [],
        "delivery": loop_join.unavailable(),
        "discovery": None,
        "sentinel": {"public_requests": 0, "credential_exposures": 0},
        "isolation": isolation,
        "private_hashes": {"root_transcript": None, "executor_stderr": sha256_text(detail) if detail else None, "resolved_settings": None},
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
