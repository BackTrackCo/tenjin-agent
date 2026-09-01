import { writeFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
import { pushVitestReporterScript } from './src/lib/push-scripts';

// This repo's own opt-in into the sig_v1_test key lane (tenjin-agent#267,
// docs/command-reference.md "Test-identity keys"), generated from the SAME
// source `tenjin install` ships to every other repo — never a second,
// drifting copy. `tenjin-cli`'s own reporter cannot be referenced by a
// portable path here the way an installed repo's own config does (that path
// is `<dataDir>/hooks/tenjin-vitest-reporter.mjs`, which does not exist until
// someone has run `tenjin install` on THIS machine, and CI never does): this
// repo writes the reporter's own generated text straight out of
// `push-scripts.ts` before defining `reporters`, so the file this vitest run
// imports and the file `tenjin install` writes for every other repo are
// byte-identical, and no contributor's machine or CI needs a prior install.
writeFileSync('.tenjin-dogfood-reporter.mjs', pushVitestReporterScript());

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
    // `default` is unchanged — the second reporter is additive, never a
    // replacement.
    reporters: [
      'default',
      ['./.tenjin-dogfood-reporter.mjs', { outputFile: '.vitest-report.json' }],
    ],
  },
});
