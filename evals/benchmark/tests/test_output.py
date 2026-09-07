"""What the lane prints.

CI output is read by a person deciding whether a run means anything, so the
per-module table, the step summary, and the report reading are covered like any
other contract. The rule these cases hold to is that a reading adds no number
its source did not carry, and never prints an arm's result without its arm.
"""

from __future__ import annotations

import io
import json
import tempfile
import unittest
from pathlib import Path

from evals.benchmark import report as report_module, selftest


def module_result(module: str, tests: int, seconds: float, failures: int = 0, errors: int = 0, skipped: int = 0):
    return selftest.ModuleResult(
        module=module,
        subject=selftest.subject_of(module),
        tests=tests,
        seconds=seconds,
        failures=failures,
        errors=errors,
        skipped=skipped,
    )


class SubjectTest(unittest.TestCase):
    def test_every_shipped_module_has_a_written_subject(self) -> None:
        # A new module with no entry still runs; this keeps the table honest by
        # failing when someone adds a module and leaves it unlabelled.
        self.assertEqual(sorted(selftest.SUBJECTS), selftest.modules())

    def test_an_unlabelled_module_falls_back_to_its_name(self) -> None:
        self.assertEqual(selftest.subject_of("test_new_thing"), "new thing")


class TableTest(unittest.TestCase):
    def test_the_table_names_every_module_with_its_count_and_time(self) -> None:
        table = selftest.render_table([module_result("test_usage", 9, 0.01), module_result("test_runner", 26, 1.87)])
        self.assertIn("test_usage", table)
        self.assertIn("test_runner", table)
        self.assertIn("9", table)
        self.assertIn("1.87s", table)
        self.assertIn("usage contract", table)

    def test_a_failed_module_says_so_in_its_row(self) -> None:
        table = selftest.render_table([module_result("test_usage", 9, 0.01, failures=2)])
        self.assertIn("FAILED 2", table)

    def test_a_skip_is_visible_rather_than_counted_as_a_pass(self) -> None:
        table = selftest.render_table([module_result("test_budget", 2, 0.1, skipped=1)])
        self.assertIn("skipped", table)

    def test_columns_stay_aligned_when_one_module_name_is_long(self) -> None:
        rows = [module_result("test_claude_usage", 29, 0.02), module_result("test_usage", 9, 0.01)]
        data = selftest.render_table(rows).splitlines()[1:]
        # The seconds column ends at the same offset in every row, so a long
        # module name widens the whole table rather than shifting one row.
        self.assertEqual(len({line.index("s  ") for line in data}), 1, data)


class MarkdownTest(unittest.TestCase):
    def test_the_step_summary_carries_the_totals_and_one_row_per_module(self) -> None:
        rows = [module_result("test_usage", 9, 0.01), module_result("test_reduce", 19, 0.02)]
        markdown = selftest.render_markdown(rows, 5.4, ok=True)
        self.assertIn("28 tests across 2 modules passed in 5.4s", markdown)
        self.assertIn("| `test_usage` | 9 |", markdown)
        self.assertIn("| `test_reduce` | 19 |", markdown)
        self.assertIn("No model, no network, no spend.", markdown)

    def test_a_failed_run_says_failed_in_the_summary(self) -> None:
        markdown = selftest.render_markdown([module_result("test_usage", 9, 0.01, errors=1)], 5.4, ok=False)
        self.assertIn("FAILED", markdown)
        self.assertNotIn("passed in", markdown)


class RunModuleTest(unittest.TestCase):
    def test_a_module_run_reports_its_own_count_and_subject(self) -> None:
        stream = io.StringIO()
        result = selftest.run_module("test_usage", verbosity=0, groups=False, stream=stream)
        self.assertEqual(result.module, "test_usage")
        self.assertTrue(result.ok)
        self.assertGreater(result.tests, 0)
        self.assertIn("usage contract", stream.getvalue())

    def test_groups_wrap_the_module_in_an_actions_log_group(self) -> None:
        stream = io.StringIO()
        selftest.run_module("test_usage", verbosity=0, groups=True, stream=stream)
        printed = stream.getvalue()
        self.assertIn("::group::test_usage", printed)
        self.assertIn("::endgroup::", printed)


