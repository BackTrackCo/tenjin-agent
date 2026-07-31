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
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

from run_output_eval import grade_problem, summarize, unusable_configurations  # noqa: E402
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
