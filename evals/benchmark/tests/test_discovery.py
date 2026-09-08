"""Discovery facts off a fake transcript: the setup file read, and a failing test run before the fix."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from evals.benchmark import discovery


def _row(index: int, kind: str, block: dict) -> str:
    stamp = f"2026-09-08T00:00:{index:02d}.000Z"
    if kind == "assistant":
        message = {"role": "assistant", "content": [{"type": "tool_use", **block}]}
    else:
        message = {"role": "user", "content": [{"type": "tool_result", **block}]}
    return json.dumps({"type": kind, "uuid": f"u-{index}", "timestamp": stamp, "session_id": "s", "message": message})


class DiscoveryTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.sessions = Path(self.tmp.name) / "sessions"
        self.sessions.mkdir()
        self.addCleanup(self.tmp.cleanup)

    def write(self, name: str, rows: list[str]) -> None:
        (self.sessions / name).write_text("\n".join(rows) + "\n", encoding="utf-8")

    def test_a_failing_run_before_the_edit_and_no_setup_read(self) -> None:
        self.write(
            "root.jsonl",
            [
                _row(1, "assistant", {"id": "t1", "name": "Read", "input": {"file_path": "/trial/repo/src/actor.mjs"}}),
                _row(2, "user", {"tool_use_id": "t1", "content": "export function actorKey() {}"}),
                _row(3, "assistant", {"id": "t2", "name": "Bash", "input": {"command": "pnpm exec vitest run tests/actor.test.mjs"}}),
                _row(4, "user", {"tool_use_id": "t2", "content": " FAIL  tests/actor.test.mjs > actorKey case 1\nAssertionError: expected 's1:undefined' to be 's1:root'"}),
                _row(5, "assistant", {"id": "t3", "name": "Edit", "input": {"file_path": "/trial/repo/src/actor.mjs", "old_string": "a", "new_string": "b"}}),
                _row(6, "assistant", {"id": "t4", "name": "Bash", "input": {"command": "pnpm exec vitest run tests/actor.test.mjs"}}),
                _row(7, "user", {"tool_use_id": "t4", "content": " ✓ tests/actor.test.mjs (2 tests)"}),
            ],
        )
        found = discovery.derive(self.sessions, "actor")
        self.assertEqual(found, {"setup_read": False, "setup_reads": 0, "test_run_before_fix": True, "failing_runs_before_fix": 1, "test_runs": 2, "source_edited": True})

    def test_a_setup_read_and_an_edit_before_any_run_is_counted_as_such(self) -> None:
        self.write(
            "root.jsonl",
            [
                _row(1, "assistant", {"id": "t1", "name": "Bash", "input": {"command": "cat .bench1/cases.setup.mjs"}}),
                _row(2, "user", {"tool_use_id": "t1", "content": "globalThis.__bench1Cases = {}"}),
                _row(3, "assistant", {"id": "t2", "name": "Read", "input": {"file_path": "/trial/repo/.bench1/cases.setup.mjs"}}),
                _row(4, "user", {"tool_use_id": "t2", "content": "globalThis.__bench1Cases = {}"}),
                _row(5, "assistant", {"id": "t3", "name": "Write", "input": {"file_path": "/trial/repo/src/actor.mjs", "content": "x"}}),
                _row(6, "assistant", {"id": "t4", "name": "Bash", "input": {"command": "pnpm exec vitest run tests/actor.test.mjs"}}),
                _row(7, "user", {"tool_use_id": "t4", "content": "AssertionError: still wrong", "is_error": True}),
            ],
        )
        found = discovery.derive(self.sessions, "actor")
        self.assertEqual((found["setup_read"], found["setup_reads"], found["test_run_before_fix"], found["failing_runs_before_fix"]), (True, 2, False, 0))

    def test_a_child_transcript_counts_too_and_an_empty_dir_is_all_false(self) -> None:
        (self.sessions / "child").mkdir()
        self.write("child/agent.jsonl", [_row(1, "assistant", {"id": "t1", "name": "Bash", "input": {"command": "sed -i '' 's/a/b/' src/actor.mjs > /dev/null"}})])
        self.assertTrue(discovery.derive(self.sessions, "actor")["source_edited"])
        self.assertEqual(discovery.derive(Path(self.tmp.name) / "absent", "actor")["test_runs"], 0)


if __name__ == "__main__":
    unittest.main()
