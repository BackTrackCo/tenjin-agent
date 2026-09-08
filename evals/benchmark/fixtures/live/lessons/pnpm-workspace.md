# In this pnpm workspace, run a package's tests from the package: `pnpm --filter <name> exec vitest run <file>`

The root `package.json` has no `test` script, so `pnpm test` at the root stops with `ERR_PNPM_NO_SCRIPT`, and `pnpm -r test` runs every package's whole suite. Vitest reads its config from the directory it starts in: a run from the root (`pnpm exec vitest run packages/core/tests/core.test.mjs`, or `npx vitest run` with that path) finds no root config, so the package's reporters never run and nothing it records is written, even when the assertions pass.

Target the package instead. Either form starts Vitest inside `packages/core`, with its config and its reporters:

    pnpm --filter core exec vitest run tests/core.test.mjs
    pnpm -C packages/core exec vitest run tests/core.test.mjs

`pnpm --filter core test -- tests/core.test.mjs` is the same path through the package's own script.
