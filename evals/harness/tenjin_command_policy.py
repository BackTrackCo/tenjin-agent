#!/usr/bin/env python3
"""PreToolUse boundary for the controlled installed-hooks output eval.

The Claude CLI permission spelling ``Bash(tenjin:*)`` is a prefix grant, not a
shell grammar.  Without this hook it also grants command chaining, redirects,
substitution, absolute paths, and every other Tenjin verb.  This hook runs before
both exposed tool families and permits only one byte-exact repository inspection,
one fixed candidate-file write, and one byte-exact publish command.  Everything
else is denied.

This file is invoked from a runner-owned ``--settings`` file outside the case
directory.  The model therefore cannot change either half of the boundary with
its project-scoped file tools.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sqlite3
import stat
import sys
from pathlib import Path
from urllib.parse import quote


PUBLISH_COMMAND = "tenjin publish ./tenjin-candidate.md --json"
INSPECTION_COMMAND = "git status --short"
CANDIDATE = "tenjin-candidate.md"
DENIAL = (
    "Controlled eval permits only its fixed inspection, candidate write, "
    "and publish operations."
)


def deny(reason: str = DENIAL) -> int:
    print(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": reason,
                }
            },
            separators=(",", ":"),
        )
    )
    return 0


def _capture_armed(payload: dict, state_db: Path, not_before_ms: int) -> bool:
    """Trust only the ordinary Stop hook's durable marker for this session.

    The runner's post-hoc stream observer cannot undo a premature publication.
    This read-only gate instead checks the marker the installed Stop hook writes
    *before* emitting its capture continuation.  The session id comes from the
    hook protocol rather than model input, and the row must be newer than this
    controlled run, so a stale row cannot arm a resumed/reused identifier.
    """

    session_id = payload.get("session_id")
    if (
        not isinstance(session_id, str)
        or not session_id
        or len(session_id) > 256
        or any(ord(character) < 0x20 for character in session_id)
    ):
        return False
    try:
        metadata = os.lstat(state_db)
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
            return False
        resolved = state_db.resolve(strict=True)
        uri = f"file:{quote(str(resolved), safe='/')}?mode=ro"
        connection = sqlite3.connect(uri, uri=True, timeout=0.1)
        try:
            row = connection.execute(
                "SELECT value, at FROM session_state WHERE session = ? AND key = ?",
                (session_id, "capture_asked"),
            ).fetchone()
        finally:
            connection.close()
    except (OSError, RuntimeError, sqlite3.Error):
        return False
    if (
        not isinstance(row, tuple)
        or len(row) != 2
        or not isinstance(row[0], str)
        or not isinstance(row[1], int)
        or isinstance(row[1], bool)
        or row[1] < not_before_ms
    ):
        return False
    try:
        marker = json.loads(row[0])
        at = marker.get("at") if isinstance(marker, dict) and set(marker) == {"at"} else None
        if not isinstance(at, str) or not at:
            return False
        # Validate the exact bounded marker shape rather than accepting an
        # arbitrary value written under the same key.
        dt.datetime.fromisoformat(at.replace("Z", "+00:00"))
    except (ValueError, json.JSONDecodeError):
        return False
    return True


def decide(payload: object, project: Path, state_db: Path, not_before_ms: int) -> int:
    if not isinstance(payload, dict):
        return deny()
    tool_name = payload.get("tool_name")
    tool_input = payload.get("tool_input")
    if not isinstance(tool_input, dict):
        return deny()

    try:
        root = project.resolve(strict=True)
        candidate = root / CANDIDATE
    except (OSError, RuntimeError):
        return deny("Controlled eval case directory is missing or inaccessible.")

    if tool_name == "Write":
        if not _capture_armed(payload, state_db, not_before_ms):
            return deny("Controlled eval publication is not armed by its Stop capture ask.")
        file_path = tool_input.get("file_path")
        if file_path != f"./{CANDIDATE}":
            return deny()
        # Write may create the file. If something already occupies the fixed
        # path, it must still be the ordinary regular file a previous Write made.
        try:
            metadata = os.lstat(candidate)
        except FileNotFoundError:
            return 0
        except OSError:
            return deny("Controlled eval candidate is inaccessible.")
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
            return deny("Controlled eval candidate must be a regular non-symlink file.")
        return 0

    if tool_name != "Bash":
        return deny()
    command = tool_input.get("command")
    # Byte-exact by construction: this rejects newlines, Unicode whitespace or
    # confusables, redirects, substitutions, chaining, flags, alternate paths,
    # and an otherwise-equivalent command with any raw variance.
    if command == INSPECTION_COMMAND:
        return 0
    if command != PUBLISH_COMMAND:
        return deny()
    if not _capture_armed(payload, state_db, not_before_ms):
        return deny("Controlled eval publication is not armed by its Stop capture ask.")

    try:
        metadata = os.lstat(candidate)
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
            return deny("Controlled eval candidate must be a regular non-symlink file.")
        resolved = candidate.resolve(strict=True)
        if resolved.parent != root:
            return deny("Controlled eval candidate resolved outside its case directory.")
    except (OSError, RuntimeError):
        return deny("Controlled eval candidate is missing or inaccessible.")

    # Empty stdout means this hook neither denies nor overrides Claude's normal
    # permission system. The separate --allowedTools rule supplies the coarse
    # grant after this structural boundary passes.
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", required=True, type=Path)
    parser.add_argument("--state-db", required=True, type=Path)
    parser.add_argument("--not-before-ms", required=True, type=int)
    args = parser.parse_args()
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return deny("Controlled eval received a malformed tool request.")
    return decide(payload, args.project, args.state_db, args.not_before_ms)


if __name__ == "__main__":
    raise SystemExit(main())
