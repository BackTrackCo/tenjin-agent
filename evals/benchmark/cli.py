"""`python3 -m evals.benchmark.cli fake-run --out DIR` and the reduce/report steps.

The fake path is the CI path: no model, no network, no spend. Later steps
add the operator-only live command behind the isolation attestation.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from . import FIXTURES, manifest as manifest_module, records, reduce as reduce_module, report as report_module, runner, schedule

FAKE_MANIFEST = FIXTURES / "fake" / "manifest.json"


def load_run(run_dir: Path) -> tuple[manifest_module.Manifest, str]:
    payload = json.loads((run_dir / "schedule.json").read_text(encoding="utf-8"))
    manifest = manifest_module.load(Path(json.loads((run_dir / "manifest.json").read_text(encoding="utf-8"))["path"]))
    if manifest.hash != payload["manifest_hash"]:
        raise manifest_module.ManifestError("manifest changed since the schedule was written")
    return manifest, payload["schedule_hash"]


def fake_run(out: Path, manifest_path: Path = FAKE_MANIFEST) -> dict[str, Any]:
    manifest = manifest_module.load(manifest_path)
    trials = schedule.expand(manifest)
    out.mkdir(parents=True, exist_ok=True)
    (out / "manifest.json").write_text(json.dumps({"path": str(manifest.path), "hash": manifest.hash}, indent=2) + "\n", encoding="utf-8")
    digest = schedule.write(out, manifest, trials)
    results = runner.run(manifest, trials, out, digest)
    report = do_report(out)
    return {
        "trials": len(results),
        "resumed": sum(1 for result in results if result.resumed),
        "outcomes": {result.trial_id: result.outcome for result in results},
        "report": str(out / "report.json"),
        "schedule_hash": report["schedule_hash"],
    }


def do_reduce(run_dir: Path) -> dict[str, Any]:
    manifest, digest = load_run(run_dir)
    accepted, excluded = records.select(run_dir / "records", manifest.hash, digest)
    return reduce_module.reduce(accepted, excluded)


def do_report(run_dir: Path) -> dict[str, Any]:
    manifest, digest = load_run(run_dir)
    accepted, excluded = records.select(run_dir / "records", manifest.hash, digest)
    reduction = reduce_module.reduce(accepted, excluded)
    report = report_module.project(manifest.data, manifest.hash, digest, reduction, accepted)
    (run_dir / "report.json").write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python3 -m evals.benchmark.cli")
    commands = parser.add_subparsers(dest="command", required=True)
    fake = commands.add_parser("fake-run", help="run the fake manifest end to end, offline")
    fake.add_argument("--out", required=True, type=Path)
    for name in ("reduce", "report"):
        commands.add_parser(name).add_argument("--run", required=True, type=Path)
    args = parser.parse_args(argv)
    if args.command == "fake-run":
        payload = fake_run(args.out)
    elif args.command == "reduce":
        payload = do_reduce(args.run)
    else:
        payload = do_report(args.run)
    json.dump(payload, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
