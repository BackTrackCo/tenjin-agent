import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalSpendAuthorizer } from './spend';
import { spendLedgerPath } from '../paths';
import { readSessionFile, type SessionFile } from '../session-present';
// The session-cache WRITER lives with the mint half by design; a test may cross
// that line freely (the import pin is on read.ts, not here), and writing the
// fixture through the production writer is what makes the collision case below
// exercise the real pairing rather than a hand-rolled file.
import { saveSessionFile } from '../session-key';
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
    await authA.commit(first.reservationId, 300_000n);

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
    await auth.commit(first.reservationId, 450_000n);
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
    await auth.commit(a.reservationId, 400_000n);
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

  it('release of an unknown or undefined id is a no-op (idempotent)', async () => {
    const auth = createLocalSpendAuthorizer({
      dir,
      policy: policy({ sessionBudgetAtomic: 500_000n }),
    });
    await auth.release('nope');
    await auth.release(undefined);
    const authz = await auth.authorize({ amountAtomic: 1n, creator: 'iris' });
    expect(authz.sessionSpentAtomic).toBe(0n);
    expect(authz.decision).not.toBe('deny');
  });

  // Minor 5 from the B2 review: a human can out-wait the reservation TTL at the
  // confirm prompt; the settled amount must still land in the committed ledger.
  it('commit records the settled amount even when the reservation TTL-expired', async () => {
    let now = 1_000_000_000_000;
    const auth = createLocalSpendAuthorizer({
      dir,
      policy: policy({ sessionBudgetAtomic: 500_000n }),
      now: () => now,
    });
    const a = await auth.authorize({ amountAtomic: 400_000n, creator: 'iris' });
    now += 11 * 60_000; // reservation evicted by freshen()
    await auth.commit(a.reservationId, 400_000n);
    const b = await auth.authorize({ amountAtomic: 200_000n, creator: 'iris' });
    expect(b.sessionSpentAtomic).toBe(400_000n);
    expect(b.decision).toBe('deny');
  });

  // The ledger used to live in session.json — the SAME file the P-256 session key
  // is cached in. Two incompatible schemas, and both readers treat a parse failure
  // as "absent", so each writer silently destroyed the other's file: minting a
  // session zeroed the spending window, and the next spend deleted the session key.
  it('leaves a cached session key intact and writes the ledger to spend.json', async () => {
    const session: SessionFile = {
      address: '0xabc',
      origin: 'https://tenjin.blog',
      delegation: 'D',
      exp: new Date(2_000_000_000_000).toISOString(),
      scope: 'read',
      publicKeyRaw: 'P',
      privateKeyJwk: { kty: 'EC', crv: 'P-256', d: 'd', x: 'x', y: 'y' },
    };
    await saveSessionFile(dir, session);

    const auth = createLocalSpendAuthorizer({
      dir,
      policy: policy({ sessionBudgetAtomic: 500_000n }),
    });
    const a = await auth.authorize({ amountAtomic: 300_000n, creator: 'iris' });
    await auth.commit(a.reservationId, 300_000n);

    const state = await readSessionFile(dir);
    expect(state.kind).toBe('ok');
    if (state.kind === 'ok') expect(state.file).toEqual(session);

    const ledger: unknown = JSON.parse(await readFile(spendLedgerPath(dir), 'utf8'));
    expect(ledger).toMatchObject({ schemaVersion: 3, committedAtomic: '300000' });
  });

  it('reports an unreadable ledger ONCE and restarts the window (fail-open)', async () => {
    await writeFile(spendLedgerPath(dir), 'not json {{{', { mode: 0o600 });
    const reasons: string[] = [];
    // Budget off, so neither call persists: both reads see the same broken file
    // and only the latch keeps the second one quiet.
    const auth = createLocalSpendAuthorizer({
      dir,
      policy: policy({ sessionBudgetAtomic: 0n }),
      onCorrupt: (reason) => reasons.push(reason),
    });
    const authz = await auth.authorize({ amountAtomic: 100_000n, creator: 'iris' });
    expect(authz.sessionSpentAtomic).toBe(0n); // the spend still proceeds
    await auth.commit(undefined, 100_000n);
    expect(reasons).toEqual(['not valid JSON']);
  });

  it('names the offending field when the ledger is JSON but not a ledger', async () => {
    await writeFile(spendLedgerPath(dir), JSON.stringify({ schemaVersion: 1 }), { mode: 0o600 });
    const reasons: string[] = [];
    const auth = createLocalSpendAuthorizer({
      dir,
      policy: policy({ sessionBudgetAtomic: 500_000n }),
      onCorrupt: (reason) => reasons.push(reason),
    });
    await auth.authorize({ amountAtomic: 100_000n, creator: 'iris' });
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('schemaVersion');
  });

  it('says nothing on a first run: an absent ledger is not a corrupt one', async () => {
    const reasons: string[] = [];
    const auth = createLocalSpendAuthorizer({
      dir,
      policy: policy({ sessionBudgetAtomic: 500_000n }),
      onCorrupt: (reason) => reasons.push(reason),
    });
    const a = await auth.authorize({ amountAtomic: 100_000n, creator: 'iris' });
    await auth.commit(a.reservationId, 100_000n);
    expect(reasons).toEqual([]);
  });

  it('commit with no reservation id (budget was off) still counts toward a future budget', async () => {
    const off = createLocalSpendAuthorizer({ dir, policy: policy({ sessionBudgetAtomic: 0n }) });
    const authz = await off.authorize({ amountAtomic: 300_000n, creator: 'iris' });
    expect(authz.reservationId).toBeUndefined();
    await off.commit(undefined, 300_000n);
    const on = createLocalSpendAuthorizer({
      dir,
      policy: policy({ sessionBudgetAtomic: 500_000n }),
    });
    const next = await on.authorize({ amountAtomic: 300_000n, creator: 'iris' });
    expect(next.sessionSpentAtomic).toBe(300_000n);
    expect(next.decision).toBe('deny');
  });

  it('tracks rolling hourly and daily spend, including pending reservations', async () => {
    let now = 1_000_000_000_000;
    const auth = createLocalSpendAuthorizer({
      dir,
      policy: policy({ hourlyBudgetAtomic: 500_000n, dailyBudgetAtomic: 900_000n }),
      now: () => now,
    });
    const first = await auth.authorize({ amountAtomic: 400_000n, creator: 'iris' });
    expect(first.reservationId).toBeTypeOf('string');
    const pendingDeny = await auth.authorize({ amountAtomic: 200_000n, creator: 'iris' });
    expect(pendingDeny.reason).toBe('hourly_budget_exceeded');
    await auth.commit(first.reservationId, 400_000n);

    now += 3_600_001;
    const afterHour = await auth.authorize({ amountAtomic: 500_000n, creator: 'iris' });
    expect(afterHour.decision).not.toBe('deny');
    await auth.commit(afterHour.reservationId, 500_000n);
    now += 3_600_001;
    const dailyDeny = await auth.authorize({ amountAtomic: 1n, creator: 'iris' });
    expect(dailyDeny.reason).toBe('daily_budget_exceeded');
  });

  it('conservatively migrates v2 committed spend into rolling history', async () => {
    const now = 1_000_000_000_000;
    await writeFile(
      spendLedgerPath(dir),
      JSON.stringify({
        schemaVersion: 2,
        windowStartMs: now - 1_000,
        committedAtomic: '400000',
        reservations: [],
      }),
    );
    const auth = createLocalSpendAuthorizer({
      dir,
      policy: policy({ hourlyBudgetAtomic: 500_000n }),
      now: () => now,
    });
    const denied = await auth.authorize({ amountAtomic: 100_001n, creator: 'iris' });
    expect(denied.reason).toBe('hourly_budget_exceeded');
  });
});
