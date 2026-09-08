import { expect, test } from 'vitest';
import { actorKey } from '../src/actor.mjs';

// The cases arrive through the runner's setup file; a run is the only way to learn them.
const cases = globalThis.__bench1Cases?.actor ?? [];

test.each(cases)('actorKey case %#', ({ args, expected }) => {
  expect(actorKey(...args)).toBe(expected);
});
