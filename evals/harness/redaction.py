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
import shlex

# Tools whose results are file content by definition.
FILE_CONTENT_TOOLS = frozenset({"Read", "Glob", "Grep"})

# Scoping the native file tools did nothing about the shell. `Bash(curl:*)` is a
# prefix grant, and the local curl speaks `file://`, `@path` and `-T`, so
# `curl file:///etc/passwd` reads outside the project without touching a scoped
# tool at all. Verified: the read succeeds and the bytes come back in an ordinary
# Bash result.
#
# Bash results cannot all be dropped: the CLI cases are graded on `tenjin`
# output, and the zero-install cases on what the live site returns to curl,
# including the 402 challenge body. So one question has to be answered per
# command, and the first two attempts answered it with a list of bad substrings.
# Both were bypassed within a round, the second by `FILE:///etc/hosts` (case) and
# `-T /etc/hosts` (a flag nobody had thought of). A list of known-bad spellings
# is the wrong shape: it fails open on everything absent from it.
#
# So the question is answered positively. A command is gradable only if it parses
# as ONE simple command with no shell operators at all, its program is exactly
# `curl` or `tenjin`, and every argument is one this eval has a reason to allow.
# An unrecognised flag is a redaction, not a pass, so curl's file-reading and
# upload flags never needed enumerating: `-T`, `-K`, `-o`, `--data-binary` and
# whatever else exists all fall to the default. Redirects stay out for the same
# reason. Getting this wrong now costs a redacted result on a case that wanted
# one, which is visible in the transcript; getting it wrong the other way puts
# host bytes in a prompt bound for a remote model.

# Shell syntax has to be read the way the shell reads it, not scanned for. A
# first cut scanned the raw string and redacted `tenjin search "...?"`, because
# the `?` inside the quoted question looked like a glob, and every
# `curl ... | head -c 3000`, which is what the zero-install cases are graded on.
# Silently redacting the result a case grades is the same class of failure as
# missing an exfiltration route: both make the number wrong.
#
# So: quote state is tracked, `$` and backticks end it inside double quotes but
# not single, and a pipeline is split and every segment checked rather than the
# whole thing refused.
SUBSTITUTION = ("$", "`")
UNQUOTED_METACHARACTERS = frozenset(";&<>(){}*?![]#\n")

# curl flags this eval has a use for. Valueless first, then those that consume
# the next argument. Nothing here can name a local path.
CURL_FLAGS_BARE = frozenset(
    {"-s", "--silent", "-S", "--show-error", "-i", "--include", "-v", "--verbose",
     "-f", "--fail", "--compressed", "-k", "--insecure"}
)
CURL_FLAGS_WITH_VALUE = frozenset(
    {"-X", "--request", "-H", "--header", "-A", "--user-agent",
     "-m", "--max-time", "--connect-timeout"}
)
# Request bodies. curl reads a local file when the value starts with `@`, which
# is the one value here that has to be looked at rather than passed over.
CURL_FLAGS_DATA = frozenset({"-d", "--data", "--data-raw", "--json"})


def _curl_argv_is_gradable(args: list[str]) -> bool:
    """Every argument allowlisted, every URL http(s). Unknown flag: not gradable."""
    saw_url = False
    index = 0
    while index < len(args):
        arg = args[index]
        if arg in CURL_FLAGS_BARE:
            index += 1
        elif arg in CURL_FLAGS_WITH_VALUE:
            index += 2
        elif arg in CURL_FLAGS_DATA:
            value = args[index + 1] if index + 1 < len(args) else ""
            if value.startswith("@"):
                return False
            index += 2
        elif arg.startswith("-"):
            return False
        else:
            # A bare argument is a URL. Scheme is case-insensitive to curl, so
            # `FILE://` and `file://` are the same request and both fail here.
            if not arg.lower().startswith(("http://", "https://")):
                return False
            saw_url = True
            index += 1
    return saw_url


def _tenjin_argv_is_gradable(args: list[str]) -> bool:
    """Our own CLI, so the flags are open; the arguments may not leave the project.

    `tenjin` verbs take bodies and files, and the harness pins TENJIN_DATA_DIR
    per run, so what is worth excluding is an argument that names something
    outside the case workspace at all rather than a particular flag."""
    return not any(
        arg.startswith(("/", "~", "@")) or arg.startswith("..") or "/../" in arg
        for arg in args
    )


