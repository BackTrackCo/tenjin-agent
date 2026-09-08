"""Seed the trial's own store through the product's write path.

The product's local record is the `pairings` table in `loop.db`: the failure
arm opens a row when a command fails under a key the signature lanes derive,
and closes it when the same agent, having edited a tracked file since, passes
the same command again (`src/hooks/failure/pairings.ts`). A later failure under
the same key in the same project is answered by that row on the `local` leg.
Nothing else writes those rows: no CLI verb, no daemon route, no config. So
the only honest way to pre-populate the store is the way a producer session
does it, which is to send the daemon the hook events that session would have
sent, with the real failure output the fixture's command prints, and let the
daemon's own code write the rows. This module does exactly that and nothing
more: it never opens `loop.db` for writing.

What it cannot seed, it says. A lesson whose fix is a different command (the
test-harness convention: `node tests/x` fails, `pnpm exec vitest run` passes)
has no local record in the product, because a pairing closes only on a pass
with the same command head, so such a lesson is reported `unseedable` rather
than faked.
"""

from __future__ import annotations

import json
import hashlib
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from . import FIXTURES, sha256_text

DISTRACTORS = FIXTURES / "live" / "distractors.json"
DISTRACTOR_KEYS = frozenset({"id", "command", "file", "error"})
EVENT_TIMEOUT_S = 15.0
# The daemon stamps rows with its own clock in milliseconds; two events inside
# one millisecond would let a close read as older than its open.
EVENT_GAP_S = 0.005
PASS_OUTPUT = " ✓ {test} (1 test)\n\n Test Files  1 passed (1)\n      Tests  1 passed (1)\n"
SEED_SESSION_SUFFIX = ":seed"
STATUSES = ("open", "unverified", "verified")


class LocalSeedError(RuntimeError):
    pass


def project_id(cwd: str) -> str:
    """The product's `projectId`: sha256 of the cwd string, first 16 hex characters (`src/hooks/failure/keys.ts`)."""
    return hashlib.sha256(cwd.encode("utf-8")).hexdigest()[:16]


@dataclass(frozen=True)
class Replay:
    """One producer-shaped session talking to the trial's daemon."""

    url: str
    token: str
    session: str
    cwd: str
    transcript: str
    sleep: Callable[[float], None] = time.sleep
    calls: list[dict[str, Any]] = field(default_factory=list)

    def post(self, payload: dict[str, Any]) -> int:
        body = json.dumps({"session_id": self.session, "cwd": self.cwd, "transcript_path": self.transcript, **payload}).encode("utf-8")
        request = urllib.request.Request(
            self.url, data=body, method="POST", headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"}
        )
        try:
            with urllib.request.urlopen(request, timeout=EVENT_TIMEOUT_S) as response:
                status = int(response.status)
        except urllib.error.HTTPError as error:
            status = int(error.code)
        except (urllib.error.URLError, OSError) as error:
            raise LocalSeedError(f"the daemon did not take a replayed {payload['hook_event_name']} event: {error.__class__.__name__}") from error
        if status not in (200, 204):
            raise LocalSeedError(f"the daemon answered {status} to a replayed {payload['hook_event_name']} event")
        self.calls.append({"event": payload["hook_event_name"], "tool": payload.get("tool_name"), "status": status})
        self.sleep(EVENT_GAP_S)
        return status


def _tool(event: str, name: str, tool_input: dict[str, Any], call_id: str, **extra: Any) -> dict[str, Any]:
    return {"hook_event_name": event, "tool_name": name, "tool_input": tool_input, "tool_use_id": call_id, **extra}


def failure_then_fix(replay: Replay, command: str, failure_text: str, edited_file: str, pass_text: str, call_prefix: str) -> None:
    """The five events a fix looks like from the daemon's side.

    A Bash call that fails with the real output, an edit of the file the fix
    touches, and the same Bash call passing. The failure travels as
    `PostToolUseFailure` with the output under `error`, which is how Claude
    Code reports a non-zero exit; the pass is a plain `PostToolUse`.
    """
    replay.post(_tool("PreToolUse", "Bash", {"command": command}, f"{call_prefix}-fail"))
    replay.post(_tool("PostToolUseFailure", "Bash", {"command": command}, f"{call_prefix}-fail", error=failure_text, is_interrupt=False))
    replay.post(_tool("PreToolUse", "Edit", {"file_path": edited_file}, f"{call_prefix}-edit"))
    replay.post(_tool("PreToolUse", "Bash", {"command": command}, f"{call_prefix}-pass"))
    replay.post(_tool("PostToolUse", "Bash", {"command": command}, f"{call_prefix}-pass", tool_response={"stdout": pass_text, "stderr": "", "interrupted": False}))


