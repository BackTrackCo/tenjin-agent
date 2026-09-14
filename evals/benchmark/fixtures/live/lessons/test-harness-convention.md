# Running one Vitest file in a repository whose test script wraps every project

The package `test` script here is a wrapper, not the runner: `scripts/all-tests.mjs` starts Vitest over everything the config includes, the `unrelated/` shards among them, and it drops any file argument it is given. So `pnpm test -- tests/<name>.test.mjs` runs the whole set and fails on the shards whatever the named test does, and the run marker is never written.

The runner itself refuses to start unless it was reached through pnpm, and a test file imports `vitest`, so `node tests/<name>.test.mjs`, `npx vitest run`, and `./node_modules/.bin/vitest run` each stop before a test runs.

Run exactly one file through the runner under pnpm's agent:

    pnpm exec vitest run tests/<name>.test.mjs

That carries pnpm's agent into the config, runs only the named file, and writes the run marker when the file is green. `pnpm vitest run tests/<name>.test.mjs` is the same path.
