"""The offline suite's own wall-clock budget.

The budget is a property of this package rather than of the machine that
happens to run it, so the entry point times the one run it makes and fails
past `BUDGET_S`. Nothing here re-runs the suite: a second run inside the
first would double the wall time it is meant to bound.
"""

from __future__ import annotations

import io
import unittest

from evals.benchmark import selftest


class BudgetTest(unittest.TestCase):
    def test_the_entry_point_judges_the_budget_on_its_one_run(self) -> None:
        stream = io.StringIO()
        passed = selftest.run(["test_schedule"], budget_s=selftest.BUDGET_S, stream=stream)
        self.assertTrue(passed.ok)
        self.assertEqual([result.module for result in passed.results], ["test_schedule"])
        self.assertGreater(passed.results[0].tests, 0)
        self.assertIn("benchmark self-test passed:", stream.getvalue())
        self.assertIn(f"budget {selftest.BUDGET_S:.0f}s", stream.getvalue())
        stream = io.StringIO()
        slow = selftest.run(["test_schedule"], budget_s=0.0, stream=stream)
        self.assertFalse(slow.ok)
        self.assertTrue(all(result.ok for result in slow.results))
        self.assertIn("over its 0s budget", stream.getvalue())
        self.assertNotIn("passed:", stream.getvalue())

    def test_the_budget_is_sixty_seconds_and_the_rule_is_strict(self) -> None:
        self.assertEqual(selftest.BUDGET_S, 60.0)
        self.assertFalse(selftest.over_budget(59.9))
        self.assertTrue(selftest.over_budget(60.1))
        self.assertTrue(selftest.over_budget(0.1, 0.0))


if __name__ == "__main__":
    unittest.main()
