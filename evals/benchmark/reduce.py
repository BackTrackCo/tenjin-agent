"""Failure-inclusive, task-equal reducer.

Failed, capped, and interrupted attempts keep their usage in the numerator:
they are task outcomes, so dropping them would pay an arm for giving up.
Infrastructure-invalid attempts are the opposite case, and they are counted
and named rather than scored. Every task weighs the same regardless of repeats
or token size, which is why every arm figure is a mean over task cells and
never a sum over attempts.

Every ratio is stated beside what it decomposes into: requests per attempt,
new tokens per attempt (uncached input, cache writes, and output), and their
ratios. A fixed preamble is replayed on every request, so a ratio of token
totals moves with the number of round trips; the new-token ratio is the same
arms over ingestion nobody had paid for before, and only the two together say
whether an arm sent less or merely sent fewer times.

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

import statistics
from typing import Any

import numpy as np
from scipy import stats

from . import phases as phases_module
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
# downstream needs more digits, and rounding here is what keeps a published
# number from carrying a platform's last float bit.
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


def capture_tokens(cells: list[dict[str, Any]], phases: frozenset[str] = CAPTURE_PHASES) -> int:
    """One-time producer/capture spend for a set of attempts.

    Keyed by native request id: a capture call that several consuming trials
    each record is one call that happened once, and counting it per attempt
    would charge an arm again for every reuse.
    """
    seen: dict[str, int] = {}
    for record in cells:
        for receipt in record["auxiliary"]:
            if receipt["phase"] in phases:
                seen[receipt["native_request_id"]] = receipt["input_total"] + receipt["output_total"]
    return sum(seen.values())


def phase_tokens(cells: list[dict[str, Any]]) -> dict[str, int]:
    """The one-time spend by phase: `producer` is the task's own work, `capture` what the capture ask added on top."""
    return {phase: capture_tokens(cells, frozenset({phase})) for phase in sorted(CAPTURE_PHASES)}


def producers_of(cells: list[dict[str, Any]]) -> int:
    """How many attempts in the cell carried a producer or capture receipt: one producer per such attempt."""
    return sum(1 for record in cells if any(receipt["phase"] in CAPTURE_PHASES for receipt in record["auxiliary"]))


def per_producer(cells: list[dict[str, Any]]) -> dict[str, float]:
    """The one-time spend one lesson cost, per phase: the cell's phase tokens over its producers, zero with none.

    Amortization is per lesson, and a task is one lesson: a task that ran three
    producers paid for the lesson three times over, so the figure a consumer
    is charged is the mean producer's, never the cell's sum.
    """
    count = producers_of(cells)
    totals = phase_tokens(cells)
    return {phase: (float(totals[phase]) / count if count else 0.0) for phase in totals}


def overhead_tokens(record: dict[str, Any]) -> int:
    """The attempt's turn-end nudge and CLI search, as the store marked them. Zero for an undecomposed attempt."""
    return phases_module.tokens(record.get("attempt_phases"), phases_module.NUDGE, phases_module.SEARCH)


def attempt_phase_tokens(records: list[dict[str, Any]]) -> dict[str, int]:
    """Tokens per attempt phase over the cell, so a reader sees what the arm's own requests went to."""
    return {
        phase: sum(phases_module.tokens(record.get("attempt_phases"), phase) for record in records)
        for phase in phases_module.PHASES
    }


def new_tokens(per_attempt: list[dict[str, Any]], auxiliary: int) -> int | None:
    """Ingestion nobody had already paid for: uncached input, cache writes, and output.

    A cache read is the same bytes replayed on the next request of the same
    attempt, so it belongs in the token total and not here. What is left is the
    unique text an arm made the provider take in and produce, which is the
    figure a token ratio is often read as. Null when a record hid a category,
    because a zero there would read as an observation. An auxiliary receipt
    exposes no cache split, so all of it counts as new.
    """
    if any(summed["uncached_input"] is None or summed["cache_write"] is None for summed in per_attempt):
        return None
    return sum(summed["uncached_input"] + summed["cache_write"] + summed["output_total"] for summed in per_attempt) + auxiliary


