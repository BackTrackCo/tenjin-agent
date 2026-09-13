"""Informational regression check: a finished run against an explicitly selected baseline.

The baseline is a document of comparison figures, never a result:
per arm, how many attempts passed and what an attempt cost in tokens and in
USD the last time an operator ran the smoke. `findings` names each way the
run is worse (pass rate down, tokens or cost up by more than the tolerance,
any invalid attempt, any excluded record), and `emit` prints them, annotates
them under GitHub Actions, and always leaves the exit code alone. A warning
is the whole product; blocking is the required lane's job.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any, Mapping

from . import sha256_json

BASELINE_SCHEMA = "bench1.baseline.v1"
ARM_KEYS = frozenset({"attempts", "pass", "mean_tokens", "mean_cost_usd"})
TITLE = "benchmark regression"


class BaselineError(ValueError):
    pass


def load_baseline(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise BaselineError(f"cannot read the baseline: {error}") from error
    if not isinstance(data, dict) or data.get("schema") != BASELINE_SCHEMA:
        raise BaselineError(f"the baseline must be a {BASELINE_SCHEMA} object")
    for name in ("date", "source"):
        if not isinstance(data.get(name), str) or not data[name]:
            raise BaselineError(f"baseline {name} must be a non-empty string")
    tolerance = data.get("tolerance")
    if isinstance(tolerance, bool) or not isinstance(tolerance, (int, float)) or not 0 <= tolerance < 1:
        raise BaselineError("baseline tolerance must be a fraction in [0, 1)")
    arms = data.get("arms")
    if not isinstance(arms, dict) or not arms:
        raise BaselineError("baseline arms must be a non-empty object")
    for arm_id, arm in arms.items():
        if not isinstance(arm, dict) or set(arm) != ARM_KEYS:
            raise BaselineError(f"baseline arm {arm_id!r} must carry exactly {', '.join(sorted(ARM_KEYS))}")
        for name in ARM_KEYS:
            value = arm[name]
            if isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0:
                raise BaselineError(f"baseline arm {arm_id!r} {name} must be a non-negative number")
        if arm["attempts"] == 0 or arm["pass"] > arm["attempts"]:
            raise BaselineError(f"baseline arm {arm_id!r} needs attempts >= 1 and pass <= attempts")
    return data


def observe(report: dict[str, Any], accepted: Mapping[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Per-arm figures in the baseline's own terms, read from the report and the records.

    Pass rate and tokens per attempt are the reducer's, so this check cannot
    drift from what `summary` prints. Cost is not in the projection, so it is
    the mean of `cost_usd` over the arm's scored records, null when none of
    them carries one.
    """
    observed: dict[str, dict[str, Any]] = {}
    for arm_id, arm in report["arms"].items():
        costs = [record["cost_usd"] for record in accepted.values() if record["arm_id"] == arm_id and record["outcome"] != "invalid" and record["cost_usd"] is not None]
        observed[arm_id] = {
            "attempts": arm["attempts"],
            "pass": arm["outcomes"]["pass"],
            "pass_rate": arm["pass_rate"],
            "tokens_per_attempt": arm["tokens_per_attempt"],
            "mean_cost_usd": None if not costs else sum(costs) / len(costs),
        }
    return observed


def _above(value: float | None, base: float, tolerance: float) -> bool:
    return value is not None and value > base * (1 + tolerance)


def findings(report: dict[str, Any], observed: dict[str, dict[str, Any]], baseline: dict[str, Any]) -> list[str]:
    tolerance = float(baseline["tolerance"])
    percent = f"{tolerance:.0%}"
    found: list[str] = []
    for arm_id, base in baseline["arms"].items():
        arm = observed.get(arm_id)
        if arm is None:
            found.append(f"arm {arm_id}: no accepted attempt in this run, baseline had {base['attempts']}")
            continue
        base_rate = base["pass"] / base["attempts"]
        if arm["pass_rate"] is None:
            found.append(f"arm {arm_id}: no scored attempt, baseline pass rate {base_rate:.3f}")
        elif arm["pass_rate"] < base_rate:
            found.append(f"arm {arm_id}: pass rate {arm['pass_rate']:.3f} below baseline {base_rate:.3f}")
        if _above(arm["tokens_per_attempt"], base["mean_tokens"], tolerance):
            found.append(
                f"arm {arm_id}: {arm['tokens_per_attempt']:.1f} tokens per attempt, "
                f"above baseline {base['mean_tokens']} by more than {percent}"
            )
        if _above(arm["mean_cost_usd"], base["mean_cost_usd"], tolerance):
            found.append(
                f"arm {arm_id}: {arm['mean_cost_usd']:.4f} USD per attempt, "
                f"above baseline {base['mean_cost_usd']:.4f} by more than {percent}"
            )
    for arm_id in sorted(set(observed) - set(baseline["arms"])):
        found.append(f"arm {arm_id}: no baseline entry")
    invalid = len(report["invalid"])
    if invalid:
        found.append(f"{invalid} invalid attempt{'s' if invalid != 1 else ''}")
    excluded = sum(report["excluded"].values())
    if excluded:
        found.append(f"{excluded} record file{'s' if excluded != 1 else ''} excluded")
    return found


def render(found: list[str], baseline: dict[str, Any], report: dict[str, Any]) -> str:
    label = f"baseline {baseline['date']} ({baseline['source']})"
    lines = [
        f"regress: run {report['manifest_hash'][:12]} against {label}, tolerance {float(baseline['tolerance']):.0%}",
    ]
    if not found:
        lines.append(f"no regression against {label}")
    lines += [f"regression: {item}" for item in found]
    return "\n".join(lines)


