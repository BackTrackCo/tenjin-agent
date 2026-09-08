"""`python3 -m evals.benchmark.cli fake-run|live-run|verify|reduce|report|regress`.

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
it requires an isolation attestation, refuses an automated environment, and
refuses a shell that does not have the credential seam variable set, on top of
the refusals `artifact.require_isolation` already owns. `--ci-live --plumbing`
is the one automated exception: the plumbing smoke in its own CI lane, stamped
automated and non-publishable in every record.
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import os
import shlex
import sys
from pathlib import Path
from typing import Any, Mapping

from . import (
    FIXTURES,
    reap as reap_module,
    artifact,
    executor,
    manifest as manifest_module,
    records,
    reduce as reduce_module,
    regress as regress_module,
    report as report_module,
    runner,
    schedule,
    tenjin_arm,
    vendor as vendor_module,
    verifier,
)

FAKE_MANIFEST = FIXTURES / "fake" / "manifest.json"
SMOKE_MANIFEST = FIXTURES / "live" / "smoke-manifest.json"
HOOKS_SMOKE_MANIFEST = FIXTURES / "live" / "hooks-smoke-manifest.json"
# These names mean nobody is watching. A live run under them needs `--ci-live`,
# which trades the human for the budget cap, the wall-clock cap, and the job
# timeout, and gives up any claim to a publishable number in return.
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


def provisioned_arms(manifest: manifest_module.Manifest) -> list[str]:
    return [str(arm["id"]) for arm in manifest.arms if arm.get("provision")]


def refuse_secret_in_report(out: Path, secrets: tuple[str, ...]) -> None:
    """The report is the one file that may leave the run directory. A seeded secret in it is a refusal."""
    path = out / "report.json"
    text = path.read_text(encoding="utf-8")
    if any(secret and secret in text for secret in secrets):
        path.unlink()
        raise CliError("report.json carried the seeded shelf secret and was deleted: nothing from this run is publishable")


def execute(manifest: manifest_module.Manifest, trials: list[schedule.Trial], out: Path, runtime: runner.Runtime) -> dict[str, Any]:
    """Write the run's manifest pointer and schedule, execute it, publish the report."""
    out.mkdir(parents=True, exist_ok=True)
    (out / "manifest.json").write_text(json.dumps({"path": str(manifest.path), "hash": manifest.hash}, indent=2) + "\n", encoding="utf-8")
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


def describe_hooks(settings: Mapping[str, Any]) -> list[str]:
    """One line per hook handler: the event, the kind, and the command or the URL with header names only."""
    lines = []
    for event, entries in sorted((settings.get("hooks") or {}).items()):
        for entry in entries:
            for handler in entry.get("hooks", []):
                if handler.get("type") == "http":
                    names = ",".join(sorted(handler.get("headers", {}))) or "none"
                    lines.append(f"{event} http {handler.get('url')} headers={names}")
                else:
                    lines.append(f"{event} command {handler.get('command')}")
    return lines


def plan_trial(manifest: manifest_module.Manifest, trial: schedule.Trial, out: Path, source: Any = None) -> dict[str, Any]:
    """Build one trial's roots and launch exactly as `runner.run_trial` does, then stop."""
    task = next(item for item in manifest.tasks if item["id"] == trial.task_id)
    arm = next(item for item in manifest.arms if item["id"] == trial.arm_id)
    spec = executor.lookup(arm["executor"])
    # The roots are built as the run builds them, short of the vendored
    # toolchain: a dry run extracts nothing and starts nothing, so it states
    # the platform verdict alone and leaves the node probe to the live run.
    roots = artifact.create(out, trial.trial_id, manifest.fixture_path(task))
    vendor = manifest.vendor_for(task)
    host = vendor_module.host_facts(probe_node=False)
    provision = None
    if arm.get("provision") and spec.prepare is not None:
        # A dry run seeds the data dir and resolves the template with a port of
        # 0 and a labelled token; it starts no daemon.
        provision = spec.prepare(executor.ProvisionRequest(trial.trial_id, roots, arm, source or tenjin_arm.dry_source(), dry_run=True))
    launch = spec.launch(executor.LaunchRequest(trial.trial_id, roots, task, arm, manifest.pins, provision))
    settings = arm.get("settings") or {}
    resolved = json.loads((roots.base / "settings.json").read_text(encoding="utf-8")) if launch.resolved_settings_hash else settings
    return {
        "trial_id": trial.trial_id,
        "task_id": trial.task_id,
        "arm_id": trial.arm_id,
        "repeat": trial.repeat,
        "argv": list(launch.argv),
        "provision": None if provision is None else {**provision.facts, "origins": list(provision.origins)},
        "vendor": None if vendor is None else {**vendor.facts, "host": host, "host_matches": vendor_module.matches(vendor, host)},
        "hooks": describe_hooks(resolved),
        "roots": {
            "cwd": str(launch.cwd),
            "home": str(roots.home),
            # The profile is `CLAUDE_CONFIG_DIR`, and the transcript directory
            # hangs off it, so a reviewer can see the two agree.
            "profile": str(roots.profile),
            "data": str(roots.data_dir),
            "output": str(roots.output),
            "sessions": str(spec.sessions(roots, launch.root_session_id)),
        },
        "environment": sorted(launch.env or {}),
        # The arm's settings file is a second environment channel into the
        # same process, so the dry run names those variables too.
        "settings_env": sorted(settings.get("env") or {}),
        "settings_hooks": sorted(settings.get("hooks") or {}),
    }


