import { beforeEach, describe, expect, it } from 'vitest';
import { readAuditLog } from '../../src/audit.ts';
import { runCli } from '../../src/cli.ts';
import type { CliIo } from '../../src/cli.ts';
import { reconcileAccount } from '../../src/commands/reconcile.ts';
import { db } from '../../src/db/queries.ts';
import { balanceFor, postEntry } from '../../src/ledger.ts';
import { auditActions, resetWorld, seedAccount } from '../../src/testing/harness.ts';

beforeEach(() => {
  resetWorld();
});

function recorder(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (line) => out.push(line), err: (line) => err.push(line) }, out, err };
}

function seedThree(): string {
  const account = seedAccount('standard');
  postEntry({ accountId: account.id, amountCents: 1_000, kind: 'credit', memo: 'a' });
  postEntry({ accountId: account.id, amountCents: 400, kind: 'debit', memo: 'b' });
  postEntry({ accountId: account.id, amountCents: 100, kind: 'debit', memo: 'c' });
  return account.id;
}

describe('reconcileAccount', () => {
  it('settles what is unsettled and counts what it saw', async () => {
    const accountId = seedThree();
    const summary = await reconcileAccount(accountId);

    expect(summary).toEqual({
      accountId,
      checked: 3,
      settled: 3,
      unsettled: 0,
      balanceCents: balanceFor(accountId).balanceCents,
    });
    expect(db.entries.all().every((row) => row.settled)).toBe(true);
  });

  it('settles nothing the second time', async () => {
    const accountId = seedThree();
    await reconcileAccount(accountId);
    const summary = await reconcileAccount(accountId);
    expect(summary).toMatchObject({ checked: 3, settled: 0, unsettled: 0 });
  });

  it('brackets the run in the audit trail', async () => {
    const accountId = seedThree();
    await reconcileAccount(accountId);

    const actions = auditActions();
    expect(actions[0]).toBe('reconcile.started');
    expect(actions.at(-1)).toBe('reconcile.finished');
    expect(actions.filter((action) => action === 'entry.settled')).toHaveLength(3);
  });

  it('puts the whole run under one request id', async () => {
    const accountId = seedThree();
    await reconcileAccount(accountId);

    const records = readAuditLog();
    expect(records.length).toBeGreaterThan(1);
    const ids = new Set(records.map((record) => record.requestId));
    expect(ids.size).toBe(1);
  });

  it('records what it found on the finishing event', async () => {
    const accountId = seedThree();
    const summary = await reconcileAccount(accountId);

    const finished = readAuditLog().find((record) => record.action === 'reconcile.finished');
    expect(finished?.accountId).toBe(accountId);
    expect(finished?.detail).toMatchObject({
      checked: 3,
      settled: 3,
      balanceCents: summary.balanceCents,
    });
  });

  it('refuses an unknown account', async () => {
    await expect(reconcileAccount('acc_nope')).rejects.toMatchObject({
      code: 'account_not_found',
    });
  });
});

describe('ledger reconcile', () => {
  it('prints what it did', async () => {
    const accountId = seedThree();
    const { io, out } = recorder();

    expect(await runCli(['reconcile', accountId], io)).toBe(0);
    expect(out[0]).toBe(
      `reconciled ${accountId}: checked 3, settled 3, balance ${balanceFor(accountId).balanceCents}`,
    );
  });

  it('leaves the same trail when it runs from the CLI', async () => {
    const accountId = seedThree();
    await runCli(['reconcile', accountId], recorder().io);

    const records = readAuditLog();
    expect(records.map((record) => record.action)).toContain('reconcile.finished');
    expect(new Set(records.map((record) => record.requestId)).size).toBe(1);
  });

  it('exits 1 on an unknown account', async () => {
    const { io, err } = recorder();
    expect(await runCli(['reconcile', 'acc_nope'], io)).toBe(1);
    expect(err.join('\n')).toContain('account_not_found');
  });

  it('exits 2 with no account id', async () => {
    const { io } = recorder();
    expect(await runCli(['reconcile'], io)).toBe(2);
  });
});
