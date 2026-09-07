#!/usr/bin/env python3
"""Offline self-test entry: runs every case under evals/benchmark/tests/.

No model, no network, no spend. Run directly or through
`src/evals-benchmark.test.ts`, which is what puts it in CI.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

PACKAGE = Path(__file__).resolve().parent
REPO_ROOT = PACKAGE.parent.parent


def main() -> int:
    sys.path.insert(0, str(REPO_ROOT))
    suite = unittest.defaultTestLoader.discover(str(PACKAGE / "tests"), top_level_dir=str(REPO_ROOT))
    result = unittest.TextTestRunner(verbosity=1).run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(main())
