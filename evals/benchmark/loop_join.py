"""Read-only projection of a stopped trial's loop.db onto exact actor keys.

Loop 2 owns delivery facts (`fires`, `legs`). The benchmark reads them after
the trial stops and joins on the exact `(session, agent)`; it never writes and
never infers ancestry. A live WAL means settlement is incomplete, so the join
refuses rather than copying only the main file.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any

from .usage import ActorKey


class LoopJoinError(RuntimeError):
    pass


def project(loop_db: Path | None, actors: list[ActorKey]) -> dict[str, Any]:
    if loop_db is None or not loop_db.is_file():
        return {"status": "unavailable", "fires": [], "legs": []}
    wal = loop_db.with_name(loop_db.name + "-wal")
    if wal.exists() and wal.stat().st_size > 0:
        raise LoopJoinError("loop.db WAL is live: settlement has not completed")
    wanted = {(session, agent) for _harness, session, agent in actors}
    fires: list[dict[str, Any]] = []
    legs: list[dict[str, Any]] = []
    connection = sqlite3.connect(f"file:{loop_db}?mode=ro", uri=True)
    try:
        connection.row_factory = sqlite3.Row
        for row in connection.execute("SELECT id, session, agent, harness, event FROM fires"):
            if (row["session"], row["agent"]) not in wanted:
                continue
            fires.append({"fire_id": row["id"], "actor": [row["harness"], row["session"], row["agent"]]})
            for leg in connection.execute(
                "SELECT stage, shelf, status, outcome FROM legs WHERE fire_id = ?", (row["id"],)
            ):
                legs.append({"fire_id": row["id"], **dict(leg)})
    finally:
        connection.close()
    return {"status": "joined", "fires": fires, "legs": legs}
