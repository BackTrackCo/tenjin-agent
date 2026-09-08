import { expect, test } from 'vitest';
import { actorKey } from '../src/actor.mjs';
import { cases } from './support/cases.mjs';

test.each(cases)('actorKey case %#', ({ args, expected }) => {
  expect(actorKey(...args)).toBe(expected);
});
