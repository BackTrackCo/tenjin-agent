"""Claude JSONL adapter: the frozen row, grouping, selection, and reconciliation rules."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from typing import Any

from evals.benchmark import claude_usage
from evals.benchmark.claude_usage import ClaudeUsageError
from evals.benchmark.tests.support import SESSIONS, copy_session, parse

ROOT = ("claude", "sess-family", "")


def _assistant_rows(rows: list[Any]) -> list[dict[str, Any]]:
    return [row for row in rows if isinstance(row, dict) and row.get("type") == "assistant"]


class RootOnlyTest(unittest.TestCase):
    def test_root_only_selects_one_record_per_request(self) -> None:
        session = parse("sess-root-only")
        self.assertEqual(session.actors, [("claude", "sess-root-only", "")])
        self.assertEqual([record.native_request_id for record in session.records], ["req_001", "req_002"])
        self.assertEqual(session.reconciliation["status"], "matched")
        self.assertTrue(session.settled)
        self.assertIsNone(session.invalid_reason)
        self.assertEqual(session.envelope.num_turns, 2)
        self.assertEqual(session.envelope.total_cost_usd, 0.0123)
        self.assertEqual(session.tool_counts, {"": {"Bash": 1}})

    def test_partial_and_final_rows_select_the_final_row(self) -> None:
        session = parse("sess-root-only")
        first = session.records[0]
        # Three assistant rows, two requests: the partial row (output 1) is never summed in.
        self.assertEqual(session.diagnostics["fragments"], 3)
        self.assertEqual(session.diagnostics["requests"], 2)
        self.assertEqual((first.uncached_input, first.cache_write, first.cache_read, first.output_total), (4, 1200, 0, 180))
        self.assertEqual(first.input_total, 1204)
        self.assertEqual(first.completion_state, "complete")
        self.assertEqual(first.adapter_version, claude_usage.ADAPTER_VERSION)

    def test_message_id_is_the_documented_fallback_key(self) -> None:
        session = parse("sess-fallback")
        self.assertEqual([record.native_request_id for record in session.records], ["msg_601", "msg_602"])
        self.assertEqual(session.records[0].output_total, 60)
        self.assertEqual(session.reconciliation["status"], "matched")


class FamilyTest(unittest.TestCase):
    def test_family_discovers_child_grandchild_and_concurrent_siblings(self) -> None:
        session = parse("sess-family")
        self.assertEqual([actor[2] for actor in session.actors], ["", "child01", "grand01", "sib0a", "sib0b"])
        self.assertEqual(
            sorted(record.native_request_id for record in session.records),
            ["req_101", "req_102", "req_c01", "req_c02", "req_g01", "req_s01", "req_s02"],
        )
        by_actor = {}
        for record in session.records:
            by_actor[record.actor_key[2]] = by_actor.get(record.actor_key[2], 0) + record.total
        self.assertEqual(by_actor, {"": 4293, "child01": 1965, "grand01": 432, "sib0a": 526, "sib0b": 536})
        self.assertEqual(session.reconciliation["status"], "matched_with_descendants")

    def test_parent_edges_come_only_from_structured_native_fields(self) -> None:
        session = parse("sess-family")
        edges = {edge.child[2]: (edge.parent[2], edge.provenance) for edge in session.parent_edges}
        self.assertEqual(
            edges,
            {"child01": ("", "native"), "grand01": ("child01", "native"), "sib0a": ("", "native"), "sib0b": ("", "native")},
        )
        entries = {entry["key"][2]: entry for entry in session.actor_entries()}
        self.assertEqual(entries["grand01"]["parent_actor_key"], ["claude", "sess-family", "child01"])
        self.assertIsNone(entries[""]["parent_actor_key"])
        self.assertEqual(entries[""]["parent_provenance"], "unavailable")

    def test_ancestry_is_never_inferred_from_prose_or_paths(self) -> None:
        # The root's tool result names flat01 and says who its parent was; the
        # child's rows carry no parent_tool_use_id, so nothing is stored.
        session = parse("sess-flat")
        self.assertEqual([actor[2] for actor in session.actors], ["", "flat01"])
        self.assertEqual(session.parent_edges, [])
        entry = next(entry for entry in session.actor_entries() if entry["key"][2] == "flat01")
        self.assertEqual((entry["parent_actor_key"], entry["parent_provenance"]), (None, "unavailable"))
        self.assertEqual(session.reconciliation["status"], "matched")

    def test_forwarded_child_prose_and_echo_count_once(self) -> None:
        session = parse("sess-family")
        # The root file carries child01's prose as a tool result and an echo of
        # its last request; the child transcript carries the request itself.
        self.assertEqual(session.diagnostics["echo_rows"], 1)
        child = [record for record in session.records if record.native_request_id == "req_c02"]
        self.assertEqual(len(child), 1)
        self.assertEqual(child[0].actor_key[2], "child01")

    def test_echo_that_disagrees_with_the_child_is_rejected(self) -> None:
        def edit(rows: list[Any]) -> list[Any]:
            for row in _assistant_rows(rows):
                if row.get("agentId") == "child01":
                    row["message"]["usage"]["output_tokens"] += 1
            return rows

        with tempfile.TemporaryDirectory() as tmp:
            sessions = copy_session(Path(tmp), "sess-family", edit)
            with self.assertRaises(ClaudeUsageError) as caught:
                parse("sess-family", sessions)
        self.assertEqual(caught.exception.code, "conflicting_records")

    def test_sidechain_row_without_agent_id_is_rejected(self) -> None:
        def edit(rows: list[Any]) -> list[Any]:
            for row in _assistant_rows(rows):
                row.pop("agentId", None)
            return rows

        with tempfile.TemporaryDirectory() as tmp:
            sessions = copy_session(Path(tmp), "sess-family", edit)
            with self.assertRaises(ClaudeUsageError) as caught:
                parse("sess-family", sessions)
        self.assertEqual(caught.exception.code, "sidechain_without_agent")

    def test_child_transcript_naming_another_agent_is_rejected(self) -> None:
        def edit(rows: list[Any]) -> list[Any]:
            for row in _assistant_rows(rows):
                row["agentId"] = "sib0a"
            return rows

        with tempfile.TemporaryDirectory() as tmp:
            sessions = copy_session(Path(tmp), "sess-family", children={"grand01": edit})
            with self.assertRaises(ClaudeUsageError) as caught:
                parse("sess-family", sessions)
        self.assertEqual(caught.exception.code, "actor_mismatch")


class ReconciliationTest(unittest.TestCase):
    def test_repeated_message_ids_reconcile_against_the_envelope(self) -> None:
        session = parse("sess-root-only")
        categories = session.reconciliation["categories"]
        self.assertEqual(categories["output_tokens"], {"envelope": 275, "actors": 275, "delta": 0})
        self.assertEqual(categories["cache_creation_input_tokens"]["delta"], 0)

    def test_unexplained_envelope_mismatch_fails_the_attempt_closed(self) -> None:
        session = parse("sess-mismatch")
        self.assertEqual(session.reconciliation["status"], "mismatch")
        self.assertEqual(session.reconciliation["categories"]["output_tokens"]["delta"], 1)
        self.assertEqual(session.invalid_reason, "usage:mismatch")
        # The records are still there for the cost appendix; they just never score.
        self.assertEqual(session.records[0].output_total, 180)

    def test_envelope_counting_only_the_root_still_matches_with_children(self) -> None:
        def edit(rows: list[Any]) -> list[Any]:
            rows[-1]["usage"] = {"input_tokens": 13, "cache_creation_input_tokens": 2100, "cache_read_input_tokens": 2000, "output_tokens": 180}
            return rows

        with tempfile.TemporaryDirectory() as tmp:
            session = parse("sess-family", copy_session(Path(tmp), "sess-family", edit))
        self.assertEqual(session.reconciliation["status"], "matched")

    def test_side_model_usage_explains_a_remainder_without_apportioning(self) -> None:
        session = parse("sess-side-models")
        self.assertEqual(session.reconciliation["status"], "explained_by_side_models")
        self.assertEqual(session.reconciliation["unattributed"], {"input_tokens": 40, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0, "output_tokens": 12, "models": 1})
        self.assertEqual(len(session.records), 1)
        self.assertIsNone(session.invalid_reason)

    def test_side_model_that_does_not_explain_the_remainder_is_a_mismatch(self) -> None:
        def edit(rows: list[Any]) -> list[Any]:
            rows[-1]["usage"]["output_tokens"] += 1
            return rows

        with tempfile.TemporaryDirectory() as tmp:
            session = parse("sess-side-models", copy_session(Path(tmp), "sess-side-models", edit))
        self.assertEqual(session.reconciliation["status"], "mismatch")

    def test_missing_envelope_is_unsettled_not_zero(self) -> None:
        session = parse("sess-capped")
        self.assertFalse(session.settled)
        self.assertEqual(session.reconciliation["status"], "no_envelope")
        self.assertIsNone(session.record_fields()["turns"])
        self.assertIsNone(session.record_fields()["cost_usd"])


class RetryAndCategoriesTest(unittest.TestCase):
    def test_native_iterations_are_one_request(self) -> None:
        session = parse("sess-retry")
        record = session.records[0]
        self.assertEqual(len(session.records), 1)
        self.assertEqual((record.uncached_input, record.cache_write, record.cache_read, record.output_total), (8, 1000, 1000, 102))
        self.assertEqual(session.diagnostics["retries"], 1)
        self.assertEqual(session.reconciliation["status"], "matched")

    def test_iterations_that_do_not_sum_are_rejected(self) -> None:
        def edit(rows: list[Any]) -> list[Any]:
            _assistant_rows(rows)[0]["message"]["usage"]["iterations"][0]["output_tokens"] += 5
            return rows

        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ClaudeUsageError) as caught:
                parse("sess-retry", copy_session(Path(tmp), "sess-retry", edit))
        self.assertEqual(caught.exception.code, "iterations_mismatch")

    def test_cache_output_and_reasoning_categories(self) -> None:
        record = parse("sess-categories").records[0]
        self.assertEqual(record.uncached_input, 7)
        self.assertEqual(record.cache_write, 1500)
        self.assertEqual(record.cache_read, 250)
        self.assertEqual(record.input_total, 1757)
        self.assertEqual(record.output_total, 400)
        self.assertEqual(record.reasoning_output_subset, 150)
        self.assertIsNone(record.provider_total)
        self.assertIsNone(record.native_request_cost)

    def test_cache_creation_detail_must_sum_to_the_category(self) -> None:
        def edit(rows: list[Any]) -> list[Any]:
            _assistant_rows(rows)[0]["message"]["usage"]["cache_creation"]["ephemeral_1h_input_tokens"] = 1
            return rows

        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ClaudeUsageError) as caught:
                parse("sess-categories", copy_session(Path(tmp), "sess-categories", edit))
        self.assertEqual(caught.exception.code, "malformed_usage")

    def test_null_versus_zero_categories(self) -> None:
        hidden, zeros = parse("sess-null-zero").records
        self.assertIsNone(hidden.cache_read)
        self.assertIsNone(hidden.cache_write)
        self.assertEqual(hidden.input_total, 5)
        self.assertEqual((zeros.cache_read, zeros.cache_write), (0, 0))
        self.assertEqual(zeros.input_total, 5)
        reconciliation = parse("sess-null-zero").reconciliation
        self.assertEqual(reconciliation["status"], "matched")
        self.assertIsNone(reconciliation["categories"]["cache_read_input_tokens"]["delta"])


class RejectionTest(unittest.TestCase):
    def test_malformed_row_is_rejected(self) -> None:
        with self.assertRaises(ClaudeUsageError) as caught:
            parse("sess-malformed")
        self.assertEqual(caught.exception.code, "malformed_row")

    def test_duplicate_request_across_actors_is_rejected(self) -> None:
        with self.assertRaises(ClaudeUsageError) as caught:
            parse("sess-duplicate")
        self.assertEqual(caught.exception.code, "duplicate_request")

    def test_capped_transcript_keeps_partial_usage(self) -> None:
        session = parse("sess-capped")
        states = {record.native_request_id: record.completion_state for record in session.records}
        self.assertEqual(states, {"req_901": "complete", "req_902": "partial"})
        self.assertEqual(sum(record.total for record in session.records), 903 + 50 + 904 + 1)

    def test_turn_budget_cap_is_visible_on_the_envelope(self) -> None:
        session = parse("sess-capped-turns")
        self.assertTrue(session.envelope.capped)
        self.assertTrue(session.envelope.is_error)
        self.assertEqual(session.envelope.cap, "turns")
        self.assertEqual(session.reconciliation["status"], "matched")
        self.assertEqual(session.reconciliation["envelope"], "complete")

    def test_a_budget_stop_leaves_a_partial_envelope_that_is_not_a_mismatch(self) -> None:
        # The CLI stops on --max-budget-usd before its envelope has folded the
        # last requests in, so the envelope undercounts every category. The
        # per-actor rows are the count; the envelope's own totals stay beside
        # them as partial, and the attempt is a capped one, never invalid.
        session = parse("sess-capped-budget")
        self.assertEqual(session.envelope.cap, "budget")
        self.assertEqual(session.reconciliation["status"], "envelope_partial")
        self.assertEqual(session.reconciliation["envelope"], "partial")
        self.assertIsNone(session.invalid_reason)
        categories = session.reconciliation["categories"]
        self.assertEqual(categories["output_tokens"], {"envelope": 50, "actors": 120, "delta": -70})
        self.assertEqual(categories["cache_read_input_tokens"], {"envelope": 0, "actors": 900, "delta": -900})
        self.assertEqual(sum(record.total for record in session.records), 903 + 50 + 904 + 70)
        self.assertEqual(session.record_fields()["cost_usd"], 0.7512)

    def test_a_capped_envelope_above_the_transcript_is_still_a_mismatch(self) -> None:
        # Partial means the envelope shows less, never more: an envelope that
        # counts a request the transcript lacks is a gap the cap does not name.
        def edit(rows: list[Any]) -> list[Any]:
            rows[-1]["usage"]["output_tokens"] = 121
            return rows

        with tempfile.TemporaryDirectory() as tmp:
            session = parse("sess-capped-budget", copy_session(Path(tmp), "sess-capped-budget", edit))
        self.assertEqual(session.reconciliation["status"], "mismatch")
        self.assertEqual(session.invalid_reason, "usage:mismatch")

    def test_incomplete_group_is_ambiguous(self) -> None:
        with self.assertRaises(ClaudeUsageError) as caught:
            parse("sess-ambiguous")
        self.assertEqual(caught.exception.code, "input_disagreement")

        def regress(rows: list[Any]) -> list[Any]:
            first, second = _assistant_rows(rows)[:2]
            first["message"]["usage"]["output_tokens"] = second["message"]["usage"]["output_tokens"] + 1
            return rows

        def mixed(rows: list[Any]) -> list[Any]:
            _assistant_rows(rows)[1]["message"]["id"] = "msg_other"
            return rows

        def reused(rows: list[Any]) -> list[Any]:
            _assistant_rows(rows)[2]["message"]["id"] = "msg_001"
            return rows

        for code, edit in (("output_regressed", regress), ("mixed_message_ids", mixed), ("message_id_reused", reused)):
            with self.subTest(code), tempfile.TemporaryDirectory() as tmp:
                with self.assertRaises(ClaudeUsageError) as caught:
                    parse("sess-root-only", copy_session(Path(tmp), "sess-root-only", edit))
                self.assertEqual(caught.exception.code, code)

    def test_malformed_native_records_are_rejected(self) -> None:
        def no_usage(rows: list[Any]) -> list[Any]:
            del _assistant_rows(rows)[0]["message"]["usage"]
            return rows

        def no_key(rows: list[Any]) -> list[Any]:
            row = _assistant_rows(rows)[0]
            del row["requestId"]
            del row["message"]["id"]
            return rows

        def negative(rows: list[Any]) -> list[Any]:
            _assistant_rows(rows)[0]["message"]["usage"]["input_tokens"] = -1
            return rows

        def trailing(rows: list[Any]) -> list[Any]:
            return rows + [rows[1]]

        def two_results(rows: list[Any]) -> list[Any]:
            return rows + [rows[-1]]

        def other_session(rows: list[Any]) -> list[Any]:
            _assistant_rows(rows)[0]["session_id"] = "sess-other"
            return rows

        cases = {
            "assistant_without_usage": no_usage,
            "row_without_request_key": no_key,
            "malformed_usage": negative,
            "rows_after_result": trailing,
            "session_mismatch": other_session,
        }
        for code, edit in cases.items():
            with self.subTest(code), tempfile.TemporaryDirectory() as tmp:
                with self.assertRaises(ClaudeUsageError) as caught:
                    parse("sess-root-only", copy_session(Path(tmp), "sess-root-only", edit))
                self.assertEqual(caught.exception.code, code)
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ClaudeUsageError) as caught:
                parse("sess-root-only", copy_session(Path(tmp), "sess-root-only", two_results))
        self.assertEqual(caught.exception.code, "rows_after_result")

    def test_missing_root_transcript_is_rejected(self) -> None:
        with self.assertRaises(ClaudeUsageError) as caught:
            claude_usage.parse_session_dir(SESSIONS, "sess-missing", "trial-x")
        self.assertEqual(caught.exception.code, "root_transcript_missing")

    def test_synthetic_rows_are_not_requests(self) -> None:
        def edit(rows: list[Any]) -> list[Any]:
            synthetic = {
                "type": "assistant",
                "session_id": "sess-root-only",
                "message": {"id": "msg_synthetic", "model": "<synthetic>", "content": [], "usage": {"input_tokens": 0, "output_tokens": 0}},
            }
            return rows[:-1] + [synthetic, rows[-1]]

        with tempfile.TemporaryDirectory() as tmp:
            session = parse("sess-root-only", copy_session(Path(tmp), "sess-root-only", edit))
        self.assertEqual(session.diagnostics["synthetic_rows"], 1)
        self.assertEqual(len(session.records), 2)


if __name__ == "__main__":
    unittest.main()
