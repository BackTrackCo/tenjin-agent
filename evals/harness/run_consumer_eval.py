#!/usr/bin/env python3
"""Preflight the frozen PR 2A consumer-use lane and fail closed.

The current ordinary team-mode UserPromptSubmit implementation always launches
both team and public shelf requests.  The benchmark requires zero public
traffic, so this runner performs the frozen-input, source, installed-hook,
configuration, state-store, and parity gates, writes a thin ``blocked_not_run``
artifact, then exits without invoking Claude or ``tenjin push grade``.

When the ordinary product path can make a team-only prompt query, this is the
place to add the full-set executor.  Do not work around the invariant by
rewriting configuration or substituting a benchmark-only hook.
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from installed_hooks import (  # noqa: E402
    InstalledHooksPreflightError,
    build_blocked_consumer_report,
    consumer_fixture_preflight,
    installed_capture_state_db,
    installed_child_env,
    installed_hooks_preflight,
    source_provenance,
    validate_installed_parity_report,
)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--fixture-dir",
        type=Path,
        default=Path("evals/tenjin-publish/session-capture/archive-v1"),
    )
    parser.add_argument("--installed-parity-report", required=True, type=Path)
    parser.add_argument("--workspace", type=Path, default=None)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()

    repo = Path(__file__).resolve().parents[2]
    workspace = args.workspace or Path(tempfile.mkdtemp(prefix="consumer-eval-preflight-"))
    workspace.mkdir(parents=True, exist_ok=True)
    try:
        fixture = consumer_fixture_preflight(args.fixture_dir)
        source = source_provenance(repo)
        environment = installed_child_env()
        preflight = installed_hooks_preflight(cwd=workspace, env=environment)
        # The live lane is blocked, but resolving the exact state store now
        # proves that its eventual per-session attribution will use the same
        # installed bundle and not a benchmark-local data directory.
        installed_capture_state_db(
            env=environment,
            expected_hook_sha256=preflight["installedHookSetSha256"],
        )
        parity = validate_installed_parity_report(
            args.installed_parity_report, source, preflight
        )
        report = build_blocked_consumer_report(
            fixture=fixture,
            preflight=preflight,
            source=source,
            parity=parity,
        )
    except (InstalledHooksPreflightError, OSError) as error:
        print(f"CONSUMER PREFLIGHT FAILED, nothing ran: {error}", file=sys.stderr)
        return 2

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(
        "CONSUMER USE BLOCKED, nothing ran: ordinary team prompt hook always queries public",
        file=sys.stderr,
    )
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
