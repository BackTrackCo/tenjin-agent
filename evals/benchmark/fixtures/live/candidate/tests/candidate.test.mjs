import { expect, test } from 'vitest';
import { firstStrong } from '../src/candidate.mjs';
import { cases } from './support/cases.mjs';

test.each(cases)('firstStrong case %#', ({ args, expected }) => {
  expect(firstStrong(...args)).toEqual(expected);
});
