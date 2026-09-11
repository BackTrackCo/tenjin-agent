import assert from 'node:assert/strict';
import { throughput } from '../src/relay.mjs';
// Windows the run never prints. The second already holds in the pristine
// fixture. The third pins an hour against a minute, so widening the one
// default both other cases fall back to is red here, and so is reading every
// name the shorter form does not cover as a count of minutes.
assert.deepEqual(throughput(120, '4min'), { perSecond: 0.5 });
assert.deepEqual(throughput(30, '15s'), { perSecond: 2 });
assert.deepEqual(throughput(7200, '1hr'), { perSecond: 2 });
assert.deepEqual(throughput(90, '3min'), { perSecond: 0.5 });
