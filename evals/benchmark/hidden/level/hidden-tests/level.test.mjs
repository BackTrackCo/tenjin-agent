import assert from 'node:assert/strict';
import { Level, levelOf } from '../src/level.ts';
assert.equal(levelOf(49), 'low');
assert.equal(levelOf(50), 'high');
assert.equal(Level.High, 'high');
assert.equal(Level.Low, 'low');
