import { describe, it, expect } from 'vitest';
import { evaluateSpendPolicy, parseConfirmPolicy, type SpendPolicy } from './policy';

// A permissive baseline; each test tightens ONE knob so a failure names the knob.
function policy(over: Partial<SpendPolicy> = {}): SpendPolicy {
  return {
    maxAutoSpendAtomic: 1_000_000n, // $1 auto
    sessionBudgetAtomic: 0n, // disabled
    confirm: { mode: 'above', thresholdAtomic: 1_000_000n },
    allowlistCreators: [],
    ...over,
  };
}

const req = (over: Partial<Parameters<typeof evaluateSpendPolicy>[1]> = {}) => ({
  amountAtomic: 100_000n, // $0.10
  creator: 'iris',
  sessionSpentAtomic: 0n,
  ...over,
});

describe('evaluateSpendPolicy, price cap (--max-price)', () => {
  it('denies when the amount exceeds the cap', () => {
    const r = evaluateSpendPolicy(
      policy(),
      req({ amountAtomic: 200_000n, maxPriceAtomic: 100_000n }),
    );
    expect(r.decision).toBe('deny');
    expect(r.reason).toBe('price_cap_exceeded');
  });
  it('allows exactly at the cap (boundary)', () => {
    const r = evaluateSpendPolicy(
      policy(),
      req({ amountAtomic: 100_000n, maxPriceAtomic: 100_000n }),
    );
    expect(r.decision).toBe('allow');
  });
  it('a price cap is a hard deny, not reduced to confirm even under a loose confirm policy', () => {
    const r = evaluateSpendPolicy(
      policy({ confirm: { mode: 'always' } }),
      req({ amountAtomic: 5n, maxPriceAtomic: 4n }),
    );
    expect(r.decision).toBe('deny');
    expect(r.reason).toBe('price_cap_exceeded');
  });
});

describe('evaluateSpendPolicy, allowlistCreators', () => {
  it('denies a creator not on a non-empty allowlist', () => {
    const r = evaluateSpendPolicy(
      policy({ allowlistCreators: ['alice'] }),
      req({ creator: 'iris' }),
    );
    expect(r.decision).toBe('deny');
    expect(r.reason).toBe('not_allowlisted');
  });
  it('allows a listed creator (case-insensitive)', () => {
    const r = evaluateSpendPolicy(
      policy({ allowlistCreators: ['IRIS'] }),
      req({ creator: 'iris' }),
    );
    expect(r.decision).toBe('allow');
  });
  it('an empty allowlist imposes no restriction', () => {
    const r = evaluateSpendPolicy(policy({ allowlistCreators: [] }), req({ creator: 'anyone' }));
    expect(r.decision).toBe('allow');
  });
});

describe('evaluateSpendPolicy, sessionBudget', () => {
  it('0 disables the ceiling', () => {
    const r = evaluateSpendPolicy(
      policy({ sessionBudgetAtomic: 0n }),
      req({ amountAtomic: 999_999_999n }),
    );
    expect(r.decision).not.toBe('deny');
  });
  it('denies when projected spend exceeds the budget', () => {
    const r = evaluateSpendPolicy(
      policy({ sessionBudgetAtomic: 500_000n }),
      req({ amountAtomic: 200_000n, sessionSpentAtomic: 400_000n }),
    );
    expect(r.decision).toBe('deny');
    expect(r.reason).toBe('session_budget_exceeded');
  });
  it('allows projected spend exactly at the budget (boundary)', () => {
    const r = evaluateSpendPolicy(
      policy({ sessionBudgetAtomic: 500_000n }),
      req({ amountAtomic: 100_000n, sessionSpentAtomic: 400_000n }),
    );
    expect(r.decision).not.toBe('deny');
  });
});

describe('evaluateSpendPolicy, maxAutoSpend + confirm', () => {
  it('default posture (maxAutoSpend 0, confirm always) requires confirmation for any spend', () => {
    const r = evaluateSpendPolicy(
      policy({ maxAutoSpendAtomic: 0n, confirm: { mode: 'always' } }),
      req({ amountAtomic: 1n }),
    );
    expect(r.decision).toBe('confirm');
    expect(r.reason).toBe('above_auto_spend');
  });
  it('confirm always forces a prompt even within maxAutoSpend', () => {
    const r = evaluateSpendPolicy(
      policy({ maxAutoSpendAtomic: 1_000_000n, confirm: { mode: 'always' } }),
      req({ amountAtomic: 100_000n }),
    );
    expect(r.decision).toBe('confirm');
    expect(r.reason).toBe('confirm_always');
  });
  it('allows silently when within maxAutoSpend and below the confirm threshold', () => {
    const r = evaluateSpendPolicy(
      policy({
        maxAutoSpendAtomic: 1_000_000n,
        confirm: { mode: 'above', thresholdAtomic: 500_000n },
      }),
      req({ amountAtomic: 100_000n }),
    );
    expect(r.decision).toBe('allow');
    expect(r.reason).toBe('within_policy');
  });
  it('confirms above the confirm threshold even within maxAutoSpend', () => {
    const r = evaluateSpendPolicy(
      policy({
        maxAutoSpendAtomic: 1_000_000n,
        confirm: { mode: 'above', thresholdAtomic: 200_000n },
      }),
      req({ amountAtomic: 300_000n }),
    );
    expect(r.decision).toBe('confirm');
    expect(r.reason).toBe('above_confirm_threshold');
  });
  it('confirms above maxAutoSpend regardless of the confirm threshold', () => {
    const r = evaluateSpendPolicy(
      policy({
        maxAutoSpendAtomic: 100_000n,
        confirm: { mode: 'above', thresholdAtomic: 1_000_000n },
      }),
      req({ amountAtomic: 200_000n }),
    );
    expect(r.decision).toBe('confirm');
    expect(r.reason).toBe('above_auto_spend');
  });
  it('allows exactly at maxAutoSpend (boundary) below threshold', () => {
    const r = evaluateSpendPolicy(
      policy({
        maxAutoSpendAtomic: 100_000n,
        confirm: { mode: 'above', thresholdAtomic: 100_000n },
      }),
      req({ amountAtomic: 100_000n }),
    );
    expect(r.decision).toBe('allow');
  });
});

describe('evaluateSpendPolicy, gate ordering', () => {
  it('price cap is checked before allowlist', () => {
    const r = evaluateSpendPolicy(
      policy({ allowlistCreators: ['alice'] }),
      req({ creator: 'iris', amountAtomic: 5n, maxPriceAtomic: 4n }),
    );
    expect(r.reason).toBe('price_cap_exceeded');
  });
  it('allowlist is checked before session budget', () => {
    const r = evaluateSpendPolicy(
      policy({ allowlistCreators: ['alice'], sessionBudgetAtomic: 1n }),
      req({ creator: 'iris', amountAtomic: 999n }),
    );
    expect(r.reason).toBe('not_allowlisted');
  });
});

describe('parseConfirmPolicy', () => {
  it('parses "always"', () => {
    expect(parseConfirmPolicy('always')).toEqual({ mode: 'always' });
  });
  it('parses "above:<atomic>"', () => {
    expect(parseConfirmPolicy('above:250000')).toEqual({
      mode: 'above',
      thresholdAtomic: 250_000n,
    });
  });
  it('fails closed to always on a malformed value', () => {
    expect(parseConfirmPolicy('garbage')).toEqual({ mode: 'always' });
  });
});
