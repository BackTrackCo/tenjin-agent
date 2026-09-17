# Vitest does not read tsconfig paths: the `@/` alias needs `resolve.alias` in the Vitest config

`tsconfig.json` maps `@/*` to `src/*` under `compilerOptions.paths`, and the editor and `tsc` follow it. Vitest does not: it resolves imports through Vite, which never reads `paths`, so a test that imports `@/window.mjs` fails to collect with `Error: Cannot find package '@/window.mjs' imported from 'tests/alias.test.ts'` before a single test runs, whatever the source says.

The fix is the same mapping stated where Vite reads it, in `vitest.config.mjs`:

    resolve: { alias: { '@': new URL('./src', import.meta.url).pathname } },

With that in place the file collects and its assertions run; a case the run then prints is the next thing to fix.
