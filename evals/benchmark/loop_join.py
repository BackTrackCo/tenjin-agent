"""Read-only projection of a stopped trial's loop.db onto exact actor keys.

Loop 2 owns delivery facts (`fires`, `legs` in src/hooks/store.ts). The
benchmark reads them after the trial stops and joins each fire to the exact
`(harness, session, agent)` it was recorded under; a sibling with another
agent id never receives it, and no ancestry is inferred. A `-wal` file means
the daemon has not settled, so the join refuses rather than reading a main
file that is missing the WAL's frames. The connection is `mode=ro` plus
`immutable=1`, which also keeps SQLite from creating `-wal`/`-shm` files in a
directory the benchmark only reads.
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


SHELVES = ("team", "public")
# A leg the product planned but never sent: public fallback off, or a stage
# the arm dropped. It reached no origin, so it is not a request.
SKIPPED = "skipped"


def unavailable() -> dict[str, Any]:
    return {"status": "unavailable", "fires": [], "legs": [], "unmatched_fires": [], "shelves": count_shelves([])}


def count_shelves(legs: list[dict[str, Any]]) -> dict[str, int]:
    """How many legs went to each shelf. The public count is what the sentinel reads."""
    counts = {shelf: 0 for shelf in SHELVES}
    for leg in legs:
        shelf = leg.get("shelf")
        if shelf in counts and leg.get("status") != SKIPPED:
            counts[shelf] += 1
    return counts


def project(loop_db: Path | None, actors: list[ActorKey]) -> dict[str, Any]:
    """Fires and legs for exactly these actors, plus fires for actors that are not in the set.

    `unmatched_fires` is an attribution error for the caller: Loop 2 recorded
    a fire for an actor the harness never exposed usage for, which is not a
    zero-token actor.
    """
    if loop_db is None or not loop_db.is_file():
        return unavailable()
    if loop_db.with_name(loop_db.name + "-wal").exists():
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
    finally:
        connection.close()
    return {"status": "joined", "fires": fires, "legs": legs, "unmatched_fires": unmatched, "shelves": count_shelves(legs)}
