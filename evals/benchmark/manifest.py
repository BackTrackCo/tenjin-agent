"""Frozen run manifest: load, validate, hash.

Manifest values are data. Executor and verifier names select code-owned argv
in `executor.py` and `verifier.py`; no field here is ever shell-evaluated.
Validation runs before any spend, so a bad manifest costs nothing, and the
manifest hash covers every byte the schedule and trial ids derive from.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import corpus as corpus_module, sha256_dir, sha256_json
from .usage import HARNESSES

SCHEMA_VERSION = 1

TOP_KEYS = frozenset(
    {
        "benchmark_version",
        "schema_version",
        "harness",
        "seed",
        "repeats",
        "pins",
        "price_sheet_version",
        "tasks",
        "arms",
    }
)
OPTIONAL_TOP_KEYS = frozenset({"phases", "slice", "corpus"})
PIN_KEYS = frozenset(
    {
        "model",
        "harness_version",
        "effort",
        "image",
        "dependency_lock_hash",
        "permission_mode",
        "wall_clock_s",
        "turn_budget",
    }
)
TASK_KEYS = frozenset({"id", "family", "transfer_distance", "fixture", "fixture_hash", "verifier"})
ARM_KEYS = frozenset({"id", "executor", "product_version", "settings_hash", "memory_snapshot_hash", "auxiliary_usage"})
# What a live executor needs and a fake one has no use for. Coarse shapes are
# checked here so a bad manifest costs nothing; the executor that turns these
# into argv owns the flag and value allowlists (`claude_live.py`).
OPTIONAL_PIN_KEYS = frozenset({"max_budget_usd", "tools", "allowed_tools", "credential_env"})
OPTIONAL_TASK_KEYS = frozenset({"prompt", "tools", "allowed_tools"})
# `lessons` names exactly which lessons a provisioned arm seeds on the team
# shelf (the default is the task's family lesson and its own fix), and
# `producer` runs a producer phase in the same data dir before the consumer.
# `hooks_disabled` names product hook arms the seeded config turns off; the
# provisioner owns which names exist, because they are the product's, not this
# package's. `public_fallback` is the product's `team.publicFallback`, which
# decides whether a team miss then reaches the public marketplace; it defaults
# to the product's own `on`, so an arm that omits it is the product as shipped.
# An arm's static files are `settings.overlay`, validated by the live executor.
OPTIONAL_ARM_KEYS = frozenset({"settings", "provision", "lessons", "producer", "hooks_disabled", "public_fallback"})
# The product's own values for `team.publicFallback`. `off` is the exact string
# `src/hooks/ask.ts` reads to drop the public-only legs.
PUBLIC_FALLBACK = frozenset({"on", "off"})
PHASE_KEYS = frozenset({"producer", "capture", "consumer"})
SLICE_KINDS = frozenset({"recursive"})
SLICE_KEYS = {"recursive": frozenset({"kind"})}
SUBAGENT_TOOL = "Agent"
TRANSFER_DISTANCES = frozenset({"none", "same_task", "same_family", "cross_family"})
# What an arm's memory product can prove about its own model spend. `none` is a
# claim that it spends no model tokens outside the harness session; `exposed`
# means it emits auxiliary receipts; `unexposed` is an arm whose spend the
# benchmark cannot see, which the reducer keeps out of the headline. There is
# no default: silence about auxiliary spend is the failure this field names.
AUXILIARY_EXPOSURE = frozenset({"none", "exposed", "unexposed"})

# Ids appear in publishable output, so they are opaque tokens by construction.
ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
# A version a later run could resolve differently is not a pin.
UNPINNED = ("latest", "*", "^", "~", ">", "<")


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

    def fixture_path(self, task: dict[str, Any]) -> Path:
        return (self.path.parent / task["fixture"]).resolve()

    @property
    def slice(self) -> dict[str, Any] | None:
        return None if "slice" not in self.data else dict(self.data["slice"])

    @property
    def corpus(self) -> corpus_module.Corpus | None:
        """The database branch a run resets before its first trial, when it names one."""
        if "corpus" not in self.data:
            return None
        return corpus_module.parse(self.data["corpus"])


def fixture_hash(fixture: Path) -> str:
    """The committed fixture files. The dependency tree is the image's, and the image is labelled with this hash."""
    return "sha256:" + sha256_dir(fixture)


def _pinned(value: Any) -> bool:
    return isinstance(value, str) and value.strip() != "" and not value.startswith(UNPINNED)


