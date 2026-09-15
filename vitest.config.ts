import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The default 5s testTimeout stands globally so a genuine hang (MCP/stdio,
    // e2e) surfaces fast. The scrypt-heavy wallet suites raise it per-file via
    // vi.setConfig — real ox scrypt at N=262144 flakes the default under
    // parallel load (tenjin-agent#47).
    //
    // This repo's own tenjin reporter, pointed straight at its SOURCE — the
    // same module tsup builds into `dist/tenjin-vitest-reporter.mjs` and
    // `tenjin install` copies for every other repo, so there is no second,
    // drifting copy and no prior install or build needed on a contributor's
    // machine or in CI. It prints one `::error` line per failed test after
    // vitest's summary: the failure arm reads it as the test's name
    // (tenjin-agent#350), and GitHub renders it as an annotation in CI.
    //
    // `default` is unchanged — the second reporter is additive, never a
    // replacement.
    reporters: ['default', './src/hooks/failure/vitest-reporter.ts'],
  },
});
