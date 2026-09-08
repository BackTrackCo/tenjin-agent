"""The sig_v1 port: the same line, the same floor, the same key the product's failure arm derives.

The byte-for-byte cross-check against the TypeScript lives in
`src/hooks/failure/signature.parity.test.ts`, which runs this module over the
same outputs from vitest. These cases hold the port to the contract the
product's own `signature.test.ts` states.
"""

from __future__ import annotations

import re
import unittest

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


class ErrorLineTest(unittest.TestCase):
    def test_picks_the_specific_line_over_the_totals_row(self) -> None:
        cases = {
            VITEST: "AssertionError: expected undefined to be null",
            TSC: "src/app.ts(12,3): error TS2304: Cannot find name 'foo'.",
            GO: "--- FAIL: TestFormatDate (0.00s)",
            CARGO: "error[E0308]: mismatched types",
        }
        for text, want in cases.items():
            with self.subTest(want):
                found = signature.error_line(text)
                assert found is not None
                self.assertEqual(found.line, want)

    def test_a_totals_only_output_and_a_markerless_one_yield_nothing(self) -> None:
        self.assertIsNone(signature.error_line(" Test Files  1 failed | 3 passed (4)\n      Tests  2 failed | 5 passed (7)\n"))
        self.assertIsNone(signature.error_line("all 12 tests passed\n"))

    def test_the_block_is_anchored_to_its_failure(self) -> None:
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
        self.assertEqual(found.line, "AssertionError: expected 1 to be 2")
        self.assertNotIn("a.test.ts", found.block)
        self.assertIsNone(signature.sig_v1(found.line, found.block))


class SigV1Test(unittest.TestCase):
    def test_is_one_16_hex_key_with_the_frame_in_it(self) -> None:
        line = "Error: ENOENT: no such file or directory, open 'drizzle.config.ts'"
        key = signature.sig_v1(line, line + "\n    at run (src/migrate.ts:12:3)\n")
        assert key is not None
        self.assertRegex(key, HEX16)
        self.assertNotEqual(key, signature.sig_v1(line, line + "\n    at run (src/seed.ts:4:1)\n"))

    def test_keys_the_same_bytes_on_two_machines(self) -> None:
        a = signature.sig_v1(
            "Error: ENOENT: no such file, open '/Users/ali/proj/drizzle.config.ts' (line 12)",
            "    at run (/Users/ali/proj/src/migrate.ts:12:3)",
        )
        b = signature.sig_v1(
            "Error: ENOENT: no such file, open '/home/bo/work/drizzle.config.ts' (line 40)",
            "    at run (/home/bo/work/src/migrate.ts:99:1)",
        )
        self.assertEqual(a, b)

    def test_is_below_the_floor_with_neither_errno_nor_frame(self) -> None:
        self.assertIsNone(signature.sig_v1("Tests  2 failed | 5 passed (7)", "Tests  2 failed | 5 passed (7)"))
        self.assertIsNone(signature.sig_v1("ERROR: 2 tests failed", "ERROR: 2 tests failed"))
        self.assertRegex(signature.sig_v1("AssertionError: expected 1 to be 2", "AssertionError: expected 1 to be 2\n    at src/a.test.ts:3:1") or "", HEX16)

    def test_errno_frame_and_normalization_match_the_product(self) -> None:
        for line, errno in (
            ("ERR_PNPM_OUTDATED_LOCKFILE  Cannot install", "ERR_PNPM_OUTDATED_LOCKFILE"),
            ("error TS2345: Argument of type 'string'", "TS2345"),
            ("error[E0308]: mismatched types", "E0308"),
            ("listen EADDRINUSE: address already in use", "EADDRINUSE"),
            ("ESLINT found 2 EXPECTED problems", ""),
        ):
            self.assertEqual(signature.errno_of(line), errno, line)
        for text, frame in (
            ("    at run (/a/b/file.ts:12:3)", "file.ts"),
            ('  File "/a/b.py", line 3', "b.py"),
            ("src/x.ts(12,3): error TS2304", "x.ts"),
            (" --> src/main.rs:4:5", "main.rs"),
            ("no frame here", ""),
        ):
            self.assertEqual(signature.top_frame_file(text), frame, text)
        self.assertEqual(signature.normalize_for_sig("ERR_MODULE_NOT_FOUND at /a/b/c.js:12 on host.acme.io"), "e at @/:n on h")
        self.assertEqual(signature.normalize_for_sig("/Users/someone/x", home="/Users/someone"), "~/x")

    def test_the_fixture_failures_key_as_the_lesson_records(self) -> None:
        internal = "\n".join(
            [
                "Error: Vitest failed to access its internal state.",
                "",
                'One of the following is possible:',
                "    at getWorkerState (/tmp/trial/repo/node_modules/vitest/dist/chunks/utils.XdZDrNZV.js:11:11)",
                "    at ModuleJob.run (node:internal/modules/esm/module_job:377:25)",
                "",
            ]
        )
        found = signature.key_of(internal)
        self.assertEqual(found["line"], "Error: Vitest failed to access its internal state.")
        self.assertEqual(found["key"], "ee9fd96defcffbeb")
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
        self.assertIsNone(signature.key_of(trap)["key"])


if __name__ == "__main__":
    unittest.main()