def child_usage(record: dict[str, Any]) -> tuple[int, int]:
    """Tokens and requests of the attempt's descendants (every actor but the lead), for the recursive slice's per-actor reading."""
    tokens = requests = 0
    for item in record["usage"]:
        if item["actor_key"][2] != "":
            tokens += item["input_total"] + item["output_total"]
            requests += 1
    return tokens, requests


def local_legs(record: dict[str, Any]) -> tuple[int, int]:
    """Legs the local store answered (`shelf` local): sent, and hits."""
    legs = [leg for leg in record["delivery"].get("legs", []) if leg.get("shelf") == "local"]
    return len(legs), sum(1 for leg in legs if leg.get("outcome") == "hit")


def producer_summary(records: list[dict[str, Any]]) -> dict[str, Any] | None:
    """What the natural arm's producer phases did, over every accepted attempt of the arm: run, passed, captured, and refused."""
    phases = [record["isolation"]["producer"] for record in records if isinstance(record["isolation"].get("producer"), dict)]
    if not phases:
        return None
    return {
        "attempts": len(phases),
        "passes": sum(1 for phase in phases if phase.get("outcome") == "pass"),
        "captured": sum(1 for phase in phases if sum(phase.get("capture", {}).get("pairings", {}).get(status, 0) for status in ("unverified", "verified")) > 0),
        "findings": sum(int(phase.get("capture", {}).get("findings", 0)) for phase in phases),
        "invalid": sum(1 for phase in phases if phase.get("outcome") == "invalid"),
        "wal_live": sum(1 for phase in phases if phase.get("wal_live_between_phases")),
    }


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
    children = [child_usage(record) for record in records]
    locals_ = [local_legs(record) for record in records]
    overhead = sum(overhead_tokens(record) for record in records)
    requests = sum(summed["requests"] for summed in per_attempt)
    new = new_tokens(per_attempt, auxiliary)
    durations = [record.get("agent_time_s") for record in records]
    timed = all(value is not None for value in durations)
    capture_share = per_producer(records)["capture"]
    system_tokens = tokens + capture_share * attempts
    return {
        "consumer_tokens_per_verified_resolution": None if not passes else _round(tokens / passes),
        "system_completion_by_reuse": [{"reuse": reuse, "tokens": None if not passes else _round((tokens + capture_share * attempts / reuse) / passes)} for reuse in REUSE_POINTS],
        "consumer_seconds_per_verified_resolution": None if not passes or not timed else _round(sum(durations) / passes),
        "consumer_seconds_reason": "no_verified_resolution" if not passes else (None if timed else "timing_unavailable"),
        "attempts": attempts,
        "passes": passes,
        "pass_rate": _round(passes / attempts),
        "phase_tokens": phase_tokens(records),
        "producers": producers_of(records),
        "capture_per_producer": {phase: _round(value) for phase, value in per_producer(records).items()},
        "requests": requests,
        # Round trips and unique ingestion, beside the total the headline uses.
        # A ratio of totals moves with the number of requests, because a fixed
        # preamble is replayed on every one of them; these two say how much of
        # it was round trips and how much was text nobody had sent before. The
        # corpus readout orders tasks by requests_per_attempt in the baseline
        # arm, which is what a task cost to work out with nothing carried in.
        "requests_per_attempt": _round(requests / attempts),
        "new_tokens": new,
        "new_tokens_per_attempt": None if new is None else _round(new / attempts),
        "new_tokens_reason": None if new is not None else "categories_unexposed",
        "tokens": tokens,
        "tokens_per_attempt": _round(tokens / attempts),
        # The same attempts with the product's own turn-end nudge and the CLI
        # search the primer sent the agent on taken out. A decomposition of the
        # number above, never a replacement for it.
        "retrieval_only_tokens_per_attempt": _round((tokens - overhead) / attempts),
        "tokens_per_verified_resolution": None if passes == 0 else _round(system_tokens / passes),
        "tokens_per_verified_resolution_reason": "no_verified_resolution" if passes == 0 else None,
        "outcomes": {name: sum(1 for record in records if record["outcome"] == name) for name in SCORED},
        "diagnostics": {
            # Named beside the total, never inside it.
            "auxiliary_consumer_tokens": auxiliary,
            "attempt_phase_tokens": attempt_phase_tokens(records),
            "reasoning_output_subset": reasoning,
            "reasoning_unavailable": sum(summed["unavailable"]["reasoning_output_subset"] for summed in per_attempt),
            "deliveries": sum(len(record["delivery"]["fires"]) for record in records),
            "local_legs": sum(sent for sent, _hits in locals_),
            "local_hits": sum(hits for _sent, hits in locals_),
            "child_tokens": sum(tokens for tokens, _requests in children),
            "child_requests": sum(requests for _tokens, requests in children),
            "actors": sum(len(record["actors"]) for record in records),
            "counted_in_tokens": False,
        },
    }


