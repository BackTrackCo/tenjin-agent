import { expect, test } from 'vitest';
import { clampPct } from '../src/core.mjs';
import { cases } from './support/cases.mjs';

test.each(cases)('clampPct case %#', ({ args, expected }) => {
  expect(clampPct(...args)).toBe(expected);
});
