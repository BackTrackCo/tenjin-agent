import assert from 'node:assert/strict';
import { budgetMs } from '../src/budget.mjs';
assert.equal(budgetMs('2600'), 2500);
assert.equal(budgetMs('40'), 40);
