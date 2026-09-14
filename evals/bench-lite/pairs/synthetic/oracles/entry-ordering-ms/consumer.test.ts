import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleRequest } from '../../src/http/handlers.ts';
import { listEntriesInWindow, postEntry } from '../../src/ledger.ts';
import { resetWorld, seedAccount } from '../../src/testing/harness.ts';

const START = '2026-03-04T12:00:00.000Z';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(START));
  resetWorld();
});

afterEach(() => {
  vi.useRealTimers();
});

/** The `code` of the LedgerError `fn` throws. */
function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code ?? 'no-code';
  }
  return 'no-throw';
}

/** Four entries: three inside one second, one in the next. */
function seedFour(): string {
  const account = seedAccount('standard');
  const post = (memo: string) =>
    postEntry({ accountId: account.id, amountCents: 1_000, kind: 'debit', memo });

  vi.setSystemTime(new Date('2026-03-04T12:00:00.100Z'));
  post('a');
  vi.setSystemTime(new Date('2026-03-04T12:00:00.500Z'));
  post('b');
  vi.setSystemTime(new Date('2026-03-04T12:00:00.900Z'));
  post('c');
  vi.setSystemTime(new Date('2026-03-04T12:00:01.200Z'));
  post('d');

  return account.id;
}

function memos(entries: { memo: string }[]): string[] {
  return entries.map((entry) => entry.memo);
}

describe('listEntriesInWindow', () => {
  it('takes everything when no bounds are given', () => {
    const accountId = seedFour();
    expect(memos(listEntriesInWindow(accountId, {}))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('includes an entry exactly on the since bound', () => {
    const accountId = seedFour();
    const entries = listEntriesInWindow(accountId, { since: '2026-03-04T12:00:00.500Z' });
    expect(memos(entries)).toEqual(['b', 'c', 'd']);
  });

  it('excludes an entry exactly on the until bound', () => {
    const accountId = seedFour();
    const entries = listEntriesInWindow(accountId, {
      since: '2026-03-04T12:00:00.100Z',
      until: '2026-03-04T12:00:00.500Z',
    });
    expect(memos(entries)).toEqual(['a']);
  });

  it('cuts a window inside one second at the millisecond', () => {
    const accountId = seedFour();
    const entries = listEntriesInWindow(accountId, {
      since: '2026-03-04T12:00:00.500Z',
      until: '2026-03-04T12:00:01.000Z',
    });
    expect(memos(entries)).toEqual(['b', 'c']);
  });

  it('can be empty', () => {
    const accountId = seedFour();
    const entries = listEntriesInWindow(accountId, {
      since: '2026-03-04T12:00:00.600Z',
      until: '2026-03-04T12:00:00.900Z',
    });
    expect(entries).toEqual([]);
  });

  it('returns what it returns oldest first', () => {
    const accountId = seedFour();
    const entries = listEntriesInWindow(accountId, { since: '2026-03-04T12:00:00.000Z' });
    expect(memos(entries)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('refuses a bound that is not a timestamp', () => {
    const accountId = seedFour();
    expect(codeOf(() => listEntriesInWindow(accountId, { since: 'yesterday' }))).toBe(
      'invalid_window',
    );
    expect(codeOf(() => listEntriesInWindow(accountId, { until: '' }))).toBe('invalid_window');
  });

  it('refuses an unknown account', () => {
    expect(codeOf(() => listEntriesInWindow('acc_nope', {}))).toBe('account_not_found');
  });
});

describe('GET /accounts/:accountId/entries with a window', () => {
  it('filters on the query string and counts what it returns', () => {
    const accountId = seedFour();
    const response = handleRequest({
      method: 'GET',
      path: `/accounts/${accountId}/entries`,
      query: { since: '2026-03-04T12:00:00.500Z', until: '2026-03-04T12:00:01.000Z' },
    });

    expect(response.status).toBe(200);
    expect(memos(response.body.entries as { memo: string }[])).toEqual(['b', 'c']);
    expect(response.body.count).toBe(2);
  });

  it('serves the whole account with no query string', () => {
    const accountId = seedFour();
    const response = handleRequest({ method: 'GET', path: `/accounts/${accountId}/entries` });
    expect(memos(response.body.entries as { memo: string }[])).toEqual(['a', 'b', 'c', 'd']);
    expect(response.body.count).toBe(4);
  });

  it('400s a bound that is not a timestamp', () => {
    const accountId = seedFour();
    const response = handleRequest({
      method: 'GET',
      path: `/accounts/${accountId}/entries`,
      query: { since: 'yesterday' },
    });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({ code: 'invalid_window' });
  });
});
