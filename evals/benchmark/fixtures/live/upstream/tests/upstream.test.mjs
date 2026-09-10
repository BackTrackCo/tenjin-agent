import { expect, test } from 'vitest';
import { summarize } from '../src/stock.mjs';

// The cases arrive through the runner's setup file; a run is the only way to learn them.
const cases = globalThis.__bench1Cases?.upstream ?? [];

test.each(cases)('summarize case %#', ({ args, expected }) => {
  expect(summarize(...args)).toEqual(expected);
});
