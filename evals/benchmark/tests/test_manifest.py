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
            "phase keys": {**base, "phases": {"producer": "x"}},
            "empty phase": {**base, "phases": {**base["phases"], "capture": ""}},
        }
        for name, data in cases.items():
            with self.subTest(name), self.assertRaises(ManifestError):
                self.check(data)

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


if __name__ == "__main__":
    unittest.main()
