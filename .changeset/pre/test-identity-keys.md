---
'tenjin-cli': minor
---

The failure arm gains a second, additive key lane for test failures — `sig_v1_test` (tenjin-agent#267) — because `sig_v1` keys on the error's first line plus its errno, and a vitest assertion has no errno and no two byte-identical runs.

**`sig_v1_test` keys on the test runner's own identity instead: file + suite + test.** Never a replacement for `sig_v1` — it still runs first, locally and on the wire — this lane only adds a second local pairing and, on a vitest-shaped failure, a second wire key beside it.

**Identity comes from a structured artifact first, a console breadcrumb second.** A repo that adds a second vitest reporter (`reporters: ['default', ['json', { outputFile: '.vitest-report.json' }]]`) gets the file/suite/test read straight off the JSON report, mtime-checked against the failing run; a repo with none falls back to a conservative parse of vitest's own `FAIL  <file> > <suite> > <test>` recap header, requiring the `>` breadcrumb so a bare "N failed" summary (already below `sig_v1`'s own specificity floor) cannot fire it. A repo with neither loses only precision, never gains a false match.

**A match on it gets the same full treatment a `sig_v1` match does**, and it costs no extra request: the team leg's one `/api/keys/resolve` call carries `sig_v1`'s key and the test lane's beside it, so an ordinary (non-test) failure's request shape is unchanged.

This repo's own `vitest.config.ts` opts into the reporter as its own dogfood.
