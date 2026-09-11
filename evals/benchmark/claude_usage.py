"""Claude JSONL usage adapter: transcript rows -> UsageRecords.

The shapes are frozen against the sanitized fixtures under
`fixtures/claude/sessions/`, modelled on Claude Code stream-json and persisted
session transcripts:

- an `assistant` row carries `message.id` and `message.usage` with
  `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`,
  `output_tokens`, optional `output_tokens_details.thinking_tokens`, optional
  `cache_creation.ephemeral_*` detail, and optional `usage.iterations` (the
  native retry shape: one entry per provider call the request needed);
- one request repeats partial and final rows; rows group by `requestId` with
  `message.id` as the documented fallback, and the group's last row is the
  record. Rows are never summed;
- a `result` row is the envelope: `subtype`, `is_error`, `num_turns`,
  `total_cost_usd`, `usage`, `modelUsage`. The root's selected records must
  reconcile with it or the attempt is invalid. A budget or turn cap ends the
  session before the envelope is complete: its totals then fall below the
  transcript's in every category, the per-actor rows stay the authoritative
  count, and the envelope is kept as `partial` rather than failing the
  attempt;
- a child transcript is `<root>/subagents/agent-<id>.jsonl`; its rows may name
  the same id in `agentId` and the dispatching tool call in
  `parent_tool_use_id`, which is the only source of a parent edge.

Every rejection raises `ClaudeUsageError` with a stable `code`, so the runner
can record an invalid attempt with a machine-readable reason.
"""

from __future__ import annotations

from .native_usage import ParentEdge, SessionUsage

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import sha256_text
from .usage import ActorKey, UsageError, UsageRecord, actor_key, dedupe

ADAPTER = "claude_jsonl"
ADAPTER_VERSION = "1"
HARNESS = "claude"
SYNTHETIC_MODEL = "<synthetic>"
NATIVE = ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens")
MODEL_USAGE = {
    "input_tokens": "inputTokens",
    "cache_creation_input_tokens": "cacheCreationInputTokens",
    "cache_read_input_tokens": "cacheReadInputTokens",
    "output_tokens": "outputTokens",
}
ITERATION_TYPES = frozenset({"message", "fallback_message"})
# The harness's own stops, and the stop reason each one records.
CAPPED_SUBTYPES = {"error_max_budget_usd": "budget", "error_max_turns": "turns"}


class ClaudeUsageError(ValueError):
    def __init__(self, code: str, detail: str) -> None:
        super().__init__(f"{code}: {detail}")
        self.code = code


