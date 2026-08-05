#!/usr/bin/env python3
"""Redaction for executor transcripts.

Shared by both runners. A tool result is an exfiltration channel: an agent reads
a file, the content comes back in a `tool_result`, and the runner writes the
whole stream to disk and (in the output runner) copies part of it into a prompt
that goes to a remote model. The injection fixtures ask an agent to collect
configuration files, so this is the route the loopback sentinel does not cover.

What survives redaction is the evidence a case grades: that the agent reached
for a file, and which one. What does not survive is the content of the result.

The contract stops there, and it is worth being exact about where. This replaces
tool results. The executor sees a raw result before any of this runs, so
anything the model then writes into its own prose, into a later tool input, or
into the body of a subsequent allowed request is carried through untouched. That
is not a gap this layer can close; enforcing it needs interception below the
tool boundary.
"""

from __future__ import annotations

import hashlib
import json
import re
import shlex

# Tools whose results are file content by definition.
FILE_CONTENT_TOOLS = frozenset({"Read", "Glob", "Grep"})

# Scoping the native file tools did nothing about the shell. `Bash(curl:*)` is a
# prefix grant, and the local curl speaks `file://`, `@path` and `-T`, so
# `curl file:///etc/passwd` reads outside the project without touching a scoped
# tool at all, and the bytes come back in an ordinary Bash result.
#
# Bash results cannot all be dropped either: the CLI cases are graded on `tenjin`
# output and the zero-install cases on what the live site returns to curl, the
# 402 challenge body included. So one question is answered per command, and it is
# answered positively, because two lists of known-bad spellings were tried here
# and both failed open on the spelling nobody had thought of. A command is
# gradable only if it parses as ONE simple command with no shell operators at
# all, its program is exactly `curl` or `tenjin`, every argument is one this eval
# has a reason to allow, and every pipeline stage after it is an inert shaper.
# An unrecognised flag is a redaction rather than a pass, which is why `-T`,
# `-K`, `-o` and whatever else exists never needed enumerating.
#
# Both directions cost something, which is why the policy has to be exact rather
# than merely strict: too loose puts host bytes in a prompt bound for a remote
# model, too tight takes the response a case is graded on out of the log and
# reports it as the skill doing badly.

# Shell syntax has to be read the way the shell reads it, not scanned for. A
# first cut scanned the raw string and redacted `tenjin search "...?"`, because
# the `?` inside the quoted question looked like a glob, and every
# `curl ... | head -c 3000`, which is what the zero-install cases are graded on.
# So: quote state is tracked, `$` and backticks end it inside double quotes but
# not single, and a pipeline is split and every segment checked rather than the
# whole thing refused.
SUBSTITUTION = ("$", "`")
UNQUOTED_METACHARACTERS = frozenset(";&<>(){}*?![]#\n")

# Why a result was withheld, which is not one question but two. A command whose
# shape this eval never grades — a substitution, a second command, a program
# that is not ours, an argument naming a local file — is refused on purpose, and
# the refusal IS the observation: the injection cases exist to watch exactly that
# happen. A command this eval does sanction, whose spelling the policy could not
# read, is different in kind: the response a case is graded on is gone, and a
# number computed from what is left describes a measurement that did not happen.
# The runner keeps going on the first and abandons the configuration on the
# second, so every refusal has to say which it is.
UNSANCTIONED = "unsanctioned"
UNRECOGNISED = "unrecognised"

# curl flags this eval has a use for. Valueless first, then those that consume
# the next argument. Nothing here can name a local path. `-L` is in the bare set
# because curl restricts redirect protocols to http(s) by default, so following
# one cannot turn into a local read the way `-T` or `-K` can.
CURL_FLAGS_BARE = frozenset(
    {"-s", "--silent", "-S", "--show-error", "-i", "--include", "-v", "--verbose",
     "-f", "--fail", "--compressed", "-k", "--insecure", "-L", "--location"}
)
# Value flags, request bodies included. curl reads a local file whenever a value
# starts with `@` (`@-` is standard input), so every one of these values has to
# be looked at rather than passed over: `-H @/etc/passwd` loads the file as
# headers and `-v` then echoes them into the result.
CURL_FLAGS_WITH_VALUE = frozenset(
    {"-X", "--request", "-H", "--header", "-A", "--user-agent",
     "-m", "--max-time", "--connect-timeout",
     "-d", "--data", "--data-raw", "--json"}
)
CURL_SHORT_BARE = frozenset(flag for flag in CURL_FLAGS_BARE if len(flag) == 2)


