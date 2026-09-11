"""The informational regression check: warn, annotate, never fail."""

from __future__ import annotations

import contextlib
import io
import json
from pathlib import Path
from typing import Callable
from unittest import mock

import pytest
from inline_snapshot import snapshot

from evals.benchmark import cli, regress
from evals.benchmark.tests import support

Check = Callable[..., tuple[list[str], str]]


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


@pytest.fixture
def path(tmp_path: Path) -> Path:
    return tmp_path / "baseline.json"


@pytest.fixture
def check(path: Path) -> Check:
    """Write a baseline, run the check over a published report, return findings and text."""

    def run(published: dict, base: dict | None = None, environ: dict | None = None, records: dict | None = None) -> tuple[list[str], str]:
        path.write_text(json.dumps(base or baseline()), encoding="utf-8")
        stream = io.StringIO()
        payload = regress.check(published, records or accepted(), path, environ or {}, stream)
        return payload["findings"], stream.getvalue()

    return run




def test_a_clean_run_says_so_and_finds_nothing(check: Check) -> None:
    found, text = check(report())
    assert found == []
    assert "no regression against baseline 2026-09-07 (test baseline)" in text
    assert "::warning" not in text


def test_a_pass_rate_drop_is_a_finding(check: Check) -> None:
    found, _ = check(report(on_pass=1))
    assert found == ["arm on: pass rate 0.500 below baseline 1.000"]


def test_token_growth_beyond_the_tolerance_is_a_finding(check: Check) -> None:
    found, text = check(report(on_tokens=25001.0))
    assert len(found) == 1
    assert "arm on: 25001.0 tokens per attempt, above baseline 20000 by more than 25%" in found[0]
    assert "regression: arm on" in text


def test_token_growth_within_the_tolerance_is_not(check: Check) -> None:
    found, _ = check(report(on_tokens=25000.0, off_tokens=24999.0))
    assert found == []


def test_cost_growth_beyond_the_tolerance_is_a_finding(check: Check) -> None:
    found, _ = check(report(), records=accepted(cost=0.08))
    assert found == snapshot(
        [
            "arm off: 0.0800 USD per attempt, above baseline 0.0600 by more than 25%",
            "arm on: 0.0800 USD per attempt, above baseline 0.0600 by more than 25%",
        ]
    )


def test_a_missing_cost_is_not_compared(check: Check) -> None:
    records = accepted()
    for record in records.values():
        record["cost_usd"] = None
    found, _ = check(report(), records=records)
    assert found == []


def test_an_invalid_attempt_or_an_excluded_record_is_a_finding(check: Check) -> None:
    found, _ = check(report(invalid=1, excluded=2))
    assert found == ["1 invalid attempt", "2 record files excluded"]


def test_an_arm_missing_on_either_side_is_named(check: Check) -> None:
    published = report()
    del published["arms"]["on"]
    published["arms"]["new"] = published["arms"]["off"]
    found, _ = check(published)
    assert found == ["arm on: no accepted attempt in this run, baseline had 2", "arm new: no baseline entry"]


def test_github_actions_gets_one_annotation_per_finding_and_a_step_summary(check: Check, tmp_path: Path) -> None:
    summary = tmp_path / "summary.md"
    environ = {"GITHUB_ACTIONS": "1", "GITHUB_STEP_SUMMARY": str(summary)}
    found, text = check(report(on_pass=1, invalid=1), environ=environ)
    assert len(found) == 2
    for item in found:
        assert f"::warning title=benchmark regression::{item}\n" in text
    written = summary.read_text(encoding="utf-8")
    assert "## Bench-1 regression check: regressions found" in written
    assert "regression: arm on: pass rate" in written


@pytest.mark.parametrize(
    "data",
    [
        pytest.param(baseline(schema="other"), id="schema"),
        pytest.param(baseline(tolerance=1.5), id="tolerance"),
        pytest.param(baseline(arms={"off": {"attempts": 2}}), id="arm keys"),
        pytest.param(baseline(arms={"off": {"attempts": 1, "pass": 2, "mean_tokens": 1, "mean_cost_usd": 0}}), id="pass over attempts"),
    ],
)
def test_a_malformed_baseline_is_refused_by_shape(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data), encoding="utf-8")
    with pytest.raises(regress.BaselineError):
        regress.load_baseline(path)


def test_the_command_line_exits_zero_whatever_it_finds(fake_run: Path, path: Path) -> None:
    path.write_text(json.dumps(baseline(arms={"off": {"attempts": 2, "pass": 2, "mean_tokens": 1, "mean_cost_usd": 0}})), encoding="utf-8")
    printed = io.StringIO()
    with contextlib.redirect_stdout(printed), mock.patch.dict("os.environ", {"GITHUB_ACTIONS": "1", "GITHUB_STEP_SUMMARY": ""}, clear=False):
        code = cli.main(["regress", "--run", str(fake_run), "--baseline", str(path)])
    assert code == 0
    assert "regression: arm off:" in printed.getvalue()
    assert "::warning title=benchmark regression::" in printed.getvalue()