def amortize(tokens_per_attempt: float | None, capture: float) -> list[dict[str, Any]]:
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


def task_cost(cell: dict[str, Any], phases: tuple[str, ...], reuse: int) -> float:
    """One task's consumer tokens per attempt plus its per-producer one-time cost over `reuse` uses."""
    return cell["tokens_per_attempt"] + sum(cell["capture_per_producer"][phase] for phase in phases) / reuse


def amortize_tasks(tasks: list[dict[str, Any]], phases: tuple[str, ...]) -> list[dict[str, Any]]:
    """The arm's amortization, task-equal: each task charged its own lesson's per-producer cost, then the mean."""
    schedule: list[dict[str, Any]] = []
    for reuse in REUSE_POINTS:
        shares = [sum(cell["capture_per_producer"][phase] for phase in phases) / reuse for cell in tasks]
        schedule.append(
            {
                "reuse": reuse,
                "capture_tokens_per_use": _mean(shares),
                "tokens_per_attempt": _mean([task_cost(cell, phases, reuse) for cell in tasks]),
            }
        )
    return schedule


def paired_bootstrap(
    ratios: list[float], seed: int, resamples: int = RESAMPLES, confidence: float = CONFIDENCE
) -> dict[str, Any] | None:
    """Percentile interval for the mean per-task ratio, resampling tasks.

    Tasks are the sampling unit because tasks are the unit the reducer weighs
    equally; resampling attempts would let a task with more repeats speak
    louder, so the caller passes one ratio per task and `scipy.stats.bootstrap`
    draws over that. The pinned scipy and the manifest's own seed are what make
    one run reproduce one interval.
    """
    if not ratios:
        return None
    point = _mean(ratios)
    if len(ratios) == 1:
        low = high = None
    else:
        interval = stats.bootstrap(
            (np.asarray(ratios, dtype=float),), np.mean,
            n_resamples=resamples, confidence_level=confidence, method="percentile", rng=np.random.default_rng(seed),
        ).confidence_interval
        low, high = _round(float(interval.low)), _round(float(interval.high))
    return {
        "reason": "insufficient_independent_tasks" if len(ratios) < 2 else None,
        "method": "task_paired_percentile",
        "point": point,
        "low": low,
        "high": high,
        "tasks": len(ratios),
        "resamples": resamples,
        "confidence": confidence,
        "seed": seed,
    }


def per_task_ratio(arm: dict[str, Any], base: dict[str, Any], shared: list[str], field: str) -> tuple[float | None, str | None]:
    """The task-equal mean of one per-attempt field's ratio, or null with the reason it has none."""
    if not shared:
        return None, "no_shared_task"
    ratios: list[float] = []
    for task_id in shared:
        divisor = base["tasks"][task_id][field]
        numerator = arm["tasks"][task_id][field]
        if divisor is None or numerator is None:
            return None, "categories_unexposed"
        if not divisor:
            return None, "baseline_zero"
        ratios.append(numerator / divisor)
    return _mean(ratios), None


