"""The reducer: what counts, what never counts, and how tasks are weighed.

Each case here is one line of the plan's reduction contract. The corpus cases
read the frozen fixture under `fixtures/fake/corpus/`, so a change in the
reducer that moves a published aggregate has to be an explicit edit to checked
in numbers rather than a quiet drift.
"""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from evals.benchmark import FIXTURES, manifest as manifest_module, records, reduce as reduce_module, schedule
from evals.benchmark.records import Excluded
from evals.benchmark.tests import support

CORPUS_MANIFEST = FIXTURES / "fake" / "corpus-manifest.json"
CORPUS = FIXTURES / "fake" / "corpus"
GOLDEN = FIXTURES / "fake" / "bootstrap-golden.json"


def corpus() -> tuple[manifest_module.Manifest, str, dict, list[Excluded]]:
    manifest = manifest_module.load(CORPUS_MANIFEST)
    digest = json.loads((CORPUS / "schedule.json").read_text(encoding="utf-8"))["schedule_hash"]
    accepted, excluded = records.select(CORPUS / "records", manifest.hash, digest)
    return manifest, digest, accepted, excluded


class NumeratorTest(unittest.TestCase):
    def test_failed_and_capped_task_usage_stays_in_the_numerator(self) -> None:
        cell = support.accept(
            support.reduction_record("t1", "off", 0, 0, 6000, "pass"),
            support.reduction_record("t1", "off", 1, 1, 9000, "fail"),
            support.reduction_record("t1", "off", 2, 2, 3000, "capped"),
            support.reduction_record("t1", "off", 3, 3, 2000, "interrupted"),
        )
        arm = reduce_module.reduce(cell, [])["arms"]["off"]
        task = arm["tasks"]["t1"]
        self.assertEqual(task["attempts"], 4)
        self.assertEqual(task["tokens"], 20000)
        self.assertEqual(task["outcomes"], {"pass": 1, "fail": 1, "capped": 1, "interrupted": 1})
        # One verified resolution paid for all four attempts.
        self.assertEqual(task["tokens_per_verified_resolution"], 20000)
        self.assertEqual(task["pass_rate"], 0.25)

    def test_an_infrastructure_invalid_record_never_enters_a_result_silently(self) -> None:
        accepted = support.accept(
            support.reduction_record("t1", "off", 0, 0, 6000, "pass"),
            support.reduction_record("t1", "off", 1, 1, 90000, "invalid"),
        )
        reduction = reduce_module.reduce(accepted, [Excluded("stale.json", "stale")])
        arm = reduction["arms"]["off"]
        self.assertEqual(arm["attempts"], 2)
        self.assertEqual(arm["outcomes"]["invalid"], 1)
        # Counted and named, never scored: its 90,000 tokens are not a cheap run.
        self.assertEqual(arm["tasks"]["t1"]["attempts"], 1)
        self.assertEqual(arm["tasks"]["t1"]["tokens"], 6000)
        self.assertEqual(reduction["invalid"], [{"trial_id": list(accepted)[1], "arm_id": "off", "task_id": "t1", "reason": "usage"}])
        self.assertEqual(reduction["excluded"], [{"path": "stale.json", "reason": "stale"}])

    def test_every_task_weighs_the_same_regardless_of_repeats_or_token_size(self) -> None:
        accepted = support.accept(
            # A big task with many repeats, and a small task with one.
            support.reduction_record("big", "off", 0, 0, 90000, "pass"),
            support.reduction_record("big", "off", 1, 1, 90000, "pass"),
            support.reduction_record("big", "off", 2, 2, 90000, "pass"),
            support.reduction_record("small", "off", 0, 3, 1000, "fail"),
        )
        arm = reduce_module.reduce(accepted, [])["arms"]["off"]
        self.assertEqual(arm["tokens_per_attempt"], (90000 + 1000) / 2)
        # An attempt-weighted mean would be 67,750 and a pass rate of 0.75.
        self.assertNotEqual(arm["tokens_per_attempt"], arm["tokens"] / arm["attempts"])
        self.assertEqual(arm["pass_rate"], 0.5)

    def test_pass_rate_and_token_ratio_are_separate_axes(self) -> None:
        def build(outcome: str, tokens: int) -> dict:
            return {
                **support.accept(
                    support.reduction_record("t1", "off", 0, 0, 10000, "pass"),
                    support.reduction_record("t1", "on", 0, 1, tokens, outcome),
                )
            }

        cheap_and_wrong = reduce_module.reduce(build("fail", 5000), [], "off")
        cheap_and_right = reduce_module.reduce(build("pass", 5000), [], "off")
        self.assertEqual(cheap_and_wrong["comparisons"]["on"]["token_ratio"], 0.5)
        self.assertEqual(cheap_and_right["comparisons"]["on"]["token_ratio"], 0.5)
        # Same ratio, opposite quality. Nothing folds them into one number.
        self.assertEqual(cheap_and_wrong["comparisons"]["on"]["pass_rate_delta"], -1.0)
        self.assertEqual(cheap_and_right["comparisons"]["on"]["pass_rate_delta"], 0.0)

    def test_tokens_per_verified_resolution_has_no_divide_by_zero_fiction(self) -> None:
        accepted = support.accept(
            support.reduction_record("t1", "off", 0, 0, 6000, "fail"),
            support.reduction_record("t2", "off", 0, 1, 6000, "pass"),
        )
        arm = reduce_module.reduce(accepted, [])["arms"]["off"]
        self.assertIsNone(arm["tasks"]["t1"]["tokens_per_verified_resolution"])
        self.assertEqual(arm["tasks"]["t1"]["tokens_per_verified_resolution_reason"], "no_verified_resolution")
        # One task without a resolution makes the arm figure null, not infinite
        # and not silently the other task's number.
        self.assertIsNone(arm["tokens_per_verified_resolution"])
        self.assertEqual(arm["tokens_per_verified_resolution_reason"], "no_verified_resolution")
        self.assertEqual(arm["tasks"]["t2"]["tokens_per_verified_resolution"], 6000)