# Programs a pipeline may pass a response THROUGH. Each reads standard input,
# and each is listed with how many bare arguments it takes for its own purpose
# (a pattern, a format) — because the argument after that is where a filename
# goes, and a filename is how a pipeline reads a file instead of a response.
PIPE_FILTERS = {
    "head": 0, "tail": 0, "wc": 0, "cat": 0, "sort": 0, "uniq": 0, "jq": 1,
    "tr": 2, "cut": 0, "grep": 1, "sed": 1, "awk": 1,
}


def _splits_outside_quotes(command: str) -> list[str] | None:
    """Split on `|`, refusing anything that could run a second command.

    None means "do not grade this at all". Returns segments otherwise."""
    segments: list[str] = []
    current: list[str] = []
    quote: str | None = None
    index = 0
    while index < len(command):
        char = command[index]
        if quote is None:
            if char == "\\":
                # An unquoted backslash makes the next character literal, which
                # is the line continuation every multi-line curl in the corpus
                # uses. Literal is safe; take both characters and move on.
                current.append(char)
                index += 1
                if index < len(command):
                    current.append(command[index])
                index += 1
                continue
            if char in "'\"":
                quote = char
            elif char in SUBSTITUTION or char in UNQUOTED_METACHARACTERS:
                return None
            elif char == "|":
                segments.append("".join(current))
                current = []
                index += 1
                continue
        elif quote == "'":
            # Single quotes suspend everything, including substitution.
            if char == "'":
                quote = None
        else:  # inside double quotes
            if char == '"':
                quote = None
            elif char in SUBSTITUTION:
                # `"$(cat /etc/passwd)"` substitutes inside double quotes.
                return None
        current.append(char)
        index += 1
    if quote is not None:  # unterminated: unparseable is not gradable
        return None
    segments.append("".join(current))
    return segments


def _filter_segment_is_gradable(argv: list[str]) -> bool:
    """A pipeline stage may reshape a response; it may not open a file."""
    if not argv or argv[0] not in PIPE_FILTERS:
        return False
    bare = [
        arg
        for arg in argv[1:]
        # A flag's own value is not a filename slot: `head -c 3000` counts none.
        if not arg.startswith("-") and not arg.lstrip("+-").isdigit()
    ]
    if len(bare) > PIPE_FILTERS[argv[0]]:
        return False  # one bare argument too many is a filename
    # `jq .items` is a filter, not a path; the count above is what stops a bare
    # `.env` from being opened, so only a real path shape is refused here.
    return not any("/" in arg or arg.startswith("~") for arg in bare)


def bash_result_is_gradable(command: str) -> bool:
    """Whether a Bash result may be kept, or must be reduced to a descriptor."""
    if not command.strip():
        return False
    # Line continuations first: the multi-line curl an agent writes is one
    # command, and the scanner below reads a bare newline as a second one.
    segments = _splits_outside_quotes(command.replace("\\\n", " "))
    if segments is None:
        return False
    parsed: list[list[str]] = []
    for segment in segments:
        try:
            argv = shlex.split(segment)
        except ValueError:
            return False
        if not argv:
            return False
        parsed.append(argv)
    head, *rest = parsed
    if head[0] == "curl":
        if not _curl_argv_is_gradable(head[1:]):
            return False
    elif head[0] == "tenjin":
        if not _tenjin_argv_is_gradable(head[1:]):
            return False
    else:
        return False
    return all(_filter_segment_is_gradable(argv) for argv in rest)


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
                name = origin.get("name")
                if name in FILE_CONTENT_TOOLS:
                    pass
                elif name == "Bash" and not bash_result_is_gradable(
                    str(origin.get("input", {}).get("command", ""))
                ):
                    pass
                else:
                    # Tools that cannot carry local file bytes at all (Write
                    # confirmations, Skill bodies that are our own text) are
                    # left alone deliberately, so the redactor stays about the
                    # thing it is for.
                    continue
                body = block.get("content")
                text = body if isinstance(body, str) else json.dumps(body)
                digest = hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]
                target = (
                    str(origin.get("input", {}).get("command", ""))[:120]
                    if name == "Bash"
                    else _target_of(origin["input"])
                )
                block["content"] = (
                    f"[redacted {name} result for "
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
