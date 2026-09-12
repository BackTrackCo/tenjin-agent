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

import json

import re
from typing import Any

from . import canonical_json, regress
from .artifact import CANARY_PREFIX
from .reduce import consumer_auxiliary

REPORT_SCHEMA = "bench1.report.v1"
# The pre-registered headline: the capture-only amortized ratio at reuse 1, every
# token the capture ask added charged to a single consumer. The consumer-only
# ratio is the secondary line.
HEADLINE_LABEL = "system tokens per verified completion, capture at reuse 1"
CAPTURE_FREE_LABEL = "capture-free (future: capture on an operator-run model)"
# The as-shipped number is the one to quote as Tenjin. This one takes the
# product's own turn-end nudge and the primer's CLI search out of both arms and
# answers a narrower question; it is a decomposition, and it says so wherever
# it appears.
RETRIEVAL_ONLY_LABEL = "retrieval only, decomposition: the turn-end nudge and the CLI search subtracted from both arms"
# What the headline decomposes into, printed under every ratio and never as
# one: round trips, unique ingestion, and the axis a token ratio never states.
REQUESTS_LABEL = "requests, decomposition: model requests per attempt"
NEW_TOKENS_LABEL = "new tokens, decomposition: uncached input plus cache writes plus output, per attempt"
PASS_DELTA_LABEL = "pass rate delta, the other axis: not a token figure"
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
    if trail == "report.corpus.source_lsn" and re.fullmatch(r"[0-9A-F]+/[0-9A-F]+", value):
        return
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
        epochs = [json.loads(stamp) for stamp in sorted(stamps)]
        # Different reset times are comparable only with the same verified,
        # schedule-bound immutable source revision. Legacy stamps still refuse.
        if (any(not item or not item.get("baseline_id") or not item.get("source_lsn") or not item.get("epoch_id") for item in epochs)
                or len({canonical_json({k: v for k, v in item.items() if k not in {"reset_at", "epoch_id"}}) for item in epochs}) != 1):
            raise ReportError("corpus_mixed", "report.corpus", "the accepted attempts measured more than one corpus")
        return {**epochs[0], "reset_epochs": [{"epoch_id": item["epoch_id"], "reset_at": item["reset_at"]} for item in sorted(epochs, key=lambda item: (item["reset_at"], item["epoch_id"]))]}
    return next(iter(accepted.values()))["isolation"].get("corpus")


def stamp(accepted: dict[str, dict[str, Any]]) -> tuple[bool, str]:
    """`(publishable, isolation kind)` for the run: one non-publishable record decides."""
    publishable = bool(accepted) and all(record["isolation"]["publishable"] for record in accepted.values())
    kinds = {isolation_kind(record) for record in accepted.values()}
    kind = next((name for name in ISOLATION_KINDS if name in kinds), "fake")
    return publishable, kind


def snapshot_fields(taken: dict[str, Any] | None) -> dict[str, Any] | None:
    """What the corpus reading may say in public: counts, a hash, a time, or a refusal code.

    The reading's own `detail` names a host and an exception, which is a private
    string; the run directory keeps it and the report states the code alone.
    """
    if not taken:
        return None
    fields = {key: taken.get(key) for key in ("origin", "posts", "content_hash", "taken_at", "error")}
    return {key: value for key, value in fields.items() if value is not None}


