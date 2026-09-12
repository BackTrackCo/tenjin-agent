"""Portable, content-checked resume evidence; never copy trial roots or credentials."""
from __future__ import annotations

import argparse
from dataclasses import asdict
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import sys

from . import frozen_corpus, manifest as manifests, records, schedule, server_revision

SCHEMA = "bench1.checkpoint.v1"
INDEX = "checkpoint.json"
NONCE = re.compile(r"\d{8}T\d{6}Z-[0-9a-f]{8}")
REVISION = re.compile(r"[0-9a-f]{40,64}")
ALLOWED = re.compile(r"(?:harness-lock\.json|manifest\.json|schedule\.json|corpus-baseline\.json|server-revision\.json|records/[0-9a-f]{24}\.json|corpus-epochs/[0-9a-f]{64}\.json)")


class CheckpointError(ValueError):
    pass


def encoded(value):
    return (json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + "\n").encode()


def digest(value):
    return "sha256:" + hashlib.sha256(value).hexdigest()


def read(root, name):
    path = root / name
    if any(item.is_symlink() for item in (path, *path.parents)) or not path.is_file():
        raise CheckpointError(f"missing or symlinked evidence: {name}")
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError) as error:
        raise CheckpointError(f"unreadable evidence: {name}") from error


def empty_destination(out):
    if any(item.is_symlink() for item in (out, *out.parents)):
        raise CheckpointError("destination must not use symlinks")
    if out.exists() and (not out.is_dir() or any(out.iterdir())):
        raise CheckpointError("destination must be empty")


