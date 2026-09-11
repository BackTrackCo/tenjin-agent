"""A stand-in for the `tenjin` CLI's profile, publish and delete: JSON receipts, a call log in the data dir, and switchable failures."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path


def deleted(data_dir: Path) -> set[str]:
    """The piece ids this fake shelf has already taken down."""
    path = data_dir / "deleted.json"
    return set(json.loads(path.read_text(encoding="utf-8"))) if path.exists() else set()


def main(argv: list[str]) -> int:
    data_dir = Path(os.environ["TENJIN_DATA_DIR"])
    command = argv[0] if argv else ""
    with (data_dir / "cli-calls.jsonl").open("a", encoding="utf-8") as log:
        log.write(json.dumps({"argv": argv, "env": sorted(os.environ)}) + "\n")
    if command == "profile":
        # The wallet preflight. `wrong-passphrase` stands for a keystore the
        # passphrase in the environment does not open.
        if (data_dir / "wrong-passphrase").exists():
            json.dump({"ok": False, "error": {"code": "WALLET_INVALID_KEY", "message": "Could not decrypt the wallet keystore."}}, sys.stdout)
            return 1
        json.dump({"ok": True, "data": {"address": "0x0a3B118D0261b5b772d613DB32446FEE7b7208bC", "profile": None}}, sys.stdout)
        return 0
    if command == "publish":
        if (data_dir / "fail-publish").exists():
            sys.stderr.write("shelf refused the piece: token " + json.loads((data_dir / "config.json").read_text())["shelfBypassSecret"] + "\n")
            return 4
        count = sum(1 for line in (data_dir / "cli-calls.jsonl").read_text(encoding="utf-8").splitlines() if '"publish"' in line)
        if (data_dir / "fail-second-publish").exists() and count >= 2:
            sys.stderr.write("shelf refused the second piece\n")
            return 4
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
        if (data_dir / "fail-search").exists():
            sys.stderr.write("search refused: 502 from the shelf\n")
            return 4
        # A deleted piece stops being findable, which is what makes the order
        # of the snapshot and the delete observable from the answers alone.
        results = data_dir / "search-results.json"
        candidates = [item for item in (json.loads(results.read_text(encoding="utf-8")) if results.exists() else []) if item.get("resourceId") not in deleted(data_dir)]
        items = data_dir / "search-items.json"
        if items.exists():
            # The v3 receipt: `data.response.items`, each a passthrough candidate.
            live = [item for item in json.loads(items.read_text(encoding="utf-8")) if item.get("resourceId") not in deleted(data_dir)]
            sys.stdout.write(json.dumps({"ok": True, "data": {"shelf": "team", "response": {"searchId": "search-1", "items": live}}}) + "\n")
            return 0
        sys.stderr.write(json.dumps({"ok": True, "data": {"candidates": candidates}}) + "\n")
        return 0
    if command == "delete":
        if (data_dir / "fail-delete").exists():
            sys.stderr.write("delete refused: 502 from the shelf\n")
            return 4
        (data_dir / "deleted.json").write_text(json.dumps(sorted(deleted(data_dir) | {argv[1]})), encoding="utf-8")
        json.dump({"ok": True, "data": {"deleted": True, "postId": argv[1]}}, sys.stdout)
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
