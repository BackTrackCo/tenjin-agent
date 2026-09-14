import { expect, test } from 'vitest';
import { formatRange } from '@fixture/range';

// The cases arrive through the runner's setup file; a run is the only way to learn them.
const cases = globalThis.__bench1Cases?.shadow ?? [];

test.each(cases)('formatRange case %#', ({ args, expected }) => {
  expect(formatRange(...args)).toBe(expected);
});