def _count(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _optional_count(holder: dict[str, Any], key: str, where: str) -> int | None:
    value = holder.get(key)
    if value is None:
        return None
    if not _count(value):
        raise ClaudeUsageError("malformed_usage", f"{where}: {key} must be null or a non-negative integer")
    return value


def _required_count(holder: dict[str, Any], key: str, where: str) -> int:
    value = holder.get(key)
    if not _count(value):
        raise ClaudeUsageError("malformed_usage", f"{where}: {key} must be a non-negative integer")
    return value


@dataclass(frozen=True)
class NativeUsage:
    input_tokens: int
    cache_creation: int | None
    cache_read: int | None
    output_tokens: int
    thinking: int | None
    iterations: int

    @property
    def inputs(self) -> tuple[int, int | None, int | None]:
        return (self.input_tokens, self.cache_creation, self.cache_read)

    def category(self, name: str) -> int | None:
        return {
            "input_tokens": self.input_tokens,
            "cache_creation_input_tokens": self.cache_creation,
            "cache_read_input_tokens": self.cache_read,
            "output_tokens": self.output_tokens,
        }[name]


def native_usage(usage: Any, where: str) -> NativeUsage:
    """Validate one native usage object before any of it is normalized."""
    if not isinstance(usage, dict):
        raise ClaudeUsageError("malformed_usage", f"{where}: usage must be an object")
    parsed = NativeUsage(
        input_tokens=_required_count(usage, "input_tokens", where),
        cache_creation=_optional_count(usage, "cache_creation_input_tokens", where),
        cache_read=_optional_count(usage, "cache_read_input_tokens", where),
        output_tokens=_required_count(usage, "output_tokens", where),
        thinking=None,
        iterations=0,
    )
    details = usage.get("output_tokens_details")
    thinking = None
    if details is not None:
        if not isinstance(details, dict):
            raise ClaudeUsageError("malformed_usage", f"{where}: output_tokens_details must be an object")
        thinking = _optional_count(details, "thinking_tokens", where)
        if thinking is not None and thinking > parsed.output_tokens:
            raise ClaudeUsageError("malformed_usage", f"{where}: thinking_tokens exceed output_tokens")
    detail = usage.get("cache_creation")
    if isinstance(detail, dict):
        parts = [_optional_count(detail, key, where) for key in ("ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens")]
        if all(part is not None for part in parts) and parsed.cache_creation is not None:
            if sum(part for part in parts if part is not None) != parsed.cache_creation:
                raise ClaudeUsageError("malformed_usage", f"{where}: cache_creation detail does not sum to cache_creation_input_tokens")
    iterations = usage.get("iterations")
    count = 0
    if iterations is not None:
        if not isinstance(iterations, list):
            raise ClaudeUsageError("malformed_usage", f"{where}: iterations must be a list")
        sums: dict[str, int] = {name: 0 for name in NATIVE}
        for index, item in enumerate(iterations):
            if not isinstance(item, dict) or item.get("type") not in ITERATION_TYPES:
                raise ClaudeUsageError("malformed_usage", f"{where}: iterations[{index}] has an unknown shape")
            for name in NATIVE:
                value = item.get(name)
                if value is None:
                    continue
                if not _count(value):
                    raise ClaudeUsageError("malformed_usage", f"{where}: iterations[{index}].{name} is not a count")
                sums[name] += value
            count += 1
        if count:
            # The top-level usage is what the provider billed for the request;
            # iterations explain it retry by retry and must add up to it.
            for name in NATIVE:
                top = parsed.category(name)
                if top is not None and sums[name] != top:
                    raise ClaudeUsageError("iterations_mismatch", f"{where}: iterations do not sum to {name}")
    return NativeUsage(
        input_tokens=parsed.input_tokens,
        cache_creation=parsed.cache_creation,
        cache_read=parsed.cache_read,
        output_tokens=parsed.output_tokens,
        thinking=thinking,
        iterations=count,
    )


@dataclass(frozen=True)
class Envelope:
    subtype: str
    is_error: bool
    num_turns: int | None
    total_cost_usd: float | None
    usage: dict[str, int | None] | None
    model_usage: dict[str, dict[str, int | None]]
    source_hash: str

    @property
    def capped(self) -> bool:
        return self.subtype in CAPPED_SUBTYPES

    @property
    def cap(self) -> str | None:
        """The stop reason a capped envelope names: `budget` or `turns`."""
        return CAPPED_SUBTYPES.get(self.subtype)

    def to_json(self) -> dict[str, Any]:
        return {
            "subtype": self.subtype,
            "is_error": self.is_error,
            "num_turns": self.num_turns,
            "total_cost_usd": self.total_cost_usd,
            "usage": self.usage,
            "models": sorted(self.model_usage),
            "source_hash": self.source_hash,
        }


def _envelope(event: dict[str, Any], line: str, where: str) -> Envelope:
    subtype = event.get("subtype")
    if not isinstance(subtype, str) or not subtype:
        raise ClaudeUsageError("malformed_row", f"{where}: result row without subtype")
    is_error = event.get("is_error", False)
    if not isinstance(is_error, bool):
        raise ClaudeUsageError("malformed_row", f"{where}: result is_error must be a boolean")
    num_turns = event.get("num_turns")
    if num_turns is not None and not _count(num_turns):
        raise ClaudeUsageError("malformed_row", f"{where}: result num_turns is not a count")
    cost = event.get("total_cost_usd")
    if cost is not None and (isinstance(cost, bool) or not isinstance(cost, (int, float)) or cost < 0):
        raise ClaudeUsageError("malformed_row", f"{where}: result total_cost_usd is not a non-negative number")
    usage = None
    if event.get("usage") is not None:
        raw = event["usage"]
        if not isinstance(raw, dict):
            raise ClaudeUsageError("malformed_row", f"{where}: result usage must be an object")
        usage = {name: _optional_count(raw, name, where) for name in NATIVE}
    model_usage: dict[str, dict[str, int | None]] = {}
    raw_models = event.get("modelUsage")
    if raw_models is not None:
        if not isinstance(raw_models, dict):
            raise ClaudeUsageError("malformed_row", f"{where}: result modelUsage must be an object")
        for model, entry in raw_models.items():
            if not isinstance(model, str) or not isinstance(entry, dict):
                raise ClaudeUsageError("malformed_row", f"{where}: result modelUsage entry has an unknown shape")
            model_usage[model] = {name: _optional_count(entry, native, where) for name, native in MODEL_USAGE.items()}
    return Envelope(
        subtype=subtype,
        is_error=is_error,
        num_turns=num_turns,
        total_cost_usd=None if cost is None else float(cost),
        usage=usage,
        model_usage=model_usage,
        source_hash=sha256_text(line),
    )


@dataclass(frozen=True)
class Fragment:
    key: str
    message_id: str | None
    actor: ActorKey
    model: str | None
    usage: NativeUsage
    stop_reason: str | None
    line: str
    line_no: int


@dataclass
class Transcript:
    path: Path
    file_actor: ActorKey
    records: list[UsageRecord] = field(default_factory=list)
    actors: set[ActorKey] = field(default_factory=set)
    envelope: Envelope | None = None
    tool_uses: dict[str, ActorKey] = field(default_factory=dict)
    tool_names: dict[ActorKey, dict[str, int]] = field(default_factory=dict)
    parent_refs: dict[ActorKey, set[str]] = field(default_factory=dict)
    models: dict[ActorKey, set[str]] = field(default_factory=dict)
    diagnostics: dict[str, int] = field(default_factory=dict)


def _row_actor(event: dict[str, Any], transcript: Transcript, root_session_id: str, where: str) -> ActorKey:
    for key in ("session_id", "sessionId"):
        session = event.get(key)
        if session is not None and session != root_session_id:
            raise ClaudeUsageError("session_mismatch", f"{where}: row belongs to another session")
    agent = event.get("agentId")
    file_agent = transcript.file_actor[2]
    if agent is None:
        sidechain = event.get("isSidechain") is True or event.get("parent_tool_use_id") is not None
        if file_agent == "" and sidechain:
            # A child's request echoed into the root without naming the child
            # cannot be attributed to any actor, so it cannot be counted once.
            raise ClaudeUsageError("sidechain_without_agent", f"{where}: sidechain row without agentId")
        return transcript.file_actor
    try:
        actor = actor_key(HARNESS, root_session_id, agent if isinstance(agent, str) else "\0")
    except UsageError as error:
        raise ClaudeUsageError("actor_mismatch", f"{where}: {error}") from error
    if file_agent and actor[2] != file_agent:
        raise ClaudeUsageError("actor_mismatch", f"{where}: row names agent {actor[2]!r} inside transcript {file_agent!r}")
    return actor


def _bump(counter: dict[str, int], key: str, by: int = 1) -> None:
    counter[key] = counter.get(key, 0) + by


def parse_transcript(path: Path, trial_id: str, file_actor: ActorKey) -> Transcript:
    root_session_id = file_actor[1]
    transcript = Transcript(path=path, file_actor=file_actor)
    transcript.actors.add(file_actor)
    groups: dict[str, list[Fragment]] = {}
    message_keys: dict[str, str] = {}
    after_result = False
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeDecodeError) as error:
        raise ClaudeUsageError("unreadable_transcript", f"{path.name}: {error}") from error
    for line_no, line in enumerate(lines, start=1):
        if not line.strip():
            continue
        where = f"{path.name}:{line_no}"
        try:
            event = json.loads(line)
        except json.JSONDecodeError as error:
            raise ClaudeUsageError("malformed_row", f"{where}: {error.msg}") from error
        if not isinstance(event, dict):
            raise ClaudeUsageError("malformed_row", f"{where}: row is not an object")
        if after_result:
            raise ClaudeUsageError("rows_after_result", f"{where}: row after the result envelope")
        _bump(transcript.diagnostics, "rows")
        kind = event.get("type")
        if kind == "result":
            transcript.envelope = _envelope(event, line, where)
            after_result = True
            continue
        if kind != "assistant":
            continue
        message = event.get("message")
        if not isinstance(message, dict):
            raise ClaudeUsageError("malformed_row", f"{where}: assistant row without message")
        actor = _row_actor(event, transcript, root_session_id, where)
        model = message.get("model") if isinstance(message.get("model"), str) else None
        if model == SYNTHETIC_MODEL:
            _bump(transcript.diagnostics, "synthetic_rows")
            continue
        if "usage" not in message:
            raise ClaudeUsageError("assistant_without_usage", f"{where}: assistant row without usage")
        usage = native_usage(message["usage"], where)
        request_id = event.get("requestId")
        message_id = message.get("id")
        if isinstance(request_id, str) and request_id:
            key = request_id
        elif isinstance(message_id, str) and message_id:
            key = message_id
        else:
            raise ClaudeUsageError("row_without_request_key", f"{where}: assistant row without requestId or message id")
        if not isinstance(message_id, str) or not message_id:
            message_id = None
        if message_id is not None and message_keys.setdefault(message_id, key) != key:
            raise ClaudeUsageError("message_id_reused", f"{where}: message id appears under two request keys")
        transcript.actors.add(actor)
        transcript.models.setdefault(actor, set())
        if model is not None:
            transcript.models[actor].add(model)
        parent = event.get("parent_tool_use_id")
        if parent is not None:
            if not isinstance(parent, str) or not parent:
                raise ClaudeUsageError("malformed_row", f"{where}: parent_tool_use_id must be a string")
            transcript.parent_refs.setdefault(actor, set()).add(parent)
        content = message.get("content")
        for block in content if isinstance(content, list) else []:
            if not isinstance(block, dict) or block.get("type") != "tool_use":
                continue
            tool_id, name = block.get("id"), block.get("name")
            if not isinstance(tool_id, str) or not tool_id or not isinstance(name, str):
                raise ClaudeUsageError("malformed_row", f"{where}: tool_use block without id or name")
            if tool_id in transcript.tool_uses:
                if transcript.tool_uses[tool_id] != actor:
                    raise ClaudeUsageError("tool_use_reused", f"{where}: tool_use id issued by two actors")
                continue  # the same block repeated on a later fragment of one message
            transcript.tool_uses[tool_id] = actor
            names = transcript.tool_names.setdefault(actor, {})
            names[name] = names.get(name, 0) + 1
        stop_reason = message.get("stop_reason")
        if stop_reason is not None and not isinstance(stop_reason, str):
            raise ClaudeUsageError("malformed_row", f"{where}: stop_reason must be null or a string")
        groups.setdefault(key, []).append(Fragment(key, message_id, actor, model, usage, stop_reason, line, line_no))
    for key, fragments in groups.items():
        transcript.records.append(_select(fragments, trial_id, transcript, path.name))
    transcript.diagnostics["requests"] = len(groups)
    transcript.diagnostics["fragments"] = sum(len(fragments) for fragments in groups.values())
    return transcript


