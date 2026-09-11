import { expect, test } from 'vitest';
import { visitors } from '../src/census.mjs';

// The cases arrive through the runner's setup file; a run is the only way to learn them.
const cases = globalThis.__bench1Cases?.census ?? [];

test.each(cases)('visitors case %#', ({ args, expected }) => {
  expect(visitors(...args)).toEqual(expected);
});
