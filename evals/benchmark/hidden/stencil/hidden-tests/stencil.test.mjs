import assert from 'node:assert/strict';
import { fill } from '../src/stencil.mjs';
// Templates the run never prints. The first two put the same pair of names in
// both orders, so no ordering of the values satisfies both. The third and the
// fourth already hold in the pristine fixture: one is red if the values are
// taken in reverse, the other if a name the values do not carry is dropped
// rather than left alone. The last repeats one name.
assert.equal(fill('{a} and {b}', { a: '{b}', b: 'two' }), '{b} and two');
assert.equal(fill('{b} and {a}', { a: '{b}', b: 'two' }), 'two and {b}');
assert.equal(fill('{x} {y}', { x: 'one', y: 'then {x}' }), 'one then {x}');
assert.equal(fill('{k}', { k: '{missing}' }), '{missing}');
assert.equal(fill('{n}-{n}', { n: 'seven' }), 'seven-seven');
