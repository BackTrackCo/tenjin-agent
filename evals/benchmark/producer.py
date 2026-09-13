"""The natural arm's producer phase: a first session on the same store.

The producer runs the task before the consumer does, in the same trial data
dir, with the product's capture on. It gets its own home, profile, output, and
transcripts, the same pins, the same isolation, and its own verifier: a
producer that did not fix the task has produced nothing a consumer could
reuse, so the attempt is invalid `producer:failed` rather than a consumer
measured against an empty store. Its usage is recorded as auxiliary receipts
on the consumer's record, phase `producer` for the work the task would have
cost anyway and phase `capture` for what the turn-end capture ask added; the
consumer's own usage never mixes with either.

Between the phases the daemon is stopped and its WAL has to be gone: the
store is read once, settled, for what the producer left (closed pairings,
harvested findings, its fires), and the consumer's daemon is then started on
the consumer config with the same data dir and token on a fresh port. A WAL
still live at that point is a refusal, because the consumer would otherwise
read a ledger the producer's daemon was still writing.
"""

from __future__ import annotations

import datetime
import json
import sqlite3
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import loop_join, artifact, claude_usage, sha256_dir, sha256_file, sha256_text, tenjin_arm, usage, verifier
from . import protocol, publication
from .executor import ExecutorSpec, LaunchRequest, Provision, ProvisionError

PHASE = artifact.PRODUCER_PHASE
PAIRING_STATUSES = ("open", "unverified", "verified")


def project_id(cwd: str) -> str:
    """The product's `projectId`: sha256 of the cwd string, first 16 hex characters (`src/hooks/failure/keys.ts`)."""
    import hashlib

    return hashlib.sha256(cwd.encode("utf-8")).hexdigest()[:16]


def pairings_of(loop_db: Path, project: str) -> list[dict[str, Any]]:
    """The project's pairing rows as the record may carry them: kind, key hash, status, closes; never the error line."""
    if not loop_db.is_file():
        return []
    uri = f"file:{loop_db.resolve().as_posix()}?mode=ro&immutable=1"
    try:
        connection = sqlite3.connect(uri, uri=True)
    except sqlite3.Error as error:
        raise ProvisionError(f"cannot open loop.db read-only: {error}") from error
    try:
        rows = connection.execute("SELECT kind, key, status, closes FROM pairings WHERE project IS ? ORDER BY id", (project,)).fetchall()
    except sqlite3.Error as error:
        raise ProvisionError(f"loop.db has no readable pairings table: {error}") from error
    finally:
        connection.close()
    return [{"kind": kind, "key_hash": sha256_text(f"{kind}:{key}")[:16], "status": status, "closes": int(closes or 0)} for kind, key, status, closes in rows]


def summarize(rows: list[dict[str, Any]]) -> dict[str, int]:
    counts = {status: 0 for status in PAIRING_STATUSES}
    for row in rows:
        counts[row["status"]] = counts.get(row["status"], 0) + 1
    return counts
COMPONENT = "producer"
CAPTURE_PHASE = "capture"
FINDING_PREFIX = "finding:"
TURN_END = "turn.end"


@dataclass(frozen=True)
class ProducerResult:
    facts: dict[str, Any]
    receipts: list[usage.AuxiliaryReceipt] = field(default_factory=list)
    invalid_reason: str | None = None
    provision: Provision | None = None
    foreign_sessions: tuple[str, ...] = ()


def request_times(transcript: Path) -> dict[str, int]:
    """The first timestamp seen per native request id, in epoch milliseconds, off the root transcript."""
    times: dict[str, int] = {}
    if not transcript.is_file():
        return times
    for line in transcript.read_text(encoding="utf-8").splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        request_id, stamp = event.get("requestId"), event.get("timestamp")
        if not isinstance(request_id, str) or request_id in times or not isinstance(stamp, str):
            continue
        try:
            parsed = datetime.datetime.fromisoformat(stamp.replace("Z", "+00:00"))
        except ValueError:
            continue
        times[request_id] = int(parsed.timestamp() * 1000)
    return times


