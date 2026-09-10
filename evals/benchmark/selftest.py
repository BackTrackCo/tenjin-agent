#!/usr/bin/env python3
"""Offline self-test entry: every case under evals/benchmark/tests/, through pytest.

No model, no network, no spend. The required CI workflow runs it on every pull
request; its wall-clock bound is the CI step's own timeout, not a rule in here.
The flags the workflow passes are unchanged: `--verbosity` picks pytest's quiet,
default, or verbose reporting, `--groups` wraps the run in one GitHub Actions
log group, and `--summary` appends the one-line verdict to a step summary file.

pytest and inline-snapshot are the suite's own dependencies, pinned alongside
the package's in `requirements-test.txt`. Run this file with that venv's
interpreter, which is what the CI step does.
"""

from __future__ import annotations

import argparse
import importlib.util
import sys
import time
from pathlib import Path

PACKAGE = Path(__file__).resolve().parent
REPO_ROOT = PACKAGE.parent.parent
INSTALL = "python3 -m pip install --require-hashes --only-binary=:all: -r evals/benchmark/requirements-test.txt"


class Counter:
    """The run's own totals, so the verdict line states what pytest collected."""

    def __init__(self) -> None:
        self.collected = 0
        self.failed = 0
        self.errors = 0

    def pytest_collection_finish(self, session: object) -> None:
        # `session.testscollected` is still zero here; the item list is not.
        self.collected = len(getattr(session, "items", ()))

    def pytest_runtest_logreport(self, report: object) -> None:
        if getattr(report, "outcome", "") == "failed":
            if getattr(report, "when", "") == "call":
                self.failed += 1
            else:
                self.errors += 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python3 evals/benchmark/selftest.py")
    parser.add_argument("--verbosity", type=int, default=1, choices=(0, 1, 2))
    parser.add_argument("--groups", action="store_true", help="wrap the run in a GitHub Actions log group")
    parser.add_argument("--summary", type=Path, help="append the verdict line here, such as $GITHUB_STEP_SUMMARY")
    args = parser.parse_args(argv)
    # `find_spec` rather than an import: importing the plugin here would beat
    # pytest to it and lose assertion rewriting inside it.
    if importlib.util.find_spec("inline_snapshot") is None:
        print(f"the benchmark self-test needs inline-snapshot; install it with\n  {INSTALL}", file=sys.stderr)
        return 2
    try:
        import pytest
    except ModuleNotFoundError:
        print(f"the benchmark self-test needs pytest; install it with\n  {INSTALL}", file=sys.stderr)
        return 2
    sys.path.insert(0, str(REPO_ROOT))
    counter = Counter()
    if args.groups:
        print("::group::evals/benchmark/tests", flush=True)
    started = time.monotonic()
    reporting = {0: ["-q"], 2: ["-v"]}.get(args.verbosity, [])
    status = pytest.main(["-c", str(PACKAGE / "pytest.ini"), *reporting], plugins=[counter])
    elapsed = time.monotonic() - started
    if args.groups:
        print("::endgroup::", flush=True)
    # A required check that reports success over an empty run is worse than a
    # slow one, so a green status with nothing collected is a red verdict.
    ok = status == 0 and counter.collected > 0
    verdict = (
        f"benchmark self-test passed: {counter.collected} tests in {elapsed:.1f}s"
        if ok
        else f"benchmark self-test FAILED: {counter.failed} failures, {counter.errors} errors"
        f" of {counter.collected} tests in {elapsed:.1f}s"
    )
    print(verdict)
    if args.summary:
        with args.summary.open("a", encoding="utf-8") as handle:
            handle.write(f"## Bench-1 offline self-test\n\n{verdict}. No model, no network, no spend.\n")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
