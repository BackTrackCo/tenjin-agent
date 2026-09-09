"""loop.db projection: read-only, WAL-refusing, joined on the exact actor key."""

from __future__ import annotations

import hashlib
import re
import sqlite3
from pathlib import Path

import pytest

from evals.benchmark import loop_join
from evals.benchmark.loop_join import LoopJoinError
from evals.benchmark.tests.support import loop_ddl

SESSION = "sess-family"
ROOT = ("claude", SESSION, "")
CHILD = ("claude", SESSION, "child01")
SIBLING = ("claude", SESSION, "sib0a")


@pytest.fixture
def db(tmp_path: Path) -> Path:
    """A settled ledger: three prompt fires under three actors, with legs."""
    path = tmp_path / "loop.db"
    connection = sqlite3.connect(path)
    connection.executescript(loop_ddl())
    fires = [
        ("fire-root", 1, SESSION, "", "prompt", "claude", "prompt", "p1", "hit", "team:piece-1"),
        ("fire-child", 2, SESSION, "child01", "prompt", "claude", "prompt", "p2", "miss", None),
        ("fire-sib", 3, SESSION, "sib0a", "prompt", "claude", "prompt", "p3", "hit", "team:piece-2"),
    ]
    for fire in fires:
        connection.execute(
            "INSERT INTO fires (id, at, session, agent, arm, harness, event, prompt_id, reason, delivered, cwd, wait, deadline_ms, elapsed_ms, question)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '/private/host/path', 'sync', 1000, 12, 'private question text')",
            fire,
        )
    connection.execute(
        "INSERT INTO legs (fire_id, stage, shelf, status, outcome, elapsed_ms, search_id, title, url, form, calibration)"
        " VALUES ('fire-root', 1, 'team', 'ok', 'hit', 10, 'search-1', 'private title', 'https://example.test/private', 'answer', 'calibrated')"
    )
    connection.execute("INSERT INTO legs (fire_id, stage, shelf, status, outcome, elapsed_ms) VALUES ('fire-root', 2, 'public', 'skipped', NULL, 0)")
    connection.execute("INSERT INTO legs (fire_id, stage, shelf, status, outcome, elapsed_ms) VALUES ('fire-sib', 1, 'team', 'ok', 'hit', 5)")
    connection.commit()
    connection.close()
    return path


def test_legs_are_counted_per_shelf_and_a_skipped_leg_is_not_a_request(db: Path) -> None:
    projection = loop_join.project(db, [ROOT, CHILD, SIBLING])
    # Two team legs went out; the public leg was planned and dropped.
    assert projection["shelves"] == {"team": 2, "public": 0, "keys": 0, "local": 0, "other": 0}
    assert projection["classes"] == {"team": 2, "public": 0, "local": 0, "other": 0}
    assert projection["public"] == {"legs": 0, "hits": 0, "timeouts": 0, "no_answer": 0}
    empty = loop_join.unavailable()
    assert empty["classes"] == {"team": 0, "public": 0, "local": 0, "other": 0}
    assert empty["public"] == {"legs": 0, "hits": 0, "timeouts": 0, "no_answer": 0}


def test_every_shelf_the_product_writes_has_a_class_and_only_an_unknown_one_is_other() -> None:
    # The tool-failure fire sends a keys leg and a local leg; the prompt
    # fire sends a team leg and, on a team miss, a public leg. The keys
    # leg is served by the public marketplace, so it is a public request;
    # the local leg never leaves the process, so it is not a request at
    # all; a shelf value outside the product's union is an unknown origin.
    legs = [
        {"shelf": "team", "status": "ok", "outcome": "miss"},
        {"shelf": "public", "status": "timeout", "outcome": "no-answer"},
        {"shelf": "keys", "status": "ok", "outcome": "miss"},
        {"shelf": "local", "status": "ok", "outcome": "miss"},
        {"shelf": "keys", "status": "ok", "outcome": "hit"},
        {"shelf": "mirror", "status": "ok", "outcome": "hit"},
        {"shelf": "public", "status": "skipped", "outcome": None},
    ]
    assert loop_join.count_shelves(legs) == {"team": 1, "public": 1, "keys": 2, "local": 1, "other": 1}
    assert loop_join.classify(legs) == {"team": 1, "public": 3, "local": 1, "other": 1}
    assert loop_join.public_summary(legs) == {"legs": 3, "hits": 1, "timeouts": 1, "no_answer": 1}
    for shelf in loop_join.SHELVES:
        assert loop_join.class_of({"shelf": shelf}) in loop_join.CLASSES
        assert loop_join.class_of({"shelf": shelf}) != "other"
    assert loop_join.class_of({"shelf": None}) == "other"


def test_exact_actor_join_with_legs(db: Path) -> None:
    projection = loop_join.project(db, [ROOT, CHILD])
    assert projection["status"] == "joined"
    assert [fire["fire_id"] for fire in projection["fires"]] == ["fire-root", "fire-child"]
    root = projection["fires"][0]
    assert root["actor"] == list(ROOT)
    assert root["delivered"] == "team:piece-1"
    assert root["reason"] == "hit"
    assert "question" not in root
    assert "cwd" not in root
    legs = [(leg["fire_id"], leg["stage"], leg["shelf"], leg["status"], leg["outcome"]) for leg in projection["legs"]]
    assert legs == [("fire-root", 1, "team", "ok", "hit"), ("fire-root", 2, "public", "skipped", None)]
    assert projection["legs"][0]["actor"] == list(ROOT)
    assert "title" not in projection["legs"][0]
    assert "url" not in projection["legs"][0]


