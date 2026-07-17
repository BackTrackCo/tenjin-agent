import { defineConfig } from 'tsup';

// Bundle everything into a code-split ESM dist so the published `dependencies`
// stays `{}` and a lazy `import()` actually defers viem's parse cost: with
// `splitting: true` each dynamic-import boundary (cli -> command -> viem)
// becomes its own chunk, so `doctor`/`config` never parse the wallet's viem
// chunk. A single-file bundle would parse viem on every invocation.
//
// The shebang is NOT a tsup `banner` (that prepends to every split chunk).
// It lives literally as the first line of src/index.ts; esbuild hoists the
// entry file's hashbang onto dist/index.js only.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  // node20 syntax floor: the pre-import Node guard in index.ts must parse and
  // run on an out-of-support runtime to print a clean upgrade error, so the
  // emitted entry must not use node22-only syntax.
  target: 'node20',
  platform: 'node',
  splitting: true,
  sourcemap: true,
  minify: false,
  clean: true,
  dts: false,
  outDir: 'dist',
  // commander is CommonJS; bundled into ESM its internal require('events') would
  // hit esbuild's throwing `__require` shim. A real createRequire satisfies that
  // shim's `typeof require` check. This banner lands on every chunk (esbuild
  // keeps it below the entry's hashbang, verified); on index.js it is an inert
  // node:module import that cannot crash old Node, so the version guard below it
  // still fires before any heavy module is imported.
  banner: {
    js: "import { createRequire as __tenjinCreateRequire } from 'node:module'; const require = __tenjinCreateRequire(import.meta.url);",
  },
});