def _hash_token(value: Any) -> bool:
    return isinstance(value, str) and value.startswith("sha256:") and len(value) > len("sha256:")


def _require_keys(name: str, item: Any, allowed: frozenset[str], optional: frozenset[str] = frozenset()) -> None:
    if not isinstance(item, dict):
        raise ManifestError(f"{name} must be an object")
    unknown = sorted(set(item) - allowed - optional)
    missing = sorted(allowed - set(item))
    if unknown:
        raise ManifestError(f"{name} has unknown keys: {', '.join(unknown)}")
    if missing:
        raise ManifestError(f"{name} is missing keys: {', '.join(missing)}")


def _require_id(name: str, value: Any) -> str:
    if not isinstance(value, str) or not ID.match(value):
        raise ManifestError(f"{name} id {value!r} is not an opaque token")
    return value


def _require_count(name: str, value: Any, minimum: int = 0) -> None:
    if not isinstance(value, int) or isinstance(value, bool) or value < minimum:
        raise ManifestError(f"{name} must be an integer of at least {minimum}")


def _require_optional_shapes(name: str, item: dict[str, Any]) -> None:
    """Coarse types for the optional live fields, before any of them is an argument."""
    for key in ("prompt", "credential_env"):
        if key in item and (not isinstance(item[key], str) or not item[key].strip()):
            raise ManifestError(f"{name}.{key} must be a non-empty string")
    for key in ("tools", "allowed_tools"):
        if key in item and not (isinstance(item[key], list) and all(isinstance(value, str) for value in item[key])):
            raise ManifestError(f"{name}.{key} must be a list of strings")
    if "settings" in item and not isinstance(item["settings"], dict):
        raise ManifestError(f"{name}.settings must be an object")
    if "provision" in item:
        _require_id(f"{name} provision", item["provision"])
    if "lessons" in item:
        if not isinstance(item["lessons"], list) or not item["lessons"]:
            raise ManifestError(f"{name}.lessons must be a non-empty list of lesson ids")
        for lesson in item["lessons"]:
            _require_id(f"{name} lesson", lesson)
    if "producer" in item and not isinstance(item["producer"], bool):
        raise ManifestError(f"{name}.producer must be true or false")
    if "producer" in item and not item.get("provision"):
        raise ManifestError(f"{name}.producer needs a provisioned arm")
    if "hooks_disabled" in item:
        if not isinstance(item["hooks_disabled"], list) or not item["hooks_disabled"]:
            raise ManifestError(f"{name}.hooks_disabled must be a non-empty list of product hook arm names")
        for arm in item["hooks_disabled"]:
            _require_id(f"{name} hooks_disabled", arm)
        if not item.get("provision"):
            raise ManifestError(f"{name}.hooks_disabled needs a provisioned arm: there is no seeded config to write it into")
        if item.get("producer"):
            raise ManifestError(f"{name} runs a producer phase, so it captures: an arm that captures keeps every hook arm the product ships on")
    if "public_fallback" in item:
        if item["public_fallback"] not in PUBLIC_FALLBACK:
            raise ManifestError(f"{name}.public_fallback must be one of {', '.join(sorted(PUBLIC_FALLBACK))}")
        if not item.get("provision"):
            raise ManifestError(f"{name}.public_fallback needs a provisioned arm: there is no seeded config to write it into")
    budget = item.get("max_budget_usd")
    if "max_budget_usd" in item and (isinstance(budget, bool) or not isinstance(budget, (int, float)) or budget <= 0):
        raise ManifestError(f"{name}.max_budget_usd must be a positive number")


def _validate_slice(data: dict[str, Any]) -> None:
    """A slice is one named variation of a local run, with exactly the fields its kind needs."""
    item = data["slice"]
    if not isinstance(item, dict) or item.get("kind") not in SLICE_KINDS:
        raise ManifestError(f"slice.kind must be one of {', '.join(sorted(SLICE_KINDS))}")
    kind = item["kind"]
    if set(item) != SLICE_KEYS[kind]:
        raise ManifestError(f"slice {kind!r} carries exactly {', '.join(sorted(SLICE_KEYS[kind]))}")
    if kind == "recursive" and not any(SUBAGENT_TOOL in task.get("tools", []) for task in data["tasks"]):
        raise ManifestError(f"a recursive slice needs a task whose tools include {SUBAGENT_TOOL}")


