import { expect, test } from 'vitest';
import { repoSlug } from '../src/slug.mjs';

// The cases arrive through the runner's setup file; a run is the only way to learn them.
const cases = globalThis.__bench1Cases?.slug ?? [];

test.each(cases)('repoSlug case %#', ({ args, expected }) => {
  expect(repoSlug(...args)).toBe(expected);
});