class ReportRenderTest(unittest.TestCase):
    def report(self, **overrides) -> dict:
        base = {
            "schema": "bench1.report.v1",
            "benchmark_version": "test-0",
            "manifest_hash": "a" * 64,
            "schedule_hash": "b" * 64,
            "seed": 7,
            "repeats": 2,
            "baseline": "off",
            "arms": {
                "off": {
                    "attempts": 2,
                    "outcomes": {"pass": 2, "fail": 0, "capped": 0, "interrupted": 0, "invalid": 0},
                    "pass_rate": 1.0,
                    "tokens": 20000,
                    "tokens_per_attempt": 10000.0,
                    "accounting": "complete",
                },
                "on": {
                    "attempts": 2,
                    "outcomes": {"pass": 1, "fail": 1, "capped": 0, "interrupted": 0, "invalid": 0},
                    "pass_rate": 0.5,
                    "tokens": 16000,
                    "tokens_per_attempt": 8000.0,
                    "accounting": "incomplete",
                },
            },
            "comparisons": {
                "on": {
                    "token_ratio": 0.8,
                    "token_ratio_reason": None,
                    "headline_eligible": False,
                    "interval": {
                        "low": 0.7,
                        "high": 0.9,
                        "confidence": 0.95,
                        "tasks": 4,
                        "point": 0.8,
                        "method": "task_paired_percentile",
                        "resamples": 2000,
                        "seed": 7,
                    },
                }
            },
            "invalid": [],
            "excluded": {},
            "trials": [
                {"outcome": "pass"},
                {"outcome": "pass"},
                {"outcome": "pass"},
                {"outcome": "fail"},
            ],
        }
        base.update(overrides)
        return base

    def test_the_reading_prints_every_arm_not_only_the_winner(self) -> None:
        text = report_module.render(self.report())
        self.assertIn("off (baseline)", text)
        self.assertIn("on", text)
        self.assertIn("incomplete", text)

    def test_it_names_the_ratio_its_interval_and_whether_it_is_headline_eligible(self) -> None:
        text = report_module.render(self.report())
        self.assertIn("0.800", text)
        self.assertIn("[0.700, 0.900]", text)
        self.assertIn("95%", text)
        self.assertIn("NOT headline eligible", text)

    def test_a_refused_ratio_prints_its_reason_instead_of_a_number(self) -> None:
        payload = self.report()
        payload["comparisons"]["on"]["token_ratio"] = None
        payload["comparisons"]["on"]["token_ratio_reason"] = "no_verified_resolution"
        text = report_module.render(payload)
        self.assertIn("no_verified_resolution", text)
        self.assertNotIn("0.800", text)

    def test_a_single_arm_run_says_there_is_no_comparison(self) -> None:
        payload = self.report(comparisons={})
        self.assertIn("no comparison", report_module.render(payload))

    def test_failed_and_invalid_attempts_stay_visible(self) -> None:
        payload = self.report(invalid=[{"trial_id": "x", "reason": "usage:mismatch"}])
        text = report_module.render(payload)
        self.assertIn("3 pass", text)
        self.assertIn("1 fail", text)
        self.assertIn("1 invalid", text)

    def test_the_reading_adds_no_number_the_report_does_not_carry(self) -> None:
        # Every number in the text must be traceable to the projection, so the
        # reading cannot become a second, drifting source of results.
        payload = self.report()
        text = report_module.render(payload)
        self.assertNotIn("0.500", text.split("token ratio")[1])

    def test_it_reads_a_real_report_written_by_the_fake_run(self) -> None:
        from evals.benchmark import cli

        with tempfile.TemporaryDirectory(prefix="bench1-render-") as directory:
            run = Path(directory) / "run"
            cli.fake_run(run)
            published = json.loads((run / "report.json").read_text(encoding="utf-8"))
            text = report_module.render(published)
        self.assertIn("bench1.report.v1", text)
        self.assertIn("(baseline)", text)


if __name__ == "__main__":
    unittest.main()