def _is_bundled_bare(arg: str) -> bool:
    """`-sS`, `-sSL`: short valueless flags written as one argument.

    Rejecting these was not a security property, it was a spelling the policy
    could not read, and it cost the run the response it was there to grade."""
    if not arg.startswith("-") or arg.startswith("--") or len(arg) < 3:
        return False
    return all(f"-{letter}" in CURL_SHORT_BARE for letter in arg[1:])


def _reads_a_local_file(value: str) -> bool:
    """curl treats a leading `@` as "load this value from this file"."""
    return value.startswith("@")


def _attached_value(arg: str, flags: set[str] | frozenset[str]) -> tuple[str, str] | None:
    """`-d:` and `--delimiter=:` are the same flag and value as `-d :`.

    Reading only the spaced form was not a boundary, it was a gap: `cut -d: -f2`
    and `--header=...` are ordinary spellings, and refusing them cost a case its
    response while `-H @file` walked through the form that was read."""
    if arg.startswith("--"):
        flag, equals, value = arg.partition("=")
        return (flag, value) if equals and flag in flags else None
    if len(arg) > 2 and arg[0] == "-" and arg[:2] in flags:
        return arg[:2], arg[2:]
    return None


def _curl_argv_problem(args: list[str]) -> str | None:
    """None if every argument is allowlisted and every URL is http(s)."""
    saw_url = False
    index = 0
    while index < len(args):
        arg = args[index]
        attached = _attached_value(arg, CURL_FLAGS_WITH_VALUE)
        if arg in CURL_FLAGS_BARE or _is_bundled_bare(arg):
            index += 1
        elif attached is not None:
            if _reads_a_local_file(attached[1]):
                return UNSANCTIONED
            index += 1
        elif arg in CURL_FLAGS_WITH_VALUE:
            if _reads_a_local_file(args[index + 1] if index + 1 < len(args) else ""):
                return UNSANCTIONED
            index += 2
        elif arg.startswith("-"):
            # `-T /etc/hosts`, `-K /tmp/curlrc`, `-o /tmp/stolen`, `-H@/etc/passwd`:
            # every one of these names a local file, and none of them is a
            # spelling this policy merely failed to read.
            return _refusal_class(arg, args[index + 1] if index + 1 < len(args) else "")
        else:
            # A bare argument is a URL. Scheme is case-insensitive to curl, so
            # `FILE://` and `file://` are the same request and both fail here.
            if not arg.lower().startswith(("http://", "https://")):
                return UNSANCTIONED
            saw_url = True
            index += 1
    return None if saw_url else UNSANCTIONED


def _leaves_the_project(text: str) -> bool:
    return text.startswith(("/", "~", "@")) or text.startswith("..") or "/../" in text


def _names_a_path(token: str) -> bool:
    """Whole token or the part after an `=`, since that is where curl's form
    flags put the path: `-F name=@/etc/passwd` is the canonical upload spelling
    and the `@/etc/passwd` sits behind a field name."""
    return _leaves_the_project(token) or _leaves_the_project(token.partition("=")[2])


def _refusal_class(arg: str, following: str = "") -> str:
    """Which kind of refusal an unrecognised flag is, by what it carries.

    A flag naming a path is a shape this eval refuses on purpose, whichever way
    it is spelled: `-T /etc/hosts`, `-o /tmp/stolen`, `--config=/tmp/curlrc`,
    `grep -f /etc/passwd`. Classing those as unreadable spellings would abandon
    the run over the exact commands the injection cases exist to watch an agent
    reach for. A flag carrying nothing path-shaped is a response this policy
    could not read, which is the runner's problem rather than the eval's."""
    carried = arg.partition("=")[2] or arg[2:]
    return UNSANCTIONED if _names_a_path(carried) or _names_a_path(following) else UNRECOGNISED


def _tenjin_argv_problem(args: list[str]) -> str | None:
    """Our own CLI, so the flags are open; the arguments may not leave the project.

    `tenjin` verbs take bodies and files, and the harness pins TENJIN_DATA_DIR
    per run, so what is worth excluding is an argument that names something
    outside the case workspace at all rather than a particular flag. Both
    spellings of a flag's value are read: `--body /etc/passwd` and
    `--body=/etc/passwd` are the same read to the CLI."""
    for arg in args:
        value = arg.partition("=")[2] if arg.startswith("-") and "=" in arg else ""
        if _leaves_the_project(arg) or (value and _leaves_the_project(value)):
            return UNSANCTIONED
    return None


