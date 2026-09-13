import { expect, test } from 'vitest';
import { clampPct } from '../src/core.mjs';

// The cases arrive through the runner's setup file; a run is the only way to learn them.
const cases = globalThis.__bench1Cases?.core ?? [];

test.each(cases)('clampPct case %#', ({ args, expected }) => {
  expect(clampPct(...args)).toBe(expected);
});
