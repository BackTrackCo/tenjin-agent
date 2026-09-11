"""Checkpoint portability and refusal tests use fabricated normalized records only."""
import json
import shutil
from dataclasses import asdict

import pytest

from evals.benchmark import FIXTURES, artifact, checkpoint, corpus, frozen_corpus, manifest, schedule, sha256_json
from . import support

REVISION = "a" * 40
NONCE = "20260911T120000Z-12345678"


def put(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(checkpoint.encoded(value))


def source(tmp_path, with_corpus=False):
    manifest_path = FIXTURES / "fake" / "manifest.json"
    if with_corpus:
        data = json.loads(manifest_path.read_text())
        data["corpus"] = {"provider": "neon", "project_id": "project", "branch_id": "target",
                          "parent_id": "source", "origin": "bench.example"}
        shutil.copytree(manifest_path.parent / "repo", tmp_path / "repo")
        manifest_path = tmp_path / "input.json"
        put(manifest_path, data)
    selected = manifest.load(manifest_path)
    run = tmp_path / "run"
    trials = schedule.expand(selected)
    digest = schedule.write(run, selected, trials)
    put(run / "manifest.json", {"path": str(manifest_path), "hash": selected.hash, "nonce": NONCE})
    trial = trials[0]
    record = support.reduction_record(trial.task_id, trial.arm_id, trial.repeat, trial.position, 100, "invalid",
                                     manifest_hash=selected.hash, schedule_hash=digest)
    record["invalid_detail"] = "private host diagnostic must not leave"
    if with_corpus:
        identity = {"runtime_revision": frozen_corpus.RUNTIME_REVISION, "manifest_hash": selected.hash,
                    "corpus": selected.corpus.facts, "source_lsn": "0/ABC",
                    "source_generation": {"id": "source", "parent_id": None, "created_at": "2026-09-01T00:00:00Z", "last_reset_at": None}}
        baseline = {"schema": frozen_corpus.SCHEMA, "identity": identity, "baseline_id": "sha256:" + sha256_json(identity)}
        put(run / frozen_corpus.BASELINE, baseline)
        stamp = asdict(artifact.CorpusStamp(**selected.corpus.facts, api_origin=corpus.API_ORIGIN,
                      reset_at="2026-09-11T12:00:00Z", source_lsn="0/ABC", baseline_id=baseline["baseline_id"]))
        epoch = {"stamp": stamp, "operation_ids": ["op-1"], "target_last_reset_at": "2026-09-11T12:00:00Z"}
        epoch_hash = sha256_json(epoch)
        stamp["epoch_id"] = "sha256:" + epoch_hash
        put(run / "corpus-epochs" / f"{epoch_hash}.json", epoch)
        record["isolation"]["corpus"] = stamp
    put(run / "records" / f"{trial.trial_id}.json", record)
    return run, manifest_path, record


@pytest.mark.parametrize("with_corpus", [False, True])
def test_roundtrip_preserves_nonce_schedule_and_sanitized_records(tmp_path, with_corpus):
    run, path, record = source(tmp_path, with_corpus)
    # Trial material must never be copied.
    put(run / "trials" / "auth.json", {"secret": "not exported"})
    bundle, restored = tmp_path / "bundle", tmp_path / "restored"
    checkpoint.export_run(run, bundle, path, REVISION)
    assert json.loads((bundle / "manifest.json").read_text()) == {"hash": manifest.load(path).hash, "nonce": NONCE}
    assert not (bundle / "trials").exists()
    checkpoint.import_run(bundle, restored, path, REVISION)
    received = json.loads(next((restored / "records").glob("*.json")).read_text())
    assert received == {key: value for key, value in record.items() if key != "invalid_detail"}
    assert json.loads((restored / "manifest.json").read_text())["nonce"] == NONCE
    assert json.loads((restored / "manifest.json").read_text())["path"] == str(path.resolve())
    assert (run / "schedule.json").read_bytes() != b""
    assert json.loads((run / "schedule.json").read_text()) == json.loads((restored / "schedule.json").read_text())


@pytest.mark.parametrize("change", ["revision", "runtime", "content", "traversal", "unknown", "symlink", "schedule"])
def test_import_refuses_before_writing_destination(tmp_path, change):
    run, path, _ = source(tmp_path)
    bundle, restored = tmp_path / "bundle", tmp_path / "restored"
    checkpoint.export_run(run, bundle, path, REVISION)
    index = json.loads((bundle / checkpoint.INDEX).read_text())
    revision = REVISION
    if change == "revision":
        revision = "b" * 40
    elif change == "runtime":
        index["runtime_revision"] = "sha256:" + "b" * 64
    elif change == "content":
        (bundle / "schedule.json").write_text("{}")
    elif change == "traversal":
        index["files"]["../outside.json"] = "sha256:" + "a" * 64
    elif change == "unknown":
        put(bundle / "auth.json", {})
    elif change == "symlink":
        (bundle / "manifest.json").unlink()
        (bundle / "manifest.json").symlink_to(run / "manifest.json")
    elif change == "schedule":
        changed = json.loads((bundle / "schedule.json").read_text())
        changed["trials"] = changed["trials"][:-1]
        put(bundle / "schedule.json", changed)
        index["files"]["schedule.json"] = checkpoint.digest((bundle / "schedule.json").read_bytes())
    put(bundle / checkpoint.INDEX, index)
    with pytest.raises(ValueError):
        checkpoint.import_run(bundle, restored, path, revision)
    assert not restored.exists()


def test_missing_epoch_refuses_export_before_output(tmp_path):
    run, path, _ = source(tmp_path, True)
    next((run / "corpus-epochs").glob("*.json")).unlink()
    with pytest.raises(ValueError, match="evidence"):
        checkpoint.export_run(run, tmp_path / "bundle", path, REVISION)
    assert not (tmp_path / "bundle").exists()


def test_missing_indexed_epoch_refuses_import(tmp_path):
    run, path, _ = source(tmp_path, True)
    bundle = tmp_path / "bundle"
    checkpoint.export_run(run, bundle, path, REVISION)
    next((bundle / "corpus-epochs").glob("*.json")).unlink()
    with pytest.raises(ValueError, match="inventory"):
        checkpoint.import_run(bundle, tmp_path / "restored", path, REVISION)
    assert not (tmp_path / "restored").exists()


def test_destination_must_be_empty(tmp_path):
    run, path, _ = source(tmp_path)
    bundle = tmp_path / "bundle"
    put(bundle / "existing.json", {"preserve": True})
    with pytest.raises(ValueError, match="empty"):
        checkpoint.export_run(run, bundle, path, REVISION)
    assert json.loads((bundle / "existing.json").read_text()) == {"preserve": True}
