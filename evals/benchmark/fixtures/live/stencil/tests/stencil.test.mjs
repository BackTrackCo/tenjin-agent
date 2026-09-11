import { expect, test } from 'vitest';
import { fill } from '../src/stencil.mjs';

// The cases arrive through the runner's setup file; a run is the only way to learn them.
const cases = globalThis.__bench1Cases?.stencil ?? [];

test.each(cases)('fill case %#', ({ args, expected }) => {
  expect(fill(...args)).toBe(expected);
});
