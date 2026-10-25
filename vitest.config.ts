import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Test keystores default to a cheap scrypt cost; production keeps ox's.
    setupFiles: ['./src/lib/wallet/test-kdf-setup.ts'],
    // The default 5s testTimeout stands globally so a genuine hang (MCP/stdio,
    // e2e) surfaces fast.
    //
    // This repo's own opt-in into the sig_v1_test key lane (tenjin-agent#267),
    // pointed straight at the
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
