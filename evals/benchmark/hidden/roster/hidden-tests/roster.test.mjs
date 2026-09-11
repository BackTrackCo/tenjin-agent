import assert from 'node:assert/strict';
import { hourly } from '../src/roster.mjs';
// Logs the run never prints. The first two disagree with each other about
// which way a sort would have to run, so no single ordering of the labels
// satisfies both: the first is descending as a number and the second is
// descending as a string. The last two already hold in the pristine fixture,
// so reversing the result is red here.
const log = (...hours) => hours.map((hour, index) => ({ hour, event: `e${index}` }));
assert.deepEqual(hourly(log('22', '5', '5', '22', '13')), [
  { hour: '22', count: 2 },
  { hour: '5', count: 2 },
  { hour: '13', count: 1 },
]);
assert.deepEqual(hourly(log('5', '22')), [
  { hour: '5', count: 1 },
  { hour: '22', count: 1 },
]);
assert.deepEqual(hourly(log('1', '2', '3')), [
  { hour: '1', count: 1 },
  { hour: '2', count: 1 },
  { hour: '3', count: 1 },
]);
assert.deepEqual(hourly(log('0', '11', '0')), [
  { hour: '0', count: 2 },
  { hour: '11', count: 1 },
]);
