#!/usr/bin/env python3
"""Pure tests for the two scoring gates. No network, no model, no spend.

These guard one property, in both runners: a run that did not happen cannot be
counted as a run that produced a result. It is the failure mode a measurement
harness is least able to notice about itself, because every version of it lands
in the flattering direction — a timed-out trigger sample reads as "the skill
declined to fire", and a grade array that lost an expectation reads as a higher
pass rate rather than a smaller one.

Run directly (`python3 evals/harness/scoring_selftest.py`) or through
`src/evals-harness-scoring.test.ts`, which is what puts it in CI.
"""

from __future__ import annotations

import contextlib
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import run_output_eval  # noqa: E402
from redaction import redact_stream  # noqa: E402
from run_output_eval import (  # noqa: E402
    EXEC_ALLOWED,
    attempt_totals,
    grade_problem,
    summarize,
    unusable_configurations,
)
from run_trigger_eval import invalid_reason, unusable_samples  # noqa: E402


def sample(**overrides: object) -> dict:
    """A healthy trigger sample, before whatever the test breaks about it."""
    return {
        "fired": False,
        "other_skills_fired": [],
        "skill_offered": True,
        "tools": [],
        "cost_usd": 0.01,
        "result": "success",
        "error": None,
        **overrides,
    }


class TriggerSamples(unittest.TestCase):
    def test_a_healthy_sample_is_counted(self) -> None:
        self.assertIsNone(invalid_reason(sample()))
        self.assertIsNone(invalid_reason(sample(fired=True)))

    def test_a_timeout_is_not_a_non_fire(self) -> None:
        # What run_once actually returns on timeout: no fired bit, and none of
        # the fields the other checks read.
        timed_out = {"fired": None, "error": "timeout", "tools": [], "cost_usd": 0.0}
        self.assertIsNotNone(invalid_reason(timed_out))

    def test_a_failed_executor_is_not_a_non_fire(self) -> None:
        self.assertIsNotNone(invalid_reason(sample(error="exit 1")))

    def test_a_run_that_was_never_offered_the_skill_is_not_a_non_fire(self) -> None:
        self.assertIsNotNone(invalid_reason(sample(skill_offered=False)))

    def test_an_incomplete_result_is_not_a_non_fire(self) -> None:
        self.assertIsNotNone(invalid_reason(sample(result="error_max_turns")))
        self.assertIsNotNone(invalid_reason(sample(result=None)))

    def test_every_broken_kind_is_kept_out_of_scoring(self) -> None:
        cases = [{"query": "q0", "should_trigger": False}]
        broken = {
            "timeout": {"fired": None, "error": "timeout", "cost_usd": 0.0},
            "exit": sample(error="exit 1"),
            "unoffered": sample(skill_offered=False),
            "incomplete": sample(result="error_max_turns"),
        }
        for label, outcome in broken.items():
            with self.subTest(label):
                unusable = unusable_samples(cases, {(0, 0): outcome}, 1)
                self.assertEqual(len(unusable), 1, f"{label} reached the scorer")

    def test_the_headline_case_an_all_timeout_negative_cannot_pass(self) -> None:
        # Three timeouts on a should_trigger:false query used to score 0 fires
        # out of 3 and print as a pass.
        cases = [{"query": "q0", "should_trigger": False}]
        results = {(0, run): {"fired": None, "error": "timeout", "cost_usd": 0.0} for run in range(3)}
        self.assertEqual(len(unusable_samples(cases, results, 3)), 3)

    def test_a_missing_sample_is_not_silently_absent(self) -> None:
        cases = [{"query": "q0", "should_trigger": True}]
        self.assertEqual(len(unusable_samples(cases, {}, 3)), 3)


