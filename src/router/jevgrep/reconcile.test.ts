import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandContext } from '../../context';
import { spendLedgerPath } from '../../lib/paths';
import { canonicalHash } from '../../lib/request-schema';
import { readLedger, spentOf } from '../../lib/spend-ledger';
import { createLocalSpendAuthorizer } from '../../lib/wallet/spend';
import { reconcileJevgrepLedger } from './reconcile';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-jev-reconcile-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function ctx(): CommandContext {
  const sink = { write: () => true } as unknown as NodeJS.WritableStream;
  return {
    flags: { json: true, timeout: 1000 },
    dataDir: dir,
    io: { stdout: sink, stderr: sink, isTTY: false },
  };
}

describe('jevgrep ledger reconciliation', () => {
  it('settles only signed records whose evaluation has a saved response, and reports before applying', async () => {
    const authorizer = createLocalSpendAuthorizer({
      dir,
      policy: { maxAutoSpendAtomic: 50_000n, sessionBudgetAtomic: 100_000n, allowlistCreators: [] },
    });
    const runId = 'run-old';
    const answered = 'a'.repeat(64);
    const ids: string[] = [];
    for (const key of [answered, 'b'.repeat(64), 'c'.repeat(64)]) {
      const auth = await authorizer.authorize({
        creator: 'supplier.example',
        amountAtomic: 1000n,
        requestKey: key,
        durableRun: { id: runId, maxAtomic: 50_000n },
      });
      ids.push(auth.reservationId!);
    }
    await authorizer.markSigned!(ids[0]!);
    await authorizer.markSigned!(ids[1]!);
    const journal = join(dir, 'jevgrep', 'payments', canonicalHash(runId));
    await mkdir(journal, { recursive: true });
    await writeFile(join(journal, `${answered}.response.json`), '{"answers":{}}');

    const dry = await reconcileJevgrepLedger(ctx(), { apply: false });
    expect(dry).toEqual({
      unresolved: 2,
      answered: 1,
      settled: 0,
      applied: false,
      remainingUnknownAtomic: '2000',
    });
    let ledger = (await readLedger(spendLedgerPath(dir))).ledger!;
    expect(ledger.durable!.map((entry) => entry.state)).toEqual(['signed', 'signed', 'reserved']);
    expect(spentOf(ledger)).toBe(3000n);

    const applied = await reconcileJevgrepLedger(ctx(), { apply: true });
    expect(applied).toEqual({
      unresolved: 2,
      answered: 1,
      settled: 1,
      applied: true,
      remainingUnknownAtomic: '1000',
    });
    ledger = (await readLedger(spendLedgerPath(dir))).ledger!;
    expect(ledger.durable!.map((entry) => entry.state)).toEqual(['settled', 'signed', 'reserved']);
    // The settled money moved into the window counters: the budget input is unchanged today.
    expect(spentOf(ledger)).toBe(3000n);
    expect(ledger.automaticCommittedAtomic).toBe('1000');
    expect(await reconcileJevgrepLedger(ctx(), { apply: true })).toMatchObject({
      unresolved: 1,
      answered: 0,
      settled: 0,
    });
  });

  it('is a no-op without a ledger or journal', async () => {
    expect(await reconcileJevgrepLedger(ctx(), { apply: true })).toEqual({
      unresolved: 0,
      answered: 0,
      settled: 0,
      applied: true,
      remainingUnknownAtomic: '0',
    });
  });
});
