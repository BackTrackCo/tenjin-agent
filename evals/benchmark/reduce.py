"""Failure-inclusive, task-equal reducer.

Failed and capped attempts keep their usage in the numerator. Invalid attempts
never enter a result silently: they are counted and named. Every task weighs
the same regardless of repeats or token size, and pass rate and token ratio
stay separate axes. `tokens_per_verified_resolution` reports null with a
reason rather than dividing by zero.
"""

from __future__ import annotations

import statistics
from typing import Any

from .records import Excluded
from .usage import from_json, totals

SCORED = ("pass", "fail", "capped", "interrupted")


def _task_cell(cell: list[dict[str, Any]]) -> dict[str, Any]:
    usage = [from_json(item) for record in cell for item in record["usage"]]
    summed = totals(usage)
    passes = sum(1 for record in cell if record["outcome"] == "pass")
    tokens = summed["total"]
    return {
        "attempts": len(cell),
        "passes": passes,
        "requests": summed["requests"],
        "tokens": tokens,
        "tokens_per_verified_resolution": None if passes == 0 else tokens / passes,
    }


def reduce(accepted: dict[str, dict[str, Any]], excluded: list[Excluded]) -> dict[str, Any]:
    arms: dict[str, dict[str, Any]] = {}
    invalid: list[dict[str, str]] = []
    cells: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for record in accepted.values():
        arm = arms.setdefault(
            record["arm_id"],
            {"attempts": 0, "outcomes": {name: 0 for name in (*SCORED, "invalid")}, "tasks": {}},
        )
        arm["attempts"] += 1
        arm["outcomes"][record["outcome"]] += 1
        if record["outcome"] == "invalid":
            invalid.append({"trial_id": record["trial_id"], "arm_id": record["arm_id"], "task_id": record["task_id"]})
            continue
        cells.setdefault((record["arm_id"], record["task_id"]), []).append(record)
    for (arm_id, task_id), cell in sorted(cells.items()):
        arms[arm_id]["tasks"][task_id] = _task_cell(cell)
    for arm_id, arm in arms.items():
        per_task = [task["tokens_per_verified_resolution"] for task in arm["tasks"].values()]
        scored = sum(arm["outcomes"][name] for name in SCORED)
        arm["pass_rate"] = None if scored == 0 else arm["outcomes"]["pass"] / scored
        arm["tokens"] = sum(task["tokens"] for task in arm["tasks"].values())
        if not per_task or any(value is None for value in per_task):
            arm["tokens_per_verified_resolution"] = None
            arm["tokens_per_verified_resolution_reason"] = "no_verified_resolution"
        else:
            arm["tokens_per_verified_resolution"] = statistics.fmean(per_task)
            arm["tokens_per_verified_resolution_reason"] = None
    return {
        "arms": arms,
        "invalid": invalid,
        "excluded": [{"path": item.path, "reason": item.reason} for item in excluded],
    }