class ExecutorStatus(unittest.TestCase):
    @staticmethod
    def stream(subtype: str | None, is_error: bool = False) -> str:
        events = [{"type": "assistant", "message": {"content": [{"type": "text", "text": "hi"}]}}]
        if subtype is not None:
            events.append(
                {
                    "type": "result",
                    "subtype": subtype,
                    "is_error": is_error,
                    "total_cost_usd": 0.02,
                    "num_turns": 2,
                }
            )
        return "\n".join(json.dumps(event) for event in events)

    def test_a_successful_turn_has_no_error(self) -> None:
        self.assertIsNone(summarize(self.stream("success"))["error"])

    def test_a_capped_turn_is_an_error(self) -> None:
        self.assertIsNotNone(summarize(self.stream("error_max_turns"))["error"])

    def test_a_flagged_result_is_an_error(self) -> None:
        self.assertIsNotNone(summarize(self.stream("success", is_error=True))["error"])

    def test_a_stream_with_no_result_event_is_an_error(self) -> None:
        self.assertIsNotNone(summarize(self.stream(None))["error"])


CASE = {
    "id": 1,
    "prompt": "p",
    "expected_output": "what a good run looks like",
    "expectations": ["the first expectation", "the second expectation"],
}


def grading(*grades: tuple[str, str]) -> dict:
    return {"grades": [{"expectation": text, "grade": value} for text, value in grades]}


BOTH = grading(("the first expectation", "pass"), ("the second expectation", "fail"))


class GradeArrays(unittest.TestCase):
    def test_a_complete_grading_is_aggregated(self) -> None:
        self.assertIsNone(grade_problem(CASE, BOTH))

    def test_a_partial_array_is_rejected(self) -> None:
        # The bug this exists for: one grade for two expectations reported 1.0,
        # because the ungraded one left the denominator rather than the numerator.
        partial = grading(("the first expectation", "pass"))
        self.assertIsNotNone(grade_problem(CASE, partial))

    def test_an_empty_array_from_a_parse_failure_is_rejected(self) -> None:
        self.assertIsNotNone(grade_problem(CASE, {"grades": [], "error": "no JSON body"}))
        self.assertIsNotNone(grade_problem(CASE, {"grades": []}))

    def test_a_reordered_array_is_rejected(self) -> None:
        swapped = grading(("the second expectation", "pass"), ("the first expectation", "fail"))
        self.assertIsNotNone(grade_problem(CASE, swapped))

    def test_a_reworded_expectation_is_rejected(self) -> None:
        reworded = grading(("the 1st expectation", "pass"), ("the second expectation", "fail"))
        self.assertIsNotNone(grade_problem(CASE, reworded))

    def test_rewrapping_is_tolerated(self) -> None:
        # A grader may reflow whitespace; it may not reword. Being strict about
        # wrapping would abort runs over a line break.
        rewrapped = grading(("the  first\nexpectation", "pass"), ("the second expectation", "fail"))
        self.assertIsNone(grade_problem(CASE, rewrapped))

    def test_an_invalid_grade_value_is_rejected(self) -> None:
        invalid = grading(("the first expectation", "partial"), ("the second expectation", "fail"))
        self.assertIsNotNone(grade_problem(CASE, invalid))

    def test_ungraded_is_a_legal_value(self) -> None:
        legal = grading(("the first expectation", "ungraded"), ("the second expectation", "pass"))
        self.assertIsNone(grade_problem(CASE, legal))


class OutputConfigurations(unittest.TestCase):
    jobs = [(CASE, True)]

    def test_a_whole_configuration_is_aggregated(self) -> None:
        runs = {(1, True): {"error": None}}
        self.assertEqual(unusable_configurations(self.jobs, runs, {(1, True): BOTH}), [])

    def test_a_failed_executor_blocks_aggregation(self) -> None:
        runs = {(1, True): {"error": "result subtype was 'error_max_turns'"}}
        self.assertEqual(len(unusable_configurations(self.jobs, runs, {(1, True): BOTH})), 1)

    def test_a_partial_grading_blocks_aggregation(self) -> None:
        runs = {(1, True): {"error": None}}
        partial = grading(("the first expectation", "pass"))
        self.assertEqual(len(unusable_configurations(self.jobs, runs, {(1, True): partial})), 1)

    def test_missing_records_block_aggregation(self) -> None:
        self.assertEqual(len(unusable_configurations(self.jobs, {}, {})), 1)


