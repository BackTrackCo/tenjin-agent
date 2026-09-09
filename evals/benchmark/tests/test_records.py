"""Immutable attempt records: publish without overwrite, validate, select on resume."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from evals.benchmark import claude_usage, records
from evals.benchmark.records import RecordError
from evals.benchmark.tests.support import attempt_record, parse

UNRECONCILED = ("mismatch", "envelope_without_usage", "unparsed", "no_envelope", "envelope_partial")
RECONCILED = ("matched", "matched_with_descendants", "explained_by_side_models")


def contradictions(base: dict) -> dict[str, dict]:
    """One valid record, bent one way per case, each way a validator refuses."""
    actor = base["actors"][1]
    return {
        "unknown key": {**base, "extra": 1},
        "missing key": {key: value for key, value in base.items() if key != "delivery"},
        "wrong schema": {**base, "schema": "bench1.attempt.v0"},
        "forged trial id": {**base, "trial_id": "abc"},
        "unknown outcome": {**base, "outcome": "maybe"},
        "unknown stop": {**base, "stop_reason": "crash"},
        "pass without verifier": {**base, "verifier": None},
        "lead missing": {**base, "actors": base["actors"][1:]},
        "actor twice": {**base, "actors": base["actors"] + [base["actors"][0]]},
        "parent without provenance": {**base, "actors": [base["actors"][0], {**actor, "parent_provenance": "unavailable"}] + base["actors"][2:]},
        "provenance without parent": {**base, "actors": [{**base["actors"][0], "parent_provenance": "native"}] + base["actors"][1:]},
        "parent outside attempt": {**base, "actors": [base["actors"][0], {**actor, "parent_actor_key": ["claude", "sess-family", "ghost"]}] + base["actors"][2:]},
        "edge outside attempt": {**base, "parent_edges": [{"child": ["claude", "sess-family", "ghost"], "parent": ["claude", "sess-family", ""], "provenance": "native"}]},
        "edge unavailable": {**base, "parent_edges": [{**base["parent_edges"][0], "provenance": "unavailable"}]},
        "usage outside attempt": {**base, "usage": [{**base["usage"][0], "actor_key": ["claude", "sess-family", "ghost"]}]},
        "usage other trial": {**base, "usage": [{**base["usage"][0], "trial_id": "other"}]},
        "usage duplicated": {**base, "usage": base["usage"] + [base["usage"][0]]},
        "usage conflicting": {**base, "usage": base["usage"] + [{**base["usage"][0], "output_total": 1}]},
        "receipt duplicates native id": {**base, "auxiliary": [{"trial_id": base["trial_id"], "component": "observer", "phase": "capture", "native_request_id": "req_101", "input_total": 1, "output_total": 1, "source_hash": "sha256:x"}]},
        "receipt other trial": {**base, "auxiliary": [{"trial_id": "other", "component": "observer", "phase": "capture", "native_request_id": "aux_1", "input_total": 1, "output_total": 1, "source_hash": "sha256:x"}]},
        "delivery status": {**base, "delivery": {**base["delivery"], "status": "guessed"}},
        "fire outside attempt": {**base, "delivery": {**base["delivery"], "status": "joined", "fires": [{"fire_id": "f", "actor": ["claude", "sess-family", "ghost"]}]}},
        "negative wall time": {**base, "wall_time_s": -1},
        "bad turns": {**base, "turns": "two"},
        "sentinel count": {**base, "sentinel": {"public_requests": None}},
        "reconciliation shape": {**base, "usage_reconciliation": {}},
    }


CONTRADICTIONS = contradictions(attempt_record(parse("sess-family")))


def test_complete_record_validates(family_session: claude_usage.SessionUsage) -> None:
    record = attempt_record(family_session)
    records.validate(record)
    assert len(record["actors"]) == 5
    assert len(record["parent_edges"]) == 4
    assert record["usage_reconciliation"]["status"] == "matched_with_descendants"


def test_invalid_attempt_needs_a_reason_and_only_then(root_only_session: claude_usage.SessionUsage) -> None:
    invalid = attempt_record(parse("sess-mismatch"), outcome="invalid", invalid_reason="usage:mismatch", verifier=None)
    records.validate(invalid)
    with pytest.raises(RecordError):
        records.validate({**invalid, "invalid_reason": None})
    with pytest.raises(RecordError):
        records.validate(attempt_record(root_only_session, invalid_reason="oops"))


# The invariant lives in the record, not only in the runner that built it: a
# file the reducer reads from disk cannot claim a pass over usage that never
# reconciled with the harness envelope.
@pytest.mark.parametrize("status", UNRECONCILED)
def test_a_pass_cannot_carry_unreconciled_usage(family_session: claude_usage.SessionUsage, status: str) -> None:
    with pytest.raises(RecordError):
        records.validate(attempt_record(family_session, usage_reconciliation={"status": status}))


@pytest.mark.parametrize("status", RECONCILED)
def test_a_pass_may_carry_reconciled_usage(family_session: claude_usage.SessionUsage, status: str) -> None:
    records.validate(attempt_record(family_session, usage_reconciliation={"status": status}))


def test_a_declared_cap_is_the_one_scored_outcome_that_may_have_no_envelope(family_session: claude_usage.SessionUsage) -> None:
    # The outcome names the gap itself.
    capped = attempt_record(
        family_session,
        outcome="capped",
        stop_reason="timeout",
        verifier=None,
        usage_reconciliation={"status": "no_envelope"},
    )
    records.validate(capped)
    # A harness cap leaves a partial envelope; that too is named by the
    # outcome, and a capped attempt may carry the verdict it earned first.
    records.validate({**capped, "stop_reason": "budget", "usage_reconciliation": {"status": "envelope_partial"}})
    records.validate({**capped, "stop_reason": "turns", "verifier": {"id": "fake_answer_file", "exit_code": 0}})
    with pytest.raises(RecordError):
        records.validate({**capped, "usage_reconciliation": {"status": "mismatch"}})
    # An invalid attempt is where an unreconciled status belongs.
    records.validate({**capped, "outcome": "invalid", "invalid_reason": "usage:mismatch", "usage_reconciliation": {"status": "mismatch"}})


@pytest.mark.parametrize("data", list(CONTRADICTIONS.values()), ids=list(CONTRADICTIONS))
def test_record_rejects_contradictions(data: dict) -> None:
    with pytest.raises(RecordError):
        records.validate(data)


def test_publish_never_overwrites_and_two_writers_cannot_both_win(root_only_session: claude_usage.SessionUsage, tmp_path: Path) -> None:
    record = attempt_record(root_only_session)
    path, won = records.publish(tmp_path, record)
    _, second = records.publish(tmp_path, {**record, "outcome": "fail"})
    assert won
    assert not second
    assert json.loads(path.read_text())["outcome"] == "pass"
    accepted, excluded = records.select(tmp_path, record["manifest_hash"], record["schedule_hash"])
    assert list(accepted) == [record["trial_id"]]
    assert [item.reason for item in excluded] == ["partial"]


def test_select_excludes_every_non_final_file_with_a_reason(root_only_session: claude_usage.SessionUsage, tmp_path: Path) -> None:
    record = attempt_record(root_only_session)
    records.publish(tmp_path, record)
    (tmp_path / "stale.json").write_text(json.dumps({**record, "schedule_hash": "sha256:old"}), encoding="utf-8")
    (tmp_path / "misnamed.json").write_text(json.dumps(record), encoding="utf-8")
    (tmp_path / "broken.json").write_text("{", encoding="utf-8")
    (tmp_path / "forged.json").write_text(json.dumps({**record, "trial_id": "forged"}), encoding="utf-8")
    (tmp_path / "notes.txt").write_text("private", encoding="utf-8")
    accepted, excluded = records.select(tmp_path, record["manifest_hash"], record["schedule_hash"])
    assert list(accepted) == [record["trial_id"]]
    assert {item.path: item.reason.split(":", 1)[0] for item in excluded} == {
        "stale.json": "stale",
        "misnamed.json": "misnamed",
        "broken.json": "invalid",
        "forged.json": "invalid",
        "notes.txt": "foreign",
    }
    nothing, stale = records.select(tmp_path, "sha256:other", record["schedule_hash"])
    assert nothing == {}
    assert "stale" in [item.reason for item in stale]


def test_publish_refuses_an_invalid_record_before_writing(tmp_path: Path) -> None:
    with pytest.raises(RecordError):
        records.publish(tmp_path, {"schema": records.RECORD_SCHEMA})
    assert list(tmp_path.iterdir()) == []
