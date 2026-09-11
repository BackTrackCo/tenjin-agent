"""Immutable attempt records.

Write a unique partial file, flush it, publish the final path without
overwrite. `os.link` is the publish step because it fails atomically when the
final path exists, so two writers for one trial_id cannot both win. Resume
accepts only a final record whose manifest and schedule hashes match and whose
trial_id derives from its own fields; every other file is excluded with a
machine-readable reason and never reaches the reducer.
"""

from __future__ import annotations

import re

import json
import math
import os
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import loop_join, phases as phases_module, usage
from .schedule import trial_id as derive_trial_id

RECORD_SCHEMA = "bench1.attempt.v1"
OUTCOMES = frozenset({"pass", "fail", "capped", "interrupted", "invalid"})
# `timeout` is the wall-clock pin, `interrupted` the settlement cap, `budget`
# and `turns` the harness's own stops; `exit` is an ordinary end.
STOP_REASONS = frozenset({"exit", "timeout", "interrupted", "budget", "turns"})
PROVENANCE = frozenset({"native", "observed", "unavailable"})
# A scored attempt has to have accounted for its own spend. These are the
# reconciliation statuses that did: the root envelope agrees with the selected
# records, or its remainder is attributed to models that wrote no root row.
RECONCILED = frozenset({"matched", "matched_with_descendants", "explained_by_side_models"})
# A cap is the one declared reason a scored attempt may have no envelope at
# all, or a partial one: the outcome itself names the gap.
CAPPED_OUTCOMES = frozenset({"capped", "interrupted"})
CAPPED_RECONCILIATION = frozenset({"no_envelope", "envelope_partial"})
REQUIRED = frozenset(
    {
        "schema",
        "trial_id",
        "manifest_hash",
        "schedule_hash",
        "task_id",
        "arm_id",
        "repeat",
        "position",
        "settings_hash",
        "environment_hash",
        "harness",
        "native_root_id",
        "actors",
        "parent_edges",
        "usage",
        "usage_reconciliation",
        "auxiliary",
        "outcome",
        "invalid_reason",
        "verifier",
        "patch_hash",
        "stop_reason",
        "wall_time_s",
        "unresolved_actors",
        "turns",
        "tool_counts",
        "cost_usd",
        "delivery",
        "sentinel",
        "isolation",
        "private_hashes",
    }
)


# Keys a record may carry and a frozen corpus record predates: null or absent on the fake path.
OPTIONAL = frozenset({"discovery", "attempt_phases", "invalid_detail", "agent_time_s", "verification_time_s"})
# `invalid_detail` is the refusal in its own words, for a reason code that
# cannot carry them: `provision:seed_publish` says a publish failed and not what
# it answered. Written masked by whoever refuses; private, like a transcript, so
# `report.py` never projects it.
DETAIL_LIMIT = 1024
# `image` is a container trial's pnpm: installed into the fixture image at
# build time by exact version, so nothing on the host decides which one ran.
PACKAGE_MANAGER_KINDS = frozenset({"image", "corepack-shim", "binary", "missing"})
SEED_KEYS = frozenset({"lesson", "title", "nonce", "key_hashes", "keys", "shelf_origin", "piece_id", "published", "probe", "deleted", "delete_error"})
# The CLI build a container trial measured, under `isolation.image.cli`: the
# packed package's content hash and the checkout commit it was built from.
CLI_KEYS = frozenset({"build", "commit"})
# The product's own `team.publicFallback`, stated per attempt because an arm may
# choose it (`tenjin_arm.public_fallback_of`).
PUBLIC_FALLBACK = frozenset({"on", "off"})
# The corpus stamp a reset wrote into the attestation (`artifact.CorpusStamp`).
CORPUS_KEYS = frozenset({"provider", "project_id", "branch_id", "parent_id", "origin", "api_origin", "reset_at"})

CORPUS_REVISION_KEYS = frozenset({"baseline_id", "source_lsn", "epoch_id"})

