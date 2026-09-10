"""`python3 -m evals.benchmark.cli fake-run|verify|reduce|report|summary`.

The fake path is the CI path: no model, no network, no spend. `verify` re-runs
the hidden verifiers over a finished run's retained worktrees and reports where
a fresh verdict disagrees with the recorded one, which is the check an operator
runs before trusting a run they did not watch. `reduce` and `report` rebuild
the aggregates and the publishable projection from the immutable records alone.

Nothing here starts an agent or spends anything. This is the offline half of
the chain; the live executor and the `live-run` command that drives it arrive
on top of it. `require_executor` refuses a live executor name, so a manifest
that names one cannot be run here by mistake.
"""
from __future__ import annotations

import argparse
import dataclasses
import json
import re
import secrets
import sys
import time
from pathlib import Path
from typing import Any

from . import (
    FIXTURES,
    executor,
    manifest as manifest_module,
    records,
    reduce as reduce_module,
    report as report_module,
    runner,
    schedule,
    verifier,
)

FAKE_MANIFEST = FIXTURES / "fake" / "manifest.json"


class CliError(RuntimeError):
    """A refusal an operator should read as a sentence, not as a traceback."""


def baseline(manifest: manifest_module.Manifest) -> str:
    """The first arm in the manifest is the control every other arm is read against."""
    return str(manifest.arms[0]["id"])


def read_run_file(run_dir: Path, name: str) -> Any:
    """One of a run's own files, or a refusal that names what is missing rather than a traceback."""
    path = run_dir / name
    if not path.is_file():
        raise CliError(f"no {name} under {run_dir}: the run did not start or wrote no records, so there is nothing to read")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise CliError(f"{path} is not readable JSON: {error.__class__.__name__}") from error


def load_run(run_dir: Path) -> tuple[manifest_module.Manifest, str]:
    payload = read_run_file(run_dir, "schedule.json")
    manifest = manifest_module.load(Path(read_run_file(run_dir, "manifest.json")["path"]))
    if manifest.hash != payload["manifest_hash"]:
        raise manifest_module.ManifestError("manifest changed since the schedule was written")
    return manifest, payload["schedule_hash"]


def require_executor(manifest: manifest_module.Manifest, *, live: bool) -> executor.ExecutorSpec:
    """`fake-run` refuses a live executor and `live-run` refuses a fake one.

    Returns the one spec every arm shares, which `manifest.validate` enforces.
    """
    command = "live-run" if live else "fake-run"
    specs = []
    for arm in manifest.arms:
        spec = executor.lookup(arm["executor"])
        if spec.live is not live:
            kind = "live" if spec.live else "fake"
            raise CliError(f"{command} refuses arm {arm['id']!r}: executor {spec.name!r} is {kind}")
        specs.append(spec)
    return specs[0]


def refuse_secret_in_report(out: Path, secrets: tuple[str, ...]) -> None:
    """The report is the one file that may leave the run directory. A seeded secret in it is a refusal."""
    path = out / "report.json"
    text = path.read_text(encoding="utf-8")
    if any(secret and secret in text for secret in secrets):
        path.unlink()
        raise CliError("report.json carried the seeded shelf secret and was deleted: nothing from this run is publishable")


NONCE = re.compile(r"^\d{8}T\d{6}Z-[0-9a-f]{8}\Z")


def run_nonce(out: Path, manifest: manifest_module.Manifest) -> str:
    """One nonce per run, minted at the first `live-run` and kept in the manifest sidecar so a resume reuses it."""
    sidecar = out / "manifest.json"
    existing = None
    if sidecar.is_file():
        try:
            existing = json.loads(sidecar.read_text(encoding="utf-8")).get("nonce")
        except (OSError, json.JSONDecodeError, AttributeError):
            existing = None
    nonce = existing if isinstance(existing, str) and NONCE.match(existing) else f"{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}-{secrets.token_hex(4)}"
    out.mkdir(parents=True, exist_ok=True)
    sidecar.write_text(json.dumps({"path": str(manifest.path), "hash": manifest.hash, "nonce": nonce}, indent=2) + "\n", encoding="utf-8")
    return nonce


def execute(manifest: manifest_module.Manifest, trials: list[schedule.Trial], out: Path, runtime: runner.Runtime) -> dict[str, Any]:
    """Write the run's manifest pointer and schedule, execute it, publish the report."""
    nonce = run_nonce(out, manifest)
    runtime = dataclasses.replace(runtime, run_nonce=nonce)
    digest = schedule.write(out, manifest, trials)
    results = runner.run(manifest, trials, out, digest, runtime)
    report = do_report(out)
    refuse_secret_in_report(out, tuple(getattr(runtime.source, "secrets", ()) or ()))
    return {
        "trials": len(results),
        "resumed": sum(1 for result in results if result.resumed),
        "outcomes": {result.trial_id: result.outcome for result in results},
        "report": str(out / "report.json"),
        "schedule_hash": report["schedule_hash"],
    }


def fake_run(out: Path, manifest_path: Path = FAKE_MANIFEST, runtime: runner.Runtime | None = None) -> dict[str, Any]:
    manifest = manifest_module.load(manifest_path)
    require_executor(manifest, live=False)
    return execute(manifest, schedule.expand(manifest), out, runtime or runner.Runtime())


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
        # A capped attempt keeps its verdict beside the outcome, so the fresh
        # verdict is read against the recorded verdict rather than `capped`.
        recorded = record["outcome"] if record["verifier"] is None else verifier.outcome_of(record["verifier"]["exit_code"])
        agrees = verdict.outcome == recorded
        verdicts[trial_id] = {"status": verdict.outcome, "recorded": recorded, "agrees": agrees}
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
    # `summary` prints a finished report as text instead of JSON. It reads the
    # published projection and computes nothing, so a log can show what a run
    # did without a reader piping JSON through another tool.
    summary = commands.add_parser("summary", help="read a finished run's report.json as text")
    summary.add_argument("--run", required=True, type=Path)
    args = parser.parse_args(argv)
    if args.command in ("summary", "verify", "reduce", "report"):
        try:
            return run_reader(args)
        except (CliError, manifest_module.ManifestError, records.RecordError) as error:
            sys.stderr.write(f"{error}\n")
            return 2
    payload = fake_run(args.out)
    json.dump(payload, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0


def run_reader(args: argparse.Namespace) -> int:
    """The commands that read a finished run. Each refuses a run with nothing to read in one sentence."""
    if args.command == "summary":
        sys.stdout.write(report_module.render(read_run_file(args.run, "report.json")) + "\n")
        return 0
    payload = {"verify": do_verify, "reduce": do_reduce, "report": do_report}[args.command](args.run)
    json.dump(payload, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
