"""The informational regression check: warn, annotate, never fail."""

from __future__ import annotations

import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from evals.benchmark import cli, regress
from evals.benchmark.tests import support


def baseline(**overrides: object) -> dict:
    base = {
        "schema": regress.BASELINE_SCHEMA,
        "date": "2026-09-07",
        "source": "test baseline",
        "tolerance": 0.25,
        "arms": {
            "off": {"attempts": 2, "pass": 2, "mean_tokens": 20000, "mean_cost_usd": 0.06},
            "on": {"attempts": 2, "pass": 2, "mean_tokens": 20000, "mean_cost_usd": 0.06},
        },
    }
    base.update(overrides)
    return base


def report(off_tokens: float = 20000.0, on_tokens: float = 20000.0, on_pass: int = 2, invalid: int = 0, excluded: int = 0) -> dict:
    def arm(tokens: float, passes: int) -> dict:
        return {
            "attempts": 2,
            "outcomes": {"pass": passes, "fail": 2 - passes, "capped": 0, "interrupted": 0, "invalid": 0},
            "pass_rate": passes / 2,
            "tokens_per_attempt": tokens,
        }

    return {
        "manifest_hash": "a" * 64,
        "arms": {"off": arm(off_tokens, 2), "on": arm(on_tokens, on_pass)},
        "invalid": [{"trial_id": f"t{i}", "arm_id": "on", "task_id": "x", "reason": "usage"} for i in range(invalid)],
        "excluded": {"partial": excluded} if excluded else {},
    }


def accepted(cost: float = 0.06) -> dict:
    out = {}
    for index, arm_id in enumerate(("off", "off", "on", "on")):
        record = support.reduction_record(f"t{index}", arm_id, 0, index % 2, 6000, "pass")
        record["cost_usd"] = cost
        out[record["trial_id"]] = record
    return out


class RegressTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "baseline.json"

    def check(self, published: dict, base: dict | None = None, environ: dict | None = None, records: dict | None = None):
        self.path.write_text(json.dumps(base or baseline()), encoding="utf-8")
        stream = io.StringIO()
        payload = regress.check(published, records or accepted(), self.path, environ or {}, stream)
        return payload["findings"], stream.getvalue()

    def test_the_committed_baseline_loads(self) -> None:
        data = regress.load_baseline(regress.BASELINE)
        self.assertEqual(set(data["arms"]), {"off", "on"})
        self.assertIn("non-publishable", data["source"])

    def test_a_clean_run_says_so_and_finds_nothing(self) -> None:
        found, text = self.check(report())
        self.assertEqual(found, [])
        self.assertIn("no regression against baseline 2026-09-07 (test baseline)", text)
        self.assertNotIn("::warning", text)

    def test_a_pass_rate_drop_is_a_finding(self) -> None:
        found, _ = self.check(report(on_pass=1))
        self.assertEqual(found, ["arm on: pass rate 0.500 below baseline 1.000"])

    def test_token_growth_beyond_the_tolerance_is_a_finding(self) -> None:
        found, text = self.check(report(on_tokens=25001.0))
        self.assertEqual(len(found), 1)
        self.assertIn("arm on: 25001.0 tokens per attempt, above baseline 20000 by more than 25%", found[0])
        self.assertIn("regression: arm on", text)

    def test_token_growth_within_the_tolerance_is_not(self) -> None:
        found, _ = self.check(report(on_tokens=25000.0, off_tokens=24999.0))
        self.assertEqual(found, [])

    def test_cost_growth_beyond_the_tolerance_is_a_finding(self) -> None:
        found, _ = self.check(report(), records=accepted(cost=0.08))
        self.assertEqual(
            found,
            [
                "arm off: 0.0800 USD per attempt, above baseline 0.0600 by more than 25%",
                "arm on: 0.0800 USD per attempt, above baseline 0.0600 by more than 25%",
            ],
        )

    def test_a_missing_cost_is_not_compared(self) -> None:
        records = accepted()
        for record in records.values():
            record["cost_usd"] = None
        found, _ = self.check(report(), records=records)
        self.assertEqual(found, [])

    def test_an_invalid_attempt_or_an_excluded_record_is_a_finding(self) -> None:
        found, _ = self.check(report(invalid=1, excluded=2))
        self.assertEqual(found, ["1 invalid attempt", "2 record files excluded"])

    def test_an_arm_missing_on_either_side_is_named(self) -> None:
        published = report()
        del published["arms"]["on"]
        published["arms"]["new"] = published["arms"]["off"]
        found, _ = self.check(published)
        self.assertEqual(found, ["arm on: no accepted attempt in this run, baseline had 2", "arm new: no baseline entry"])

    def test_github_actions_gets_one_annotation_per_finding_and_a_step_summary(self) -> None:
        summary = Path(self.tmp.name) / "summary.md"
        environ = {"GITHUB_ACTIONS": "1", "GITHUB_STEP_SUMMARY": str(summary)}
        found, text = self.check(report(on_pass=1, invalid=1), environ=environ)
        self.assertEqual(len(found), 2)
        for item in found:
            self.assertIn(f"::warning title=benchmark regression::{item}\n", text)
        written = summary.read_text(encoding="utf-8")
        self.assertIn("## Bench-1 regression check: regressions found", written)
        self.assertIn("regression: arm on: pass rate", written)

    def test_a_malformed_baseline_is_refused_by_shape(self) -> None:
        cases = {
            "schema": baseline(schema="other"),
            "tolerance": baseline(tolerance=1.5),
            "arm keys": baseline(arms={"off": {"attempts": 2}}),
            "pass over attempts": baseline(arms={"off": {"attempts": 1, "pass": 2, "mean_tokens": 1, "mean_cost_usd": 0}}),
        }
        for name, data in cases.items():
            with self.subTest(name), self.assertRaises(regress.BaselineError):
                self.path.write_text(json.dumps(data), encoding="utf-8")
                regress.load_baseline(self.path)

    def test_the_command_line_exits_zero_whatever_it_finds(self) -> None:
        run = Path(self.tmp.name) / "run"
        cli.fake_run(run)
        self.path.write_text(json.dumps(baseline(arms={"off": {"attempts": 2, "pass": 2, "mean_tokens": 1, "mean_cost_usd": 0}})), encoding="utf-8")
        printed = io.StringIO()
        with contextlib.redirect_stdout(printed), mock.patch.dict("os.environ", {"GITHUB_ACTIONS": "1", "GITHUB_STEP_SUMMARY": ""}, clear=False):
            code = cli.main(["regress", "--run", str(run), "--baseline", str(self.path)])
        self.assertEqual(code, 0)
        self.assertIn("regression: arm off:", printed.getvalue())
        self.assertIn("::warning title=benchmark regression::", printed.getvalue())


if __name__ == "__main__":
    unittest.main()
