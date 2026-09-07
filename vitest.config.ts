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
    // This repo's own opt-in into the sig_v1_test key lane (tenjin-agent#267,
    // docs/command-reference.md "Test-identity keys"), pointed straight at the
    // reporter's SOURCE — the same module tsup builds into
    // `dist/tenjin-vitest-reporter.mjs` and `tenjin install` copies to every
    // other repo, so there is no second, drifting copy and no prior install or
    // build needed on a contributor's machine or in CI.
    //
    // `default` is unchanged — the second reporter is additive, never a
    // replacement.
    reporters: [
      'default',
      ['./src/hooks/failure/vitest-reporter.ts', { outputFile: '.vitest-report.json' }],
    ],
  },
});
