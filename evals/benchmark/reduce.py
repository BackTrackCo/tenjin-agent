"""Failure-inclusive, task-equal reducer.

Failed, capped, and interrupted attempts keep their usage in the numerator:
they are task outcomes, so dropping them would pay an arm for giving up.
Infrastructure-invalid attempts are the opposite case, and they are counted
and named rather than scored. Every task weighs the same regardless of repeats
or token size, which is why every arm figure is a mean over task cells and
never a sum over attempts.

Pass rate and token ratio are separate axes. A cheaper arm that solves less is
not a better arm, so nothing here folds the two into one number.
`tokens_per_verified_resolution` reports null with a reason instead of
dividing by zero.

The numerator is consumer actor-set usage plus the consumer-phase auxiliary
receipts the attempt caused. Injected text is already inside the consumer's
input and the reasoning subset is already inside `output_total`; both are
reported as diagnostics beside the total and never added to it. Producer and
capture phase receipts are one-time knowledge cost, so they leave the
per-attempt numerator and come back through amortization at reuse 1, 2, 5,
and 10.
"""

from __future__ import annotations

import random
import statistics
from typing import Any

from .records import Excluded
from .usage import from_json, totals

REDUCTION_SCHEMA = "bench1.reduction.v1"
SCORED = ("pass", "fail", "capped", "interrupted")
OUTCOMES = (*SCORED, "invalid")
# A cap is a declared accounting gap, not a hidden one.
PARTIAL_OUTCOMES = frozenset({"capped", "interrupted"})
COMPLETE_RECONCILIATION = frozenset({"matched", "matched_with_descendants"})
CAPTURE_PHASES = frozenset({"producer", "capture"})
REUSE_POINTS = (1, 2, 5, 10)
RESAMPLES = 2000
CONFIDENCE = 0.95
# Reporting precision for derived floats. Ratios are dimensionless and nothing
# downstream needs more digits, and rounding here is what keeps the golden
# bootstrap byte-identical across platforms and Python builds.
PRECISION = 12


class ReduceError(ValueError):
    pass


def _round(value: float | None) -> float | None:
    return None if value is None else round(value, PRECISION)


def _mean(values: list[float]) -> float | None:
    return None if not values else _round(statistics.fmean(values))


def consumer_auxiliary(record: dict[str, Any]) -> int:
    """Auxiliary memory-product tokens this attempt itself caused."""
    return sum(
        receipt["input_total"] + receipt["output_total"]
        for receipt in record["auxiliary"]
        if receipt["phase"] not in CAPTURE_PHASES
    )


def capture_tokens(cells: list[dict[str, Any]]) -> int:
    """One-time producer/capture spend for a set of attempts.

    Keyed by native request id: a capture call that several consuming trials
    each record is one call that happened once, and counting it per attempt
    would charge an arm again for every reuse.
    """
    seen: dict[str, int] = {}
    for record in cells:
        for receipt in record["auxiliary"]:
            if receipt["phase"] in CAPTURE_PHASES:
                seen[receipt["native_request_id"]] = receipt["input_total"] + receipt["output_total"]
    return sum(seen.values())


def _accounting(record: dict[str, Any]) -> str:
    if record["outcome"] in PARTIAL_OUTCOMES:
        return "partial_by_cap"
    status = record["usage_reconciliation"].get("status")
    if status in COMPLETE_RECONCILIATION and not record["unresolved_actors"]:
        return "complete"
    return "incomplete"


