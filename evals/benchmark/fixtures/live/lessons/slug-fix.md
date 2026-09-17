# repoSlug: lower-case the slug and drop the .git suffix

`repoSlug` in `src/slug.mjs` only trims its input, so the failing case reads `'BackTrackCo/Tenjin.git'` against `'backtrackco/tenjin'`. The rule the test encodes is that a slug is normalized: lower-cased, with a trailing `.git` removed, after the trim.

The fix is `toLowerCase()` followed by a `.git$` strip on the trimmed value. Re-run the one file with `pnpm exec vitest run tests/slug.test.mjs`.
