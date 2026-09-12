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

`pins.concurrency` trials run at once, defaulting to one. Trials are otherwise
isolated from each other, but an arm that provisions seeds its lesson into the
one shelf the operator's account owns, searches it, and deletes it at the end,
so two seeded windows that overlapped would answer each other's searches and
move the delivery numbers this benchmark exists to measure. `run` therefore
admits one provisioning trial at a time and lets the rest run freely. The
schedule is untouched: trials are assigned in its order and the results come
back in it, whatever order they finish in.
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import threading
import time
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Callable

from . import artifact, claude_usage, container, discovery, executor, images, loop_join, phases as phases_module, producer as producer_module, records, sha256_dir, sha256_file, sha256_json, sha256_text, usage, verifier
from .manifest import Manifest
from .schedule import Trial
from . import protocol

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
    agent_time_s: float | None = None


Spawn = Callable[[executor.Launch, artifact.TrialRoots, float], Completed]


@dataclass(frozen=True)
class TrialResult:
    trial_id: str
    outcome: str
    resumed: bool
    path: Path


def default_spawn(launch: executor.Launch, roots: artifact.TrialRoots, timeout_s: float) -> Completed:
    """Route one launch to the seam that can run it.

    A launch that names a container recipe is a live attempt and runs inside
    Harbor; anything else is a plain child process. The choice is the launch's
    own shape rather than a runtime flag, so a manifest cannot ask for both.
    """
    return container_spawn(launch, roots, timeout_s) if launch.recipe is not None else process_spawn(launch, roots, timeout_s)


def container_spawn(launch: executor.Launch, roots: artifact.TrialRoots, timeout_s: float) -> Completed:
    """The live seam: bring one Harbor container up, exec the agent in it, tear it down.

    The container is the process boundary, so nothing starts in this process's
    own session and there is no group to kill. `Container.close` runs on every
    path out and sweeps the compose project afterwards in case `down` never ran,
    and the project is recorded under `<run>/projects/` before the agent starts,
    so `cli.py cleanup` reaches it after a kill this process never saw.

    Three execs in one container, in order. The ENTRYPOINT has already started
    the trial's daemon by the time `up --wait` returns, so its report is read
    first: an unhealthy daemon ends the attempt before anything is spent. Then
    the agent under the wall-clock cap. Then the daemon stop, which has to happen
    while the container is up, because the host reads `loop.db` back after it is
    gone.
    """
    recipe = launch.recipe
    roots.output.mkdir(parents=True, exist_ok=True)
    container.record_project(roots.run_dir, roots.trial_id, recipe.name)
    stream = roots.stream.open("w", encoding="utf-8")
    completed = Completed(returncode=1, stderr="", timed_out=False)
    command = launch.argv
    separated_out = separated_err = None
    if launch.separate_streams:
        command, separated_out, separated_err = container.split_streams(command, roots.output)
    try:
        with container.Container(recipe=recipe) as box:
            refused = container.daemon_error(roots.output)
            if refused is not None:
                return Completed(returncode=container.DAEMON_REFUSED, stderr=refused, timed_out=False)
            agent_started = time.monotonic()
            try:
                ran = box.exec(
                    command,
                    cwd=recipe.workdir,
                    environment=container.forwarded(recipe, os.environ),
                    timeout_s=timeout_s,
                    stream=None if launch.separate_streams else stream,
                )
                completed = Completed(returncode=ran.returncode, stderr=ran.stderr, timed_out=False, agent_time_s=time.monotonic() - agent_started)
            except RuntimeError as error:
                # Harbor raises a plain RuntimeError on its own timeout, having
                # already killed the host-side client. The command inside the
                # container outlives that and dies with the container below,
                # which is the same guarantee the process-group kill gave.
                if "timed out" not in str(error):
                    raise
                completed = Completed(returncode=124, stderr=str(error), timed_out=True, agent_time_s=time.monotonic() - agent_started)
            if recipe.daemon:
                box.exec([container.TRIAL_ENTRY, container.STOP_ARG], timeout_s=container.STOP_TIMEOUT_S)
    finally:
        if separated_out is not None and separated_out.is_file():
            stream.write(separated_out.read_text(encoding="utf-8"))
        if separated_err is not None and separated_err.is_file():
            completed = replace(completed, stderr=separated_err.read_text(encoding="utf-8"))
        stream.close()
        container.stop(recipe.name)
        container.forget_project(roots.run_dir, roots.trial_id)
    return completed


