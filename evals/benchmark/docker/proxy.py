#!/usr/bin/env python3
"""The run's egress proxy: the attestation's network allowlist, enforced.

A trial container joins an `--internal` Docker network, which has no route out
and no DNS for outside names, and reaches this process for everything else.
This proxy sits on that network and on the default bridge, holds the run's
allowlist, and answers a `CONNECT` to any host outside it with 403. So the
allowlist is true by construction rather than by promise: a name a trial cannot
resolve and a host this process refuses are the only two ways out.

Every request is one JSON line in the log, verdict included, which is what the
runner counts as the trial's public requests. Nothing here reads a request
body, and a tunnelled byte is never buffered to disk.

Stdlib only, because the image is `python:3.12-slim` pinned by digest with
nothing installed into it.
"""

from __future__ import annotations

import argparse
import json
import socket
import socketserver
import sys
import threading
import time
from pathlib import Path

BUFFER = 1 << 16
# The runner's readiness check is a bare TCP connect from inside this
# container. It is not a request a trial made, and counting it as one would
# put a refusal in every run's sentinel, so a loopback client is not logged.
LOOPBACK = ("127.0.0.1", "::1")
CONNECT_TIMEOUT_S = 10.0
IDLE_TIMEOUT_S = 300.0
REQUEST_LIMIT = 8192


class Log:
    """One JSON line per request, appended under a lock and flushed."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.lock = threading.Lock()
        path.parent.mkdir(parents=True, exist_ok=True)

    def write(self, **fields: object) -> None:
        line = json.dumps({"ts": time.time(), **fields}, sort_keys=True)
        with self.lock:
            with self.path.open("a", encoding="utf-8") as handle:
                handle.write(line + "\n")
                handle.flush()


def allowed(host: str, allowlist: frozenset[str]) -> bool:
    """Exact host match, case-folded. No wildcard, no suffix rule: a suffix rule is how an allowlist grows a hole."""
    return host.lower() in allowlist


def pump(source: socket.socket, sink: socket.socket) -> None:
    try:
        while True:
            chunk = source.recv(BUFFER)
            if not chunk:
                break
            sink.sendall(chunk)
    except OSError:
        pass
    finally:
        for sock in (source, sink):
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass


class Handler(socketserver.StreamRequestHandler):
    timeout = IDLE_TIMEOUT_S
    allowlist: frozenset[str] = frozenset()
    log: Log | None = None

    def record(self, **fields: object) -> None:
        if self.log is not None and self.client_address[0] not in LOOPBACK:
            self.log.write(client=self.client_address[0], **fields)

    def refuse(self, status: str, host: str, reason: str, method: str) -> None:
        self.record(host=host, verdict="refused", reason=reason, method=method)
        self.wfile.write(f"HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".encode())

    def handle(self) -> None:
        try:
            line = self.rfile.readline(REQUEST_LIMIT).decode("latin-1").strip()
        except OSError:
            return
        parts = line.split()
        if len(parts) != 3:
            self.refuse("400 Bad Request", "", "unparsable request line", "")
            return
        method, target, _version = parts
        if method.upper() != "CONNECT":
            # Everything a trial sends is https, so a plain proxied request is
            # already outside the shape this proxy serves; it is refused and
            # counted rather than forwarded.
            host = target.split("/")[2] if target.startswith("http://") and len(target.split("/")) > 2 else target
            self.refuse("405 Method Not Allowed", host.split(":")[0], "not a CONNECT", method.upper())
            return
        host, _, port_text = target.rpartition(":")
        try:
            port = int(port_text)
        except ValueError:
            self.refuse("400 Bad Request", target, "no port in the CONNECT target", "CONNECT")
            return
        while True:
            header = self.rfile.readline(REQUEST_LIMIT)
            if not header or header in (b"\r\n", b"\n"):
                break
        if not allowed(host, self.allowlist):
            self.refuse("403 Forbidden", host, "not on the allowlist", "CONNECT")
            return
        try:
            upstream = socket.create_connection((host, port), timeout=CONNECT_TIMEOUT_S)
        except OSError as error:
            self.record(host=host, port=port, verdict="unreachable", reason=error.__class__.__name__, method="CONNECT")
            self.wfile.write(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            return
        self.record(host=host, port=port, verdict="allowed", method="CONNECT")
        self.wfile.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        self.wfile.flush()
        upstream.settimeout(None)
        self.connection.settimeout(None)
        outbound = threading.Thread(target=pump, args=(self.connection, upstream), daemon=True)
        outbound.start()
        pump(upstream, self.connection)
        outbound.join(timeout=CONNECT_TIMEOUT_S)
        upstream.close()


class Proxy(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="proxy.py")
    parser.add_argument("--port", type=int, default=8888)
    parser.add_argument("--allow", action="append", default=[], help="one allowed host; repeatable")
    parser.add_argument("--log", type=Path, required=True, help="the JSONL request log")
    args = parser.parse_args(argv)
    Handler.allowlist = frozenset(host.strip().lower() for host in args.allow if host.strip())
    Handler.log = Log(args.log)
    if not Handler.allowlist:
        sys.stderr.write("proxy: refusing to start with an empty allowlist\n")
        return 2
    sys.stderr.write(f"proxy: :{args.port} allows {', '.join(sorted(Handler.allowlist))}\n")
    sys.stderr.flush()
    with Proxy(("0.0.0.0", args.port), Handler) as server:
        server.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