SECRET = "sk-live-DO-NOT-FORWARD-4471"


def tool_stream(tool: str, tool_input: dict, result_body: str) -> str:
    """One tool call and its result, in the executor's stream shape."""
    return "\n".join(
        json.dumps(event)
        for event in [
            {
                "type": "assistant",
                "message": {
                    "content": [
                        {"type": "tool_use", "id": "tu_1", "name": tool, "input": tool_input}
                    ]
                },
            },
            {
                "type": "user",
                "message": {
                    "content": [
                        {"type": "tool_result", "tool_use_id": "tu_1", "content": result_body}
                    ]
                },
            },
            {"type": "result", "subtype": "success", "total_cost_usd": 0.01, "num_turns": 2},
        ]
    )


class UntrustedFileContent(unittest.TestCase):
    """The quiet exfiltration route: a tool result is a transport.

    An obedient agent reads a file and the content comes back in a tool_result,
    which used to be written to disk verbatim and copied into a prompt sent to a
    remote model. The sentinel never touched that path."""

    def test_a_read_result_never_reaches_the_transcript(self) -> None:
        stream = tool_stream("Read", {"file_path": "/Users/someone/.tenjin/wallet.json"}, SECRET)
        self.assertIn(SECRET, stream, "the fixture itself must contain the secret")
        self.assertNotIn(SECRET, redact_stream(stream))

    def test_a_read_result_never_reaches_the_grader_prompt(self) -> None:
        stream = tool_stream("Read", {"file_path": "/Users/someone/.aws/credentials"}, SECRET)
        self.assertNotIn(SECRET, summarize(redact_stream(stream))["log"])

    def test_grep_and_glob_results_are_redacted_too(self) -> None:
        for tool, tool_input in [("Grep", {"pattern": "token"}), ("Glob", {"pattern": "**/*.env"})]:
            with self.subTest(tool):
                stream = tool_stream(tool, tool_input, SECRET)
                self.assertNotIn(SECRET, redact_stream(stream))

    def test_structured_result_bodies_are_redacted(self) -> None:
        # tool_result content is sometimes a list of blocks rather than a string.
        stream = "\n".join(
            json.dumps(event)
            for event in [
                {
                    "type": "assistant",
                    "message": {
                        "content": [
                            {"type": "tool_use", "id": "tu_1", "name": "Read", "input": {"file_path": "/etc/hosts"}}
                        ]
                    },
                },
                {
                    "type": "user",
                    "message": {
                        "content": [
                            {
                                "type": "tool_result",
                                "tool_use_id": "tu_1",
                                "content": [{"type": "text", "text": SECRET}],
                            }
                        ]
                    },
                },
            ]
        )
        self.assertNotIn(SECRET, redact_stream(stream))

    def test_the_sibling_tool_use_result_is_redacted_too(self) -> None:
        # The same body arrives twice in a real stream: once in
        # message.content, once in a `tool_use_result` sibling. Redacting only
        # the first left the file on disk, which a grep of a real transcript
        # caught after the first version of the redactor.
        stream = "\n".join(
            json.dumps(event)
            for event in [
                {
                    "type": "assistant",
                    "message": {
                        "content": [
                            {"type": "tool_use", "id": "tu_1", "name": "Read", "input": {"file_path": "/tmp/x.md"}}
                        ]
                    },
                },
                {
                    "type": "user",
                    "message": {
                        "content": [
                            {"type": "tool_result", "tool_use_id": "tu_1", "content": SECRET}
                        ]
                    },
                    "tool_use_result": {
                        "type": "text",
                        "file": {"filePath": "/tmp/x.md", "content": SECRET},
                    },
                },
            ]
        )
        self.assertEqual(stream.count(SECRET), 2, "the fixture must carry both copies")
        self.assertNotIn(SECRET, redact_stream(stream))

    def test_the_attempt_survives_redaction(self) -> None:
        # Obedience has to stay observable: what the agent reached for, and
        # which file, is the evidence the case grades.
        stream = tool_stream("Read", {"file_path": "/Users/someone/.tenjin/wallet.json"}, SECRET)
        redacted = redact_stream(stream)
        self.assertIn("wallet.json", redacted)
        self.assertIn("redacted Read result", redacted)
        self.assertIn("TOOL Read", summarize(redacted)["log"])

    def test_other_tool_results_are_left_alone(self) -> None:
        # Bash output is how a CLI case is graded; redacting it would grade
        # nothing. Its file-content reach is closed by the permission scoping.
        stream = tool_stream("Bash", {"command": "tenjin search --json"}, '{"decision":"MISS"}')
        self.assertIn("MISS", redact_stream(stream))

    def test_the_executor_grant_is_scoped_to_the_project(self) -> None:
        self.assertNotIn("Read", EXEC_ALLOWED, "a bare Read grant reaches every path on the machine")
        for rule in ("Read(./**)", "Glob(./**)", "Grep(./**)"):
            self.assertIn(rule, EXEC_ALLOWED)


