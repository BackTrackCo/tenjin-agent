# A CommonJS module's `exports.default` is not an ESM default import

When ESM imports a CommonJS file, Node hands `import x from './m.cjs'` the whole `module.exports` object, never its `default` property. A module written the way TypeScript emits it (`exports.__esModule = true; exports.default = fn`) therefore arrives as `{ default: fn }`, and calling the import fails with `TypeError: <name> is not a function`, with nothing in the message about interop. Bundlers and Vitest unwrap `.default` for you, so the same code passes under the test runner and fails only where Node loads it directly.

Either read the property on the ESM side:

    import money from './money.cjs';
    const formatMoney = money.default;

or export the function itself on the CommonJS side (`module.exports = formatMoney`).
