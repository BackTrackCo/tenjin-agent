"""Frozen run manifest: load, validate, hash.

Manifest values are data. Executor and verifier names select code-owned argv
in `executor.py` and `verifier.py`; no field here is ever shell-evaluated.
Validation runs before any spend, so a bad manifest costs nothing, and the
manifest hash covers every byte the schedule and trial ids derive from.

`SCHEMA` is the shape: keys, types, enums, patterns, bounds. What follows it in
`validate` is the short list a schema cannot state, because each rule reads
something outside the document: the fixture directory on disk, the hash of its
bytes, and whether ids repeat or the arms disagree on one executor.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import corpus as corpus_module, sha256_dir, sha256_json, vendor as vendor_module
from .schema import check, enum
from .usage import HARNESSES

SCHEMA_VERSION = 1

PHASE_KEYS = frozenset({"producer", "capture", "consumer"})
TRANSFER_DISTANCES = frozenset({"none", "same_task", "same_family", "cross_family"})
# What an arm's memory product can prove about its own model spend. `none` is a
# claim that it spends no model tokens outside the harness session; `exposed`
# means it emits auxiliary receipts; `unexposed` is an arm whose spend the
# benchmark cannot see, which the reducer keeps out of the headline. There is
# no default: silence about auxiliary spend is the failure this field names.
AUXILIARY_EXPOSURE = frozenset({"none", "exposed", "unexposed"})

# Ids appear in publishable output, so they are opaque tokens by construction.
IDENTIFIER = {"type": "string", "pattern": r"^[A-Za-z0-9_-]{1,64}$"}
# A version a later run could resolve differently is not a pin: a value that
# says nothing, or that opens with a tag or a range operator.
UNPINNED = ("latest", "*", "^", "~", ">", "<")
PINNED = {
    "type": "string",
    "pattern": r"\S",
    "not": {"pattern": "^(" + "|".join(re.escape(prefix) for prefix in UNPINNED) + ")"},
}
HASH_TOKEN = {"type": "string", "pattern": "^sha256:.+"}
NON_BLANK = {"type": "string", "pattern": r"\S"}
STRINGS = {"type": "array", "items": {"type": "string"}}
COUNT = {"type": "integer", "minimum": 0}
POSITIVE = {"type": "integer", "minimum": 1}
# Relative, and no segment that climbs out of the manifest's own directory.
# Transcribed from `Path(value).is_absolute()` and `".." in Path(value).parts`,
# which is what the fixture lookup below still resolves against.
FIXTURE_PATH = {"type": "string", "pattern": r"^[^/]", "not": {"pattern": r"(^|/)\.\.(/|$)"}}

# Shape, and only shape. Every rule that has to read something outside this
# document is in `validate` below: whether the fixture directory is there,
# whether its bytes hash to what the task claims, whether two tasks or two arms
# share an id, and whether the arms agree on one executor.
SCHEMA: dict[str, Any] = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "additionalProperties": False,
    "required": ["arms", "benchmark_version", "harness", "pins", "price_sheet_version", "repeats", "schema_version", "seed", "tasks"],
    "properties": {
        "benchmark_version": PINNED,
        "price_sheet_version": PINNED,
        "schema_version": {"const": SCHEMA_VERSION},
        "harness": enum(HARNESSES),
        "seed": COUNT,
        "repeats": POSITIVE,
        "pins": {
            "type": "object",
            "additionalProperties": False,
            "required": ["dependency_lock_hash", "effort", "harness_version", "image", "model", "permission_mode", "turn_budget", "wall_clock_s"],
            "properties": {
                "model": PINNED,
                "harness_version": PINNED,
                "effort": PINNED,
                "image": PINNED,
                "permission_mode": PINNED,
                "dependency_lock_hash": HASH_TOKEN,
                "wall_clock_s": POSITIVE,
                "turn_budget": POSITIVE,
                # What a live executor needs and a fake one has no use for.
                # Coarse shapes here so a bad manifest costs nothing; the
                # executor that turns these into argv owns the flag and value
                # allowlists (`claude_live.py`).
                "concurrency": POSITIVE,
                "max_budget_usd": {"type": "number", "exclusiveMinimum": 0},
                "tools": STRINGS,
                "allowed_tools": STRINGS,
                "credential_env": NON_BLANK,
            },
        },
        "phases": {
            "type": "object",
            "additionalProperties": False,
            "required": sorted(PHASE_KEYS),
            "properties": {phase: PINNED for phase in sorted(PHASE_KEYS)},
        },
        # Shape only: `corpus.parse` is what says which provider, which ids and
        # which origin, and it raises the reject code the runner reports.
        "corpus": {"type": "object"},
        "tasks": {
            "type": "array",
            "minItems": 1,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["family", "fixture", "fixture_hash", "id", "transfer_distance", "verifier"],
                "properties": {
                    "id": IDENTIFIER,
                    "family": IDENTIFIER,
                    "verifier": IDENTIFIER,
                    "transfer_distance": enum(TRANSFER_DISTANCES),
                    "fixture": FIXTURE_PATH,
                    "fixture_hash": HASH_TOKEN,
                    "prompt": NON_BLANK,
                    # Shape only: `vendor_module.resolve` is what says whether
                    # the archive it names exists and hashes to its pin.
                    "vendor": NON_BLANK,
                },
            },
        },
        "arms": {
            "type": "array",
            "minItems": 2,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["auxiliary_usage", "executor", "id", "memory_snapshot_hash", "product_version", "settings_hash"],
                "properties": {
                    "id": IDENTIFIER,
                    "executor": IDENTIFIER,
                    "product_version": PINNED,
                    "settings_hash": HASH_TOKEN,
                    "memory_snapshot_hash": HASH_TOKEN,
                    "auxiliary_usage": enum(AUXILIARY_EXPOSURE),
                    "settings": {"type": "object"},
                    "provision": IDENTIFIER,
                    "lessons": {"type": "array", "minItems": 1, "items": IDENTIFIER},
                },
            },
        },
    },
}


class ManifestError(ValueError):
    pass


@dataclass(frozen=True)
class Manifest:
    data: dict[str, Any]
    path: Path
    hash: str

    @property
    def tasks(self) -> list[dict[str, Any]]:
        return list(self.data["tasks"])

    @property
    def arms(self) -> list[dict[str, Any]]:
        return list(self.data["arms"])

    @property
    def pins(self) -> dict[str, Any]:
        return dict(self.data["pins"])

    @property
    def harness(self) -> str:
        return str(self.data["harness"])

    @property
    def concurrency(self) -> int:
        """How many trials may be in flight at once. Absent means one, so an existing manifest is unchanged.

        It is a pin because it is a property of the run rather than of the
        schedule, and `environment_hash` is the hash of the pins: a reader
        comparing two runs sees a different environment without a new field.
        """
        return int(self.data["pins"].get("concurrency", 1))

    def fixture_path(self, task: dict[str, Any]) -> Path:
        return (self.path.parent / task["fixture"]).resolve()

    @property
    def corpus(self) -> corpus_module.Corpus | None:
        """The database branch a run resets before its first trial, when it names one."""
        if "corpus" not in self.data:
            return None
        return corpus_module.parse(self.data["corpus"])

    def vendor_for(self, task: dict[str, Any]) -> vendor_module.Vendor | None:
        """The archive a task's trials extract into `node_modules`, when it names one."""
        if "vendor" not in task:
            return None
        return vendor_module.resolve(self.path.parent, task["vendor"])


