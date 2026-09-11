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


def test_the_producer_phase_and_the_capture_overhead_amortize_apart() -> None:
    producer = support.receipt("producer", "producer", "p_1", 600, 200)
    capture = support.receipt("producer", "capture", "p_2", 100, 50)
    natural = [
        support.reduction_record("t1", "on", 0, 1, 400, auxiliary=(producer, capture)),
        support.reduction_record("t2", "on", 0, 3, 400, auxiliary=(producer, capture)),
    ]
    off = [support.reduction_record("t1", "off", 0, 0, 800), support.reduction_record("t2", "off", 0, 2, 800)]
    reduction = reduce_module.reduce(support.accept(*off, *natural), [], baseline="off")
    arm = reduction["arms"]["on"]
    assert (arm["capture_tokens"], arm["phase_tokens"]) == (950, {"capture": 150, "producer": 800})
    assert [point["capture_tokens_per_use"] for point in arm["amortization"]] == [950.0, 475.0, 190.0, 95.0]
    assert [point["capture_tokens_per_use"] for point in arm["amortization_capture_only"]] == [150.0, 75.0, 30.0, 15.0]
    comparison = reduction["comparisons"]["on"]
    assert comparison["token_ratio"] == 0.5
    assert [point["token_ratio"] for point in comparison["amortized_capture_only_token_ratio"]] == [round((400 + 150) / 800, 12), round((400 + 75) / 800, 12), round((400 + 30) / 800, 12), round((400 + 15) / 800, 12)]
    assert comparison["amortized_token_ratio"][0]["token_ratio"] == round((400 + 950) / 800, 12)
    assert arm["producer"] is None
    cell = arm["tasks"]["t1"]["diagnostics"]
    assert (cell["local_legs"], cell["local_hits"], cell["child_tokens"], cell["child_requests"], cell["actors"]) == (0, 0, 0, 0, 1)


def test_amortization_charges_each_task_its_own_lesson_at_the_mean_producer_cost() -> None:
    # t1 ran three producers (one per repeat), t2 ran one; the arm-wide capture sum
    # (3 x 300 + 900 = 1800) is never what a consumer is charged.
    def producer(request: str, capture: int) -> tuple[dict, dict]:
        return support.receipt("producer", "producer", f"p_{request}", 1000, 0), support.receipt("producer", "capture", f"c_{request}", capture, 0)

    natural = [
        support.reduction_record("t1", "on", 0, 1, 400, auxiliary=producer("a", 300)),
        support.reduction_record("t1", "on", 1, 3, 400, auxiliary=producer("b", 300)),
        support.reduction_record("t1", "on", 2, 5, 400, auxiliary=producer("c", 300)),
        support.reduction_record("t2", "on", 0, 7, 400, auxiliary=producer("d", 900)),
    ]
    off = [support.reduction_record("t1", "off", 0, 0, 800), support.reduction_record("t2", "off", 0, 6, 800)]
    reduction = reduce_module.reduce(support.accept(*off, *natural), [], baseline="off")
    arm = reduction["arms"]["on"]
    assert (arm["capture_tokens"], arm["phase_tokens"]) == (4000 + 1800, {"capture": 1800, "producer": 4000})
    assert (arm["tasks"]["t1"]["producers"], arm["tasks"]["t2"]["producers"]) == (3, 1)
    assert arm["tasks"]["t1"]["capture_per_producer"] == {"capture": 300.0, "producer": 1000.0}
    assert arm["tasks"]["t2"]["capture_per_producer"] == {"capture": 900.0, "producer": 1000.0}
    # Per task at reuse 1: t1 (400 + 300) / 800, t2 (400 + 900) / 800; the arm figure is their mean.
    comparison = reduction["comparisons"]["on"]
    assert comparison["headline"] == round(((700 / 800) + (1300 / 800)) / 2, 12)
    assert comparison["amortized_capture_only_token_ratio"][3]["token_ratio"] == round(((430 / 800) + (490 / 800)) / 2, 12)
    assert comparison["amortized_token_ratio"][0]["token_ratio"] == round(((1700 / 800) + (2300 / 800)) / 2, 12)
    assert comparison["headline_interval"]["tasks"] == 2
    assert arm["amortization_capture_only"][0] == {"reuse": 1, "capture_tokens_per_use": 600.0, "tokens_per_attempt": 1000.0}
    assert arm["amortization"][0]["tokens_per_attempt"] == 2000.0
    assert reduction["arms"]["off"]["amortization"][0] == {"reuse": 1, "capture_tokens_per_use": 0.0, "tokens_per_attempt": 800.0}


