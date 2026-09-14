"""Observe the deployed Next.js server without credentials or a server change.

Observations are outside agent timing. They detect drift, not prevent it: schema
changes or a deployment and rollback between observations are not observable here.
"""
from __future__ import annotations

import json
import re
from html.parser import HTMLParser
from pathlib import Path
import urllib.parse
import urllib.request

FILE = "server-revision.json"
SCHEMA = "bench1.server-revision.v1"
ID = re.compile(r"[A-Za-z0-9_.-]{1,64}")
KEYS = {"schema", "manifest_hash", "origin", "deployment_id", "observed_id", "checks", "status"}
MAX_BODY = 1024 * 1024


class ServerError(ValueError):
    def __init__(self, code):
        self.code = code
        super().__init__(f"remote server {code}; retained evidence is diagnostic only")


class DeploymentHTML(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids = set()

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if tag == "html" and "data-dpl-id" in values:
            self.ids.add(values["data-dpl-id"])
        # Read framework asset attributes, never arbitrary prose or scripts.
        for key in ("src", "href") if tag in ("script", "link") else ():
            value = values.get(key) or ""
            parsed = urllib.parse.urlsplit(value)
            if not parsed.netloc and parsed.path.startswith("/_next/static/"):
                self.ids.update(urllib.parse.parse_qs(parsed.query).get("dpl", []))


def parse(body):
    document = DeploymentHTML()
    document.feed(body)
    if len(document.ids) != 1:
        raise ServerError("identity_unavailable")
    value = next(iter(document.ids))
    if not isinstance(value, str) or not ID.fullmatch(value):
        raise ServerError("identity_unavailable")
    return value


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ServerError("identity_unavailable")


def probe(origin):
    if not re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?", origin):
        raise ServerError("identity_unavailable")
    request = urllib.request.Request(f"https://{origin}/", headers={"Accept": "text/html", "Cache-Control": "no-cache"})
    try:
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=10) as response:
            body = response.read(MAX_BODY + 1)
        if len(body) > MAX_BODY:
            raise ServerError("identity_unavailable")
        return parse(body.decode("utf-8"))
    except (OSError, UnicodeError, ValueError) as error:
        raise ServerError("identity_unavailable") from error


def read(root):
    path = root / FILE
    if path.is_symlink():
        raise ServerError("evidence_unreadable")
    if not path.exists():
        return None
    try:
        value = json.loads(path.read_text())
        valid = (isinstance(value, dict) and set(value) == KEYS and value["schema"] == SCHEMA
                 and isinstance(value["manifest_hash"], str) and re.fullmatch(r"(?:sha256:)?[0-9a-f]{64}", value["manifest_hash"])
                 and isinstance(value["origin"], str) and re.fullmatch(r"[a-z0-9.-]+", value["origin"])
                 and type(value["checks"]) is int and value["checks"] >= 1
                 and value["status"] in {"stable", "changed", "unavailable"}
                 and all(item is None or isinstance(item, str) and ID.fullmatch(item)
                         for item in (value["deployment_id"], value["observed_id"]))
                 and (value["status"] != "stable" or value["deployment_id"] is not None and value["observed_id"] == value["deployment_id"]))
        if not valid:
            raise ValueError()
        return value
    except (OSError, ValueError, TypeError, KeyError) as error:
        raise ServerError("evidence_unreadable") from error


def observe(root: Path, origin: str, manifest_hash: str, fetch=probe):
    previous = read(root)
    if previous is None and any((root / "records").glob("*.json")):
        raise ServerError("evidence_missing")
    if previous and (previous["origin"] != origin or previous["manifest_hash"] != manifest_hash):
        raise ServerError("evidence_mismatch")
    if previous and previous["status"] != "stable":
        raise ServerError(previous["status"])
    try:
        observed = fetch(origin)
        if not isinstance(observed, str) or not ID.fullmatch(observed):
            raise ServerError("identity_unavailable")
    except (OSError, ValueError):
        observed = None
    expected = previous["deployment_id"] if previous else observed
    state = {"schema": SCHEMA, "manifest_hash": manifest_hash, "origin": origin,
             "deployment_id": expected, "observed_id": observed,
             "checks": (previous["checks"] if previous else 0) + 1,
             "status": "unavailable" if observed is None else "changed" if observed != expected else "stable"}
    root.mkdir(parents=True, exist_ok=True)
    temporary = root / (FILE + ".pending")
    with temporary.open("x") as stream:
        json.dump(state, stream, sort_keys=True)
    temporary.replace(root / FILE)
    if state["status"] != "stable":
        raise ServerError(state["status"])
    return state
