import { beforeEach, describe, expect, it } from 'vitest';
import { isKey } from '../../src/hash.ts';
import { handleRequest } from '../../src/http/handlers.ts';
import { contentKey, listEntries } from '../../src/ledger.ts';
import { resetWorld, seedAccount } from '../../src/testing/harness.ts';

beforeEach(() => {
  resetWorld();
});

describe('contentKey', () => {
  it('is one of our keys', () => {
    const key = contentKey({ accountId: 'acc_1', amountCents: 100, kind: 'debit', memo: 'x' });
    expect(key).toHaveLength(32);
    expect(isKey(key)).toBe(true);
  });

  it('is the same key for the same content', () => {
    const input = { accountId: 'acc_1', amountCents: 100, kind: 'debit' as const, memo: 'x' };
    expect(contentKey(input)).toBe(contentKey({ ...input }));
  });

  it('does not care what order the fields were written in', () => {
    const first = contentKey({ accountId: 'acc_1', amountCents: 100, kind: 'debit', memo: 'x' });
    const second = contentKey({ memo: 'x', kind: 'debit', amountCents: 100, accountId: 'acc_1' });
    expect(second).toBe(first);
  });

  it('treats an amount written as a string as the same amount', () => {
    const asNumber = contentKey({ accountId: 'acc_1', amountCents: 100, kind: 'debit' });
    const asString = contentKey({ accountId: 'acc_1', amountCents: '100', kind: 'debit' });
    expect(asString).toBe(asNumber);
  });

  it('treats a missing memo as an empty one', () => {
    const absent = contentKey({ accountId: 'acc_1', amountCents: 100, kind: 'credit' });
    const empty = contentKey({ accountId: 'acc_1', amountCents: 100, kind: 'credit', memo: '' });
    expect(absent).toBe(empty);
  });

  it('is a different key for different content', () => {
    const base = { accountId: 'acc_1', amountCents: 100, kind: 'debit' as const, memo: 'x' };
    const keys = new Set([
      contentKey(base),
      contentKey({ ...base, accountId: 'acc_2' }),
      contentKey({ ...base, amountCents: 101 }),
      contentKey({ ...base, kind: 'credit' }),
      contentKey({ ...base, memo: 'y' }),
    ]);
    expect(keys.size).toBe(5);
  });
});

describe('POST /entries without an Idempotency-Key', () => {
  function post(body: unknown) {
    return handleRequest({ method: 'POST', path: '/entries', body });
  }

  it('creates the entry the first time', () => {
    const account = seedAccount('standard');
    const response = post({
      accountId: account.id,
      amountCents: 700,
      kind: 'debit',
      memo: 'rent',
    });

    expect(response.status).toBe(201);
    expect(response.body.duplicate).toBe(false);
    expect(listEntries(account.id)).toHaveLength(1);
  });

  it('stores the derived key on the entry', () => {
    const account = seedAccount('standard');
    post({ accountId: account.id, amountCents: 700, kind: 'debit', memo: 'rent' });

    expect(listEntries(account.id)[0]?.idempotencyKey).toBe(
      contentKey({ accountId: account.id, amountCents: 700, kind: 'debit', memo: 'rent' }),
    );
  });

  it('does not post the same content twice', () => {
    const account = seedAccount('standard');
    const first = post({
      accountId: account.id,
      amountCents: 700,
      kind: 'debit',
      memo: 'rent',
    });
    const second = post({
      memo: 'rent',
      kind: 'debit',
      amountCents: 700,
      accountId: account.id,
    });

    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect((second.body.entry as { id: string }).id).toBe((first.body.entry as { id: string }).id);
    expect(listEntries(account.id)).toHaveLength(1);
  });

  it('sees through an amount sent as a string', () => {
    const account = seedAccount('standard');
    post({ accountId: account.id, amountCents: 700, kind: 'debit', memo: 'rent' });
    const second = post({ accountId: account.id, amountCents: '700', kind: 'debit', memo: 'rent' });

    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect(listEntries(account.id)).toHaveLength(1);
  });

  it('takes a genuinely different entry', () => {
    const account = seedAccount('standard');
    post({ accountId: account.id, amountCents: 700, kind: 'debit', memo: 'rent' });
    const other = post({ accountId: account.id, amountCents: 700, kind: 'debit', memo: 'rates' });

    expect(other.status).toBe(201);
    expect(other.body.duplicate).toBe(false);
    expect(listEntries(account.id)).toHaveLength(2);
  });
});

describe('POST /entries with an Idempotency-Key', () => {
  function post(body: unknown, key: string) {
    return handleRequest({
      method: 'POST',
      path: '/entries',
      body,
      headers: { 'idempotency-key': key },
    });
  }

  it('keys on the header when there is one', () => {
    const account = seedAccount('standard');
    const body = { accountId: account.id, amountCents: 700, kind: 'debit', memo: 'rent' };

    const first = post(body, 'abc');
    expect(first.status).toBe(201);
    expect(first.body.duplicate).toBe(false);
    expect((first.body.entry as { idempotencyKey: string }).idempotencyKey).toBe('abc');

    const second = post({ ...body, memo: 'something else' }, 'abc');
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect((second.body.entry as { id: string }).id).toBe((first.body.entry as { id: string }).id);
    expect(listEntries(account.id)).toHaveLength(1);
  });
});