def test_producer_facts_and_local_hits_are_summarised_per_arm() -> None:
    record = support.reduction_record("t1", "on", 0, 1, 400)
    record["isolation"] = {**record["isolation"], "producer": {"outcome": "pass", "capture": {"pairings": {"open": 0, "unverified": 1, "verified": 0}, "findings": 2}, "wal_live_between_phases": False}}
    other = support.reduction_record("t2", "on", 0, 3, 400, outcome="invalid")
    other["isolation"] = {**other["isolation"], "producer": {"outcome": "invalid", "capture": {"pairings": {"open": 1, "unverified": 0, "verified": 0}, "findings": 0}, "wal_live_between_phases": True}}
    seeded = support.reduction_record("t1", "seeded", 0, 0, 500)
    seeded["delivery"] = {**seeded["delivery"], "legs": [{"fire_id": "f", "stage": 0, "shelf": "local", "status": "ok", "outcome": "hit", "actor": ["claude", seeded["native_root_id"], ""]}]}
    reduction = reduce_module.reduce(support.accept(record, other, seeded), [])
    assert reduction["arms"]["on"]["producer"] == {"attempts": 2, "passes": 1, "captured": 1, "findings": 2, "invalid": 1, "wal_live": 1}
    assert reduction["arms"]["seeded"]["tasks"]["t1"]["diagnostics"]["local_hits"] == 1


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


# What a token ratio is made of: round trips, unique ingestion, and the pass rate.
#
# The arms here are the shape the 2026-09-09 four-arm run measured. Every
# request replays a 9,000-token preamble, so the arm that makes one fewer
# request spends 9,000 fewer tokens without sending one token less that the
# provider had not already been given.

PREAMBLE = 9000


@pytest.fixture
def decomposition() -> dict:
    accepted = support.accept(
        support.reduction_record("t1", "off", 0, 0, 108000, "pass", requests=8, preamble=PREAMBLE),
        support.reduction_record("t1", "on", 0, 1, 99000, "pass", requests=7, preamble=PREAMBLE),
    )
    return reduce_module.reduce(accepted, [], "off")


def test_requests_per_attempt_and_the_request_ratio_are_reported(decomposition: dict) -> None:
    assert decomposition["arms"]["off"]["requests_per_attempt"] == 8
    assert decomposition["arms"]["on"]["requests_per_attempt"] == 7
    comparison = decomposition["comparisons"]["on"]
    assert comparison["request_ratio"] == 0.875
    assert comparison["request_ratio_reason"] is None


def test_new_tokens_count_uncached_input_cache_writes_and_output_only(decomposition: dict) -> None:
    off, on = decomposition["arms"]["off"], decomposition["arms"]["on"]
    # 108,000 tokens, of which 63,000 are the preamble replayed seven times.
    assert off["tasks"]["t1"]["tokens_per_attempt"] == 108000
    assert off["new_tokens_per_attempt"] == 45000
    assert on["new_tokens_per_attempt"] == 45000
    assert off["new_tokens_reason"] is None


def test_the_token_ratio_here_is_entirely_the_removed_request(decomposition: dict) -> None:
    comparison = decomposition["comparisons"]["on"]
    # The whole 9,000-token gap is one request's replayed preamble: the
    # headline moves, and not one token of unique ingestion was saved.
    assert comparison["token_ratio"] == round(99000 / 108000, 12)
    assert comparison["new_token_ratio"] == 1.0
    assert comparison["new_token_ratio_reason"] is None
    assert comparison["pass_rate_delta"] == 0.0