class AmortizationTest(unittest.TestCase):
    def setUp(self) -> None:
        capture = (support.receipt("compressor", "capture", "aux-capture-1", 4000, 1000),)
        self.accepted = support.accept(
            support.reduction_record("t1", "off", 0, 0, 10000, "pass"),
            support.reduction_record("t1", "on", 0, 1, 8000, "pass", auxiliary=capture),
        )
        self.reduction = reduce_module.reduce(self.accepted, [], "off")

    def test_capture_cost_amortizes_at_reuse_1_2_5_and_10(self) -> None:
        arm = self.reduction["arms"]["on"]
        self.assertEqual(arm["capture_tokens"], 5000)
        # Capture leaves the per-attempt numerator and returns per use.
        self.assertEqual(arm["tokens_per_attempt"], 8000)
        self.assertEqual(
            [(point["reuse"], point["capture_tokens_per_use"], point["tokens_per_attempt"]) for point in arm["amortization"]],
            [(1, 5000, 13000), (2, 2500, 10500), (5, 1000, 9000), (10, 500, 8500)],
        )
        self.assertEqual(
            [(point["reuse"], point["token_ratio"]) for point in self.reduction["comparisons"]["on"]["amortized_token_ratio"]],
            [(1, 1.3), (2, 1.05), (5, 0.9), (10, 0.85)],
        )

    def test_the_producer_phase_and_the_capture_overhead_amortize_apart(self) -> None:
        producer = support.receipt("producer", "producer", "p_1", 600, 200)
        capture = support.receipt("producer", "capture", "p_2", 100, 50)
        natural = [
            support.reduction_record("t1", "on", 0, 1, 400, auxiliary=(producer, capture)),
            support.reduction_record("t2", "on", 0, 3, 400, auxiliary=(producer, capture)),
        ]
        off = [support.reduction_record("t1", "off", 0, 0, 800), support.reduction_record("t2", "off", 0, 2, 800)]
        reduction = reduce_module.reduce(support.accept(*off, *natural), [], baseline="off")
        arm = reduction["arms"]["on"]
        self.assertEqual((arm["capture_tokens"], arm["phase_tokens"]), (950, {"capture": 150, "producer": 800}))
        self.assertEqual([point["capture_tokens_per_use"] for point in arm["amortization"]], [950.0, 475.0, 190.0, 95.0])
        self.assertEqual([point["capture_tokens_per_use"] for point in arm["amortization_capture_only"]], [150.0, 75.0, 30.0, 15.0])
        comparison = reduction["comparisons"]["on"]
        self.assertEqual(comparison["token_ratio"], 0.5)
        self.assertEqual([point["token_ratio"] for point in comparison["amortized_capture_only_token_ratio"]], [round((400 + 150) / 800, 12), round((400 + 75) / 800, 12), round((400 + 30) / 800, 12), round((400 + 15) / 800, 12)])
        self.assertEqual(comparison["amortized_token_ratio"][0]["token_ratio"], round((400 + 950) / 800, 12))
        self.assertIsNone(arm["producer"])
        self.assertIsNone(arm["local_seed"])
        cell = arm["tasks"]["t1"]["diagnostics"]
        self.assertEqual((cell["local_legs"], cell["local_hits"], cell["child_tokens"], cell["child_requests"], cell["actors"]), (0, 0, 0, 0, 1))

    def test_amortization_charges_each_task_its_own_lesson_at_the_mean_producer_cost(self) -> None:
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
        self.assertEqual((arm["capture_tokens"], arm["phase_tokens"]), (4000 + 1800, {"capture": 1800, "producer": 4000}))
        self.assertEqual((arm["tasks"]["t1"]["producers"], arm["tasks"]["t2"]["producers"]), (3, 1))
        self.assertEqual(arm["tasks"]["t1"]["capture_per_producer"], {"capture": 300.0, "producer": 1000.0})
        self.assertEqual(arm["tasks"]["t2"]["capture_per_producer"], {"capture": 900.0, "producer": 1000.0})
        # Per task at reuse 1: t1 (400 + 300) / 800, t2 (400 + 900) / 800; the arm figure is their mean.
        comparison = reduction["comparisons"]["on"]
        self.assertEqual(comparison["headline"], round(((700 / 800) + (1300 / 800)) / 2, 12))
        self.assertEqual(comparison["amortized_capture_only_token_ratio"][3]["token_ratio"], round(((430 / 800) + (490 / 800)) / 2, 12))
        self.assertEqual(comparison["amortized_token_ratio"][0]["token_ratio"], round(((1700 / 800) + (2300 / 800)) / 2, 12))
        self.assertEqual(comparison["headline_interval"]["tasks"], 2)
        self.assertEqual(arm["amortization_capture_only"][0], {"reuse": 1, "capture_tokens_per_use": 600.0, "tokens_per_attempt": 1000.0})
        self.assertEqual(arm["amortization"][0]["tokens_per_attempt"], 2000.0)
        self.assertEqual(reduction["arms"]["off"]["amortization"][0], {"reuse": 1, "capture_tokens_per_use": 0.0, "tokens_per_attempt": 800.0})

    def test_producer_and_local_seed_facts_are_summarised_per_arm(self) -> None:
        record = support.reduction_record("t1", "on", 0, 1, 400)
        record["isolation"] = {**record["isolation"], "producer": {"outcome": "pass", "capture": {"pairings": {"open": 0, "unverified": 1, "verified": 0}, "findings": 2}, "wal_live_between_phases": False}}
        other = support.reduction_record("t2", "on", 0, 3, 400, outcome="invalid")
        other["isolation"] = {**other["isolation"], "producer": {"outcome": "invalid", "capture": {"pairings": {"open": 1, "unverified": 0, "verified": 0}, "findings": 0}, "wal_live_between_phases": True}}
        seeded = support.reduction_record("t1", "seeded", 0, 0, 500)
        seeded["isolation"] = {**seeded["isolation"], "local_seed": {"pairings": {"open": 0, "unverified": 2, "verified": 0}, "distractors": 50}}
        seeded["delivery"] = {**seeded["delivery"], "legs": [{"fire_id": "f", "stage": 0, "shelf": "local", "status": "ok", "outcome": "hit", "actor": ["claude", seeded["native_root_id"], ""]}]}
        reduction = reduce_module.reduce(support.accept(record, other, seeded), [])
        self.assertEqual(reduction["arms"]["on"]["producer"], {"attempts": 2, "passes": 1, "captured": 1, "findings": 2, "invalid": 1, "wal_live": 1})
        self.assertEqual(reduction["arms"]["seeded"]["local_seed"], {"attempts": 1, "pairings": 2, "empty": 0, "distractors": 50})
        self.assertEqual(reduction["arms"]["seeded"]["tasks"]["t1"]["diagnostics"]["local_hits"], 1)

    def test_capture_spend_is_counted_once_however_many_attempts_record_it(self) -> None:
        capture = (support.receipt("compressor", "capture", "aux-capture-1", 4000, 1000),)
        accepted = support.accept(
            support.reduction_record("t1", "on", 0, 0, 8000, "pass", auxiliary=capture),
            support.reduction_record("t1", "on", 1, 1, 8000, "pass", auxiliary=capture),
        )
        self.assertEqual(reduce_module.reduce(accepted, [])["arms"]["on"]["capture_tokens"], 5000)

    def test_consumer_phase_auxiliary_usage_is_in_the_per_attempt_numerator(self) -> None:
        observer = (support.receipt("observer", "consumer", "aux-obs-1", 400, 100),)
        accepted = support.accept(support.reduction_record("t1", "on", 0, 0, 8000, "pass", auxiliary=observer))
        task = reduce_module.reduce(accepted, [])["arms"]["on"]["tasks"]["t1"]
        self.assertEqual(task["tokens"], 8500)
        self.assertEqual(task["diagnostics"]["auxiliary_consumer_tokens"], 500)


