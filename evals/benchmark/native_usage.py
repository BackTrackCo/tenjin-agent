"""Harness-independent normalized session evidence; native parsers own envelopes."""
from __future__ import annotations
from dataclasses import dataclass
from typing import Any
from .usage import ActorKey, UsageRecord

@dataclass(frozen=True)
class ParentEdge:
    child: ActorKey
    parent: ActorKey
    provenance: str


@dataclass
class SessionUsage:
    root_session_id: str
    trial_id: str
    records: list[UsageRecord]
    actors: list[ActorKey]
    parent_edges: list[ParentEdge]
    envelope: Any | None
    reconciliation: dict[str, Any]
    tool_counts: dict[str, dict[str, int]]
    diagnostics: dict[str, int]

    @property
    def settled(self) -> bool:
        return self.envelope is not None

    @property
    def invalid_reason(self) -> str | None:
        status = self.reconciliation["status"]
        if status in ("mismatch", "envelope_without_usage"):
            return f"usage:{status}"
        return None

    def record_fields(self) -> dict[str, Any]:
        """The usage-derived slice of an attempt record, built one way everywhere."""
        return {
            "native_root_id": self.root_session_id,
            "actors": self.actor_entries(),
            "parent_edges": [
                {"child": list(edge.child), "parent": list(edge.parent), "provenance": edge.provenance}
                for edge in self.parent_edges
            ],
            "usage": [record.to_json() for record in self.records],
            "usage_reconciliation": self.reconciliation,
            "tool_counts": self.tool_counts,
            "turns": None if self.envelope is None else self.envelope.num_turns,
            "cost_usd": None if self.envelope is None else self.envelope.total_cost_usd,
        }

    def actor_entries(self) -> list[dict[str, Any]]:
        parents = {edge.child: edge for edge in self.parent_edges}
        entries = []
        for actor in self.actors:
            edge = parents.get(actor)
            entries.append(
                {
                    "key": list(actor),
                    "parent_actor_key": None if edge is None else list(edge.parent),
                    "parent_provenance": "unavailable" if edge is None else edge.provenance,
                }
            )
        return entries

