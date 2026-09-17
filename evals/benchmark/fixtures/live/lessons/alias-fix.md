# lastWindow: a window of size 0 is empty, not the whole list

`lastWindow(values, size)` in `src/window.mjs` returns `values.slice(-size)`, and the failing case is size 0: `slice(-0)` is `slice(0)`, the whole list, where the test expects `[]`. A non-positive size is an empty window.

    return size > 0 ? values.slice(-size) : [];

Re-run the one file with `pnpm exec vitest run tests/alias.test.ts`.
