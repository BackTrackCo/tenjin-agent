"""A stand-in for `tenjin-daemon.mjs`, for the provisioning cases.

It does what the real daemon does at the seam this package touches: reads
`TENJIN_DATA_DIR`, `config.json` (for `loop.port`) and `daemon.token`, binds
loopback, writes `daemon.pid`, answers `/health` with its pid and data dir,
accepts a bearer-authenticated POST on `/hook/claude`, keeps a `loop.db-wal`
file while it runs, and removes it on SIGTERM. `--keep-wal` leaves the WAL
behind, which is the daemon that never closed its database and what the stop
path's checkpoint has to settle without waiting; `--port`
overrides the configured port, which is how a case stands in for a daemon the
shim respawned.

It records a failure question and its team lookup legs, and a Stop fire. It
never infers a fix or simulates the removed local pairing store. Rows use the
product's own DDL, so the benchmark reads the current runtime's shape.
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




class Store:
    """The slice of the failure arm the cases need, on the product's own tables."""

    def __init__(self, path: Path) -> None:
        self.path = path
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
        db = self.connect()
        try:
            if event == "Stop":
                self.fire(db, session, agent, "turn.end", "stop", "no-question", None, cwd)
            elif event == "PostToolUseFailure" and tool == "Bash":
                found = key_of(str(raw.get("error", "")))
                keys = [("sig_v1", found["key"]), ("sig_v1_test", found["test_key"])]
                keys = [(kind, key) for kind, key in keys if key is not None]
                line = found["line"] or ""
                if keys or line:
                    import hashlib
                    parts = [f"{kind}:{key}" for kind, key in keys]
                    if line:
                        parts.append("line:" + hashlib.sha256(line.encode()).hexdigest()[:32])
                    fire_id = self.fire(db, session, agent, "tool.after", "failure", "no-hit", None, cwd)
                    db.execute("UPDATE fires SET question_key = ?, question = ? WHERE id = ?", ("|".join(parts), line, fire_id))
                    shelves = (["keys"] if keys else []) + (["team"] if line else [])
                    for stage, shelf in enumerate(shelves):
                        db.execute("INSERT INTO legs (fire_id, stage, shelf, status, outcome, elapsed_ms) VALUES (?, ?, ?, 'ok', 'no-answer', 1)", (fire_id, stage, shelf))
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
