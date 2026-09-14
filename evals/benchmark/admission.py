"""Conservative admission budget; active attempts drain before the CI hard timeout."""
from __future__ import annotations

import argparse
import math
import time
from pathlib import Path

from . import manifest

# Two settlement/daemon/verifier allowances per producer+consumer attempt,
# plus provisioning, teardown, checkpoint upload and check publication slack.
PER_SESSION_TAIL_S = 150
FINAL_TAIL_S = 900


def seconds(config, job_seconds: float, elapsed_seconds: float) -> float:
    if not all(math.isfinite(value) and value >= 0 for value in (job_seconds, elapsed_seconds)):
        raise ValueError("job and elapsed seconds must be finite and nonnegative")
    sessions = 2 if any(arm.get("producer") for arm in config.arms) else 1
    reserve = sessions * (config.pins["wall_clock_s"] + PER_SESSION_TAIL_S) + FINAL_TAIL_S
    return max(0.0, job_seconds - elapsed_seconds - reserve)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--job-minutes", required=True, type=float)
    parser.add_argument("--started-at", required=True, type=float)
    args = parser.parse_args()
    print(int(seconds(manifest.load(args.manifest), args.job_minutes * 60, max(0, time.time() - args.started_at))))


if __name__ == "__main__":
    main()
