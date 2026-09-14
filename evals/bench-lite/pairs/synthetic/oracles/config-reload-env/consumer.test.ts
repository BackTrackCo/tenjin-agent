import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readAuditLogFor } from '../../src/audit.ts';
import { db } from '../../src/db/queries.ts';
import { handleRequest } from '../../src/http/handlers.ts';
import { postEntry } from '../../src/ledger.ts';
import { resetWorld, seedAccount } from '../../src/testing/harness.ts';

beforeEach(() => {
  delete process.env.LEDGER_FLAGS;
  resetWorld();
});

afterEach(() => {
  delete process.env.LEDGER_FLAGS;
});

function seedTwo(): string {
  const account = seedAccount('standard');
  postEntry({ accountId: account.id, amountCents: 1_000, kind: 'credit', memo: 'a' });
  postEntry({ accountId: account.id, amountCents: 250, kind: 'debit', memo: 'b' });
  return account.id;
}

function settle(accountId: string) {
  return handleRequest({ method: 'POST', path: `/accounts/${accountId}/settle`, body: {} });
}

describe('POST /accounts/:accountId/settle', () => {
  it('settles what is open and says how many', () => {
    const accountId = seedTwo();
    const response = settle(accountId);

    expect(response.status).toBe(200);
    expect(response.body.settled).toBe(2);
    expect(db.entries.all().every((row) => row.settled)).toBe(true);
  });

  it('settles nothing the second time', () => {
    const accountId = seedTwo();
    settle(accountId);
    expect(settle(accountId).body.settled).toBe(0);
  });

  it('runs the old path when the flag is off', () => {
    const accountId = seedTwo();
    expect(settle(accountId).body.mode).toBe('v1');
  });

  it('runs the new path when the flag is on', () => {
    const accountId = seedTwo();
    process.env.LEDGER_FLAGS = 'settlement_v2';
    expect(settle(accountId).body.mode).toBe('v2');
  });

  it('finds the flag among others', () => {
    const accountId = seedTwo();
    process.env.LEDGER_FLAGS = 'audit_v3, settlement_v2 ,shadow_reads';
    expect(settle(accountId).body.mode).toBe('v2');
  });

  it('goes back to the old path when the flag goes away', () => {
    const accountId = seedTwo();
    process.env.LEDGER_FLAGS = 'settlement_v2';
    expect(settle(accountId).body.mode).toBe('v2');

    delete process.env.LEDGER_FLAGS;
    const again = settle(accountId);
    expect(again.body.mode).toBe('v1');
  });

  it('is not fooled by a flag that merely contains the name', () => {
    const accountId = seedTwo();
    process.env.LEDGER_FLAGS = 'settlement_v2_shadow';
    expect(settle(accountId).body.mode).toBe('v1');
  });

  it('records the mode it ran in', () => {
    const accountId = seedTwo();
    process.env.LEDGER_FLAGS = 'settlement_v2';
    settle(accountId);

    const records = readAuditLogFor('settlement.completed');
    expect(records).toHaveLength(1);
    expect(records[0]?.accountId).toBe(accountId);
    expect(records[0]?.detail).toMatchObject({ mode: 'v2', settled: 2 });
  });

  it('records the old mode too', () => {
    const accountId = seedTwo();
    settle(accountId);
    expect(readAuditLogFor('settlement.completed')[0]?.detail).toMatchObject({
      mode: 'v1',
      settled: 2,
    });
  });

  it('404s an unknown account', () => {
    const response = settle('acc_nope');
    expect(response.status).toBe(404);
    expect(response.body.error).toMatchObject({ code: 'account_not_found' });
  });
});
