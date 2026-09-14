import { beforeEach, describe, expect, it } from 'vitest';
import { updateSettings } from '../src/accounts.ts';
import { balanceFor, listEntries, postEntries, postEntry } from '../src/ledger.ts';
import { resetWorld, seedAccount } from '../src/testing/harness.ts';

beforeEach(() => {
  resetWorld();
});

describe('postEntry', () => {
  it('prices the entry from the account plan', () => {
    const account = seedAccount('standard');
    const entry = postEntry({ accountId: account.id, amountCents: 10_000, kind: 'debit' });
    expect(entry.feeCents).toBe(35);
    expect(entry.amountCents).toBe(10_000);
    expect(entry.idempotencyKey).toBeNull();
  });

  it('refuses an amount over the spending limit', () => {
    const account = seedAccount('starter');
    updateSettings(account.id, { spendingLimitCents: 1_000 });
    expect(() => postEntry({ accountId: account.id, amountCents: 1_001, kind: 'debit' })).toThrow(
      /spending limit/,
    );
  });

  it('refuses a zero or negative amount', () => {
    const account = seedAccount('standard');
    expect(() => postEntry({ accountId: account.id, amountCents: 0, kind: 'credit' })).toThrow(
      /greater than zero/,
    );
  });

  it('refuses an unknown account', () => {
    expect(() => postEntry({ accountId: 'acc_nope', amountCents: 10, kind: 'debit' })).toThrow(
      /no such account/,
    );
  });

  it('returns the first entry when the same idempotency key comes back', () => {
    const account = seedAccount('standard');
    const first = postEntry({
      accountId: account.id,
      amountCents: 500,
      kind: 'credit',
      idempotencyKey: 'key-1',
    });
    const second = postEntry({
      accountId: account.id,
      amountCents: 500,
      kind: 'credit',
      idempotencyKey: 'key-1',
    });
    expect(second.id).toBe(first.id);
    expect(listEntries(account.id)).toHaveLength(1);
  });

  it('truncates a long memo', () => {
    const account = seedAccount('standard');
    const entry = postEntry({
      accountId: account.id,
      amountCents: 100,
      kind: 'debit',
      memo: 'x'.repeat(200),
    });
    expect(entry.memo).toHaveLength(140);
  });
});

describe('postEntries', () => {
  it('posts every entry in the batch', () => {
    const account = seedAccount('scale');
    const entries = postEntries([
      { accountId: account.id, amountCents: 1_000, kind: 'debit' },
      { accountId: account.id, amountCents: 2_000, kind: 'credit' },
    ]);
    expect(entries).toHaveLength(2);
    expect(listEntries(account.id)).toHaveLength(2);
  });

  it('refuses an empty batch', () => {
    expect(() => postEntries([])).toThrow(/at least one/);
  });
});

describe('balanceFor', () => {
  it('is credits less debits less fees', () => {
    const account = seedAccount('starter');
    postEntry({ accountId: account.id, amountCents: 5_000, kind: 'credit' });
    postEntry({ accountId: account.id, amountCents: 1_000, kind: 'debit' });
    const balance = balanceFor(account.id);
    expect(balance.feesCents).toBe(35);
    expect(balance.balanceCents).toBe(5_000 - 1_000 - 35);
    expect(balance.entryCount).toBe(2);
    expect(balance.currency).toBe('USD');
  });

  it('is zero for an account with no entries', () => {
    const account = seedAccount('standard');
    expect(balanceFor(account.id)).toMatchObject({ balanceCents: 0, entryCount: 0 });
  });
});
