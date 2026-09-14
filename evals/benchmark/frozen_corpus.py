"""Restore one immutable Neon baseline per schedule; keep each actual reset receipt."""
from __future__ import annotations

import json
import datetime
import re
from dataclasses import asdict, replace
from pathlib import Path

from . import corpus, sha256_file, sha256_json

SCHEMA = "bench1.corpus-baseline.v1"
BASELINE = "corpus-baseline.json"
RUNTIME_REVISION = "sha256:" + sha256_json({path.name: sha256_file(path) for path in sorted(Path(__file__).parent.glob("*.py"))})
LSN = re.compile(r"[0-9A-F]+/[0-9A-F]+")


def generation(api, config):
    row = api.branch(config.project_id, config.parent_id)
    if row.get("id") != config.parent_id or not isinstance(row.get("created_at"), str) or not row["created_at"]:
        raise corpus.CorpusError("source_unconfirmed", "source branch generation could not be verified")
    return {key: row.get(key) for key in ("id", "parent_id", "created_at", "last_reset_at")}


def load(out: Path, config: corpus.Corpus, identity: str):
    path = out / BASELINE
    if not path.exists():
        if any((out / "records").glob("*.json")):
            raise corpus.CorpusError("baseline_missing", "retained records have no frozen corpus baseline")
        return None
    try:
        saved = json.loads(path.read_text())
        facts = saved["identity"]
        expected = "sha256:" + sha256_json(facts)
        valid = (saved["schema"] == SCHEMA and saved["baseline_id"] == expected
                 and facts["runtime_revision"] == RUNTIME_REVISION and facts["manifest_hash"] == identity and facts["corpus"] == config.facts
                 and set(facts["source_generation"]) == {"id", "parent_id", "created_at", "last_reset_at"}
                 and facts["source_generation"]["id"] == config.parent_id
                 and isinstance(facts["source_lsn"], str) and LSN.fullmatch(facts["source_lsn"]))
    except (OSError, ValueError, KeyError, TypeError):
        valid = False
    if not valid:
        raise corpus.CorpusError("baseline_mismatch", "frozen corpus baseline differs or is unreadable; evidence was not changed")
    return saved


def reset(config: corpus.Corpus, api, out: Path, identity: str):
    saved = load(out, config, identity)
    source = generation(api, config)
    if saved is not None and source != saved["identity"]["source_generation"]:
        raise corpus.CorpusError("source_changed", "frozen source branch generation changed; never fall back to head")
    corpus.guard(config, api.branch(config.project_id, config.branch_id))
    lsn = None if saved is None else saved["identity"]["source_lsn"]
    # Restore retention/expiry errors propagate. Head is used only for the first epoch.
    receipt = api.reset_to_parent(config.project_id, config.branch_id, config.parent_id, source_lsn=lsn)
    settled = api.branch(config.project_id, config.branch_id)
    corpus.guard(config, settled)
    resolved = settled.get("parent_lsn")
    if not isinstance(resolved, str) or not LSN.fullmatch(resolved) or (lsn is not None and resolved != lsn):
        raise corpus.CorpusError("revision_unconfirmed", "settled restore did not confirm the frozen source LSN")
    if generation(api, config) != source:
        raise corpus.CorpusError("source_changed", "source branch changed during restore; no trial may start")
    if saved is None:
        facts = {"runtime_revision": RUNTIME_REVISION, "manifest_hash": identity, "corpus": config.facts, "source_generation": source, "source_lsn": resolved}
        saved = {"schema": SCHEMA, "identity": facts, "baseline_id": "sha256:" + sha256_json(facts)}
        out.mkdir(parents=True, exist_ok=True)
        # Exclusive creation; the outer run lease owns the whole operation.
        with (out / BASELINE).open("x") as stream:
            json.dump(saved, stream, indent=2)
    stamp = corpus.artifact.CorpusStamp(**config.facts, api_origin=corpus.API_ORIGIN, reset_at=datetime.datetime.now(datetime.UTC).isoformat(),
                                        baseline_id=saved["baseline_id"], source_lsn=resolved)
    epochs = out / "corpus-epochs"
    epochs.mkdir(exist_ok=True)
    operations = corpus._operation_ids(receipt)
    evidence = {"stamp": asdict(stamp), "operation_ids": operations, "target_last_reset_at": settled.get("last_reset_at")}
    key = sha256_json(evidence)
    stamp = replace(stamp, epoch_id="sha256:" + key)
    evidence["stamp"] = asdict(stamp)
    with (epochs / f"{key}.json").open("x") as stream:
        json.dump(evidence, stream, indent=2)
    return stamp


def verify_records(out: Path, accepted):
    """A frozen record must name its retained, content-verified reset receipt."""
    for record in accepted.values():
        stamp = record["isolation"].get("corpus")
        if not stamp or not stamp.get("baseline_id"):
            continue
        try:
            epoch_id = stamp["epoch_id"]
            if not isinstance(epoch_id, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", epoch_id):
                raise ValueError("epoch id missing")
            evidence = json.loads((out / "corpus-epochs" / f"{epoch_id[7:]}.json").read_text())
            if evidence["stamp"] != stamp or not evidence["operation_ids"]:
                raise ValueError("epoch receipt differs")
            identity = {**evidence, "stamp": {**stamp, "epoch_id": None}}
            if "sha256:" + sha256_json(identity) != epoch_id:
                raise ValueError("epoch hash differs")
        except (OSError, ValueError, KeyError, TypeError) as error:
            raise corpus.CorpusError("epoch_unconfirmed", "frozen record has no matching immutable reset receipt") from error
