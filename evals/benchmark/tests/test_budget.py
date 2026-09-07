"""The offline suite's own wall-clock budget.

Bench-1 runs inside an existing required CI lane, so "under one additional
minute" is a property of this package rather than of the machine that happens
to run it. The case runs the whole self-test as a child process and times it;
the child sets `BENCH1_SELFTEST_CHILD` so it does not run this case again.
"""

from __future__ import annotations

import os
import subprocess
import sys
import time
import unittest

from evals.benchmark import REPO_ROOT, selftest

CHILD = "BENCH1_SELFTEST_CHILD"


class BudgetTest(unittest.TestCase):
    def test_the_whole_offline_suite_finishes_inside_its_declared_budget(self) -> None:
        if os.environ.get(CHILD):
            self.skipTest("already inside the timed run")
        started = time.monotonic()
        completed = subprocess.run(
            [sys.executable, str(REPO_ROOT / "evals" / "benchmark" / "selftest.py")],
            cwd=REPO_ROOT,
            env={**os.environ, CHILD: "1"},
            capture_output=True,
            text=True,
            timeout=selftest.BUDGET_S * 2,
            shell=False,
            check=False,
        )
        elapsed = time.monotonic() - started
        self.assertEqual(completed.returncode, 0, completed.stderr[-2000:])
        self.assertLess(
            elapsed,
            selftest.BUDGET_S,
            f"the offline suite took {elapsed:.1f}s, over its {selftest.BUDGET_S:.0f}s budget",
        )

    def test_the_entry_point_fails_a_suite_that_runs_over_budget(self) -> None:
        # Running the suite by hand reports the same failure the bridge would.
        self.assertEqual(selftest.BUDGET_S, 60.0)
        self.assertFalse(selftest.over_budget(59.9))
        self.assertTrue(selftest.over_budget(60.1))


if __name__ == "__main__":
    unittest.main()