def _select(fragments: list[Fragment], trial_id: str, transcript: Transcript, name: str) -> UsageRecord:
    """One complete final usage record per request group, or a rejection.

    Partial rows are prefixes of the final row: identical input categories and
    non-decreasing output. Anything else is two different requests wearing one
    key, which cannot be resolved by choosing.
    """
    where = f"{name}:{fragments[-1].line_no}"
    key = fragments[0].key
    if len({fragment.actor for fragment in fragments}) != 1:
        raise ClaudeUsageError("mixed_actors", f"{where}: request {key!r} spans two actors")
    if len({fragment.message_id for fragment in fragments if fragment.message_id is not None}) > 1:
        raise ClaudeUsageError("mixed_message_ids", f"{where}: request {key!r} carries two message ids")
    if len({fragment.usage.inputs for fragment in fragments}) != 1:
        raise ClaudeUsageError("input_disagreement", f"{where}: request {key!r} fragments disagree on input categories")
    outputs = [fragment.usage.output_tokens for fragment in fragments]
    if any(later < earlier for earlier, later in zip(outputs, outputs[1:])):
        raise ClaudeUsageError("output_regressed", f"{where}: request {key!r} output_tokens decreased between rows")
    final = fragments[-1]
    complete = transcript.envelope is not None or any(fragment.stop_reason is not None for fragment in fragments)
    _bump(transcript.diagnostics, "retries", max(final.usage.iterations - 1, 0))
    usage = final.usage
    record = UsageRecord(
        adapter=ADAPTER,
        adapter_version=ADAPTER_VERSION,
        trial_id=trial_id,
        actor_key=final.actor,
        native_request_id=key,
        input_total=usage.input_tokens + (usage.cache_read or 0) + (usage.cache_creation or 0),
        uncached_input=usage.input_tokens,
        cache_read=usage.cache_read,
        cache_write=usage.cache_creation,
        output_total=usage.output_tokens,
        reasoning_output_subset=usage.thinking,
        provider_total=None,
        native_request_cost=None,
        completion_state="complete" if complete else "partial",
        source_hash=sha256_text(final.line),
    )
    try:
        record.validate()
    except UsageError as error:
        raise ClaudeUsageError("malformed_usage", f"{where}: {error}") from error
    return record



