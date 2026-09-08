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
        self.assertEqual(projection["shelves"], {"team": 2, "public": 0, "keys": 0, "local": 0, "other": 0})
        self.assertEqual(projection["classes"], {"team": 2, "public": 0, "local": 0, "other": 0})
        self.assertEqual(projection["public"], {"legs": 0, "hits": 0, "timeouts": 0, "no_answer": 0})
        empty = loop_join.unavailable()
        self.assertEqual(empty["classes"], {"team": 0, "public": 0, "local": 0, "other": 0})
        self.assertEqual(empty["public"], {"legs": 0, "hits": 0, "timeouts": 0, "no_answer": 0})

    def test_every_shelf_the_product_writes_has_a_class_and_only_an_unknown_one_is_other(self) -> None:
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
        self.assertEqual(loop_join.count_shelves(legs), {"team": 1, "public": 1, "keys": 2, "local": 1, "other": 1})
        self.assertEqual(loop_join.classify(legs), {"team": 1, "public": 3, "local": 1, "other": 1})
        self.assertEqual(loop_join.public_summary(legs), {"legs": 3, "hits": 1, "timeouts": 1, "no_answer": 1})
        for shelf in loop_join.SHELVES:
            self.assertIn(loop_join.class_of({"shelf": shelf}), loop_join.CLASSES)
            self.assertNotEqual(loop_join.class_of({"shelf": shelf}), "other")
        self.assertEqual(loop_join.class_of({"shelf": None}), "other")

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
        wal.write_bytes(b"\x37\x7f\x06\x82" + b"\x00" * 28)
        with self.assertRaises(LoopJoinError):
            loop_join.project(self.db, [ROOT])

    def test_an_empty_wal_is_settled(self) -> None:
        # What a reader that opened the ledger without immutable=1 leaves behind: no frames, nothing unsettled.
        self.db.with_name("loop.db-wal").write_bytes(b"")
        self.db.with_name("loop.db-shm").write_bytes(b"\x00" * 32)
        self.assertFalse(loop_join.wal_live(self.db))
        self.assertEqual(loop_join.project(self.db, [ROOT])["status"], "joined")

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



class FailureKeyTest(unittest.TestCase):
    def test_the_last_keyed_failure_fire_names_its_lane_and_the_keys_leg_verdict(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "loop.db"
            db = sqlite3.connect(path)
            db.executescript(loop_ddl())
            for fire_id, at, key, delivered in (("f1", 1, "aaaaaaaaaaaaaaaa", None), ("f2", 2, "502b90852a1505e3", "keys:piece-7")):
                db.execute(
                    "INSERT INTO fires (id, at, session, agent, arm, harness, event, cwd, wait, deadline_ms, elapsed_ms, reason, question_key, delivered)"
                    " VALUES (?, ?, 's', '', 'failure', 'claude', 'tool.after', '', 'sync', 1000, 5, 'hit', ?, ?)",
                    (fire_id, at, key, delivered),
                )
            db.execute("INSERT INTO legs (fire_id, stage, shelf, status, outcome, elapsed_ms) VALUES ('f2', 0, 'local', 'ok', 'no-answer', 1)")
            db.execute("INSERT INTO legs (fire_id, stage, shelf, status, outcome, elapsed_ms) VALUES ('f2', 0, 'keys', 'ok', 'hit', 40)")
            db.execute(
                "INSERT INTO pairings (uid, at, session, project, machine, kind, key, scope, status) VALUES ('u', 2, 's', 'p', 'm', 'sig_v1_test', '502b90852a1505e3', 'project', 'open')"
            )
            db.commit()
            db.close()
            key = loop_join.project(path, [])["failure_key"]
            self.assertEqual((key["fire_id"], key["lane"], key["keys_leg_hit"], key["delivered_piece_id"], key["report_file_present"]), ("f2", "sig_v1_test", True, "piece-7", None))
            self.assertEqual(key["keys_leg"], {"status": "ok", "outcome": "hit"})
            self.assertRegex(key["key_hash"], r"^[0-9a-f]{16}$")
            self.assertNotIn("502b90852a1505e3", str(key))
            self.assertIsNone(loop_join.unavailable()["failure_key"])


class CliSearchesTest(unittest.TestCase):
    def test_searches_the_agent_ran_through_the_cli_are_counted_apart_from_the_hooks(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "loop.db"
            db = sqlite3.connect(path)
            db.executescript(loop_ddl())
            rows = [("s1", 1, "cli", "hit"), ("s2", 2, "cli", "miss"), ("s3", 3, "cli", "hit"), ("s4", 4, None, "hit"), ("s5", 5, "hook", "miss")]
            for search_id, at, source, decision in rows:
                db.execute(
                    "INSERT INTO searches (search_id, at, session, question, fingerprint, decision, candidates, source) VALUES (?, ?, 'sess', 'q', 'fp', ?, '[]', ?)",
                    (search_id, at, decision, source),
                )
            db.commit()
            db.close()
            projected = loop_join.project(path, [])
            self.assertEqual(projected["cli_searches"], {"count": 3, "decisions": {"hit": 2, "miss": 1}})
            self.assertEqual(loop_join.unavailable()["cli_searches"], {"count": 0, "decisions": {}})


if __name__ == "__main__":
    unittest.main()
