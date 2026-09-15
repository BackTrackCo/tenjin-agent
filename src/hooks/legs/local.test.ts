import { describe, expect, it } from 'vitest';
import { localLeg } from './local';
import type { Answer, Question } from '../types';

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
    const result = await leg.request(Q, 4000, new AbortController().signal);
    expect(result).toMatchObject({ status: 'ok', title: PARKED.title });
    expect(leg.verdict(result)).toEqual(PARKED);
  });

  it('an answer that is not there is a definite miss: ok, and null', async () => {
    const leg = localLeg('team', () => null);
    const result = await leg.request(Q, 4000, new AbortController().signal);
    expect(result.status).toBe('ok');
    expect(leg.verdict(result)).toBeNull();
  });

  it("carries the parked answer's own shelf, so a parked public piece stays public", () => {
    expect(localLeg('public', () => null).shelf).toBe('public');
  });
});
