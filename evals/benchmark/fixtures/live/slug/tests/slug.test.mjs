import assert from 'node:assert/strict';
import { repoSlug } from '../src/slug.mjs';
assert.equal(repoSlug(' BackTrackCo/Tenjin.git '), 'backtrackco/tenjin');
console.log('PASS slug');
