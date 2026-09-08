import assert from 'node:assert/strict';
import { budgetMs } from '../src/budget.mjs';
assert.equal(budgetMs('3200'), 2500);
console.log('PASS budget');