def _cell(records: list[dict[str, Any]]) -> dict[str, Any]:
    # Totals are taken per attempt and then added. A native request id is
    # unique inside one attempt and repeats across attempts, so pooling first
    # would let one attempt's request cancel another's.
    per_attempt = [totals([from_json(item) for item in record["usage"]]) for record in records]
    auxiliary = sum(consumer_auxiliary(record) for record in records)
    tokens = sum(summed["total"] for summed in per_attempt) + auxiliary
    attempts = len(records)
    passes = sum(1 for record in records if record["outcome"] == "pass")
    subsets = [summed["reasoning_output_subset"] for summed in per_attempt]
    reasoning = None if any(value is None for value in subsets) else sum(subsets)
    return {
        "attempts": attempts,
        "passes": passes,
        "pass_rate": _round(passes / attempts),
        "requests": sum(summed["requests"] for summed in per_attempt),
        "tokens": tokens,
        "tokens_per_attempt": _round(tokens / attempts),
        "tokens_per_verified_resolution": None if passes == 0 else _round(tokens / passes),
        "tokens_per_verified_resolution_reason": "no_verified_resolution" if passes == 0 else None,
        "outcomes": {name: sum(1 for record in records if record["outcome"] == name) for name in SCORED},
        "diagnostics": {
            # Named beside the total, never inside it.
            "auxiliary_consumer_tokens": auxiliary,
            "reasoning_output_subset": reasoning,
            "reasoning_unavailable": sum(summed["unavailable"]["reasoning_output_subset"] for summed in per_attempt),
            "deliveries": sum(len(record["delivery"]["fires"]) for record in records),
            "counted_in_tokens": False,
        },
    }


def amortize(tokens_per_attempt: float | None, capture: int) -> list[dict[str, Any]]:
    """Capture cost spread over 1, 2, 5, and 10 consuming uses."""
    schedule: list[dict[str, Any]] = []
    for reuse in REUSE_POINTS:
        share = capture / reuse
        schedule.append(
            {
                "reuse": reuse,
                "capture_tokens_per_use": _round(share),
                "tokens_per_attempt": None if tokens_per_attempt is None else _round(tokens_per_attempt + share),
            }
        )
    return schedule


def _quantile_index(count: int, quantile: float) -> int:
    """Nearest-rank index into a sorted sample. Stated so the golden is a rule."""
    return min(count - 1, max(0, int(quantile * (count - 1) + 0.5)))


def paired_bootstrap(
    ratios: list[float], seed: int, resamples: int = RESAMPLES, confidence: float = CONFIDENCE
) -> dict[str, Any] | None:
    """Percentile interval for the mean per-task ratio, resampling tasks.

    Tasks are the sampling unit because tasks are the unit the reducer weighs
    equally; resampling attempts would let a task with more repeats speak
    louder. `random.Random(seed)` and a stated rank rule make one frozen seed
    reproduce one interval, which is what the golden fixture pins.
    """
    if not ratios:
        return None
    count = len(ratios)
    generator = random.Random(seed)
    sample: list[float] = []
    for _ in range(resamples):
        draw = [ratios[generator.randrange(count)] for _ in range(count)]
        sample.append(statistics.fmean(draw))
    sample.sort()
    return {
        "method": "task_paired_percentile",
        "point": _mean(ratios),
        "low": _round(sample[_quantile_index(resamples, (1 - confidence) / 2)]),
        "high": _round(sample[_quantile_index(resamples, (1 + confidence) / 2)]),
        "tasks": count,
        "resamples": resamples,
        "confidence": confidence,
        "seed": seed,
    }


def _compare(arm: dict[str, Any], base: dict[str, Any], seed: int) -> dict[str, Any]:
    shared = sorted(set(arm["tasks"]) & set(base["tasks"]))
    ratios: list[float] = []
    reason: str | None = None
    for task_id in shared:
        divisor = base["tasks"][task_id]["tokens_per_attempt"]
        if not divisor:
            reason = "baseline_zero_tokens"
            ratios = []
            break
        ratios.append(arm["tasks"][task_id]["tokens_per_attempt"] / divisor)
    if not shared:
        reason = "no_shared_task"
    ratio = _mean(ratios)
    capture_ratio: list[dict[str, Any]] = []
    base_points = amortize(base["tokens_per_attempt"], base["capture_tokens"])
    arm_points = amortize(arm["tokens_per_attempt"], arm["capture_tokens"])
    for point, arm_point in zip(base_points, arm_points):
        divisor = point["tokens_per_attempt"]
        capture_ratio.append(
            {
                "reuse": point["reuse"],
                "token_ratio": None if not divisor else _round(arm_point["tokens_per_attempt"] / divisor),
            }
        )
    pass_delta = (
        None
        if arm["pass_rate"] is None or base["pass_rate"] is None
        else _round(arm["pass_rate"] - base["pass_rate"])
    )
    return {
        "tasks": len(shared),
        "token_ratio": ratio,
        "token_ratio_reason": reason,
        "pass_rate_delta": pass_delta,
        "interval": paired_bootstrap(ratios, seed),
        "amortized_token_ratio": capture_ratio,
        "headline_eligible": bool(arm["headline_eligible"] and base["headline_eligible"] and ratio is not None),
    }


