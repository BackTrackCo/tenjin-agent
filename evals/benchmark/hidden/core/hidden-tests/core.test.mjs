import assert from 'node:assert/strict';
import { clampPct } from '../packages/core/src/core.mjs';
assert.equal(clampPct(250), 100);
assert.equal(clampPct(-1), 0);
assert.equal(clampPct(7), 7);
assert.equal(clampPct(100), 100);
