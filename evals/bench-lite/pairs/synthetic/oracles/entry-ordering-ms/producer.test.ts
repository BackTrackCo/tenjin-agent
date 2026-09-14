import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleRequest } from '../../src/http/handlers.ts';
import { listEntries, postEntry } from '../../src/ledger.ts';
import { resetWorld, seedAccount } from '../../src/testing/harness.ts';

const T0 = '2026-03-04T12:00:00.123Z';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(T0));
  resetWorld();
});

afterEach(() => {
  vi.useRealTimers();
});

function post(accountId: string, memo: string) {
  return postEntry({ accountId, amountCents: 1_000, kind: 'debit', memo });
}

describe('listEntries', () => {
  it('returns entries in the order they were posted, inside one second', () => {
    const account = seedAccount('standard');
    post(account.id, 'a');
    post(account.id, 'b');
    post(account.id, 'c');

    expect(listEntries(account.id).map((entry) => entry.memo)).toEqual(['a', 'b', 'c']);
  });

  it('numbers the entries of an account from one, in posting order', () => {
    const account = seedAccount('standard');
    post(account.id, 'a');
    post(account.id, 'b');
    post(account.id, 'c');

    expect(listEntries(account.id).map((entry) => entry.sequence)).toEqual([1, 2, 3]);
  });

  it('numbers each account separately', () => {
    const first = seedAccount('standard', 'First');
    const second = seedAccount('standard', 'Second');
    post(first.id, 'a');
    post(second.id, 'b');
    post(first.id, 'c');

    expect(listEntries(first.id).map((entry) => entry.sequence)).toEqual([1, 2]);
    expect(listEntries(second.id).map((entry) => entry.sequence)).toEqual([1]);
  });
});

describe('entry timestamps', () => {
  it('keeps the millisecond the entry was posted at', () => {
    const account = seedAccount('standard');
    const entry = post(account.id, 'a');
    expect(entry.createdAt.toISOString()).toBe(T0);
    expect(listEntries(account.id)[0]?.createdAt.toISOString()).toBe(T0);
  });

  it('keeps the millisecond of a later entry too', () => {
    const account = seedAccount('standard');
    post(account.id, 'a');
    vi.advanceTimersByTime(400);
    const later = post(account.id, 'b');

    expect(later.createdAt.toISOString()).toBe('2026-03-04T12:00:00.523Z');
    expect(listEntries(account.id).map((entry) => entry.createdAt.toISOString())).toEqual([
      T0,
      '2026-03-04T12:00:00.523Z',
    ]);
  });

  it('orders entries posted in different seconds by time', () => {
    const account = seedAccount('standard');
    post(account.id, 'a');
    vi.advanceTimersByTime(2_000);
    post(account.id, 'b');
    expect(listEntries(account.id).map((entry) => entry.memo)).toEqual(['a', 'b']);
  });
});

describe('GET /accounts/:accountId/entries', () => {
  it('serves the same order, sequence and timestamps', () => {
    const account = seedAccount('standard');
    post(account.id, 'a');
    post(account.id, 'b');

    const response = handleRequest({ method: 'GET', path: `/accounts/${account.id}/entries` });
    const entries = response.body.entries as { memo: string; sequence: number; createdAt: string }[];

    expect(response.status).toBe(200);
    expect(entries.map((entry) => entry.memo)).toEqual(['a', 'b']);
    expect(entries.map((entry) => entry.sequence)).toEqual([1, 2]);
    expect(entries.map((entry) => entry.createdAt)).toEqual([T0, T0]);
  });

  it('puts the sequence and the timestamp on a posted entry', () => {
    const account = seedAccount('standard');
    const response = handleRequest({
      method: 'POST',
      path: '/entries',
      body: { accountId: account.id, amountCents: 500, kind: 'credit', memo: 'first' },
    });
    expect(response.status).toBe(201);
    expect(response.body.entry).toMatchObject({ sequence: 1, createdAt: T0 });
  });
});
