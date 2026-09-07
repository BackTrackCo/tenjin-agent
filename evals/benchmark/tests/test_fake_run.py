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
            records.validate(record)
            self.assertEqual(record["outcome"], "pass")
            # Root emits req_1 (partial + final rows) and req_2; the child emits one.
            self.assertEqual([item["native_request_id"] for item in record["usage"]], ["req_1", "req_2", "req_c1"])
            self.assertEqual(len(record["actors"]), 2)
            self.assertEqual(record["actors"][0]["key"][2], "")
            self.assertEqual(record["actors"][0]["parent_provenance"], "unavailable")
            # The fake child names its dispatching tool call, a structured native edge.
            self.assertEqual(record["actors"][1]["parent_provenance"], "native")
            self.assertEqual(record["actors"][1]["parent_actor_key"], record["actors"][0]["key"])
            self.assertEqual(record["usage_reconciliation"]["status"], "matched")
            self.assertEqual(record["delivery"]["status"], "unavailable")
            self.assertEqual(record["tool_counts"], {"": {"Task": 1}})
            self.assertTrue(record["patch_hash"].startswith("sha256:"))
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

    def test_manifest_hash_change_invalidates_the_run(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "run"
            cli.fake_run(out)
            payload = json.loads((out / "schedule.json").read_text())
            payload["manifest_hash"] = "sha256:other"
            (out / "schedule.json").write_text(json.dumps(payload), encoding="utf-8")
            with self.assertRaises(ManifestError):
                cli.do_report(out)

    def test_report_guard_refuses_private_strings(self) -> None:
        with self.assertRaises(report.ReportError):
            report.guard({"trials": [{"note": "/Users/someone/.claude/transcript.jsonl"}]})
        with self.assertRaises(report.ReportError):
            report.guard({"prompt": "x"})


if __name__ == "__main__":
    unittest.main()
