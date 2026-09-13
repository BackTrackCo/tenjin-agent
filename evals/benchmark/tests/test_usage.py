"""UsageRecord contract: arithmetic, null versus zero, dedupe, receipts, totals."""

from __future__ import annotations

import pytest

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


@pytest.mark.parametrize(
    "overrides",
    [
        pytest.param({"uncached_input": 5}, id="input categories"),
        pytest.param({"cache_read": None, "cache_write": 1300}, id="exposed inputs exceed total"),
        pytest.param({"reasoning_output_subset": 181}, id="reasoning exceeds output"),
        pytest.param({"provider_total": 100}, id="provider total below observed"),
        pytest.param({"output_total": -1}, id="negative count"),
        pytest.param({"input_total": True}, id="boolean count"),
        pytest.param({"completion_state": "done"}, id="unknown state"),
        pytest.param({"actor_key": ("claude", "sess", "bad id")}, id="bad actor"),
        pytest.param({"actor_key": ("unknown", "sess", "")}, id="unknown harness"),
    ],
)
def test_subsets_are_validated_before_any_sum(overrides: dict) -> None:
    with pytest.raises(UsageError):
        record(**overrides)


def test_null_means_not_exposed_and_partial_arithmetic_still_holds() -> None:
    hidden = record(cache_read=None, cache_write=None, input_total=4)
    assert hidden.cache_read is None
    assert hidden.total == 184
    assert record(cache_read=None, input_total=1204).input_total == 1204


def test_json_round_trip_validates() -> None:
    payload = record().to_json()
    assert payload["actor_key"] == ["claude", "sess", ""]
    assert usage.from_json(payload) == record()
    with pytest.raises(UsageError):
        usage.from_json({**payload, "extra": 1})
    with pytest.raises(UsageError):
        usage.from_json({**payload, "cache_read": 0, "cache_write": 0, "uncached_input": 0})


def test_identical_echo_collapses_to_one() -> None:
    first = record()
    assert usage.dedupe([first, record(source_hash="sha256:other-line")]) == [first]


def test_conflicting_records_for_one_request_fail() -> None:
    with pytest.raises(UsageError) as caught:
        usage.dedupe([record(), record(output_total=181)])
    assert caught.value.code == "conflicting_records"


def test_one_request_under_two_actors_fails() -> None:
    with pytest.raises(UsageError) as caught:
        usage.dedupe([record(), record(actor=CHILD)])
    assert caught.value.code == "duplicate_request"


def test_auxiliary_receipts_must_not_duplicate_native_ids() -> None:
    receipt = AuxiliaryReceipt("trial", "observer", "capture", "aux_1", 10, 5, "sha256:aux")
    usage.check_receipts([receipt], [record()])
    with pytest.raises(UsageError) as caught:
        usage.check_receipts([receipt, receipt], [record()])
    assert caught.value.code == "duplicate_request"
    with pytest.raises(UsageError):
        usage.check_receipts([AuxiliaryReceipt("trial", "observer", "capture", "req_1", 10, 5, "sha256:aux")], [record()])
    with pytest.raises(UsageError):
        usage.receipt_from_json({"trial_id": "trial"})


def test_totals_keep_null_distinct_from_zero() -> None:
    zeros = record("req_1", cache_read=0, cache_write=0, uncached_input=1204)
    hidden = record("req_2", cache_read=None, cache_write=None, uncached_input=4, input_total=4)
    summary = usage.totals([zeros, hidden])
    assert summary["requests"] == 2
    assert summary["input_total"] == 1208
    assert summary["total"] == 1208 + 360
    assert summary["cache_read"] is None
    assert summary["cache_write"] is None
    assert summary["uncached_input"] == 1208
    assert summary["unavailable"] == {"uncached_input": 0, "cache_read": 1, "cache_write": 1, "reasoning_output_subset": 2}
    all_exposed = usage.totals([zeros, record("req_3", reasoning_output_subset=20)])
    assert all_exposed["cache_read"] == 0
    assert all_exposed["reasoning_output_subset"] is None


def test_totals_count_partial_records_and_dedupe_first() -> None:
    partial = record("req_9", completion_state="partial")
    summary = usage.totals([record(), record(source_hash="sha256:echo"), partial])
    assert summary["requests"] == 2
    assert summary["partial"] == 1
