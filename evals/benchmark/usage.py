"""UsageRecord: one logical model request, in the plan's frozen field set.

A nullable field means the provider did not expose that category. It is never
written as zero, and a subset (cached input, reasoning output) is validated
against its total before anything is summed.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any

ActorKey = tuple[str, str, str]  # (harness, root_session_id, native_actor_id)

COMPLETION_STATES = frozenset({"complete", "partial"})


class UsageError(ValueError):
    pass


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
        if self.completion_state not in COMPLETION_STATES:
            raise UsageError(f"unknown completion_state {self.completion_state!r}")
        for name in ("input_total", "output_total"):
            if not _count(getattr(self, name)):
                raise UsageError(f"{name} must be a non-negative integer")
        for name in ("uncached_input", "cache_read", "cache_write", "reasoning_output_subset"):
            value = getattr(self, name)
            if value is not None and not _count(value):
                raise UsageError(f"{name} must be null or a non-negative integer")
        parts = (self.uncached_input, self.cache_read, self.cache_write)
        if all(part is not None for part in parts) and sum(parts) != self.input_total:  # type: ignore[arg-type]
            raise UsageError("input categories do not sum to input_total")
        if self.reasoning_output_subset is not None and self.reasoning_output_subset > self.output_total:
            raise UsageError("reasoning_output_subset exceeds output_total")
        if self.provider_total is not None and self.provider_total < self.input_total + self.output_total:
            raise UsageError("provider_total is below the observed input and output")

    @property
    def total(self) -> int:
        return self.input_total + self.output_total

    def to_json(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["actor_key"] = list(self.actor_key)
        return payload


def _count(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def from_json(payload: dict[str, Any]) -> UsageRecord:
    data = dict(payload)
    data["actor_key"] = tuple(data["actor_key"])
    record = UsageRecord(**data)
    record.validate()
    return record


def dedupe(records: list[UsageRecord]) -> list[UsageRecord]:
    """Two records for one (actor, request) are the same request seen twice."""
    seen: set[tuple[ActorKey, str]] = set()
    unique: list[UsageRecord] = []
    for record in records:
        key = (record.actor_key, record.native_request_id)
        if key in seen:
            continue
        seen.add(key)
        unique.append(record)
    return unique


def totals(records: list[UsageRecord]) -> dict[str, int]:
    unique = dedupe(records)
    return {
        "requests": len(unique),
        "input_total": sum(record.input_total for record in unique),
        "output_total": sum(record.output_total for record in unique),
        "total": sum(record.total for record in unique),
    }
