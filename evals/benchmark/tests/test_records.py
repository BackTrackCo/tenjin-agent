"""Immutable attempt records: publish without overwrite, validate, select on resume."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from evals.benchmark import claude_usage, loop_join, records
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
        "sentinel count": {**base, "sentinel": {"credential_exposures": None}},
        "reconciliation shape": {**base, "usage_reconciliation": {}},
    }


CONTRADICTIONS = contradictions(attempt_record(parse("sess-family")))


def test_complete_record_validates(family_session: claude_usage.SessionUsage) -> None:
    record = attempt_record(family_session)
    records.validate(record)
    assert len(record["actors"]) == 5
    assert len(record["parent_edges"]) == 4
    assert record["usage_reconciliation"]["status"] == "matched_with_descendants"


@pytest.mark.parametrize("entry", [None, 7, True, "bad", [], [["adapter", "claude"]]])
def test_non_object_retained_usage_is_a_record_error(family_session, entry) -> None:
    value = attempt_record(family_session)
    value["usage"] = [entry]
    with pytest.raises(RecordError, match="usage entry"):
        records.validate(value)


def test_invalid_attempt_needs_a_reason_and_only_then(root_only_session: claude_usage.SessionUsage) -> None:
    invalid = attempt_record(parse("sess-mismatch"), outcome="invalid", invalid_reason="usage:mismatch", verifier=None)
    records.validate(invalid)
    with pytest.raises(RecordError):
        records.validate({**invalid, "invalid_reason": None})
    with pytest.raises(RecordError):
        records.validate(attempt_record(root_only_session, invalid_reason="oops"))


def test_a_refusal_may_quote_itself_and_only_a_refusal_may(family_session: claude_usage.SessionUsage) -> None:
    """`invalid_reason` is the enum a reducer groups by; `invalid_detail` is what the refusal actually said."""
    invalid = attempt_record(parse("sess-mismatch"), outcome="invalid", invalid_reason="provision:seed_publish", verifier=None)
    records.validate({**invalid, "invalid_detail": "tenjin publish exited 1: No wallet passphrase is available."})
    records.validate({**invalid, "invalid_detail": None})
    for bad in ("", 7, "x" * (records.DETAIL_LIMIT + 1)):
        with pytest.raises(RecordError):
            records.validate({**invalid, "invalid_detail": bad})
    with pytest.raises(RecordError):
        records.validate({**attempt_record(family_session), "invalid_detail": "a scored attempt started"})


def test_the_marketplace_leg_is_stated_per_attempt_or_not_at_all(family_session: claude_usage.SessionUsage) -> None:
    # The two shelf arms carry byte-identical settings, so this field is the
    # only thing in a record that tells them apart.
    base = attempt_record(family_session)
    for value in ("on", "off"):
        records.validate({**base, "isolation": {**base["isolation"], "public_fallback": value}})
    records.validate(base)
    for value in ("false", "", True):
        with pytest.raises(RecordError):
            records.validate({**base, "isolation": {**base["isolation"], "public_fallback": value}})


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


@pytest.mark.parametrize("field", ("wall_time_s", "agent_time_s", "verification_time_s"))
@pytest.mark.parametrize("value", (-1, True, float("inf"), float("nan")))
def test_timing_requires_finite_nonnegative_observations(field, value) -> None:
    with pytest.raises(RecordError):
        records.validate({**attempt_record(parse("sess-family")), field: value})


def test_knowledge_receipt_rejects_unbound_or_unversioned_available_bodies(family_session):
    import copy
    base = attempt_record(family_session)
    knowledge = {"corpus_hash": "sha256:" + "a" * 64, "body_hashes": {"prior": "sha256:" + "b" * 64}, "available": ["prior"]}
    base["isolation"]["knowledge"] = knowledge
    records.validate(base)
    for change in [{"available": ["future"]}, {"available": ["prior", "prior"]}, {"corpus_hash": "unversioned"}, {"body_hashes": {"prior": "current"}}]:
        bad = copy.deepcopy(base)
        bad["isolation"]["knowledge"].update(change)
        with pytest.raises(RecordError):
            records.validate(bad)


def _with_producer(producer: str, **overrides) -> dict:
    """A record whose memory was prepared by one producer phase that ended `producer`."""
    base = attempt_record(parse("sess-family"))
    return {
        **base,
        "isolation": {**base["isolation"], "producer": {"outcome": producer, "agent_time_s": 12.0}},
        **overrides,
    }


@pytest.mark.parametrize("outcome", sorted(records.UNSETTLED_PRODUCER))
def test_an_unsettled_producer_leaves_its_attempt_unmeasurable(outcome: str) -> None:
    scored = _with_producer(outcome)
    assert records.producer_unusable(scored) == f"producer:{outcome}"
    with pytest.raises(RecordError, match=f"producer:{outcome}"):
        records.validate(scored)
    # The same attempt is a record once it says what it is: the producer
    # published nothing, so there was nothing to reuse and nothing to score.
    records.validate(_with_producer(outcome, outcome="invalid", invalid_reason=f"producer:{outcome}", verifier=None))


@pytest.mark.parametrize("outcome", ("pass", "fail"))
def test_a_producer_that_finished_still_prepared_a_measurement(outcome: str) -> None:
    record = _with_producer(outcome)
    assert records.producer_unusable(record) is None
    records.validate(record)


def test_an_attempt_without_a_producer_phase_depends_on_none() -> None:
    assert records.producer_unusable(attempt_record(parse("sess-family"))) is None
    assert records.producer_unusable({"isolation": {"producer": "capped"}}) is None
    assert records.producer_unusable({}) is None


def test_a_fires_query_head_is_bounded_and_agrees_with_the_length_beside_it(family_session: claude_usage.SessionUsage) -> None:
    """The head exists to settle what a fire asked, so a record cannot claim more than the hook could send."""
    base = attempt_record(family_session)
    actor = list(base["actors"][0]["key"])
    fire = {"fire_id": "f", "actor": actor, "question_head": "why does pnpm reinstall every run", "question_chars": 900}
    delivery = {**base["delivery"], "status": "joined", "fires": [fire]}
    records.validate({**base, "delivery": delivery})
    records.validate({**base, "delivery": {**delivery, "fires": [{"fire_id": "f", "actor": actor}]}})
    bent = (
        {**fire, "question_head": "x" * (loop_join.QUESTION_HEAD_CHARS + 1)},
        {**fire, "question_head": ""},
        {**fire, "question_chars": 4},
        {**fire, "question_chars": -1},
    )
    for entry in bent:
        with pytest.raises(RecordError, match="question_"):
            records.validate({**base, "delivery": {**delivery, "fires": [entry]}})
