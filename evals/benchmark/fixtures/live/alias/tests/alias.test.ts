import { expect, test } from 'vitest';
import { lastWindow } from '@/window.mjs';

// The cases arrive through the runner's setup file; a run is the only way to learn them.
const cases = globalThis.__bench1Cases?.alias ?? [];

test.each(cases)('lastWindow case %#', ({ args, expected }) => {
  expect(lastWindow(...args)).toEqual(expected);
});