def process_spawn(launch: executor.Launch, roots: artifact.TrialRoots, timeout_s: float) -> Completed:
    """The only place this package starts a process. Own session, no shell.

    Its own session so the wall-clock cap and the way out both reach a
    grandchild the agent left behind. Nothing here, and nothing an operator or
    an agent has to do afterwards, matches a process by name: that is how a
    cleanup aimed at one trial reaches an unrelated session.

    A harness SIGKILLed mid-trial leaves this child reparented to pid 1, and
    nothing reaps it. That is deliberate. This seam runs the fake and offline
    executors, which start no model and spend nothing, so a stray `sleep` costs
    a `kill` an operator may never bother to type.
    """
    roots.output.mkdir(parents=True, exist_ok=True)
    stream = roots.stream.open("w", encoding="utf-8")
    agent_started = time.monotonic()
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
        stream.close()
    return Completed(returncode=process.returncode, stderr=stderr or "", timed_out=timed_out, agent_time_s=time.monotonic() - agent_started)


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
class Runtime:
    clock: Clock = time.monotonic
    admit_until: float | None = None
    server_check: Callable[[], Any] | None = None
    sleep: Sleep = time.sleep
    # Resolved when a Runtime is built, not when this class is defined. A
    # plain default would bind the function object once and for all, and a
    # test that replaces `runner.process_spawn` to prove nothing starts would
    # then be guarding a name the runtime no longer reads.
    spawn: Spawn = field(default_factory=lambda: default_spawn)
    settle_cap_s: float = 30.0
    settle_interval_s: float = 0.25
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
    # The run's egress (`container.Egress`), created before the first trial and
    # removed after the last. Every live container joins its internal network.
    egress: Any = None
    # The run's one corpus reading (`snapshot.Once`), asked for once the first
    # seed has reached the shelf, so the count is the corpus the trials searched.
    snapshot: Any = None


@dataclass(frozen=True)
class Settlement:
    result_row: dict[str, Any] | None
    unresolved: list[str]
    waited_s: float
    capped: bool

    @property
    def settled(self) -> bool:
        return self.result_row is not None and not self.unresolved


scan = claude_usage.scan


def settle(sessions: Path, root_session_id: str, runtime: Runtime, stream: Path | None = None, *, scan_fn=None) -> Settlement:
    """Wait for descendants to stop, up to the declared settlement cap.

    A root that exits while a child is live is not a complete attempt, so the
    wait is the default and the cap is the exception.
    """
    started = runtime.clock()
    while True:
        result_row, unresolved = (scan_fn or scan)(sessions, root_session_id, stream)
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
    # `wal_checkpoint` is why an attempt that came back `delivery:wal_live`
    # did. The ledger's WAL is closed explicitly at stop, so a surviving one
    # is a checkpoint that refused and named its reason, not a wait that ran out.
    out = {
        **isolation,
        "daemon_respawned": bool((stop or {}).get("respawned", False)),
        "wal_checkpoint": (stop or {}).get("wal_checkpoint"),
    }
    # Which product hook arms the seeded config turned off, on every
    # provisioned attempt and not only where the manifest named one: an empty
    # list is the arm as shipped, and no key at all means no provisioning.
    off = provision.facts.get("hooks_disabled")
    if off is not None:
        out["hooks_disabled"] = list(off)
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


def seeds_shelf(manifest: Manifest, trial: Trial) -> bool:
    """Whether this trial provisions, which is decidable from the manifest before it starts.

    One predicate, read by the trial that provisions and by the scheduler that
    has to keep two of them apart.
    """
    arm = next(item for item in manifest.arms if item["id"] == trial.arm_id)
    return executor.lookup(arm["executor"]).prepare is not None and bool(arm.get("provision"))


