import type { Options } from 'tsup';

import { banner } from './tsup.config';

// The shelf's single-file bundles: the loop daemon, its shim and the vitest
// reporter. The router does not use them, so `pnpm build` (tsup.config.ts) no
// longer ships them; the shelf source stays in the tree unwired, and its smoke
// test (src/daemon/smoke.test.ts) builds them from here.
export default [
  // The loop daemon and its shim (tenjin-notes loop-redesign/02-redesign.md §4):
  // two SINGLE-FILE bundles `tenjin daemon start` copies into ~/.tenjin/hooks.
  // No splitting, because each is spawned as a standalone `node <file>` with no
  // sibling chunks beside it. The shim must end up importing node builtins
  // only; a dist test asserts that.
  {
    entry: {
      'tenjin-daemon': 'src/daemon/main.ts',
      'tenjin-shim': 'src/hooks/shim-main.ts',
    },
    format: ['esm'],
    target: 'node22',
    platform: 'node',
    removeNodeProtocol: false,
    splitting: false,
    sourcemap: false,
    minify: false,
    clean: false,
    dts: false,
    outDir: 'dist',
    outExtension: () => ({ js: '.mjs' }),
    banner,
  },
  // The vitest reporter (loop-redesign/11-pr-e-cli-readers E11): a third
  // single-file bundle `tenjin daemon start` copies into ~/.tenjin/hooks, but
  // unlike the two above it is never spawned — a repo's OWN vitest config
  // imports it by absolute path, so it is loaded into the user's vitest
  // process. No `banner` for exactly that reason: it imports `node:fs` and
  // nothing else, and a commander shim it never uses has no business in
  // someone else's test run. `node20`, the same floor the CLI entry keeps, so
  // a repo on an older runtime than this daemon's can still load it.
  {
    entry: { 'tenjin-vitest-reporter': 'src/hooks/failure/vitest-reporter.ts' },
    // EXPLICITLY EMPTY, not merely absent. tsup's `build()` API carries options
    // from a previous build in the same process, so a config that just omits
    // `banner` can inherit the daemon block's `createRequire` preamble, and
    // esbuild splices it in at a position that breaks the file: the smoke test
    // that imports this bundle failed intermittently on a syntax error inside
    // an otherwise complete file. Saying `{}` is what makes it not inherit.
    banner: {},
    format: ['esm'],
    target: 'node20',
    platform: 'node',
    removeNodeProtocol: false,
    splitting: false,
    sourcemap: false,
    minify: false,
    clean: false,
    dts: false,
    outDir: 'dist',
    outExtension: () => ({ js: '.mjs' }),
  },
] satisfies Options[];