def test_a_provider_that_hides_the_categories_gets_a_reason_and_not_a_zero() -> None:
    accepted = support.accept(
        support.reduction_record("t1", "off", 0, 0, 10000, "pass"),
        support.reduction_record("t1", "on", 0, 1, 8000, "pass"),
    )
    reduction = reduce_module.reduce(accepted, [], "off")
    arm = reduction["arms"]["on"]
    assert arm["tasks"]["t1"]["new_tokens"] is None
    assert arm["new_tokens_per_attempt"] is None
    assert arm["new_tokens_reason"] == "categories_unexposed"
    comparison = reduction["comparisons"]["on"]
    assert comparison["new_token_ratio"] is None
    assert comparison["new_token_ratio_reason"] == "categories_unexposed"
    # Round trips are counted whatever the provider exposes.
    assert comparison["request_ratio"] == 1.0


def test_each_task_weighs_the_same_in_both_new_figures() -> None:
    accepted = support.accept(
        support.reduction_record("big", "on", 0, 0, 108000, "pass", requests=8, preamble=PREAMBLE),
        support.reduction_record("big", "on", 1, 1, 108000, "pass", requests=8, preamble=PREAMBLE),
        support.reduction_record("small", "on", 0, 2, 30000, "pass", requests=2, preamble=PREAMBLE),
    )
    arm = reduce_module.reduce(accepted, [])["arms"]["on"]
    # Two repeats of the big task do not outweigh the one small task.
    assert arm["requests_per_attempt"] == 5
    assert arm["new_tokens_per_attempt"] == (45000 + 21000) / 2


def test_bootstrap_output_is_deterministic_for_a_frozen_seed() -> None:
    ratios = [0.62, 0.71, 0.79, 0.83]
    first = reduce_module.paired_bootstrap(ratios, 99)
    assert first == reduce_module.paired_bootstrap(ratios, 99)
    assert first != reduce_module.paired_bootstrap(ratios, 100)


@pytest.mark.parametrize("case", GOLDEN_CASES, ids=GOLDEN_IDS)
def test_the_bootstrap_states_its_method_and_brackets_its_point(case: dict) -> None:
    # The method's fields are pinned; the endpoints are not. `point` is the
    # plain mean of the ratios and owes nothing to the generator, so it is a
    # fact. `low` and `high` are the 2.5th and 97.5th resample means, and
    # pinning those froze the resampler's own draw order rather than the
    # contract: every resampling-order change would have been a fixture to
    # regenerate, which is a check that reports on itself.
    interval = reduce_module.paired_bootstrap(case["ratios"], case["seed"])
    if case["expected"] is None:
        assert interval is None
        return
    assert interval is not None
    assert {key: interval[key] for key in case["expected"]} == case["expected"]
    if len(case["ratios"]) == 1:
        assert interval["low"] is None and interval["high"] is None
        assert interval["reason"] == "insufficient_independent_tasks"
        return
    assert interval["low"] <= interval["point"] <= interval["high"]
    # A degenerate corpus resamples one value forever, so only a corpus with
    # two different ratios in it can be asked for a non-empty interval.
    assert interval["low"] < interval["high"] if len(set(case["ratios"])) > 1 else interval["low"] == interval["high"]


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
        arm = cells.setdefault(record["arm_id"], {"tokens": {}, "passes": {}, "attempts": {}, "capture": 0, "task_capture": {}, "producers": {}})
        task = record["task_id"]
        usage = sum(row["input_total"] + row["output_total"] for row in record["usage"])
        usage += sum(r["input_total"] + r["output_total"] for r in record["auxiliary"] if r["phase"] == "consumer")
        arm["tokens"][task] = arm["tokens"].get(task, 0) + usage
        arm["passes"][task] = arm["passes"].get(task, 0) + int(record["outcome"] == "pass")
        arm["attempts"][task] = arm["attempts"].get(task, 0) + 1
        arm["producers"][task] = arm["producers"].get(task, 0) + int(any(r["phase"] in ("producer", "capture") for r in record["auxiliary"]))
        arm["task_capture"][task] = arm["task_capture"].get(task, 0) + sum(r["input_total"] + r["output_total"] for r in record["auxiliary"] if r["phase"] == "capture")
        arm["capture"] += sum(r["input_total"] + r["output_total"] for r in record["auxiliary"] if r["phase"] == "capture")
    for arm in cells.values():
        # Per task: tokens per verified resolution, and tokens per attempt (the ratio's numerator and divisor).
        arm["per_task"] = {task: arm["tokens"][task] / arm["attempts"][task] for task in arm["tokens"]}
        arm["per_resolution"] = sum((arm["tokens"][task] + arm["task_capture"][task] / (arm["producers"][task] or 1) * arm["attempts"][task]) / arm["passes"][task] for task in arm["tokens"]) / len(arm["tokens"])
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
    # Amortization is per lesson: only the corpus task whose attempt carried the
    # producer and capture receipts is charged them, at its own per-producer cost,
    # so the reuse-1 ratio sits just under 1 and falls from there.
    ratios_by_reuse = {point["reuse"]: point["token_ratio"] for point in comparison["amortized_token_ratio"]}
    assert ratios_by_reuse[1] == round(0.991666666667, 12)
    assert ratios_by_reuse[10] < ratios_by_reuse[1]
    assert ratios_by_reuse[10] < 1