def validate(data: dict[str, Any], base: Path) -> None:
    _require_keys("manifest", data, TOP_KEYS, OPTIONAL_TOP_KEYS)
    if data["schema_version"] != SCHEMA_VERSION:
        raise ManifestError(f"schema_version must be {SCHEMA_VERSION}")
    if data["harness"] not in HARNESSES:
        raise ManifestError(f"harness must be one of {', '.join(sorted(HARNESSES))}")
    if not _pinned(data["benchmark_version"]) or not _pinned(data["price_sheet_version"]):
        raise ManifestError("benchmark_version and price_sheet_version must be pinned")
    _require_count("seed", data["seed"])
    _require_count("repeats", data["repeats"], 1)
    pins = data["pins"]
    _require_keys("pins", pins, PIN_KEYS, OPTIONAL_PIN_KEYS)
    _require_optional_shapes("pins", pins)
    for key in ("model", "harness_version", "effort", "image", "permission_mode"):
        if not _pinned(pins[key]):
            raise ManifestError(f"pins.{key} is not pinned")
    if not _hash_token(pins["dependency_lock_hash"]):
        raise ManifestError("pins.dependency_lock_hash must be a sha256 token")
    _require_count("pins.wall_clock_s", pins["wall_clock_s"], 1)
    _require_count("pins.turn_budget", pins["turn_budget"], 1)
    if "corpus" in data:
        try:
            corpus_module.parse(data["corpus"])
        except corpus_module.CorpusError as error:
            raise ManifestError(error.detail) from error
    if "phases" in data:
        _require_keys("phases", data["phases"], PHASE_KEYS)
        for key in PHASE_KEYS:
            if not _pinned(data["phases"][key]):
                raise ManifestError(f"phases.{key} must be a non-empty label")
    if not isinstance(data["tasks"], list) or not data["tasks"]:
        raise ManifestError("tasks must be a non-empty list")
    if not isinstance(data["arms"], list) or len(data["arms"]) < 2:
        raise ManifestError("arms must list at least two arms")
    seen: set[str] = set()
    for task in data["tasks"]:
        _require_keys("task", task, TASK_KEYS, OPTIONAL_TASK_KEYS)
        _require_optional_shapes("task", task)
        task_id = _require_id("task", task["id"])
        if task_id in seen:
            raise ManifestError(f"duplicate task id {task_id!r}")
        seen.add(task_id)
        _require_id("task family", task["family"])
        _require_id("task verifier", task["verifier"])
        if task["transfer_distance"] not in TRANSFER_DISTANCES:
            raise ManifestError(f"task {task_id!r} transfer_distance is unknown")
        relative = task["fixture"]
        if not isinstance(relative, str) or not relative or Path(relative).is_absolute() or ".." in Path(relative).parts:
            raise ManifestError(f"task {task_id!r} fixture must be a relative path inside the manifest directory")
        fixture = base / relative
        if not fixture.is_dir():
            raise ManifestError(f"task {task_id!r} fixture path is missing: {relative}")
        if task["fixture_hash"] != fixture_hash(fixture):
            raise ManifestError(f"task {task_id!r} fixture_hash does not match the fixture directory")
    seen.clear()
    executors: set[str] = set()
    for arm in data["arms"]:
        _require_keys("arm", arm, ARM_KEYS, OPTIONAL_ARM_KEYS)
        _require_optional_shapes("arm", arm)
        arm_id = _require_id("arm", arm["id"])
        if arm_id in seen:
            raise ManifestError(f"duplicate arm id {arm_id!r}")
        seen.add(arm_id)
        _require_id("arm executor", arm["executor"])
        if not _pinned(arm["product_version"]):
            raise ManifestError(f"arm {arm_id!r} product_version is not pinned")
        for key in ("settings_hash", "memory_snapshot_hash"):
            if not _hash_token(arm[key]):
                raise ManifestError(f"arm {arm_id!r} {key} must be a sha256 token")
        if arm["auxiliary_usage"] not in AUXILIARY_EXPOSURE:
            raise ManifestError(f"arm {arm_id!r} auxiliary_usage must be one of {', '.join(sorted(AUXILIARY_EXPOSURE))}")
        executors.add(arm["executor"])
    # Arms that run different executors measure different harnesses, so their
    # token totals would not be comparable under one manifest.
    if len(executors) != 1:
        raise ManifestError("arms are unbalanced: every arm must share one executor")
    if "slice" in data:
        _validate_slice(data)
    if data.get("slice", {}).get("kind") != "recursive" and any(SUBAGENT_TOOL in task.get("tools", []) for task in data["tasks"]):
        raise ManifestError(f"only a recursive slice may give a task the {SUBAGENT_TOOL} tool")


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
