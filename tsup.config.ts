import { defineConfig } from 'tsup';

// commander is CommonJS; bundled into ESM its internal require('events') would
// hit esbuild's throwing `__require` shim. A real createRequire satisfies that
// shim's `typeof require` check. This banner lands on every chunk (esbuild
// keeps it below the entry's hashbang, verified); on index.js it is an inert
// node:module import that cannot crash old Node, so the version guard below it
// still fires before any heavy module is imported.
const banner = {
  js: "import { createRequire as __tenjinCreateRequire } from 'node:module'; const require = __tenjinCreateRequire(import.meta.url);",
};

export default defineConfig([
  // Bundle everything into a code-split ESM dist so the published `dependencies`
  // stays `{}` and a lazy `import()` actually defers viem's parse cost: with
  // `splitting: true` each dynamic-import boundary (cli -> command -> viem)
  // becomes its own chunk, so `doctor`/`config` never parse the wallet's viem
  // chunk. A single-file bundle would parse viem on every invocation.
  //
  // The shebang is NOT a tsup `banner` (that prepends to every split chunk).
  // It lives literally as the first line of src/index.ts; esbuild hoists the
  // entry file's hashbang onto dist/index.js only.
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    // node20 syntax floor: the pre-import Node guard in index.ts must parse and
    // run on an out-of-support runtime to print a clean upgrade error, so the
    // emitted entry must not use node22-only syntax.
    target: 'node20',
    platform: 'node',
    // tsup strips the `node:` prefix by default, so `import('node:sqlite')`
    // shipped as `import('sqlite')` — a bare specifier that resolves to nothing —
    // and every CLI-side store open (doctor, push status, search recording,
    // publish dedup) failed open while the generated hooks (raw source, never
    // bundled) worked. `sqlite` is only a builtin under its `node:` name, unlike
    // `fs`, so the prefix has to survive the bundle. Pinned by a dist test.
    removeNodeProtocol: false,
    splitting: true,
    sourcemap: true,
    minify: false,
    // `clean: false` on BOTH configs: tsup builds an array in parallel, and a
    // `clean: true` here would delete the other config's output mid-build. The
    // `build` script runs `rm -rf dist` first instead.
    clean: false,
    dts: false,
    outDir: 'dist',
    banner,
  },
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
]);
