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
    sessionBudgetAtomic: 0n, // disabled
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
    expect(authz.reservationId).toBeTypeOf('string'); // reserved while budget in force
  });

  it('does not reserve when the budget is disabled (0)', async () => {
    const auth = createLocalSpendAuthorizer({ dir, policy: policy({ sessionBudgetAtomic: 0n }) });
    const authz = await auth.authorize({ amountAtomic: 100_000n, creator: 'iris' });
    expect(authz.reservationId).toBeUndefined();
  });

  it('commit finalizes a reservation, which a NEW authorizer over the same dir sees', async () => {
    const authA = createLocalSpendAuthorizer({
      dir,
      policy: policy({ sessionBudgetAtomic: 500_000n }),
    });
    const first = await authA.authorize({ amountAtomic: 300_000n, creator: 'iris' });
    await authA.commit(first.reservationId);

    // A brand-new authorizer instance (a fresh CLI process) must read the
    // accumulated spend from disk, not any in-memory closure.
    const authB = createLocalSpendAuthorizer({
      dir,
      policy: policy({ sessionBudgetAtomic: 500_000n }),
    });
    const second = await authB.authorize({ amountAtomic: 100_000n, creator: 'iris' });
    expect(second.sessionSpentAtomic).toBe(300_000n);
    expect(second.decision).not.toBe('deny');
  });

  it('a committed spend that fills the budget makes the next spend a session-budget deny', async () => {
    const auth = createLocalSpendAuthorizer({
      dir,
      policy: policy({ sessionBudgetAtomic: 500_000n }),
    });
    const first = await auth.authorize({ amountAtomic: 450_000n, creator: 'iris' });
    await auth.commit(first.reservationId);
    const second = await auth.authorize({ amountAtomic: 100_000n, creator: 'iris' });
    expect(second.decision).toBe('deny');
    expect(second.reason).toBe('session_budget_exceeded');
  });

  it('a PENDING reservation (never committed) still counts, so a second authorize is denied (TOCTOU)', async () => {
    const auth = createLocalSpendAuthorizer({
      dir,
      policy: policy({ sessionBudgetAtomic: 500_000n }),
    });
    // Simulates two concurrent processes: A reserves and has not committed yet.
    await auth.authorize({ amountAtomic: 400_000n, creator: 'iris' });
    const b = await auth.authorize({ amountAtomic: 400_000n, creator: 'iris' });
    expect(b.sessionSpentAtomic).toBe(400_000n); // A's reservation is visible
    expect(b.decision).toBe('deny');
    expect(b.reason).toBe('session_budget_exceeded');
  });

  it('release frees a reservation so the budget is available again', async () => {
    const auth = createLocalSpendAuthorizer({
      dir,
      policy: policy({ sessionBudgetAtomic: 500_000n }),
    });
    const a = await auth.authorize({ amountAtomic: 400_000n, creator: 'iris' });
    await auth.release(a.reservationId);
    const b = await auth.authorize({ amountAtomic: 400_000n, creator: 'iris' });
    expect(b.sessionSpentAtomic).toBe(0n);
    expect(b.decision).not.toBe('deny');
  });

  it('a rolled-over window resets committed spend and reservations', async () => {
    let now = 1_000_000_000_000;
    const auth = createLocalSpendAuthorizer({
      dir,
      policy: policy({ sessionBudgetAtomic: 500_000n }),
      windowMs: 1000,
      now: () => now,
    });
    const a = await auth.authorize({ amountAtomic: 400_000n, creator: 'iris' });
    await auth.commit(a.reservationId);
    now += 2000; // past the window
    const b = await auth.authorize({ amountAtomic: 400_000n, creator: 'iris' });
    expect(b.sessionSpentAtomic).toBe(0n);
    expect(b.decision).not.toBe('deny');
  });

  it('a dangling reservation self-expires after the TTL', async () => {
    let now = 1_000_000_000_000;
    const auth = createLocalSpendAuthorizer({
      dir,
      policy: policy({ sessionBudgetAtomic: 500_000n }),
      now: () => now,
    });
    await auth.authorize({ amountAtomic: 400_000n, creator: 'iris' }); // never committed
    now += 11 * 60_000; // 11 minutes, past the 10-minute reservation TTL
    const b = await auth.authorize({ amountAtomic: 400_000n, creator: 'iris' });
    expect(b.sessionSpentAtomic).toBe(0n);
    expect(b.decision).not.toBe('deny');
  });

  it('commit/release of an unknown or undefined id are no-ops (idempotent)', async () => {
    const auth = createLocalSpendAuthorizer({
      dir,
      policy: policy({ sessionBudgetAtomic: 500_000n }),
    });
    await auth.commit('nope');
    await auth.release('nope');
    await auth.commit(undefined);
    await auth.release(undefined);
    const authz = await auth.authorize({ amountAtomic: 1n, creator: 'iris' });
    expect(authz.sessionSpentAtomic).toBe(0n);
  });
});
