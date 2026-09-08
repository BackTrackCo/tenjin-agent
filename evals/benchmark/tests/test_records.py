"""Immutable attempt records: publish without overwrite, validate, select on resume."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from evals.benchmark import records
from evals.benchmark.records import RecordError
from evals.benchmark.tests.support import attempt_record, parse


class RecordShapeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.family = parse("sess-family")
        cls.root_only = parse("sess-root-only")

    def test_complete_record_validates(self) -> None:
        record = attempt_record(self.family)
        records.validate(record)
        self.assertEqual(len(record["actors"]), 5)
        self.assertEqual(len(record["parent_edges"]), 4)
        self.assertEqual(record["usage_reconciliation"]["status"], "matched_with_descendants")

    def test_invalid_attempt_needs_a_reason_and_only_then(self) -> None:
        invalid = attempt_record(parse("sess-mismatch"), outcome="invalid", invalid_reason="usage:mismatch", verifier=None)
        records.validate(invalid)
        with self.assertRaises(RecordError):
            records.validate({**invalid, "invalid_reason": None})
        with self.assertRaises(RecordError):
            records.validate(attempt_record(self.root_only, invalid_reason="oops"))

    def test_a_scored_outcome_cannot_carry_unreconciled_usage(self) -> None:
        # The invariant lives in the record, not only in the runner that built
        # it: a file the reducer reads from disk cannot claim a pass over usage
        # that never reconciled with the harness envelope.
        for status in ("mismatch", "envelope_without_usage", "unparsed", "no_envelope", "envelope_partial"):
            with self.subTest(f"pass/{status}"), self.assertRaises(RecordError):
                records.validate(attempt_record(self.family, usage_reconciliation={"status": status}))
        for status in ("matched", "matched_with_descendants", "explained_by_side_models"):
            with self.subTest(f"pass/{status}"):
                records.validate(attempt_record(self.family, usage_reconciliation={"status": status}))
        # A declared cap is the one case a scored attempt may have no envelope:
        # the outcome names the gap itself.
        capped = attempt_record(
            self.family,
            outcome="capped",
            stop_reason="timeout",
            verifier=None,
            usage_reconciliation={"status": "no_envelope"},
        )
        records.validate(capped)
        # A harness cap leaves a partial envelope; that too is named by the
        # outcome, and a capped attempt may carry the verdict it earned first.
        records.validate({**capped, "stop_reason": "budget", "usage_reconciliation": {"status": "envelope_partial"}})
        records.validate({**capped, "stop_reason": "turns", "verifier": {"id": "fake_answer_file", "exit_code": 0}})
        with self.assertRaises(RecordError):
            records.validate({**capped, "usage_reconciliation": {"status": "mismatch"}})
        # An invalid attempt is where an unreconciled status belongs.
        records.validate({**capped, "outcome": "invalid", "invalid_reason": "usage:mismatch", "usage_reconciliation": {"status": "mismatch"}})

    def test_record_rejects_contradictions(self) -> None:
        base = attempt_record(self.family)
        actor = base["actors"][1]
        cases = {
            "unknown key": {**base, "extra": 1},
            "missing key": {key: value for key, value in base.items() if key != "delivery"},
            "wrong schema": {**base, "schema": "bench1.attempt.v0"},
            "forged trial id": {**base, "trial_id": "abc"},
            "unknown outcome": {**base, "outcome": "maybe"},
            "unknown stop": {**base, "stop_reason": "crash"},
            "pass without verifier": {**base, "verifier": None},
            "lead missing": {**base, "actors": base["actors"][1:]},
            "actor twice": {**base, "actors": base["actors"] + [base["actors"][0]]},
            "parent without provenance": {**base, "actors": [base["actors"][0], {**actor, "parent_provenance": "unavailable"}] + base["actors"][2:]},
            "provenance without parent": {**base, "actors": [{**base["actors"][0], "parent_provenance": "native"}] + base["actors"][1:]},
            "parent outside attempt": {**base, "actors": [base["actors"][0], {**actor, "parent_actor_key": ["claude", "sess-family", "ghost"]}] + base["actors"][2:]},
            "edge outside attempt": {**base, "parent_edges": [{"child": ["claude", "sess-family", "ghost"], "parent": ["claude", "sess-family", ""], "provenance": "native"}]},
            "edge unavailable": {**base, "parent_edges": [{**base["parent_edges"][0], "provenance": "unavailable"}]},
            "usage outside attempt": {**base, "usage": [{**base["usage"][0], "actor_key": ["claude", "sess-family", "ghost"]}]},
            "usage other trial": {**base, "usage": [{**base["usage"][0], "trial_id": "other"}]},
            "usage duplicated": {**base, "usage": base["usage"] + [base["usage"][0]]},
            "usage conflicting": {**base, "usage": base["usage"] + [{**base["usage"][0], "output_total": 1}]},
            "receipt duplicates native id": {**base, "auxiliary": [{"trial_id": base["trial_id"], "component": "observer", "phase": "capture", "native_request_id": "req_101", "input_total": 1, "output_total": 1, "source_hash": "sha256:x"}]},
            "receipt other trial": {**base, "auxiliary": [{"trial_id": "other", "component": "observer", "phase": "capture", "native_request_id": "aux_1", "input_total": 1, "output_total": 1, "source_hash": "sha256:x"}]},
            "delivery status": {**base, "delivery": {**base["delivery"], "status": "guessed"}},
            "fire outside attempt": {**base, "delivery": {**base["delivery"], "status": "joined", "fires": [{"fire_id": "f", "actor": ["claude", "sess-family", "ghost"]}]}},
            "negative wall time": {**base, "wall_time_s": -1},
            "bad turns": {**base, "turns": "two"},
            "sentinel count": {**base, "sentinel": {"public_requests": None}},
            "reconciliation shape": {**base, "usage_reconciliation": {}},
        }
        for name, data in cases.items():
            with self.subTest(name), self.assertRaises(RecordError):
                records.validate(data)


class PublishTest(unittest.TestCase):
    def test_publish_never_overwrites_and_two_writers_cannot_both_win(self) -> None:
        record = attempt_record(parse("sess-root-only"))
        with tempfile.TemporaryDirectory() as tmp:
            path, won = records.publish(Path(tmp), record)
            _, second = records.publish(Path(tmp), {**record, "outcome": "fail"})
            self.assertTrue(won)
            self.assertFalse(second)
            self.assertEqual(json.loads(path.read_text())["outcome"], "pass")
            accepted, excluded = records.select(Path(tmp), record["manifest_hash"], record["schedule_hash"])
            self.assertEqual(list(accepted), [record["trial_id"]])
            self.assertEqual([item.reason for item in excluded], ["partial"])

    def test_select_excludes_every_non_final_file_with_a_reason(self) -> None:
        record = attempt_record(parse("sess-root-only"))
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            records.publish(root, record)
            (root / "stale.json").write_text(json.dumps({**record, "schedule_hash": "sha256:old"}), encoding="utf-8")
            (root / "misnamed.json").write_text(json.dumps(record), encoding="utf-8")
            (root / "broken.json").write_text("{", encoding="utf-8")
            (root / "forged.json").write_text(json.dumps({**record, "trial_id": "forged"}), encoding="utf-8")
            (root / "notes.txt").write_text("private", encoding="utf-8")
            accepted, excluded = records.select(root, record["manifest_hash"], record["schedule_hash"])
            self.assertEqual(list(accepted), [record["trial_id"]])
            reasons = {item.path: item.reason.split(":", 1)[0] for item in excluded}
            self.assertEqual(
                reasons,
                {"stale.json": "stale", "misnamed.json": "misnamed", "broken.json": "invalid", "forged.json": "invalid", "notes.txt": "foreign"},
            )
            nothing, stale = records.select(root, "sha256:other", record["schedule_hash"])
            self.assertEqual(nothing, {})
            self.assertIn("stale", [item.reason for item in stale])

    def test_publish_refuses_an_invalid_record_before_writing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(RecordError):
                records.publish(Path(tmp), {"schema": records.RECORD_SCHEMA})
            self.assertEqual(list(Path(tmp).iterdir()), [])


if __name__ == "__main__":
    unittest.main()
