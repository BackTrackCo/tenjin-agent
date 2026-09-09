"""The per-run corpus reading: what it hashes, what it ignores, and where it lands."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from typing import Any

from evals.benchmark import report, snapshot

ORIGIN = "bench.tenjin.sh"


def piece(identifier: str, **overrides: Any) -> dict[str, Any]:
    row = {
        "id": identifier,
        "slug": f"slug-{identifier}",
        "title": f"Piece {identifier}",
        "price": "50000",
        "publishedAt": "2026-09-09T00:00:00.000Z",
        "updatedAt": "2026-09-09T00:00:00.000Z",
        "excerpt": "the first paragraph",
        "reads": 3,
        "creator": {"handle": "athoughts"},
    }
    return {**row, **overrides}


class FakeCatalog:
    """Pages handed back in order, so a walk and its cursors are what a case controls."""

    def __init__(self, pages: list[dict[str, Any]]) -> None:
        self.pages = pages
        self.asked: list[str | None] = []

    def page(self, origin: str, cursor: str | None) -> dict[str, Any]:
        self.asked.append(cursor)
        return self.pages[len(self.asked) - 1]


class DigestTest(unittest.TestCase):
    def test_the_hash_is_over_the_pieces_and_not_over_their_order(self) -> None:
        one = snapshot.digest([piece("a"), piece("b")])
        self.assertEqual(one, snapshot.digest([piece("b"), piece("a")]))

    def test_a_read_count_or_an_excerpt_never_moves_the_hash(self) -> None:
        self.assertEqual(
            snapshot.digest([piece("a")]),
            snapshot.digest([piece("a", reads=99, excerpt="edited by the feed")]),
        )

    def test_an_edited_piece_moves_the_hash(self) -> None:
        self.assertNotEqual(snapshot.digest([piece("a")]), snapshot.digest([piece("a", title="Piece a, revised")]))

    def test_a_piece_added_moves_the_hash(self) -> None:
        self.assertNotEqual(snapshot.digest([piece("a")]), snapshot.digest([piece("a"), piece("b")]))


class TakeTest(unittest.TestCase):
    def test_a_walk_follows_the_cursor_to_the_end_and_counts_every_page(self) -> None:
        catalog = FakeCatalog(
            [
                {"items": [piece("a"), piece("b")], "nextCursor": "page-2"},
                {"items": [piece("c")], "nextCursor": None},
            ]
        )
        taken = snapshot.take(ORIGIN, catalog, now=lambda: "2026-09-09T12:00:00Z")
        self.assertEqual((taken.origin, taken.posts, taken.taken_at), (ORIGIN, 3, "2026-09-09T12:00:00Z"))
        self.assertEqual(catalog.asked, [None, "page-2"])
        self.assertEqual(taken.content_hash, snapshot.digest([piece("a"), piece("b"), piece("c")]))

    def test_an_empty_corpus_is_a_reading_and_not_a_refusal(self) -> None:
        taken = snapshot.take(ORIGIN, FakeCatalog([{"items": [], "nextCursor": None}]), now=lambda: "2026-09-09T12:00:00Z")
        self.assertEqual(taken.posts, 0)

    def test_a_feed_that_never_stops_is_refused_rather_than_walked_forever(self) -> None:
        catalog = FakeCatalog([{"items": [piece("a")], "nextCursor": "more"}] * (snapshot.MAX_PAGES + 1))
        with self.assertRaises(snapshot.SnapshotError) as caught:
            snapshot.take(ORIGIN, catalog)
        self.assertEqual(caught.exception.code, "feed_unbounded")

    def test_a_body_that_is_not_a_listing_is_refused(self) -> None:
        with self.assertRaises(snapshot.SnapshotError) as caught:
            snapshot.take(ORIGIN, FakeCatalog([{"error": "not found"}]))
        self.assertEqual(caught.exception.code, "feed_unreadable")


class OnceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.run_dir = Path(self.tmp.name) / "run"

    def test_the_run_reads_the_corpus_once_however_often_it_asks(self) -> None:
        catalog = FakeCatalog([{"items": [piece("a")], "nextCursor": None}])
        once = snapshot.Once(self.run_dir, ORIGIN, catalog)
        first = once.fire()
        self.assertEqual(once.fire(), first)
        self.assertEqual(len(catalog.asked), 1)
        self.assertEqual(json.loads((self.run_dir / snapshot.FILE).read_text(encoding="utf-8")), first)

    def test_a_reading_that_fails_is_recorded_and_does_not_raise(self) -> None:
        class Broken:
            def page(self, origin: str, cursor: str | None) -> dict[str, Any]:
                raise snapshot.SnapshotError("feed_unreachable", f"{origin}: URLError")

        result = snapshot.Once(self.run_dir, ORIGIN, Broken()).fire()
        self.assertEqual(result["error"], "feed_unreachable")
        self.assertEqual(snapshot.read(self.run_dir), result)

    def test_a_run_that_recorded_nothing_reads_back_as_nothing(self) -> None:
        self.assertIsNone(snapshot.read(self.run_dir))


class ReportFieldsTest(unittest.TestCase):
    """What the reading may say in public: `report.guard` refuses a private string."""

    def test_the_publishable_projection_drops_the_private_detail(self) -> None:
        fields = report.snapshot_fields(
            {"origin": ORIGIN, "error": "feed_unreachable", "detail": "bench.tenjin.sh: URLError"}
        )
        self.assertEqual(fields, {"origin": ORIGIN, "error": "feed_unreachable"})
        report.guard({"corpus_snapshot": fields})

    def test_a_reading_passes_the_redaction_guard(self) -> None:
        taken = snapshot.take(ORIGIN, FakeCatalog([{"items": [piece("a")], "nextCursor": None}]))
        report.guard({"corpus_snapshot": report.snapshot_fields(taken.__dict__)})

    def test_no_reading_is_no_field(self) -> None:
        self.assertIsNone(report.snapshot_fields(None))


if __name__ == "__main__":
    unittest.main()
