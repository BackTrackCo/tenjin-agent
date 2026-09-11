"""Frozen run manifest: load, validate, hash.

Manifest values are data. Executor and verifier names select code-owned argv
in `executor.py` and `verifier.py`; no field here is ever shell-evaluated.
Validation runs before any spend, so a bad manifest costs nothing, and the
manifest hash covers every byte the schedule and trial ids derive from.

`load` expands `presets.py` first, so validation and the hash both see the
settings that actually run rather than the shorthand that named them.

`SCHEMA` is the shape: keys, types, enums, patterns, bounds. What follows it in
`validate` is the short list a schema cannot state, because each rule reads
something outside its own subdocument: the fixture directory on disk, the hash
of its bytes, whether ids repeat or the arms disagree on one executor, which of
an arm's choices need a provisioned arm, and which tasks a slice's kind needs.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import corpus as corpus_module, presets, sha256_dir, sha256_json
from .schema import check, enum
from .usage import HARNESSES

SCHEMA_VERSION = 1

PHASE_KEYS = frozenset({"producer", "capture", "consumer"})
SLICE_KINDS = frozenset({"recursive"})
SLICE_KEYS = {"recursive": frozenset({"kind"})}
SUBAGENT_TOOL = "Agent"
# The product's own values for `team.publicFallback`. `off` is the exact string
# `src/hooks/ask.ts` reads to drop the public-only legs.
PUBLIC_FALLBACK = frozenset({"on", "off"})
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
                "speed_mode": enum({"standard", "fast"}),
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
        # Shape only: `_validate_slice` is what says which kind, which keys
        # that kind carries, and which tasks the kind needs, and the last of
        # those reads the sibling `tasks` array.
        "slice": {"type": "object"},
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
                    "tools": STRINGS,
                    "allowed_tools": STRINGS,
                },
            },
        },
        "arms": {
            "type": "array",
            "minItems": 1,
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
                    # `lessons` names exactly which lessons a provisioned arm
                    # seeds on the team shelf (the default is the task's family
                    # lesson and its own fix), and `producer` runs a producer
                    # phase in the same data dir before the consumer.
                    # `hooks_disabled` names product hook arms the seeded config
                    # turns off; the provisioner owns which names exist, because
                    # they are the product's, not this package's.
                    # `public_fallback` is the product's `team.publicFallback`,
                    # which decides whether a team miss then reaches the public
                    # marketplace; it defaults to the product's own `on`, so an
                    # arm that omits it is the product as shipped. An arm's
                    # static files are `settings.overlay`, validated by the live
                    # executor. An arm may also name a `presets.PRESET_KEY`
                    # instead of inlining the block: `load` expands it into
                    # `settings` before this validation and before the hash, so
                    # no arm reaches here still carrying the name. An inline
                    # `settings` beside a preset is legal and wins key by key,
                    # which is where a real difference between two arms stays
                    # visible; an inline block with no preset is unchanged.
                    "lessons": {"type": "array", "minItems": 1, "items": IDENTIFIER},
                    "producer": {"type": "boolean"},
                    "hooks_disabled": {"type": "array", "minItems": 1, "items": IDENTIFIER},
                    "public_fallback": enum(PUBLIC_FALLBACK),
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

    @property
    def slice(self) -> dict[str, Any] | None:
        return None if "slice" not in self.data else dict(self.data["slice"])


def fixture_hash(fixture: Path) -> str:
    """The committed fixture files. The dependency tree is the image's, and the image is labelled with this hash."""
    return "sha256:" + sha256_dir(fixture)


def _arm_rules(name: str, arm: dict[str, Any]) -> None:
    """What an arm's choices need of each other, which is what the schema cannot see."""
    if "producer" in arm and not arm.get("provision"):
        raise ManifestError(f"{name}.producer needs a provisioned arm")
    if "hooks_disabled" in arm:
        if not arm.get("provision"):
            raise ManifestError(f"{name}.hooks_disabled needs a provisioned arm: there is no seeded config to write it into")
        if arm.get("producer"):
            raise ManifestError(f"{name} runs a producer phase, so it captures: an arm that captures keeps every hook arm the product ships on")
    if "public_fallback" in arm and not arm.get("provision"):
        raise ManifestError(f"{name}.public_fallback needs a provisioned arm: there is no seeded config to write it into")