def render_plan(manifest: manifest_module.Manifest, plans: list[dict[str, Any]]) -> str:
    """One block per trial, with the argv on a single copyable line."""
    lines = [
        f"live-run dry run: {len(plans)} trials from {manifest.path}",
        "nothing was started: --dry-run stops before the spawn.",
        "env names the child allowlist and prints no value; the credential seam "
        "variable is on that line only when this shell has it set.",
        "arm env and arm hooks name what the arm's own settings file adds to "
        "that process, again without values.",
    ]
    for index, plan in enumerate(plans, start=1):
        lines.append("")
        lines.append(
            f"trial {index}/{len(plans)} {plan['trial_id']} "
            f"task={plan['task_id']} arm={plan['arm_id']} repeat={plan['repeat']}"
        )
        for name, value in plan["roots"].items():
            lines.append(f"  {name:10}{value}")
        lines.append(f"  {'env':10}{' '.join(plan['environment'])}")
        lines.append(f"  {'arm env':10}{' '.join(plan['settings_env']) or '(none)'}")
        lines.append(f"  {'arm hooks':10}{' '.join(plan['settings_hooks']) or '(none)'}")
        for hook in plan["hooks"]:
            lines.append(f"  {'hook':10}{hook}")
        if plan["provision"] is not None:
            facts = plan["provision"]
            lines.append(
                f"  {'provision':10}shelf_secret_present={str(facts['shelf_secret_present']).lower()} "
                f"shelf_origin={facts['shelf_origin']} public_origin={facts['public_origin']}"
            )
        if plan["vendor"] is not None:
            facts = plan["vendor"]
            verdict = "extracted into repo/node_modules at trial preparation" if facts["host_matches"] else "MISMATCH: live-run refuses this host"
            lines.append(
                f"  {'vendor':10}{facts['id']} platform={facts['platform']} node_abi={facts['node_abi']} "
                f"host={facts['host']['platform']} {verdict}"
            )
        lines.append(f"  {'argv':10}{shlex.join(plan['argv'])}")
    return "\n".join(lines)


def refuse_foreign_vendor(manifest: manifest_module.Manifest, environ: Mapping[str, str]) -> None:
    """A vendored toolchain built for another platform is refused before any root exists."""
    vendors = [(task, manifest.vendor_for(task)) for task in manifest.tasks]
    if not any(vendor is not None for _task, vendor in vendors):
        return
    host = vendor_module.host_facts(environ)
    for task, vendor in vendors:
        if vendor is None:
            continue
        try:
            vendor_module.check_platform(vendor, host)
        except vendor_module.VendorError as error:
            raise CliError(f"task {task['id']!r}: {error.detail}") from error


def live_run(
    out: Path,
    manifest_path: Path = SMOKE_MANIFEST,
    attestation_path: Path | None = None,
    *,
    dry_run: bool = False,
    plumbing: bool = False,
    ci_live: bool = False,
    environ: Mapping[str, str] | None = None,
    stream: Any = None,
    runtime: runner.Runtime | None = None,
    tenjin_source: Path | None = None,
) -> dict[str, Any]:
    environ = os.environ if environ is None else environ
    # The product compares data dir strings, so every root has to be spelled
    # absolutely and the same way in every process.
    out = Path(os.path.abspath(out))
    manifest = manifest_module.load(manifest_path)
    spec = require_executor(manifest, live=True)
    trials = schedule.expand(manifest)
    provisioned = provisioned_arms(manifest)
    if ci_live and provisioned:
        raise CliError(f"--ci-live refuses a manifest that provisions an arm ({', '.join(provisioned)}): the live lane is smoke-only")
    if tenjin_source is not None and not provisioned:
        raise CliError("--tenjin-source is for a manifest with a provisioned arm; this one has none")
    source = None if tenjin_source is None else tenjin_arm.load_source(tenjin_source)
    if dry_run:
        plans = [plan_trial(manifest, trial, out, source) for trial in trials]
        (stream or sys.stdout).write(render_plan(manifest, plans) + "\n")
        return {"dry_run": True, "trials": plans}
    if provisioned and source is None:
        raise CliError(f"arm {provisioned[0]!r} is provisioned: live-run needs --tenjin-source <data dir>")
    if source is not None and source.shelf_secret_present and attestation_path is not None:
        raise CliError("--attestation refuses a source that carries shelfBypassSecret: a run that seeds a team shelf secret is never publishable, run it with --plumbing")
    if ci_live and not plumbing:
        raise CliError("--ci-live is valid only with --plumbing: an automated live run is never publishable")
    if ci_live and attestation_path is not None:
        raise CliError("--ci-live refuses --attestation: an automated live run claims no isolation")
    automation = [name for name in AUTOMATION_ENV if environ.get(name)]
    if automation and not ci_live:
        raise CliError(f"live-run refuses an automated environment: {', '.join(automation)} is set")
    if attestation_path is None and not plumbing:
        raise CliError(
            "live-run requires --attestation, or --plumbing for a non-publishable smoke: "
            "a publishable live run states the isolation it ran under"
        )
    refuse_foreign_vendor(manifest, environ)
    seam = None if spec.credential_seam is None else spec.credential_seam(manifest.pins)
    # A run launched from a shell without the credential would spend the
    # wall-clock cap on attempts that cannot reach the provider.
    if seam is not None and not environ.get(seam):
        raise CliError(f"live-run needs the credential seam {seam} set in this shell")
    attestation = None if attestation_path is None else artifact.load_attestation(attestation_path)
    # The gates stay code-owned: an injected runtime supplies the clock, the
    # settlement barrier, or the process seam, never the isolation contract.
    # `--plumbing` buys one thing and states its price: a run with no attestation
    # is stamped non-publishable in every record, so gate 3 can prove the chain
    # end to end on a host that is not a disposable instance, and no number from
    # it can be quoted as a result.
    runtime = dataclasses.replace(
        runtime or runner.Runtime(),
        attestation=attestation,
        publishable=not plumbing,
        ci=bool(automation),
        automated=ci_live,
        source=source,
    )
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


