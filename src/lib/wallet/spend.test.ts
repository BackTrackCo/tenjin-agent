import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalSpendAuthorizer } from './spend';
import type { SpendPolicy } from '../policy';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-spend-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function policy(over: Partial<SpendPolicy> = {}): SpendPolicy {
  return {
    maxAutoSpendAtomic: 1_000_000n,
    sessionBudgetAtomic: 0n,
    confirm: { mode: 'above', thresholdAtomic: 1_000_000n },
    allowlistCreators: [],
    ...over,
  };
}

describe('createLocalSpendAuthorizer', () => {
  it('reports client-only enforcement (honest custody posture)', () => {
    const auth = createLocalSpendAuthorizer({ dir, policy: policy() });
    expect(auth.policyEnforcement).toBe('client-only');
  });

  it('surfaces the policy decision and the session context', async () => {
    const auth = createLocalSpendAuthorizer({
      dir,
      policy: policy({ sessionBudgetAtomic: 500_000n }),
    });
    const authz = await auth.authorize({ amountAtomic: 100_000n, creator: 'iris' });
    expect(authz.decision).toBe('allow');
    expect(authz.sessionSpentAtomic).toBe(0n);
    expect(authz.sessionBudgetAtomic).toBe(500_000n);
  });

  it('commit advances the rolling session ledger, which authorize then reads', async () => {
    const auth = createLocalSpendAuthorizer({
      dir,
      policy: policy({ sessionBudgetAtomic: 500_000n }),
    });
    await auth.commit(300_000n);
    const authz = await auth.authorize({ amountAtomic: 100_000n, creator: 'iris' });
    expect(authz.sessionSpentAtomic).toBe(300_000n);
    // 300k already + 100k = 400k <= 500k budget → still allowed.
    expect(authz.decision).not.toBe('deny');
  });

  it('a committed spend that fills the budget makes the next spend a session-budget deny', async () => {
    const auth = createLocalSpendAuthorizer({
      dir,
      policy: policy({ sessionBudgetAtomic: 500_000n }),
    });
    await auth.commit(450_000n);
    const authz = await auth.authorize({ amountAtomic: 100_000n, creator: 'iris' });
    expect(authz.decision).toBe('deny');
    expect(authz.reason).toBe('session_budget_exceeded');
  });

  it('commits accumulate within the window', async () => {
    const auth = createLocalSpendAuthorizer({
      dir,
      policy: policy({ sessionBudgetAtomic: 1_000_000n }),
    });
    await auth.commit(100_000n);
    await auth.commit(200_000n);
    const authz = await auth.authorize({ amountAtomic: 1n, creator: 'iris' });
    expect(authz.sessionSpentAtomic).toBe(300_000n);
  });

  it('a rolled-over window resets the spent total', async () => {
    let now = 1_000_000_000_000;
    const auth = createLocalSpendAuthorizer({
      dir,
      policy: policy({ sessionBudgetAtomic: 500_000n }),
      windowMs: 1000,
      now: () => now,
    });
    await auth.commit(400_000n);
    now += 2000; // past the window
    const authz = await auth.authorize({ amountAtomic: 400_000n, creator: 'iris' });
    expect(authz.sessionSpentAtomic).toBe(0n);
    expect(authz.decision).not.toBe('deny');
  });
});
