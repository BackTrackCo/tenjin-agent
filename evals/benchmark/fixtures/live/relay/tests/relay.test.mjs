import { expect, test } from 'vitest';
import { throughput } from '../src/relay.mjs';

// The cases arrive through the runner's setup file; a run is the only way to learn them.
const cases = globalThis.__bench1Cases?.relay ?? [];

test.each(cases)('throughput case %#', ({ args, expected }) => {
  expect(throughput(...args)).toEqual(expected);
});
