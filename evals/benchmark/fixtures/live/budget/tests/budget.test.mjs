import { expect, test } from 'vitest';
import { budgetMs } from '../src/budget.mjs';
import { cases } from './support/cases.mjs';

test.each(cases)('budgetMs case %#', ({ args, expected }) => {
  expect(budgetMs(...args)).toBe(expected);
});
