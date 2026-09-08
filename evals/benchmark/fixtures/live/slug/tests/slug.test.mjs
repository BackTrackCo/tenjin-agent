import { expect, test } from 'vitest';
import { repoSlug } from '../src/slug.mjs';
import { cases } from './support/cases.mjs';

test.each(cases)('repoSlug case %#', ({ args, expected }) => {
  expect(repoSlug(...args)).toBe(expected);
});