def evidence(root, manifest):
    """Validate semantic identity before materializing any output."""
    sidecar = read(root, "manifest.json")
    if (not isinstance(sidecar, dict) or sidecar.get("hash") != manifest.hash
            or not isinstance(sidecar.get("nonce"), str) or not NONCE.fullmatch(sidecar["nonce"])):
        raise CheckpointError("manifest identity or nonce differs")
    trials = schedule.expand(manifest)
    frozen = {"manifest_hash": manifest.hash, "schedule_hash": schedule.schedule_hash(trials),
              "trials": [asdict(trial) for trial in trials]}
    if read(root, "schedule.json") != frozen:
        raise CheckpointError("full frozen schedule differs")
    payload = {"manifest.json": encoded({"hash": manifest.hash, "nonce": sidecar["nonce"]}),
               "schedule.json": encoded(frozen)}
    if manifest.release is not None:
        lock = read(manifest.path.parent, manifest.path.name)
        retained = root / "harness-lock.json"
        if retained.exists() and read(root, "harness-lock.json") != lock:
            raise CheckpointError("harness release lock differs")
        payload["harness-lock.json"] = encoded(lock)
    expected = {trial.trial_id: trial for trial in trials}
    accepted = {}
    directory = root / "records"
    if directory.is_symlink():
        raise CheckpointError("records directory must not be a symlink")
    for path in sorted(directory.iterdir()) if directory.exists() else []:
        if path.is_symlink():
            raise CheckpointError("record must not be a symlink")
        if ".partial." in path.name:
            continue
        name = "records/" + path.name
        if not ALLOWED.fullmatch(name):
            raise CheckpointError("unknown final record file")
        record = read(root, name)
        records.validate(record)
        trial = expected.get(path.stem)
        if (trial is None or record["manifest_hash"] != manifest.hash
                or record["schedule_hash"] != frozen["schedule_hash"]
                or any(record[key] != value for key, value in asdict(trial).items())):
            raise CheckpointError("record does not belong to the frozen schedule")
        record.pop("invalid_detail", None)
        accepted[path.stem] = record
        payload[name] = encoded(record)
    if manifest.corpus is not None:
        observed = server_revision.read(root)
        if observed is not None:
            if observed["manifest_hash"] != manifest.hash or observed["origin"] != manifest.corpus.origin:
                raise CheckpointError("remote server evidence differs")
            payload[server_revision.FILE] = encoded(observed)
        # Check selected paths before existing validators dereference them.
        baseline = read(root, frozen_corpus.BASELINE)
        saved = frozen_corpus.load(root, manifest.corpus, manifest.hash)
        if saved is None:
            raise CheckpointError("frozen corpus baseline is required")
        payload[frozen_corpus.BASELINE] = encoded(baseline)
        for record in accepted.values():
            stamp = record["isolation"].get("corpus") or {}
            if (stamp.get("baseline_id") != saved["baseline_id"]
                    or stamp.get("source_lsn") != saved["identity"]["source_lsn"]
                    or any(stamp.get(key) != value for key, value in manifest.corpus.facts.items())):
                raise CheckpointError("record corpus baseline differs")
            epoch = stamp.get("epoch_id", "")
            if not isinstance(epoch, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", epoch):
                raise CheckpointError("record epoch is missing")
            name = f"corpus-epochs/{epoch[7:]}.json"
            payload[name] = encoded(read(root, name))
        frozen_corpus.verify_records(root, accepted)
    elif any(record["isolation"].get("corpus") for record in accepted.values()):
        raise CheckpointError("corpus-free manifest has corpus records")
    return payload, frozen["schedule_hash"]


def write_payload(out, payload):
    empty_destination(out)
    out.mkdir(parents=True, exist_ok=True)
    for name, data in payload.items():
        path = out / name
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("xb") as stream:
            stream.write(data)


def export_run(run: Path, out: Path, manifest_path: Path, revision: str):
    empty_destination(out)
    if not REVISION.fullmatch(revision):
        raise CheckpointError("revision must be the exact Git commit ID")
    manifest = manifests.load(manifest_path)
    payload, schedule_hash = evidence(run, manifest)
    index = {"schema": SCHEMA, "revision": revision, "runtime_revision": frozen_corpus.RUNTIME_REVISION,
             "manifest_hash": manifest.hash, "schedule_hash": schedule_hash,
             "files": {name: digest(data) for name, data in payload.items()}}
    payload[INDEX] = encoded(index)
    write_payload(out, payload)
    return {"checkpoint": str(out), "records": sum(name.startswith("records/") for name in payload)}


def import_run(checkpoint: Path, out: Path, manifest_path: Path, revision: str):
    empty_destination(out)
    index = read(checkpoint, INDEX)
    manifest = manifests.load(manifest_path)
    if (not isinstance(index, dict) or set(index) != {"schema", "revision", "runtime_revision", "manifest_hash", "schedule_hash", "files"}
            or index["schema"] != SCHEMA or not REVISION.fullmatch(revision)
            or index["revision"] != revision or index["runtime_revision"] != frozen_corpus.RUNTIME_REVISION
            or index["manifest_hash"] != manifest.hash or not isinstance(index["files"], dict)):
        raise CheckpointError("checkpoint revision, runtime or manifest differs")
    names = set(index["files"])
    if any(not isinstance(name, str) or not ALLOWED.fullmatch(name)
           or str(PurePosixPath(name)) != name for name in names):
        raise CheckpointError("unknown or unsafe checkpoint path")
    present = set()
    permitted_dirs = {"records", "corpus-epochs"}
    for path in checkpoint.rglob("*"):
        if path.is_symlink():
            raise CheckpointError("checkpoint must not contain symlinks")
        name = path.relative_to(checkpoint).as_posix()
        if path.is_dir():
            if name not in permitted_dirs:
                raise CheckpointError("unknown checkpoint directory")
        elif path.is_file():
            present.add(name)
        else:
            raise CheckpointError("checkpoint must contain regular files only")
    if present != names | {INDEX}:
        raise CheckpointError("checkpoint file inventory differs")
    for name, expected in index["files"].items():
        read(checkpoint, name)
        if digest((checkpoint / name).read_bytes()) != expected:
            raise CheckpointError("checkpoint content hash differs")
    payload, schedule_hash = evidence(checkpoint, manifest)
    if set(payload) != names or schedule_hash != index["schedule_hash"]:
        raise CheckpointError("checkpoint evidence inventory or schedule differs")
    # The portable sidecar must never carry a supplied host path/private additions.
    if read(checkpoint, "manifest.json") != json.loads(payload["manifest.json"]):
        raise CheckpointError("checkpoint manifest sidecar has unknown fields")
    sidecar = json.loads(payload["manifest.json"])
    manifest_path = out / "harness-lock.json" if manifest.release is not None else manifest.path
    payload["manifest.json"] = encoded({**sidecar, "path": str(manifest_path.resolve())})
    payload["schedule.sha256"] = (schedule_hash + "\n").encode()
    write_payload(out, payload)
    return {"run": str(out), "records": sum(name.startswith("records/") for name in payload)}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("export", "import"))
    parser.add_argument("--run", type=Path, required=True, help="source run, or exported checkpoint for import")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--revision", required=True)
    args = parser.parse_args(argv)
    try:
        result = (export_run if args.action == "export" else import_run)(args.run, args.out, args.manifest, args.revision)
    except (ValueError, OSError, frozen_corpus.corpus.CorpusError) as error:
        print(f"checkpoint refused: {error}", file=sys.stderr)
        return 2
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
