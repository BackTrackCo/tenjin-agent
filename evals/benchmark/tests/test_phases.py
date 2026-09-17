"""The attempt's own decomposition: the task, the turn-end nudge, the CLI search, partitioned by the store's marks."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

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


@pytest.fixture
def records() -> list[usage.UsageRecord]:
    return [record("req_1"), record("req_2"), record("req_3", 900, 90)]


@pytest.fixture
def times() -> dict[str, int]:
    return {"req_1": 1_000, "req_2": 2_000, "req_3": 3_000}


def totals(block: dict[str, dict[str, int]]) -> dict[str, int]:
    return {phase: entry["input_total"] + entry["output_total"] for phase, entry in block.items()}


def test_an_arm_with_no_store_is_all_task_and_nothing_else(records: list[usage.UsageRecord], times: dict[str, int]) -> None:
    block = phases.split(records, times, phases.Marks())
    assert totals(block) == {"consumer": 1210, "nudge": 0, "cli_search": 0}
    assert block["consumer"]["requests"] == 3


def test_every_request_from_the_turn_end_fire_on_is_the_nudge(records: list[usage.UsageRecord], times: dict[str, int]) -> None:
    block = phases.split(records, times, phases.Marks(turn_end_at=2_500))
    assert totals(block) == {"consumer": 220, "nudge": 990, "cli_search": 0}
    assert (block["consumer"]["requests"], block["nudge"]["requests"]) == (2, 1)


def test_a_cli_search_claims_the_first_request_after_it_and_only_that_one(records: list[usage.UsageRecord], times: dict[str, int]) -> None:
    block = phases.split(records, times, phases.Marks(turn_end_at=None, searches=(1_500,)))
    assert totals(block) == {"consumer": 1100, "nudge": 0, "cli_search": 110}
    assert block["cli_search"]["requests"] == 1


def test_two_searches_claim_two_requests(records: list[usage.UsageRecord], times: dict[str, int]) -> None:
    block = phases.split(records, times, phases.Marks(searches=(1_500, 2_500)))
    assert block["cli_search"]["requests"] == 2
    assert totals(block)["cli_search"] == 1100


def test_a_search_after_the_turn_end_is_the_nudges_request_not_the_searchs(records: list[usage.UsageRecord], times: dict[str, int]) -> None:
    # The Stop hook fired first; what follows is the capture ask's turn,
    # and one request is never charged twice.
    block = phases.split(records, times, phases.Marks(turn_end_at=2_500, searches=(2_600,)))
    assert totals(block) == {"consumer": 220, "nudge": 990, "cli_search": 0}


def test_a_request_the_transcript_never_stamped_falls_to_the_task(records: list[usage.UsageRecord]) -> None:
    block = phases.split(records, {"req_1": 1_000}, phases.Marks(turn_end_at=900))
    assert block["consumer"]["requests"] == 2
    assert block["nudge"]["requests"] == 1


@pytest.mark.parametrize(
    "marks",
    [phases.Marks(), phases.Marks(turn_end_at=2_000), phases.Marks(turn_end_at=2_000, searches=(1_100,))],
)
def test_the_phases_always_partition_the_attempts_own_usage(records: list[usage.UsageRecord], times: dict[str, int], marks: phases.Marks) -> None:
    block = phases.split(records, times, marks)
    assert sum(totals(block).values()) == 1210
    assert sum(entry["requests"] for entry in block.values()) == 3


@pytest.fixture
def db(tmp_path: Path) -> Path:
    return tmp_path / "loop.db"


def store(db: Path, session: str = "session-a") -> None:
    support.write_loop_db(db, [("fire-1", session, "")])
    connection = sqlite3.connect(db)
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


def test_the_marks_are_the_first_turn_end_and_every_cli_search(db: Path) -> None:
    store(db)
    marks = phases.read_marks(db, "session-a")
    assert marks.turn_end_at == 5000
    # `push-hook` rows are the product's own searches, not the agent's.
    assert marks.searches == (2000, 4000)
    assert marks.known


def test_another_sessions_marks_are_not_this_attempts(db: Path) -> None:
    store(db)
    assert phases.read_marks(db, "session-b") == phases.Marks()


def test_a_missing_or_unreadable_store_leaves_the_attempt_undecomposed(db: Path) -> None:
    assert phases.read_marks(db, "session-a") == phases.Marks()
    db.write_bytes(b"not a database")
    assert phases.read_marks(db, "session-a") == phases.Marks()


def test_the_named_phases_add_up_and_an_undecomposed_attempt_is_zero() -> None:
    block = {"consumer": {"requests": 1, "input_total": 10, "output_total": 1}, "nudge": {"requests": 1, "input_total": 20, "output_total": 2}}
    assert phases.tokens(block, "nudge") == 22
    assert phases.tokens(block, "consumer", "nudge") == 33
    assert phases.tokens(None, "nudge") == 0
    assert phases.tokens({}, "cli_search") == 0
