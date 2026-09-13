"""Operator-attested benchmark credential scope; never a product team-mode flag.

The receipt binds the configured key to the dedicated Vercel project. It is an
operator assertion, like the container attestation, not a Vercel signature.
Ordinary team keys have no receipt and retain the existing refusal.
"""
from __future__ import annotations

import hashlib
import re
from typing import Any

FILE = "benchmark-shelf-key.json"
PROJECT = "prj_CZTvvIcbCviimx86QG5zyExaYys5"
ORIGIN = "bench.tenjin.sh"
SCHEMA = "bench1.shelf-key.v1"


def validate(value: Any) -> dict[str, str]:
    if not isinstance(value, dict) or set(value) != {"schema", "project_id", "origin", "key_sha256"}:
        raise ValueError("benchmark shelf key receipt has invalid fields")
    if value["schema"] != SCHEMA or value["project_id"] != PROJECT or value["origin"] != ORIGIN:
        raise ValueError("benchmark shelf key receipt must name the dedicated tenjin-bench project and origin")
    if not isinstance(value["key_sha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", value["key_sha256"]):
        raise ValueError("benchmark shelf key receipt requires a SHA-256 digest")
    return dict(value)


def bind(value: Any, secret: str, origin: str | None) -> dict[str, str]:
    receipt = validate(value)
    if not secret or origin != receipt["origin"] or hashlib.sha256(secret.encode()).hexdigest() != receipt["key_sha256"]:
        raise ValueError("benchmark shelf key receipt does not match the configured credential and origin")
    return receipt


def recorded(isolation: dict[str, Any]) -> bool:
    value = isolation.get("benchmark_shelf_key")
    if value is None:
        return False
    validate(value)
    corpus = isolation.get("corpus") or {}
    return bool(isolation.get("shelf_secret_present") and isolation.get("live")
                and isolation.get("attested_container") and isolation.get("attestation_hash")
                and isolation.get("shelf_origin") == ORIGIN and corpus.get("origin") == ORIGIN)


def bind_run(path, receipt: Any, manifest_hash: str) -> None:
    """A changed team profile starts a new measurement, never a mixed resume."""
    import json
    expected = {"schema": "bench1.team-profile.v1", "manifest_hash": manifest_hash,
                "scope": validate(receipt), "publication_price": "0"}
    target = path / "team-profile.json"
    if target.exists():
        if json.loads(target.read_text()) != expected:
            raise ValueError("benchmark team profile changed; start a fresh run")
    else:
        if any((path / "records").glob("*.json")):
            raise ValueError("existing run predates the free team profile; start a fresh run")
        path.mkdir(parents=True, exist_ok=True)
        with target.open("x") as stream:
            stream.write(json.dumps(expected, indent=2) + "\n")


def configure(path, secret: str, receipt: Any) -> None:
    """Write a fresh CLI profile from an independently stored scope receipt."""
    import json
    import os
    scope = bind(receipt, secret, ORIGIN)
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if (path / "config.json").exists() or (path / FILE).exists():
        raise ValueError("benchmark team profile already exists; use a fresh source directory")
    config = {"baseUrl": "https://" + ORIGIN, "publicShelfUrl": "https://tenjin.blog",
              "shelfBypassSecret": secret, "team": {"publicFallback": "on"},
              "publish": {"mode": "auto", "defaultPrice": "0"}}
    for name, value in (("config.json", config), (FILE, scope)):
        fd = os.open(path / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as stream:
            stream.write(json.dumps(value, indent=2) + "\n")


if __name__ == "__main__":
    import argparse
    import json
    import os
    from pathlib import Path
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    args = parser.parse_args()
    try:
        configure(args.source, os.environ["TENJIN_BENCH_SHELF_BYPASS_SECRET"],
                  json.loads(os.environ["TENJIN_BENCH_SHELF_KEY_RECEIPT"]))
    except (KeyError, OSError, ValueError) as error:
        # Do not echo environment values or exception strings containing paths.
        parser.exit(2, f"benchmark team profile refused ({type(error).__name__}); check dedicated key, receipt and fresh source directory\n")
    print("Benchmark team profile configured: dedicated key, free publication, public fallback on")
