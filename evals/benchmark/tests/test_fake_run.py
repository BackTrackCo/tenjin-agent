"""The walking skeleton: one fake manifest through every seam, offline."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from evals.benchmark import cli, manifest, records, report, schedule
from evals.benchmark.manifest import ManifestError


class FakeRunTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.TemporaryDirectory()
        cls.out = Path(cls.tmp.name) / "run"
        cls.first = cli.fake_run(cls.out)
        cls.second = cli.fake_run(cls.out)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.tmp.cleanup()

    def test_schedule_and_hash_are_written(self) -> None:
        payload = json.loads((self.out / "schedule.json").read_text())
        digest = (self.out / "schedule.sha256").read_text().strip()
        self.assertEqual(payload["schedule_hash"], digest)
        self.assertEqual(self.first["schedule_hash"], digest)
        self.assertEqual(len(payload["trials"]), 2)

    def test_every_trial_passes_and_counts_each_request_once(self) -> None:
        self.assertEqual(set(self.first["outcomes"].values()), {"pass"})
        for path in (self.out / "records").glob("*.json"):
            record = json.loads(path.read_text())
            self.assertEqual(record["outcome"], "pass")
            # Root emits req_1 (partial + final rows) and req_2; the child emits one.
            self.assertEqual([item["native_request_id"] for item in record["usage"]], ["req_1", "req_2", "req_c1"])
            self.assertEqual(len(record["actors"]), 2)
            self.assertEqual(record["actors"][0][2], "")
            self.assertEqual(record["parent_provenance"], "unavailable")
            self.assertEqual(record["delivery"]["status"], "unavailable")
            self.assertIsNone(record["usage"][0]["reasoning_output_subset"])

    def test_resume_skips_every_published_record(self) -> None:
        self.assertEqual(self.first["resumed"], 0)
        self.assertEqual(self.second["resumed"], 2)
        self.assertEqual(self.first["outcomes"], self.second["outcomes"])

    def test_report_is_publishable(self) -> None:
        payload = json.loads((self.out / "report.json").read_text())
        report.guard(payload)
        self.assertEqual(set(payload["arms"]), {"off", "on"})
        for arm in payload["arms"].values():
            self.assertEqual(arm["pass_rate"], 1.0)
            self.assertIsNotNone(arm["tokens_per_verified_resolution"])
        self.assertGreater(payload["arms"]["off"]["tokens"], payload["arms"]["on"]["tokens"])

    def test_verifier_bytes_are_absent_from_the_agent_mount(self) -> None:
        for trial in (self.out / "trials").iterdir():
            self.assertFalse((trial / "repo" / "verifier.py").exists())
            self.assertTrue((trial / "verify" / "answer.txt").is_file())


class ContractTest(unittest.TestCase):
    def test_same_seed_reproduces_the_schedule(self) -> None:
        loaded = manifest.load(cli.FAKE_MANIFEST)
        self.assertEqual(schedule.expand(loaded), schedule.expand(loaded))

    def test_manifest_rejects_bad_shapes(self) -> None:
        base = json.loads(cli.FAKE_MANIFEST.read_text())
        cases = {
            "unknown key": {**base, "extra": 1},
            "duplicate arm": {**base, "arms": [base["arms"][0], base["arms"][0]]},
            "missing fixture": {**base, "tasks": [{**base["tasks"][0], "fixture": "nope"}]},
            "unpinned model": {**base, "pins": {**base["pins"], "model": "latest"}},
            "mixed executors": {**base, "arms": [base["arms"][0], {**base["arms"][1], "executor": "real"}]},
        }
        for name, data in cases.items():
            with self.subTest(name), self.assertRaises(ManifestError):
                manifest.validate(data, cli.FAKE_MANIFEST.parent)

    def test_publish_never_overwrites(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            record = {
                "schema": records.RECORD_SCHEMA,
                "trial_id": "t1",
                "manifest_hash": "m",
                "schedule_hash": "s",
                "task_id": "a",
                "arm_id": "off",
                "repeat": 0,
                "position": 0,
                "outcome": "pass",
                "usage": [],
            }
            path, won = records.publish(Path(tmp), record)
            _, second = records.publish(Path(tmp), {**record, "outcome": "fail"})
            self.assertTrue(won)
            self.assertFalse(second)
            self.assertEqual(json.loads(path.read_text())["outcome"], "pass")
            accepted, excluded = records.select(Path(tmp), "m", "s")
            self.assertEqual(list(accepted), ["t1"])
            self.assertEqual([item.reason for item in excluded], ["partial"])
            stale, reasons = records.select(Path(tmp), "other", "s")
            self.assertEqual(stale, {})
            self.assertIn("stale", [item.reason for item in reasons])

    def test_report_guard_refuses_private_strings(self) -> None:
        with self.assertRaises(report.ReportError):
            report.guard({"trials": [{"note": "/Users/someone/.claude/transcript.jsonl"}]})
        with self.assertRaises(report.ReportError):
            report.guard({"prompt": "x"})


if __name__ == "__main__":
    unittest.main()
