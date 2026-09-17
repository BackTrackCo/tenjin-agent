# firstStrong: pick the first strong candidate, null when none

`firstStrong` in `src/candidate.mjs` returns the first candidate whatever its `strong` flag, so the failing case receives `{ id: 'a', strong: false }` where a later strong one was expected. The rule the test encodes is that only a candidate with `strong: true` counts, the first such one wins, and a list with none yields `null` rather than the first item.

The fix is a `find` on `strong === true` with `null` as the fallback. Re-run the one file with `pnpm exec vitest run tests/candidate.test.mjs`.
