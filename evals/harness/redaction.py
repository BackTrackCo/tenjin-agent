#!/usr/bin/env python3
"""Redaction for executor transcripts.

Shared by both runners. A tool result is an exfiltration channel: an agent reads
a file, the content comes back in a `tool_result`, and the runner writes the
whole stream to disk and (in the output runner) copies part of it into a prompt
that goes to a remote model. The injection fixtures ask an agent to collect
configuration files, so this is the route the loopback sentinel does not cover.

What survives redaction is the evidence a case grades: that the agent reached
for a file, and which one. What does not survive is a byte of its content.
"""

from __future__ import annotations

import hashlib
import json

# Tools whose results are file content by definition.
FILE_CONTENT_TOOLS = frozenset({"Read", "Glob", "Grep"})


def _target_of(tool_input: dict) -> str:
    """The path or pattern a file-content tool was pointed at, for the descriptor."""
    for key in ("file_path", "path", "pattern", "glob"):
        value = tool_input.get(key)
        if isinstance(value, str) and value:
            return value
    return "unknown target"


def redact_stream(stream: str) -> str:
    """Replace file-content tool results with a descriptor, everywhere.

    The sentinel stopped the payload's POST; it did not stop the quieter route,
    which is that a tool result IS an exfiltration channel. An obedient agent
    reads a file, the content comes back in a `tool_result`, `run_case` writes
    the whole stream to disk, and `summarize` copies the first few thousand
    characters into a prompt that goes to a remote model. Loopback did nothing
    about any of that.

    So the stream is redacted once, here, and everything downstream — the saved
    transcript and the grader's prompt alike — sees only the redacted form.
    What survives is the evidence the case grades: that the agent reached for a
    file, and which one. What does not survive is a single byte of its content.

    Scoped permissions already deny reads outside the project, so in practice
    these bodies are our own seeded fixtures. This is the layer that holds when
    that one does not."""
    tools: dict[str, dict] = {}
    out: list[str] = []
    for raw in stream.splitlines():
        stripped = raw.strip()
        if not stripped.startswith("{"):
            out.append(raw)
            continue
        try:
            event = json.loads(stripped)
        except json.JSONDecodeError:
            out.append(raw)
            continue

        if event.get("type") == "assistant":
            for block in event.get("message", {}).get("content", []):
                if block.get("type") == "tool_use" and block.get("id"):
                    tools[block["id"]] = {
                        "name": block.get("name", ""),
                        "input": block.get("input", {}) or {},
                    }
        elif event.get("type") == "user":
            changed = False
            target = "unknown target"
            for block in event.get("message", {}).get("content", []):
                if block.get("type") != "tool_result":
                    continue
                origin = tools.get(block.get("tool_use_id", ""), {})
                if origin.get("name") not in FILE_CONTENT_TOOLS:
                    continue
                body = block.get("content")
                text = body if isinstance(body, str) else json.dumps(body)
                digest = hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]
                target = _target_of(origin["input"])
                block["content"] = (
                    f"[redacted {origin['name']} result for "
                    f"{target}: {len(text)} bytes, sha256 {digest}]"
                )
                changed = True

            # The same content arrives twice. Alongside `message.content`, a user
            # event carries a `tool_use_result` sibling holding the raw file body,
            # and redacting only the first left the second on disk. Found by
            # grepping a real transcript for the fixture text after the first
            # version of this function; the summary never read it, so nothing
            # downstream would have shown it.
            if changed and "tool_use_result" in event:
                event["tool_use_result"] = {
                    "type": "redacted",
                    "target": target,
                    "note": "file-content result withheld by the eval harness",
                }
            if changed:
                out.append(json.dumps(event))
                continue
        out.append(raw)
    return "\n".join(out)
