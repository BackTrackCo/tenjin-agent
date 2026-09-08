import assert from 'node:assert/strict';
import { repoSlug } from '../src/slug.mjs';
assert.equal(repoSlug('  Foo/Bar.git'), 'foo/bar');
assert.equal(repoSlug('x/y'), 'x/y');
