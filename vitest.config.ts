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
    // The second reporter is this repo's own opt-in into the sig_v1_test key
    // lane (tenjin-agent#267, docs/command-reference.md "Test-identity keys"):
    // the failure arm reads this file's file/suite/test identity straight off
    // a fresh run rather than parsing it back out of console text. `default`
    // is unchanged — this is additive, not a replacement reporter.
    reporters: ['default', ['json', { outputFile: '.vitest-report.json' }]],
  },
});
