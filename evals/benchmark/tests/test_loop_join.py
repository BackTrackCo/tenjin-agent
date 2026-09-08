"""loop.db projection: read-only, WAL-refusing, joined on the exact actor key."""

from __future__ import annotations

import hashlib
import sqlite3
import tempfile
import unittest
from pathlib import Path

from evals.benchmark import loop_join
from evals.benchmark.loop_join import LoopJoinError
from evals.benchmark.tests.support import loop_ddl

SESSION = "sess-family"
ROOT = ("claude", SESSION, "")
CHILD = ("claude", SESSION, "child01")
SIBLING = ("claude", SESSION, "sib0a")


def build(path: Path) -> None:
    db = sqlite3.connect(path)
    db.executescript(loop_ddl())
    fires = [
        ("fire-root", 1, SESSION, "", "prompt", "claude", "prompt", "p1", "hit", "team:piece-1"),
        ("fire-child", 2, SESSION, "child01", "prompt", "claude", "prompt", "p2", "miss", None),
        ("fire-sib", 3, SESSION, "sib0a", "prompt", "claude", "prompt", "p3", "hit", "team:piece-2"),
    ]
    for fire in fires:
        db.execute(
            "INSERT INTO fires (id, at, session, agent, arm, harness, event, prompt_id, reason, delivered, cwd, wait, deadline_ms, elapsed_ms, question)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '/private/host/path', 'sync', 1000, 12, 'private question text')",
            fire,
        )
    db.execute(
        "INSERT INTO legs (fire_id, stage, shelf, status, outcome, elapsed_ms, search_id, title, url, form, calibration)"
        " VALUES ('fire-root', 1, 'team', 'ok', 'hit', 10, 'search-1', 'private title', 'https://example.test/private', 'answer', 'calibrated')"
    )
    db.execute(
        "INSERT INTO legs (fire_id, stage, shelf, status, outcome, elapsed_ms) VALUES ('fire-root', 2, 'public', 'skipped', NULL, 0)"
    )
    db.execute("INSERT INTO legs (fire_id, stage, shelf, status, outcome, elapsed_ms) VALUES ('fire-sib', 1, 'team', 'ok', 'hit', 5)")
    db.commit()
    db.close()


class LoopJoinTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.db = Path(self.tmp.name) / "loop.db"
        build(self.db)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_legs_are_counted_per_shelf_and_a_skipped_leg_is_not_a_request(self) -> None:
        projection = loop_join.project(self.db, [ROOT, CHILD, SIBLING])
        # Two team legs went out; the public leg was planned and dropped.
        self.assertEqual(projection["shelves"], {"team": 2, "public": 0, "other": 0})
        self.assertEqual(loop_join.unavailable()["shelves"], {"team": 0, "public": 0, "other": 0})
        self.assertEqual(loop_join.count_shelves([{"shelf": "public", "status": "ok"}, {"shelf": "mirror", "status": "ok"}]), {"team": 0, "public": 1, "other": 1})

    def test_exact_actor_join_with_legs(self) -> None:
        projection = loop_join.project(self.db, [ROOT, CHILD])
        self.assertEqual(projection["status"], "joined")
        self.assertEqual([fire["fire_id"] for fire in projection["fires"]], ["fire-root", "fire-child"])
        root = projection["fires"][0]
        self.assertEqual(root["actor"], list(ROOT))
        self.assertEqual(root["delivered"], "team:piece-1")
        self.assertEqual(root["reason"], "hit")
        self.assertNotIn("question", root)
        self.assertNotIn("cwd", root)
        legs = [(leg["fire_id"], leg["stage"], leg["shelf"], leg["status"], leg["outcome"]) for leg in projection["legs"]]
        self.assertEqual(legs, [("fire-root", 1, "team", "ok", "hit"), ("fire-root", 2, "public", "skipped", None)])
        self.assertEqual(projection["legs"][0]["actor"], list(ROOT))
        self.assertNotIn("title", projection["legs"][0])
        self.assertNotIn("url", projection["legs"][0])

    def test_wrong_sibling_is_rejected(self) -> None:
        # sib0a's fire never attaches to child01 or the lead, even though all
        # three share the root session.
        projection = loop_join.project(self.db, [ROOT, CHILD])
        self.assertEqual([fire["fire_id"] for fire in projection["unmatched_fires"]], ["fire-sib"])
        self.assertEqual(projection["unmatched_fires"][0]["actor"], list(SIBLING))
        self.assertNotIn("fire-sib", {leg["fire_id"] for leg in projection["legs"]})
        other_harness = loop_join.project(self.db, [("claude", "sess-other", ""), CHILD])
        self.assertEqual([fire["fire_id"] for fire in other_harness["fires"]], ["fire-child"])

    def test_native_actor_without_fire_is_kept(self) -> None:
        grandchild = ("claude", SESSION, "grand01")
        projection = loop_join.project(self.db, [ROOT, CHILD, grandchild])
        self.assertEqual(len(projection["fires"]), 2)
        self.assertEqual(projection["unmatched_fires"][0]["fire_id"], "fire-sib")

    def test_fire_actor_without_usage_is_an_attribution_error(self) -> None:
        projection = loop_join.project(self.db, [ROOT])
        self.assertEqual({fire["fire_id"] for fire in projection["unmatched_fires"]}, {"fire-child", "fire-sib"})

    def test_live_wal_refuses_the_join(self) -> None:
        wal = self.db.with_name("loop.db-wal")
        wal.write_bytes(b"")
        with self.assertRaises(LoopJoinError):
            loop_join.project(self.db, [ROOT])

    def test_join_is_read_only_and_leaves_no_side_files(self) -> None:
        before = hashlib.sha256(self.db.read_bytes()).hexdigest()
        loop_join.project(self.db, [ROOT, CHILD])
        self.assertEqual(hashlib.sha256(self.db.read_bytes()).hexdigest(), before)
        self.assertEqual(sorted(path.name for path in Path(self.tmp.name).iterdir()), ["loop.db"])

    def test_missing_database_is_unavailable(self) -> None:
        self.assertEqual(loop_join.project(None, [ROOT])["status"], "unavailable")
        self.assertEqual(loop_join.project(self.db.with_name("none.db"), [ROOT]), loop_join.unavailable())

    def test_foreign_database_is_an_error(self) -> None:
        other = Path(self.tmp.name) / "other.db"
        sqlite3.connect(other).close()
        with self.assertRaises(LoopJoinError):
            loop_join.project(other, [ROOT])


if __name__ == "__main__":
    unittest.main()