def project(
    manifest_data: dict[str, Any],
    manifest_hash: str,
    schedule_hash: str,
    reduction: dict[str, Any],
    accepted: dict[str, dict[str, Any]],
    corpus_snapshot: dict[str, Any] | None = None,
    server_revision: dict[str, Any] | None = None,
    harness_release: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """The whole publishable artifact, refused as a unit if anything private rides along."""
    excluded: dict[str, int] = {}
    for item in reduction["excluded"]:
        reason = item["reason"].split(":", 1)[0]
        excluded[reason] = excluded.get(reason, 0) + 1
    publishable, kind = stamp(accepted)
    if server_revision is not None and server_revision.get("status") != "stable":
        publishable = False
    # The delivery legs by shelf, summed over the accepted attempts. Every
    # count here comes from the daemon's own ledger, so it says which legs the
    # product recorded, never which requests left the container: the container
    # harness reports no denials, and `unnamed_shelf_legs` is named for what it
    # is rather than dressed up as observed egress.
    origins = {"public_legs": 0, "public_hits": 0, "public_timeouts": 0, "unnamed_shelf_legs": 0}
    for record in accepted.values():
        public = record["delivery"].get("public", {})
        origins["public_legs"] += public.get("legs", 0)
        origins["public_hits"] += public.get("hits", 0)
        origins["public_timeouts"] += public.get("timeouts", 0)
        origins["unnamed_shelf_legs"] += record["delivery"].get("classes", {}).get("other", 0)
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
    # An arm's own configuration, off the records rather than off the manifest,
    # because the record is what the attempt actually ran under. `off` is the
    # one value worth stating: the shelf arms are byte-identical otherwise.
    fallbacks: dict[str, str] = {}
    for record in accepted.values():
        value = record["isolation"].get("public_fallback")
        if value is not None:
            fallbacks[record["arm_id"]] = value
    arms = {
        arm_id: arm if arm_id not in fallbacks else {**arm, "public_fallback": fallbacks[arm_id]}
        for arm_id, arm in reduction["arms"].items()
    }
    report = {
        "schema": REPORT_SCHEMA,
        "server_revision": server_revision,
        "benchmark_version": manifest_data["benchmark_version"],
        "slice": manifest_data.get("slice"),
        "price_sheet_version": manifest_data["price_sheet_version"],
        "run_configuration": {
            "model": manifest_data["pins"].get("model"),
            "harness": manifest_data.get("harness"),
            "harness_version": manifest_data["pins"].get("harness_version"),
            "harness_release": harness_release,
            "effort": manifest_data["pins"].get("effort"),
            "speed_mode_requested": manifest_data["pins"].get("speed_mode", "standard"),
            "planned_per_arm": len(manifest_data["tasks"]) * manifest_data["repeats"],
            "arm_ids": [arm["id"] for arm in manifest_data.get("arms", [])] or sorted(arms),
            "product_commits": sorted({record["isolation"].get("image", {}).get("cli", {}).get("commit") for record in accepted.values() if isinstance(record["isolation"].get("image"), dict) and record["isolation"]["image"].get("cli", {}).get("commit")}),
        },
        "manifest_hash": manifest_hash,
        "regression_protocol_hash": regress.protocol_hash(manifest_data),
        "harness_update_protocol_hash": regress.protocol_hash(manifest_data, harness_update=True),
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
        "corpus_snapshot": snapshot_fields(corpus_snapshot),
        # What the arms above were measured on, one entry per manifest task.
        # A headline is a ratio over this set, so a reader who cannot see the
        # set cannot tell a corpus that is too easy from one that is too small.
        # The per-task figures stay under `arms`; this is the metadata only the
        # manifest holds, and `render` joins the two.
        "corpus_tasks": [
            {
                "task_id": task["id"],
                "family": task["family"],
                "transfer_distance": task["transfer_distance"],
                "verifier": task["verifier"],
                "fixture_hash": task["fixture_hash"],
            }
            for task in manifest_data["tasks"]
        ],
        "baseline": reduction["baseline"],
        "arms": arms,
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
                "agent_time_s": record.get("agent_time_s"),
                "verification_time_s": record.get("verification_time_s"),
                "harness_time_s": record.get("wall_time_s"),
                "actors": len(record.get("actors", [])),
                "requests": len(record["usage"]),
                "auxiliary_receipts": len(record["auxiliary"]),
                # What this attempt spent, by the rule the reducer scores with:
                # native usage plus the consumer-phase auxiliary receipts it
                # caused, capture-phase receipts left out as one-time cost. An
                # invalid attempt keeps the spend it really made, so these rows
                # sum to the arm total only over `outcome != "invalid"`, which
                # is the same set the reducer aggregates. An arm total is
                # `arms[arm].tokens` and is the figure to read instead.
                "tokens": sum(item["input_total"] + item["output_total"] for item in record["usage"]) + consumer_auxiliary(record),
                "credential_exposures": record["sentinel"].get("credential_exposures", 0),
                "public_legs": record["delivery"].get("public", {}).get("legs", 0),
                "public_hits": record["delivery"].get("public", {}).get("hits", 0),
                "unnamed_shelf_legs": record["delivery"].get("classes", {}).get("other", 0),
                "local_hits": sum(1 for leg in record["delivery"].get("legs", []) if leg.get("shelf") == "local" and leg.get("outcome") == "hit"),
                "child_tokens": sum(item["input_total"] + item["output_total"] for item in record["usage"] if item["actor_key"][2] != ""),
                "producer_outcome": None if not isinstance(record["isolation"].get("producer"), dict) else record["isolation"]["producer"].get("outcome"),
                "producer_tokens": None
                if not isinstance(record["isolation"].get("producer"), dict)
                else sum(int(value) for value in record["isolation"]["producer"].get("phase_tokens", {}).values()),
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


def _pair(report: dict[str, Any], arm_id: str, baseline: str | None, field: str, spec: str) -> str:
    """One per-attempt figure for the arm and for the baseline, in that order."""
    arms = report["arms"]
    base = None if baseline is None else arms.get(baseline, {}).get(field)
    return f"{_number(arms[arm_id].get(field), spec)} versus {_number(base, spec)}"


def _decomposition(report: dict[str, Any], arm_id: str, baseline: str | None, comparison: dict[str, Any]) -> list[str]:
    """What the ratios above decompose into: round trips, unique ingestion, and the pass rate.

    Printed under every ratio because the headline is a ratio of token totals,
    and a reader who sees only that cannot tell an arm that sent less from an
    arm that made fewer requests carrying the same replayed preamble.
    """
    requests = comparison.get("request_ratio")
    new_tokens = comparison.get("new_token_ratio")
    delta = comparison.get("pass_rate_delta")
    return [
        f"    {REQUESTS_LABEL}: {_pair(report, arm_id, baseline, 'requests_per_attempt', '7.2f')}, ratio "
        + (f"{requests:.3f}" if requests is not None else f"none ({comparison.get('request_ratio_reason') or 'no shared task'})"),
        f"    {NEW_TOKENS_LABEL}: {_pair(report, arm_id, baseline, 'new_tokens_per_attempt', '10.1f')}, ratio "
        + (f"{new_tokens:.3f}" if new_tokens is not None else f"none ({comparison.get('new_token_ratio_reason') or 'no shared task'})"),
        f"    {PASS_DELTA_LABEL}: " + ("none" if delta is None else f"{delta:+.3f}"),
    ]


# GitHub caps a check run's `output.summary` here. A run that ever approached
# it would be truncated silently by the API, which is a readout that lies about
# its own length, so `check_summary` truncates and says it did.
CHECK_SUMMARY_LIMIT = 65535
METHODOLOGY = "https://github.com/BackTrackCo/tenjin-agent/blob/main/evals/benchmark/README.md"


def run_status(report: dict[str, Any]) -> str:
    server = report.get("server_revision")
    if server and server.get("status") != "stable":
        return "UNAVAILABLE — remote server changed or could not be checked; diagnostic evidence only"
    if report.get("isolation") == "fake":
        return "SYNTHETIC TEST — no product result"
    if not report.get("publishable"):
        return "PLUMBING — not publishable; no product result"
    if any(row.get("invalid_reason") == "provider:rate_limit" for row in report.get("trials", [])):
        return "UNAVAILABLE — model subscription/rate limit; no product result"
    config = report.get("run_configuration") or {}
    expected = config.get("planned_per_arm")
    ids = config.get("arm_ids") or sorted(report.get("arms") or {})
    if not expected or any((report.get("arms", {}).get(arm) or {}).get("attempts") != expected for arm in ids):
        return "INCOMPLETE — planned attempts are missing; no headline"
    if report.get("invalid") or sum(report.get("excluded", {}).values()):
        return "INCOMPLETE — invalid or excluded attempts; no headline"
    if any(arm.get("accounting") != "complete" for arm in report.get("arms", {}).values()):
        return "INCOMPLETE — token accounting is not complete; no headline"
    return "PROVISIONAL MEASUREMENT — not a hardened product claim"


def overview(report: dict[str, Any], *, markdown: bool = False) -> str:
    """Experiment identity and completion-normalized product numbers, before diagnostics."""
    config = report.get("run_configuration") or {}
    arms = report.get("arms") or {}
    ids = config.get("arm_ids") or sorted(arms)
    planned = config.get("planned_per_arm")
    tasks = report.get("corpus_tasks") or []
    recorded = sum(arm.get("attempts", 0) for arm in arms.values())
    expected = "unknown" if not planned else str(planned * len(ids))
    lines = [run_status(report), f"Experiment: {report['benchmark_version']}",
             f"Model: {config.get('model') or 'unknown'} | Harness: {config.get('harness') or 'unknown'} {config.get('harness_version') or ''} | Effort: {config.get('effort') or 'unknown'}",
             f"Speed mode requested: {config.get('speed_mode_requested', 'standard')} | Concurrency: {report.get('concurrency', 1)} | Provider acceptance: not independently observed",
             f"Ran: {recorded}/{expected} attempts | Tasks: {len(tasks)} | Arms: {len(ids)} | Repeats: {report.get('repeats', 'unknown')}",
             "Tasks: " + (", ".join(task["task_id"] for task in tasks) or "unknown"),
             "Control: " + str(report.get("baseline") or "none"), ""]
    release = config.get("harness_release")
    if release:
        lines += [f"Harness release: {release['package']}@{release['version']} | Requested: {release['requested']} | Resolved: {release['resolved_at']}", ""]
    server = report.get("server_revision")
    if server:
        lines += [f"Remote server: {server.get('deployment_id') or 'unknown'} | Observations: {server.get('checks', 0)} | Status: {server.get('status')}",
                  "Deployment observations detect changes; they do not lock the server or prove schema compatibility.", ""]
    columns = ["Arm", "Verified / planned", "Failed / capped / invalid", "Consumer s / completion", "System tokens / completion", "Time vs control", "Tokens vs control"]
    rows = []
    baseline = arms.get(report.get("baseline"), {})
    def display(value: Any, digits: int = 0) -> str:
        return "n/a" if value is None else f"{value:,.{digits}f}"
    def delta(value: Any, base: Any, comparable: bool) -> str:
        if not comparable or value is None or base is None or base <= 0:
            return "n/a"
        pct = (value / base - 1) * 100
        return f"{abs(pct):.1f}% {'lower' if pct < 0 else 'higher' if pct > 0 else 'change'}"
    complete = run_status(report).startswith("PROVISIONAL")
    for arm_id in ids:
        arm = arms.get(arm_id, {})
        outcomes = arm.get("outcomes", {})
        seconds = arm.get("consumer_seconds_per_verified_resolution")
        tokens = arm.get("tokens_per_verified_resolution")
        rows.append([arm_id, f"{outcomes.get('pass', 0)} / {planned or '?'}",
                     f"{outcomes.get('fail', 0)} / {outcomes.get('capped', 0) + outcomes.get('interrupted', 0)} / {outcomes.get('invalid', 0)}",
                     display(seconds, 1), display(tokens),
                     "control" if arm_id == report.get("baseline") else delta(seconds, baseline.get("consumer_seconds_per_verified_resolution"), complete),
                     "control" if arm_id == report.get("baseline") else delta(tokens, baseline.get("tokens_per_verified_resolution"), complete)])
    if markdown:
        lines = [line + "  " for line in lines]
        lines += ["| " + " | ".join(columns) + " |", "| " + " | ".join("---" for _ in columns) + " |"]
        lines += ["| " + " | ".join(row) + " |" for row in rows]
    else:
        widths = [max(len(columns[i]), *(len(row[i]) for row in rows)) for i in range(len(columns))] if rows else [len(c) for c in columns]
        lines += [" | ".join(cell.ljust(width) for cell, width in zip(row, widths)) for row in [columns, *rows]]
    for arm_id in ids:
        producer = arms.get(arm_id, {}).get("producer")
        if producer:
            lines += ["", f"Producer {arm_id}: {producer['passes']}/{producer['attempts']} verified; "
                      f"{producer['captured']} left reusable local pairings; {producer['findings']} capture drafts retained. "
                      "Drafts are not published knowledge or proof of consumer delivery."]
            if producer.get("publication_mode") == "host-assisted":
                lines += [f"Host-assisted publication: {producer['published']} pieces published; {producer['consumers_with_delivery']} consumers received a producer piece through a team hook; {producer['verified_with_delivery']} of those passed. "
                          f"{producer['publication_failed']} publication phases failed; {producer['not_deleted']} pieces lack confirmed cleanup; {producer['publication_time_s']:.1f}s host publication time.",
                          "Publication is performed by the benchmark host. Delivery plus a pass does not establish that the piece was useful; compare completion time/tokens across treatments."]
            else:
                lines += ["Producer publication and attributed team delivery: unavailable in these records."]
    if complete:
        for arm_id, comparison in sorted(report.get("comparisons", {}).items()):
            for key, label in (("completion_time", "Time ratio"), ("completion_tokens", "Token ratio"), ("completion_rate", "Pass-rate difference")):
                interval = comparison.get(key) or {}
                span = (f"95% interval [{interval['low']:.3f}, {interval['high']:.3f}]"
                        if interval.get("low") is not None else f"interval unavailable ({interval.get('reason') or 'no_evidence'})")
                lines.append(f"{arm_id} vs control — {label}: {display(interval.get('point'), 3)}; {span}; {interval.get('tasks', 0)} paired tasks")
    lines += ["", "Per completion = scored consumer spend plus incremental capture allocated at reuse 1 / verified passes within each task, then equal-weighted across tasks; failed and capped work is included.",
              "Consumer time is measured around agent execution, including its tools/hooks; container setup/teardown, producer work and hidden verification are separate. Producer task tokens are excluded; capture amortization at reuse 2/5/10 is secondary.",
              "n/a means no verified completion, missing timing, or an incomplete comparison. Intervals resample paired tasks, never repeated attempts; one-task intervals are unavailable.",
              "Product commit(s): " + (", ".join(config.get("product_commits") or []) or "not recorded")]
    return "\n".join(lines)


def check_summary(report: dict[str, Any], methodology: str = METHODOLOGY, limit: int = CHECK_SUMMARY_LIMIT) -> str:
    """One shared overview for CI checks, step summaries and exported Markdown."""
    head = f"## {report['benchmark_version']}\n\n"
    taken = report.get("corpus_snapshot")
    corpus = "The corpus this run measured was not read."
    if taken and not taken.get("error"):
        corpus = f"Corpus: {taken['posts']} pieces on `{taken['origin']}`, read at {taken['taken_at']}."
    body = overview(report, markdown=True) + "\n\n" + corpus + f"\n\n[Method: evals/benchmark/README.md]({methodology}).\n\n"
    body += "<details><summary>Accounting, phase costs, uncertainty and task details</summary>\n\n```text\n" + render(report, include_overview=False)
    tail = "\n```\n</details>\n"
    room = max(0, limit - len(head) - len(tail))
    if len(body) > room:
        note = "\n[truncated: the whole report is report.json in this run's artifact]"
        # A small custom limit may cut before the details block starts.
        body = body[:max(0, room - len(note))] + note
        if "<details>" not in body:
            tail = "\n"
        elif "```text" not in body:
            tail = "\n</details>\n"
    return (head + body + tail)[:limit]


# The corpus block is the readout's only per-task section, so it is the only
# one whose length follows the manifest. A check run's `output.summary` is
# capped at 65,535 characters and the API truncates silently past it, so this
# caps itself first: the rows are ordered by discovery cost, a cut therefore
# drops the cheapest tasks, and the line under them says how many were dropped.
# Every task stays in `report.json` under `corpus_tasks` either way.
CORPUS_ROWS = 50
# task, family, distance, verifier: the manifest columns, and the report keys
# they read. `fixture` is the fixture hash and takes a fixed dozen characters.
CORPUS_COLUMNS = (("task", "task_id"), ("family", "family"), ("distance", "transfer_distance"), ("verifier", "verifier"))
FIXTURE_WIDTH = 12
# requests, tokens, pass rate: one group of three per arm, and the cell keys
# they read.
ARM_GROUP = ("7.2f", "10.1f", "5.3f")
ARM_LABELS = ("reqs", "tokens", "pass")
CELL_KEYS = ("requests_per_attempt", "tokens_per_attempt", "pass_rate")


def _cell(report: dict[str, Any], arm_id: str, task_id: str) -> dict[str, Any]:
    """One arm's cell for one task, or an empty cell for a task it never scored."""
    return (((report.get("arms") or {}).get(arm_id) or {}).get("tasks") or {}).get(task_id) or {}


def _group(report: dict[str, Any], arm_id: str, task_id: str) -> str:
    """One arm's three figures for one task: round trips, tokens, and pass rate."""
    cell = _cell(report, arm_id, task_id)
    return " ".join(_number(cell.get(key), spec) for key, spec in zip(CELL_KEYS, ARM_GROUP))


def _row(left: str, groups: list[str]) -> str:
    """The manifest columns, then one group per arm. A run with no arm is left alone."""
    return left + "".join(f"  {group}" for group in groups)


def corpus_section(report: dict[str, Any]) -> list[str]:
    """The corpus a headline was measured on, most expensive task first.

    Discovery cost is the baseline arm's requests per attempt: what a task took
    to work out with nothing carried in. Ordering by it is the point of the
    section, because it is what tells a reader at a glance whether the corpus
    holds any expensive task at all. Nothing here is measured; every figure is
    the reducer's own cell, and the metadata beside it is the manifest's.
    """
    tasks = report.get("corpus_tasks") or []
    if not tasks:
        return []
    arms = sorted(report.get("arms") or {})
    baseline = report.get("baseline")
    cost = {task["task_id"]: _cell(report, baseline or "", task["task_id"]).get("requests_per_attempt") for task in tasks}
    ordered = sorted(tasks, key=lambda task: (cost[task["task_id"]] is None, -(cost[task["task_id"]] or 0.0), task["task_id"]))
    shown = ordered[:CORPUS_ROWS]
    widths = [max([len(label)] + [len(str(task[key])) for task in shown]) for label, key in CORPUS_COLUMNS]
    left = " ".join(label.ljust(width) for (label, _), width in zip(CORPUS_COLUMNS, widths)) + " " + "fixture".ljust(FIXTURE_WIDTH)
    # An arm whose every attempt was invalid has no cell for any task, so the
    # order is nothing but the task ids and the heading says that rather than
    # claiming a ranking the run never measured.
    if any(value is not None for value in cost.values()):
        heading = f"corpus: {plural(len(ordered), 'task')}, most expensive first by discovery cost, requests per attempt in {baseline}"
    else:
        why = f"{baseline} scored no attempt" if baseline else "no baseline arm is named"
        heading = f"corpus: {plural(len(ordered), 'task')}, ordered by task id: {why}, so no discovery cost is known"
    # Two header lines because each arm owns three columns: the arm names sit
    # over their own group rather than over one shared row of labels.
    group = len(ARM_GROUP) - 1 + sum(int(spec.split(".", 1)[0]) for spec in ARM_GROUP)
    labels = " ".join(label.rjust(int(spec.split(".", 1)[0])) for label, spec in zip(ARM_LABELS, ARM_GROUP))
    lines = [
        heading,
        _row(" " * len(left), [(f"{arm_id} (baseline)" if arm_id == baseline else arm_id).center(group) for arm_id in arms]),
        _row(left, [labels for _ in arms]),
    ]
    for task in shown:
        fixture = str(task["fixture_hash"]).removeprefix("sha256:")[:FIXTURE_WIDTH]
        cells = " ".join(str(task[key]).ljust(size) for (_, key), size in zip(CORPUS_COLUMNS, widths))
        lines.append(_row(f"{cells} {fixture.ljust(FIXTURE_WIDTH)}", [_group(report, arm_id, task["task_id"]) for arm_id in arms]))
    if len(ordered) > len(shown):
        lines.append(
            f"... {plural(len(ordered) - len(shown), 'cheaper task')} not shown; "
            f"all {len(ordered)} are in report.json under corpus_tasks"
        )
    # The arm banner centres a short name inside its group, which leaves the
    # padding on the right of the last one; a log should not carry it.
    return [line.rstrip() for line in lines]


def render(report: dict[str, Any], *, include_overview: bool = True) -> str:
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
    if include_overview:
        lines = [overview(report), "", "Detailed accounting (provisional diagnostics):", *lines]
    if report.get("shelf_secret_present", False):
        lines.append("team shelf secret present: NOT PUBLISHABLE, the arm ran against a private shelf this run cannot vouch for")
    if report.get("slice"):
        lines.append("slice: " + " ".join(f"{key}={value}" for key, value in sorted(report["slice"].items())))
    taken = report.get("corpus_snapshot")
    if taken and taken.get("error"):
        lines.append(f"corpus snapshot unavailable ({taken['error']}): this report does not say which corpus produced it")
    elif taken:
        lines.append(f"corpus snapshot: {taken['posts']} pieces on {taken['origin']} at {taken['taken_at']}, {taken['content_hash']}")
    corpus = report.get("corpus")
    if corpus:
        lines.append(
            f"corpus {corpus['provider']} project {corpus['project_id']} branch {corpus['branch_id']} "
            f"reset from {corpus['parent_id']} at {corpus['reset_at']}, serving {corpus['origin']}"
        )
    if corpus and corpus.get("reset_epochs"):
        lines.append(f"frozen source revision {corpus['source_lsn']}; {len(corpus['reset_epochs'])} actual reset epochs retained")
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
    for arm_id, arm in sorted(report["arms"].items()):
        producer = arm.get("producer")
        if producer:
            lines.append(
                f"{arm_id} producer phases: {producer['attempts']} run, {producer['passes']} passed, {producer['captured']} left a closed local record, "
                f"{producer['findings']} capture draft(s) retained, {producer['invalid']} invalid; one-time tokens producer {arm['phase_tokens']['producer']}, capture {arm['phase_tokens']['capture']}"
            )
        diagnostics = [task.get("diagnostics", {}) for task in arm.get("tasks", {}).values()]
        spent = {phase: sum(item.get("attempt_phase_tokens", {}).get(phase, 0) for item in diagnostics) for phase in ("consumer", "nudge", "cli_search")}
        if spent["nudge"] or spent["cli_search"]:
            lines.append(
                f"{arm_id} attempt phases: task {spent['consumer']}, turn-end nudge {spent['nudge']}, CLI search {spent['cli_search']} "
                "(the product as shipped; the nudge and the search are inside the arm's total)"
            )
        local_hits = sum(item.get("local_hits", 0) for item in diagnostics)
        local_legs = sum(item.get("local_legs", 0) for item in diagnostics)
        child_tokens = sum(item.get("child_tokens", 0) for item in diagnostics)
        if local_legs or child_tokens:
            lines.append(f"{arm_id} local legs: {local_legs}, hits: {local_hits}; descendant tokens: {child_tokens}")
    seeds = report.get("seeds")
    if seeds is not None and seeds["published"]:
        lines.append(f"seeded pieces: {seeds['published']} published to the team shelf, {seeds['published'] - seeds['not_deleted']} deleted")
        if seeds["not_deleted"]:
            lines.append(f"WARNING: {seeds['not_deleted']} seeded piece(s) still on the team shelf: delete them by hand (isolation.seed.piece_id in the records)")
    # The two shelf arms are byte-identical in their settings, so the reading
    # names which one had the marketplace leg on.
    for arm_id, arm in sorted(report["arms"].items()):
        fallback = arm.get("public_fallback")
        if fallback == "off":
            lines.append(f"{arm_id}: public fallback off, so a team miss never reached the marketplace")
    origins = report.get("origins")
    if origins is not None:
        lines.append(
            f"public legs: {origins['public_legs']}, hits: {origins['public_hits']}, "
            f"timeouts: {origins['public_timeouts']}; legs the daemon logged to an unnamed shelf: {origins['unnamed_shelf_legs']}"
        )
    if report["comparisons"]:
        lines.append(f"Completion token comparison versus {baseline}, 1.0 means no change; decomposition follows:")
        for arm_id, comparison in sorted(report["comparisons"].items()):
            headline = comparison.get("headline")
            eligible = "headline eligible" if comparison["headline_eligible"] else "NOT headline eligible"
            interval = comparison.get("headline_interval")
            if headline is None:
                lines.append(f"  headline {arm_id}: none ({comparison['token_ratio_reason'] or 'no capture-only ratio'}), {eligible}")
            else:
                span = "" if not interval or interval.get("low") is None else f"  interval [{interval['low']:.3f}, {interval['high']:.3f}] at {interval['confidence']:.0%} over {plural(interval['tasks'], 'task')}"
                lines.append(f"  headline {arm_id}: {headline:.3f} ({HEADLINE_LABEL}){span}, {eligible}")
            curve = {point["reuse"]: point["token_ratio"] for point in comparison.get("amortized_capture_only_token_ratio", [])}
            lines.append(f"    reuse 2/5/10: {_number(curve.get(2), '5.3f')}/{_number(curve.get(5), '5.3f')}/{_number(curve.get(10), '5.3f')}")
            ratio = comparison["token_ratio"]
            if ratio is None:
                lines.append(f"    {CAPTURE_FREE_LABEL}: none ({comparison['token_ratio_reason']})")
            else:
                free_interval = comparison["interval"]
                span = "interval unavailable: insufficient independent tasks" if free_interval["low"] is None else (
                    f"interval [{free_interval['low']:.3f}, {free_interval['high']:.3f}] "
                    f"at {free_interval['confidence']:.0%} over {plural(free_interval['tasks'], 'task')}"
                )
                lines.append(f"    {CAPTURE_FREE_LABEL}: {ratio:.3f}  {span}")
            retrieval = comparison.get("retrieval_only_token_ratio")
            if retrieval is None:
                lines.append(f"    {RETRIEVAL_ONLY_LABEL}: none ({comparison.get('retrieval_only_token_ratio_reason') or 'no phase decomposition'})")
            else:
                lines.append(f"    {RETRIEVAL_ONLY_LABEL}: {retrieval:.3f}")
            amortized = {point["reuse"]: point["token_ratio"] for point in comparison.get("amortized_token_ratio", [])}
            if any(value is not None for value in amortized.values()):
                lines.append(f"    diagnostic, the producer's own work charged too, reuse 1/10: {_number(amortized.get(1), '5.3f')}/{_number(amortized.get(10), '5.3f')}")
            lines += _decomposition(report, arm_id, baseline, comparison)
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
    # Last, because it is the one block that grows with the manifest and the
    # one this reading ever truncates: a cut here costs a reader the cheapest
    # tasks rather than the arms, the ratios, or the accounting above.
    rows = corpus_section(report)
    if rows:
        lines += ["", *rows]
    return "\n".join(lines)


def plan_summary(manifest: dict[str, Any]) -> str:
    """Human-readable experiment plan, using only declared configuration."""
    tasks, arms, pins = manifest["tasks"], manifest["arms"], manifest["pins"]
    count = len(tasks) * len(arms) * manifest["repeats"]
    lines = [f"Experiment to run: {manifest['benchmark_version']}",
             f"Model: {pins['model']} | Harness: {manifest['harness']} {pins['harness_version']} | Effort: {pins['effort']}",
             f"Planned: {count} attempts = {len(tasks)} tasks × {len(arms)} arms × {manifest['repeats']} repeats",
             f"Caps per attempt: {pins['wall_clock_s']} seconds, {pins['turn_budget']} turns | Concurrency: {pins.get('concurrency', 1)}",
             "Tasks: " + ", ".join(task["id"] for task in tasks),
             "Control: " + arms[0]["id"]]
    for arm in arms:
        lines.append(f"Arm: {arm['id']} | executor={arm['executor']} | producer={'yes' if arm.get('producer') else 'no'} | auxiliary={arm['auxiliary_usage']} | settings={arm['settings_hash']}")
    lines.append("No result yet. Execution and verified outcomes determine what can be reported.")
    return "\n".join(lines)