def test_wrong_sibling_is_rejected(db: Path) -> None:
    # sib0a's fire never attaches to child01 or the lead, even though all
    # three share the root session.
    projection = loop_join.project(db, [ROOT, CHILD])
    assert [fire["fire_id"] for fire in projection["unmatched_fires"]] == ["fire-sib"]
    assert projection["unmatched_fires"][0]["actor"] == list(SIBLING)
    assert "fire-sib" not in {leg["fire_id"] for leg in projection["legs"]}
    other_harness = loop_join.project(db, [("claude", "sess-other", ""), CHILD])
    assert [fire["fire_id"] for fire in other_harness["fires"]] == ["fire-child"]


def test_native_actor_without_fire_is_kept(db: Path) -> None:
    projection = loop_join.project(db, [ROOT, CHILD, ("claude", SESSION, "grand01")])
    assert len(projection["fires"]) == 2
    assert projection["unmatched_fires"][0]["fire_id"] == "fire-sib"


def test_fire_actor_without_usage_is_an_attribution_error(db: Path) -> None:
    projection = loop_join.project(db, [ROOT])
    assert {fire["fire_id"] for fire in projection["unmatched_fires"]} == {"fire-child", "fire-sib"}


def test_live_wal_refuses_the_join(db: Path) -> None:
    db.with_name("loop.db-wal").write_bytes(b"\x37\x7f\x06\x82" + b"\x00" * 28)
    with pytest.raises(LoopJoinError):
        loop_join.project(db, [ROOT])


def test_an_empty_wal_is_settled(db: Path) -> None:
    # What a reader that opened the ledger without immutable=1 leaves behind: no frames, nothing unsettled.
    db.with_name("loop.db-wal").write_bytes(b"")
    db.with_name("loop.db-shm").write_bytes(b"\x00" * 32)
    assert not loop_join.wal_live(db)
    assert loop_join.project(db, [ROOT])["status"] == "joined"


def test_join_is_read_only_and_leaves_no_side_files(db: Path) -> None:
    before = hashlib.sha256(db.read_bytes()).hexdigest()
    loop_join.project(db, [ROOT, CHILD])
    assert hashlib.sha256(db.read_bytes()).hexdigest() == before
    assert sorted(path.name for path in db.parent.iterdir()) == ["loop.db"]


def test_missing_database_is_unavailable(db: Path) -> None:
    assert loop_join.project(None, [ROOT])["status"] == "unavailable"
    assert loop_join.project(db.with_name("none.db"), [ROOT]) == loop_join.unavailable()


def test_foreign_database_is_an_error(tmp_path: Path) -> None:
    other = tmp_path / "other.db"
    sqlite3.connect(other).close()
    with pytest.raises(LoopJoinError):
        loop_join.project(other, [ROOT])


def test_the_last_keyed_failure_fire_names_its_lane_and_the_keys_leg_verdict(tmp_path: Path) -> None:
    path = tmp_path / "loop.db"
    connection = sqlite3.connect(path)
    connection.executescript(loop_ddl())
    for fire_id, at, key, delivered in (("f1", 1, "aaaaaaaaaaaaaaaa", None), ("f2", 2, "502b90852a1505e3", "keys:piece-7")):
        connection.execute(
            "INSERT INTO fires (id, at, session, agent, arm, harness, event, cwd, wait, deadline_ms, elapsed_ms, reason, question_key, delivered)"
            " VALUES (?, ?, 's', '', 'failure', 'claude', 'tool.after', '', 'sync', 1000, 5, 'hit', ?, ?)",
            (fire_id, at, key, delivered),
        )
    connection.execute("INSERT INTO legs (fire_id, stage, shelf, status, outcome, elapsed_ms) VALUES ('f2', 0, 'local', 'ok', 'no-answer', 1)")
    connection.execute("INSERT INTO legs (fire_id, stage, shelf, status, outcome, elapsed_ms) VALUES ('f2', 0, 'keys', 'ok', 'hit', 40)")
    connection.execute(
        "INSERT INTO pairings (uid, at, session, project, machine, kind, key, scope, status) VALUES ('u', 2, 's', 'p', 'm', 'sig_v1_test', '502b90852a1505e3', 'project', 'open')"
    )
    connection.commit()
    connection.close()
    key = loop_join.project(path, [])["failure_key"]
    assert (key["fire_id"], key["lane"], key["keys_leg_hit"], key["delivered_piece_id"], key["report_file_present"]) == ("f2", "sig_v1_test", True, "piece-7", None)
    assert key["keys_leg"] == {"status": "ok", "outcome": "hit"}
    assert re.match(r"^[0-9a-f]{16}$", key["key_hash"])
    assert "502b90852a1505e3" not in str(key)
    assert loop_join.unavailable()["failure_key"] is None


def test_searches_the_agent_ran_through_the_cli_are_counted_apart_from_the_hooks(tmp_path: Path) -> None:
    path = tmp_path / "loop.db"
    connection = sqlite3.connect(path)
    connection.executescript(loop_ddl())
    rows = [("s1", 1, "cli", "hit"), ("s2", 2, "cli", "miss"), ("s3", 3, "cli", "hit"), ("s4", 4, None, "hit"), ("s5", 5, "hook", "miss")]
    for search_id, at, source, decision in rows:
        connection.execute(
            "INSERT INTO searches (search_id, at, session, question, fingerprint, decision, candidates, source) VALUES (?, ?, 'sess', 'q', 'fp', ?, '[]', ?)",
            (search_id, at, decision, source),
        )
    connection.commit()
    connection.close()
    assert loop_join.project(path, [])["cli_searches"] == {"count": 3, "decisions": {"hit": 2, "miss": 1}}
    assert loop_join.unavailable()["cli_searches"] == {"count": 0, "decisions": {}}
