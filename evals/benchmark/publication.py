"""Host-assisted publication of a verified producer's own captured drafts.

No lesson substitution, added fingerprint keys or task-container wallet. A private,
ephemeral CLI state avoids cross-run publication dedup without changing draft prose.
"""
from __future__ import annotations

import dataclasses
import json
from pathlib import Path
import re
import sqlite3
import tempfile
import time

from . import sha256_text, tenjin_arm
from .executor import ProvisionError

MAX_DRAFTS = 32
MAX_BYTES = 262144
PIECE_ID = re.compile(r"[A-Za-z0-9_.:-]{1,128}\Z")


def drafts_of(loop_db: Path, session: str, project: str):
    if not loop_db.is_file():
        return []
    with sqlite3.connect(f"file:{loop_db.resolve().as_posix()}?mode=ro&immutable=1", uri=True) as db:
        rows = db.execute("SELECT key, value FROM facts WHERE substr(key, 1, 8) = 'finding:' ORDER BY key").fetchall()
    drafts = []
    for key, raw in rows:
        try:
            finding = json.loads(raw)
        except (TypeError, json.JSONDecodeError) as error:
            raise ProvisionError("captured finding is malformed", code="capture_draft") from error
        if not isinstance(finding, dict):
            raise ProvisionError("captured finding is not an object", code="capture_draft")
        if finding.get("session") != session or finding.get("project") != project:
            continue
        title, body = finding.get("title"), finding.get("body")
        if not isinstance(title, str) or not title.strip() or "\n" in title or "\r" in title or not isinstance(body, str) or not body.strip():
            raise ProvisionError("captured finding has no valid title/body", code="capture_draft")
        document = f"# {title}\n\n{body}"
        if len(document.encode()) > MAX_BYTES:
            raise ProvisionError("captured finding exceeds publication bound", code="capture_draft")
        drafts.append((sha256_text(key), document))
    if len(drafts) > MAX_DRAFTS:
        raise ProvisionError("too many captured findings; none published", code="capture_draft")
    return drafts


def publish(roots, provision, session: str, project: str):
    started = time.monotonic()
    facts = {"mode": "host-assisted", "status": "complete", "pieces": [], "wall_time_s": 0.0}
    reason = None
    source = provision.stop_state["source"]
    try:
        drafts = drafts_of(roots.data_dir / tenjin_arm.LOOP_DB, session, project)
        # Parent/source wallet remains outside every artifact and container mount.
        # Independent publication state means repeated identical drafts can be
        # republished after a corpus reset without adding artificial lesson text.
        with tempfile.TemporaryDirectory(prefix="bench1-publisher-") as temp:
            private = Path(temp)
            (private / "config.json").write_text(json.dumps({**source.config, "publish": {"mode": "auto"}}))
            (private / "config.json").chmod(0o600)
            (private / "wallet.json").symlink_to((source.path / "wallet.json").resolve())
            publisher = dataclasses.replace(source, path=private)
            seen = set()
            for index, (draft_hash, document) in enumerate(drafts):
                digest = sha256_text(document)
                if digest in seen:
                    continue
                seen.add(digest)
                body = private / f"draft-{index}.md"
                body.write_text(document, encoding="utf-8")
                code, payload, _tail = tenjin_arm._run_cli([*tenjin_arm.PUBLISH_ARGV(body, ()), "--price", "0"], tenjin_arm.cli_environment(publisher), source.secrets)
                piece_id = tenjin_arm.piece_id_of(payload)
                valid_id = isinstance(piece_id, str) and PIECE_ID.fullmatch(piece_id) is not None
                ok = code == 0 and valid_id and tenjin_arm._find(payload, "alreadyPublished") is not True and tenjin_arm._find(payload, "status") == "published" and tenjin_arm._find(payload, "ok") is not False
                item = {"draft_hash": draft_hash, "body_hash": digest, "piece_id": piece_id if valid_id else None, "published": bool(ok), "deleted": None}
                facts["pieces"].append(item)
                if valid_id:
                    # Retain ownership immediately so every exit path can delete.
                    provision.stop_state["pieces"].append(piece_id)
                if not ok:
                    facts["status"] = "unavailable"
                    # A nonzero/timeout response can still follow a remote write.
                    # Stop all admission, preserve evidence; reset before retry.
                    reason = "isolation:seed_cleanup"
                    break
    except (ProvisionError, OSError, sqlite3.Error):
        facts["status"] = "unavailable"
        reason = "producer:capture_publication"
    facts["wall_time_s"] = time.monotonic() - started
    return facts, reason
