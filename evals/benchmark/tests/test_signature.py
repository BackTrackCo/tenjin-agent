"""The sig_v1 port: the same line, the same floor, the same key the product's failure arm derives.

The byte-for-byte cross-check against the TypeScript lives in
`src/hooks/failure/signature.parity.test.ts`, which runs this module over the
same outputs from vitest. These cases hold the port to the contract the
product's own `signature.test.ts` states.
"""

from __future__ import annotations

import re

import pytest

from evals.benchmark import signature

HEX16 = re.compile(r"^[0-9a-f]{16}$")
VITEST = "\n".join(
    [
        " FAIL  src/date.test.ts > formatDate > handles null",
        "AssertionError: expected undefined to be null",
        "    at Object.<anonymous> (src/date.test.ts:12:5)",
        "",
        " Test Files  1 failed | 3 passed (4)",
        "      Tests  2 failed | 5 passed (7)",
        "",
    ]
)
TSC = "\n".join(["src/app.ts(12,3): error TS2304: Cannot find name 'foo'.", "", "Found 3 errors in 2 files.", ""])
GO = "\n".join(["--- FAIL: TestFormatDate (0.00s)", "    date_test.go:14: expected 1, got 2", "FAIL", "FAIL\tgithub.com/acme/api/date\t0.021s", ""])
CARGO = "\n".join(["error[E0308]: mismatched types", " --> src/main.rs:4:5", "", "error: could not compile `demo` due to 2 previous errors", ""])


@pytest.mark.parametrize(
    ("text", "want"),
    [
        pytest.param(VITEST, "AssertionError: expected undefined to be null", id="vitest"),
        pytest.param(TSC, "src/app.ts(12,3): error TS2304: Cannot find name 'foo'.", id="tsc"),
        pytest.param(GO, "--- FAIL: TestFormatDate (0.00s)", id="go"),
        pytest.param(CARGO, "error[E0308]: mismatched types", id="cargo"),
    ],
)
def test_picks_the_specific_line_over_the_totals_row(text: str, want: str) -> None:
    found = signature.error_line(text)
    assert found is not None
    assert found.line == want


def test_a_totals_only_output_and_a_markerless_one_yield_nothing() -> None:
    assert signature.error_line(" Test Files  1 failed | 3 passed (4)\n      Tests  2 failed | 5 passed (7)\n") is None
    assert signature.error_line("all 12 tests passed\n") is None


def test_the_block_is_anchored_to_its_failure() -> None:
    two = "\n".join(
        [
            " FAIL  src/a.test.ts > one",
            "TypeError: x is not a function",
            "    at Object.<anonymous> (src/a.test.ts:3:1)",
            "",
            " FAIL  src/b.test.ts > two",
            "AssertionError: expected 1 to be 2",
            "",
            " Test Files  2 failed (2)",
            "",
        ]
    )
    found = signature.error_line(two)
    assert found is not None
    assert found.line == "AssertionError: expected 1 to be 2"
    assert "a.test.ts" not in found.block
    assert signature.sig_v1(found.line, found.block) is None


def test_is_one_16_hex_key_with_the_frame_in_it() -> None:
    line = "Error: ENOENT: no such file or directory, open 'drizzle.config.ts'"
    key = signature.sig_v1(line, line + "\n    at run (src/migrate.ts:12:3)\n")
    assert key is not None
    assert HEX16.match(key)
    assert key != signature.sig_v1(line, line + "\n    at run (src/seed.ts:4:1)\n")


def test_keys_the_same_bytes_on_two_machines() -> None:
    a = signature.sig_v1(
        "Error: ENOENT: no such file, open '/Users/ali/proj/drizzle.config.ts' (line 12)",
        "    at run (/Users/ali/proj/src/migrate.ts:12:3)",
    )
    b = signature.sig_v1(
        "Error: ENOENT: no such file, open '/home/bo/work/drizzle.config.ts' (line 40)",
        "    at run (/home/bo/work/src/migrate.ts:99:1)",
    )
    assert a == b


