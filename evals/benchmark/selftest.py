#!/usr/bin/env python3
"""Offline self-test entry: runs every case under evals/benchmark/tests/.

No model, no network, no spend. Run directly or through
`.github/workflows/benchmark.yml`, its own lane, separate from the required
CLI check.

The suite owns a wall-clock budget as well as a result: a suite that grows
past `BUDGET_S` fails here rather than turning its own lane into a slow one.
"""

from __future__ import annotations

import sys
import time
import unittest
from pathlib import Path

PACKAGE = Path(__file__).resolve().parent
REPO_ROOT = PACKAGE.parent.parent
BUDGET_S = 60.0


def over_budget(elapsed_s: float, budget_s: float = BUDGET_S) -> bool:
    return elapsed_s > budget_s


def main() -> int:
    sys.path.insert(0, str(REPO_ROOT))
    suite = unittest.defaultTestLoader.discover(str(PACKAGE / "tests"), top_level_dir=str(REPO_ROOT))
    started = time.monotonic()
    result = unittest.TextTestRunner(verbosity=1).run(suite)
    elapsed = time.monotonic() - started
    if not result.wasSuccessful():
        return 1
    if over_budget(elapsed):
        print(f"benchmark self-test took {elapsed:.1f}s, over its {BUDGET_S:.0f}s budget")
        return 1
    print(f"benchmark self-test finished in {elapsed:.1f}s, budget {BUDGET_S:.0f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
