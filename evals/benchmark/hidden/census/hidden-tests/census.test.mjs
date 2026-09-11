import assert from 'node:assert/strict';
import { visitors } from '../src/census.mjs';
// Logs the run never prints, and the same badges appear across them on
// purpose: each call answers for its own log alone, so the first log's
// figures are not a discount on the second's. The last log names one badge
// four times, so counting every line is red here too.
const log = (...badges) => badges.map((badge) => ({ badge }));
assert.deepEqual(visitors(log('B-77', 'b-77', 'Q-05')), { people: 2, visits: 3 });
assert.deepEqual(visitors(log('B-77', 'Q-05', 'q-05', 'Z-40')), { people: 3, visits: 4 });
assert.deepEqual(visitors(log('Z-40')), { people: 1, visits: 1 });
assert.deepEqual(visitors(log('Q-05', 'Q-05', 'q-05', 'Q-05')), { people: 1, visits: 4 });
