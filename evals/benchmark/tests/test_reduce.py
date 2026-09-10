"""The reducer: what counts, what never counts, and how tasks are weighed.

Each case here is one line of the plan's reduction contract. The corpus cases
read the shared fake corpus and recompute the contract's arithmetic beside the
reducer's own output, so a regenerated corpus moves both sides together and
only a reducer change can open a gap.
"""

from __future__ import annotations

import json
from typing import Any

import pytest
from inline_snapshot import snapshot

from evals.benchmark import FIXTURES, records, reduce as reduce_module, schedule
from evals.benchmark.records import Excluded
from evals.benchmark.tests import support

GOLDEN = json.loads((FIXTURES / "fake" / "bootstrap-golden.json").read_text(encoding="utf-8"))
GOLDEN_CASES = GOLDEN["cases"]
GOLDEN_IDS = [case["name"] for case in GOLDEN_CASES]


def test_failed_and_capped_task_usage_stays_in_the_numerator() -> None:
    cell = support.accept(
        support.reduction_record("t1", "off", 0, 0, 6000, "pass"),
        support.reduction_record("t1", "off", 1, 1, 9000, "fail"),
        support.reduction_record("t1", "off", 2, 2, 3000, "capped"),
        support.reduction_record("t1", "off", 3, 3, 2000, "interrupted"),
    )
    task = reduce_module.reduce(cell, [])["arms"]["off"]["tasks"]["t1"]
    assert task["attempts"] == 4
    assert task["tokens"] == 20000
    assert task["outcomes"] == {"pass": 1, "fail": 1, "capped": 1, "interrupted": 1}
    # One verified resolution paid for all four attempts.
    assert task["tokens_per_verified_resolution"] == 20000
    assert task["pass_rate"] == 0.25


def test_an_infrastructure_invalid_record_never_enters_a_result_silently() -> None:
    accepted = support.accept(
        support.reduction_record("t1", "off", 0, 0, 6000, "pass"),
        support.reduction_record("t1", "off", 1, 1, 90000, "invalid"),
    )
    reduction = reduce_module.reduce(accepted, [Excluded("stale.json", "stale")])
    arm = reduction["arms"]["off"]
    assert arm["attempts"] == 2
    assert arm["outcomes"]["invalid"] == 1
    # Counted and named, never scored: its 90,000 tokens are not a cheap run.
    assert arm["tasks"]["t1"]["attempts"] == 1
    assert arm["tasks"]["t1"]["tokens"] == 6000
    assert reduction["invalid"] == [{"trial_id": list(accepted)[1], "arm_id": "off", "task_id": "t1", "reason": "usage"}]
    assert reduction["excluded"] == [{"path": "stale.json", "reason": "stale"}]


def test_round_trips_are_reported_per_attempt_beside_the_token_total() -> None:
    """Requests per attempt is what the corpus readout calls a task's discovery cost."""
    accepted = support.accept(
        support.reduction_record("t1", "off", 0, 0, 6000, "pass"),
        support.reduction_record("t1", "off", 1, 1, 9000, "fail"),
        # Named and never scored, so it moves neither the count nor the divisor.
        support.reduction_record("t1", "off", 2, 2, 3000, "invalid"),
    )
    cell = reduce_module.reduce(accepted, [])["arms"]["off"]["tasks"]["t1"]
    # One usage row per attempt in this builder, so two attempts are two requests.
    assert (cell["requests"], cell["attempts"]) == (2, 2)
    assert cell["requests_per_attempt"] == 1.0


def test_every_task_weighs_the_same_regardless_of_repeats_or_token_size() -> None:
    accepted = support.accept(
        # A big task with many repeats, and a small task with one.
        support.reduction_record("big", "off", 0, 0, 90000, "pass"),
        support.reduction_record("big", "off", 1, 1, 90000, "pass"),
        support.reduction_record("big", "off", 2, 2, 90000, "pass"),
        support.reduction_record("small", "off", 0, 3, 1000, "fail"),
    )
    arm = reduce_module.reduce(accepted, [])["arms"]["off"]
    assert arm["tokens_per_attempt"] == (90000 + 1000) / 2
    # An attempt-weighted mean would be 67,750 and a pass rate of 0.75.
    assert arm["tokens_per_attempt"] != arm["tokens"] / arm["attempts"]
    assert arm["pass_rate"] == 0.5


