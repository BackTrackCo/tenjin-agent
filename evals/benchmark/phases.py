"""What an attempt's own model requests were spent on: the task, the turn-end nudge, a CLI search.

An attempt's token total is one number, and the pilot showed that number is not
one thing. In a Tenjin attempt the Stop hook fires `turn.end`, the daemon
answers with the capture ask, and the harness spends one more model request on
it; the primer sometimes tells the agent to run `tenjin search` in a Bash tool,
and the turn that carries those results back costs another. Both are the
product working as shipped. Neither is retrieval, and inferring either from a
transcript afterwards is guesswork.

So the attempt records the split. The rule is the store's own marks, never a
heuristic over the text:

- `nudge` is every request whose first timestamp is at or after the session's
  first `turn.end` fire. That fire is the Stop hook; what the model does after
  it is the capture ask's cost.
- `cli_search` is the first request at or after each CLI search row for the
  session, when that request is not already the nudge's. One request per
  search: the turn that carried the results back.
- `consumer` is everything else, which is the task.

The three are a partition of the attempt's own usage: they sum to it exactly,
which `records.validate` and the reducer both rely on. A request the transcript
gave no timestamp, and every request of an arm with no store, falls to
`consumer`, so an arm without hooks reads as all task and nothing else.

This is a decomposition, never a headline. `reduce` carries the subtracted
totals beside the real ones and labels them; the number to quote as Tenjin is
the one with the product as shipped.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import usage
from .loop_join import CLI_SOURCE

CONSUMER = "consumer"
NUDGE = "nudge"
SEARCH = "cli_search"
PHASES = (CONSUMER, NUDGE, SEARCH)
TURN_END = "turn.end"


@dataclass(frozen=True)
class Marks:
    """The store's own timestamps for one session: when the turn ended, and when the agent searched."""

    turn_end_at: int | None = None
    searches: tuple[int, ...] = field(default_factory=tuple)

    @property
    def known(self) -> bool:
        return self.turn_end_at is not None or bool(self.searches)


def read_marks(loop_db: Path, session: str) -> Marks:
    """The session's first `turn.end` fire and every CLI search, or empty marks when there is no store.

    Read-only and immutable, like every other read of a settled `loop.db`; a
    store that cannot be read leaves the attempt undecomposed rather than
    invalid, because this is a diagnostic and never the outcome.
    """
    if not loop_db.is_file():
        return Marks()
    uri = f"file:{loop_db.resolve().as_posix()}?mode=ro&immutable=1"
    try:
        connection = sqlite3.connect(uri, uri=True)
    except sqlite3.Error:
        return Marks()
    try:
        ends = connection.execute("SELECT at FROM fires WHERE session = ? AND event = ? ORDER BY at LIMIT 1", (session, TURN_END)).fetchall()
        searches = connection.execute("SELECT at FROM searches WHERE session = ? AND source = ? ORDER BY at", (session, CLI_SOURCE)).fetchall()
    except sqlite3.Error:
        return Marks()
    finally:
        connection.close()
    return Marks(turn_end_at=None if not ends else int(ends[0][0]), searches=tuple(int(row[0]) for row in searches))


def empty() -> dict[str, dict[str, int]]:
    return {phase: {"requests": 0, "input_total": 0, "output_total": 0} for phase in PHASES}


def split(records: list[usage.UsageRecord], times: dict[str, int], marks: Marks) -> dict[str, dict[str, int]]:
    """The attempt's own usage, partitioned. Ordered by request time, so "the first request after" is decidable."""
    out = empty()
    ordered = sorted(records, key=lambda record: (times.get(record.native_request_id) is None, times.get(record.native_request_id, 0)))
    claimed: set[str] = set()
    for at in marks.searches:
        for record in ordered:
            when = times.get(record.native_request_id)
            if when is None or when < at or record.native_request_id in claimed:
                continue
            if marks.turn_end_at is not None and when >= marks.turn_end_at:
                break
            claimed.add(record.native_request_id)
            break
    for record in ordered:
        when = times.get(record.native_request_id)
        if marks.turn_end_at is not None and when is not None and when >= marks.turn_end_at:
            phase = NUDGE
        elif record.native_request_id in claimed:
            phase = SEARCH
        else:
            phase = CONSUMER
        out[phase]["requests"] += 1
        out[phase]["input_total"] += record.input_total
        out[phase]["output_total"] += record.output_total
    return out


def tokens(block: dict[str, Any] | None, *names: str) -> int:
    """The tokens of the named phases, zero when the attempt carries no decomposition."""
    if not isinstance(block, dict):
        return 0
    total = 0
    for name in names:
        entry = block.get(name)
        if isinstance(entry, dict):
            total += int(entry.get("input_total", 0)) + int(entry.get("output_total", 0))
    return total
