"""The publishable projection and its redaction guard.

The guard cases plant real leak shapes rather than asserting a schema: a host
path, a provider credential, the benchmark's own canary, a prompt, and a
memory body, each pushed through a field the projection actually copies.
"""

from __future__ import annotations

import unittest
from pathlib import Path

from evals.benchmark import artifact, records, reduce as reduce_module, report
from evals.benchmark.report import ReportError
from evals.benchmark.tests import support
from evals.benchmark.tests.test_reduce import corpus

HOST_PATH = "/Users/someone/.claude/projects/tenjin/transcript.jsonl"
CREDENTIAL = "sk-ant-api03-DEADBEEFDEADBEEFDEADBEEF"
PROMPT = "Rename the slug helper and keep the old route working."
MEMORY_BODY = "The team lesson: the hook reads NEXT_PUBLIC_BUILDER_CODE and nothing else."


class GuardTest(unittest.TestCase):
    def refusal(self, value: object, trail: str = "report") -> ReportError:
        with self.assertRaises(ReportError) as caught:
            report.guard(value, trail)
        return caught.exception

    def test_a_host_path_cannot_enter_the_projection(self) -> None:
        for planted in (HOST_PATH, "~/.claude/settings.json", "C:\\Users\\someone\\repo", "evals/benchmark"):
            with self.subTest(value=planted):
                self.assertEqual(self.refusal({"invalid_reason": planted}).code, "host_path")

    def test_a_credential_cannot_enter_the_projection(self) -> None:
        planted = (
            CREDENTIAL,
            "ghp_ABCDEFGHIJKLMNOPQRSTUVWX",
            "AKIAIOSFODNN7EXAMPLE",
            "xoxb-1234567890-abcdefghij",
            "AIzaSyA1B2C3D4E5F6G7H8I9J0",
            artifact.canary_token("trial-1"),
        )
        for value in planted:
            with self.subTest(value=value[:12]):
                self.assertEqual(self.refusal({"arm_id": value}).code, "credential")

    def test_a_prompt_or_a_memory_body_cannot_enter_the_projection(self) -> None:
        for planted in (PROMPT, MEMORY_BODY, "assistant: I will edit the file now"):
            with self.subTest(value=planted[:16]):
                self.assertEqual(self.refusal({"reason": planted}).code, "not_opaque")

    def test_a_private_field_is_refused_before_its_value_is_read(self) -> None:
        for key in ("prompt", "transcript", "memory", "question", "stderr", "cwd", "argv", "home", "url", "title"):
            with self.subTest(key=key):
                error = self.refusal({"trials": [{key: "ok"}]})
                self.assertEqual(error.code, "private_field")
                self.assertEqual(error.trail, f"report.trials[0].{key}")

    def test_an_unpublishable_type_is_refused(self) -> None:
        self.assertEqual(self.refusal({"tokens": Path("/tmp/x")}).code, "unpublishable_type")
        self.assertEqual(self.refusal({"tokens": {1, 2}}).code, "unpublishable_type")

    def test_hashes_counts_and_enums_are_publishable(self) -> None:
        report.guard(
            {
                "manifest_hash": "a" * 64,
                "schedule_hash": "sha256:" + "b" * 64,
                "trial_id": "27d0f0fe30d9608939dadc4c",
                "outcome": "capped",
                "invalid_reason": "sentinel:public_request",
                "token_ratio": 0.825,
                "attempts": 12,
                "headline_eligible": True,
                "reason": None,
            }
        )

    def test_an_opaque_string_longer_than_the_cap_is_refused(self) -> None:
        self.assertEqual(self.refusal({"arm_id": "a" * 65}).code, "not_opaque")
        report.guard({"arm_id": "a" * 64})


class ProjectionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.manifest, cls.digest, cls.accepted, cls.excluded = corpus()
        cls.reduction = reduce_module.reduce(cls.accepted, cls.excluded, "off", cls.manifest.data["seed"])

    def project(self, manifest_data: dict | None = None, accepted: dict | None = None) -> dict:
        return report.project(
            manifest_data or self.manifest.data,
            self.manifest.hash,
            self.digest,
            self.reduction,
            accepted or self.accepted,
        )

    def test_the_corpus_projects_to_counts_enums_ids_and_hashes(self) -> None:
        published = self.project()
        self.assertEqual(published["schema"], report.REPORT_SCHEMA)
        self.assertEqual(published["baseline"], "off")
        self.assertEqual(len(published["trials"]), 12)
        self.assertEqual(published["excluded"], {"stale": 1, "partial": 1, "foreign": 1})
        self.assertEqual(published["comparisons"]["on"]["token_ratio"], 0.825)
        # Nothing in the projection is a body, a path, or a transcript.
        report.guard(published)

    def test_a_planted_host_path_in_a_record_refuses_the_whole_report(self) -> None:
        trial_id, record = sorted(self.accepted.items())[0]
        planted = {**self.accepted, trial_id: {**record, "invalid_reason": f"usage:{HOST_PATH}"}}
        with self.assertRaises(ReportError) as caught:
            self.project(accepted=planted)
        self.assertEqual(caught.exception.code, "host_path")

    def test_a_planted_credential_in_the_manifest_refuses_the_whole_report(self) -> None:
        planted = {**self.manifest.data, "benchmark_version": CREDENTIAL}
        with self.assertRaises(ReportError) as caught:
            self.project(manifest_data=planted)
        self.assertEqual(caught.exception.code, "credential")
        self.assertEqual(caught.exception.trail, "report.benchmark_version")

    def test_the_projection_carries_no_usage_body_or_delivery_detail(self) -> None:
        published = self.project()
        trial = published["trials"][0]
        self.assertEqual(sorted(trial), sorted(
            [
                "actors",
                "arm_id",
                "auxiliary_receipts",
                "invalid_reason",
                "outcome",
                "requests",
                "sentinel_hits",
                "stop_reason",
                "task_id",
                "tokens",
                "trial_id",
            ]
        ))
        # The private record has fields the projection deliberately drops.
        private = self.accepted[trial["trial_id"]]
        self.assertIn("private_hashes", private)
        self.assertIn("delivery", private)
        self.assertNotIn("private_hashes", trial)
        self.assertNotIn("delivery", trial)


class RecordBoundaryTest(unittest.TestCase):
    def test_a_record_may_hold_what_the_report_may_not(self) -> None:
        record = support.reduction_record("t1", "off", 0, 0, 6000, "pass")
        record["private_hashes"] = {"root_transcript": "sha256:" + "c" * 64, "executor_stderr": None}
        records.validate(record)
        # A whole record is never publishable: `private_hashes` is the
        # record's private-input slice, so a projection that wants any of it
        # has to give it a public name rather than forward the field.
        with self.assertRaises(ReportError) as caught:
            report.guard(record)
        self.assertEqual(caught.exception.code, "private_field")


if __name__ == "__main__":
    unittest.main()
