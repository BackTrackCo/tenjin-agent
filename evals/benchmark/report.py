"""Publishable projection and its redaction guard.

The report carries counts, enums, opaque ids, hashes, and reason codes only.
Raw transcripts, model prose, prompts, memory bodies, worktrees, host paths,
and credentials are private inputs and stay in the run directory.

The guard is structural rather than a blocklist of known leaks. A publishable
string is a SHA-256 token or an opaque token of at most 64 characters drawn
from `[A-Za-z0-9_.:+-]`, so a path separator, a space, a newline, or a quote
is a refusal by construction: prose, a prompt, a memory body, a transcript
line, and a host path cannot be spelled in that alphabet. Credentials can be,
which is why known secret shapes and the benchmark's own canary are refused by
value on top of it, and why a private-sounding key name is refused before its
value is even read.
"""

from __future__ import annotations

import re
from typing import Any

from . import canonical_json
from .artifact import CANARY_PREFIX

REPORT_SCHEMA = "bench1.report.v1"
# How a run was isolated, weakest first. A report takes the weakest kind any
# accepted record carries, so one plumbing record marks the whole run.
ISOLATION_KINDS = ("team_shelf_secret", "automated_plumbing", "operator_plumbing", "attested", "fake")
MAX_TOKEN = 64
OPAQUE = re.compile(r"^[A-Za-z0-9_.:+-]{0,%d}$" % MAX_TOKEN)
HASH = re.compile(r"^(?:sha256:)?[0-9a-f]{64}$")
SEPARATORS = ("/", "\\")
FORBIDDEN_KEYS = frozenset(
    {
        "answer",
        "apikey",
        "api_key",
        "argv",
        "body",
        "content",
        "credential",
        "cwd",
        "detail",
        "env",
        "home",
        "injected_text",
        "memory",
        "message",
        "note",
        "notes",
        "output",
        "path",
        "paths",
        "private_hashes",
        "profile",
        "prompt",
        "prompts",
        "question",
        "repo",
        "secret",
        "stderr",
        "stdout",
        "text",
        "title",
        "token",
        "transcript",
        "url",
    }
)
CREDENTIAL = re.compile(
    r"(?:^sk-[A-Za-z0-9_-]{6,}"
    r"|^ghp_[A-Za-z0-9]{6,}"
    r"|^github_pat_[A-Za-z0-9_]{6,}"
    r"|^AKIA[0-9A-Z]{6,}"
    r"|^xox[abprs]-[A-Za-z0-9-]{6,}"
    r"|^AIza[A-Za-z0-9_-]{10,}"
    r"|^eyJ[A-Za-z0-9_-]{10,}\."
    r"|BEGIN [A-Z ]*PRIVATE KEY"
    r"|" + re.escape(CANARY_PREFIX) + r")"
)


class ReportError(ValueError):
    def __init__(self, code: str, trail: str, detail: str) -> None:
        super().__init__(f"{code} at {trail}: {detail}")
        self.code = code
        self.trail = trail


def guard(value: Any, trail: str = "report") -> None:
    """Refuse anything that is not a count, an enum, an opaque id, or a hash."""
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str):
                raise ReportError("bad_key", trail, "keys must be strings")
            if key.lower() in FORBIDDEN_KEYS:
                raise ReportError("private_field", f"{trail}.{key}", "the field itself is private")
            guard(item, f"{trail}.{key}")
    elif isinstance(value, list):
        for index, item in enumerate(value):
            guard(item, f"{trail}[{index}]")
    elif isinstance(value, str):
        _guard_string(value, trail)
    elif value is not None and not isinstance(value, (int, float, bool)):
        raise ReportError("unpublishable_type", trail, f"{type(value).__name__} is not publishable")


def _guard_string(value: str, trail: str) -> None:
    if HASH.match(value):
        return
    if CREDENTIAL.search(value):
        raise ReportError("credential", trail, "the value has the shape of a credential")
    if any(separator in value for separator in SEPARATORS) or value.startswith("~"):
        raise ReportError("host_path", trail, "the value looks like a filesystem path")
    if not OPAQUE.match(value):
        raise ReportError("not_opaque", trail, f"only {MAX_TOKEN} characters of [A-Za-z0-9_.:+-] are publishable")


