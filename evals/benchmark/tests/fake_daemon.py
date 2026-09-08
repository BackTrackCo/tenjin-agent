"""A stand-in for `tenjin-daemon.mjs`, for the provisioning cases.

It does what the real daemon does at the seam this package touches: reads
`TENJIN_DATA_DIR`, `config.json` (for `loop.port`) and `daemon.token`, binds
loopback, writes `daemon.pid`, answers `/health` with its pid and data dir,
accepts a bearer-authenticated POST on `/hook/claude`, keeps a `loop.db-wal`
file while it runs, and removes it on SIGTERM. `--keep-wal` leaves the WAL
behind, which is the settlement failure the runner has to refuse; `--port`
overrides the configured port, which is how a case stands in for a daemon the
shim respawned.
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

STORE = Path(__file__).resolve().parents[3] / "src" / "hooks" / "store.ts"


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
