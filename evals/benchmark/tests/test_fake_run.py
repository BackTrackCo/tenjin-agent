"""The walking skeleton: one fake manifest through every seam, offline."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from evals.benchmark import artifact, cli, executor, manifest, records, report, runner, schedule
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

    def test_verify_reruns_each_hidden_verifier_and_reports_disagreement(self) -> None:
        payload = cli.do_verify(self.out)
        self.assertEqual(payload["disagreements"], [])
        self.assertTrue(all(item["agrees"] for item in payload["trials"].values()))
        trial_id = sorted(payload["trials"])[0]
        answer = self.out / "trials" / trial_id / "verify" / "answer.txt"
        original = answer.read_text(encoding="utf-8")
        answer.write_text("41\n", encoding="utf-8")
        try:
            second = cli.do_verify(self.out)
        finally:
            answer.write_text(original, encoding="utf-8")
        self.assertEqual(second["disagreements"], [trial_id])
        self.assertEqual(second["trials"][trial_id], {"status": "fail", "recorded": "pass", "agrees": False})


class EndToEndTest(unittest.TestCase):
    """The whole offline path in one case, with a real interruption in it.

    Every other case injects a seam. This one drives the shipped CLI: real
    executor processes, a hard interruption between two trials, a resume, a
    fresh verifier pass, the reducer, and the publishable report.
    """

    def test_run_interrupt_resume_verify_reduce_and_report(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "run"
            spawns: list[str] = []

            def spawn(launch: executor.Launch, roots: artifact.TrialRoots, timeout_s: float) -> runner.Completed:
                spawns.append(launch.root_session_id)
                if len(spawns) == 2:
                    raise KeyboardInterrupt
                return runner.process_spawn(launch, roots, timeout_s)

            with self.assertRaises(KeyboardInterrupt):
                cli.fake_run(out, runtime=runner.Runtime(spawn=spawn))
            records_dir = out / "records"
            # The interrupted trial published nothing; the finished one is final.
            self.assertEqual(len(list(records_dir.glob("*.json"))), 1)
            self.assertEqual(list(records_dir.glob("*.partial.*")), [])
            self.assertFalse((out / "report.json").exists())
            first = {path.name: (path.read_bytes(), path.stat().st_ino) for path in records_dir.glob("*.json")}

            resumed = cli.fake_run(out)
            self.assertEqual(resumed["trials"], 2)
            self.assertEqual(resumed["resumed"], 1)
            self.assertEqual(set(resumed["outcomes"].values()), {"pass"})
            after = {path.name: (path.read_bytes(), path.stat().st_ino) for path in records_dir.glob("*.json")}
            self.assertEqual(len(after), 2)
            for name, value in first.items():
                self.assertEqual(after[name], value, f"{name} was rewritten on resume")

            self.assertEqual(cli.do_verify(out)["disagreements"], [])
            reduction = cli.do_reduce(out)
            self.assertEqual(reduction["baseline"], "off")
            self.assertEqual(reduction["excluded"], [])
            self.assertEqual(reduction["invalid"], [])
            self.assertEqual(reduction["arms"]["on"]["accounting"], "complete")

            published = json.loads((out / "report.json").read_text(encoding="utf-8"))
            report.guard(published)
            self.assertEqual(published["baseline"], "off")
            self.assertLess(published["comparisons"]["on"]["token_ratio"], 1.0)
            self.assertEqual(published["comparisons"]["on"]["interval"]["tasks"], 1)


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