def reduce(
    accepted: dict[str, dict[str, Any]],
    excluded: list[Excluded],
    baseline: str | None = None,
    seed: int = 0,
    declared_arms: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Task-equal aggregates per arm, plus comparisons against one baseline arm.

    `declared_arms` is the manifest's arm list. The records say what was
    observed; only the manifest can say what an arm was able to expose, so an
    arm declaring `auxiliary_usage: unexposed` is accounting-incomplete even
    when every one of its records reconciles.
    """
    declared = {arm["id"]: arm.get("auxiliary_usage") for arm in declared_arms or []}
    arms: dict[str, dict[str, Any]] = {}
    invalid: list[dict[str, str]] = []
    cells: dict[tuple[str, str], list[dict[str, Any]]] = {}
    scored_by_arm: dict[str, list[dict[str, Any]]] = {}
    for record in accepted.values():
        arm = arms.setdefault(
            record["arm_id"],
            {"attempts": 0, "outcomes": {name: 0 for name in OUTCOMES}, "tasks": {}, "accounting_reasons": []},
        )
        arm["attempts"] += 1
        arm["outcomes"][record["outcome"]] += 1
        if record["outcome"] == "invalid":
            # Named, never scored: an invalid attempt is a measurement that did
            # not happen, not a zero-token run and not a miss.
            invalid.append(
                {
                    "trial_id": record["trial_id"],
                    "arm_id": record["arm_id"],
                    "task_id": record["task_id"],
                    "reason": str(record["invalid_reason"]).split(":", 1)[0],
                }
            )
            continue
        cells.setdefault((record["arm_id"], record["task_id"]), []).append(record)
        scored_by_arm.setdefault(record["arm_id"], []).append(record)
    for (arm_id, task_id), cell in sorted(cells.items()):
        arms[arm_id]["tasks"][task_id] = _cell(cell)
    for arm_id, arm in arms.items():
        scored = scored_by_arm.get(arm_id, [])
        states = {_accounting(record) for record in scored}
        reasons = {
            record["usage_reconciliation"].get("status", "unparsed") for record in scored if _accounting(record) == "incomplete"
        }
        if declared.get(arm_id) == "unexposed":
            states.add("incomplete")
            reasons.add("auxiliary_unexposed")
        arm["accounting"] = "incomplete" if "incomplete" in states else ("partial_by_cap" if "partial_by_cap" in states else "complete")
        arm["accounting_reasons"] = sorted(reasons)
        arm["headline_eligible"] = arm["accounting"] != "incomplete" and bool(arm["tasks"])
        arm["capture_tokens"] = capture_tokens(scored)
        tasks = list(arm["tasks"].values())
        arm["tokens"] = sum(task["tokens"] for task in tasks)
        arm["pass_rate"] = _mean([task["pass_rate"] for task in tasks])
        arm["tokens_per_attempt"] = _mean([task["tokens_per_attempt"] for task in tasks])
        per_task = [task["tokens_per_verified_resolution"] for task in tasks]
        if not per_task or any(value is None for value in per_task):
            arm["tokens_per_verified_resolution"] = None
            arm["tokens_per_verified_resolution_reason"] = "no_verified_resolution"
        else:
            arm["tokens_per_verified_resolution"] = _mean(per_task)
            arm["tokens_per_verified_resolution_reason"] = None
        arm["amortization"] = amortize(arm["tokens_per_attempt"], arm["capture_tokens"])
    comparisons: dict[str, Any] = {}
    if baseline is not None:
        if baseline not in arms:
            raise ReduceError(f"baseline arm {baseline!r} has no accepted attempt")
        for arm_id in sorted(arms):
            if arm_id != baseline:
                comparisons[arm_id] = _compare(arms[arm_id], arms[baseline], seed)
    return {
        "schema": REDUCTION_SCHEMA,
        "arms": arms,
        "baseline": baseline,
        "comparisons": comparisons,
        "invalid": invalid,
        "excluded": [{"path": item.path, "reason": item.reason} for item in excluded],
    }