def do_regress(run_dir: Path, baseline_path: Path, environ: Mapping[str, str] | None = None, stream: Any = None) -> dict[str, Any]:
    """Warn where the run is worse than the committed baseline. Never a failure."""
    manifest, digest = load_run(run_dir)
    accepted, _ = records.select(run_dir / "records", manifest.hash, digest)
    published = json.loads((run_dir / "report.json").read_text(encoding="utf-8"))
    return regress_module.check(published, accepted, baseline_path, environ, stream)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python3 -m evals.benchmark.cli")
    commands = parser.add_subparsers(dest="command", required=True)
    fake = commands.add_parser("fake-run", help="run the fake manifest end to end, offline")
    fake.add_argument("--out", required=True, type=Path)
    live = commands.add_parser("live-run", help="operator only: run a live manifest, or print what it would run")
    live.add_argument("--manifest", required=True, type=Path)
    live.add_argument("--out", required=True, type=Path)
    live.add_argument("--attestation", type=Path, help="isolation attestation JSON; required without --dry-run")
    live.add_argument(
        "--plumbing",
        action="store_true",
        help="run without an attestation and stamp every record non-publishable (gate 3 smoke only)",
    )
    live.add_argument(
        "--ci-live",
        action="store_true",
        help="allow an automated environment; only with --plumbing, and every record is stamped automated",
    )
    live.add_argument("--dry-run", action="store_true", help="print each trial's argv and roots, start nothing")
    live.add_argument(
        "--tenjin-source",
        type=Path,
        help="a tenjin data dir whose config keys and hook bundles seed each provisioned arm's trial; never defaulted",
    )
    for name in ("verify", "reduce", "report"):
        commands.add_parser(name).add_argument("--run", required=True, type=Path)
    # `summary` prints a finished report as text instead of JSON. It reads the
    # published projection and computes nothing, so a log can show what a run
    # did without a reader piping JSON through another tool.
    summary = commands.add_parser("summary", help="read a finished run's report.json as text")
    summary.add_argument("--run", required=True, type=Path)
    # Informational by construction: it prints and annotates, and exits 0
    # whatever it finds, so the live lane can warn without ever blocking.
    regress = commands.add_parser("regress", help="warn where a finished run is worse than the committed baseline")
    regress.add_argument("--run", required=True, type=Path)
    regress.add_argument("--baseline", type=Path, default=regress_module.BASELINE)
    # The one supported way to clean up after an interrupted run. It acts on the
    # run's own process ledger and verifies each record against the live process
    # before signalling, so it cannot reach anything this package did not start.
    # Matching a process by name instead, `pkill -f bin/claude` and its
    # relatives, also matches an operator's unrelated sessions; do not.
    cleanup = commands.add_parser("cleanup", help="kill any process this run started and left behind")
    cleanup.add_argument("--run", required=True, type=Path)
    args = parser.parse_args(argv)
    if args.command == "cleanup":
        json.dump(reap_module.reap(args.run), sys.stdout, indent=2, sort_keys=True)
        sys.stdout.write("\n")
        return 0
    if args.command == "summary":
        published = json.loads((args.run / "report.json").read_text(encoding="utf-8"))
        sys.stdout.write(report_module.render(published) + "\n")
        return 0
    if args.command == "regress":
        do_regress(args.run, args.baseline)
        return 0
    if args.command == "live-run":
        try:
            payload = live_run(
                args.out,
                args.manifest,
                args.attestation,
                dry_run=args.dry_run,
                plumbing=args.plumbing,
                ci_live=args.ci_live,
                tenjin_source=args.tenjin_source,
            )
        except (CliError, executor.ProvisionError) as error:
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
