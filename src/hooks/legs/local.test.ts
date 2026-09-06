import { describe, expect, it } from 'vitest';
import { localLeg } from './local';
import type { Answer, Question } from '../types';

const Q: Question = { text: 'q', questionKey: 'qk' };
const PAIRING: Answer = {
  shelf: 'local',
  resourceId: 'pairing-7',
  title: 'ENOENT: no such file',
  text: 'Fixed here before by changing foo.ts.',
};

describe('localLeg', () => {
  it('resolves at once with status ok, and the record is its verdict', async () => {
    const leg = localLeg('local', () => PAIRING);
    const result = await leg.request(Q, 4000, new AbortController().signal);
    expect(result).toMatchObject({ status: 'ok', title: PAIRING.title });
    expect(leg.verdict(result)).toEqual(PAIRING);
  });

  it('a record that is not there is a definite miss: ok, and null', async () => {
    const leg = localLeg('team', () => null);
    const result = await leg.request(Q, 4000, new AbortController().signal);
    expect(result.status).toBe('ok');
    expect(leg.verdict(result)).toBeNull();
  });

  it("carries the parked answer's own shelf, so a parked public piece stays public", () => {
    expect(localLeg('public', () => null).shelf).toBe('public');
  });
});
