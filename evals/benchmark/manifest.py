"""Frozen run manifest: load, validate, hash.

Manifest values are data. Executor and verifier names select code-owned argv
in `executor.py` and `verifier.py`; no field here is ever shell-evaluated.
Validation runs before any spend, so a bad manifest costs nothing.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import sha256_json

SCHEMA_VERSION = 1

TOP_KEYS = frozenset(
    {
        "benchmark_version",
        "schema_version",
        "harness",
        "seed",
        "repeats",
        "pins",
        "price_sheet_version",
        "tasks",
        "arms",
    }
)
PIN_KEYS = frozenset({"model", "harness_version", "image", "wall_clock_s", "turn_budget"})
TASK_KEYS = frozenset({"id", "family", "transfer_distance", "fixture", "verifier"})
ARM_KEYS = frozenset({"id", "executor", "product_version", "settings_hash", "memory_snapshot_hash"})

# A version a later run could resolve differently is not a pin.
UNPINNED = ("latest", "*", "^", "~", ">", "<")


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

    def fixture_path(self, task: dict[str, Any]) -> Path:
        return (self.path.parent / task["fixture"]).resolve()


def _pinned(value: Any) -> bool:
    return isinstance(value, str) and value.strip() != "" and not value.startswith(UNPINNED)


def _require_keys(name: str, item: Any, allowed: frozenset[str]) -> None:
    if not isinstance(item, dict):
        raise ManifestError(f"{name} must be an object")
    unknown = sorted(set(item) - allowed)
    missing = sorted(allowed - set(item))
    if unknown:
        raise ManifestError(f"{name} has unknown keys: {', '.join(unknown)}")
    if missing:
        raise ManifestError(f"{name} is missing keys: {', '.join(missing)}")


def validate(data: dict[str, Any], base: Path) -> None:
    _require_keys("manifest", data, TOP_KEYS)
    if data["schema_version"] != SCHEMA_VERSION:
        raise ManifestError(f"schema_version must be {SCHEMA_VERSION}")
    _require_keys("pins", data["pins"], PIN_KEYS)
    for key in ("model", "harness_version", "image"):
        if not _pinned(data["pins"][key]):
            raise ManifestError(f"pins.{key} is not pinned")
    for key in ("wall_clock_s", "turn_budget", "seed", "repeats"):
        holder = data["pins"] if key in PIN_KEYS else data
        if not isinstance(holder[key], int) or isinstance(holder[key], bool) or holder[key] < 0:
            raise ManifestError(f"{key} must be a non-negative integer")
    if data["repeats"] < 1:
        raise ManifestError("repeats must be at least 1")
    if not _pinned(data["benchmark_version"]) or not _pinned(data["price_sheet_version"]):
        raise ManifestError("benchmark_version and price_sheet_version must be pinned")
    if not isinstance(data["tasks"], list) or not data["tasks"]:
        raise ManifestError("tasks must be a non-empty list")
    if not isinstance(data["arms"], list) or len(data["arms"]) < 2:
        raise ManifestError("arms must list at least two arms")
    seen: set[str] = set()
    for task in data["tasks"]:
        _require_keys("task", task, TASK_KEYS)
        if task["id"] in seen:
            raise ManifestError(f"duplicate task id {task['id']!r}")
        seen.add(task["id"])
        fixture = base / task["fixture"]
        if ".." in Path(task["fixture"]).parts or not fixture.is_dir():
            raise ManifestError(f"task {task['id']!r} fixture path is missing: {task['fixture']}")
    seen.clear()
    executors: set[str] = set()
    for arm in data["arms"]:
        _require_keys("arm", arm, ARM_KEYS)
        if arm["id"] in seen:
            raise ManifestError(f"duplicate arm id {arm['id']!r}")
        seen.add(arm["id"])
        if not _pinned(arm["product_version"]):
            raise ManifestError(f"arm {arm['id']!r} product_version is not pinned")
        executors.add(arm["executor"])
    # Arms that run different executors measure different harnesses, so their
    # token totals would not be comparable under one manifest.
    if len(executors) != 1:
        raise ManifestError("arms are unbalanced: every arm must share one executor")


def load(path: Path) -> Manifest:
    path = path.resolve()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ManifestError(f"cannot read manifest: {error}") from error
    validate(data, path.parent)
    return Manifest(data=data, path=path, hash=sha256_json(data))
