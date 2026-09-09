"""Claude JSONL adapter: the frozen row, grouping, selection, and reconciliation rules."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Callable

import pytest

from evals.benchmark import claude_usage
from evals.benchmark.claude_usage import ClaudeUsageError
from evals.benchmark.tests.support import SESSIONS, copy_session, parse

Edit = Callable[[list[Any]], list[Any]]


def _assistant_rows(rows: list[Any]) -> list[dict[str, Any]]:
    return [row for row in rows if isinstance(row, dict) and row.get("type") == "assistant"]


def edited(tmp_path: Path, session: str, edit: Edit | None = None, children: dict[str, Edit] | None = None) -> claude_usage.SessionUsage:
    """One fixture session copied and rewritten, then parsed."""
    return parse(session, copy_session(tmp_path, session, edit, children))


def test_root_only_selects_one_record_per_request(root_only_session: claude_usage.SessionUsage) -> None:
    session = root_only_session
    assert session.actors == [("claude", "sess-root-only", "")]
    assert [record.native_request_id for record in session.records] == ["req_001", "req_002"]
    assert session.reconciliation["status"] == "matched"
    assert session.settled
    assert session.invalid_reason is None
    assert session.envelope.num_turns == 2
    assert session.envelope.total_cost_usd == 0.0123
    assert session.tool_counts == {"": {"Bash": 1}}


def test_partial_and_final_rows_select_the_final_row(root_only_session: claude_usage.SessionUsage) -> None:
    first = root_only_session.records[0]
    # Three assistant rows, two requests: the partial row (output 1) is never summed in.
    assert root_only_session.diagnostics["fragments"] == 3
    assert root_only_session.diagnostics["requests"] == 2
    assert (first.uncached_input, first.cache_write, first.cache_read, first.output_total) == (4, 1200, 0, 180)
    # The arithmetic, not a number: exposed input categories sum to the total.
    assert first.input_total == first.uncached_input + first.cache_write + first.cache_read
    assert first.completion_state == "complete"
    assert first.adapter_version == claude_usage.ADAPTER_VERSION


def test_message_id_is_the_documented_fallback_key() -> None:
    session = parse("sess-fallback")
    assert [record.native_request_id for record in session.records] == ["msg_601", "msg_602"]
    assert session.records[0].output_total == 60
    assert session.reconciliation["status"] == "matched"


def test_family_discovers_child_grandchild_and_concurrent_siblings(family_session: claude_usage.SessionUsage) -> None:
    session = family_session
    assert [actor[2] for actor in session.actors] == ["", "child01", "grand01", "sib0a", "sib0b"]
    assert sorted(record.native_request_id for record in session.records) == ["req_101", "req_102", "req_c01", "req_c02", "req_g01", "req_s01", "req_s02"]
    by_actor: dict[str, int] = {}
    for record in session.records:
        by_actor[record.actor_key[2]] = by_actor.get(record.actor_key[2], 0) + record.total
    # Grouping, not bytes: every actor is counted once, the root outweighs each descendant,
    # and the descendants together are what the envelope adds over the root rows.
    assert sorted(by_actor) == ["", "child01", "grand01", "sib0a", "sib0b"]
    assert all(total > 0 for total in by_actor.values())
    assert by_actor[""] > max(total for actor, total in by_actor.items() if actor)
    assert session.reconciliation["status"] == "matched_with_descendants"


def test_parent_edges_come_only_from_structured_native_fields(family_session: claude_usage.SessionUsage) -> None:
    edges = {edge.child[2]: (edge.parent[2], edge.provenance) for edge in family_session.parent_edges}
    assert edges == {"child01": ("", "native"), "grand01": ("child01", "native"), "sib0a": ("", "native"), "sib0b": ("", "native")}
    entries = {entry["key"][2]: entry for entry in family_session.actor_entries()}
    assert entries["grand01"]["parent_actor_key"] == ["claude", "sess-family", "child01"]
    assert entries[""]["parent_actor_key"] is None
    assert entries[""]["parent_provenance"] == "unavailable"


def test_ancestry_is_never_inferred_from_prose_or_paths() -> None:
    # The root's tool result names flat01 and says who its parent was; the
    # child's rows carry no parent_tool_use_id, so nothing is stored.
    session = parse("sess-flat")
    assert [actor[2] for actor in session.actors] == ["", "flat01"]
    assert session.parent_edges == []
    entry = next(entry for entry in session.actor_entries() if entry["key"][2] == "flat01")
    assert (entry["parent_actor_key"], entry["parent_provenance"]) == (None, "unavailable")
    assert session.reconciliation["status"] == "matched"


def test_forwarded_child_prose_and_echo_count_once(family_session: claude_usage.SessionUsage) -> None:
    # The root file carries child01's prose as a tool result and an echo of
    # its last request; the child transcript carries the request itself.
    assert family_session.diagnostics["echo_rows"] == 1
    child = [record for record in family_session.records if record.native_request_id == "req_c02"]
    assert len(child) == 1
    assert child[0].actor_key[2] == "child01"


def test_echo_that_disagrees_with_the_child_is_rejected(tmp_path: Path) -> None:
    def edit(rows: list[Any]) -> list[Any]:
        for row in _assistant_rows(rows):
            if row.get("agentId") == "child01":
                row["message"]["usage"]["output_tokens"] += 1
        return rows

    with pytest.raises(ClaudeUsageError) as caught:
        edited(tmp_path, "sess-family", edit)
    assert caught.value.code == "conflicting_records"


def test_sidechain_row_without_agent_id_is_rejected(tmp_path: Path) -> None:
    def edit(rows: list[Any]) -> list[Any]:
        for row in _assistant_rows(rows):
            row.pop("agentId", None)
        return rows

    with pytest.raises(ClaudeUsageError) as caught:
        edited(tmp_path, "sess-family", edit)
    assert caught.value.code == "sidechain_without_agent"


def test_child_transcript_naming_another_agent_is_rejected(tmp_path: Path) -> None:
    def edit(rows: list[Any]) -> list[Any]:
        for row in _assistant_rows(rows):
            row["agentId"] = "sib0a"
        return rows

    with pytest.raises(ClaudeUsageError) as caught:
        edited(tmp_path, "sess-family", None, {"grand01": edit})
    assert caught.value.code == "actor_mismatch"


def test_repeated_message_ids_reconcile_against_the_envelope(root_only_session: claude_usage.SessionUsage) -> None:
    categories = root_only_session.reconciliation["categories"]
    # The relation, not the fixture's totals: the actors' rows add to what the envelope declares.
    assert categories["output_tokens"]["actors"] == categories["output_tokens"]["envelope"]
    assert categories["output_tokens"]["delta"] == 0
    assert categories["cache_creation_input_tokens"]["delta"] == 0


def test_unexplained_envelope_mismatch_fails_the_attempt_closed() -> None:
    session = parse("sess-mismatch")
    assert session.reconciliation["status"] == "mismatch"
    assert session.reconciliation["categories"]["output_tokens"]["delta"] == 1
    assert session.invalid_reason == "usage:mismatch"
    # The records are still there for the cost appendix; they just never score.
    assert session.records[0].output_total == 180


def test_envelope_counting_only_the_root_still_matches_with_children(tmp_path: Path) -> None:
    def edit(rows: list[Any]) -> list[Any]:
        rows[-1]["usage"] = {"input_tokens": 13, "cache_creation_input_tokens": 2100, "cache_read_input_tokens": 2000, "output_tokens": 180}
        return rows

    assert edited(tmp_path, "sess-family", edit).reconciliation["status"] == "matched"


def test_side_model_usage_explains_a_remainder_without_apportioning() -> None:
    session = parse("sess-side-models")
    assert session.reconciliation["status"] == "explained_by_side_models"
    assert session.reconciliation["unattributed"] == {"input_tokens": 40, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0, "output_tokens": 12, "models": 1}
    assert len(session.records) == 1
    assert session.invalid_reason is None


def test_side_model_that_does_not_explain_the_remainder_is_a_mismatch(tmp_path: Path) -> None:
    def edit(rows: list[Any]) -> list[Any]:
        rows[-1]["usage"]["output_tokens"] += 1
        return rows

    assert edited(tmp_path, "sess-side-models", edit).reconciliation["status"] == "mismatch"


def test_missing_envelope_is_unsettled_not_zero() -> None:
    session = parse("sess-capped")
    assert not session.settled
    assert session.reconciliation["status"] == "no_envelope"
    assert session.record_fields()["turns"] is None
    assert session.record_fields()["cost_usd"] is None


def test_native_iterations_are_one_request() -> None:
    session = parse("sess-retry")
    record = session.records[0]
    assert len(session.records) == 1
    assert (record.uncached_input, record.cache_write, record.cache_read, record.output_total) == (8, 1000, 1000, 102)
    assert session.diagnostics["retries"] == 1
    assert session.reconciliation["status"] == "matched"


def test_iterations_that_do_not_sum_are_rejected(tmp_path: Path) -> None:
    def edit(rows: list[Any]) -> list[Any]:
        _assistant_rows(rows)[0]["message"]["usage"]["iterations"][0]["output_tokens"] += 5
        return rows

    with pytest.raises(ClaudeUsageError) as caught:
        edited(tmp_path, "sess-retry", edit)
    assert caught.value.code == "iterations_mismatch"


def test_cache_output_and_reasoning_categories() -> None:
    record = parse("sess-categories").records[0]
    assert record.uncached_input == 7
    assert record.cache_write == 1500
    assert record.cache_read == 250
    assert record.input_total == 1757
    assert record.output_total == 400
    assert record.reasoning_output_subset == 150
    assert record.provider_total is None
    assert record.native_request_cost is None


def test_cache_creation_detail_must_sum_to_the_category(tmp_path: Path) -> None:
    def edit(rows: list[Any]) -> list[Any]:
        _assistant_rows(rows)[0]["message"]["usage"]["cache_creation"]["ephemeral_1h_input_tokens"] = 1
        return rows

    with pytest.raises(ClaudeUsageError) as caught:
        edited(tmp_path, "sess-categories", edit)
    assert caught.value.code == "malformed_usage"


def test_null_versus_zero_categories() -> None:
    hidden, zeros = parse("sess-null-zero").records
    assert hidden.cache_read is None
    assert hidden.cache_write is None
    assert hidden.input_total == 5
    assert (zeros.cache_read, zeros.cache_write) == (0, 0)
    assert zeros.input_total == 5
    reconciliation = parse("sess-null-zero").reconciliation
    assert reconciliation["status"] == "matched"
    assert reconciliation["categories"]["cache_read_input_tokens"]["delta"] is None


@pytest.mark.parametrize(("session", "code"), [("sess-malformed", "malformed_row"), ("sess-duplicate", "duplicate_request")])
def test_a_transcript_the_adapter_cannot_count_once_is_rejected(session: str, code: str) -> None:
    with pytest.raises(ClaudeUsageError) as caught:
        parse(session)
    assert caught.value.code == code


def test_capped_transcript_keeps_partial_usage() -> None:
    session = parse("sess-capped")
    assert {record.native_request_id: record.completion_state for record in session.records} == {"req_901": "complete", "req_902": "partial"}
    assert sum(record.total for record in session.records) == 903 + 50 + 904 + 1


def test_turn_budget_cap_is_visible_on_the_envelope() -> None:
    session = parse("sess-capped-turns")
    assert session.envelope.capped
    assert session.envelope.is_error
    assert session.envelope.cap == "turns"
    assert session.reconciliation["status"] == "matched"
    assert session.reconciliation["envelope"] == "complete"


def test_a_budget_stop_leaves_a_partial_envelope_that_is_not_a_mismatch() -> None:
    # The CLI stops on --max-budget-usd before its envelope has folded the
    # last requests in, so the envelope undercounts every category. The
    # per-actor rows are the count; the envelope's own totals stay beside
    # them as partial, and the attempt is a capped one, never invalid.
    session = parse("sess-capped-budget")
    assert session.envelope.cap == "budget"
    assert session.reconciliation["status"] == "envelope_partial"
    assert session.reconciliation["envelope"] == "partial"
    assert session.invalid_reason is None
    categories = session.reconciliation["categories"]
    # The direction, not the fixture's totals: a partial envelope is under the rows in every
    # category it undercounts, and the count the attempt carries is the rows' own sum.
    for name in ("output_tokens", "cache_read_input_tokens"):
        assert categories[name]["envelope"] < categories[name]["actors"], name
        assert categories[name]["delta"] == categories[name]["envelope"] - categories[name]["actors"], name
    assert sum(record.total for record in session.records) == sum(cell["actors"] for cell in categories.values())
    assert session.record_fields()["cost_usd"] == 0.7512


def test_a_capped_envelope_above_the_transcript_is_still_a_mismatch(tmp_path: Path) -> None:
    # Partial means the envelope shows less, never more: an envelope that
    # counts a request the transcript lacks is a gap the cap does not name.
    def edit(rows: list[Any]) -> list[Any]:
        rows[-1]["usage"]["output_tokens"] = 121
        return rows

    session = edited(tmp_path, "sess-capped-budget", edit)
    assert session.reconciliation["status"] == "mismatch"
    assert session.invalid_reason == "usage:mismatch"


def test_incomplete_group_is_ambiguous() -> None:
    with pytest.raises(ClaudeUsageError) as caught:
        parse("sess-ambiguous")
    assert caught.value.code == "input_disagreement"


def _regressed(rows: list[Any]) -> list[Any]:
    first, second = _assistant_rows(rows)[:2]
    first["message"]["usage"]["output_tokens"] = second["message"]["usage"]["output_tokens"] + 1
    return rows


def _mixed(rows: list[Any]) -> list[Any]:
    _assistant_rows(rows)[1]["message"]["id"] = "msg_other"
    return rows


def _reused(rows: list[Any]) -> list[Any]:
    _assistant_rows(rows)[2]["message"]["id"] = "msg_001"
    return rows


def _no_usage(rows: list[Any]) -> list[Any]:
    del _assistant_rows(rows)[0]["message"]["usage"]
    return rows


def _no_key(rows: list[Any]) -> list[Any]:
    row = _assistant_rows(rows)[0]
    del row["requestId"]
    del row["message"]["id"]
    return rows


def _negative(rows: list[Any]) -> list[Any]:
    _assistant_rows(rows)[0]["message"]["usage"]["input_tokens"] = -1
    return rows


def _trailing(rows: list[Any]) -> list[Any]:
    return rows + [rows[1]]


def _two_results(rows: list[Any]) -> list[Any]:
    return rows + [rows[-1]]


def _other_session(rows: list[Any]) -> list[Any]:
    _assistant_rows(rows)[0]["session_id"] = "sess-other"
    return rows


def _synthetic(rows: list[Any]) -> list[Any]:
    row = {
        "type": "assistant",
        "session_id": "sess-root-only",
        "message": {"id": "msg_synthetic", "model": "<synthetic>", "content": [], "usage": {"input_tokens": 0, "output_tokens": 0}},
    }
    return rows[:-1] + [row, rows[-1]]


@pytest.mark.parametrize(
    ("code", "edit"),
    [
        ("output_regressed", _regressed),
        ("mixed_message_ids", _mixed),
        ("message_id_reused", _reused),
        ("assistant_without_usage", _no_usage),
        ("row_without_request_key", _no_key),
        ("malformed_usage", _negative),
        pytest.param("rows_after_result", _trailing, id="rows_after_result-trailing"),
        pytest.param("rows_after_result", _two_results, id="rows_after_result-two-results"),
        ("session_mismatch", _other_session),
    ],
)
def test_malformed_native_records_are_rejected(tmp_path: Path, code: str, edit: Edit) -> None:
    with pytest.raises(ClaudeUsageError) as caught:
        edited(tmp_path, "sess-root-only", edit)
    assert caught.value.code == code


def test_missing_root_transcript_is_rejected() -> None:
    with pytest.raises(ClaudeUsageError) as caught:
        claude_usage.parse_session_dir(SESSIONS, "sess-missing", "trial-x")
    assert caught.value.code == "root_transcript_missing"


def test_synthetic_rows_are_not_requests(tmp_path: Path) -> None:
    session = edited(tmp_path, "sess-root-only", _synthetic)
    assert session.diagnostics["synthetic_rows"] == 1
    assert len(session.records) == 2