def test_consumer_time_per_completion_charges_failed_work_and_weights_tasks_equally() -> None:
    built = [support.reduction_record("a", "off", 0, 0, 100, "pass"), support.reduction_record("a", "off", 1, 0, 100, "fail"), support.reduction_record("b", "off", 0, 0, 100, "pass")]
    for record, seconds in zip(built, (10.0, 20.0, 50.0)):
        record["agent_time_s"] = seconds
    result = reduce_module.reduce(support.accept(*built), [], baseline="off")
    assert result["arms"]["off"]["consumer_seconds_per_verified_resolution"] == 40.0
    built[0]["agent_time_s"] = None
    result = reduce_module.reduce(support.accept(*built), [], baseline="off")
    assert result["arms"]["off"]["consumer_seconds_per_verified_resolution"] is None
    assert result["arms"]["off"]["consumer_seconds_reason"] == "timing_unavailable"


def test_completion_interval_uses_overview_ratio_not_mean_of_ratios() -> None:
    rows = [support.reduction_record("small", "off", 0, 0, 100, "pass"),
            support.reduction_record("large", "off", 0, 1, 1000, "pass"),
            support.reduction_record("small", "on", 0, 2, 200, "pass"),
            support.reduction_record("large", "on", 0, 3, 500, "pass")]
    result = reduce_module.reduce(support.accept(*rows), [], "off")
    interval = result["comparisons"]["on"]["completion_tokens"]
    assert interval["point"] == pytest.approx(700 / 1100)
    assert interval["point"] != pytest.approx((2 + 0.5) / 2)
    assert interval["low"] <= interval["point"] <= interval["high"]
    assert interval["tasks"] == 2


def test_capture_and_failed_spend_are_charged_per_completion() -> None:
    capture = (support.receipt("producer", "capture", "capture-1", 200, 100),)
    rows = [support.reduction_record("task", "on", 0, 0, 100, "pass", auxiliary=capture),
            support.reduction_record("task", "on", 1, 1, 200, "fail", auxiliary=capture)]
    arm = reduce_module.reduce(support.accept(*rows), [])["arms"]["on"]
    # The shared native capture receipt cost 300 once; failed consumer cost 200 remains.
    assert arm["tokens_per_verified_resolution"] == 600
    assert arm["system_completion_by_reuse"][1] == {"reuse": 2, "tokens": 450}


def test_unequal_task_cohorts_do_not_produce_completion_comparisons() -> None:
    rows = [support.reduction_record("a", "off", 0, 0, 100, "pass"),
            support.reduction_record("b", "off", 0, 1, 100, "pass"),
            support.reduction_record("a", "on", 0, 2, 100, "pass")]
    comparison = reduce_module.reduce(support.accept(*rows), [], "off")["comparisons"]["on"]
    assert comparison["headline"] is None
    assert comparison["completion_tokens"]["reason"] == "incomplete_task_pairs"


def test_an_empty_checkpoint_preserves_every_declared_arm() -> None:
    result = reduce_module.reduce({}, [], "off", declared_arms=[{"id": "off"}, {"id": "on"}])
    assert set(result["arms"]) == {"off", "on"}
    assert result["arms"]["off"]["attempts"] == 0
    assert result["comparisons"]["on"]["headline"] is None
    assert not result["comparisons"]["on"]["headline_eligible"]
