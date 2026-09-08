"""A stand-in for `tenjin-daemon.mjs`, for the provisioning cases.

It does what the real daemon does at the seam this package touches: reads
`TENJIN_DATA_DIR`, `config.json` (for `loop.port`) and `daemon.token`, binds
loopback, writes `daemon.pid`, answers `/health` with its pid and data dir,
accepts a bearer-authenticated POST on `/hook/claude`, keeps a `loop.db-wal`
file while it runs, and removes it on SIGTERM. `--keep-wal` leaves the WAL
behind, which is the settlement failure the runner has to refuse; `--port`
overrides the configured port, which is how a case stands in for a daemon the
shim respawned.

It also plays the failure arm's local record at the shape the seed and the
producer phase depend on (`src/hooks/failure/pairings.ts`): a failing Bash
call opens a pairing under the key the signature port derives from its
output, an Edit is remembered, and the same command passing afterwards
closes it `unverified`; a later failure under a closed key is a fire with a
`local` leg hit; a Stop is a `turn.end` fire. Rows go through the product's
own DDL, so the join reads them as it reads the real thing.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import signal
import sqlite3
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
STORE = REPO_ROOT / "src" / "hooks" / "store.ts"


def key_of(text: str) -> dict:
    """The signature port, imported on the first failure event only: most cases never send one and pay nothing for it."""
    sys.path.insert(0, str(REPO_ROOT))
    from evals.benchmark import signature

    return signature.key_of(text)


def project_of(cwd: str) -> str | None:
    import hashlib

    return hashlib.sha256(cwd.encode("utf-8")).hexdigest()[:16] if cwd else None


class Store:
    """The slice of the failure arm the cases need, on the product's own tables."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.edited: dict[str, list[tuple[int, str]]] = {}
        self.counter = 0

    def now(self) -> int:
        self.counter += 1
        return int(time.time() * 1000) + self.counter

    def connect(self) -> sqlite3.Connection:
        return sqlite3.connect(self.path)

    def fire(self, db: sqlite3.Connection, session: str, agent: str, event: str, arm: str, reason: str, delivered: str | None, cwd: str) -> str:
        self.counter += 1
        fire_id = f"fire-{self.counter}-{os.getpid()}"
        db.execute(
            "INSERT INTO fires (id, at, session, agent, arm, harness, event, cwd, wait, deadline_ms, elapsed_ms, reason, delivered)"
            " VALUES (?, ?, ?, ?, ?, 'claude', ?, ?, 'tool', 1000, 1, ?, ?)",
            (fire_id, self.now(), session, agent, arm, event, cwd, reason, delivered),
        )
        return fire_id

    def handle(self, raw: dict) -> None:
        event = raw.get("hook_event_name")
        session, agent, cwd = str(raw.get("session_id", "")), str(raw.get("agent_id") or ""), str(raw.get("cwd", ""))
        tool = raw.get("tool_name")
        tool_input = raw.get("tool_input") or {}
        project = project_of(cwd)
        db = self.connect()
        try:
            if event == "Stop":
                self.fire(db, session, agent, "turn.end", "stop", "no-question", None, cwd)
            elif event == "PreToolUse" and tool == "Edit":
                self.edited.setdefault(f"{session}:{agent}", []).append((self.now(), str(tool_input.get("file_path", ""))))
            elif event == "PostToolUseFailure" and tool == "Bash":
                command = str(tool_input.get("command", ""))
                found = key_of(str(raw.get("error", "")))
                keys = [("sig_v1", found["key"]), ("sig_v1_test", found["test_key"])]
                keys = [(kind, key) for kind, key in keys if key is not None]
                for kind, key in keys:
                    row = db.execute(
                        "SELECT id FROM pairings WHERE project IS ? AND key = ? AND status IN ('unverified', 'verified') LIMIT 1", (project, key)
                    ).fetchone()
                    if row is not None:
                        fire_id = self.fire(db, session, agent, "tool.after", "failure", "hit", f"pairing:{row[0]}", cwd)
                        db.execute(
                            "INSERT INTO legs (fire_id, stage, shelf, status, outcome, elapsed_ms) VALUES (?, 0, 'local', 'ok', 'hit', 0)", (fire_id,)
                        )
                        break
                else:
                    if keys:
                        self.fire(db, session, agent, "tool.after", "failure", "miss", None, cwd)
                    for kind, key in keys:
                        db.execute(
                            "INSERT INTO pairings (uid, at, session, project, machine, kind, key, cmd_head, cmd, error_line, error_files, scope, status)"
                            " VALUES (?, ?, ?, ?, 'fake', ?, ?, ?, ?, ?, '[]', 'ambiguous', 'open')",
                            (f"{session}-{self.counter}-{kind}", self.now(), session, project, kind, key, command.split(" ")[0], command, found["line"] or ""),
                        )
            elif event == "PostToolUse" and tool == "Bash":
                command = str(tool_input.get("command", ""))
                edits = self.edited.get(f"{session}:{agent}", [])
                for row in db.execute(
                    "SELECT id, at FROM pairings WHERE status = 'open' AND project IS ? AND cmd_head = ? AND cmd = ?", (project, command.split(" ")[0], command)
                ).fetchall():
                    files = [path for at, path in edits if at > row[1]]
                    if not files:
                        continue
                    now = self.now()
                    db.execute(
                        "INSERT OR IGNORE INTO pairing_closes (pairing_id, session, agent_id, at, fix_cmd, fix_files, scope) VALUES (?, ?, ?, ?, ?, ?, 'code')",
                        (row[0], session, agent or None, now, command, json.dumps(files)),
                    )
                    db.execute(
                        "UPDATE pairings SET closes = 1, status = 'unverified', closed_at = ?, fix_cmd = ?, fix_files = ?, scope = 'code' WHERE id = ?",
                        (now, command, json.dumps(files), row[0]),
                    )
            db.commit()
        finally:
            db.close()