def seed_lesson(replay: Replay, lesson: Any, task_id: str, outputs: dict[str, str], repo: str) -> dict[str, Any]:
    """Replay a lesson's keyed commands as failure-then-fix, or say why the product could not hold it."""
    fix = lesson.fix
    entries: list[dict[str, Any]] = []
    for entry in lesson.commands:
        if entry.key is None:
            continue
        command = entry.command.replace("{task}", task_id)
        if fix is None:
            entries.append({"command": command, "kind": entry.kind, "replayed": False, "reason": "no_fix_file"})
            continue
        # A pairing closes only when the same command head passes again, so a
        # lesson whose fix is another command has no local record to seed.
        if command.split(" ")[0] != fix.get("command", command).split(" ")[0]:
            entries.append({"command": command, "kind": entry.kind, "replayed": False, "reason": "cross_command"})
            continue
        text = outputs.get(command)
        if text is None:
            raise LocalSeedError(f"no probe output for {command!r}; the seed replays real output only")
        test = f"tests/{task_id}.test.mjs"
        failure_then_fix(replay, command, text, f"{repo}/{fix['file']}", PASS_OUTPUT.format(test=test), f"seed-{lesson.id}-{len(entries)}")
        entries.append({"command": command, "kind": entry.kind, "replayed": True, "reason": None})
    return {"lesson": lesson.id, "commands": entries}


def load_distractors(path: Path | None = None) -> list[dict[str, Any]]:
    path = DISTRACTORS if path is None else path
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise LocalSeedError(f"the distractor corpus is unreadable: {error.__class__.__name__}") from error
    if not isinstance(data, list) or not data:
        raise LocalSeedError("the distractor corpus must be a non-empty list")
    seen: set[str] = set()
    for item in data:
        if not isinstance(item, dict) or set(item) != DISTRACTOR_KEYS or not all(isinstance(item[key], str) and item[key] for key in DISTRACTOR_KEYS):
            raise LocalSeedError("each distractor carries id, command, file, and error, all non-empty strings")
        if item["id"] in seen:
            raise LocalSeedError(f"distractor {item['id']!r} appears twice")
        seen.add(item["id"])
    return data


def seed_distractors(replay: Replay, corpus: list[dict[str, Any]], count: int, repo: str) -> int:
    """`count` unrelated failure-then-fix records beside the real one, from the committed corpus, in order."""
    if count > len(corpus):
        raise LocalSeedError(f"the distractor corpus holds {len(corpus)} entries, fewer than the {count} the slice asks for")
    for index, item in enumerate(corpus[:count]):
        test = f"tests/{item['id']}.test.mjs"
        failure_then_fix(replay, item["command"], item["error"], f"{repo}/{item['file']}", PASS_OUTPUT.format(test=test), f"distractor-{index}")
    return count


def pairings_of(loop_db: Path, project: str) -> list[dict[str, Any]]:
    """The project's pairing rows as the record may carry them: kind, key hash, status, closes; never the error line."""
    import sqlite3

    if not loop_db.is_file():
        return []
    uri = f"file:{loop_db.resolve().as_posix()}?mode=ro&immutable=1"
    try:
        connection = sqlite3.connect(uri, uri=True)
    except sqlite3.Error as error:
        raise LocalSeedError(f"cannot open loop.db read-only: {error}") from error
    try:
        rows = connection.execute("SELECT kind, key, status, closes, session FROM pairings WHERE project IS ? ORDER BY id", (project,)).fetchall()
    except sqlite3.Error as error:
        raise LocalSeedError(f"loop.db has no readable pairings table: {error}") from error
    finally:
        connection.close()
    return [
        {"kind": kind, "key_hash": sha256_text(f"{kind}:{key}")[:16], "status": status, "closes": int(closes or 0), "session_hash": sha256_text(session)[:16]}
        for kind, key, status, closes, session in rows
    ]


def summarize(rows: list[dict[str, Any]]) -> dict[str, int]:
    counts = {status: 0 for status in STATUSES}
    for row in rows:
        counts[row["status"]] = counts.get(row["status"], 0) + 1
    return counts
