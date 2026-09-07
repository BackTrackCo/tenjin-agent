"""Immutable attempt records.

Write a unique partial file, flush it, publish the final path without
overwrite. `os.link` is the publish step because it fails atomically when the
final path exists, so two writers for one trial_id cannot both win. Resume
accepts only a final record whose manifest and schedule hashes match; every
other file is excluded with a machine-readable reason.
"""

from __future__ import annotations

import json
import os
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

RECORD_SCHEMA = "bench1.attempt.v0"
OUTCOMES = frozenset({"pass", "fail", "capped", "interrupted", "invalid"})
REQUIRED = frozenset(
    {
        "schema",
        "trial_id",
        "manifest_hash",
        "schedule_hash",
        "task_id",
        "arm_id",
        "repeat",
        "position",
        "outcome",
        "usage",
    }
)


class RecordError(ValueError):
    pass


@dataclass(frozen=True)
class Excluded:
    path: str
    reason: str


def final_path(records_dir: Path, trial_id: str) -> Path:
    return records_dir / f"{trial_id}.json"


def publish(records_dir: Path, record: dict[str, Any]) -> tuple[Path, bool]:
    """Return (final path, won). A loser keeps its partial file as evidence."""
    validate(record)
    records_dir.mkdir(parents=True, exist_ok=True)
    partial = records_dir / f"{record['trial_id']}.partial.{uuid.uuid4().hex}.json"
    with partial.open("w", encoding="utf-8") as handle:
        json.dump(record, handle, indent=2, sort_keys=True)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    final = final_path(records_dir, record["trial_id"])
    try:
        os.link(partial, final)
    except FileExistsError:
        return final, False
    partial.unlink()
    return final, True


def validate(record: dict[str, Any]) -> None:
    missing = sorted(REQUIRED - set(record))
    if missing:
        raise RecordError(f"record is missing keys: {', '.join(missing)}")
    if record["schema"] != RECORD_SCHEMA:
        raise RecordError(f"record schema must be {RECORD_SCHEMA}")
    if record["outcome"] not in OUTCOMES:
        raise RecordError(f"unknown outcome {record['outcome']!r}")
    if not isinstance(record["usage"], list):
        raise RecordError("usage must be a list")


def select(
    records_dir: Path, manifest_hash: str, schedule_hash: str
) -> tuple[dict[str, dict[str, Any]], list[Excluded]]:
    """Final records keyed by trial_id, plus everything the reducer must not read."""
    accepted: dict[str, dict[str, Any]] = {}
    excluded: list[Excluded] = []
    if not records_dir.is_dir():
        return accepted, excluded
    for path in sorted(records_dir.iterdir()):
        if ".partial." in path.name:
            excluded.append(Excluded(path.name, "partial"))
            continue
        if path.suffix != ".json":
            continue
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
            validate(record)
        except (OSError, ValueError) as error:
            excluded.append(Excluded(path.name, f"invalid: {error}"))
            continue
        if record["manifest_hash"] != manifest_hash or record["schedule_hash"] != schedule_hash:
            excluded.append(Excluded(path.name, "stale"))
            continue
        if path.stem != record["trial_id"]:
            excluded.append(Excluded(path.name, "misnamed"))
            continue
        if record["trial_id"] in accepted:
            excluded.append(Excluded(path.name, "duplicate"))
            continue
        accepted[record["trial_id"]] = record
    return accepted, excluded
