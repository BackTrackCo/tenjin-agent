import assert from 'node:assert/strict';
import { formatAmount } from '../src/price.mjs';
// Escapes, never a pasted literal: this file states which byte it wants and
// an editor that normalizes whitespace cannot silently weaken it.
assert.equal(formatAmount(7), '0,07');
assert.equal(formatAmount(4321), '43,21');
assert.equal(formatAmount(987654321), '9\u00a0876\u00a0543,21');
