"""Frozen run manifest: load, validate, hash.

Manifest values are data. Executor and verifier names select code-owned argv
in `executor.py` and `verifier.py`; no field here is ever shell-evaluated.
Validation runs before any spend, so a bad manifest costs nothing, and the
manifest hash covers every byte the schedule and trial ids derive from.

`SCHEMA` is the shape: keys, types, enums, patterns, bounds. What follows it in
`validate` is the short list a schema cannot state, because each rule reads
something outside the document: the fixture directory on disk, the hash of its
bytes, and whether ids repeat or the arms disagree on one executor.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import sha256_dir, sha256_json
from .schema import check, enum
from .usage import HARNESSES

SCHEMA_VERSION = 1

PHASE_KEYS = frozenset({"producer", "capture", "consumer"})
TRANSFER_DISTANCES = frozenset({"none", "same_task", "same_family", "cross_family"})
# What an arm's memory product can prove about its own model spend. `none` is a
# claim that it spends no model tokens outside the harness session; `exposed`
# means it emits auxiliary receipts; `unexposed` is an arm whose spend the
# benchmark cannot see, which the reducer keeps out of the headline. There is
# no default: silence about auxiliary spend is the failure this field names.
AUXILIARY_EXPOSURE = frozenset({"none", "exposed", "unexposed"})

# Ids appear in publishable output, so they are opaque tokens by construction.
IDENTIFIER = {"type": "string", "pattern": r"^[A-Za-z0-9_-]{1,64}$"}
# A version a later run could resolve differently is not a pin: a value that
# says nothing, or that opens with a tag or a range operator.
UNPINNED = ("latest", "*", "^", "~", ">", "<")
PINNED = {
    "type": "string",
    "pattern": r"\S",
    "not": {"pattern": "^(" + "|".join(re.escape(prefix) for prefix in UNPINNED) + ")"},
}
HASH_TOKEN = {"type": "string", "pattern": "^sha256:.+"}
NON_BLANK = {"type": "string", "pattern": r"\S"}
STRINGS = {"type": "array", "items": {"type": "string"}}
COUNT = {"type": "integer", "minimum": 0}
POSITIVE = {"type": "integer", "minimum": 1}
# Relative, and no segment that climbs out of the manifest's own directory.
# Transcribed from `Path(value).is_absolute()` and `".." in Path(value).parts`,
# which is what the fixture lookup below still resolves against.
FIXTURE_PATH = {"type": "string", "pattern": r"^[^/]", "not": {"pattern": r"(^|/)\.\.(/|$)"}}

# Shape, and only shape. Every rule that has to read something outside this
# document is in `validate` below: whether the fixture directory is there,
# whether its bytes hash to what the task claims, whether two tasks or two arms
# share an id, and whether the arms agree on one executor.
SCHEMA: dict[str, Any] = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "additionalProperties": False,
    "required": ["arms", "benchmark_version", "harness", "pins", "price_sheet_version", "repeats", "schema_version", "seed", "tasks"],
    "properties": {
        "benchmark_version": PINNED,
        "price_sheet_version": PINNED,
        "schema_version": {"const": SCHEMA_VERSION},
        "harness": enum(HARNESSES),
        "seed": COUNT,
        "repeats": POSITIVE,
        "pins": {
            "type": "object",
            "additionalProperties": False,
            "required": ["dependency_lock_hash", "effort", "harness_version", "image", "model", "permission_mode", "turn_budget", "wall_clock_s"],
            "properties": {
                "model": PINNED,
                "harness_version": PINNED,
                "effort": PINNED,
                "speed_mode": enum({"standard", "fast"}),
                "agent_package": enum({"@anthropic-ai/claude-code", "@openai/codex"}),
                "billing_mode": enum({"subscription"}),
                "image": PINNED,
                "permission_mode": PINNED,
                "dependency_lock_hash": HASH_TOKEN,
                "wall_clock_s": POSITIVE,
                "turn_budget": {"anyOf": [POSITIVE, {"type": "null"}]},
                # What a live executor needs and a fake one has no use for.
                # Coarse shapes here so a bad manifest costs nothing; the
                # executor that turns these into argv owns the flag and value
                # allowlists (`claude_live.py`).
                "concurrency": POSITIVE,
                "max_budget_usd": {"anyOf": [{"type": "number", "exclusiveMinimum": 0}, {"type": "null"}]},
                "tools": STRINGS,
                "allowed_tools": STRINGS,
                "credential_env": NON_BLANK,
            },
        },
        "phases": {
            "type": "object",
            "additionalProperties": False,
            "required": sorted(PHASE_KEYS),
            "properties": {phase: PINNED for phase in sorted(PHASE_KEYS)},
        },
        "tasks": {
            "type": "array",
            "minItems": 1,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["family", "fixture", "fixture_hash", "id", "transfer_distance", "verifier"],
                "properties": {
                    "id": IDENTIFIER,
                    "family": IDENTIFIER,
                    "verifier": IDENTIFIER,
                    "transfer_distance": enum(TRANSFER_DISTANCES),
                    "fixture": FIXTURE_PATH,
                    "fixture_hash": HASH_TOKEN,
                    "prompt": NON_BLANK,
                },
            },
        },
        "arms": {
            "type": "array",
            "minItems": 1,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["auxiliary_usage", "executor", "id", "memory_snapshot_hash", "product_version", "settings_hash"],
                "properties": {
                    "id": IDENTIFIER,
                    "executor": IDENTIFIER,
                    "product_version": PINNED,
                    "settings_hash": HASH_TOKEN,
                    "memory_snapshot_hash": HASH_TOKEN,
                    "auxiliary_usage": enum(AUXILIARY_EXPOSURE),
                    "settings": {"type": "object"},
                    "provision": IDENTIFIER,
                    "lessons": {"type": "array", "minItems": 1, "items": IDENTIFIER},
                },
            },
        },
    },
}


class ManifestError(ValueError):
    pass


@dataclass(frozen=True)
class Manifest:
    data: dict[str, Any]
    path: Path
    hash: str

    @property
    def tasks(self) -> list[dict[str, Any]]:
        return list(self.data["tasks"])

    @property
    def arms(self) -> list[dict[str, Any]]:
        return list(self.data["arms"])

    @property
    def pins(self) -> dict[str, Any]:
        return dict(self.data["pins"])

    @property
    def harness(self) -> str:
        return str(self.data["harness"])

    @property
    def concurrency(self) -> int:
        """How many trials may be in flight at once. Absent means one, so an existing manifest is unchanged.

        It is a pin because it is a property of the run rather than of the
        schedule, and `environment_hash` is the hash of the pins: a reader
        comparing two runs sees a different environment without a new field.
        """
        return int(self.data["pins"].get("concurrency", 1))

    def fixture_path(self, task: dict[str, Any]) -> Path:
        return (self.path.parent / task["fixture"]).resolve()


def fixture_hash(fixture: Path) -> str:
    """The committed fixture files. The layer that vendors a toolchain folds its archive digest in."""
    return "sha256:" + sha256_dir(fixture)


def validate(data: dict[str, Any], base: Path) -> None:
    """The schema, then the four rules a schema cannot state."""
    check("manifest", data, SCHEMA, ManifestError)
    seen: set[str] = set()
    for task in data["tasks"]:
        task_id = task["id"]
        if task_id in seen:
            raise ManifestError(f"duplicate task id {task_id!r}")
        seen.add(task_id)
        fixture = base / task["fixture"]
        if not fixture.is_dir():
            raise ManifestError(f"task {task_id!r} fixture path is missing: {task['fixture']}")
        if task["fixture_hash"] != fixture_hash(fixture):
            raise ManifestError(f"task {task_id!r} fixture_hash does not match the fixture directory")
    seen.clear()
    for arm in data["arms"]:
        if arm["id"] in seen:
            raise ManifestError(f"duplicate arm id {arm['id']!r}")
        seen.add(arm["id"])
    # Arms that run different executors measure different harnesses, so their
    # token totals would not be comparable under one manifest.
    if len({arm["executor"] for arm in data["arms"]}) != 1:
        raise ManifestError("arms are unbalanced: every arm must share one executor")


def expand_selection(data: dict[str, Any], path: Path) -> dict[str, Any]:
    """Select from one sibling manifest before validation, hashing and scheduling.

    No inherited selections or path traversal: fixture paths keep their original
    base directory and a selection cannot form an inheritance cycle.
    """
    if "source" not in data:
        return data
    if set(data) - {"schema", "source", "tasks", "arms"} or data.get("schema") != "bench1.selection.v1":
        raise ManifestError("selection must name schema, source and optional task/arm ids")
    source = data["source"]
    if not isinstance(source, str) or not re.fullmatch(r"[A-Za-z0-9_-]+\.json", source):
        raise ManifestError("selection source must be a sibling JSON filename")
    source_path = path.parent / source
    if source_path.resolve().parent != path.parent:
        raise ManifestError("selection source must remain in its directory")
    try:
        selected = json.loads(source_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ManifestError(f"cannot read selection source: {error}") from error
    if not isinstance(selected, dict) or "source" in selected:
        raise ManifestError("selection source must be a full manifest, not another selection")
    for key in ("tasks", "arms"):
        if key not in data:
            continue
        ids = data[key]
        if not isinstance(ids, list) or not ids or not all(isinstance(item, str) for item in ids) or len(ids) != len(set(ids)):
            raise ManifestError(f"selection {key} must be unique, nonempty ids")
        available = selected.get(key)
        if not isinstance(available, list) or not all(isinstance(item, dict) and isinstance(item.get("id"), str) for item in available):
            raise ManifestError(f"selection source has malformed {key}")
        if set(ids) - {item["id"] for item in available}:
            raise ManifestError(f"selection {key} contains unknown ids")
        selected[key] = [item for item in available if item["id"] in ids]
    return selected


def load(path: Path) -> Manifest:
    path = path.resolve()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ManifestError(f"cannot read manifest: {error}") from error
    if not isinstance(data, dict):
        raise ManifestError("manifest must be a JSON object")
    data = expand_selection(data, path)
    validate(data, path.parent)
    return Manifest(data=data, path=path, hash=sha256_json(data))
