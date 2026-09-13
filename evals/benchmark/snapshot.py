"""Which corpus produced a number: how many pieces stood on the shelf, and which ones.

A run resets its corpus branch and then seeds it, so what a trial searched
against is a fact about the run rather than about the deployment. The reset
stamp (`corpus.py`) says which branch was emptied and when; this says what was
standing on it once the run's own seed had landed. Without it a reader of a
published ratio can tell that the corpus was reset and not what was in it.

Taken once per run, from the public discovery feed the deployment already
serves, so it needs no credential and no database. The hash is over a fixed
projection of every listed piece in id order, so neither page order nor the
read counts the feed folds on can move it.

A snapshot that fails is recorded as a refusal and does not end the run: the
reset is the gate that protects the measurement, and this is the readout beside
it.
"""

from __future__ import annotations

import hashlib
import json
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Protocol

FILE = "corpus-snapshot.json"
PATH = "/api/articles?sort=oldest&limit=50"
# Every field of a listed piece that is a property of the piece. The feed also
# carries a public read count, which moves whenever anyone reads, and an
# excerpt derived from the body; neither belongs in an identity hash.
FIELDS = ("id", "slug", "title", "price", "publishedAt", "updatedAt")
# A walk, not a stream: the corpus is tens of pieces, and a feed that never
# stops handing out cursors is a refusal rather than an unbounded read.
MAX_PAGES = 40
TIMEOUT_S = 20.0


class SnapshotError(RuntimeError):
    """A readout that did not happen, named by its gate."""

    def __init__(self, code: str, detail: str) -> None:
        super().__init__(f"{code}: {detail}")
        self.code = code
        self.detail = detail


@dataclass(frozen=True)
class Snapshot:
    """The corpus a run measured: how many pieces, and a hash naming which."""

    origin: str
    posts: int
    content_hash: str
    taken_at: str


class Catalog(Protocol):
    """The seam. One call, so every test runs against a fake rather than a shelf."""

    def page(self, origin: str, cursor: str | None) -> dict[str, Any]: ...





def projection(item: Any) -> dict[str, Any]:
    if not isinstance(item, dict):
        raise SnapshotError("feed_unreadable", "a listed piece is not an object")
    return {field: item.get(field) for field in FIELDS}


def digest(items: list[Any]) -> str:
    """The corpus hash: the projections in id order, canonically encoded."""
    rows = sorted((projection(item) for item in items), key=lambda row: str(row["id"]))
    return "sha256:" + hashlib.sha256(json.dumps(rows, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


def take(origin: str, catalog: Catalog, *, now: Any = None) -> Snapshot:
    """Walk the feed to its end and hash what it listed."""
    items: list[Any] = []
    cursor: str | None = None
    for _ in range(MAX_PAGES):
        payload = catalog.page(origin, cursor)
        if not isinstance(payload, dict) or not isinstance(payload.get("items"), list):
            raise SnapshotError("feed_unreadable", f"{origin} listed no items array")
        items.extend(payload["items"])
        cursor = payload.get("nextCursor") or None
        if cursor is None:
            stamp = (now or (lambda: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())))()
            return Snapshot(origin=origin, posts=len(items), content_hash=digest(items), taken_at=stamp)
        if not isinstance(cursor, str):
            raise SnapshotError("feed_unreadable", f"{origin} handed back a cursor that is not a string")
    raise SnapshotError("feed_unbounded", f"{origin} handed out more than {MAX_PAGES} pages")


class Once:
    """The run's one snapshot: taken the first time the run asks, written where the report reads it.

    The runner asks after the first seed has reached the shelf, so the count is
    the corpus the trials actually searched. Every later ask is a no-op, because
    a run has one corpus and a per-trial reading would be a different fact.
    """

    def __init__(self, run_dir: Path, origin: str, catalog: Catalog) -> None:
        self.run_dir = run_dir
        self.origin = origin
        self.catalog: Catalog = catalog
        self.result: dict[str, Any] | None = None

    def fire(self) -> dict[str, Any]:
        if self.result is not None:
            return self.result
        try:
            self.result = asdict(take(self.origin, self.catalog))
        except SnapshotError as error:
            self.result = {"origin": self.origin, "error": error.code, "detail": error.detail}
        self.run_dir.mkdir(parents=True, exist_ok=True)
        (self.run_dir / FILE).write_text(json.dumps(self.result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        return self.result


def read(run_dir: Path) -> dict[str, Any] | None:
    """What a run recorded, for `report` and `summary`, which run long after it."""
    path = run_dir / FILE
    if not path.is_file():
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None