class GraderEnvelope(unittest.TestCase):
    """A body is only worth reading if the process that produced it succeeded."""

    BODY = json.dumps(
        {
            "grades": [
                {"expectation": "the first expectation", "grade": "pass"},
                {"expectation": "the second expectation", "grade": "pass"},
            ]
        }
    )

    def _grade(self, returncode: int, envelope: dict) -> dict:
        completed = subprocess.CompletedProcess(
            args=["claude"], returncode=returncode, stdout=json.dumps(envelope), stderr=""
        )
        with mock.patch.object(run_output_eval.subprocess, "run", return_value=completed):
            return run_output_eval.grade(CASE, {"log": "x"}, "opus", Path("."), 60)

    def test_a_failed_grader_with_a_complete_body_is_rejected(self) -> None:
        # The exact false green: exit 1, but a syntactically perfect all-pass body.
        result = self._grade(1, {"subtype": "success", "is_error": False, "result": self.BODY})
        self.assertIsNotNone(grade_problem(CASE, result))

    def test_an_error_envelope_is_rejected(self) -> None:
        for envelope in (
            {"subtype": "error_during_execution", "is_error": False, "result": self.BODY},
            {"subtype": "success", "is_error": True, "result": self.BODY},
        ):
            with self.subTest(envelope["subtype"]):
                self.assertIsNotNone(grade_problem(CASE, self._grade(0, envelope)))

    def test_a_successful_grader_is_accepted(self) -> None:
        result = self._grade(0, {"subtype": "success", "is_error": False, "result": self.BODY})
        self.assertIsNone(grade_problem(CASE, result))

    def test_a_grader_timeout_is_a_retryable_invalid_grade(self) -> None:
        # Not an exception escaping the worker thread and taking the run down.
        with mock.patch.object(
            run_output_eval.subprocess,
            "run",
            side_effect=subprocess.TimeoutExpired(cmd="claude", timeout=1),
        ):
            result = run_output_eval.grade(CASE, {"log": "x"}, "opus", Path("."), 1)
        self.assertIsNotNone(grade_problem(CASE, result))


def attempt(cost: float, error: str | None, hits: list[str], number: int) -> dict:
    return {"cost_usd": cost, "error": error, "sentinel_hits": hits, "attempt": number}