def test_pass_rate_and_token_ratio_are_separate_axes() -> None:
    def build(outcome: str, tokens: int) -> dict:
        return support.accept(
            support.reduction_record("t1", "off", 0, 0, 10000, "pass"),
            support.reduction_record("t1", "on", 0, 1, tokens, outcome),
        )

    cheap_and_wrong = reduce_module.reduce(build("fail", 5000), [], "off")
    cheap_and_right = reduce_module.reduce(build("pass", 5000), [], "off")
    assert cheap_and_wrong["comparisons"]["on"]["token_ratio"] == 0.5
    assert cheap_and_right["comparisons"]["on"]["token_ratio"] == 0.5
    # Same ratio, opposite quality. Nothing folds them into one number.
    assert cheap_and_wrong["comparisons"]["on"]["pass_rate_delta"] == -1.0
    assert cheap_and_right["comparisons"]["on"]["pass_rate_delta"] == 0.0


def test_tokens_per_verified_resolution_has_no_divide_by_zero_fiction() -> None:
    accepted = support.accept(
        support.reduction_record("t1", "off", 0, 0, 6000, "fail"),
        support.reduction_record("t2", "off", 0, 1, 6000, "pass"),
    )
    arm = reduce_module.reduce(accepted, [])["arms"]["off"]
    assert arm["tasks"]["t1"]["tokens_per_verified_resolution"] is None
    assert arm["tasks"]["t1"]["tokens_per_verified_resolution_reason"] == "no_verified_resolution"
    # One task without a resolution makes the arm figure null, not infinite
    # and not silently the other task's number.
    assert arm["tokens_per_verified_resolution"] is None
    assert arm["tokens_per_verified_resolution_reason"] == "no_verified_resolution"
    assert arm["tasks"]["t2"]["tokens_per_verified_resolution"] == 6000


@pytest.fixture
def amortized() -> dict:
    capture = (support.receipt("compressor", "capture", "aux-capture-1", 4000, 1000),)
    accepted = support.accept(
        support.reduction_record("t1", "off", 0, 0, 10000, "pass"),
        support.reduction_record("t1", "on", 0, 1, 8000, "pass", auxiliary=capture),
    )
    return reduce_module.reduce(accepted, [], "off")


def test_capture_cost_amortizes_at_reuse_1_2_5_and_10(amortized: dict) -> None:
    arm = amortized["arms"]["on"]
    assert arm["capture_tokens"] == 5000
    # Capture leaves the per-attempt numerator and returns per use.
    assert arm["tokens_per_attempt"] == 8000
    assert [(point["reuse"], point["capture_tokens_per_use"], point["tokens_per_attempt"]) for point in arm["amortization"]] == snapshot(
        [
            (1, 5000, 13000),
            (2, 2500, 10500),
            (5, 1000, 9000),
            (10, 500, 8500),
        ]
    )
    assert [(point["reuse"], point["token_ratio"]) for point in amortized["comparisons"]["on"]["amortized_token_ratio"]] == snapshot(
        [
            (1, 1.3),
            (2, 1.05),
            (5, 0.9),
            (10, 0.85),
        ]
    )


def test_capture_spend_is_counted_once_however_many_attempts_record_it() -> None:
    capture = (support.receipt("compressor", "capture", "aux-capture-1", 4000, 1000),)
    accepted = support.accept(
        support.reduction_record("t1", "on", 0, 0, 8000, "pass", auxiliary=capture),
        support.reduction_record("t1", "on", 1, 1, 8000, "pass", auxiliary=capture),
    )
    assert reduce_module.reduce(accepted, [])["arms"]["on"]["capture_tokens"] == 5000


def test_consumer_phase_auxiliary_usage_is_in_the_per_attempt_numerator() -> None:
    observer = (support.receipt("observer", "consumer", "aux-obs-1", 400, 100),)
    accepted = support.accept(support.reduction_record("t1", "on", 0, 0, 8000, "pass", auxiliary=observer))
    task = reduce_module.reduce(accepted, [])["arms"]["on"]["tasks"]["t1"]
    assert task["tokens"] == 8500
    assert task["diagnostics"]["auxiliary_consumer_tokens"] == 500


def test_injection_and_the_reasoning_subset_are_diagnostics_not_tokens() -> None:
    plain = support.accept(support.reduction_record("t1", "on", 0, 0, 9000, "pass"))
    annotated = support.accept(support.reduction_record("t1", "on", 0, 0, 9000, "pass", reasoning=1200, deliveries=2))
    bare = reduce_module.reduce(plain, [])["arms"]["on"]["tasks"]["t1"]
    rich = reduce_module.reduce(annotated, [])["arms"]["on"]["tasks"]["t1"]
    # Injected text is already inside the consumer's input and reasoning is
    # already inside output_total. Neither may be added again.
    assert bare["tokens"] == 9000
    assert rich["tokens"] == 9000
    assert rich["diagnostics"]["deliveries"] == 2
    assert rich["diagnostics"]["reasoning_output_subset"] == 1200
    assert not rich["diagnostics"]["counted_in_tokens"]
    assert bare["diagnostics"]["reasoning_output_subset"] is None
    assert bare["diagnostics"]["reasoning_unavailable"] == 1