def _child_id(path: Path) -> str:
    return path.stem.removeprefix("agent-")


def stream_envelope(stream: Path | None, trial_id: str) -> Envelope | None:
    """The `result` envelope from the harness's captured stdout, if it is there.

    Only the envelope is taken. The stream also repeats the assistant rows the
    transcript already holds, and counting those again would inflate every
    attempt, so this reads one row type and no other.
    """
    if stream is None or not stream.is_file():
        return None
    for line in stream.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError as error:
            raise ClaudeUsageError("stream_unparsable", f"{stream.name}: {error}") from error
        if isinstance(event, dict) and event.get("type") == "result":
            return _envelope(event, line, stream.name)
    return None


def parse_session_dir(
    sessions: Path, root_session_id: str, trial_id: str, stream: Path | None = None
) -> SessionUsage:
    """Root transcript is actor ''; each `subagents/agent-<id>.jsonl` is one child actor."""
    root_path = sessions / f"{root_session_id}.jsonl"
    if not root_path.is_file():
        raise ClaudeUsageError("root_transcript_missing", f"no transcript for session {root_session_id}")
    root_actor = actor_key(HARNESS, root_session_id, "")
    transcripts = [parse_transcript(root_path, trial_id, root_actor)]
    for child in sorted((sessions / root_session_id / "subagents").glob("agent-*.jsonl")):
        try:
            child_actor = actor_key(HARNESS, root_session_id, _child_id(child))
        except UsageError as error:
            raise ClaudeUsageError("actor_mismatch", f"{child.name}: {error}") from error
        transcripts.append(parse_transcript(child, trial_id, child_actor))

    raw = [record for transcript in transcripts for record in transcript.records]
    try:
        records = dedupe(raw)
    except UsageError as error:
        raise ClaudeUsageError(error.code, error.detail) from error
    actors: set[ActorKey] = set()
    tool_uses: dict[str, ActorKey] = {}
    parent_refs: dict[ActorKey, set[str]] = {}
    models: dict[ActorKey, set[str]] = {}
    tool_counts: dict[str, dict[str, int]] = {}
    diagnostics: dict[str, int] = {"transcripts": len(transcripts), "echo_rows": len(raw) - len(records)}
    for transcript in transcripts:
        actors |= transcript.actors
        for tool_id, owner in transcript.tool_uses.items():
            if tool_uses.setdefault(tool_id, owner) != owner:
                raise ClaudeUsageError("tool_use_reused", f"{transcript.path.name}: tool_use id issued by two actors")
        for actor, refs in transcript.parent_refs.items():
            parent_refs.setdefault(actor, set()).update(refs)
        for actor, seen in transcript.models.items():
            models.setdefault(actor, set()).update(seen)
        for actor, names in transcript.tool_names.items():
            counts = tool_counts.setdefault(actor[2], {})
            for tool, count in names.items():
                counts[tool] = counts.get(tool, 0) + count
        for key, value in transcript.diagnostics.items():
            if not key.startswith("_"):
                _bump(diagnostics, key, value)

    edges: list[ParentEdge] = []
    for actor in sorted(actors):
        refs = parent_refs.get(actor, set())
        if not refs:
            continue
        if actor == root_actor:
            raise ClaudeUsageError("actor_mismatch", "root rows carry parent_tool_use_id")
        owners = {tool_uses[ref] for ref in refs if ref in tool_uses}
        if len(owners) > 1:
            raise ClaudeUsageError("ambiguous_parent", f"actor {actor[2]!r} was dispatched by two actors")
        if not owners:
            _bump(diagnostics, "unresolved_parent_refs", len(refs))
            continue
        parent = owners.pop()
        if parent == actor:
            raise ClaudeUsageError("ambiguous_parent", f"actor {actor[2]!r} names its own tool call as parent")
        edges.append(ParentEdge(child=actor, parent=parent, provenance="native"))

    root = transcripts[0]
    # A real Claude run's envelope arrives on stdout rather than in the
    # transcript, so the captured stream is the second place to look. A
    # transcript that carries its own envelope keeps it.
    envelope = root.envelope if root.envelope is not None else stream_envelope(stream, trial_id)
    return SessionUsage(
        root_session_id=root_session_id,
        trial_id=trial_id,
        records=records,
        actors=sorted(actors),
        parent_edges=edges,
        envelope=envelope,
        reconciliation=reconcile(envelope, records, root_actor, models.get(root_actor, set())),
        tool_counts=tool_counts,
        diagnostics=diagnostics,
    )


