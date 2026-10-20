import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLocalSpendAuthorizer } from '../lib/wallet/spend';
import { runHookKind } from './hook-command';
import { costLines, fail, paymentsOf } from './tool';
import { turnSpendLine } from './turn-spend';

/** THE TURN'S SPEND LINE, the `Stop` leg's `systemMessage`, and the payments it counts. */

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'router-turn-spend-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('the payments one result made', () => {
  it('counts a single call, and nothing for a free one', () => {
    expect(paymentsOf({ status: 'fulfilled', cost: costLines(7_000n) })).toEqual([7_000n]);
    expect(paymentsOf({ status: 'spec', cost: costLines(0n) })).toEqual([]);
  });

  it('counts every take of a count, leaving out one an earlier call paid', () => {
    const take = (atomic: bigint) => ({ status: 'fulfilled', cost: costLines(atomic) });
    const envelope = {
      status: 'fulfilled',
      results: [
        take(30_000n),
        take(30_000n),
        take(30_000n),
        { status: 'already_paid', cost: costLines(0n) },
      ],
      cost: costLines(90_000n),
    };
    expect(paymentsOf(envelope)).toEqual([30_000n, 30_000n, 30_000n]);
  });

  it('counts a call that failed after its payment left', () => {
    const failed = fail('failed', 'The provider answered 500.', { providerAtomic: 40_000n });
    expect(paymentsOf(failed.envelope)).toEqual([40_000n]);
  });
});

describe('the Stop leg', () => {
  it("says the turn's lookups, their total and today's spend against the budget", async () => {
    await createLocalSpendAuthorizer({
      dir,
      policy: {
        maxAutoSpendAtomic: 250_000n,
        sessionBudgetAtomic: 5_000_000n,
        allowlistCreators: [],
      },
    }).commit(undefined, 310_000n);
    expect(await turnSpendLine([30_000n, 60_000n], dir, 5_000_000n)).toBe(
      '2 paid lookups, $0.09 · today $0.31 of $5.00',
    );
    expect(await turnSpendLine([7_000n], dir, null)).toBe('1 paid lookup, $0.007 · today $0.31');
    expect(await turnSpendLine([], dir, 5_000_000n)).toBeNull();
  });

  it('answers with a systemMessage, and nothing where no server counted', async () => {
    const line = async () => '1 paid lookup, $0.007';
    expect(await runHookKind('stop', {}, { dataDir: dir, stopLine: line })).toEqual({
      systemMessage: '1 paid lookup, $0.007',
    });
    expect(await runHookKind('stop', {}, { dataDir: dir })).toBeNull();
  });
});