def _validate_slice(data: dict[str, Any]) -> None:
    """A slice is one named variation of a local run, with exactly the fields its kind needs."""
    item = data["slice"]
    if item.get("kind") not in SLICE_KINDS:
        raise ManifestError(f"slice.kind must be one of {', '.join(sorted(SLICE_KINDS))}")
    kind = item["kind"]
    if set(item) != SLICE_KEYS[kind]:
        raise ManifestError(f"slice {kind!r} carries exactly {', '.join(sorted(SLICE_KEYS[kind]))}")
    if kind == "recursive" and not any(SUBAGENT_TOOL in task.get("tools", []) for task in data["tasks"]):
        raise ManifestError(f"a recursive slice needs a task whose tools include {SUBAGENT_TOOL}")


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
        if task["fixture_hash"] != fixture_hash(fixture):
            raise ManifestError(f"task {task_id!r} fixture_hash does not match the fixture directory")
    seen.clear()
    for arm in data["arms"]:
        if arm["id"] in seen:
            raise ManifestError(f"duplicate arm id {arm['id']!r}")
        seen.add(arm["id"])
        _arm_rules(f"arm {arm['id']!r}", arm)
    # Arms that run different executors measure different harnesses, so their
    # token totals would not be comparable under one manifest.
    if len({arm["executor"] for arm in data["arms"]}) != 1:
        raise ManifestError("arms are unbalanced: every arm must share one executor")
    if "slice" in data:
        _validate_slice(data)
    if data.get("slice", {}).get("kind") != "recursive" and any(SUBAGENT_TOOL in task.get("tools", []) for task in data["tasks"]):
        raise ManifestError(f"only a recursive slice may give a task the {SUBAGENT_TOOL} tool")


def expand_selection(data: dict[str, Any], path: Path) -> dict[str, Any]:
    """Select from one sibling manifest before validation, hashing and scheduling.

    No inherited selections or path traversal: fixture paths keep their original
    base directory and a selection cannot form an inheritance cycle.
    """
    if "source" not in data:
        return data
    if set(data) - {"schema", "source", "tasks", "arms"} or data.get("schema") != "bench1.selection.v1":
        raise ManifestError("selection must name schema, source and optional task/arm ids")
    source = data["source"]
    if not isinstance(source, str) or not re.fullmatch(r"[A-Za-z0-9_-]+\.json", source):
        raise ManifestError("selection source must be a sibling JSON filename")
    source_path = path.parent / source
    if source_path.resolve().parent != path.parent:
        raise ManifestError("selection source must remain in its directory")
    try:
        selected = json.loads(source_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ManifestError(f"cannot read selection source: {error}") from error
    if not isinstance(selected, dict) or "source" in selected:
        raise ManifestError("selection source must be a full manifest, not another selection")
    for key in ("tasks", "arms"):
        if key not in data:
            continue
        ids = data[key]
        if not isinstance(ids, list) or not ids or not all(isinstance(item, str) for item in ids) or len(ids) != len(set(ids)):
            raise ManifestError(f"selection {key} must be unique, nonempty ids")
        available = selected.get(key)
        if not isinstance(available, list) or not all(isinstance(item, dict) and isinstance(item.get("id"), str) for item in available):
            raise ManifestError(f"selection source has malformed {key}")
        if set(ids) - {item["id"] for item in available}:
            raise ManifestError(f"selection {key} contains unknown ids")
        selected[key] = [item for item in available if item["id"] in ids]
    return selected


def load(path: Path) -> Manifest:
    path = path.resolve()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ManifestError(f"cannot read manifest: {error}") from error
    if not isinstance(data, dict):
        raise ManifestError("manifest must be a JSON object")
    data = expand_selection(data, path)
    try:
        data = presets.expand(data)
    except presets.PresetError as error:
        raise ManifestError(str(error)) from error
    validate(data, path.parent)
    return Manifest(data=data, path=path, hash=sha256_json(data))