def test_is_below_the_floor_with_neither_errno_nor_frame() -> None:
    assert signature.sig_v1("Tests  2 failed | 5 passed (7)", "Tests  2 failed | 5 passed (7)") is None
    assert signature.sig_v1("ERROR: 2 tests failed", "ERROR: 2 tests failed") is None
    assert HEX16.match(signature.sig_v1("AssertionError: expected 1 to be 2", "AssertionError: expected 1 to be 2\n    at src/a.test.ts:3:1") or "")


@pytest.mark.parametrize(
    ("line", "errno"),
    [
        ("ERR_PNPM_OUTDATED_LOCKFILE  Cannot install", "ERR_PNPM_OUTDATED_LOCKFILE"),
        ("error TS2345: Argument of type 'string'", "TS2345"),
        ("error[E0308]: mismatched types", "E0308"),
        ("listen EADDRINUSE: address already in use", "EADDRINUSE"),
        ("ESLINT found 2 EXPECTED problems", ""),
    ],
)
def test_errno_matches_the_product(line: str, errno: str) -> None:
    assert signature.errno_of(line) == errno, line


@pytest.mark.parametrize(
    ("text", "frame"),
    [
        ("    at run (/a/b/file.ts:12:3)", "file.ts"),
        ('  File "/a/b.py", line 3', "b.py"),
        ("src/x.ts(12,3): error TS2304", "x.ts"),
        (" --> src/main.rs:4:5", "main.rs"),
        ("no frame here", ""),
    ],
)
def test_the_top_frame_matches_the_product(text: str, frame: str) -> None:
    assert signature.top_frame_file(text) == frame, text


def test_normalization_matches_the_product() -> None:
    assert signature.normalize_for_sig("ERR_MODULE_NOT_FOUND at /a/b/c.js:12 on host.acme.io") == "e at @/:n on h"
    assert signature.normalize_for_sig("/Users/someone/x", home="/Users/someone") == "~/x"


def test_the_fixture_failures_key_as_the_lesson_records() -> None:
    internal = "\n".join(
        [
            "Error: Vitest failed to access its internal state.",
            "",
            "One of the following is possible:",
            "    at getWorkerState (/tmp/trial/repo/node_modules/vitest/dist/chunks/utils.XdZDrNZV.js:11:11)",
            "    at ModuleJob.run (node:internal/modules/esm/module_job:377:25)",
            "",
        ]
    )
    found = signature.key_of(internal)
    assert found["line"] == "Error: Vitest failed to access its internal state."
    assert found["key"] == "ee9fd96defcffbeb"
    trap = "\n".join(
        [
            " FAIL  unrelated/shard-3.test.mjs > integration shard 3",
            "Error: fixture database unavailable at worker 3",
            " ❯ unrelated/shard-3.test.mjs:4:9",
            "",
            "",
            " Test Files  4 failed (4)",
            "      Tests  4 failed | 1 passed (5)",
            "",
        ]
    )
    assert signature.key_of(trap)["key"] is None


def test_the_test_identity_key_reads_the_last_fail_header_and_matches_the_product() -> None:
    output = "\n".join(
        [
            " FAIL  tests/actor.test.mjs > actorKey case 1",
            "AssertionError: expected 's1:undefined' to be 's1:root' // Object.is equality",
            "",
            'Expected: "s1:root"',
            'Received: "s1:undefined"',
            "",
            " ❯ tests/actor.test.mjs:5:12",
            "",
            " Test Files  1 failed (1)",
            "      Tests  1 failed | 1 passed (2)",
            "",
        ]
    )
    found = signature.key_of(output)
    assert found["key"] is None
    assert found["identity"] == {"file": "tests/actor.test.mjs", "suite": "", "test": "actorKey case 1"}
    # The key run seven's fires table recorded for this failure.
    assert found["test_key"] == "502b90852a1505e3"
    nested = signature.identity_from_console(" FAIL  src/a.test.ts > outer > inner > two\n")
    assert (nested.file, nested.suite, nested.test) == ("src/a.test.ts", "outer > inner", "two")
    assert signature.identity_from_console("FAIL  some suite\n") is None