def run_trial(manifest: Manifest, trial: Trial, run_dir: Path, schedule_hash: str, runtime: Runtime = Runtime()) -> dict[str, Any]:
    task = next(item for item in manifest.tasks if item["id"] == trial.task_id)
    arm = next(item for item in manifest.arms if item["id"] == trial.arm_id)
    spec = executor.lookup(arm["executor"])
    if spec.harness != manifest.harness:
        raise executor.ExecutorError(f"executor {spec.name!r} runs {spec.harness!r}, manifest pins {manifest.harness!r}")
    verifier_spec = verifier.lookup(task["verifier"])
    provisioned = seeds_shelf(manifest, trial)
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
    # The image is resolved before any root exists: a missing or drifted image
    # is a refusal, and its id is what the record says the attempt ran in.
    image = images.require(task, manifest.fixture_path(task), manifest.pins) if spec.live else None
    if image is not None:
        isolation = {**isolation, "image": image.facts}
    # Natural prepare has no lesson probe. The producer installs this image's
    # dependency tree before its first launch; avoid exporting it only to have
    # producer.create immediately discard and export it again.
    roots = artifact.create(run_dir, trial.trial_id, manifest.fixture_path(task), image=None if provisioned and arm.get("producer") else image)
    # The manifest's slice is identity of the run, stated in every record.
    if manifest.slice is not None:
        isolation = {**isolation, "slice": manifest.slice}
    provision = None
    if provisioned:
        assert spec.prepare is not None
        try:
            provision = spec.prepare(
                executor.ProvisionRequest(
                    trial.trial_id, roots, arm, runtime.source, task=task, nonce=runtime.run_nonce, image=None if image is None else image.id
                )
            )
        except executor.ProvisionError as error:
            # One trial's provisioning refused (a seed key that drifted, a
            # publish that failed, a daemon that never answered): the trial is
            # invalid under that reason and the run goes on. Whatever the
            # provisioner half-did it has already undone, fail-closed. A
            # run-wide condition (credential, platform, manifest) is refused
            # before any trial by `live-run`, never here.
            #
            # The roots die with the runner, so the record is the only place the
            # refusal survives to. It carries the text masked: a refusal that
            # costs a whole arm has to say what it saw, and the reason code alone
            # made `provision:seed_publish` mean "the publish failed somehow".
            detail = refusal_detail(str(error), tuple(getattr(runtime.source, "secrets", ()) or ()))
            (roots.output / "provision-refusal.txt").write_text(detail + "\n", encoding="utf-8")
            return refused_record(manifest, trial, schedule_hash, spec, arm, isolation, f"provision:{error.code}", detail)
    try:
        if provisioned:
            # The seed is on the shelf now, so this is the corpus every trial of
            # this run searches. Asked once; `Once` ignores every later ask.
            if runtime.snapshot is not None:
                runtime.snapshot.fire()
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
                image=image,
                roots=roots,
                provision=provision,
                runtime=runtime,
                verifier_spec=verifier_spec,
                wall_clock_s=float(manifest.pins["wall_clock_s"]),
            )
            provision = produced.provision
            foreign_sessions = produced.foreign_sessions
            isolation = {**isolation, "producer": produced.facts}
            artifact.refresh_repo(roots, manifest.fixture_path(task), image)
        launch = spec.launch(
            executor.LaunchRequest(
                trial.trial_id, roots, task, arm, manifest.pins, provision, image=None if image is None else image.id, egress=runtime.egress
            )
        )
        if launch.package_manager is not None:
            isolation = {**isolation, "package_manager": launch.package_manager}

        started = runtime.clock()
        if produced is not None and produced.invalid_reason is not None:
            completed = Completed(returncode=0, stderr="", timed_out=False)
        else:
            completed = runtime.spawn(launch, roots, float(manifest.pins["wall_clock_s"]))
    finally:
        # The daemon stops as soon as the agent has, before settlement and
        # before anything reads `loop.db`: a stopped daemon is what makes the
        # WAL rule below decidable.
        provision_stop = None if provision is None or spec.stop is None else spec.stop(roots, provision)
    if produced is not None and isinstance(produced.facts.get("publication"), dict):
        deleted = (provision_stop or {}).get("seed_deleted", {})
        for piece in produced.facts["publication"]["pieces"]:
            if piece["piece_id"] in deleted:
                piece["deleted"] = deleted[piece["piece_id"]] is None
    # The spec says where its harness left the transcripts; the parser and the
    # settlement scan read that directory whatever the harness is.
    identity_reason = None
    try:
        launch = replace(launch, root_session_id=spec.evidence.root(launch.root_session_id, roots.stream))
    except spec.evidence.errors as error:
        identity_reason = f"usage:{error.code}"
    sessions = spec.sessions(roots, launch.root_session_id)
    if identity_reason:
        settlement = Settlement(None, [""], 0.0, False)
        stop_reason = "timeout" if completed.timed_out else "exit"
    elif completed.timed_out:
        result_row, unresolved = spec.evidence.scan(sessions, launch.root_session_id, roots.stream)
        settlement = Settlement(result_row, unresolved, 0.0, False)
        stop_reason = "timeout"
    else:
        settlement = settle(sessions, launch.root_session_id, runtime, roots.stream, scan_fn=spec.evidence.scan)
        stop_reason = "interrupted" if settlement.capped else "exit"
    roots.mark_stopped()
    wall_time_s = runtime.clock() - started

    isolation_reason: str | None = None
    try:
        roots.audit()
    except artifact.ArtifactError as error:
        isolation_reason = f"isolation:{error.code}"
    canaries = () if provision is None else provision.secrets

    session: claude_usage.SessionUsage | None = None
    usage_reason: str | None = identity_reason
    try:
        session = spec.evidence.parse(sessions, launch.root_session_id, trial.trial_id, roots.stream)
        usage_reason = session.invalid_reason
    except spec.evidence.errors as error:
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
    # `delivery["classes"]` still says which shelf each leg the product logged
    # went to, `other` being one outside the seeded config's named set. It is
    # the daemon's own ledger, not an observation of the network, so it is
    # reported and no longer invalidates: nothing here can see a leg the
    # product did not write down.
    sentinel = artifact.scan_sentinels(roots, canaries=canaries, exclude=(roots.data_dir / "config.json",))

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
    cleanup_reason = "isolation:seed_cleanup" if any(value is not None for value in (provision_stop or {}).get("seed_deleted", {}).values()) else None
    try:
        provider_reason = "provider:rate_limit" if spec.evidence.limited(sessions, launch.root_session_id, roots.stream) else None
    except spec.evidence.errors:
        provider_reason = None  # The parser's precise accounting refusal survives below.
    invalid_reason = cleanup_reason or (None if produced is None else produced.invalid_reason) or isolation_reason or sentinel.reason or provider_reason or usage_reason
    outcome = "invalid"
    verification_time_s = None
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
            verification_started = time.monotonic()
            verdict = verifier.run(verifier_spec, copy, run_dir)
            verification_time_s = time.monotonic() - verification_started
            if outcome != "capped":
                outcome = verdict.outcome
                if outcome == "invalid":
                    invalid_reason = f"verifier:{verdict.verifier_id}"
    invalid_reason = protocol.completion_refusal(task, session, outcome, invalid_reason)
    if invalid_reason is not None:
        outcome = "invalid"

    try:
        root_transcript = spec.evidence.transcript(sessions, launch.root_session_id)
    except spec.evidence.errors:
        root_transcript = sessions / "unavailable-transcript.jsonl"
    try:
        native_times = spec.evidence.times(sessions, launch.root_session_id)
    except spec.evidence.errors:
        native_times = {}
    # Phase spend partitions the native usage above; it is never added twice.
    attempt_phases = phases_module.split(
        [] if session is None else session.records,
        native_times,
        phases_module.read_marks(roots.data_dir / "loop.db", loop_join.stored_session(spec.harness, launch.root_session_id)),
    )
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
        "agent_time_s": completed.agent_time_s,
        "verification_time_s": verification_time_s,
        "unresolved_actors": settlement.unresolved,
        "attempt_phases": attempt_phases,
        "delivery": delivery,
        "discovery": discovery.derive(sessions, trial.task_id, verifier.TASK_SOURCES.get(trial.task_id), harness=spec.harness) if spec.live else None,
        "sentinel": sentinel.counts(),
        "isolation": isolation_of(isolation, provision, provision_stop),
        "private_hashes": {
            "root_transcript": sha256_file(root_transcript) if root_transcript.is_file() else None,
            "executor_stderr": sha256_text(completed.stderr) if completed.stderr else None,
            "resolved_settings": None if launch.resolved_settings_hash is None else launch.resolved_settings_hash,
        },
    }