class DoubleCountTest(unittest.TestCase):
    def test_injection_and_the_reasoning_subset_are_diagnostics_not_tokens(self) -> None:
        plain = support.accept(support.reduction_record("t1", "on", 0, 0, 9000, "pass"))
        annotated = support.accept(
            support.reduction_record("t1", "on", 0, 0, 9000, "pass", reasoning=1200, deliveries=2)
        )
        bare = reduce_module.reduce(plain, [])["arms"]["on"]["tasks"]["t1"]
        rich = reduce_module.reduce(annotated, [])["arms"]["on"]["tasks"]["t1"]
        # Injected text is already inside the consumer's input and reasoning is
        # already inside output_total. Neither may be added again.
        self.assertEqual(bare["tokens"], 9000)
        self.assertEqual(rich["tokens"], 9000)
        self.assertEqual(rich["diagnostics"]["deliveries"], 2)
        self.assertEqual(rich["diagnostics"]["reasoning_output_subset"], 1200)
        self.assertFalse(rich["diagnostics"]["counted_in_tokens"])
        self.assertIsNone(bare["diagnostics"]["reasoning_output_subset"])
        self.assertEqual(bare["diagnostics"]["reasoning_unavailable"], 1)


class AccountingTest(unittest.TestCase):
    def test_an_arm_whose_usage_is_unattributed_cannot_enter_the_headline(self) -> None:
        accepted = support.accept(
            support.reduction_record("t1", "off", 0, 0, 10000, "pass"),
            support.reduction_record("t1", "on", 0, 1, 8000, "pass", reconciliation="explained_by_side_models"),
        )
        reduction = reduce_module.reduce(accepted, [], "off")
        self.assertEqual(reduction["arms"]["off"]["accounting"], "complete")
        self.assertTrue(reduction["arms"]["off"]["headline_eligible"])
        self.assertEqual(reduction["arms"]["on"]["accounting"], "incomplete")
        self.assertEqual(reduction["arms"]["on"]["accounting_reasons"], ["explained_by_side_models"])
        self.assertFalse(reduction["arms"]["on"]["headline_eligible"])
        # The ratio is still computed and shown; it is the headline flag, not
        # the arithmetic, that refuses to trust it.
        self.assertEqual(reduction["comparisons"]["on"]["token_ratio"], 0.8)
        self.assertFalse(reduction["comparisons"]["on"]["headline_eligible"])

    def test_an_arm_that_cannot_expose_auxiliary_spend_cannot_enter_the_headline(self) -> None:
        accepted = support.accept(
            support.reduction_record("t1", "off", 0, 0, 10000, "pass"),
            support.reduction_record("t1", "on", 0, 1, 8000, "pass"),
        )
        # Same records either way: only the manifest can say whether the arm's
        # memory product is able to show what it spent.
        exposed = reduce_module.reduce(accepted, [], "off", 0, support.arm_entries(off="none", on="exposed"))
        self.assertEqual(exposed["arms"]["on"]["accounting"], "complete")
        self.assertTrue(exposed["comparisons"]["on"]["headline_eligible"])

        hidden = reduce_module.reduce(accepted, [], "off", 0, support.arm_entries(off="none", on="unexposed"))
        self.assertEqual(hidden["arms"]["on"]["accounting"], "incomplete")
        self.assertEqual(hidden["arms"]["on"]["accounting_reasons"], ["auxiliary_unexposed"])
        self.assertFalse(hidden["arms"]["on"]["headline_eligible"])
        self.assertFalse(hidden["comparisons"]["on"]["headline_eligible"])
        # The control arm is untouched, and the ratio is still reported.
        self.assertTrue(hidden["arms"]["off"]["headline_eligible"])
        self.assertEqual(hidden["comparisons"]["on"]["token_ratio"], 0.8)

    def test_a_declared_cap_is_a_named_gap_rather_than_an_incomplete_one(self) -> None:
        accepted = support.accept(
            support.reduction_record("t1", "on", 0, 0, 8000, "pass"),
            support.reduction_record("t1", "on", 1, 1, 3000, "capped", reconciliation="no_envelope"),
        )
        arm = reduce_module.reduce(accepted, [])["arms"]["on"]
        self.assertEqual(arm["accounting"], "partial_by_cap")
        self.assertTrue(arm["headline_eligible"])


