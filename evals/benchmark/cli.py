"""`python3 -m evals.benchmark.cli fake-run|live-run|verify|reduce|report`.

The fake path is the CI path: no model, no network, no spend. `verify` re-runs
the hidden verifiers over a finished run's retained worktrees and reports where
a fresh verdict disagrees with the recorded one, which is the check an operator
runs before trusting a run they did not watch. `reduce` and `report` rebuild
the aggregates and the publishable projection from the immutable records alone.

`live-run` is the operator's command and spends real money. The two commands
refuse each other's manifests, so neither can quietly run the other's
executor. `--dry-run` prints the argv and the roots each trial would use and
starts nothing, which is the only part of the live path CI may exercise and is
how a reviewer reads the real command without running it. Without `--dry-run`
it requires an isolation attestation and refuses an automated environment, on
top of the refusals `artifact.require_isolation` already owns.
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import sys
from pathlib import Path
from typing import Any, Mapping

from . import (
    FIXTURES,
    artifact,
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
SMOKE_MANIFEST = FIXTURES / "live" / "smoke-manifest.json"
# A live run is a human at a terminal. These names mean nobody is watching.
AUTOMATION_ENV = ("CI", "GITHUB_ACTIONS")


class CliError(RuntimeError):
    """A refusal an operator should read as a sentence, not as a traceback."""


def baseline(manifest: manifest_module.Manifest) -> str:
    """The first arm in the manifest is the control every other arm is read against."""
    return str(manifest.arms[0]["id"])


def load_run(run_dir: Path) -> tuple[manifest_module.Manifest, str]:
    payload = json.loads((run_dir / "schedule.json").read_text(encoding="utf-8"))
    manifest = manifest_module.load(Path(json.loads((run_dir / "manifest.json").read_text(encoding="utf-8"))["path"]))
    if manifest.hash != payload["manifest_hash"]:
        raise manifest_module.ManifestError("manifest changed since the schedule was written")
    return manifest, payload["schedule_hash"]


def require_executor(manifest: manifest_module.Manifest, *, live: bool) -> None:
    """`fake-run` refuses a live executor and `live-run` refuses a fake one."""
    command = "live-run" if live else "fake-run"
    for arm in manifest.arms:
        spec = executor.lookup(arm["executor"])
        if spec.live is not live:
            kind = "live" if spec.live else "fake"
            raise CliError(f"{command} refuses arm {arm['id']!r}: executor {spec.name!r} is {kind}")


def execute(manifest: manifest_module.Manifest, trials: list[schedule.Trial], out: Path, runtime: runner.Runtime) -> dict[str, Any]:
    """Write the run's manifest pointer and schedule, execute it, publish the report."""
    out.mkdir(parents=True, exist_ok=True)
    (out / "manifest.json").write_text(json.dumps({"path": str(manifest.path), "hash": manifest.hash}, indent=2) + "\n", encoding="utf-8")
    digest = schedule.write(out, manifest, trials)
    results = runner.run(manifest, trials, out, digest, runtime)
    report = do_report(out)
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


def plan_trial(manifest: manifest_module.Manifest, trial: schedule.Trial, out: Path) -> dict[str, Any]:
    """Build one trial's roots and launch exactly as `runner.run_trial` does, then stop."""
    task = next(item for item in manifest.tasks if item["id"] == trial.task_id)
    arm = next(item for item in manifest.arms if item["id"] == trial.arm_id)
    spec = executor.lookup(arm["executor"])
    roots = artifact.create(out, trial.trial_id, manifest.fixture_path(task))
    launch = spec.launch(executor.LaunchRequest(trial.trial_id, roots, task, arm, manifest.pins))
    return {
        "trial_id": trial.trial_id,
        "task_id": trial.task_id,
        "arm_id": trial.arm_id,
        "repeat": trial.repeat,
        "argv": list(launch.argv),
        "roots": {
            "cwd": str(launch.cwd),
            "home": str(roots.home),
            "data": str(roots.data_dir),
            "output": str(roots.output),
            "sessions": str(spec.sessions(roots, launch.root_session_id)),
        },
        "environment": sorted(launch.env or {}),
    }


def render_plan(manifest: manifest_module.Manifest, plans: list[dict[str, Any]]) -> str:
    """One block per trial, with the argv on a single copyable line."""
    lines = [
        f"live-run dry run: {len(plans)} trials from {manifest.path}",
        "nothing was started: --dry-run stops before the spawn.",
        "env names the child allowlist and prints no value; the credential seam "
        "variable is on that line only when this shell has it set.",
    ]
    for index, plan in enumerate(plans, start=1):
        lines.append("")
        lines.append(
            f"trial {index}/{len(plans)} {plan['trial_id']} "
            f"task={plan['task_id']} arm={plan['arm_id']} repeat={plan['repeat']}"
        )
        for name, value in plan["roots"].items():
            lines.append(f"  {name:9}{value}")
        lines.append(f"  {'env':9}{' '.join(plan['environment'])}")
        lines.append(f"  {'argv':9}{shlex.join(plan['argv'])}")
    return "\n".join(lines)


def live_run(
    out: Path,
    manifest_path: Path = SMOKE_MANIFEST,
    attestation_path: Path | None = None,
    *,
    dry_run: bool = False,
    environ: Mapping[str, str] | None = None,
    stream: Any = None,
) -> dict[str, Any]:
    environ = os.environ if environ is None else environ
    manifest = manifest_module.load(manifest_path)
    require_executor(manifest, live=True)
    trials = schedule.expand(manifest)
    if dry_run:
        plans = [plan_trial(manifest, trial, out) for trial in trials]
        (stream or sys.stdout).write(render_plan(manifest, plans) + "\n")
        return {"dry_run": True, "trials": plans}
    automated = [name for name in AUTOMATION_ENV if environ.get(name)]
    if automated:
        raise CliError(f"live-run refuses an automated environment: {', '.join(automated)} is set")
    if attestation_path is None:
        raise CliError("live-run requires --attestation: a publishable live run states the isolation it ran under")
    attestation = artifact.load_attestation(attestation_path)
    runtime = runner.Runtime(attestation=attestation, publishable=True, ci=bool(environ.get("CI")))
    return execute(manifest, trials, out, runtime)


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
    live = commands.add_parser("live-run", help="operator only: run a live manifest, or print what it would run")
    live.add_argument("--manifest", required=True, type=Path)
    live.add_argument("--out", required=True, type=Path)
    live.add_argument("--attestation", type=Path, help="isolation attestation JSON; required without --dry-run")
    live.add_argument("--dry-run", action="store_true", help="print each trial's argv and roots, start nothing")
    for name in ("verify", "reduce", "report"):
        commands.add_parser(name).add_argument("--run", required=True, type=Path)
    # `summary` prints a finished report as text instead of JSON. It reads the
    # published projection and computes nothing, so a log can show what a run
    # did without a reader piping JSON through another tool.
    summary = commands.add_parser("summary", help="read a finished run's report.json as text")
    summary.add_argument("--run", required=True, type=Path)
    args = parser.parse_args(argv)
    if args.command == "summary":
        published = json.loads((args.run / "report.json").read_text(encoding="utf-8"))
        sys.stdout.write(report_module.render(published) + "\n")
        return 0
    if args.command == "live-run":
        try:
            payload = live_run(args.out, args.manifest, args.attestation, dry_run=args.dry_run)
        except CliError as error:
            sys.stderr.write(f"{error}\n")
            return 2
        if args.dry_run:
            return 0
    elif args.command == "fake-run":
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
