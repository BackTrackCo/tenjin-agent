"""`python3 -m evals.benchmark.cli fake-run|verify|reduce|report`.

The fake path is the CI path: no model, no network, no spend. `verify` re-runs
the hidden verifiers over a finished run's retained worktrees and reports where
a fresh verdict disagrees with the recorded one, which is the check an operator
runs before trusting a run they did not watch. `reduce` and `report` rebuild
the aggregates and the publishable projection from the immutable records alone.

There is deliberately no live subcommand: a live run is operator-only, is built
in code around `runner.Runtime` and the isolation attestation in `artifact.py`,
and is refused in CI. See the README's live section.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from . import (
    FIXTURES,
    manifest as manifest_module,
    records,
    reduce as reduce_module,
    report as report_module,
    runner,
    schedule,
    verifier,
)

FAKE_MANIFEST = FIXTURES / "fake" / "manifest.json"


def baseline(manifest: manifest_module.Manifest) -> str:
    """The first arm in the manifest is the control every other arm is read against."""
    return str(manifest.arms[0]["id"])


def load_run(run_dir: Path) -> tuple[manifest_module.Manifest, str]:
    payload = json.loads((run_dir / "schedule.json").read_text(encoding="utf-8"))
    manifest = manifest_module.load(Path(json.loads((run_dir / "manifest.json").read_text(encoding="utf-8"))["path"]))
    if manifest.hash != payload["manifest_hash"]:
        raise manifest_module.ManifestError("manifest changed since the schedule was written")
    return manifest, payload["schedule_hash"]


def fake_run(out: Path, manifest_path: Path = FAKE_MANIFEST, runtime: runner.Runtime | None = None) -> dict[str, Any]:
    manifest = manifest_module.load(manifest_path)
    trials = schedule.expand(manifest)
    out.mkdir(parents=True, exist_ok=True)
    (out / "manifest.json").write_text(json.dumps({"path": str(manifest.path), "hash": manifest.hash}, indent=2) + "\n", encoding="utf-8")
    digest = schedule.write(out, manifest, trials)
    results = runner.run(manifest, trials, out, digest, runtime or runner.Runtime())
    report = do_report(out)
    return {
        "trials": len(results),
        "resumed": sum(1 for result in results if result.resumed),
        "outcomes": {result.trial_id: result.outcome for result in results},
        "report": str(out / "report.json"),
        "schedule_hash": report["schedule_hash"],
    }


def do_verify(run_dir: Path) -> dict[str, Any]:
    """Re-run each accepted attempt's hidden verifier on its retained worktree."""
    manifest, digest = load_run(run_dir)
    verdicts: dict[str, Any] = {}
    disagreements: list[str] = []
    accepted, _ = records.select(run_dir / "records", manifest.hash, digest)
    for trial_id, record in sorted(accepted.items()):
        copy = run_dir / "trials" / trial_id / "verify"
        if not copy.is_dir():
            verdicts[trial_id] = {"status": "worktree_absent", "recorded": record["outcome"]}
            continue
        task = next(item for item in manifest.tasks if item["id"] == record["task_id"])
        verdict = verifier.run(verifier.lookup(task["verifier"]), copy, run_dir)
        agrees = verdict.outcome == record["outcome"]
        verdicts[trial_id] = {"status": verdict.outcome, "recorded": record["outcome"], "agrees": agrees}
        if not agrees:
            disagreements.append(trial_id)
    return {"trials": verdicts, "disagreements": disagreements}


def do_reduce(run_dir: Path) -> dict[str, Any]:
    manifest, digest = load_run(run_dir)
    accepted, excluded = records.select(run_dir / "records", manifest.hash, digest)
    return reduce_module.reduce(accepted, excluded, baseline(manifest), manifest.data["seed"], manifest.arms)


def do_report(run_dir: Path) -> dict[str, Any]:
    manifest, digest = load_run(run_dir)
    accepted, excluded = records.select(run_dir / "records", manifest.hash, digest)
    reduction = reduce_module.reduce(accepted, excluded, baseline(manifest), manifest.data["seed"], manifest.arms)
    report = report_module.project(manifest.data, manifest.hash, digest, reduction, accepted)
    (run_dir / "report.json").write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python3 -m evals.benchmark.cli")
    commands = parser.add_subparsers(dest="command", required=True)
    fake = commands.add_parser("fake-run", help="run the fake manifest end to end, offline")
    fake.add_argument("--out", required=True, type=Path)
    for name in ("verify", "reduce", "report"):
        commands.add_parser(name).add_argument("--run", required=True, type=Path)
    args = parser.parse_args(argv)
    if args.command == "fake-run":
        payload = fake_run(args.out)
    elif args.command == "verify":
        payload = do_verify(args.run)
    elif args.command == "reduce":
        payload = do_reduce(args.run)
    else:
        payload = do_report(args.run)
    json.dump(payload, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
