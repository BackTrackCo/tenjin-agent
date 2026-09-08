"""The publishable projection and its redaction guard.

The guard cases plant real leak shapes rather than asserting a schema: a host
path, a provider credential, the benchmark's own canary, a prompt, and a
memory body, each pushed through a field the projection actually copies.
"""

from __future__ import annotations

import json

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

    def stamped(self, **isolation: object) -> dict:
        """The corpus with every accepted record's isolation slice overridden."""
        return {
            trial_id: {**record, "isolation": {**record["isolation"], **isolation}}
            for trial_id, record in self.accepted.items()
        }

    def test_a_fake_corpus_is_publishable_and_says_so(self) -> None:
        published = self.project()
        self.assertEqual(published["publishable"], True)
        self.assertEqual(published["isolation"], "fake")
        self.assertEqual(published["comparisons"]["on"]["headline_eligible"], self.reduction["comparisons"]["on"]["headline_eligible"])

    def test_an_attested_live_run_stays_publishable_and_headline_eligible(self) -> None:
        accepted = self.stamped(live=True, attested_container=True, attestation_hash="sha256:" + "d" * 64)
        published = self.project(accepted=accepted)
        self.assertEqual(published["publishable"], True)
        self.assertEqual(published["isolation"], "attested")
        self.assertEqual(published["comparisons"]["on"]["headline_eligible"], True)
        report.guard(published)

    def test_a_plumbing_run_projects_as_non_publishable_and_never_headline_eligible(self) -> None:
        cases = {"operator_plumbing": {}, "automated_plumbing": {"automated": True}}
        for kind, extra in cases.items():
            with self.subTest(kind):
                accepted = self.stamped(live=True, publishable=False, **extra)
                published = self.project(accepted=accepted)
                self.assertEqual(published["publishable"], False)
                self.assertEqual(published["isolation"], kind)
                self.assertEqual(published["comparisons"]["on"]["headline_eligible"], False)
                # The numbers are unchanged: the stamp is a label, not a reduction.
                self.assertEqual(published["comparisons"]["on"]["token_ratio"], 0.825)
                self.assertEqual(published["arms"], self.reduction["arms"])
                report.guard(published)

    def test_one_non_publishable_record_stamps_the_whole_report(self) -> None:
        trial_id, record = sorted(self.accepted.items())[0]
        accepted = self.stamped(live=True, attested_container=True, attestation_hash="sha256:" + "d" * 64)
        accepted[trial_id] = {**record, "isolation": {**record["isolation"], "live": True, "publishable": False}}
        published = self.project(accepted=accepted)
        self.assertEqual(published["publishable"], False)
        self.assertEqual(published["isolation"], "operator_plumbing")
        self.assertEqual(published["comparisons"]["on"]["headline_eligible"], False)

    def test_a_seeded_shelf_secret_marks_the_report_and_its_reading(self) -> None:
        accepted = self.stamped(live=True, publishable=False, shelf_secret_present=True, shelf_origin="team-shelf.example")
        published = self.project(accepted=accepted)
        self.assertEqual((published["publishable"], published["isolation"], published["shelf_secret_present"]), (False, "team_shelf_secret", True))
        self.assertEqual(published["comparisons"]["on"]["headline_eligible"], False)
        self.assertNotIn("team-shelf.example", json.dumps(published))
        report.guard(published)
        self.assertIn("team shelf secret present: NOT PUBLISHABLE", report.render(published))
        self.assertEqual(self.project()["shelf_secret_present"], False)

    def test_a_record_that_seeded_a_secret_and_claims_publishable_is_refused(self) -> None:
        record = support.reduction_record("t1", "off", 0, 0, 6000, "pass")
        record["isolation"] = {**record["isolation"], "live": True, "shelf_secret_present": True}
        with self.assertRaises(records.RecordError) as caught:
            records.validate(record)
        self.assertIn("shelf secret", str(caught.exception))

    def test_a_record_without_the_isolation_booleans_is_excluded_not_projected(self) -> None:
        record = support.reduction_record("t1", "off", 0, 0, 6000, "pass")
        record["isolation"] = {"live": True, "fresh_roots": True, "attested_container": False, "attestation_hash": None}
        with self.assertRaises(records.RecordError) as caught:
            records.validate(record)
        self.assertIn("isolation.publishable", str(caught.exception))

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
                "other_requests",
                "outcome",
                "public_hits",
                "public_legs",
                "requests",
                "sentinel_hits",
                "stop_reason",
                "task_id",
                "tokens",
                "trial_id",
            ]
        ))
        # The corpus predates leg classes, so every origin count reads as zero
        # rather than as a missing field.
        self.assertEqual(published["origins"], {"public_legs": 0, "public_hits": 0, "public_timeouts": 0, "other_requests": 0})
        # The private record has fields the projection deliberately drops.
        private = self.accepted[trial["trial_id"]]
        self.assertIn("private_hashes", private)
        self.assertIn("delivery", private)
        self.assertNotIn("private_hashes", trial)
        self.assertNotIn("delivery", trial)

    def test_the_origin_counts_sum_the_public_legs_and_the_unknown_requests(self) -> None:
        accepted = {}
        for trial_id, record in self.accepted.items():
            copy = json.loads(json.dumps(record))
            copy["delivery"]["classes"] = {"team": 1, "public": 2, "local": 1, "other": 1}
            copy["delivery"]["public"] = {"legs": 2, "hits": 1, "timeouts": 1, "no_answer": 1}
            accepted[trial_id] = copy
        published = self.project(accepted=accepted)
        count = len(accepted)
        self.assertEqual(published["origins"], {"public_legs": 2 * count, "public_hits": count, "public_timeouts": count, "other_requests": count})
        self.assertEqual(published["trials"][0]["public_legs"], 2)
        self.assertEqual(published["trials"][0]["other_requests"], 1)
        report.guard(published)


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