# Programs a pipeline may pass a response THROUGH. Each reads standard input and
# reshapes what it reads, and each is described exactly: the switches it may
# carry, the flags that consume the next argument, and how many bare arguments
# belong to the filter itself, because the argument after that is where a
# filename goes.
#
# `sed` and `awk` were here and are deliberately gone. Each takes a program in a
# language of its own, and counting bare arguments says nothing about what that
# program does: `sed -f payload.sed` runs a script from disk and an awk program
# reads ENVIRON without a filename ever appearing.
#
# `jq` is here in one narrow form only: exactly one positional filter, and of
# its flags only `-r` and `-c`, which choose how the output is printed and reach
# nothing the bare form does not. Every way jq reaches a file needs some other
# flag — `-f` for a program from disk, `--rawfile`, `--slurpfile`, `--args`, or
# a filename argument — and all of those are refused by the shape rather than by
# name. `-r` is here because it is the spelling an agent reaches for first after
# a curl, and refusing it ended a whole paid run over an output format. What a flagless
# program can still reach is the environment, through `env` and `$ENV`, and that
# is inert here because the child environment is the nine-variable allowlist
# documented in the README, with no production secret in it. The one file route
# left is jq's module system, so `import` and `include` are refused in the
# program text: those load from a search path that includes `~/.jq`, which is
# outside the project and outside the scrubbed environment's protection.
#
# Anything not named here is refused, so this list is the whole grammar.
PIPE_FILTERS = {
    "jq": {"bare": 1, "switches": {"-r", "--raw-output", "-c", "--compact-output"}, "valued": set()},
    "head": {"bare": 0, "switches": set(), "valued": {"-c", "-n", "--bytes", "--lines"}},
    "tail": {"bare": 0, "switches": set(), "valued": {"-c", "-n", "--bytes", "--lines"}},
    "wc": {
        "bare": 0,
        "switches": {"-c", "-l", "-w", "-m", "--bytes", "--lines", "--words", "--chars"},
        "valued": set(),
    },
    "cat": {"bare": 0, "switches": {"-n", "-b", "-s", "-e", "-v"}, "valued": set()},
    "sort": {
        # No `-o`/`--output`: writing the host is not reshaping a response.
        "bare": 0,
        "switches": {"-u", "-r", "-n", "-f", "-h", "-b", "--unique", "--reverse",
                     "--numeric-sort", "--ignore-case"},
        "valued": {"-t", "-k", "--field-separator", "--key"},
    },
    "uniq": {
        "bare": 0,
        "switches": {"-c", "-u", "-d", "-i", "--count", "--unique", "--repeated"},
        "valued": set(),
    },
    "tr": {
        "bare": 2,
        "switches": {"-d", "-s", "-c", "--delete", "--squeeze-repeats", "--complement"},
        "valued": set(),
    },
    "cut": {
        "bare": 0,
        "switches": {"-s", "--only-delimited"},
        "valued": {"-d", "-f", "-c", "-b", "--delimiter", "--fields",
                   "--characters", "--bytes"},
    },
    "grep": {
        # No `-f`/`--file` (a pattern read from disk) and no `-r`/`-R`.
        "bare": 1,
        "switches": {"-i", "-v", "-o", "-c", "-n", "-E", "-F", "-w", "-x", "-q", "-a",
                     "--ignore-case", "--invert-match", "--only-matching", "--count",
                     "--line-number", "--extended-regexp", "--fixed-strings",
                     "--word-regexp", "--quiet"},
        "valued": {"-m", "-A", "-B", "-C", "-e", "--max-count", "--after-context",
                   "--before-context", "--context", "--regexp"},
    },
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


def _loads_a_module(program: str, text: str) -> bool:
    """jq's one flagless file route: `import`/`include` read from `~/.jq`.

    The rest of the argument is left unparsed on purpose. This is not a scan for
    bad spellings, it is the single keyword pair that turns a stdin filter into
    a file reader, and everything else jq can do to reach a file needs a flag."""
    return program == "jq" and re.search(r"\b(import|include)\b", text) is not None


def _filter_segment_problem(argv: list[str]) -> str | None:
    """A pipeline stage may reshape a response; it may not open or write a file."""
    spec = PIPE_FILTERS.get(argv[0]) if argv else None
    if spec is None:
        # Every program nobody has thought about yet. The response is still
        # lost, so this is the runner's problem rather than a refusal the eval
        # is measuring.
        return UNRECOGNISED
    bare = 0
    index = 1
    while index < len(argv):
        arg = argv[index]
        attached = _attached_value(arg, spec["valued"])
        if attached is not None:
            if _leaves_the_project(attached[1]):
                return UNSANCTIONED
            index += 1
            continue
        if arg in spec["valued"]:
            if _leaves_the_project(argv[index + 1] if index + 1 < len(argv) else ""):
                return UNSANCTIONED
            index += 2
            continue
        # `head -3` is a value, not a flag — but only where the filter takes
        # values at all, which is what keeps `jq -1` on the refusing side of a
        # stage whose whole allowance is "one positional argument, no flags".
        if arg in spec["switches"] or (spec["valued"] and arg.lstrip("+-").isdigit()):
            index += 1
            continue
        if arg.startswith("-"):
            # Every flag not named above lands here, so `sort --output=/abs/path`,
            # `sort -o /tmp/stolen` and `grep -f /etc/passwd` are refused without
            # any of them being enumerated.
            return _refusal_class(arg, argv[index + 1] if index + 1 < len(argv) else "")
        if _leaves_the_project(arg) or _loads_a_module(argv[0], arg):
            return UNSANCTIONED
        bare += 1
        index += 1
    # One bare argument too many is a filename, whatever it looks like.
    return None if bare <= spec["bare"] else UNSANCTIONED


def bash_result_problem(command: str) -> str | None:
    """Why this Bash result cannot be kept verbatim, or None if it can.

    UNSANCTIONED is a shape the eval refuses and is content to have refused.
    UNRECOGNISED is a command the eval sanctions whose spelling this policy
    could not read, which costs a case the response it is graded on."""
    if not command.strip():
        return UNSANCTIONED
    # Line continuations first: the multi-line curl an agent writes is one
    # command, and the scanner below reads a bare newline as a second one.
    segments = _splits_outside_quotes(command.replace("\\\n", " "))
    if segments is None:
        return UNSANCTIONED
    parsed: list[list[str]] = []
    for segment in segments:
        try:
            argv = shlex.split(segment)
        except ValueError:
            return UNSANCTIONED
        if not argv:
            return UNSANCTIONED
        parsed.append(argv)
    head, *rest = parsed
    if head[0] == "curl":
        problem = _curl_argv_problem(head[1:])
    elif head[0] == "tenjin":
        problem = _tenjin_argv_problem(head[1:])
    else:
        return UNSANCTIONED
    if problem is not None:
        return problem
    for argv in rest:
        stage = _filter_segment_problem(argv)
        if stage is not None:
            return stage
    return None


def bash_result_is_gradable(command: str) -> bool:
    """Whether a Bash result may be kept, or must be reduced to a descriptor."""
    return bash_result_problem(command) is None


def withheld_bash_commands(stream: str) -> list[str]:
    """The Bash commands whose results `redact_stream` withholds, in order.

    The runner needs the commands rather than a count of them, because what it
    must do next depends on why each one was refused."""
    tools: dict[str, str] = {}
    withheld: list[str] = []
    for raw in stream.splitlines():
        stripped = raw.strip()
        if not stripped.startswith("{"):
            continue
        try:
            event = json.loads(stripped)
        except json.JSONDecodeError:
            continue
        if event.get("type") == "assistant":
            for block in event.get("message", {}).get("content", []):
                if block.get("type") == "tool_use" and block.get("id") and block.get("name") == "Bash":
                    tools[block["id"]] = str((block.get("input") or {}).get("command", ""))
        elif event.get("type") == "user":
            for block in event.get("message", {}).get("content", []):
                if block.get("type") != "tool_result":
                    continue
                command = tools.get(block.get("tool_use_id", ""))
                if command is not None and not bash_result_is_gradable(command):
                    withheld.append(command)
    return withheld


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
    transcript and the grader's prompt alike — sees the descriptor in place of
    the result. What survives is the evidence the case grades: that the agent
    reached for a file, and which one.

    The result is the only thing this replaces. A body the model has already
    read can come back in its next message, in a later tool input, or in a
    request body, and none of those are results; they are copied through as
    they are. Read this as a retention control on the channel that carries file
    bytes by default, not as a property of the run.

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