class BootstrapTest(unittest.TestCase):
    def setUp(self) -> None:
        self.golden = json.loads(GOLDEN.read_text(encoding="utf-8"))

    def test_bootstrap_output_is_deterministic_for_a_frozen_seed(self) -> None:
        ratios = [0.62, 0.71, 0.79, 0.83]
        first = reduce_module.paired_bootstrap(ratios, 99)
        second = reduce_module.paired_bootstrap(ratios, 99)
        self.assertEqual(first, second)
        self.assertNotEqual(first, reduce_module.paired_bootstrap(ratios, 100))

    def test_bootstrap_output_matches_the_checked_in_golden_examples(self) -> None:
        for case in self.golden["cases"]:
            with self.subTest(case=case["name"]):
                self.assertEqual(reduce_module.paired_bootstrap(case["ratios"], case["seed"]), case["expected"])

    def test_the_interval_brackets_its_point_estimate(self) -> None:
        for case in self.golden["cases"]:
            expected = case["expected"]
            if expected is None:
                continue
            with self.subTest(case=case["name"]):
                self.assertLessEqual(expected["low"], expected["point"])
                self.assertLessEqual(expected["point"], expected["high"])


class CorpusTest(unittest.TestCase):
    """The frozen fake corpus: 12 attempts, 3 tasks, 2 arms, 2 repeats."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.manifest, cls.digest, cls.accepted, cls.excluded = corpus()
        cls.reduction = reduce_module.reduce(cls.accepted, cls.excluded, "off", cls.manifest.data["seed"], cls.manifest.arms)

    def test_the_corpus_matches_the_manifest_and_the_frozen_schedule(self) -> None:
        trials = schedule.expand(self.manifest)
        self.assertEqual(schedule.schedule_hash(trials), self.digest)
        self.assertEqual(len(self.accepted), 12)
        self.assertEqual(sorted(self.accepted), sorted(trial.trial_id for trial in trials))
        for record in self.accepted.values():
            records.validate(record)

    def test_stale_partial_and_foreign_files_are_excluded_with_a_reason(self) -> None:
        self.assertEqual(sorted(item.reason for item in self.excluded), ["foreign", "partial", "stale"])

    def test_the_corpus_reduces_to_frozen_task_equal_aggregates(self) -> None:
        off, on = self.reduction["arms"]["off"], self.reduction["arms"]["on"]
        # The treatment arm declares `auxiliary_usage: exposed` and backs it
        # with receipts, so its only named gap is the declared cap.
        self.assertEqual([off["accounting"], on["accounting"]], ["partial_by_cap", "partial_by_cap"])
        self.assertEqual(on["accounting_reasons"], [])
        self.assertTrue(self.reduction["comparisons"]["on"]["headline_eligible"])
        self.assertEqual({task: cell["tokens"] for task, cell in off["tasks"].items()}, {"answer-file": 20000, "budget-guard": 24000, "slug-rename": 12000})
        self.assertEqual({task: cell["tokens"] for task, cell in on["tasks"].items()}, {"answer-file": 17000, "budget-guard": 9500, "slug-rename": 10000})
        self.assertEqual(off["tokens_per_verified_resolution"], 15333.333333333334)
        self.assertEqual(on["tokens_per_verified_resolution"], 9333.333333333334)
        self.assertEqual(on["capture_tokens"], 5000)

    def test_the_corpus_comparison_reports_a_ratio_with_an_interval(self) -> None:
        comparison = self.reduction["comparisons"]["on"]
        self.assertEqual(comparison["token_ratio"], 0.825)
        self.assertEqual(comparison["interval"]["tasks"], 3)
        self.assertEqual(comparison["interval"]["seed"], self.manifest.data["seed"])
        self.assertLessEqual(comparison["interval"]["low"], 0.825)
        self.assertLessEqual(0.825, comparison["interval"]["high"])
        # Cheaper per attempt and more often right, on two separate axes.
        self.assertGreater(comparison["pass_rate_delta"], 0)
        # Amortization is per lesson: only the corpus task whose attempt carried the
        # producer and capture receipts is charged them, at its own per-producer cost,
        # so the reuse-1 ratio sits just under 1 and falls from there.
        ratios = {point["reuse"]: point["token_ratio"] for point in comparison["amortized_token_ratio"]}
        self.assertEqual(ratios[1], round(0.991666666667, 12))
        self.assertLess(ratios[10], ratios[1])
        self.assertLess(ratios[10], 1)


if __name__ == "__main__":
    unittest.main()
