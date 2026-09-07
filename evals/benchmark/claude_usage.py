"""Claude JSONL usage adapter: transcript rows -> UsageRecords.

Claude repeats partial and final assistant rows for one request, so rows are
grouped by native `requestId` (message id as the fallback) and one record per
group is emitted. Rows are never summed. Group A freezes the exact selection
and rejection rules against sanitized fixtures; this is the minimal shape.
"""

from __future__ import annotations

import json
from pathlib import Path

from . import sha256_text
from .usage import ActorKey, UsageRecord

ADAPTER = "claude_jsonl"
ADAPTER_VERSION = "0"
HARNESS = "claude"


class ClaudeUsageError(ValueError):
    pass


def _usage_rows(path: Path) -> dict[str, list[dict]]:
    groups: dict[str, list[dict]] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError as error:
            raise ClaudeUsageError(f"{path.name}: malformed row: {error}") from error
        if event.get("type") != "assistant" or not isinstance(event.get("message"), dict):
            continue
        message = event["message"]
        if not isinstance(message.get("usage"), dict):
            continue
        key = event.get("requestId") or message.get("id")
        if not isinstance(key, str) or not key:
            raise ClaudeUsageError(f"{path.name}: assistant row without requestId or message id")
        groups.setdefault(key, []).append({"usage": message["usage"], "line": line})
    return groups


def parse_transcript(path: Path, trial_id: str, actor_key: ActorKey) -> list[UsageRecord]:
    records: list[UsageRecord] = []
    for request_id, rows in _usage_rows(path).items():
        final = rows[-1]["usage"]
        uncached = int(final.get("input_tokens", 0) or 0)
        cache_read = final.get("cache_read_input_tokens")
        cache_write = final.get("cache_creation_input_tokens")
        cache_read = int(cache_read) if cache_read is not None else None
        cache_write = int(cache_write) if cache_write is not None else None
        record = UsageRecord(
            adapter=ADAPTER,
            adapter_version=ADAPTER_VERSION,
            trial_id=trial_id,
            actor_key=actor_key,
            native_request_id=request_id,
            input_total=uncached + (cache_read or 0) + (cache_write or 0),
            uncached_input=uncached,
            cache_read=cache_read,
            cache_write=cache_write,
            output_total=int(final.get("output_tokens", 0) or 0),
            reasoning_output_subset=None,
            provider_total=None,
            native_request_cost=None,
            completion_state="complete",
            source_hash=sha256_text(rows[-1]["line"]),
        )
        record.validate()
        records.append(record)
    return records


def parse_session_dir(sessions: Path, root_session_id: str, trial_id: str) -> list[UsageRecord]:
    """Root transcript is actor ''; each `subagents/agent-<id>.jsonl` is one child actor."""
    root = sessions / f"{root_session_id}.jsonl"
    if not root.is_file():
        raise ClaudeUsageError(f"root transcript missing for session {root_session_id}")
    records = parse_transcript(root, trial_id, (HARNESS, root_session_id, ""))
    for child in sorted((sessions / root_session_id / "subagents").glob("agent-*.jsonl")):
        agent_id = child.stem.removeprefix("agent-")
        records.extend(parse_transcript(child, trial_id, (HARNESS, root_session_id, agent_id)))
    return records
