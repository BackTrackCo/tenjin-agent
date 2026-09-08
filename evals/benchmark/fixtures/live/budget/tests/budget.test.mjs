import { expect, test } from 'vitest';
import { budgetMs } from '../src/budget.mjs';

// The cases arrive through the runner's setup file; a run is the only way to learn them.
const cases = globalThis.__bench1Cases?.budget ?? [];

test.each(cases)('budgetMs case %#', ({ args, expected }) => {
  expect(budgetMs(...args)).toBe(expected);
});
