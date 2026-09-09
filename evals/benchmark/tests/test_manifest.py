"""Frozen manifest: every rejection happens before any spend."""

from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path

from evals.benchmark import cli, manifest
from evals.benchmark.manifest import ManifestError


class ManifestTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.base = json.loads(cli.FAKE_MANIFEST.read_text())
        cls.dir = cli.FAKE_MANIFEST.parent

    def check(self, data: dict) -> None:
        manifest.validate(data, self.dir)

    def test_fake_manifest_loads_with_a_stable_hash(self) -> None:
        first, second = manifest.load(cli.FAKE_MANIFEST), manifest.load(cli.FAKE_MANIFEST)
        self.assertEqual(first.hash, second.hash)
        self.assertEqual(first.harness, "claude")
        self.assertNotEqual(first.hash, manifest.sha256_json({**first.data, "seed": first.data["seed"] + 1}))

    def test_manifest_rejects_bad_shapes(self) -> None:
        base = self.base
        task, arm = base["tasks"][0], base["arms"][0]
        cases = {
            "unknown key": {**base, "extra": 1},
            "missing key": {key: value for key, value in base.items() if key != "seed"},
            "unknown schema": {**base, "schema_version": 2},
            "unknown harness": {**base, "harness": "other"},
            "duplicate task": {**base, "tasks": [task, task]},
            "duplicate arm": {**base, "arms": [arm, arm]},
            "one arm": {**base, "arms": [arm]},
            "missing fixture": {**base, "tasks": [{**task, "fixture": "nope"}]},
            "absolute fixture": {**base, "tasks": [{**task, "fixture": "/etc"}]},
            "escaping fixture": {**base, "tasks": [{**task, "fixture": "../fake/repo"}]},
            "fixture hash": {**base, "tasks": [{**task, "fixture_hash": "sha256:other"}]},
            "transfer distance": {**base, "tasks": [{**task, "transfer_distance": "far"}]},
            "task id not opaque": {**base, "tasks": [{**task, "id": "answer file"}]},
            "unpinned model": {**base, "pins": {**base["pins"], "model": "latest"}},
            "unpinned effort": {**base, "pins": {**base["pins"], "effort": ""}},
            "range version": {**base, "pins": {**base["pins"], "harness_version": "^2.1.0"}},
            "missing pin": {**base, "pins": {key: value for key, value in base["pins"].items() if key != "permission_mode"}},
            "lock hash": {**base, "pins": {**base["pins"], "dependency_lock_hash": "none"}},
            "zero wall clock": {**base, "pins": {**base["pins"], "wall_clock_s": 0}},
            "boolean turns": {**base, "pins": {**base["pins"], "turn_budget": True}},
            "zero repeats": {**base, "repeats": 0},
            "negative seed": {**base, "seed": -1},
            "unpinned product": {**base, "arms": [{**arm, "product_version": "latest"}, base["arms"][1]]},
            "settings hash": {**base, "arms": [{**arm, "settings_hash": "off"}, base["arms"][1]]},
            "mixed executors": {**base, "arms": [arm, {**base["arms"][1], "executor": "real"}]},
            "unknown auxiliary exposure": {**base, "arms": [{**arm, "auxiliary_usage": "maybe"}, base["arms"][1]]},
            "undeclared auxiliary exposure": {
                **base,
                "arms": [{key: value for key, value in arm.items() if key != "auxiliary_usage"}, base["arms"][1]],
            },
            "phase keys": {**base, "phases": {"producer": "x"}},
            "empty phase": {**base, "phases": {**base["phases"], "capture": ""}},
            "seed path is not an arm key": {**base, "arms": [{**arm, "provision": "tenjin", "seed": "local"}, base["arms"][1]]},
            "producer without provision": {**base, "arms": [{**arm, "producer": True}, base["arms"][1]]},
            "producer not a boolean": {**base, "arms": [{**arm, "provision": "tenjin", "producer": "yes"}, base["arms"][1]]},
            "slice kind": {**base, "slice": {"kind": "fast"}},
            "retired slice": {**base, "slice": {"kind": "scale", "distractors": 50}},
            "slice with an extra key": {**base, "slice": {"kind": "recursive", "distractors": 1}},
            "recursive slice without a subagent task": {**base, "slice": {"kind": "recursive"}},
            "subagent tool outside a recursive slice": {**base, "tasks": [{**task, "tools": ["Agent"]}]},
            "task tools not strings": {**base, "tasks": [{**task, "tools": [1]}]},
        }
        for name, data in cases.items():
            with self.subTest(name), self.assertRaises(ManifestError):
                self.check(data)

    def test_a_slice_and_a_producer_arm_validate(self) -> None:
        data = json.loads(json.dumps(self.base))
        data["arms"][1].update({"provision": "tenjin", "producer": True, "lessons": ["actor-fix"]})
        self.check(data)
        recursive = {**data, "slice": {"kind": "recursive"}, "tasks": [{**data["tasks"][0], "tools": ["Bash", "Agent"], "allowed_tools": ["Bash(pnpm:*)"]}]}
        self.check(recursive)
        loaded = manifest.Manifest(data=recursive, path=self.dir / "manifest.json", hash="sha256:x")
        self.assertEqual(loaded.slice, {"kind": "recursive"})
        self.assertIsNone(manifest.Manifest(data=data, path=self.dir / "manifest.json", hash="sha256:x").slice)

    def test_fixture_hash_tracks_fixture_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            shutil.copytree(self.dir / "repo", root / "repo")
            data = json.loads(json.dumps(self.base))
            data["tasks"][0]["fixture_hash"] = manifest.fixture_hash(root / "repo")
            manifest.validate(data, root)
            (root / "repo" / "TASK.md").write_text("changed\n", encoding="utf-8")
            with self.assertRaises(ManifestError):
                manifest.validate(data, root)

    def test_load_rejects_non_object_and_unreadable(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "manifest.json"
            path.write_text("[]", encoding="utf-8")
            with self.assertRaises(ManifestError):
                manifest.load(path)
            with self.assertRaises(ManifestError):
                manifest.load(Path(tmp) / "missing.json")


class HooksDisabledTest(unittest.TestCase):
    """Who may turn a product hook arm off, and who may not."""

    def manifest(self, **arm: object) -> dict:
        data = json.loads(Path(cli.HOOKS_SMOKE_MANIFEST).read_text(encoding="utf-8"))
        data["arms"][1].update(arm)
        return data

    def test_a_provisioned_consumption_arm_may_disable_a_hook_arm(self) -> None:
        manifest.validate(self.manifest(hooks_disabled=["publish"]), cli.HOOKS_SMOKE_MANIFEST.parent)

    def test_an_arm_that_captures_may_not_disable_one(self) -> None:
        with self.assertRaises(ManifestError) as caught:
            manifest.validate(self.manifest(hooks_disabled=["publish"], producer=True), cli.HOOKS_SMOKE_MANIFEST.parent)
        self.assertIn("captures", str(caught.exception))

    def test_an_unprovisioned_arm_has_no_seeded_config_to_write_it_into(self) -> None:
        data = json.loads(Path(cli.HOOKS_SMOKE_MANIFEST).read_text(encoding="utf-8"))
        data["arms"][0]["hooks_disabled"] = ["publish"]
        with self.assertRaises(ManifestError) as caught:
            manifest.validate(data, cli.HOOKS_SMOKE_MANIFEST.parent)
        self.assertIn("provisioned arm", str(caught.exception))

    def test_an_empty_list_is_not_a_choice(self) -> None:
        with self.assertRaises(ManifestError):
            manifest.validate(self.manifest(hooks_disabled=[]), cli.HOOKS_SMOKE_MANIFEST.parent)


if __name__ == "__main__":
    unittest.main()
