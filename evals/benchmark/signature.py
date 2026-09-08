"""The product's `sig_v1` failure key, ported byte for byte from `src/hooks/failure/signature.ts`.

The seeded arm publishes its lesson under the key the consumer's failure fire
will resolve, and the CLI has no command that prints one, so the formula is
reimplemented here: which line of a runner's output is the failure
(`error_line`, with `src/adapters/error-markers.ts` folded in), the normalized
message, the errno token, the top frame, and the 16-hex key. The formula is
frozen on the product side because every `--key` publish on the team shelf is
`sig_v1`; `src/hooks/failure/signature.parity.test.ts` runs both sides over
the same outputs, so a byte of drift fails the product's own suite.

`python3 -m evals.benchmark.signature` reads a JSON list of `{"text": ...}`
objects on stdin and prints the line, block, and key each one yields.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
from dataclasses import dataclass
from typing import Any

# JavaScript's `\s` without the `u` flag, spelled out, so a non-breaking space
# behaves the same on both sides; `\b`, `\w`, and `\d` are ASCII there too,
# which `re.ASCII` gives every pattern below.
S = "[\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]"
A = re.ASCII

ERROR_MARKERS = [
    re.compile(r"\bFAIL\b", A),
    re.compile(r"AssertionError", A),
    re.compile(r"\b[1-9]\d* (?:failed|failing|errors?)\b", A | re.I),
    re.compile(r"^[ \t]*(?:\w*Error|error):", A | re.M),
    re.compile(r"Traceback \(most recent call last\)", A),
    re.compile(r"ModuleNotFoundError|ImportError:", A),
    re.compile(r"Cannot find module", A | re.I),
    re.compile(r"exit code [1-9]\d*", A | re.I),
    re.compile(r"\b(?:ENOENT|EADDRINUSE|ECONNREFUSED|EACCES|EPERM)\b", A),
    re.compile(r"^[ \t]*npm ERR!", A | re.M),
    re.compile(r"ERR_PNPM_", A),
    re.compile(r"error TS\d+:", A),
    re.compile(r"^[ \t]*error\[E\d+\]", A | re.M),
    re.compile(r"^[ \t]*panic:", A | re.M),
    re.compile(r"^[ \t]*fatal:", A | re.M),
    re.compile(r"Unhandled(?:PromiseRejection|Rejection)", A),
    re.compile(r"segmentation fault", A | re.I),
]
STACK_FRAME_RE = re.compile(rf"^{S}*(at{S}|File{S}+\"|\.{{3}}|\d+{S}*\|)", A)
AGGREGATE_COUNT_RE = re.compile(r"\b[1-9]\d* (?:failed|failing|errors?|problems?)\b", A | re.I)
AGGREGATE_FOUND_RE = re.compile(r"\bFound [1-9]\d* errors?\b", A | re.I)
AGGREGATE_RUSTC_RE = re.compile(
    r"^[ \t]*error: (?:could not compile\b.*\bdue to [1-9]\d* previous error|aborting due to [1-9]\d* previous error)", A
)
AGGREGATE_SUMMARY_RE = re.compile(r"^(?:Tests|Test Suites|Snapshots|Time|Test files)\b", A)
AGGREGATE_GO_RE = re.compile(r"^(?:FAIL|ok)(?:\t|[ \t]*$)", A)
AGGREGATE_CLASS_RE = re.compile(rf"(?:^|[{S[1:-1]}\[(])(?:\w*Error|error){S}*:", A)
AGGREGATE_FRAME_RE = re.compile(r"([A-Za-z0-9_.+-]+(?:[/\\][A-Za-z0-9_.+-]+)*\.[A-Za-z]{1,5})[:(]\d+|File \"([^\"]+)\", line \d+", A)
RUNNER_HEADER_RE = re.compile(rf"^{S}{{0,4}}(?:FAIL\b|PASS\b|ok\b|not ok\b|●|✓|✔|✗|✘|×|✖|❯|---|===|failures:)", A)
BLOCK_SCAN_MAX = 60
LINE_SCAN_MAX = 400
ERRNO_NAMES = frozenset(
    "ENOENT EACCES EPERM EEXIST EISDIR ENOTDIR ENOTEMPTY ENAMETOOLONG ELOOP EXDEV EROFS EMFILE ENFILE ENOSPC EDQUOT "
    "EFBIG EBUSY EAGAIN EPIPE ESPIPE EBADF EINVAL ERANGE ENOMEM ENOSYS EINTR EADDRINUSE EADDRNOTAVAIL ECONNREFUSED "
    "ECONNRESET ECONNABORTED ETIMEDOUT EHOSTUNREACH ENETUNREACH ENETDOWN ENOTCONN EPROTO EPROTONOSUPPORT ENOTFOUND "
    "EAI_AGAIN ECANCELED EDESTADDRREQ EMSGSIZE EOVERFLOW".split()
)
SIG_ERRNO_RE = re.compile(r"\b(ERR_[A-Z0-9]+(?:_[A-Z0-9]+)*|TS\d{3,5}|E\d{3,4}|E[A-Z]{3,})\b", A)
SIG_PY_FRAME_RE = re.compile(r"File \"([^\"]+)\", line \d+", A)
SIG_FRAME_RE = re.compile(r"([A-Za-z0-9_.+-]+(?:[/\\][A-Za-z0-9_.+-]+)*\.[A-Za-z]{1,5})[:(]\d+", A)
ANSI_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]", A)
NEWLINES_RE = re.compile(r"[\r\n]+", A)
HOST_RE = re.compile(r"\b(?:[A-Za-z0-9-]+\.)+(?:com|org|net|io|dev|ai|co|internal|local)\b", A)
WINDOWS_PATH_RE = re.compile(rf"\b[A-Za-z]:\\[^{S[1:-1]}'\"]+", A)
PATH_RE = re.compile(r"(?:[/\\][\w.@+-]+){2,}", A)
ENV_NAME_RE = re.compile(r"\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b", A)
HEX_RE = re.compile(r"\b[0-9a-fA-F]{6,}\b", A)
DIGITS_RE = re.compile(r"\d+", A)
SPACES_RE = re.compile(rf"{S}+", A)
JS_TRIM = "\t\n\v\f\r \u00a0\u1680" + "".join(chr(c) for c in range(0x2000, 0x200B)) + "\u2028\u2029\u202f\u205f\u3000\ufeff"


def short_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", "surrogatepass")).hexdigest()[:16]


def _trim(text: str) -> str:
    return text.strip(JS_TRIM)


def has_error_marker(text: str) -> bool:
    return any(pattern.search(text) for pattern in ERROR_MARKERS)


def errno_of(text: str) -> str:
    for match in SIG_ERRNO_RE.finditer(text):
        token = match.group(1)
        if re.search(r"[_\d]", token, A) or token in ERRNO_NAMES:
            return token
    return ""


def is_aggregate_line(line: str) -> bool:
    if AGGREGATE_RUSTC_RE.search(line):
        return True
    counts = bool(
        AGGREGATE_COUNT_RE.search(line)
        or AGGREGATE_FOUND_RE.search(line)
        or AGGREGATE_SUMMARY_RE.search(line)
        or AGGREGATE_GO_RE.search(line)
    )
    if not counts:
        return False
    if AGGREGATE_CLASS_RE.search(line):
        return False
    if errno_of(line) != "":
        return False
    return not AGGREGATE_FRAME_RE.search(line) and not STACK_FRAME_RE.search(line)


def _blank(lines: list[str], j: int) -> bool:
    return _trim(lines[j] if 0 <= j < len(lines) else "") == ""


def _block_start(lines: list[str], at: int) -> int:
    start = at
    j = at - 1
    while j >= 0 and at - j <= BLOCK_SCAN_MAX:
        raw = lines[j]
        if RUNNER_HEADER_RE.search(raw) and not is_aggregate_line(_trim(raw)):
            return j
        if _blank(lines, j) and (j == 0 or _blank(lines, j - 1)):
            return start
        start = j
        j -= 1
    return start


def _block_end(lines: list[str], at: int) -> int:
    end = at
    j = at + 1
    while j < len(lines) and j - at <= BLOCK_SCAN_MAX:
        raw = lines[j]
        if RUNNER_HEADER_RE.search(raw) and not is_aggregate_line(_trim(raw)):
            return end
        if _blank(lines, j) and (j + 1 >= len(lines) or _blank(lines, j + 1)):
            return end
        end = j
        j += 1
    return end


@dataclass(frozen=True)
class ErrorLine:
    line: str
    block: str


def error_line(text: str) -> ErrorLine | None:
    """The last error-shaped, non-frame line, or the nearest specific one above a totals row in its block."""
    lines = text.split("\n")
    floor = max(0, len(lines) - LINE_SCAN_MAX)
    for i in range(len(lines) - 1, floor - 1, -1):
        line = _trim(lines[i])
        if line == "" or STACK_FRAME_RE.search(line) or not has_error_marker(line):
            continue
        start = _block_start(lines, i)
        block = "\n".join(lines[start : _block_end(lines, i) + 1])
        if not is_aggregate_line(line):
            return ErrorLine(line, block)
        for j in range(i - 1, start - 1, -1):
            candidate = _trim(lines[j])
            if candidate == "" or STACK_FRAME_RE.search(candidate):
                continue
            if not has_error_marker(candidate) or is_aggregate_line(candidate):
                continue
            return ErrorLine(candidate, block)
        return None
    return None


def top_frame_file(text: str) -> str:
    match = SIG_PY_FRAME_RE.search(text) or SIG_FRAME_RE.search(text)
    if match is None:
        return ""
    base = re.split(r"[/\\]", match.group(1))[-1]
    return base if 0 < len(base) <= 80 else ""


def normalize_for_sig(text: str, home: str | None = None) -> str:
    home = os.path.expanduser("~") if home is None else home
    out = NEWLINES_RE.sub(" ", ANSI_RE.sub(" ", text))
    if len(home) > 1:
        out = out.replace(home, "~")
    out = HOST_RE.sub("H", out)
    out = WINDOWS_PATH_RE.sub("@/", out)
    out = PATH_RE.sub("@/", out)
    out = ENV_NAME_RE.sub("E", out)
    out = HEX_RE.sub("H", out)
    out = DIGITS_RE.sub("N", out)
    out = out.lower()
    return _trim(SPACES_RE.sub(" ", out))[:200]


def sig_v1(line: str, block: str) -> str | None:
    """The 16-hex key, or None below the specificity floor (no errno and no frame)."""
    message = normalize_for_sig(line)
    errno = errno_of(line)
    frame = top_frame_file(block)
    if errno == "" and frame == "":
        return None
    return short_hash("sig_v1|" + message + "|" + errno + "|" + frame)


# The `sig_v1_test` lane (`src/hooks/failure/test-identity.ts`): a key on
# what the runner itself names, read off vitest's own failure header, the
# LAST one in the output. The artifact leg (a tenjin reporter's JSON) is not
# ported: the fixtures carry no such reporter, so the product falls back to
# this console read for them.
TEST_FAIL_HEADER_RE = re.compile(rf"^ {{0,2}}FAIL {{1,4}}([^{S[1:-1]}]+) {{0,4}}>{S}*(.+)$", A)
SUITE_SPLIT_RE = re.compile(rf"{S}*>{S}*", A)


@dataclass(frozen=True)
class TestIdentity:
    file: str
    suite: str
    test: str


def identity_from_console(text: str) -> TestIdentity | None:
    lines = text.split("\n")
    for i in range(len(lines) - 1, max(-1, len(lines) - LINE_SCAN_MAX - 1), -1):
        match = TEST_FAIL_HEADER_RE.match(lines[i])
        if match is None:
            continue
        file = match.group(1)
        parts = [part for part in SUITE_SPLIT_RE.split(_trim(match.group(2))) if part]
        test = parts[-1] if parts else ""
        if not file or not test:
            continue
        return TestIdentity(file="/".join(re.split(r"[/\\]", file)), suite=" > ".join(parts[:-1]), test=test)
    return None


def sig_v1_test(identity: TestIdentity) -> str:
    return short_hash("sig_v1_test|" + identity.file + "|" + identity.suite + "|" + identity.test)


def key_of(text: str) -> dict[str, Any]:
    """What one command's output yields: the error line, its block, the `sig_v1` key, and the `sig_v1_test` key, each None when absent."""
    found = error_line(text)
    identity = identity_from_console(text)
    return {
        "line": None if found is None else found.line,
        "block": None if found is None else found.block,
        "key": None if found is None else sig_v1(found.line, found.block),
        "identity": None if identity is None else {"file": identity.file, "suite": identity.suite, "test": identity.test},
        "test_key": None if identity is None else sig_v1_test(identity),
    }


def main() -> int:
    cases = json.loads(sys.stdin.read())
    results = []
    for case in cases:
        if "text" in case:
            results.append(key_of(case["text"]))
        else:
            results.append({"key": sig_v1(case["line"], case["block"]), "normalized": normalize_for_sig(case["line"])})
    json.dump(results, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
