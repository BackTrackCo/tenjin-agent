"""Frozen manifest: every rejection happens before any spend."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from evals.benchmark import cli, manifest
from evals.benchmark.manifest import ManifestError

BASE = json.loads(cli.FAKE_MANIFEST.read_text())
DIR = cli.FAKE_MANIFEST.parent
TASK, ARM = BASE["tasks"][0], BASE["arms"][0]

BAD_SHAPES = {
    "unknown key": {**BASE, "extra": 1},
    "missing key": {key: value for key, value in BASE.items() if key != "seed"},
    "unknown schema": {**BASE, "schema_version": 2},
    "unknown harness": {**BASE, "harness": "other"},
    "duplicate task": {**BASE, "tasks": [TASK, TASK]},
    "duplicate arm": {**BASE, "arms": [ARM, ARM]},
    "no arms": {**BASE, "arms": []},
    "missing fixture": {**BASE, "tasks": [{**TASK, "fixture": "nope"}]},
    "absolute fixture": {**BASE, "tasks": [{**TASK, "fixture": "/etc"}]},
    "escaping fixture": {**BASE, "tasks": [{**TASK, "fixture": "../fake/repo"}]},
    "fixture hash": {**BASE, "tasks": [{**TASK, "fixture_hash": "sha256:other"}]},
    "transfer distance": {**BASE, "tasks": [{**TASK, "transfer_distance": "far"}]},
    "task id not opaque": {**BASE, "tasks": [{**TASK, "id": "answer file"}]},
    "unpinned model": {**BASE, "pins": {**BASE["pins"], "model": "latest"}},
    "unpinned effort": {**BASE, "pins": {**BASE["pins"], "effort": ""}},
    "range version": {**BASE, "pins": {**BASE["pins"], "harness_version": "^2.1.0"}},
    "missing pin": {**BASE, "pins": {key: value for key, value in BASE["pins"].items() if key != "permission_mode"}},
    "lock hash": {**BASE, "pins": {**BASE["pins"], "dependency_lock_hash": "none"}},
    "zero wall clock": {**BASE, "pins": {**BASE["pins"], "wall_clock_s": 0}},
    "boolean turns": {**BASE, "pins": {**BASE["pins"], "turn_budget": True}},
    "zero concurrency": {**BASE, "pins": {**BASE["pins"], "concurrency": 0}},
    "boolean concurrency": {**BASE, "pins": {**BASE["pins"], "concurrency": True}},
    "fractional concurrency": {**BASE, "pins": {**BASE["pins"], "concurrency": 2.5}},
    "zero repeats": {**BASE, "repeats": 0},
    "negative seed": {**BASE, "seed": -1},
    "unpinned product": {**BASE, "arms": [{**ARM, "product_version": "latest"}, BASE["arms"][1]]},
    "settings hash": {**BASE, "arms": [{**ARM, "settings_hash": "off"}, BASE["arms"][1]]},
    "mixed executors": {**BASE, "arms": [ARM, {**BASE["arms"][1], "executor": "real"}]},
    "unknown auxiliary exposure": {**BASE, "arms": [{**ARM, "auxiliary_usage": "maybe"}, BASE["arms"][1]]},
    "undeclared auxiliary exposure": {
        **BASE,
        "arms": [{key: value for key, value in ARM.items() if key != "auxiliary_usage"}, BASE["arms"][1]],
    },
    "phase keys": {**BASE, "phases": {"producer": "x"}},
    "empty phase": {**BASE, "phases": {**BASE["phases"], "capture": ""}},
    # A membership test alone raised TypeError on an unhashable value, which
    # escaped this module's refusal contract; a schema keyword refuses it.
    "harness that is not hashable": {**BASE, "harness": ["claude"]},
    "transfer distance that is not hashable": {**BASE, "tasks": [{**TASK, "transfer_distance": {}}]},
    "auxiliary exposure that is not hashable": {**BASE, "arms": [{**ARM, "auxiliary_usage": []}, BASE["arms"][1]]},
    # `True == 1` in Python, so a boolean used to pass for the schema version.
    "boolean schema version": {**BASE, "schema_version": True},
}


def test_fake_manifest_loads_with_a_stable_hash() -> None:
    first, second = manifest.load(cli.FAKE_MANIFEST), manifest.load(cli.FAKE_MANIFEST)
    assert first.hash == second.hash
    assert first.harness == "claude"
    assert first.hash != manifest.sha256_json({**first.data, "seed": first.data["seed"] + 1})


@pytest.mark.parametrize("data", list(BAD_SHAPES.values()), ids=list(BAD_SHAPES))
def test_manifest_rejects_bad_shapes(data: dict) -> None:
    with pytest.raises(ManifestError):
        manifest.validate(data, DIR)


def test_concurrency_defaults_to_one_and_rides_the_environment_hash() -> None:
    # Absent is one, so every committed manifest runs exactly as it did
    # before the pin existed, and the pin is opt-in per manifest.
    assert manifest.load(cli.FAKE_MANIFEST).concurrency == 1
    assert "concurrency" not in BASE["pins"]
    concurrent = {**BASE, "pins": {**BASE["pins"], "concurrency": 4}}
    manifest.validate(concurrent, DIR)
    assert manifest.Manifest(data=concurrent, path=cli.FAKE_MANIFEST, hash="sha256:x").concurrency == 4
    # `environment_hash` in every record is the hash of the pins, so two
    # runs at different degrees are already distinguishable there.
    assert manifest.sha256_json(concurrent["pins"]) != manifest.sha256_json(BASE["pins"])


def test_fixture_hash_tracks_fixture_bytes(tmp_path: Path) -> None:
    shutil.copytree(DIR / "repo", tmp_path / "repo")
    data = json.loads(json.dumps(BASE))
    data["tasks"][0]["fixture_hash"] = manifest.fixture_hash(tmp_path / "repo")
    manifest.validate(data, tmp_path)
    (tmp_path / "repo" / "TASK.md").write_text("changed\n", encoding="utf-8")
    with pytest.raises(ManifestError):
        manifest.validate(data, tmp_path)


def test_load_rejects_non_object_and_unreadable(tmp_path: Path) -> None:
    path = tmp_path / "manifest.json"
    path.write_text("[]", encoding="utf-8")
    with pytest.raises(ManifestError):
        manifest.load(path)
    with pytest.raises(ManifestError):
        manifest.load(tmp_path / "missing.json")