def test_an_arm_whose_usage_is_unattributed_cannot_enter_the_headline() -> None:
    accepted = support.accept(
        support.reduction_record("t1", "off", 0, 0, 10000, "pass"),
        support.reduction_record("t1", "on", 0, 1, 8000, "pass", reconciliation="explained_by_side_models"),
    )
    reduction = reduce_module.reduce(accepted, [], "off")
    assert reduction["arms"]["off"]["accounting"] == "complete"
    assert reduction["arms"]["off"]["headline_eligible"]
    assert reduction["arms"]["on"]["accounting"] == "incomplete"
    assert reduction["arms"]["on"]["accounting_reasons"] == ["explained_by_side_models"]
    assert not reduction["arms"]["on"]["headline_eligible"]
    # The ratio is still computed and shown; it is the headline flag, not
    # the arithmetic, that refuses to trust it.
    assert reduction["comparisons"]["on"]["token_ratio"] == 0.8
    assert not reduction["comparisons"]["on"]["headline_eligible"]


def test_an_arm_that_cannot_expose_auxiliary_spend_cannot_enter_the_headline() -> None:
    accepted = support.accept(
        support.reduction_record("t1", "off", 0, 0, 10000, "pass"),
        support.reduction_record("t1", "on", 0, 1, 8000, "pass"),
    )
    # Same records either way: only the manifest can say whether the arm's
    # memory product is able to show what it spent.
    exposed = reduce_module.reduce(accepted, [], "off", 0, support.arm_entries(off="none", on="exposed"))
    assert exposed["arms"]["on"]["accounting"] == "complete"
    assert exposed["comparisons"]["on"]["headline_eligible"]

    hidden = reduce_module.reduce(accepted, [], "off", 0, support.arm_entries(off="none", on="unexposed"))
    assert hidden["arms"]["on"]["accounting"] == "incomplete"
    assert hidden["arms"]["on"]["accounting_reasons"] == ["auxiliary_unexposed"]
    assert not hidden["arms"]["on"]["headline_eligible"]
    assert not hidden["comparisons"]["on"]["headline_eligible"]
    # The control arm is untouched, and the ratio is still reported.
    assert hidden["arms"]["off"]["headline_eligible"]
    assert hidden["comparisons"]["on"]["token_ratio"] == 0.8


def test_a_declared_cap_is_a_named_gap_rather_than_an_incomplete_one() -> None:
    accepted = support.accept(
        support.reduction_record("t1", "on", 0, 0, 8000, "pass"),
        support.reduction_record("t1", "on", 1, 1, 3000, "capped", reconciliation="no_envelope"),
    )
    arm = reduce_module.reduce(accepted, [])["arms"]["on"]
    assert arm["accounting"] == "partial_by_cap"
    assert arm["headline_eligible"]


def test_bootstrap_output_is_deterministic_for_a_frozen_seed() -> None:
    ratios = [0.62, 0.71, 0.79, 0.83]
    first = reduce_module.paired_bootstrap(ratios, 99)
    assert first == reduce_module.paired_bootstrap(ratios, 99)
    assert first != reduce_module.paired_bootstrap(ratios, 100)


@pytest.mark.parametrize("case", GOLDEN_CASES, ids=GOLDEN_IDS)
def test_bootstrap_output_matches_the_checked_in_golden_examples(case: dict) -> None:
    # Byte-identical on purpose: the golden is the reducer's pre-registration freeze of the interval method.
    assert reduce_module.paired_bootstrap(case["ratios"], case["seed"]) == case["expected"]


@pytest.mark.parametrize("case", GOLDEN_CASES, ids=GOLDEN_IDS)
def test_the_interval_brackets_its_point_estimate(case: dict) -> None:
    expected = case["expected"]
    if expected is None:
        pytest.skip("no interval for this case")
    assert expected["low"] <= expected["point"]
    assert expected["point"] <= expected["high"]


# A built fake corpus: 12 attempts, 3 tasks, 2 arms, 2 repeats.


@pytest.fixture(scope="module")
def reduction(corpus) -> dict:
    manifest, _digest, accepted, excluded = corpus
    return reduce_module.reduce(accepted, excluded, "off", manifest.data["seed"], manifest.arms)


