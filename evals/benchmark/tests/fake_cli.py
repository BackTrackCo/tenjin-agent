"""A stand-in for the `tenjin` CLI's publish and delete: JSON receipts, a call log in the data dir, and switchable failures."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path


def main(argv: list[str]) -> int:
    data_dir = Path(os.environ["TENJIN_DATA_DIR"])
    command = argv[0] if argv else ""
    with (data_dir / "cli-calls.jsonl").open("a", encoding="utf-8") as log:
        log.write(json.dumps({"argv": argv, "env": sorted(os.environ)}) + "\n")
    if command == "publish":
        if (data_dir / "fail-publish").exists():
            sys.stderr.write("shelf refused the piece: token " + json.loads((data_dir / "config.json").read_text())["shelfBypassSecret"] + "\n")
            return 4
        count = sum(1 for line in (data_dir / "cli-calls.jsonl").read_text(encoding="utf-8").splitlines() if '"publish"' in line)
        if (data_dir / "already-published").exists():
            sys.stdout.write(json.dumps({"ok": True, "data": {"alreadyPublished": True, "url": "https://team-shelf.example/a/ali/the-lesson"}}) + "\n")
            return 0
        if (data_dir / "garbage-publish").exists():
            # Published, but the receipt is unreadable: the fail-closed path.
            sys.stdout.write("Published The lesson (published) for 0.00 USD\n")
            return 0
        envelope = {"ok": True, "data": {"resourceId": f"piece-{count}", "url": f"https://team-shelf.example/p/piece-{count}", "status": "published"}}
        if (data_dir / "envelope-on-stderr").exists():
            # 0.1.0-alpha.15 writes the envelope to stderr; stdout stays empty.
            sys.stderr.write(json.dumps(envelope) + "\n")
            return 0
        sys.stdout.write("warning: no answer card\n" + json.dumps(envelope) + "\n")
        return 0
    if command == "search":
        results = data_dir / "search-results.json"
        candidates = json.loads(results.read_text(encoding="utf-8")) if results.exists() else []
        sys.stderr.write(json.dumps({"ok": True, "data": {"candidates": candidates}}) + "\n")
        return 0
    if command == "delete":
        if (data_dir / "fail-delete").exists():
            sys.stderr.write("delete refused: 502 from the shelf\n")
            return 4
        json.dump({"ok": True, "data": {"deleted": True, "postId": argv[1]}}, sys.stdout)
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