def refusal_detail(text: str, secrets: tuple[str, ...]) -> str:
    """A refusal's own words, with every secret the source holds replaced and the length bounded.

    Masking is the same substitution the provisioner already applies to a CLI
    tail, applied again here because the record is written by this module and a
    provisioner that forgot would leak into a file the run keeps.
    """
    for secret in secrets:
        if secret:
            text = text.replace(secret, "[secret]")
    text = " ".join(text.split())
    return text if len(text) <= records.DETAIL_LIMIT else text[: records.DETAIL_LIMIT - 3] + "..."


def refused_record(
    manifest: Manifest, trial: Trial, schedule_hash: str, spec: executor.ExecutorSpec, arm: dict[str, Any], isolation: dict[str, Any], reason: str, detail: str
) -> dict[str, Any]:
    """An attempt that never started: no root, no usage, no delivery, invalid under the refusal's reason, which it quotes."""
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
        "invalid_detail": detail or None,
        "verifier": None,
        "patch_hash": None,
        "stop_reason": "exit",
        "wall_time_s": 0.0,
        "unresolved_actors": [],
        "attempt_phases": phases_module.empty(),
        "delivery": loop_join.unavailable(),
        "discovery": None,
        "sentinel": {"credential_exposures": 0},
        "isolation": isolation,
        "private_hashes": {"root_transcript": None, "executor_stderr": sha256_text(detail) if detail else None, "resolved_settings": None},
    }


