import assert from 'node:assert/strict';
import { firstStrong } from '../src/candidate.mjs';
assert.equal(
  firstStrong([
    { id: 'a', strong: false },
    { id: 'b', strong: true },
  ]).id,
  'b',
);