def isolation_kind(record: dict[str, Any]) -> str:
    isolation = record["isolation"]
    if isolation.get("shelf_secret_present", False):
        return "team_shelf_secret"
    if not isolation["live"]:
        return "fake"
    if isolation["attested_container"]:
        return "attested"
    return "automated_plumbing" if isolation.get("automated", False) else "operator_plumbing"


def corpus_stamp(accepted: dict[str, dict[str, Any]]) -> dict[str, Any] | None:
    """The one corpus every accepted attempt measured, or a refusal.

    Attempts against different corpora are not comparable, so a mixed run is
    refused as a unit rather than published with the difference left out.
    """
    if not accepted:
        return None
    stamps = {canonical_json(record["isolation"].get("corpus")) for record in accepted.values()}
    if len(stamps) > 1:
        raise ReportError("corpus_mixed", "report.corpus", "the accepted attempts measured more than one corpus")
    return next(iter(accepted.values()))["isolation"].get("corpus")


def stamp(accepted: dict[str, dict[str, Any]]) -> tuple[bool, str]:
    """`(publishable, isolation kind)` for the run: one non-publishable record decides."""
    publishable = bool(accepted) and all(record["isolation"]["publishable"] for record in accepted.values())
    kinds = {isolation_kind(record) for record in accepted.values()}
    kind = next((name for name in ISOLATION_KINDS if name in kinds), "fake")
    return publishable, kind