def store_facts(loop_db: Path, session: str, project: str) -> dict[str, Any]:
    """What the producer left in the settled store: pairings for the project, harvested findings, and its own fires."""
    facts: dict[str, Any] = {"pairings": summarize([]), "pairing_key_hashes": [], "findings": 0, "fires": 0, "turn_end_fires": 0, "first_turn_end_at": None, "actor_capture_from": {}}
    if not loop_db.is_file():
        return facts
    rows = pairings_of(loop_db, project)
    facts["pairings"] = summarize(rows)
    facts["pairing_key_hashes"] = sorted({row["key_hash"] for row in rows if row["status"] != "open"})
    uri = f"file:{loop_db.resolve().as_posix()}?mode=ro&immutable=1"
    connection = sqlite3.connect(uri, uri=True)
    try:
        facts["findings"] = int(connection.execute("SELECT count(*) FROM facts WHERE substr(key, 1, ?) = ?", (len(FINDING_PREFIX), FINDING_PREFIX)).fetchone()[0])
        facts["fires"] = int(connection.execute("SELECT count(*) FROM fires WHERE session = ?", (session,)).fetchone()[0])
        boundaries = connection.execute("SELECT agent, min(at) FROM fires WHERE session = ? AND event IN ('turn.end', 'agent.stop') GROUP BY agent", (session,)).fetchall()
        facts["actor_capture_from"] = {str(agent): int(at) for agent, at in boundaries}
        ends = connection.execute("SELECT at FROM fires WHERE session = ? AND event = ? AND agent = '' ORDER BY at", (session, TURN_END)).fetchall()
    except sqlite3.Error as error:
        raise ProvisionError(f"the settled loop.db could not be read after the producer phase: {error}") from error
    finally:
        connection.close()
    facts["turn_end_fires"] = len(ends)
    facts["first_turn_end_at"] = None if not ends else int(ends[0][0])
    return facts


def receipts_of(trial_id: str, records: list[usage.UsageRecord], times: dict[str, int], capture_from: int | None, actor_capture_from: dict[str, int] | None = None) -> list[usage.AuxiliaryReceipt]:
    """One receipt per producer request. Requests from the first turn-end fire on are the capture ask's cost."""
    receipts = []
    for record in records:
        at = times.get(record.native_request_id)
        boundary = capture_from if actor_capture_from is None else actor_capture_from.get(record.actor_key[2])
        phase = CAPTURE_PHASE if boundary is not None and at is not None and at >= boundary else PHASE
        receipts.append(
            usage.AuxiliaryReceipt(
                trial_id=trial_id,
                component=COMPONENT,
                phase=phase,
                native_request_id=record.native_request_id,
                input_total=record.input_total,
                output_total=record.output_total,
                source_hash=record.source_hash,
            )
        )
    return receipts


def phase_tokens(receipts: list[usage.AuxiliaryReceipt]) -> dict[str, int]:
    out = {PHASE: 0, CAPTURE_PHASE: 0}
    for receipt in receipts:
        out[receipt.phase] += receipt.input_total + receipt.output_total
    return out


