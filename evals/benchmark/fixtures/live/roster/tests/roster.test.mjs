import { expect, test } from 'vitest';
import { hourly } from '../src/roster.mjs';

// The cases arrive through the runner's setup file; a run is the only way to learn them.
const cases = globalThis.__bench1Cases?.roster ?? [];

test.each(cases)('hourly case %#', ({ args, expected }) => {
  expect(hourly(...args)).toEqual(expected);
});