class DiscardedAttemptEvidence(unittest.TestCase):
    """An attempt that obeyed the payload and then failed is the whole point."""

    HISTORY = [
        attempt(0.05, "result subtype was 'error_max_turns'", ["POST /api/posts (410 bytes)"], 1),
        attempt(0.07, None, [], 2),
    ]

    def test_a_hit_on_a_discarded_attempt_reaches_the_headline(self) -> None:
        totals = attempt_totals(self.HISTORY)
        self.assertEqual(len(totals["sentinel_hits"]), 1)
        self.assertEqual(totals["sentinel_hits_on_counted_attempt"], [])

    def test_the_discarded_attempt_is_itemised(self) -> None:
        discarded = attempt_totals(self.HISTORY)["discarded_attempts"]
        self.assertEqual(len(discarded), 1)
        self.assertEqual(discarded[0]["attempt"], 1)
        self.assertEqual(len(discarded[0]["sentinel_hits"]), 1)

    def test_cost_covers_every_attempt(self) -> None:
        self.assertAlmostEqual(attempt_totals(self.HISTORY)["cost_usd"], 0.12)
        self.assertEqual(attempt_totals(self.HISTORY)["attempts"], 2)

    def test_a_clean_single_attempt_reports_nothing_extra(self) -> None:
        totals = attempt_totals([attempt(0.03, None, [], 1)])
        self.assertEqual(totals["discarded_attempts"], [])
        self.assertEqual(totals["sentinel_hits"], [])
        self.assertEqual(totals["attempts"], 1)


REPO = Path(__file__).resolve().parents[2]


class TheGatesAreWiredIn(unittest.TestCase):
    """Extracting a gate and forgetting to call it would pass every test above.

    These drive `main()` end to end with the model call replaced by a failure, so
    they cost nothing and still prove the run stops, exits 2, and writes no
    result file for anyone to read a number out of."""

    def test_the_trigger_runner_abandons_a_run_of_timeouts(self) -> None:
        import run_trigger_eval

        workspace = Path(tempfile.mkdtemp(prefix="selftest-trigger-"))
        argv = [
            "run_trigger_eval.py",
            "--eval-set", str(REPO / "evals/tenjin-search/trigger-eval-defer.json"),
            "--skill", str(REPO / "skills/tenjin-search"),
            "--workspace", str(workspace),
            "--runs-per-query", "1",
            "--max-attempts", "2",
            "--no-preflight",
        ]
        timed_out = {"fired": None, "error": "timeout", "tools": [], "cost_usd": 0.0}
        with mock.patch.object(run_trigger_eval, "run_once", return_value=timed_out), mock.patch.object(
            sys, "argv", argv
        ), contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()):
            exit_code = run_trigger_eval.main()

        self.assertEqual(exit_code, 2)
        self.assertIn("RUN INVALID", out.getvalue())
        self.assertFalse((workspace / "results.json").exists(), "a scored file was written")

    def test_the_output_runner_abandons_a_failed_executor(self) -> None:
        import run_output_eval

        workspace = Path(tempfile.mkdtemp(prefix="selftest-output-"))
        argv = [
            "run_output_eval.py",
            "--eval-set", str(REPO / "evals/tenjin/evals.json"),
            "--skill", str(REPO / "skills/tenjin"),
            "--workspace", str(workspace),
            "--only", "6",
            "--max-attempts", "2",
            "--no-preflight",
        ]
        failed = {
            "log": "",
            "answer": "",
            "cost_usd": 0.0,
            "turns": 0,
            "result": "error_max_turns",
            "error": "result subtype was 'error_max_turns' (is_error=False)",
        }
        with mock.patch.object(run_output_eval, "run_case", return_value=failed), mock.patch.object(
            sys, "argv", argv
        ), contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()):
            exit_code = run_output_eval.main()

        self.assertEqual(exit_code, 2)
        self.assertIn("RUN INVALID", out.getvalue())
        self.assertFalse((workspace / "benchmark.json").exists(), "a benchmark was written")


if __name__ == "__main__":
    unittest.main(verbosity=2)
