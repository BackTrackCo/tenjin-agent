"""UsageRecord: one logical model request, in the plan's frozen field set.

A nullable field means the provider did not expose that category. It is never
written as zero, and a subset (cached input, reasoning output) is validated
against its total before anything is summed. Auxiliary receipts are the
benchmark-owned counterpart for memory-product model calls; a native request
id may appear once across both sets or the attempt is invalid.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass
from typing import Any

ActorKey = tuple[str, str, str]  # (harness, root_session_id, native_actor_id)

HARNESSES = frozenset({"claude"})
COMPLETION_STATES = frozenset({"complete", "partial"})
CATEGORIES = ("uncached_input", "cache_read", "cache_write", "reasoning_output_subset")
# Mirrors AGENT_ID_RE in src/lib/grade.ts; '' is the lead.
ACTOR_ID = re.compile(r"^[A-Za-z0-9_-]{0,128}$")


class UsageError(ValueError):
    def __init__(self, code: str, detail: str) -> None:
        super().__init__(f"{code}: {detail}")
        self.code = code
        self.detail = detail


def actor_key(harness: str, root_session_id: str, native_actor_id: str = "") -> ActorKey:
    if harness not in HARNESSES:
        raise UsageError("unknown_harness", f"unknown harness {harness!r}")
    if not isinstance(root_session_id, str) or not root_session_id:
        raise UsageError("bad_actor", "root_session_id must be a non-empty string")
    if not isinstance(native_actor_id, str) or not ACTOR_ID.match(native_actor_id):
        raise UsageError("bad_actor", f"native_actor_id {native_actor_id!r} is not a valid actor id")
    return (harness, root_session_id, native_actor_id)


def _count(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


@dataclass(frozen=True)
class UsageRecord:
    adapter: str
    adapter_version: str
    trial_id: str
    actor_key: ActorKey
    native_request_id: str
    input_total: int
    uncached_input: int | None
    cache_read: int | None
    cache_write: int | None
    output_total: int
    reasoning_output_subset: int | None
    provider_total: int | None
    native_request_cost: float | None
    completion_state: str
    source_hash: str

    def validate(self) -> None:
        actor_key(*self.actor_key)
        for name in ("adapter", "adapter_version", "trial_id", "native_request_id", "source_hash"):
            if not isinstance(getattr(self, name), str) or not getattr(self, name):
                raise UsageError("bad_field", f"{name} must be a non-empty string")
        if self.completion_state not in COMPLETION_STATES:
            raise UsageError("bad_field", f"unknown completion_state {self.completion_state!r}")
        for name in ("input_total", "output_total"):
            if not _count(getattr(self, name)):
                raise UsageError("bad_count", f"{name} must be a non-negative integer")
        for name in (*CATEGORIES, "provider_total"):
            value = getattr(self, name)
            if value is not None and not _count(value):
                raise UsageError("bad_count", f"{name} must be null or a non-negative integer")
        if self.native_request_cost is not None and (
            isinstance(self.native_request_cost, bool)
            or not isinstance(self.native_request_cost, (int, float))
            or self.native_request_cost < 0
        ):
            raise UsageError("bad_count", "native_request_cost must be null or a non-negative number")
        parts = [part for part in (self.uncached_input, self.cache_read, self.cache_write) if part is not None]
        if len(parts) == 3 and sum(parts) != self.input_total:
            raise UsageError("arithmetic", "input categories do not sum to input_total")
        if parts and sum(parts) > self.input_total:
            raise UsageError("arithmetic", "exposed input categories exceed input_total")
        if self.reasoning_output_subset is not None and self.reasoning_output_subset > self.output_total:
            raise UsageError("arithmetic", "reasoning_output_subset exceeds output_total")
        if self.provider_total is not None and self.provider_total < self.input_total + self.output_total:
            raise UsageError("arithmetic", "provider_total is below the observed input and output")

    @property
    def total(self) -> int:
        return self.input_total + self.output_total

    @property
    def counts(self) -> tuple[int | None, ...]:
        return (
            self.input_total,
            self.uncached_input,
            self.cache_read,
            self.cache_write,
            self.output_total,
            self.reasoning_output_subset,
            self.provider_total,
        )

    def to_json(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["actor_key"] = list(self.actor_key)
        return payload


def from_json(payload: dict[str, Any]) -> UsageRecord:
    data = dict(payload)
    try:
        data["actor_key"] = tuple(data["actor_key"])
        record = UsageRecord(**data)
    except (KeyError, TypeError) as error:
        raise UsageError("bad_shape", f"usage record has the wrong shape: {error}") from error
    record.validate()
    return record


@dataclass(frozen=True)
class AuxiliaryReceipt:
    """A memory-product model call the benchmark itself observed for one trial."""

    trial_id: str
    component: str
    phase: str
    native_request_id: str
    input_total: int
    output_total: int
    source_hash: str

    def validate(self) -> None:
        for name in ("trial_id", "component", "phase", "native_request_id", "source_hash"):
            if not isinstance(getattr(self, name), str) or not getattr(self, name):
                raise UsageError("bad_field", f"receipt {name} must be a non-empty string")
        for name in ("input_total", "output_total"):
            if not _count(getattr(self, name)):
                raise UsageError("bad_count", f"receipt {name} must be a non-negative integer")

    def to_json(self) -> dict[str, Any]:
        return asdict(self)


def receipt_from_json(payload: dict[str, Any]) -> AuxiliaryReceipt:
    try:
        receipt = AuxiliaryReceipt(**payload)
    except TypeError as error:
        raise UsageError("bad_shape", f"auxiliary receipt has the wrong shape: {error}") from error
    receipt.validate()
    return receipt


def dedupe(records: list[UsageRecord]) -> list[UsageRecord]:
    """One record per (actor, request).

    The same request seen twice with the same counts (a root-forwarded echo of
    a child row) collapses to the first sighting. Two records for one request
    that disagree, or one request id under two actors, are contradictions and
    fail the attempt rather than counting twice or picking a winner.
    """
    by_key: dict[tuple[ActorKey, str], UsageRecord] = {}
    owner: dict[str, ActorKey] = {}
    unique: list[UsageRecord] = []
    for record in records:
        key = (record.actor_key, record.native_request_id)
        seen = by_key.get(key)
        if seen is not None:
            if seen.counts != record.counts or seen.completion_state != record.completion_state:
                raise UsageError("conflicting_records", f"request {record.native_request_id!r} has conflicting usage records")
            continue
        other = owner.get(record.native_request_id)
        if other is not None and other != record.actor_key:
            raise UsageError("duplicate_request", f"request {record.native_request_id!r} is claimed by two actors")
        owner[record.native_request_id] = record.actor_key
        by_key[key] = record
        unique.append(record)
    return unique


def check_receipts(receipts: list[AuxiliaryReceipt], records: list[UsageRecord]) -> None:
    """Duplicate native ids across receipts, or into the consumer set, fail the attempt."""
    consumer = {record.native_request_id for record in records}
    seen: set[str] = set()
    for receipt in receipts:
        receipt.validate()
        if receipt.native_request_id in seen or receipt.native_request_id in consumer:
            raise UsageError("duplicate_request", f"auxiliary receipt {receipt.native_request_id!r} duplicates a native request id")
        seen.add(receipt.native_request_id)


def totals(records: list[UsageRecord]) -> dict[str, Any]:
    """Sums over deduplicated records.

    A category total is null when any record did not expose it: adding zero for
    an unexposed category would present a lower bound as an observation.
    `unavailable` counts the records that hid each category.
    """
    unique = dedupe(records)
    summary: dict[str, Any] = {
        "requests": len(unique),
        "partial": sum(1 for record in unique if record.completion_state == "partial"),
        "input_total": sum(record.input_total for record in unique),
        "output_total": sum(record.output_total for record in unique),
        "total": sum(record.total for record in unique),
        "unavailable": {},
    }
    for name in CATEGORIES:
        values = [getattr(record, name) for record in unique]
        missing = sum(1 for value in values if value is None)
        summary["unavailable"][name] = missing
        summary[name] = None if missing else sum(values)  # type: ignore[arg-type]
    return summary
