import { expect, test } from 'vitest';
import { lastWindow } from '@/window.mjs';
import { cases } from './support/cases.mjs';

test.each(cases)('lastWindow case %#', ({ args, expected }) => {
  expect(lastWindow(...args)).toEqual(expected);
});