def project(
    manifest_data: dict[str, Any],
    manifest_hash: str,
    schedule_hash: str,
    reduction: dict[str, Any],
    accepted: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    """The whole publishable artifact, refused as a unit if anything private rides along."""
    excluded: dict[str, int] = {}
    for item in reduction["excluded"]:
        reason = item["reason"].split(":", 1)[0]
        excluded[reason] = excluded.get(reason, 0) + 1
    publishable, kind = stamp(accepted)
    # The delivery legs by origin, summed over the accepted attempts, so the
    # plan's canary gate reads as two separate counts: requests to an origin
    # outside the known set, and legs the public marketplace answered.
    origins = {"public_legs": 0, "public_hits": 0, "public_timeouts": 0, "other_requests": 0}
    for record in accepted.values():
        public = record["delivery"].get("public", {})
        origins["public_legs"] += public.get("legs", 0)
        origins["public_hits"] += public.get("hits", 0)
        origins["public_timeouts"] += public.get("timeouts", 0)
        origins["other_requests"] += record["delivery"].get("classes", {}).get("other", 0)
    # The seeded pieces: how many trials wrote one to the team shelf, and how
    # many left it there because the delete failed, which the summary warns on.
    seeds = {"published": 0, "not_deleted": 0}
    for record in accepted.values():
        for seed in record["isolation"].get("seed") or []:
            if seed.get("published"):
                seeds["published"] += 1
                if seed.get("deleted") is not True:
                    seeds["not_deleted"] += 1
    # The failure path per arm: which lane keyed the failure fire, whether the
    # keys leg hit, whether the reporter's artifact existed, what was delivered.
    failure_keys: dict[str, dict[str, Any]] = {}
    for record in accepted.values():
        key = record["delivery"].get("failure_key")
        row = failure_keys.setdefault(record["arm_id"], {"attempts": 0, "keyed": 0, "lanes": {}, "keys_leg_hits": 0, "report_files": 0, "delivered": 0})
        row["attempts"] += 1
        if key is None:
            continue
        row["keyed"] += 1
        lane = key.get("lane") or "unknown"
        row["lanes"][lane] = row["lanes"].get(lane, 0) + 1
        row["keys_leg_hits"] += int(bool(key.get("keys_leg_hit")))
        row["report_files"] += int(key.get("report_file_present") is True)
        row["delivered"] += int(key.get("delivered_piece_id") is not None)
    # Discovery per arm: attempts that ran the test (and saw it fail) before
    # editing the source, and attempts that read the injected setup file.
    found: dict[str, dict[str, int]] = {}
    for record in accepted.values():
        row = found.setdefault(record["arm_id"], {"attempts": 0, "test_run_before_fix": 0, "setup_read": 0})
        facts = record.get("discovery")
        if not isinstance(facts, dict):
            continue
        row["attempts"] += 1
        row["test_run_before_fix"] += int(bool(facts.get("test_run_before_fix")))
        row["setup_read"] += int(bool(facts.get("setup_read")))
    report = {
        "schema": REPORT_SCHEMA,
        "benchmark_version": manifest_data["benchmark_version"],
        "price_sheet_version": manifest_data["price_sheet_version"],
        "manifest_hash": manifest_hash,
        "schedule_hash": schedule_hash,
        "seed": manifest_data["seed"],
        "repeats": manifest_data["repeats"],
        # Every record carries this inside `environment_hash`, which is the
        # hash of the pins. Stating it here is the same fact in the form a
        # reader comparing two runs can act on without opening a record.
        "concurrency": int(manifest_data["pins"].get("concurrency", 1)),
        "publishable": publishable,
        "isolation": kind,
        "shelf_secret_present": any(record["isolation"].get("shelf_secret_present", False) for record in accepted.values()),
        # Who started the run, stated rather than judged: an attested run is
        # publishable whether a person or a schedule launched it, and a reader
        # is entitled to know which.
        "automated": any(record["isolation"].get("automated", False) for record in accepted.values()),
        "corpus": corpus_stamp(accepted),
        "baseline": reduction["baseline"],
        "arms": reduction["arms"],
        # A headline needs complete accounting and a publishable run; the
        # reducer knows the first and only the records know the second.
        "comparisons": {
            arm_id: {**comparison, "headline_eligible": comparison["headline_eligible"] and publishable}
            for arm_id, comparison in reduction["comparisons"].items()
        },
        "invalid": reduction["invalid"],
        "excluded": excluded,
        "origins": origins,
        "seeds": seeds,
        "failure_keys": failure_keys,
        "discovery": found,
        "trials": [
            {
                "trial_id": record["trial_id"],
                "task_id": record["task_id"],
                "arm_id": record["arm_id"],
                "outcome": record["outcome"],
                "invalid_reason": record["invalid_reason"],
                "stop_reason": record["stop_reason"],
                "actors": len(record.get("actors", [])),
                "requests": len(record["usage"]),
                "auxiliary_receipts": len(record["auxiliary"]),
                "tokens": sum(item["input_total"] + item["output_total"] for item in record["usage"]),
                "sentinel_hits": sum(record["sentinel"].values()),
                "public_legs": record["delivery"].get("public", {}).get("legs", 0),
                "public_hits": record["delivery"].get("public", {}).get("hits", 0),
                "other_requests": record["delivery"].get("classes", {}).get("other", 0),
            }
            for record in sorted(accepted.values(), key=lambda item: item["position"])
        ],
    }
    guard(report)
    return report


def _number(value: float | None, spec: str) -> str:
    """A float under its format, or `none` right-aligned to the same width."""
    if value is None:
        width = int(spec.split(".", 1)[0])
        return "none".rjust(width)
    return format(value, spec)


def plural(count: int, noun: str) -> str:
    return f"{count} {noun}" if count == 1 else f"{count} {noun}s"


def render(report: dict[str, Any]) -> str:
    """A finished report as text, for a log or a step summary.

    The projection is the artifact; this is only a reading of it. It adds no
    number the reducer did not compute, and it prints every arm rather than the
    winner, because a reader who sees one arm cannot tell a result from a claim.
    """
    baseline = report["baseline"]
    labels = {arm_id: f"{arm_id} (baseline)" if arm_id == baseline else arm_id for arm_id in report["arms"]}
    width = max([len(label) for label in labels.values()] + [len("arm")])
    stamp_line = (
        f"isolation {report['isolation']}, publishable"
        if report["publishable"]
        else f"isolation {report['isolation']}: NOT PUBLISHABLE, plumbing evidence only, no number here is a result"
    )
    if report.get("automated", False):
        stamp_line += ", automated: no person watched this run"
    lines = [
        f"benchmark {report['benchmark_version']}, schema {report['schema']}",
        f"manifest {report['manifest_hash'][:12]}  schedule {report['schedule_hash'][:12]}  "
        f"seed {report['seed']}  repeats {report['repeats']}  concurrency {report.get('concurrency', 1)}",
        stamp_line,
    ]
    if report.get("shelf_secret_present", False):
        lines.append("team shelf secret present: NOT PUBLISHABLE, the arm ran against a private shelf this run cannot vouch for")
    corpus = report.get("corpus")
    if corpus:
        lines.append(
            f"corpus {corpus['provider']} project {corpus['project_id']} branch {corpus['branch_id']} "
            f"reset from {corpus['parent_id']} at {corpus['reset_at']}, serving {corpus['origin']}"
        )
    lines += [
        "",
        f"{'arm'.ljust(width)} {'attempts':>8s} {'passes':>7s} {'pass rate':>9s} {'tokens':>10s} "
        f"{'per attempt':>12s} {'accounting':>12s}",
    ]
    for arm_id, arm in sorted(report["arms"].items()):
        # An arm whose every attempt was invalid has no scored cell, so its
        # rate and mean are null; the row says so instead of failing to print.
        lines.append(
            f"{labels[arm_id].ljust(width)} {arm['attempts']:8d} {arm['outcomes']['pass']:7d} "
            f"{_number(arm['pass_rate'], '9.3f')} {arm['tokens']:10d} {_number(arm['tokens_per_attempt'], '12.1f')} "
            f"{arm['accounting']:>12s}"
        )
    lines.append("")
    for arm_id, row in sorted((report.get("discovery") or {}).items()):
        if row["attempts"]:
            lines.append(f"discovery {arm_id}: ran the test before the fix {row['test_run_before_fix']}/{row['attempts']}, read the setup file {row['setup_read']}/{row['attempts']}")
    for arm_id, row in sorted((report.get("failure_keys") or {}).items()):
        if not row["keyed"]:
            continue
        lanes = ", ".join(f"{lane} x{count}" for lane, count in sorted(row["lanes"].items()))
        lines.append(
            f"failure key {arm_id}: keyed {row['keyed']}/{row['attempts']} ({lanes}), keys leg hit {row['keys_leg_hits']}, "
            f"report file {row['report_files']}, delivered {row['delivered']}"
        )
    seeds = report.get("seeds")
    if seeds is not None and seeds["published"]:
        lines.append(f"seeded pieces: {seeds['published']} published to the team shelf, {seeds['published'] - seeds['not_deleted']} deleted")
        if seeds["not_deleted"]:
            lines.append(f"WARNING: {seeds['not_deleted']} seeded piece(s) still on the team shelf: delete them by hand (isolation.seed.piece_id in the records)")
    origins = report.get("origins")
    if origins is not None:
        lines.append(
            f"public legs: {origins['public_legs']}, hits: {origins['public_hits']}, "
            f"timeouts: {origins['public_timeouts']}; requests to an unknown origin: {origins['other_requests']}"
        )
    if report["comparisons"]:
        lines.append(f"token ratio versus {baseline}, 1.0 means no change, lower means fewer tokens:")
        for arm_id, comparison in sorted(report["comparisons"].items()):
            ratio = comparison["token_ratio"]
            if ratio is None:
                lines.append(f"  {arm_id}: none ({comparison['token_ratio_reason']})")
                continue
            interval = comparison["interval"]
            eligible = "headline eligible" if comparison["headline_eligible"] else "NOT headline eligible"
            lines.append(
                f"  {arm_id}: {ratio:.3f}  interval [{interval['low']:.3f}, {interval['high']:.3f}] "
                f"at {interval['confidence']:.0%} over {plural(interval['tasks'], 'task')}, {eligible}"
            )
    else:
        lines.append(f"no comparison: {baseline} is the only arm with a result")
    outcomes: dict[str, int] = {}
    for trial in report["trials"]:
        outcomes[trial["outcome"]] = outcomes.get(trial["outcome"], 0) + 1
    lines += [
        "",
        f"{len(report['trials'])} attempts: " + ", ".join(f"{count} {name}" for name, count in sorted(outcomes.items())),
        f"{len(report['invalid'])} invalid, {plural(len(report['excluded']), 'record file')} excluded",
    ]
    return "\n".join(lines)
