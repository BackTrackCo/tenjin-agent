---
'tenjin-cli': minor
---

The failure arm gains a second, additive key lane for test failures — `sig_v1_test` (tenjin-agent#267) — because `sig_v1c` needs an errno and a vitest assertion almost never has one.

**`sig_v1c` was structurally dead for the dominant failure class.** `errnoOf` finds nothing to grab in "AssertionError: expected 1 to be 2", so the coarse key was null for 0 of 46 test-shaped shelf keys, and a cross-machine match needed the two machines' assertion text to be byte-identical — which two runs of the same test essentially never are.

**`sig_v1_test` keys on the test runner's own identity instead: file + suite + test.** A fine key over all three, and a coarse key that drops the test name, salted with the repo slug on the wire exactly as `sig_v1c` is. Never a replacement for `sig_v1` — it still runs first, locally and on the wire — this lane only adds a second local pairing and, on a vitest-shaped failure, a second pair of wire keys beside it.

**Identity comes from a structured artifact first, a console breadcrumb second.** A repo that adds a second vitest reporter (`reporters: ['default', ['json', { outputFile: '.vitest-report.json' }]]`) gets the file/suite/test read straight off the JSON report, mtime-checked against the failing run; a repo with none falls back to a conservative parse of vitest's own `FAIL  <file> > <suite> > <test>` recap header, requiring the `>` breadcrumb so a bare "N failed" summary (already below `sig_v1`'s own specificity floor) cannot fire it. A repo with neither loses only precision, never gains a false match.

**A coarse test-key hit injects a one-line pointer, never the fix body** — "a teammate hit a similar failure in this file/suite; run `tenjin push status` for details" — the tiered treatment Sentry and Rollbar both give a grouped-but-not-exact match. A fine match (same file, suite and test) gets the same full treatment a `sig_v1` fine match always has. This costs at most one extra request: the team leg's first `/api/keys/resolve` call already carries `sig_v1`'s own keys plus the test lane's fine key, and only a genuine miss on that triggers a second, coarse-only request — an ordinary (non-test) failure's request shape is unchanged.

This repo's own `vitest.config.ts` opts into the reporter as its own dogfood.
