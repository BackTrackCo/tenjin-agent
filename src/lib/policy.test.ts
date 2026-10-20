import { describe, it, expect } from 'vitest';
import { evaluatePlan, evaluateSpendPolicy, type SpendPolicy } from './policy';

// A permissive baseline; each test tightens ONE knob so a failure names the knob.
function policy(over: Partial<SpendPolicy> = {}): SpendPolicy {
  return {
    maxAutoSpendAtomic: 1_000_000n, // $1 auto
    sessionBudgetAtomic: null, // disabled
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
    const r = evaluateSpendPolicy(policy(), req({ amountAtomic: 5n, maxPriceAtomic: 4n }));
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
  it('none removes the ceiling', () => {
    const r = evaluateSpendPolicy(
      policy({ sessionBudgetAtomic: null, maxAutoSpendAtomic: 999_999_999n }),
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

describe('automatic limits and mandatory manual consent', () => {
  it.each([0n, 99_999n])('refuses automatic spending above threshold %s', (maxAutoSpendAtomic) => {
    expect(evaluateSpendPolicy(policy({ maxAutoSpendAtomic }), req())).toMatchObject({
      decision: 'deny',
      reason: 'above_auto_spend',
    });
  });
  it('allows the exact automatic threshold', () => {
    expect(evaluateSpendPolicy(policy({ maxAutoSpendAtomic: 100_000n }), req()).decision).toBe(
      'allow',
    );
  });
  it.each([0n, 1n, null])(
    'manual consent is independent of budget %s and automatic threshold',
    (sessionBudgetAtomic) => {
      expect(
        evaluateSpendPolicy(
          policy({ sessionBudgetAtomic, maxAutoSpendAtomic: 0n }),
          req({ mode: 'manual', sessionSpentAtomic: 9_000_000n }),
        ),
      ).toMatchObject({ decision: 'confirm', reason: 'confirm_always' });
    },
  );
  it('even a small manual payment needs consent', () => {
    expect(evaluateSpendPolicy(policy(), req({ mode: 'manual' })).decision).toBe('confirm');
  });
  it('manual consent does not override price or creator checks', () => {
    expect(evaluateSpendPolicy(policy(), req({ mode: 'manual', maxPriceAtomic: 1n })).reason).toBe(
      'price_cap_exceeded',
    );
    expect(
      evaluateSpendPolicy(policy({ allowlistCreators: ['other'] }), req({ mode: 'manual' })).reason,
    ).toBe('not_allowlisted');
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

describe('explicit zero daily limit', () => {
  it('denies positive amounts before confirmation and permits zero', () => {
    expect(
      evaluateSpendPolicy(policy({ sessionBudgetAtomic: 0n }), req({ amountAtomic: 1n })),
    ).toMatchObject({ decision: 'deny', reason: 'session_budget_exceeded' });
    expect(
      evaluateSpendPolicy(policy({ sessionBudgetAtomic: 0n }), req({ amountAtomic: 0n })),
    ).toMatchObject({ decision: 'allow' });
  });
});

/** ONE CALL'S PAYMENTS, AS A WHOLE: their total held to the per-call limit
 *  and, with what the window spent, to the budget, before any is signed. */
describe('evaluatePlan', () => {
  const step = (amountAtomic: bigint, creator = 'x402.aispace.bot') => ({ amountAtomic, creator });
  const cap = policy({ maxAutoSpendAtomic: 250_000n, sessionBudgetAtomic: 5_000_000n });

  it('holds the total to the per-call limit, however many payments make it', () => {
    expect(evaluatePlan(cap, [step(115_000n), step(95_000n), step(40_000n)], 0n)).toMatchObject({
      decision: 'allow',
    });
    expect(evaluatePlan(cap, [step(115_000n), step(95_000n), step(43_000n)], 0n)).toMatchObject({
      decision: 'deny',
      reason: 'above_auto_spend',
    });
  });

  it('counts what the session already spent against the budget', () => {
    const budget = policy({ maxAutoSpendAtomic: 250_000n, sessionBudgetAtomic: 300_000n });
    const set = [step(115_000n), step(95_000n), step(43_000n)];
    const roomy = policy({ maxAutoSpendAtomic: 1_000_000n, sessionBudgetAtomic: 300_000n });
    expect(evaluatePlan(roomy, set, 47_000n)).toMatchObject({ decision: 'allow' });
    expect(evaluatePlan(roomy, set, 48_000n)).toMatchObject({
      decision: 'deny',
      reason: 'session_budget_exceeded',
    });
    expect(evaluatePlan(budget, set, 0n)).toMatchObject({ reason: 'above_auto_spend' });
  });

  it('holds every payee to the allowlist', () => {
    const listed = policy({ allowlistCreators: ['x402.aispace.bot'] });
    expect(evaluatePlan(listed, [step(1n), step(1n, 'blockrun.ai')], 0n)).toMatchObject({
      decision: 'deny',
      reason: 'not_allowlisted',
    });
  });
});
