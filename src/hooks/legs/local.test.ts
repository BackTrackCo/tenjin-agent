import { describe, expect, it } from 'vitest';
import { localLeg } from './local';
import type { Answer, Deps, Question } from '../types';

/** A local leg reads no auth and makes no request; `Deps` is a formality here. */
const DEPS = {} as Deps;

const Q: Question = { text: 'q', questionKey: 'qk' };
const PARKED: Answer = {
  shelf: 'team',
  resourceId: '22222222-2222-4222-8222-222222222222',
  title: 'The collation flip',
  text: 'The collation flips on an image swap.',
};

describe('localLeg', () => {
  it('resolves at once with status ok, and the parked answer is its verdict', async () => {
    const leg = localLeg('team', () => PARKED);
    const [result] = await leg.request(Q, 4000, new AbortController().signal, DEPS);
    expect(result).toMatchObject({ shelf: 'team', status: 'ok', title: PARKED.title });
    expect(result?.answer).toEqual(PARKED);
  });

  it('an answer that is not there is a definite miss: ok, and null', async () => {
    const leg = localLeg('team', () => null);
    const [result] = await leg.request(Q, 4000, new AbortController().signal, DEPS);
    expect(result?.status).toBe('ok');
    expect(result?.answer).toBeNull();
  });

  it("carries the parked answer's own shelf, so a parked public piece stays public", () => {
    expect(localLeg('public', () => null).shelves).toEqual(['public']);
  });
});