def completion_interval(arm: dict[str, Any], base: dict[str, Any], field: str, seed: int, *, difference: bool = False) -> dict[str, Any]:
    """Paired task bootstrap of the same ratio-of-means displayed in the overview."""
    tasks = sorted(arm["tasks"])
    result = {"method": "paired_task_ratio_of_means" if not difference else "paired_task_mean_difference",
              "point": None, "low": None, "high": None, "tasks": len(tasks),
              "confidence": CONFIDENCE, "resamples": RESAMPLES, "seed": seed, "reason": None}
    if not tasks or set(tasks) != set(base["tasks"]):
        return {**result, "reason": "incomplete_task_pairs"}
    numerator = [arm["tasks"][task][field] for task in tasks]
    denominator = [base["tasks"][task][field] for task in tasks]
    if any(value is None for value in numerator + denominator):
        return {**result, "reason": "endpoint_unavailable"}
    if not difference and statistics.fmean(denominator) <= 0:
        return {**result, "reason": "baseline_zero"}
    def estimate(left, right, axis=-1):
        return np.mean(left, axis=axis) - np.mean(right, axis=axis) if difference else np.mean(left, axis=axis) / np.mean(right, axis=axis)
    result["point"] = _round(float(estimate(numerator, denominator)))
    if len(tasks) < 2:
        return {**result, "reason": "insufficient_independent_tasks"}
    ci = stats.bootstrap((np.asarray(numerator), np.asarray(denominator)), estimate,
                         paired=True, method="percentile", n_resamples=RESAMPLES,
                         confidence_level=CONFIDENCE, rng=np.random.default_rng(seed)).confidence_interval
    return {**result, "low": _round(float(ci.low)), "high": _round(float(ci.high))}


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
    # The same ratio with each arm's nudge and CLI-search phases subtracted
    # from both sides. It answers "what did retrieval alone cost", and it is
    # labelled as a decomposition everywhere it is printed.
    retrieval: list[float] = []
    retrieval_reason = reason
    for task_id in shared:
        divisor = base["tasks"][task_id]["retrieval_only_tokens_per_attempt"]
        if not divisor:
            retrieval_reason = retrieval_reason or "baseline_zero_tokens"
            retrieval = []
            break
        retrieval.append(arm["tasks"][task_id]["retrieval_only_tokens_per_attempt"] / divisor)
    # Amortization is per lesson, task-equal like everything else: each shared
    # task's consumer tokens plus that task's per-producer one-time cost over
    # `reuse` uses, against the baseline's, then the mean of the ratios. The
    # first series charges the producer's own work too (a diagnostic); the
    # second charges only what the capture ask added, which is the headline
    # rule (pre-registered before any pilot number was read): every token the
    # capture ask added is charged to a single consumer at reuse 1, and
    # nothing of the producer's own work, which would have happened anyway.
    # The reuse-1 set of the capture-only series is bootstrapped for the
    # headline interval.
    capture_ratio: list[dict[str, Any]] = []
    capture_only: list[dict[str, Any]] = []
    headline_ratios: list[float] = []
    for phases, series in ((("producer", "capture"), capture_ratio), (("capture",), capture_only)):
        for reuse in REUSE_POINTS:
            per_task: list[float] = []
            for task_id in shared:
                divisor = task_cost(base["tasks"][task_id], phases, reuse)
                if not divisor:
                    per_task = []
                    break
                per_task.append(task_cost(arm["tasks"][task_id], phases, reuse) / divisor)
            series.append({"reuse": reuse, "token_ratio": _mean(per_task)})
            if series is capture_only and reuse == 1:
                headline_ratios = per_task
    pass_delta = (
        None
        if arm["pass_rate"] is None or base["pass_rate"] is None
        else _round(arm["pass_rate"] - base["pass_rate"])
    )
    # What the token ratio decomposes into. A removed request takes the fixed
    # preamble with it, so the ratio above tracks round trips; the new-token
    # ratio is the same arms over unique ingestion alone, and the two together
    # say whether an arm sent less or merely sent fewer times.
    request_ratio, request_reason = per_task_ratio(arm, base, shared, "requests_per_attempt")
    new_token_ratio, new_token_reason = per_task_ratio(arm, base, shared, "new_tokens_per_attempt")
    completion_tokens = completion_interval(arm, base, "tokens_per_verified_resolution", seed)
    completion_time = completion_interval(arm, base, "consumer_seconds_per_verified_resolution", seed)
    completion_rate = completion_interval(arm, base, "pass_rate", seed, difference=True)
    return {
        "completion_tokens": completion_tokens,
        "completion_time": completion_time,
        "completion_rate": completion_rate,
        "tasks": len(shared),
        "token_ratio": ratio,
        "token_ratio_reason": reason,
        "request_ratio": request_ratio,
        "request_ratio_reason": request_reason,
        "new_token_ratio": new_token_ratio,
        "new_token_ratio_reason": new_token_reason,
        "retrieval_only_token_ratio": _mean(retrieval),
        "retrieval_only_token_ratio_reason": retrieval_reason,
        "pass_rate_delta": pass_delta,
        "interval": paired_bootstrap(ratios, seed),
        "amortized_token_ratio": capture_ratio,
        "amortized_capture_only_token_ratio": capture_only,
        "headline": completion_tokens["point"],
        "headline_rule": "system_tokens_per_verified_completion_reuse_1",
        "headline_interval": completion_tokens,
        "headline_eligible": bool(arm["headline_eligible"] and base["headline_eligible"] and completion_tokens["point"] is not None),
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
    arms: dict[str, dict[str, Any]] = {arm_id: {"attempts": 0, "outcomes": {name: 0 for name in OUTCOMES}, "tasks": {}, "accounting_reasons": []} for arm_id in declared}
    invalid: list[dict[str, str]] = []
    cells: dict[tuple[str, str], list[dict[str, Any]]] = {}
    scored_by_arm: dict[str, list[dict[str, Any]]] = {}
    all_by_arm: dict[str, list[dict[str, Any]]] = {}
    for record in accepted.values():
        all_by_arm.setdefault(record["arm_id"], []).append(record)
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
        arm["phase_tokens"] = phase_tokens(scored)
        arm["producer"] = producer_summary(all_by_arm.get(arm_id, []))
        invalid_records = [record for record in all_by_arm.get(arm_id, []) if record["outcome"] == "invalid"]
        arm["invalid_observed_effort"] = {
            "tokens": sum(sum(item["input_total"] + item["output_total"] for item in record["usage"]) + consumer_auxiliary(record) for record in invalid_records),
            "agent_seconds": sum(record["agent_time_s"] for record in invalid_records if record.get("agent_time_s") is not None),
            "missing_timing": sum(record.get("agent_time_s") is None for record in invalid_records),
        }
        tasks = list(arm["tasks"].values())
        arm["tokens"] = sum(task["tokens"] for task in tasks)
        arm["pass_rate"] = _mean([task["pass_rate"] for task in tasks])
        arm["tokens_per_attempt"] = _mean([task["tokens_per_attempt"] for task in tasks])
        arm["requests_per_attempt"] = _mean([task["requests_per_attempt"] for task in tasks])
        per_new = [task["new_tokens_per_attempt"] for task in tasks]
        exposed = bool(per_new) and all(value is not None for value in per_new)
        arm["new_tokens_per_attempt"] = _mean(per_new) if exposed else None  # type: ignore[arg-type]
        arm["new_tokens_reason"] = None if exposed else "categories_unexposed"
        per_task = [task["tokens_per_verified_resolution"] for task in tasks]
        if not per_task or any(value is None for value in per_task):
            arm["tokens_per_verified_resolution"] = None
            arm["tokens_per_verified_resolution_reason"] = "no_verified_resolution"
        else:
            arm["tokens_per_verified_resolution"] = _mean(per_task)
            arm["tokens_per_verified_resolution_reason"] = None
        durations = [task["consumer_seconds_per_verified_resolution"] for task in tasks]
        arm["consumer_seconds_per_verified_resolution"] = _mean(durations) if durations and all(value is not None for value in durations) else None
        arm["consumer_seconds_reason"] = None if arm["consumer_seconds_per_verified_resolution"] is not None else ("timing_unavailable" if any(task["consumer_seconds_reason"] == "timing_unavailable" for task in tasks) else "no_verified_resolution")
        arm["system_completion_by_reuse"] = [
            {"reuse": reuse, "tokens": _mean([task["system_completion_by_reuse"][index]["tokens"] for task in tasks])
             if tasks and all(task["passes"] for task in tasks) else None}
            for index, reuse in enumerate(REUSE_POINTS)]
        arm["amortization"] = amortize_tasks(tasks, ("producer", "capture"))
        arm["amortization_capture_only"] = amortize_tasks(tasks, ("capture",))
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

