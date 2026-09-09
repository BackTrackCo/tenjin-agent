#!/usr/bin/env python3
"""Offline self-test entry: every case under evals/benchmark/tests/, through stdlib unittest.

No model, no network, no spend, nothing installed. The required CI workflow
runs it on every pull request; its wall-clock bound is the CI step's own
timeout, not a rule in here. The flags the workflow passes are accepted so the
workflow stays as it is: `--verbosity` is unittest's, `--groups` wraps the run
in one GitHub Actions log group, and `--summary` appends the one-line verdict
to a step summary file.
"""

from __future__ import annotations

import argparse
import sys
import time
import unittest
from pathlib import Path

PACKAGE = Path(__file__).resolve().parent
REPO_ROOT = PACKAGE.parent.parent


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python3 evals/benchmark/selftest.py")
    parser.add_argument("--verbosity", type=int, default=1, choices=(0, 1, 2))
    parser.add_argument("--groups", action="store_true", help="wrap the run in a GitHub Actions log group")
    parser.add_argument("--summary", type=Path, help="append the verdict line here, such as $GITHUB_STEP_SUMMARY")
    args = parser.parse_args(argv)
    sys.path.insert(0, str(REPO_ROOT))
    if args.groups:
        print("::group::evals/benchmark/tests", flush=True)
    started = time.monotonic()
    suite = unittest.defaultTestLoader.discover(str(PACKAGE / "tests"), pattern="test_*.py", top_level_dir=str(REPO_ROOT))
    result = unittest.TextTestRunner(verbosity=args.verbosity).run(suite)
    elapsed = time.monotonic() - started
    if args.groups:
        print("::endgroup::", flush=True)
    ok = result.wasSuccessful()
    verdict = (
        f"benchmark self-test passed: {result.testsRun} tests in {elapsed:.1f}s"
        if ok
        else f"benchmark self-test FAILED: {len(result.failures)} failures, {len(result.errors)} errors of {result.testsRun} tests in {elapsed:.1f}s"
    )
    print(verdict)
    if args.summary:
        with args.summary.open("a", encoding="utf-8") as handle:
            handle.write(f"## Bench-1 offline self-test\n\n{verdict}. No model, no network, no spend.\n")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
