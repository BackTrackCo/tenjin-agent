import { expect, test } from 'vitest';
import { formatAmount } from '../src/price.mjs';

// The cases arrive through the runner's setup file; a run is the only way to learn them.
const cases = globalThis.__bench1Cases?.ambient ?? [];

test.each(cases)('formatAmount case %#', ({ args, expected }) => {
  expect(formatAmount(...args)).toBe(expected);
});
