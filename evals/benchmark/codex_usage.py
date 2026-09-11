"""Codex 0.154.0 native rollout accounting.

Only token_usage_record.usage is additive. Turn/thread checkpoints and exec
turn.completed are reconciliation evidence, never extra requests. Native
response IDs are mandatory. Session metadata owns descendant membership.
The CLI loses presence bits for optional token categories, so a native zero
in those fields stays unknown here. See codex-rs/protocol/src/protocol.rs at
6b9826e3aa83b1a5947db50f4332cb9c65f1b340 and token_usage_rollout.rs.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from . import sha256_text, usage
from .native_usage import Adapter, ParentEdge, SessionUsage

VERSION = "0.154.0"
MODEL = "gpt-5.6-sol"
COUNTS = ("input_tokens", "output_tokens", "total_tokens")
LIMITS = {"usage_limit_exceeded", "rate_limit_exceeded"}


class CodexUsageError(ValueError):
    def __init__(self, code: str, detail: str):
        super().__init__(f"{code}: {detail}")
        self.code = code


def rows(path: Path) -> list[tuple[dict[str, Any], str]]:
    if not path.is_file():
        return []
    lines = path.read_text(encoding="utf-8").splitlines(keepends=True)
    result = []
    for index, line in enumerate(lines):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError as error:
            # A killed writer may leave its last line partial. Earlier damage
            # is a contradictory artifact, never a reason to skip spend.
            if index == len(lines) - 1 and not line.endswith("\n"):
                break
            raise CodexUsageError("malformed_row", str(error)) from error
        if not isinstance(row, dict):
            raise CodexUsageError("malformed_row", "rollout row is not an object")
        result.append((row, line))
    return result


def root_id(stream: Path) -> str:
    ids = {row.get("thread_id") for row, _ in rows(stream) if row.get("type") == "thread.started"}
    if len(ids) != 1 or not isinstance(next(iter(ids)), str) or not next(iter(ids)):
        raise CodexUsageError("root_identity", "exec stream must identify exactly one native root")
    return next(iter(ids))


def family(directory: Path, root: str) -> dict[str, tuple[dict[str, Any], list[tuple[dict[str, Any], str]]]]:
    found = {}
    for path in sorted(directory.rglob("*.jsonl")):
        content = rows(path)
        metadata = [row.get("payload") for row, _ in content if row.get("type") == "session_meta"]
        if not metadata:
            continue
        meta = metadata[0]
        if not isinstance(meta, dict) or meta.get("session_id") != root:
            continue
        thread = meta.get("id")
        if not isinstance(thread, str) or not thread or thread in found or any(item != meta for item in metadata):
            raise CodexUsageError("actor_identity", "ambiguous native thread metadata")
        if meta.get("cli_version") != VERSION:
            raise CodexUsageError("version_mismatch", "rollout CLI version differs from the pinned adapter")
        found[thread] = (meta, content)
    if root not in found:
        raise CodexUsageError("root_identity", "root rollout missing")
    for thread, (meta, _) in found.items():
        parent = meta.get("parent_thread_id")
        if (thread == root and parent is not None) or (thread != root and parent not in found):
            raise CodexUsageError("actor_identity", "descendant lacks an explicit parent in this family")
        seen = {thread}
        while parent is not None:
            if parent in seen:
                raise CodexUsageError("actor_identity", "native parent cycle")
            seen.add(parent)
            parent = found[parent][0].get("parent_thread_id")
    return found


def terminal(content) -> dict[str, Any] | None:
    latest = None
    completed = None
    for row, _ in content:
        event = row.get("payload", {})
        if row.get("type") != "event_msg" or not isinstance(event, dict):
            continue
        if event.get("type") in {"task_started", "turn_started"}:
            latest, completed = event.get("turn_id"), None
        elif event.get("type") in {"task_complete", "turn_complete"} and latest and event.get("turn_id") == latest:
            completed = event
    return completed


def scan(directory: Path, root: str, stream: Path | None = None):
    try:
        members = family(directory, root)
    except CodexUsageError:
        return None, [""]
    return terminal(members[root][1]), ["" if thread == root else thread for thread, (_, content) in members.items() if terminal(content) is None]


def count(holder: dict[str, Any], key: str) -> int:
    value = holder.get(key)
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise CodexUsageError("malformed_usage", f"{key} must be a nonnegative native count")
    return value


def error_code(error: Any) -> str | None:
    if not isinstance(error, dict):
        return None
    code = error.get("codex_error_info")
    return code if isinstance(code, str) else (next(iter(code)) if isinstance(code, dict) and len(code) == 1 else None)


@dataclass(frozen=True)
class Envelope:
    subtype: str
    is_error: bool
    num_turns: int
    total_cost_usd: None = None
    capped: bool = False
    cap: str | None = None


def parse_session_dir(directory: Path, root: str, trial_id: str, stream: Path | None = None) -> SessionUsage:
    members = family(directory, root)
    records = []
    actors = [usage.actor_key("codex", root, "" if thread == root else thread) for thread in members]
    edges = []
    mismatch = False
    turns = set()
    for thread, (meta, content) in members.items():
        actor = usage.actor_key("codex", root, "" if thread == root else thread)
        if thread != root:
            parent = meta["parent_thread_id"]
            edges.append(ParentEdge(actor, usage.actor_key("codex", root, "" if parent == root else parent), "native"))
        own = []
        checkpoints = None
        contexts = {}
        for row, line in content:
            payload = row.get("payload", {})
            if not isinstance(payload, dict):
                raise CodexUsageError("malformed_row", "native payload must be an object")
            if row.get("type") == "turn_context":
                contexts[payload.get("turn_id")] = payload.get("model")
            if row.get("type") != "token_usage_record":
                continue
            if payload.get("thread_id") != thread or payload.get("session_id") != root:
                raise CodexUsageError("actor_identity", "usage claims a different native owner")
            turn = payload.get("turn_id")
            if not isinstance(turn, str) or not turn or contexts.get(turn) != MODEL:
                raise CodexUsageError("model_mismatch", "usage has no matching pinned model context")
            turns.add((thread, turn))
            native = payload.get("usage")
            checkpoint = payload.get("thread_token_usage")
            if not isinstance(native, dict) or not isinstance(checkpoint, dict):
                raise CodexUsageError("malformed_usage", "usage/checkpoint missing")
            raw = {key: count(native, key) for key in COUNTS}
            optional = {key: count(native, key) if key in native else 0 for key in ("cached_input_tokens", "cache_write_input_tokens", "reasoning_output_tokens")}
            cache, write, reasoning = (optional[key] or None for key in optional)
            normalized = usage.UsageRecord(
                "codex_rollout", VERSION, trial_id, actor, payload.get("response_id"), raw["input_tokens"],
                None if cache is None or write is None else raw["input_tokens"] - cache - write,
                cache, write, raw["output_tokens"], reasoning, raw["total_tokens"], None, "complete", sha256_text(line))
            normalized.validate()
            own.append(normalized)
            checkpoints = {key: count(checkpoint, key) for key in COUNTS}
        own = usage.dedupe(own)
        if checkpoints is not None:
            mismatch |= checkpoints != {"input_tokens": sum(r.input_total for r in own), "output_tokens": sum(r.output_total for r in own), "total_tokens": sum(r.provider_total for r in own)}
        if terminal(content) is not None and not own:
            mismatch = True
        records.extend(own)
    records = usage.dedupe(records)
    final = terminal(members[root][1])
    envelope = None if final is None else Envelope(error_code(final.get("error")) or ("error" if final.get("error") else "success"), bool(final.get("error")), len(turns))
    if stream is not None:
        events = [row for row, _ in rows(stream) if row.get("type") == "turn.completed"]
        if events:
            expected = events[-1].get("usage", {})
            root_records = [record for record in records if record.actor_key[2] == ""]
            mismatch |= count(expected, "input_tokens") != sum(r.input_total for r in root_records) or count(expected, "output_tokens") != sum(r.output_total for r in root_records)
    status = "mismatch" if mismatch else ("no_envelope" if envelope is None else ("matched_with_descendants" if len(actors) > 1 else "matched"))
    return SessionUsage(root, trial_id, records, actors, edges, envelope, {"status": status}, {}, {"observed_requests": len(records)})


def request_times(directory: Path, root: str) -> dict[str, int]:
    result = {}
    for _, content in family(directory, root).values():
        for row, _ in content:
            if row.get("type") == "token_usage_record":
                try:
                    result[row["payload"]["response_id"]] = int(datetime.fromisoformat(row["timestamp"].replace("Z", "+00:00")).timestamp() * 1000)
                except (KeyError, ValueError, TypeError) as error:
                    raise CodexUsageError("request_timestamp", "capture requires a native request timestamp") from error
    return result


def provider_limit(directory: Path, root: str) -> bool:
    final = terminal(family(directory, root)[root][1])
    return final is not None and error_code(final.get("error")) in LIMITS


def transcript_path(directory: Path, root: str) -> Path:
    for path in sorted(directory.rglob("*.jsonl")):
        if any(row.get("type") == "session_meta" and row.get("payload", {}).get("id") == root for row, _ in rows(path)):
            return path
    return directory / "missing-root.jsonl"


EVIDENCE = Adapter(
    parse=parse_session_dir,
    root=lambda expected, stream: root_id(stream),
    scan=scan,
    transcript=transcript_path,
    times=request_times,
    limited=lambda directory, root, stream: provider_limit(directory, root),
    errors=(CodexUsageError, usage.UsageError),
)
