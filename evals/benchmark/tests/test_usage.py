"""UsageRecord contract: arithmetic, null versus zero, dedupe, receipts, totals."""

from __future__ import annotations

import unittest

from evals.benchmark import usage
from evals.benchmark.usage import AuxiliaryReceipt, UsageError, UsageRecord

ACTOR = ("claude", "sess", "")
CHILD = ("claude", "sess", "child01")


def record(request: str = "req_1", actor: tuple[str, str, str] = ACTOR, **overrides: object) -> UsageRecord:
    fields = {
        "adapter": "claude_jsonl",
        "adapter_version": "1",
        "trial_id": "trial",
        "actor_key": actor,
        "native_request_id": request,
        "input_total": 1204,
        "uncached_input": 4,
        "cache_read": 0,
        "cache_write": 1200,
        "output_total": 180,
        "reasoning_output_subset": None,
        "provider_total": None,
        "native_request_cost": None,
        "completion_state": "complete",
        "source_hash": "sha256:row",
    }
    fields.update(overrides)
    built = UsageRecord(**fields)  # type: ignore[arg-type]
    built.validate()
    return built


class ArithmeticTest(unittest.TestCase):
    def test_subsets_are_validated_before_any_sum(self) -> None:
        cases = {
            "input categories": {"uncached_input": 5},
            "exposed inputs exceed total": {"cache_read": None, "cache_write": 1300},
            "reasoning exceeds output": {"reasoning_output_subset": 181},
            "provider total below observed": {"provider_total": 100},
            "negative count": {"output_total": -1},
            "boolean count": {"input_total": True},
            "unknown state": {"completion_state": "done"},
            "bad actor": {"actor_key": ("claude", "sess", "bad id")},
            "unknown harness": {"actor_key": ("codex", "sess", "")},
        }
        for name, overrides in cases.items():
            with self.subTest(name), self.assertRaises(UsageError):
                record(**overrides)

    def test_null_means_not_exposed_and_partial_arithmetic_still_holds(self) -> None:
        hidden = record(cache_read=None, cache_write=None, input_total=4)
        self.assertIsNone(hidden.cache_read)
        self.assertEqual(hidden.total, 184)
        exposed = record(cache_read=None, input_total=1204)
        self.assertEqual(exposed.input_total, 1204)

    def test_json_round_trip_validates(self) -> None:
        payload = record().to_json()
        self.assertEqual(payload["actor_key"], ["claude", "sess", ""])
        self.assertEqual(usage.from_json(payload), record())
        with self.assertRaises(UsageError):
            usage.from_json({**payload, "extra": 1})
        with self.assertRaises(UsageError):
            usage.from_json({**payload, "cache_read": 0, "cache_write": 0, "uncached_input": 0})


class DedupeTest(unittest.TestCase):
    def test_identical_echo_collapses_to_one(self) -> None:
        first = record()
        echo = record(source_hash="sha256:other-line")
        self.assertEqual(usage.dedupe([first, echo]), [first])

    def test_conflicting_records_for_one_request_fail(self) -> None:
        with self.assertRaises(UsageError) as caught:
            usage.dedupe([record(), record(output_total=181)])
        self.assertEqual(caught.exception.code, "conflicting_records")

    def test_one_request_under_two_actors_fails(self) -> None:
        with self.assertRaises(UsageError) as caught:
            usage.dedupe([record(), record(actor=CHILD)])
        self.assertEqual(caught.exception.code, "duplicate_request")

    def test_auxiliary_receipts_must_not_duplicate_native_ids(self) -> None:
        receipt = AuxiliaryReceipt("trial", "observer", "capture", "aux_1", 10, 5, "sha256:aux")
        usage.check_receipts([receipt], [record()])
        with self.assertRaises(UsageError) as caught:
            usage.check_receipts([receipt, receipt], [record()])
        self.assertEqual(caught.exception.code, "duplicate_request")
        with self.assertRaises(UsageError):
            usage.check_receipts([AuxiliaryReceipt("trial", "observer", "capture", "req_1", 10, 5, "sha256:aux")], [record()])
        with self.assertRaises(UsageError):
            usage.receipt_from_json({"trial_id": "trial"})


class TotalsTest(unittest.TestCase):
    def test_totals_keep_null_distinct_from_zero(self) -> None:
        zeros = record("req_1", cache_read=0, cache_write=0, uncached_input=1204)
        hidden = record("req_2", cache_read=None, cache_write=None, uncached_input=4, input_total=4)
        summary = usage.totals([zeros, hidden])
        self.assertEqual(summary["requests"], 2)
        self.assertEqual(summary["input_total"], 1208)
        self.assertEqual(summary["total"], 1208 + 360)
        self.assertIsNone(summary["cache_read"])
        self.assertIsNone(summary["cache_write"])
        self.assertEqual(summary["uncached_input"], 1208)
        self.assertEqual(summary["unavailable"], {"uncached_input": 0, "cache_read": 1, "cache_write": 1, "reasoning_output_subset": 2})
        all_exposed = usage.totals([zeros, record("req_3", reasoning_output_subset=20)])
        self.assertEqual(all_exposed["cache_read"], 0)
        self.assertIsNone(all_exposed["reasoning_output_subset"])

    def test_totals_count_partial_records_and_dedupe_first(self) -> None:
        partial = record("req_9", completion_state="partial")
        summary = usage.totals([record(), record(source_hash="sha256:echo"), partial])
        self.assertEqual(summary["requests"], 2)
        self.assertEqual(summary["partial"], 1)


if __name__ == "__main__":
    unittest.main()