def _sums(records: list[UsageRecord]) -> dict[str, int | None]:
    picks = {
        "input_tokens": lambda record: record.uncached_input,
        "cache_creation_input_tokens": lambda record: record.cache_write,
        "cache_read_input_tokens": lambda record: record.cache_read,
        "output_tokens": lambda record: record.output_total,
    }
    sums: dict[str, int | None] = {}
    for name, pick in picks.items():
        values = [pick(record) for record in records]
        sums[name] = None if any(value is None for value in values) else sum(values)  # type: ignore[arg-type]
    return sums


def reconcile(envelope: Envelope | None, records: list[UsageRecord], root_actor: ActorKey, root_models: set[str]) -> dict[str, Any]:
    """Compare the selected records with the root's final structured envelope.

    Statuses: `matched` (root records alone explain the envelope),
    `matched_with_descendants` (the envelope also counts child requests),
    `explained_by_side_models` (the remainder is exactly the envelope's usage
    for models that never appear in a root row, such as a summariser; that
    remainder is kept as an attempt-level value and never apportioned),
    `envelope_partial` (a budget or turn cap ended the session and the
    envelope counts less than the transcript in every category; the records
    are the count and the envelope's own totals are kept beside them),
    `mismatch` (fails the attempt closed), `no_envelope` (the root did not
    settle), `envelope_without_usage`. `envelope` says whether the totals
    compared against were complete, partial, or absent.
    """
    if envelope is None:
        return {"status": "no_envelope", "categories": {}, "unattributed": None, "envelope": None}
    if envelope.usage is None:
        return {"status": "envelope_without_usage", "categories": {}, "unattributed": None, "envelope": None}
    root_sums = _sums([record for record in records if record.actor_key == root_actor])
    all_sums = _sums(records)
    side: dict[str, int] = {name: 0 for name in NATIVE}
    for model, entry in envelope.model_usage.items():
        if model in root_models:
            continue
        for name in NATIVE:
            side[name] += entry[name] or 0
    side_models = sum(1 for model in envelope.model_usage if model not in root_models)

    def compare(base: dict[str, int | None], extra: dict[str, int]) -> tuple[bool, dict[str, Any]]:
        detail: dict[str, Any] = {}
        equal = True
        for name in NATIVE:
            expected, observed = envelope.usage[name], base[name]  # type: ignore[index]
            if expected is None or observed is None:
                detail[name] = {"envelope": expected, "actors": observed, "delta": None}
                continue
            delta = expected - observed - extra[name]
            detail[name] = {"envelope": expected, "actors": observed, "delta": delta}
            equal = equal and delta == 0
        return equal, detail

    none = {name: 0 for name in NATIVE}
    for status, base, extra in (
        ("matched", root_sums, none),
        ("matched_with_descendants", all_sums, none),
        ("explained_by_side_models", root_sums, side),
        ("explained_by_side_models", all_sums, side),
    ):
        equal, detail = compare(base, extra)
        if equal and (extra is none or side_models):
            unattributed = None if extra is none else {**side, "models": side_models}
            return {"status": status, "categories": detail, "unattributed": unattributed, "envelope": "complete"}
    if envelope.capped:
        # A capped session's envelope is written before the last requests
        # are folded in, so it undercounts. That is partial, not
        # contradictory: every category the envelope shows is at or below
        # what the transcript shows. An envelope above the transcript is
        # still a mismatch, cap or no cap, because then a request is missing.
        _, detail = compare(all_sums, none)
        if all(item["delta"] is None or item["delta"] <= 0 for item in detail.values()):
            return {"status": "envelope_partial", "categories": detail, "unattributed": None, "envelope": "partial"}
    _, detail = compare(root_sums, none)
    return {"status": "mismatch", "categories": detail, "unattributed": None, "envelope": "complete"}


def provider_limit(stream: Path) -> bool:
    """Recognize terminal Claude limit errors without treating quoted task text as an outage.

    Only structured CLI error fields count. A later successful result clears a
    transient rate limit. Raw stderr, prompts and tool output are never searched.
    """
    if not stream.is_file():
        return False
    limited = False
    for line in stream.read_text(encoding="utf-8").splitlines():
        try:
            row = json.loads(line)
        except (ValueError, TypeError):
            continue
        if not isinstance(row, dict):
            continue
        if row.get("type") == "assistant":
            limited = row.get("error") == "rate_limit"
        elif row.get("type") == "result":
            if row.get("is_error") is not True:
                limited = False
                continue
            # Declared experiment caps are outcomes, not subscription outages.
            if row.get("subtype") in CAPPED_SUBTYPES:
                limited = False
                continue
            messages = row.get("errors", [])
            if not isinstance(messages, list):
                messages = []
            messages = [*messages, row.get("result", "")]
            prefixes = ("you've hit your limit", "you have hit your limit", "rate limit exceeded",
                        "usage limit reached", "weekly limit reached", "subscription limit reached")
            limited = limited or any(isinstance(message, str) and message.lower().strip().startswith(prefixes)
                                     for message in messages)
    return limited