def emit(text: str, found: list[str], environ: Mapping[str, str], stream: Any = None) -> None:
    """Print, then under GitHub Actions annotate each finding and append to the step summary."""
    stream = sys.stdout if stream is None else stream
    stream.write(text + "\n")
    if not environ.get("GITHUB_ACTIONS"):
        return
    for item in found:
        stream.write(f"::warning title={TITLE}::{item}\n")
    summary = environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        heading = "## Bench-1 regression check: " + ("regressions found" if found else "clean")
        with Path(summary).open("a", encoding="utf-8") as handle:
            handle.write(f"{heading}\n\n```text\n{text}\n```\n")


def check(
    report: dict[str, Any],
    accepted: Mapping[str, dict[str, Any]],
    baseline_path: Path,
    environ: Mapping[str, str] | None = None,
    stream: Any = None,
) -> dict[str, Any]:
    baseline = load_baseline(baseline_path)
    observed = observe(report, accepted)
    found = findings(report, observed, baseline)
    emit(render(found, baseline, report), found, os.environ if environ is None else environ, stream)
    return {"baseline": baseline["date"], "findings": found, "observed": observed}


def protocol_hash(manifest: dict[str, Any], *, harness_update: bool = False) -> str:
    """Freeze measurement inputs while allowing the tested product revision to change.

    Runtime product/image commit receipts are not manifest inputs. Explicit
    product version labels are excluded too; model/toolchain pins stay fixed.
    """
    data = {**manifest, "measurement_method": "completion-v2-agent-clock-capture-reuse1", "arms": [{key: value for key, value in arm.items() if key != "product_version"}
                               for arm in manifest.get("arms", [])]}
    if harness_update:
        data["pins"] = {key: value for key, value in manifest.get("pins", {}).items() if key not in {"harness_version", "harness_integrity"}}
    return sha256_json(data)


def compare_harness_updates(current: dict[str, Any], baseline: dict[str, Any]) -> dict[str, Any]:
    """Release-to-release signal, never a causal claim or product baseline."""
    key = "harness_update_protocol_hash"
    if not current.get(key) or current[key] != baseline.get(key):
        return {"status": "unavailable", "reason": "different or missing harness update protocol", "rows": [], "findings": []}
    configs = [item.get("run_configuration", {}) for item in (baseline, current)]
    versions = [item.get("harness_version") for item in configs]
    if not all(versions):
        return {"status": "unavailable", "reason": "missing harness versions", "rows": [], "findings": []}
    if versions[0] == versions[1]:
        return {"status": "not changed", "reason": "Latest matching main run uses the same harness version.", "rows": [], "findings": []}
    # Reuse all coverage/invalid/accounting checks; replace only the protocol identity.
    result = compare_reports({**current, "regression_protocol_hash": current[key]},
                             {**baseline, "regression_protocol_hash": baseline[key]})
    commits = [item.get("product_commits") for item in configs]
    servers = [(item.get("server_revision") or {}).get("deployment_id") for item in (baseline, current)]
    matched = bool(commits[0] and commits[0] == commits[1] and servers[0] and servers[0] == servers[1])
    return {**result, "harness_versions": {"main": versions[0], "current": versions[1]},
            "product_commits": {"main": commits[0], "current": commits[1]},
            "server_deployments": {"main": servers[0], "current": servers[1]},
            "attribution": "recorded product/server identities match; causal attribution still requires a matched replay" if matched else "mixed or unknown product/server identities; cannot attribute this delta to the harness",
            "comparison": "harness update diagnostic"}


COMPLETION_METRICS = ("pass_rate", "consumer_seconds_per_verified_resolution", "tokens_per_verified_resolution")


def compare_reports(current: dict[str, Any], baseline: dict[str, Any], tolerance: float = 0.25) -> dict[str, Any]:
    """Compare matching complete runs; missing evidence never becomes a clean result."""
    if not 0 <= tolerance < 1:
        raise BaselineError("tolerance must be a fraction in [0, 1)")
    for key in ("schema", "regression_protocol_hash", "isolation", "automated"):
        if key not in current or current[key] != baseline.get(key):
            return {"status": "unavailable", "reason": f"different or missing {key}", "rows": [], "findings": []}
    for name, report in (("current", current), ("main", baseline)):
        configuration = report.get("run_configuration", {})
        planned = configuration.get("planned_per_arm", 0)
        arms = report.get("arms", {})
        if not planned or not arms or set(arms) != set(configuration.get("arm_ids", [])):
            return {"status": "unavailable", "reason": f"{name} run lacks planned coverage", "rows": [], "findings": []}
        if report.get("invalid") or report.get("excluded") or any(
            arm.get("attempts") != planned or arm.get("outcomes", {}).get("interrupted", 0)
            or arm.get("outcomes", {}).get("invalid", 0) or arm.get("accounting") != "complete"
            for arm in arms.values()
        ):
            return {"status": "unavailable", "reason": f"{name} run incomplete or invalid", "rows": [], "findings": []}
    rows, found = [], []
    for arm_id, arm in current["arms"].items():
        for metric in COMPLETION_METRICS:
            now, before = arm.get(metric), baseline["arms"].get(arm_id, {}).get(metric)
            rows.append({"arm": arm_id, "metric": metric, "main": before, "current": now})
            if now is None or before is None:
                continue
            worse = now < before if metric == "pass_rate" else now > before * (1 + tolerance)
            if worse:
                found.append(f"{arm_id}: {metric} {now:.3g} vs main {before:.3g}")
    return {"status": "regressions found" if found else "compared", "rows": rows, "findings": found}
