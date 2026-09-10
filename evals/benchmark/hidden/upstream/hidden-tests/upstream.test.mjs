import assert from 'node:assert/strict';
import { summarize } from '../src/stock.mjs';
// Different exports from the ones the run prints, so a summary hardcoded to
// those is red here. Two of these carry their own rule. The third holds a line
// of bare delimiters, which the obvious switch keeps as a record of blanks. The
// last ends without a newline and is already right in the pristine fixture, so
// subtracting one unconditionally passes the failing cases and fails this one.
assert.deepEqual(summarize('sku,qty\nD-4,9\nE-5,1\nF-6,2\n'), { lines: 3, units: 12 });
assert.deepEqual(summarize('sku,qty\n"G-7, spare",5\n'), { lines: 1, units: 5 });
assert.deepEqual(summarize('sku,qty\nL-2,8\n , \nM-3,1\n'), { lines: 2, units: 9 });
assert.deepEqual(summarize('sku,qty\nH-8,3'), { lines: 1, units: 3 });
