"""Frozen manifest: every rejection happens before any spend."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from evals.benchmark import cli, manifest, presets
from evals.benchmark.manifest import ManifestError


def committed(path: Path) -> dict:
    """A committed manifest as `load` hands it on: presets expanded, which is what `validate` is defined over."""
    return presets.expand(json.loads(path.read_text(encoding="utf-8")))


def provisioned_arm(**arm: object) -> dict:
    """The hooks smoke manifest with its provisioned arm carrying one more choice."""
    data = committed(cli.HOOKS_SMOKE_MANIFEST)
    data["arms"][1].update(arm)
    return data


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
    "one arm": {**BASE, "arms": [ARM]},
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
    "seed path is not an arm key": {**BASE, "arms": [{**ARM, "provision": "tenjin", "seed": "local"}, BASE["arms"][1]]},
    "producer without provision": {**BASE, "arms": [{**ARM, "producer": True}, BASE["arms"][1]]},
    "producer not a boolean": {**BASE, "arms": [{**ARM, "provision": "tenjin", "producer": "yes"}, BASE["arms"][1]]},
    "slice kind": {**BASE, "slice": {"kind": "fast"}},
    "retired slice": {**BASE, "slice": {"kind": "scale", "distractors": 50}},
    "slice with an extra key": {**BASE, "slice": {"kind": "recursive", "distractors": 1}},
    "recursive slice without a subagent task": {**BASE, "slice": {"kind": "recursive"}},
    "subagent tool outside a recursive slice": {**BASE, "tasks": [{**TASK, "tools": ["Agent"]}]},
    "task tools not strings": {**BASE, "tasks": [{**TASK, "tools": [1]}]},
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


def test_a_slice_and_a_producer_arm_validate() -> None:
    data = json.loads(json.dumps(BASE))
    data["arms"][1].update({"provision": "tenjin", "producer": True, "lessons": ["actor-fix"]})
    manifest.validate(data, DIR)
    recursive = {**data, "slice": {"kind": "recursive"}, "tasks": [{**data["tasks"][0], "tools": ["Bash", "Agent"], "allowed_tools": ["Bash(pnpm:*)"]}]}
    manifest.validate(recursive, DIR)
    loaded = manifest.Manifest(data=recursive, path=DIR / "manifest.json", hash="sha256:x")
    assert loaded.slice == {"kind": "recursive"}
    assert manifest.Manifest(data=data, path=DIR / "manifest.json", hash="sha256:x").slice is None


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


# Who may turn a product hook arm off, and who may not.


def test_a_provisioned_consumption_arm_may_disable_a_hook_arm() -> None:
    manifest.validate(provisioned_arm(hooks_disabled=["publish"]), cli.HOOKS_SMOKE_MANIFEST.parent)


def test_an_arm_that_captures_may_not_disable_one() -> None:
    with pytest.raises(ManifestError) as caught:
        manifest.validate(provisioned_arm(hooks_disabled=["publish"], producer=True), cli.HOOKS_SMOKE_MANIFEST.parent)
    assert "captures" in str(caught.value)


def test_an_empty_list_is_not_a_choice() -> None:
    with pytest.raises(ManifestError):
        manifest.validate(provisioned_arm(hooks_disabled=[]), cli.HOOKS_SMOKE_MANIFEST.parent)


# The product's `team.publicFallback` as an arm's choice, and the default that keeps every old manifest true.


def test_a_provisioned_arm_may_turn_the_marketplace_leg_off() -> None:
    manifest.validate(provisioned_arm(public_fallback="off"), cli.HOOKS_SMOKE_MANIFEST.parent)
    manifest.validate(provisioned_arm(public_fallback="on"), cli.HOOKS_SMOKE_MANIFEST.parent)


def test_an_arm_that_names_nothing_is_still_valid() -> None:
    data = committed(cli.HOOKS_SMOKE_MANIFEST)
    assert "public_fallback" not in data["arms"][1]
    manifest.validate(data, cli.HOOKS_SMOKE_MANIFEST.parent)


@pytest.mark.parametrize("value", ["false", "", True, None])
def test_a_value_the_product_has_no_setting_for_is_refused(value: object) -> None:
    with pytest.raises(ManifestError) as caught:
        manifest.validate(provisioned_arm(public_fallback=value), cli.HOOKS_SMOKE_MANIFEST.parent)
    assert "public_fallback" in str(caught.value)


@pytest.mark.parametrize("key, value", [("hooks_disabled", ["publish"]), ("public_fallback", "off")])
def test_an_unprovisioned_arm_has_no_seeded_config_to_write_it_into(key: str, value: object) -> None:
    data = committed(cli.HOOKS_SMOKE_MANIFEST)
    data["arms"][0][key] = value
    with pytest.raises(ManifestError) as caught:
        manifest.validate(data, cli.HOOKS_SMOKE_MANIFEST.parent)
    assert "provisioned arm" in str(caught.value)


@pytest.fixture(autouse=True)
def generated_hooks_input(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from evals.benchmark.tests import live_inputs
    monkeypatch.setattr(cli, "HOOKS_SMOKE_MANIFEST", live_inputs.write(tmp_path / "hooks-input", hooks=True), raising=False)