def open_loop_db(path: Path) -> None:
    """An empty loop.db of the product's own shape, so the join has tables to read."""
    if path.exists():
        return
    match = re.search(r"export const LOOP_DDL = `([\s\S]*?)`;", STORE.read_text(encoding="utf-8"))
    assert match is not None, "LOOP_DDL not found in store.ts"
    db = sqlite3.connect(path)
    try:
        db.executescript(match.group(1))
        db.commit()
    finally:
        db.close()


# A WAL with frames in it, as a live daemon leaves; a zero-byte one reads as settled.
WAL_FRAMES = b"\x37\x7f\x06\x82" + b"\x00" * 28


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="fake_daemon")
    parser.add_argument("--keep-wal", action="store_true")
    parser.add_argument("--port", type=int)
    args = parser.parse_args(argv)
    data = Path(os.environ["TENJIN_DATA_DIR"])
    config = json.loads((data / "config.json").read_text(encoding="utf-8"))
    token = (data / "daemon.token").read_text(encoding="utf-8").strip()
    port = args.port if args.port is not None else int(config.get("loop", {}).get("port") or 0)
    wal = data / "loop.db-wal"
    open_loop_db(data / "loop.db")
    store = Store(data / "loop.db")
    wal.write_bytes(WAL_FRAMES)
    started = int(time.time() * 1000)
    calls = data / "hook-calls.jsonl"

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args: object) -> None:  # noqa: N802
            return

        def do_GET(self) -> None:  # noqa: N802
            if self.path != "/health":
                self.send_response(404)
                self.end_headers()
                return
            body = json.dumps(
                {
                    "version": "fake",
                    "pid": os.getpid(),
                    "port": server.server_address[1],
                    "uptime_ms": int(time.time() * 1000) - started,
                    "idle_ms": 0,
                    "data_dir": os.environ["TENJIN_DATA_DIR"],
                    "rss": 0,
                }
            ).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self) -> None:  # noqa: N802
            length = int(self.headers.get("Content-Length") or 0)
            payload = self.rfile.read(length)
            if self.headers.get("Authorization") != f"Bearer {token}":
                self.send_response(401)
                self.end_headers()
                return
            with calls.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps({"path": self.path, "bytes": len(payload)}) + "\n")
            try:
                raw = json.loads(payload.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                raw = None
            if isinstance(raw, dict) and self.path == "/hook/claude":
                store.handle(raw)
            self.send_response(204)
            self.end_headers()

    server = HTTPServer(("127.0.0.1", port), Handler)
    (data / "daemon.pid").write_text(
        json.dumps({"pid": os.getpid(), "port": server.server_address[1], "started_at": started, "data_dir": os.environ["TENJIN_DATA_DIR"]}),
        encoding="utf-8",
    )

    def stop(*_args: object) -> None:
        if not args.keep_wal:
            wal.unlink(missing_ok=True)
        server.server_close()
        sys.exit(0)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
