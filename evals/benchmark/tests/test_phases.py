"""The attempt's own decomposition: the task, the turn-end nudge, the CLI search, partitioned by the store's marks."""

from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path

from evals.benchmark import phases, usage
from evals.benchmark.tests import support


def record(request_id: str, input_total: int = 100, output_total: int = 10) -> usage.UsageRecord:
    return usage.UsageRecord(
        adapter="claude",
        adapter_version="1",
        trial_id="trial-a",
        actor_key=("trial-a", "session", ""),
        native_request_id=request_id,
        input_total=input_total,
        uncached_input=input_total,
        cache_read=0,
        cache_write=0,
        output_total=output_total,
        reasoning_output_subset=None,
        provider_total=None,
        native_request_cost=None,
        completion_state="complete",
        source_hash="sha256:" + "0" * 8,
    )


class SplitTest(unittest.TestCase):
    def setUp(self) -> None:
        self.records = [record("req_1"), record("req_2"), record("req_3", 900, 90)]
        self.times = {"req_1": 1_000, "req_2": 2_000, "req_3": 3_000}

    def totals(self, block: dict[str, dict[str, int]]) -> dict[str, int]:
        return {phase: entry["input_total"] + entry["output_total"] for phase, entry in block.items()}

    def test_an_arm_with_no_store_is_all_task_and_nothing_else(self) -> None:
        block = phases.split(self.records, self.times, phases.Marks())
        self.assertEqual(self.totals(block), {"consumer": 1210, "nudge": 0, "cli_search": 0})
        self.assertEqual(block["consumer"]["requests"], 3)

    def test_every_request_from_the_turn_end_fire_on_is_the_nudge(self) -> None:
        block = phases.split(self.records, self.times, phases.Marks(turn_end_at=2_500))
        self.assertEqual(self.totals(block), {"consumer": 220, "nudge": 990, "cli_search": 0})
        self.assertEqual((block["consumer"]["requests"], block["nudge"]["requests"]), (2, 1))

    def test_a_cli_search_claims_the_first_request_after_it_and_only_that_one(self) -> None:
        block = phases.split(self.records, self.times, phases.Marks(turn_end_at=None, searches=(1_500,)))
        self.assertEqual(self.totals(block), {"consumer": 1100, "nudge": 0, "cli_search": 110})
        self.assertEqual(block["cli_search"]["requests"], 1)

    def test_two_searches_claim_two_requests(self) -> None:
        block = phases.split(self.records, self.times, phases.Marks(searches=(1_500, 2_500)))
        self.assertEqual(block["cli_search"]["requests"], 2)
        self.assertEqual(self.totals(block)["cli_search"], 1100)

    def test_a_search_after_the_turn_end_is_the_nudges_request_not_the_searchs(self) -> None:
        # The Stop hook fired first; what follows is the capture ask's turn,
        # and one request is never charged twice.
        block = phases.split(self.records, self.times, phases.Marks(turn_end_at=2_500, searches=(2_600,)))
        self.assertEqual(self.totals(block), {"consumer": 220, "nudge": 990, "cli_search": 0})

    def test_a_request_the_transcript_never_stamped_falls_to_the_task(self) -> None:
        block = phases.split(self.records, {"req_1": 1_000}, phases.Marks(turn_end_at=900))
        self.assertEqual(block["consumer"]["requests"], 2)
        self.assertEqual(block["nudge"]["requests"], 1)

    def test_the_phases_always_partition_the_attempts_own_usage(self) -> None:
        for marks in (phases.Marks(), phases.Marks(turn_end_at=2_000), phases.Marks(turn_end_at=2_000, searches=(1_100,))):
            with self.subTest(str(marks)):
                block = phases.split(self.records, self.times, marks)
                self.assertEqual(sum(self.totals(block).values()), 1210)
                self.assertEqual(sum(entry["requests"] for entry in block.values()), 3)


class MarksTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = Path(self.tmp.name) / "loop.db"

    def store(self, session: str = "session-a") -> None:
        support.write_loop_db(self.db, [("fire-1", session, "")])
        connection = sqlite3.connect(self.db)
        connection.execute("UPDATE fires SET event = 'turn.end', at = 5000 WHERE id = 'fire-1'")
        connection.execute(
            "CREATE TABLE IF NOT EXISTS searches (search_id TEXT PRIMARY KEY, at INTEGER NOT NULL, session TEXT NOT NULL, "
            "question TEXT, fingerprint TEXT, decision TEXT, candidates TEXT, source TEXT)"
        )
        for search_id, at, source in (("s1", 2000, "cli"), ("s2", 3000, "push-hook"), ("s3", 4000, "cli")):
            connection.execute(
                "INSERT INTO searches (search_id, at, session, question, fingerprint, decision, candidates, source) VALUES (?, ?, ?, 'q', 'f', 'd', '[]', ?)",
                (search_id, at, session, source),
            )
        connection.commit()
        connection.close()

    def test_the_marks_are_the_first_turn_end_and_every_cli_search(self) -> None:
        self.store()
        marks = phases.read_marks(self.db, "session-a")
        self.assertEqual(marks.turn_end_at, 5000)
        # `push-hook` rows are the product's own searches, not the agent's.
        self.assertEqual(marks.searches, (2000, 4000))
        self.assertTrue(marks.known)

    def test_another_sessions_marks_are_not_this_attempts(self) -> None:
        self.store()
        self.assertEqual(phases.read_marks(self.db, "session-b"), phases.Marks())

    def test_a_missing_or_unreadable_store_leaves_the_attempt_undecomposed(self) -> None:
        self.assertEqual(phases.read_marks(self.db, "session-a"), phases.Marks())
        self.db.write_bytes(b"not a database")
        self.assertEqual(phases.read_marks(self.db, "session-a"), phases.Marks())


class TokensTest(unittest.TestCase):
    def test_the_named_phases_add_up_and_an_undecomposed_attempt_is_zero(self) -> None:
        block = {"consumer": {"requests": 1, "input_total": 10, "output_total": 1}, "nudge": {"requests": 1, "input_total": 20, "output_total": 2}}
        self.assertEqual(phases.tokens(block, "nudge"), 22)
        self.assertEqual(phases.tokens(block, "consumer", "nudge"), 33)
        self.assertEqual(phases.tokens(None, "nudge"), 0)
        self.assertEqual(phases.tokens({}, "cli_search"), 0)


if __name__ == "__main__":
    unittest.main()