def attempt(manifest: Manifest, trial: Trial, run_dir: Path, schedule_hash: str, runtime: Runtime) -> TrialResult:
    """Execute one unresumed trial and publish its record.

    An interruption inside a trial publishes nothing: the next run finds no
    final record for it and executes it once, from the top.
    """
    record = run_trial(manifest, trial, run_dir, schedule_hash, runtime)
    path, won = records.publish(run_dir / "records", record)
    if not won:
        raise records.RecordError(f"another writer published trial {trial.trial_id} first")
    if record.get("invalid_reason") == "provider:rate_limit":
        raise executor.ProvisionError("model subscription allowance unavailable; checkpoint saved and new admission stopped", code="provider_unavailable")
    if record.get("invalid_reason") in {"isolation:seed_cleanup", "provision:seed_cleanup"}:
        raise executor.ProvisionError("shelf cleanup failed; evidence was saved and no more trials will be admitted", code="seed_cleanup")
    return TrialResult(trial.trial_id, record["outcome"], False, path)


def run_concurrently(
    manifest: Manifest, pending: list[Trial], run_dir: Path, schedule_hash: str, runtime: Runtime, degree: int
) -> dict[str, TrialResult]:
    """Up to `degree` trials at once, and never two that seed the shared shelf.

    The gate is a plain mutual exclusion held for the whole of a provisioning
    trial. It covers the seed the CLI publishes, every search the agent makes
    against it, the delete that ends it, and the free port its daemon claims,
    because those are one window and a second seeded window inside it is what
    would answer a search with another trial's piece. Trials that provision
    nothing take no gate and overlap with anything.
    """
    # Admission happens before submission: workers never sit idle waiting
    # behind a shared-shelf lock while independent work remains queued.
    waiting = list(pending)
    done: dict[str, TrialResult] = {}
    failures: list[tuple[int, BaseException]] = []
    with ThreadPoolExecutor(max_workers=degree, thread_name_prefix="bench1-trial") as pool:
        submitted: dict[Future[TrialResult], Trial] = {}
        while waiting or submitted:
            if runtime.admit_until is not None and runtime.clock() >= runtime.admit_until:
                waiting.clear()
            while waiting and len(submitted) < degree and not failures:
                if runtime.admit_until is not None and runtime.clock() >= runtime.admit_until:
                    waiting.clear()
                    break
                shelf_busy = any(seeds_shelf(manifest, trial) for trial in submitted.values())
                index = next((index for index, trial in enumerate(waiting)
                              if not shelf_busy or not seeds_shelf(manifest, trial)), None)
                if index is None:
                    break
                trial = waiting.pop(index)
                submitted[pool.submit(attempt, manifest, trial, run_dir, schedule_hash, runtime)] = trial
            if not submitted:
                break
            finished, _ = wait(submitted, return_when=FIRST_COMPLETED)
            finished_positions = [submitted[future].position for future in finished]
            for future in finished:
                trial = submitted.pop(future)
                try:
                    result = future.result()
                    done[result.trial_id] = result
                except BaseException as error:
                    failures.append((trial.position, error))
            if runtime.server_check is not None:
                try:
                    runtime.server_check()
                except BaseException as error:
                    failures.append((min(finished_positions), error))
            if failures:
                waiting.clear()
    if failures:
        # The earliest trial in the schedule owns the refusal, so what a run
        # raises does not depend on which thread lost the race to fail.
        failures.sort(key=lambda item: item[0])
        raise failures[0][1]
    return done


def run(
    manifest: Manifest, trials: list[Trial], run_dir: Path, schedule_hash: str, runtime: Runtime = Runtime()
) -> list[TrialResult]:
    records_dir = run_dir / "records"
    accepted, _ = records.select(records_dir, manifest.hash, schedule_hash)
    degree = manifest.concurrency
    done = {
        trial.trial_id: TrialResult(trial.trial_id, accepted[trial.trial_id]["outcome"], True, records.final_path(records_dir, trial.trial_id))
        for trial in trials
        if trial.trial_id in accepted
    }
    pending = [trial for trial in trials if trial.trial_id not in done]
    if degree == 1:
        for trial in pending:
            if runtime.admit_until is not None and runtime.clock() >= runtime.admit_until:
                break
            done[trial.trial_id] = attempt(manifest, trial, run_dir, schedule_hash, runtime)
            if runtime.server_check is not None:
                runtime.server_check()
    else:
        done.update(run_concurrently(manifest, pending, run_dir, schedule_hash, runtime, degree))
    # Schedule order, whatever order they finished in.
    return [done[trial.trial_id] for trial in trials if trial.trial_id in done]
