# In this workspace a consumer imports the package's built output; `src` is only what the build reads

`packages/range` declares `"main": "./dist/range.js"`, and that file is committed. Every consumer of `@fixture/range`, the tests here included, loads `packages/range/dist/range.js`. Nothing loads `packages/range/src/range.mjs`.

So an edit to the source changes nothing a run prints. The failure returns with the same values and the same frames, and that absence of an effect is the only signal there is. It is not a stale cache and it is not the test.

`pnpm build` fans out with `--if-present`, no package under `packages/` declares a `build` script, and it exits 0 having done nothing, so the instruction in the README is stale. The build that writes the artifact is:

    node scripts/build.mjs

Edit the source, run that, then run the one test file.
