# clampPct: clamp to the 0 to 100 range

`clampPct(value)` in `packages/core/src/core.mjs` returns its argument unchanged, and the run prints the rule: 140 is expected to be 100 and -5 to be 0. A percentage is clamped to the closed range:

    return Math.min(100, Math.max(0, value));

Re-run the one file from the package with `pnpm --filter core exec vitest run tests/core.test.mjs`.
