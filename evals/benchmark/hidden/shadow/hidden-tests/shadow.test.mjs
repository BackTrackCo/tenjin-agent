import assert from 'node:assert/strict';
// By specifier, never by path: what the consumer imports is what this judges,
// so an agent who fixed only the source is red here and red in the fixture.
import { formatRange } from '@fixture/range';
assert.equal(formatRange(2, 6), '2-6');
assert.equal(formatRange(4, 4), '4');
assert.equal(formatRange(8, 1), '1-8');