def expected_cells(accepted: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """The contract's arithmetic applied by hand to the corpus: scored attempts' usage plus consumer receipts per task, capture receipts apart."""
    cells: dict[str, dict[str, Any]] = {}
    for record in accepted.values():
        if record["outcome"] == "invalid":
            continue
        arm = cells.setdefault(record["arm_id"], {"tokens": {}, "passes": {}, "attempts": {}, "capture": 0})
        task = record["task_id"]
        usage = sum(row["input_total"] + row["output_total"] for row in record["usage"])
        usage += sum(r["input_total"] + r["output_total"] for r in record["auxiliary"] if r["phase"] == "consumer")
        arm["tokens"][task] = arm["tokens"].get(task, 0) + usage
        arm["passes"][task] = arm["passes"].get(task, 0) + int(record["outcome"] == "pass")
        arm["attempts"][task] = arm["attempts"].get(task, 0) + 1
        arm["capture"] += sum(r["input_total"] + r["output_total"] for r in record["auxiliary"] if r["phase"] == "capture")
    for arm in cells.values():
        # Per task: tokens per verified resolution, and tokens per attempt (the ratio's numerator and divisor).
        arm["per_task"] = {task: arm["tokens"][task] / arm["attempts"][task] for task in arm["tokens"]}
        arm["per_resolution"] = sum(arm["tokens"][task] / arm["passes"][task] for task in arm["tokens"]) / len(arm["tokens"])
    return cells


def test_the_corpus_matches_the_manifest_and_its_schedule(corpus) -> None:
    manifest, digest, accepted, _excluded = corpus
    # Re-expanding the manifest reproduces the schedule its records were written under.
    trials = schedule.expand(manifest)
    assert schedule.schedule_hash(trials) == digest
    assert len(accepted) == len(trials)
    assert sorted(accepted) == sorted(trial.trial_id for trial in trials)
    for record in accepted.values():
        records.validate(record)


def test_stale_partial_and_foreign_files_are_excluded_with_a_reason(corpus) -> None:
    _manifest, _digest, _accepted, excluded = corpus
    assert sorted(item.reason for item in excluded) == ["foreign", "partial", "stale"]


def test_the_corpus_reduces_to_task_equal_aggregates(corpus, reduction: dict) -> None:
    _manifest, _digest, accepted, _excluded = corpus
    off, on = reduction["arms"]["off"], reduction["arms"]["on"]
    # The treatment arm declares `auxiliary_usage: exposed` and backs it
    # with receipts, so its only named gap is the declared cap.
    assert [off["accounting"], on["accounting"]] == ["partial_by_cap", "partial_by_cap"]
    assert on["accounting_reasons"] == []
    assert reduction["comparisons"]["on"]["headline_eligible"]
    # The aggregates are recomputed from the corpus records here, so a corpus regeneration
    # moves both sides together and only a reducer change can open a gap.
    expected = expected_cells(accepted)
    assert {task: cell["tokens"] for task, cell in off["tasks"].items()} == expected["off"]["tokens"]
    assert {task: cell["tokens"] for task, cell in on["tasks"].items()} == expected["on"]["tokens"]
    assert off["tokens_per_verified_resolution"] == pytest.approx(expected["off"]["per_resolution"])
    assert on["tokens_per_verified_resolution"] == pytest.approx(expected["on"]["per_resolution"])
    assert on["capture_tokens"] == expected["on"]["capture"]


def test_the_corpus_comparison_reports_a_ratio_with_an_interval(corpus, reduction: dict) -> None:
    manifest, _digest, accepted, _excluded = corpus
    comparison = reduction["comparisons"]["on"]
    expected = expected_cells(accepted)
    ratios = [expected["on"]["per_task"][task] / expected["off"]["per_task"][task] for task in sorted(expected["off"]["per_task"])]
    assert comparison["token_ratio"] == pytest.approx(sum(ratios) / len(ratios))
    assert comparison["interval"]["tasks"] == len(ratios)
    assert comparison["interval"]["seed"] == manifest.data["seed"]
    assert comparison["interval"]["low"] <= comparison["token_ratio"]
    assert comparison["token_ratio"] <= comparison["interval"]["high"]
    # Cheaper per attempt and more often right, on two separate axes.
    assert comparison["pass_rate_delta"] > 0
    # Capture only pays for itself once the knowledge is reused.
    ratios_by_reuse = {point["reuse"]: point["token_ratio"] for point in comparison["amortized_token_ratio"]}
    assert ratios_by_reuse[1] > 1
    assert ratios_by_reuse[10] < 1
