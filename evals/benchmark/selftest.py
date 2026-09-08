#!/usr/bin/env python3
"""Offline self-test entry: runs every case under evals/benchmark/tests/.

No model, no network, no spend. Run directly or as a step of the required
`CI` workflow, where a change that breaks the package fails the pull request.

The suite runs one module at a time and reports each module's own count, time
and subject, because "161 tests OK" tells a reader nothing about which contract
was exercised. `--groups` wraps each module in a GitHub Actions log group, and
`--summary` writes the same table to a step summary file.

The suite owns a wall-clock budget as well as a result: a suite that grows
past `BUDGET_S` fails here rather than turning its own lane into a slow one.
"""

from __future__ import annotations

import argparse
import sys
import time
import unittest
from dataclasses import dataclass
from pathlib import Path

PACKAGE = Path(__file__).resolve().parent
REPO_ROOT = PACKAGE.parent.parent
BUDGET_S = 60.0

# One line per module, so a reader learns which contract a module holds to
# without opening it. A module with no entry still runs and prints a name
# derived from its filename, so a new module is never silently unlabelled.
SUBJECTS = {
    "test_artifact": "disposable trial roots, hidden layer, isolation attestation",
    "test_budget": "the suite's own wall-clock budget",
    "test_claude_live": "live Claude executor: argv, session id, sessions resolver, child env, live-run",
    "test_claude_usage": "Claude JSONL adapter: request grouping, retries, ambiguity",
    "test_fake_run": "the fake path end to end, manifest to report",
    "test_loop_join": "Loop 2 delivery join on the exact actor, read-only, WAL refusal",
    "test_manifest": "manifest validation, hashing, and pin rules",
    "test_output": "what the lane prints: module table, step summary, report reading",
    "test_reap": "deterministic cleanup: kill by recorded identity, never by name",
    "test_records": "immutable records, publish without overwrite, resume selection",
    "test_reduce": "task-equal reduction, amortization, seeded bootstrap intervals",
    "test_regress": "informational regression check against the committed baseline",
    "test_report": "publishable projection and the redaction guard",
    "test_runner": "trial execution, settlement, caps, process-group kill, resume",
    "test_schedule": "seeded balanced schedule and trial identity",
    "test_tenjin_arm": "the Tenjin hooks arm: seeded data dir, one daemon per trial, stopped before the join",
    "test_usage": "usage contract: arithmetic, null versus zero, dedupe",
    "test_verifier": "hidden verifier registry, fail-closed argv, outcome vocabulary",
}


def over_budget(elapsed_s: float, budget_s: float = BUDGET_S) -> bool:
    return elapsed_s > budget_s


@dataclass(frozen=True)
class ModuleResult:
    """What one module did, for the reader rather than for the exit code."""

    module: str
    subject: str
    tests: int
    seconds: float
    failures: int
    errors: int
    skipped: int

    @property
    def ok(self) -> bool:
        return self.failures == 0 and self.errors == 0

    @property
    def status(self) -> str:
        if not self.ok:
            return f"FAILED {self.failures + self.errors}"
        return "ok" if not self.skipped else f"ok, {self.skipped} skipped"


def modules() -> list[str]:
    return sorted(path.stem for path in (PACKAGE / "tests").glob("test_*.py"))


def subject_of(module: str) -> str:
    return SUBJECTS.get(module, module.removeprefix("test_").replace("_", " "))


def render_table(results: list[ModuleResult]) -> str:
    """The per-module table the console and the step summary are both built from."""
    width = max([len(result.module) for result in results] + [len("module")])
    status_width = max([len(result.status) for result in results] + [len("status")])
    lines = [f"{'module'.ljust(width)}  tests    time  {'status'.ljust(status_width)}  subject"]
    for result in results:
        lines.append(
            f"{result.module.ljust(width)}  {result.tests:5d}  {result.seconds:5.2f}s  "
            f"{result.status.ljust(status_width)}  {result.subject}"
        )
    return "\n".join(lines)


def render_markdown(results: list[ModuleResult], elapsed: float, ok: bool) -> str:
    """A GitHub step summary: the same facts, where a reviewer looks first."""
    total = sum(result.tests for result in results)
    verdict = "passed" if ok else "FAILED"
    lines = [
        "## Bench-1 offline self-test",
        "",
        f"{total} tests across {len(results)} modules {verdict} in {elapsed:.1f}s of a "
        f"{BUDGET_S:.0f}s budget. No model, no network, no spend.",
        "",
        "| Module | Tests | Time | Status | What it holds to |",
        "| --- | ---: | ---: | --- | --- |",
    ]
    for result in results:
        lines.append(
            f"| `{result.module}` | {result.tests} | {result.seconds:.2f}s | "
            f"{result.status} | {result.subject} |"
        )
    lines.append("")
    return "\n".join(lines)


def run_module(module: str, verbosity: int = 1, groups: bool = False, stream=None) -> ModuleResult:
    stream = stream if stream is not None else sys.stdout
    suite = unittest.defaultTestLoader.loadTestsFromName(f"evals.benchmark.tests.{module}")
    subject = subject_of(module)
    header = f"{module}: {subject}"
    print(f"::group::{header}" if groups else f"--- {header}", file=stream, flush=True)
    started = time.monotonic()
    result = unittest.TextTestRunner(verbosity=verbosity, stream=stream).run(suite)
    seconds = time.monotonic() - started
    if groups:
        print("::endgroup::", file=stream, flush=True)
    return ModuleResult(
        module=module,
        subject=subject,
        tests=result.testsRun,
        seconds=seconds,
        failures=len(result.failures),
        errors=len(result.errors),
        skipped=len(result.skipped),
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python3 evals/benchmark/selftest.py")
    parser.add_argument(
        "--verbosity",
        type=int,
        default=1,
        choices=(0, 1, 2),
        help="unittest verbosity; 2 names every case as it runs",
    )
    parser.add_argument("--groups", action="store_true", help="wrap each module in a GitHub Actions log group")
    parser.add_argument("--summary", type=Path, help="append a markdown table here, such as $GITHUB_STEP_SUMMARY")
    args = parser.parse_args(argv)

    sys.path.insert(0, str(REPO_ROOT))
    stream = sys.stdout
    started = time.monotonic()
    results = [run_module(module, args.verbosity, args.groups, stream) for module in modules()]
    elapsed = time.monotonic() - started

    total = sum(result.tests for result in results)
    failed = [result for result in results if not result.ok]
    slow = over_budget(elapsed)
    ok = not failed and not slow

    print("", file=stream)
    print(render_table(results), file=stream)
    print("", file=stream)
    if failed:
        print(f"benchmark self-test FAILED in {', '.join(result.module for result in failed)}", file=stream)
    elif slow:
        print(f"benchmark self-test took {elapsed:.1f}s, over its {BUDGET_S:.0f}s budget", file=stream)
    else:
        print(
            f"benchmark self-test passed: {total} tests across {len(results)} modules in "
            f"{elapsed:.1f}s, budget {BUDGET_S:.0f}s",
            file=stream,
        )

    if args.summary:
        with args.summary.open("a", encoding="utf-8") as handle:
            handle.write(render_markdown(results, elapsed, ok) + "\n")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
