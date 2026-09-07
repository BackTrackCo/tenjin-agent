"""Bench-1: trustworthy benchmark foundation (eval-only, stdlib-only).

The package measures trials, not transcripts. Every module is a seam the plan
freezes: manifest -> schedule -> executor -> verifier -> immutable record ->
reducer -> report. `cli.py fake-run` drives the whole chain offline.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

PACKAGE_ROOT = Path(__file__).resolve().parent
REPO_ROOT = PACKAGE_ROOT.parent.parent
FIXTURES = PACKAGE_ROOT / "fixtures"


def canonical_json(value: Any) -> str:
    """One byte layout per value, so hashes of the same data agree everywhere."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def sha256_json(value: Any) -> str:
    return sha256_text(canonical_json(value))


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 16), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_dir(root: Path) -> str:
    """Content hash of a directory: sorted relative paths and file digests."""
    entries = []
    for path in sorted(item for item in root.rglob("*") if item.is_file()):
        entries.append([path.relative_to(root).as_posix(), sha256_file(path)])
    return sha256_json(entries)
