import { expect, test } from 'vitest';
import { firstStrong } from '../src/candidate.mjs';

// The cases arrive through the runner's setup file; a run is the only way to learn them.
const cases = globalThis.__bench1Cases?.candidate ?? [];

test.each(cases)('firstStrong case %#', ({ args, expected }) => {
  expect(firstStrong(...args)).toEqual(expected);
});