def fixture_hash(fixture: Path, vendor: vendor_module.Vendor | None = None) -> str:
    """The committed fixture files, plus the vendor archive digest when the task names one.

    The archive itself is a release asset rather than a committed file, so the
    digest comes from the record, and from the local bytes whenever a checkout
    has them. Both spell the same value: `vendor.archive_digest` refuses bytes
    that are not the ones the record pins.
    """
    tree = sha256_dir(fixture)
    if vendor is None:
        return "sha256:" + tree
    return "sha256:" + sha256_json({"fixture": tree, "vendor": vendor_module.archive_digest(vendor)})


def validate(data: dict[str, Any], base: Path) -> None:
    """The schema, then the rules a schema cannot state."""
    check("manifest", data, SCHEMA, ManifestError)
    if "corpus" in data:
        try:
            corpus_module.parse(data["corpus"])
        except corpus_module.CorpusError as error:
            raise ManifestError(error.detail) from error
    seen: set[str] = set()
    for task in data["tasks"]:
        task_id = task["id"]
        if task_id in seen:
            raise ManifestError(f"duplicate task id {task_id!r}")
        seen.add(task_id)
        fixture = base / task["fixture"]
        if not fixture.is_dir():
            raise ManifestError(f"task {task_id!r} fixture path is missing: {task['fixture']}")
        try:
            vendor = None if "vendor" not in task else vendor_module.resolve(base, task["vendor"])
            expected = fixture_hash(fixture, vendor)
        except vendor_module.VendorError as error:
            raise ManifestError(f"task {task_id!r} vendor: {error.detail}") from error
        if task["fixture_hash"] != expected:
            raise ManifestError(f"task {task_id!r} fixture_hash does not match the fixture directory and its vendor archive")
    seen.clear()
    for arm in data["arms"]:
        if arm["id"] in seen:
            raise ManifestError(f"duplicate arm id {arm['id']!r}")
        seen.add(arm["id"])
    # Arms that run different executors measure different harnesses, so their
    # token totals would not be comparable under one manifest.
    if len({arm["executor"] for arm in data["arms"]}) != 1:
        raise ManifestError("arms are unbalanced: every arm must share one executor")


def load(path: Path) -> Manifest:
    path = path.resolve()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ManifestError(f"cannot read manifest: {error}") from error
    if not isinstance(data, dict):
        raise ManifestError("manifest must be a JSON object")
    validate(data, path.parent)
    return Manifest(data=data, path=path, hash=sha256_json(data))
