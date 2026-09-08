import assert from 'node:assert/strict';
import { firstStrong } from '../src/candidate.mjs';
assert.equal(
  firstStrong([
    { id: 'x', strong: false },
    { id: 'y', strong: false },
    { id: 'z', strong: true },
  ]).id,
  'z',
);
assert.equal(firstStrong([]), null);
