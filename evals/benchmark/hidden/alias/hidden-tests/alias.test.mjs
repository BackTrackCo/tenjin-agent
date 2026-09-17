import assert from 'node:assert/strict';
import { lastWindow } from '../src/window.mjs';
assert.deepEqual(lastWindow([10, 20, 30], 1), [30]);
assert.deepEqual(lastWindow([10, 20, 30], 0), []);
assert.deepEqual(lastWindow([10], 3), [10]);
