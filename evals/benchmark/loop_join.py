"""Read-only projection of a stopped trial's loop.db onto exact actor keys.

Loop 2 owns delivery facts (`fires`, `legs` in src/hooks/store.ts). The
benchmark reads them after the trial stops and joins each fire to the exact
`(harness, session, agent)` it was recorded under; a sibling with another
agent id never receives it, and no ancestry is inferred. A `-wal` file with
frames in it means the daemon has not settled, so the join refuses rather
than reading a main file that is missing them; a zero-byte `-wal` holds no
frames and is what any SQLite reader that opened the ledger without
`immutable=1` leaves behind, so it reads as settled. The connection here is
`mode=ro` plus `immutable=1`, which also keeps SQLite from creating
`-wal`/`-shm` files in a directory the benchmark only reads; every reader of
a trial ledger has to open it that way.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any

from .usage import ActorKey

STATUSES = frozenset({"unavailable", "joined"})
FIRE_COLUMNS = ("id", "at", "session", "agent", "harness", "arm", "event", "prompt_id", "reason", "delivered")
LEG_COLUMNS = ("fire_id", "stage", "shelf", "status", "outcome", "search_id", "form", "calibration")


class LoopJoinError(RuntimeError):
    pass


# The product's own `Shelf` union (src/hooks/types.ts): the team shelf, the
# public marketplace, the keys leg the public marketplace also serves, and the
# local leg that never leaves the process. Anything else is `other`.
SHELVES = ("team", "public", "keys", "local")
# What each leg is as a request. Under a seeded config the reachable set is
# known by construction: `team` is the seeded shelf, `public` is the public
# marketplace host and covers the keys leg too, `local` reaches nothing, and
# `other` is an origin outside that set, which is the only class the
# public-request sentinel counts.
CLASSES = ("team", "public", "local", "other")
CLASS_OF = {"team": "team", "public": "public", "keys": "public", "local": "local"}
# A leg the product planned but never sent: public fallback off, or a stage
# the arm dropped. It reached no origin, so it is not a request.
SKIPPED = "skipped"
TIMEOUT = "timeout"
HIT = "hit"
NO_ANSWER = "no-answer"
# A search the agent ran by hand through the CLI (`tenjin search`), which the
# product stores with `source = 'cli'`; the hooks' own legs are `fires` and
# `legs`. Counted and costed apart, so a manual search is visible.
CLI_SOURCE = "cli"


def wal_live(loop_db: Path) -> bool:
    """A `-wal` beside the ledger with frames in it. A zero-byte one is a reader's residue, not an unsettled daemon."""
    wal = loop_db.with_name(loop_db.name + "-wal")
    return wal.exists() and wal.stat().st_size > 0


def unavailable() -> dict[str, Any]:
    return {
        "status": "unavailable",
        "fires": [],
        "legs": [],
        "unmatched_fires": [],
        "shelves": count_shelves([]),
        "classes": classify([]),
        "public": public_summary([]),
        "cli_searches": {"count": 0, "decisions": {}},
    }


def cli_searches(connection: sqlite3.Connection) -> dict[str, Any]:
    """How many searches the agent ran through the CLI, by the product's own decision column."""
    decisions: dict[str, int] = {}
    try:
        rows = connection.execute("SELECT decision FROM searches WHERE source = ? ORDER BY at", (CLI_SOURCE,)).fetchall()
    except sqlite3.Error:
        return {"count": 0, "decisions": {}}
    for row in rows:
        decision = str(row[0])
        decisions[decision] = decisions.get(decision, 0) + 1
    return {"count": len(rows), "decisions": decisions}


def _sent(legs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [leg for leg in legs if leg.get("status") != SKIPPED]


def class_of(leg: dict[str, Any]) -> str:
    return CLASS_OF.get(leg.get("shelf"), "other")  # type: ignore[arg-type]


def count_shelves(legs: list[dict[str, Any]]) -> dict[str, int]:
    """How many legs went to each shelf value the product writes, plus `other`."""
    counts = {shelf: 0 for shelf in (*SHELVES, "other")}
    for leg in _sent(legs):
        shelf = leg.get("shelf")
        counts[shelf if shelf in counts else "other"] += 1
    return counts


def classify(legs: list[dict[str, Any]]) -> dict[str, int]:
    """How many legs fell in each request class. `other` is what the sentinel reads."""
    counts = {name: 0 for name in CLASSES}
    for leg in _sent(legs):
        counts[class_of(leg)] += 1
    return counts


def public_summary(legs: list[dict[str, Any]]) -> dict[str, int]:
    """The public-origin legs, counted the way the canary gate reads them.

    `legs` is how many requests reached the public marketplace (public and
    keys legs), `hits` how many came back with a piece, `timeouts` how many
    the product gave up waiting on, and `no_answer` how many ended without
    an answer of any kind, the outcome a timeout usually pairs with.
    """
    public = [leg for leg in _sent(legs) if class_of(leg) == "public"]
    return {
        "legs": len(public),
        "hits": sum(1 for leg in public if leg.get("outcome") == HIT),
        "timeouts": sum(1 for leg in public if leg.get("status") == TIMEOUT),
        "no_answer": sum(1 for leg in public if leg.get("outcome") == NO_ANSWER),
    }


def project(loop_db: Path | None, actors: list[ActorKey]) -> dict[str, Any]:
    """Fires and legs for exactly these actors, plus fires for actors that are not in the set.

    `unmatched_fires` is an attribution error for the caller: Loop 2 recorded
    a fire for an actor the harness never exposed usage for, which is not a
    zero-token actor.
    """
    if loop_db is None or not loop_db.is_file():
        return unavailable()
    if wal_live(loop_db):
        raise LoopJoinError("loop.db WAL is live: settlement has not completed")
    wanted = set(actors)
    fires: list[dict[str, Any]] = []
    legs: list[dict[str, Any]] = []
    unmatched: list[dict[str, Any]] = []
    uri = f"file:{loop_db.resolve().as_posix()}?mode=ro&immutable=1"
    try:
        connection = sqlite3.connect(uri, uri=True)
    except sqlite3.Error as error:
        raise LoopJoinError(f"cannot open loop.db read-only: {error}") from error
    try:
        connection.row_factory = sqlite3.Row
        try:
            rows = connection.execute(f"SELECT {', '.join(FIRE_COLUMNS)} FROM fires ORDER BY at, id").fetchall()
        except sqlite3.Error as error:
            raise LoopJoinError(f"loop.db has no readable fires table: {error}") from error
        for row in rows:
            actor: ActorKey = (row["harness"], row["session"], row["agent"])
            fire = {
                "fire_id": row["id"],
                "actor": list(actor),
                "at": row["at"],
                "event": row["event"],
                "hook_arm": row["arm"],
                "prompt_id": row["prompt_id"],
                "reason": row["reason"],
                "delivered": row["delivered"],
            }
            if actor not in wanted:
                unmatched.append(fire)
                continue
            fires.append(fire)
            for leg in connection.execute(
                f"SELECT {', '.join(LEG_COLUMNS)} FROM legs WHERE fire_id = ? ORDER BY stage, shelf", (row["id"],)
            ):
                legs.append({**dict(leg), "actor": list(actor)})
        searches = cli_searches(connection)
    finally:
        connection.close()
    return {
        "status": "joined",
        "fires": fires,
        "legs": legs,
        "unmatched_fires": unmatched,
        "shelves": count_shelves(legs),
        "classes": classify(legs),
        "public": public_summary(legs),
        "cli_searches": searches,
    }