def run(
    *,
    spec: ExecutorSpec,
    trial_id: str,
    task: dict[str, Any],
    arm: dict[str, Any],
    pins: dict[str, Any],
    fixture: Path,
    image: Any,
    roots: artifact.TrialRoots,
    provision: Provision,
    runtime: Any,
    verifier_spec: verifier.VerifierSpec,
    wall_clock_s: float,
) -> ProducerResult:
    """The whole producer phase, ending with the consumer's daemon up and the consumer's repository fresh."""
    from . import runner

    producer_roots = artifact.create(
        roots.run_dir, trial_id, fixture, phase=PHASE, data_dir=roots.data_dir, image=image
    )
    launch = spec.launch(
        LaunchRequest(
            trial_id,
            producer_roots,
            task,
            arm,
            pins,
            provision,
            phase=PHASE,
            image=None if image is None else image.id,
            egress=getattr(runtime, "egress", None),
        )
    )
    session_id = launch.root_session_id
    started = runtime.clock()
    try:
        completed = runtime.spawn(launch, producer_roots, wall_clock_s)
    finally:
        between = tenjin_arm.settle_daemon(roots, producer_roots.output)
    identity_reason = None
    try:
        session_id = spec.evidence.root(session_id, producer_roots.stream)
    except spec.evidence.errors as error:
        identity_reason = f"producer:usage_{error.code}"
    sessions = spec.sessions(producer_roots, session_id)
    if identity_reason:
        settlement = runner.Settlement(None, [""], 0.0, False)
        stop_reason = "timeout" if completed.timed_out else "exit"
    elif completed.timed_out:
        result_row, unresolved = spec.evidence.scan(sessions, session_id, producer_roots.stream)
        settlement = runner.Settlement(result_row, unresolved, 0.0, False)
        stop_reason = "timeout"
    else:
        settlement = runner.settle(sessions, session_id, runtime, producer_roots.stream, scan_fn=spec.evidence.scan)
        stop_reason = "interrupted" if settlement.capped else "exit"
    producer_roots.mark_stopped()
    wall_time_s = runtime.clock() - started
    facts: dict[str, Any] = {
        "native_root_id": session_id,
        "daemon": "restarted",
        "daemon_respawned": bool(between["respawned"]),
        "wal_live_between_phases": bool(between["wal_live"]),
        "stop_reason": stop_reason,
        "wall_time_s": wall_time_s,
        "agent_time_s": completed.agent_time_s,
        "verification_time_s": None,
        "unresolved_actors": settlement.unresolved,
        "outcome": "invalid",
        "verifier": None,
        "patch_hash": None,
        "turns": None,
        "cost_usd": None,
        "tokens": {"input_total": 0, "output_total": 0, "requests": 0},
        "actors": 0,
        "usage_reconciliation": {"status": "unparsed"},
        "phase_tokens": {PHASE: 0, CAPTURE_PHASE: 0},
        "capture": store_facts(roots.data_dir / tenjin_arm.LOOP_DB, loop_join.stored_session(spec.harness, session_id), project_id(str(launch.cwd))),
        "sentinel": {"credential_exposures": 0},
        "private_hashes": {"root_transcript": None, "executor_stderr": sha256_text(completed.stderr) if completed.stderr else None},
    }
    if arm.get("capture_publication") == "host":
        facts["publication"] = {"mode": "host-assisted", "status": "not-run", "pieces": [], "wall_time_s": 0.0}
    invalid: str | None = identity_reason
    try:
        if spec.evidence.limited(sessions, session_id, producer_roots.stream):
            invalid = "provider:rate_limit"
    except spec.evidence.errors:
        pass
    if between["wal_live"]:
        invalid = "producer:wal_live"
    try:
        producer_roots.audit()
    except artifact.ArtifactError as error:
        invalid = invalid or f"producer:isolation_{error.code}"
    sentinel = artifact.scan_sentinels(producer_roots, canaries=provision.secrets, exclude=(roots.data_dir / tenjin_arm.CONFIG_FILE,))
    facts["sentinel"] = sentinel.counts()
    if sentinel.reason is not None:
        invalid = invalid or "producer:" + sentinel.reason.replace(":", "_")
    session: claude_usage.SessionUsage | None = None
    try:
        session = spec.evidence.parse(sessions, session_id, trial_id, producer_roots.stream,
                                      **({"expected_version": pins["harness_version"]} if spec.harness == "codex" else {}))
        if session.invalid_reason is not None:
            invalid = invalid or "producer:" + session.invalid_reason.replace(":", "_")
    except spec.evidence.errors as error:
        invalid = invalid or f"producer:usage_{error.code}"
    receipts: list[usage.AuxiliaryReceipt] = []
    if session is not None:
        root_transcript = spec.evidence.transcript(sessions, session_id)
        receipts = receipts_of(trial_id, session.records, spec.evidence.times(sessions, session_id), facts["capture"]["first_turn_end_at"], facts["capture"]["actor_capture_from"])
        totals = usage.totals(session.records)
        facts.update(
            {
                "turns": session.record_fields()["turns"],
                "cost_usd": session.record_fields()["cost_usd"],
                "tokens": {"input_total": totals["input_total"], "output_total": totals["output_total"], "requests": totals["requests"]},
                "actors": len(session.actors),
                "usage_reconciliation": {"status": session.reconciliation["status"]},
                "phase_tokens": phase_tokens(receipts),
            }
        )
        facts["private_hashes"]["root_transcript"] = sha256_file(root_transcript) if root_transcript.is_file() else None
    envelope = None if session is None else session.envelope
    if stop_reason == "exit" and envelope is not None and envelope.cap is not None:
        facts["stop_reason"] = stop_reason = envelope.cap
    outcome = "invalid"
    if invalid is None:
        if completed.timed_out or (envelope is not None and envelope.capped):
            outcome = "capped"
        elif completed.returncode != 0:
            invalid = f"producer:exit_{completed.returncode}"
        elif settlement.capped:
            outcome = "interrupted"
        elif envelope is not None and envelope.is_error:
            invalid = f"producer:harness_{envelope.subtype}"
    if invalid is None and outcome != "interrupted":
        try:
            copy = producer_roots.hidden_copy(verifier_spec.hidden_layer)
        except artifact.ArtifactError as error:
            invalid = f"producer:isolation_{error.code}"
        else:
            facts["patch_hash"] = "sha256:" + sha256_dir(copy)
            verification_started = runtime.clock()
            verdict = verifier.run(verifier_spec, copy, roots.run_dir)
            facts["verification_time_s"] = runtime.clock() - verification_started
            facts["verifier"] = {"id": verdict.verifier_id, "exit_code": verdict.exit_code}
            if outcome != "capped":
                outcome = verdict.outcome
                if outcome == "invalid":
                    invalid = f"producer:verifier_{verdict.verifier_id}"
    invalid = protocol.completion_refusal(task, session, outcome, invalid)
    if invalid is None and outcome != "pass":
        # A producer that did not fix the task left nothing a consumer could
        # reuse; the consumer is not run against an empty store.
        invalid = "producer:failed"
    facts["outcome"] = "invalid" if invalid is not None else outcome
    facts["invalid_reason"] = invalid
    next_provision = provision
    if invalid is None and arm.get("capture_publication") == "host":
        facts["publication"], invalid = publication.publish(roots, provision, loop_join.stored_session(spec.harness, session_id), project_id(str(launch.cwd)))
        if invalid is not None:
            facts["outcome"] = "invalid"
            facts["invalid_reason"] = invalid
    if invalid is None:
        next_provision = tenjin_arm.start_phase(roots, provision, "consumer")
    return ProducerResult(facts=facts, receipts=receipts, invalid_reason=invalid, provision=next_provision, foreign_sessions=(loop_join.stored_session(spec.harness, session_id),))
