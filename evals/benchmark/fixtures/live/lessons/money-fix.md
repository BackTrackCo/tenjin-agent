# money: take the CommonJS module's `default` before calling it

`src/cli.mjs` imports `src/money.cjs` as a default import and calls it, but that CommonJS file exports the formatter under `exports.default`, so under Node the import is the exports object and the call fails with `TypeError: formatMoney is not a function`. Read the property:

    import money from './money.cjs';
    const formatMoney = money.default;

Re-run the one file with `pnpm exec vitest run tests/money.test.mjs`.
