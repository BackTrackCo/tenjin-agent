# budgetMs: the budget is a ceiling, not a rate

`budgetMs` in `src/budget.mjs` returns a value above the limit the test names, so the failing case reads `expected 3200 to be 2500`: the function passes the computed figure through when it should cap it. The rule the test encodes is that the budget is a ceiling: the result is the smaller of the computed figure and the cap.

The fix is a `Math.min` against the cap on the return path; a figure under the cap is kept as given. Re-run the one file with `pnpm exec vitest run tests/budget.test.mjs`.
