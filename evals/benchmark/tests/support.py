"""Shared fixture helpers for the offline benchmark self-test."""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any, Callable

from evals.benchmark import FIXTURES, claude_usage, records, schedule

SESSIONS = FIXTURES / "claude" / "sessions"
TRIAL = "trial-fixture"

Edit = Callable[[list[Any]], list[Any]]


def read_rows(path: Path) -> list[Any]:
    """Rows as dicts, or the raw line when it is not JSON (malformed fixtures)."""
    rows: list[Any] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            rows.append(line)
    return rows


def write_rows(path: Path, rows: list[Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(row if isinstance(row, str) else json.dumps(row))
            handle.write("\n")


def copy_session(tmp: Path, session: str, edit: Edit | None = None, children: dict[str, Edit] | None = None) -> Path:
    """Copy one fixture session into `tmp/sessions`, optionally rewriting rows."""
    target = tmp / "sessions"
    rows = read_rows(SESSIONS / f"{session}.jsonl")
    write_rows(target / f"{session}.jsonl", edit(rows) if edit else rows)
    source_children = SESSIONS / session / "subagents"
    if source_children.is_dir():
        shutil.copytree(source_children, target / session / "subagents")
    for agent_id, child_edit in (children or {}).items():
        child = target / session / "subagents" / f"agent-{agent_id}.jsonl"
        write_rows(child, child_edit(read_rows(child) if child.is_file() else []))
    return target


def parse(session: str, sessions: Path = SESSIONS) -> claude_usage.SessionUsage:
    return claude_usage.parse_session_dir(sessions, session, TRIAL)


def attempt_record(session: claude_usage.SessionUsage, **overrides: Any) -> dict[str, Any]:
    """A complete, valid attempt record around one parsed session."""
    manifest_hash, schedule_hash = "sha256:manifest", "sha256:schedule"
    task_id, arm_id, repeat, position = "answer-file", "off", 0, 0
    record: dict[str, Any] = {
        "schema": records.RECORD_SCHEMA,
        "trial_id": schedule.trial_id(manifest_hash, task_id, arm_id, repeat, position),
        "manifest_hash": manifest_hash,
        "schedule_hash": schedule_hash,
        "task_id": task_id,
        "arm_id": arm_id,
        "repeat": repeat,
        "position": position,
        "settings_hash": "sha256:off",
        "environment_hash": "sha256:pins",
        "harness": "claude",
        **session.record_fields(),
        "auxiliary": [],
        "outcome": "pass",
        "invalid_reason": None,
        "verifier": {"id": "fake_answer_file", "exit_code": 0},
        "patch_hash": "sha256:patch",
        "stop_reason": "exit",
        "wall_time_s": 1.5,
        "delivery": {"status": "unavailable", "fires": [], "legs": [], "unmatched_fires": []},
        "sentinel": {"public_requests": 0},
        "isolation": {"fresh_roots": True, "attested_container": False},
        "private_hashes": {"root_transcript": "sha256:root", "executor_stderr": None},
    }
    record.update(overrides)
    for item in record["usage"]:
        item["trial_id"] = record["trial_id"]
    return record
