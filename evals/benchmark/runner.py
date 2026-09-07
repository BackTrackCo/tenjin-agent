"""Execute a schedule: one fresh root per trial, settle, verify, record.

Attempt closes only when the root has exited and every discovered child has
a terminal row, or the declared wall-clock cap interrupts the whole process
group. Partial usage is retained either way. A trial with a valid final
record for the current manifest and schedule hashes is skipped on resume.
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from . import artifact, claude_usage, executor, loop_join, records, sha256_dir, sha256_file, sha256_json, sha256_text, verifier
from .manifest import Manifest
from .schedule import Trial

Clock = Callable[[], float]


@dataclass(frozen=True)
class TrialResult:
    trial_id: str
    outcome: str
    resumed: bool
    path: Path


def _terminal(path: Path) -> dict[str, Any] | None:
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        event = json.loads(line)
        if event.get("type") == "result":
            return event
    return None


def settle(sessions: Path, root_session_id: str) -> tuple[dict[str, Any] | None, list[str]]:
    """The root's result row, plus every child transcript still without one."""
    root = sessions / f"{root_session_id}.jsonl"
    if not root.is_file():
        return None, ["root"]
    unresolved = [
        child.stem
        for child in sorted((sessions / root_session_id / "subagents").glob("agent-*.jsonl"))
        if _terminal(child) is None
    ]
    return _terminal(root), unresolved


def run_trial(manifest: Manifest, trial: Trial, run_dir: Path, schedule_hash: str, clock: Clock) -> dict[str, Any]:
    task = next(item for item in manifest.tasks if item["id"] == trial.task_id)
    arm = next(item for item in manifest.arms if item["id"] == trial.arm_id)
    spec = executor.lookup(arm["executor"])
    if spec.harness != manifest.harness:
        raise executor.ExecutorError(f"executor {spec.name!r} runs {spec.harness!r}, manifest pins {manifest.harness!r}")
    roots = artifact.create(run_dir, trial.trial_id, manifest.fixture_path(task))
    launch = spec.launch(trial.trial_id, roots.repo, roots.output, arm)
    started = clock()
    stop_reason = "exit"
    process = subprocess.Popen(
        launch.argv,
        cwd=launch.cwd,
        env=roots.environment(os.environ.get("PATH", "")),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
        shell=False,
    )
    try:
        _, stderr = process.communicate(timeout=manifest.pins["wall_clock_s"])
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        _, stderr = process.communicate()
        stop_reason = "timeout"
    wall_time_s = clock() - started

    sessions = roots.output / "sessions"
    result_row, unresolved = settle(sessions, launch.root_session_id)
    outcome = "invalid"
    invalid_reason: str | None = None
    session: claude_usage.SessionUsage | None = None
    try:
        session = claude_usage.parse_session_dir(sessions, launch.root_session_id, trial.trial_id)
        invalid_reason = session.invalid_reason
    except claude_usage.ClaudeUsageError as error:
        invalid_reason = f"usage:{error.code}"

    actors = [] if session is None else session.actors
    try:
        delivery = loop_join.project(roots.data_dir / "loop.db", actors)
    except loop_join.LoopJoinError:
        delivery = loop_join.unavailable()
        invalid_reason = invalid_reason or "delivery:wal_live"
    if delivery["unmatched_fires"]:
        invalid_reason = invalid_reason or "delivery:fire_without_usage"

    verdict: verifier.Verdict | None = None
    patch_hash: str | None = None
    if invalid_reason is not None:
        pass
    elif stop_reason == "timeout":
        outcome = "capped"
    elif process.returncode != 0:
        invalid_reason = f"executor exited {process.returncode}"
    elif result_row is None or unresolved:
        invalid_reason = "unsettled: " + ", ".join(["root"] if result_row is None else unresolved)
    elif session is not None and session.envelope is not None and session.envelope.capped:
        outcome = "capped"
    elif session is not None and session.envelope is not None and session.envelope.is_error:
        invalid_reason = f"harness: {session.envelope.subtype}"
    else:
        copy = roots.hidden_copy()
        patch_hash = "sha256:" + sha256_dir(copy)
        verdict = verifier.run(verifier.lookup(task["verifier"]), copy, run_dir)
        outcome = verdict.outcome
        if outcome == "invalid":
            invalid_reason = f"verifier: {verdict.detail}"
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
        "auxiliary": [],
        "outcome": outcome,
        "invalid_reason": invalid_reason,
        "verifier": None if verdict is None else {"id": verdict.verifier_id, "exit_code": verdict.exit_code},
        "patch_hash": patch_hash,
        "stop_reason": stop_reason,
        "wall_time_s": wall_time_s,
        "delivery": delivery,
        "sentinel": {"public_requests": 0},
        "isolation": {"fresh_roots": True, "attested_container": False},
        "private_hashes": {
            "root_transcript": sha256_file(root_transcript) if root_transcript.is_file() else None,
            "executor_stderr": sha256_text(stderr) if stderr else None,
        },
    }


def run(
    manifest: Manifest, trials: list[Trial], run_dir: Path, schedule_hash: str, clock: Clock = time.time
) -> list[TrialResult]:
    records_dir = run_dir / "records"
    accepted, _ = records.select(records_dir, manifest.hash, schedule_hash)
    results: list[TrialResult] = []
    for trial in trials:
        if trial.trial_id in accepted:
            results.append(
                TrialResult(trial.trial_id, accepted[trial.trial_id]["outcome"], True, records.final_path(records_dir, trial.trial_id))
            )
            continue
        record = run_trial(manifest, trial, run_dir, schedule_hash, clock)
        path, won = records.publish(records_dir, record)
        if not won:
            raise records.RecordError(f"another writer published trial {trial.trial_id} first")
        results.append(TrialResult(trial.trial_id, record["outcome"], False, path))
    return results