class RecordError(ValueError):
    pass


@dataclass(frozen=True)
class Excluded:
    path: str
    reason: str


def final_path(records_dir: Path, trial_id: str) -> Path:
    return records_dir / f"{trial_id}.json"


def publish(records_dir: Path, record: dict[str, Any]) -> tuple[Path, bool]:
    """Return (final path, won). A loser keeps its partial file as evidence."""
    validate(record)
    records_dir.mkdir(parents=True, exist_ok=True)
    partial = records_dir / f"{record['trial_id']}.partial.{uuid.uuid4().hex}.json"
    with partial.open("w", encoding="utf-8") as handle:
        json.dump(record, handle, indent=2, sort_keys=True)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    final = final_path(records_dir, record["trial_id"])
    try:
        os.link(partial, final)
    except FileExistsError:
        return final, False
    partial.unlink()
    return final, True


def _count(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _require_str(record: dict[str, Any], name: str) -> str:
    value = record[name]
    if not isinstance(value, str) or not value:
        raise RecordError(f"{name} must be a non-empty string")
    return value


def _actor(value: Any, harness: str, root: str) -> tuple[str, str, str]:
    if not isinstance(value, list) or len(value) != 3:
        raise RecordError("actor key must be [harness, root_session_id, native_actor_id]")
    try:
        key = usage.actor_key(*value)
    except (usage.UsageError, TypeError) as error:
        raise RecordError(f"invalid actor key: {error}") from error
    if key[0] != harness or key[1] != root:
        raise RecordError("actor key names another harness or root session")
    return key


def validate(record: dict[str, Any]) -> None:
    if not isinstance(record, dict):
        raise RecordError("record must be an object")
    missing = sorted(REQUIRED - set(record))
    unknown = sorted(set(record) - REQUIRED - OPTIONAL)
    if missing:
        raise RecordError(f"record is missing keys: {', '.join(missing)}")
    if unknown:
        raise RecordError(f"record has unknown keys: {', '.join(unknown)}")
    if record["schema"] != RECORD_SCHEMA:
        raise RecordError(f"record schema must be {RECORD_SCHEMA}")
    for name in ("trial_id", "manifest_hash", "schedule_hash", "task_id", "arm_id", "settings_hash", "environment_hash"):
        _require_str(record, name)
    for name in ("repeat", "position"):
        if not _count(record[name]):
            raise RecordError(f"{name} must be a non-negative integer")
    expected = derive_trial_id(record["manifest_hash"], record["task_id"], record["arm_id"], record["repeat"], record["position"])
    if record["trial_id"] != expected:
        raise RecordError("trial_id does not derive from manifest_hash, task, arm, repeat, and position")
    harness = _require_str(record, "harness")
    if harness not in usage.HARNESSES:
        raise RecordError(f"unknown harness {harness!r}")
    root = _require_str(record, "native_root_id")
    if record["outcome"] not in OUTCOMES:
        raise RecordError(f"unknown outcome {record['outcome']!r}")
    reason = record["invalid_reason"]
    if record["outcome"] == "invalid" and (not isinstance(reason, str) or not reason):
        raise RecordError("an invalid attempt must carry invalid_reason")
    if record["outcome"] != "invalid" and reason is not None:
        raise RecordError("only an invalid attempt carries invalid_reason")
    detail = record.get("invalid_detail")
    if detail is not None:
        if not isinstance(detail, str) or not detail:
            raise RecordError("invalid_detail must be a non-empty string or null")
        if len(detail) > DETAIL_LIMIT:
            raise RecordError(f"invalid_detail must be at most {DETAIL_LIMIT} characters")
        if record["outcome"] != "invalid":
            raise RecordError("only an invalid attempt carries invalid_detail")
    if record["stop_reason"] not in STOP_REASONS:
        raise RecordError(f"unknown stop_reason {record['stop_reason']!r}")

    actors: set[tuple[str, str, str]] = set()
    if not isinstance(record["actors"], list):
        raise RecordError("actors must be a list")
    for entry in record["actors"]:
        if not isinstance(entry, dict) or set(entry) != {"key", "parent_actor_key", "parent_provenance"}:
            raise RecordError("actor entries carry key, parent_actor_key, and parent_provenance")
        key = _actor(entry["key"], harness, root)
        if key in actors:
            raise RecordError(f"actor {key[2]!r} is listed twice")
        actors.add(key)
        provenance = entry["parent_provenance"]
        if provenance not in PROVENANCE:
            raise RecordError(f"unknown parent provenance {provenance!r}")
        if (entry["parent_actor_key"] is None) != (provenance == "unavailable"):
            raise RecordError("parent_actor_key is null exactly when its provenance is unavailable")
        if entry["parent_actor_key"] is not None:
            parent = _actor(entry["parent_actor_key"], harness, root)
            if parent == key:
                raise RecordError("an actor cannot be its own parent")
    if record["outcome"] != "invalid" and (harness, root, "") not in actors:
        raise RecordError("the lead actor is missing from a scored attempt")
    for entry in record["actors"]:
        if entry["parent_actor_key"] is not None and tuple(entry["parent_actor_key"]) not in actors:
            raise RecordError("parent_actor_key names an actor outside the attempt")
    if not isinstance(record["parent_edges"], list):
        raise RecordError("parent_edges must be a list")
    for edge in record["parent_edges"]:
        if not isinstance(edge, dict) or set(edge) != {"child", "parent", "provenance"}:
            raise RecordError("parent edges carry child, parent, and provenance")
        if edge["provenance"] not in PROVENANCE - {"unavailable"}:
            raise RecordError("a stored parent edge needs native or observed provenance")
        if _actor(edge["child"], harness, root) not in actors or _actor(edge["parent"], harness, root) not in actors:
            raise RecordError("parent edge names an actor outside the attempt")

    if not isinstance(record["usage"], list):
        raise RecordError("usage must be a list")
    parsed = []
    for item in record["usage"]:
        try:
            parsed.append(usage.from_json(item))
        except usage.UsageError as error:
            raise RecordError(f"usage entry: {error}") from error
    for item in parsed:
        if item.trial_id != record["trial_id"]:
            raise RecordError("usage entry belongs to another trial")
        if item.actor_key not in actors:
            raise RecordError("usage entry names an actor outside the attempt")
    try:
        deduped = usage.dedupe(parsed)
        receipts = [usage.receipt_from_json(item) for item in record["auxiliary"]]
        usage.check_receipts(receipts, deduped)
    except (usage.UsageError, TypeError) as error:
        raise RecordError(f"usage: {error}") from error
    if len(deduped) != len(parsed):
        raise RecordError("usage entries are not deduplicated")
    for receipt in receipts:
        if receipt.trial_id != record["trial_id"]:
            raise RecordError("auxiliary receipt belongs to another trial")

    reconciliation = record["usage_reconciliation"]
    if not isinstance(reconciliation, dict) or not isinstance(reconciliation.get("status"), str):
        raise RecordError("usage_reconciliation must carry a status")
    # The accounting invariant belongs to the record, not only to the runner
    # that built it: a file the reducer reads from disk must not be able to
    # claim a scored outcome over usage that never reconciled.
    if record["outcome"] != "invalid":
        allowed = RECONCILED | (CAPPED_RECONCILIATION if record["outcome"] in CAPPED_OUTCOMES else frozenset())
        if reconciliation["status"] not in allowed:
            raise RecordError(
                f"outcome {record['outcome']!r} cannot carry usage_reconciliation {reconciliation['status']!r}"
            )
    # Optional, because the records of every run before it are immutable and
    # still have to reduce: an attempt with no decomposition is undecomposed,
    # never invalid.
    attempt = record.get("attempt_phases")
    if attempt is not None and (not isinstance(attempt, dict) or set(attempt) != set(phases_module.PHASES)):
        raise RecordError(f"attempt_phases must name exactly {', '.join(phases_module.PHASES)}")
    for phase, entry in (attempt or {}).items():
        if not isinstance(entry, dict) or set(entry) != {"requests", "input_total", "output_total"}:
            raise RecordError(f"attempt_phases.{phase} must carry requests, input_total and output_total")
        if not all(_count(entry[name]) for name in entry):
            raise RecordError(f"attempt_phases.{phase} counts must be non-negative integers")
    # The phases partition the attempt's own usage, so their sum is that usage
    # and never an addition to it.
    if attempt is not None:
        counted = sum(entry["input_total"] + entry["output_total"] for entry in attempt.values())
        own = sum(item["input_total"] + item["output_total"] for item in record["usage"])
        if counted != own:
            raise RecordError(f"attempt_phases sum to {counted} tokens and the attempt's usage is {own}")
    delivery = record["delivery"]
    if not isinstance(delivery, dict) or delivery.get("status") not in loop_join.STATUSES:
        raise RecordError("delivery must carry a known status")
    for name in ("fires", "legs", "unmatched_fires"):
        if not isinstance(delivery.get(name), list):
            raise RecordError(f"delivery.{name} must be a list")
    for fire in delivery["fires"]:
        if _actor(fire.get("actor"), harness, root) not in actors:
            raise RecordError("a joined fire names an actor outside the attempt")
    for name in ("tool_counts", "sentinel", "isolation", "private_hashes"):
        if not isinstance(record[name], dict):
            raise RecordError(f"{name} must be an object")
    isolation = record["isolation"]
    for name in ("live", "publishable", "attested_container"):
        if not isinstance(isolation.get(name), bool):
            raise RecordError(f"isolation.{name} must be true or false")
    for name in ("shelf_secret_present", "daemon_respawned"):
        if name in isolation and not isinstance(isolation[name], bool):
            raise RecordError(f"isolation.{name} must be true or false")
    # Non-publishable by construction: the file on disk cannot claim otherwise.
    if isolation.get("shelf_secret_present") and isolation["publishable"]:
        raise RecordError("an attempt that seeded a team shelf secret cannot be publishable")
    for name in ("shelf_origin", "public_origin"):
        if isolation.get(name) is not None and (not isinstance(isolation[name], str) or not isolation[name]):
            raise RecordError(f"isolation.{name} must be null or a host")
    # A container trial names the CLI build it measured, not a version string:
    # `tenjin-cli@0.1.0-alpha.15` on npm and the repository at that same version
    # are different builds, so the version identifies nothing. `build` is the
    # packed package's content hash, which is also an image input; `commit` is
    # what a reader resolves back to source.
    image = isolation.get("image")
    if image is not None:
        if not isinstance(image, dict):
            raise RecordError("isolation.image must be an object")
        cli = image.get("cli")
        if not isinstance(cli, dict) or set(cli) != CLI_KEYS:
            raise RecordError("isolation.image.cli must carry exactly the CLI build fields")
        for name in sorted(CLI_KEYS):
            if not isinstance(cli[name], str) or not cli[name]:
                raise RecordError(f"isolation.image.cli.{name} must name the CLI build the trial ran")
    if isolation.get("wal_checkpoint") is not None and (not isinstance(isolation["wal_checkpoint"], str) or not isolation["wal_checkpoint"]):
        raise RecordError("isolation.wal_checkpoint must be null or the reason the ledger's WAL did not close")
    seeds = isolation.get("seed")
    if seeds is not None and not isinstance(seeds, list):
        raise RecordError("isolation.seed must be a list, one entry per seeded lesson")
    for seed in seeds or []:
        if not isinstance(seed, dict) or set(seed) != SEED_KEYS:
            raise RecordError("isolation.seed entries must carry exactly the seed fields")
        if not isinstance(seed["title"], str) or not seed["title"] or not isinstance(seed["lesson"], str) or not seed["lesson"] or not isinstance(seed["published"], bool):
            raise RecordError("isolation.seed must name a lesson and a title and say whether it published")
        if not isinstance(seed["key_hashes"], list) or not all(isinstance(item, str) and item for item in seed["key_hashes"]) or seed["keys"] != len(seed["key_hashes"]):
            raise RecordError("isolation.seed key_hashes must be a list matching keys")
        for name in ("piece_id", "nonce", "shelf_origin", "delete_error"):
            if seed[name] is not None and (not isinstance(seed[name], str) or not seed[name]):
                raise RecordError(f"isolation.seed.{name} must be null or a non-empty string")
        if seed["deleted"] is not None and not isinstance(seed["deleted"], bool):
            raise RecordError("isolation.seed.deleted must be null or a boolean")
        if seed["published"] and (seed["piece_id"] is None or seed["nonce"] is None):
            raise RecordError("a seed that published names its piece and its run nonce")
    off = isolation.get("hooks_disabled")
    if off is not None and (not isinstance(off, list) or not all(isinstance(name, str) and name for name in off)):
        raise RecordError("isolation.hooks_disabled must be a list of product hook arm names")
    # The two shelf arms carry byte-identical settings, so this is the only
    # field that tells them apart in a record.
    fallback = isolation.get("public_fallback")
    if fallback is not None and fallback not in PUBLIC_FALLBACK:
        raise RecordError("isolation.public_fallback must be on or off")
    if "producer" in isolation and not isinstance(isolation["producer"], dict):
        raise RecordError("isolation.producer must be an object")
    if "producer" in isolation and isolation["producer"].get("outcome") not in OUTCOMES:
        raise RecordError("isolation.producer must carry an outcome")
    if "slice" in isolation and (not isinstance(isolation["slice"], dict) or not isinstance(isolation["slice"].get("kind"), str)):
        raise RecordError("isolation.slice must name a kind")
    corpus = isolation.get("corpus")
    if corpus is not None:
        if not isinstance(corpus, dict) or not CORPUS_KEYS <= set(corpus) or set(corpus) - CORPUS_KEYS - CORPUS_REVISION_KEYS:
            raise RecordError("isolation.corpus must carry exactly the corpus fields")
        if not all(isinstance(value, str) and value for key, value in corpus.items() if key in CORPUS_KEYS):
            raise RecordError("isolation.corpus fields must each be a non-empty string")
        revision = (corpus.get("baseline_id"), corpus.get("source_lsn"), corpus.get("epoch_id"))
        if revision != (None, None, None) and not (isinstance(revision[0], str) and re.fullmatch(r"sha256:[0-9a-f]{64}", revision[0]) and isinstance(revision[1], str) and re.fullmatch(r"[0-9A-F]+/[0-9A-F]+", revision[1]) and isinstance(revision[2], str) and re.fullmatch(r"sha256:[0-9a-f]{64}", revision[2])):
            raise RecordError("isolation.corpus frozen revision must have a baseline hash and source LSN")
    manager = isolation.get("package_manager")
    if manager is not None:
        if not isinstance(manager, dict) or set(manager) != {"kind", "version"} or manager["kind"] not in PACKAGE_MANAGER_KINDS:
            raise RecordError("isolation.package_manager must name a kind and a version")
        if manager["version"] is not None and (not isinstance(manager["version"], str) or not manager["version"]):
            raise RecordError("isolation.package_manager.version must be null or a version")
    for name in ("shelves", "classes", "public"):
        counts = delivery.get(name, {})
        if not isinstance(counts, dict) or not all(_count(value) for value in counts.values()):
            raise RecordError(f"delivery.{name} must map names to counts")
    found = record.get("discovery")
    if found is not None:
        if not isinstance(found, dict) or not all(isinstance(found.get(name), bool) for name in ("setup_read", "test_run_before_fix")):
            raise RecordError("discovery must say whether the setup file was read and whether a failing test run preceded the fix")
    key = delivery.get("failure_key")
    if key is not None:
        if not isinstance(key, dict) or key.get("lane") not in (None, "sig_v1", "sig_v1_test") or not isinstance(key.get("keys_leg_hit"), bool):
            raise RecordError("delivery.failure_key must name a lane and say whether the keys leg hit")
        if key.get("report_file_present") is not None and not isinstance(key["report_file_present"], bool):
            raise RecordError("delivery.failure_key.report_file_present must be null or a boolean")
    phase_fires = delivery.get("phase_fires")
    if phase_fires is not None and (not isinstance(phase_fires, dict) or not all(_count(value) for value in phase_fires.values())):
        raise RecordError("delivery.phase_fires must map sessions to counts")
    searches = delivery.get("cli_searches")
    if searches is not None:
        if not isinstance(searches, dict) or not _count(searches.get("count")) or not isinstance(searches.get("decisions"), dict):
            raise RecordError("delivery.cli_searches must carry a count and decisions")
        if not all(_count(value) for value in searches["decisions"].values()) or sum(searches["decisions"].values()) != searches["count"]:
            raise RecordError("delivery.cli_searches decisions must sum to its count")
    for field in ("wall_time_s", "agent_time_s", "verification_time_s"):
        value = record.get(field)
        if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0):
            raise RecordError(f"{field} must be null or a finite non-negative number")
    if record["turns"] is not None and not _count(record["turns"]):
        raise RecordError("turns must be null or a count")
    if record["cost_usd"] is not None and (
        isinstance(record["cost_usd"], bool) or not isinstance(record["cost_usd"], (int, float)) or record["cost_usd"] < 0
    ):
        raise RecordError("cost_usd must be null or a non-negative number")
    for name in ("patch_hash",):
        if record[name] is not None and (not isinstance(record[name], str) or not record[name]):
            raise RecordError(f"{name} must be null or a hash")
    verifier = record["verifier"]
    if verifier is not None and (not isinstance(verifier, dict) or not isinstance(verifier.get("id"), str)):
        raise RecordError("verifier must be null or carry an id")
    if record["outcome"] in ("pass", "fail") and verifier is None:
        raise RecordError("a pass or fail outcome needs a verifier verdict")
    if "credential_exposures" not in record["sentinel"]:
        raise RecordError("sentinel must carry credential_exposures")
    for name, value in record["sentinel"].items():
        if not _count(value):
            raise RecordError(f"sentinel.{name} must be a count")
    if not isinstance(record["unresolved_actors"], list) or any(
        not isinstance(item, str) or not usage.ACTOR_ID.match(item) for item in record["unresolved_actors"]
    ):
        raise RecordError("unresolved_actors must be a list of native actor ids")
    if record["outcome"] == "pass" and record["unresolved_actors"]:
        raise RecordError("a passing attempt cannot leave an actor unsettled")


def select(
    records_dir: Path, manifest_hash: str, schedule_hash: str
) -> tuple[dict[str, dict[str, Any]], list[Excluded]]:
    """Final records keyed by trial_id, plus everything the reducer must not read."""
    accepted: dict[str, dict[str, Any]] = {}
    excluded: list[Excluded] = []
    if not records_dir.is_dir():
        return accepted, excluded
    for path in sorted(records_dir.iterdir()):
        if ".partial." in path.name:
            excluded.append(Excluded(path.name, "partial"))
            continue
        if path.suffix != ".json" or not path.is_file():
            excluded.append(Excluded(path.name, "foreign"))
            continue
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
            validate(record)
        except (OSError, ValueError) as error:
            excluded.append(Excluded(path.name, f"invalid: {error}"))
            continue
        if record["manifest_hash"] != manifest_hash or record["schedule_hash"] != schedule_hash:
            excluded.append(Excluded(path.name, "stale"))
            continue
        if path.stem != record["trial_id"]:
            excluded.append(Excluded(path.name, "misnamed"))
            continue
        if record["trial_id"] in accepted:
            excluded.append(Excluded(path.name, "duplicate"))
            continue
        accepted[record["trial_id"]] = record
    return accepted, excluded

