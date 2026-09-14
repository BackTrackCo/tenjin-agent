import { beforeEach, describe, expect, it } from 'vitest';
import { importRows, rowKey } from '../../src/commands/import.ts';
import type { ImportRow } from '../../src/commands/import.ts';
import { isKey } from '../../src/hash.ts';
import { listEntries } from '../../src/ledger.ts';
import { resetWorld, seedAccount } from '../../src/testing/harness.ts';

beforeEach(() => {
  resetWorld();
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

const ROWS: ImportRow[] = [
  { amountCents: 1_000, kind: 'credit', memo: 'takings', reference: 'INV-1' },
  { amountCents: 250, kind: 'debit', memo: 'fees', reference: 'INV-2' },
  { amountCents: 75, kind: 'debit', memo: 'fees', reference: 'INV-3' },
];

/** The same three rows, with the fields written in a different order. */
const ROWS_REORDERED: ImportRow[] = [
  { reference: 'INV-1', memo: 'takings', kind: 'credit', amountCents: 1_000 },
  { kind: 'debit', reference: 'INV-2', amountCents: 250, memo: 'fees' },
  { memo: 'fees', amountCents: 75, reference: 'INV-3', kind: 'debit' },
];

describe('rowKey', () => {
  it('is one of our keys', () => {
    const key = rowKey('acc_1', ROWS[0] as ImportRow);
    expect(key).toHaveLength(32);
    expect(isKey(key)).toBe(true);
  });

  it('does not care what order the source wrote the columns in', () => {
    expect(rowKey('acc_1', ROWS_REORDERED[0] as ImportRow)).toBe(
      rowKey('acc_1', ROWS[0] as ImportRow),
    );
    expect(rowKey('acc_1', ROWS_REORDERED[1] as ImportRow)).toBe(
      rowKey('acc_1', ROWS[1] as ImportRow),
    );
  });

  it('treats an amount written as a string as the same amount', () => {
    expect(rowKey('acc_1', { amountCents: '250', kind: 'debit', memo: 'fees' })).toBe(
      rowKey('acc_1', { amountCents: 250, kind: 'debit', memo: 'fees' }),
    );
  });

  it('treats a missing memo or reference as an empty one', () => {
    expect(rowKey('acc_1', { amountCents: 250, kind: 'debit' })).toBe(
      rowKey('acc_1', { amountCents: 250, kind: 'debit', memo: '', reference: '' }),
    );
  });

  it('separates rows that differ in any field', () => {
    const base: ImportRow = { amountCents: 250, kind: 'debit', memo: 'fees', reference: 'INV-2' };
    const keys = new Set([
      rowKey('acc_1', base),
      rowKey('acc_2', base),
      rowKey('acc_1', { ...base, amountCents: 251 }),
      rowKey('acc_1', { ...base, kind: 'credit' }),
      rowKey('acc_1', { ...base, memo: 'other' }),
      rowKey('acc_1', { ...base, reference: 'INV-9' }),
    ]);
    expect(keys.size).toBe(6);
  });
});

describe('importRows', () => {
  it('imports a fresh batch', () => {
    const account = seedAccount('standard');
    const summary = importRows(account.id, ROWS);

    expect(summary).toEqual({
      received: 3,
      imported: 3,
      duplicates: 0,
      keys: ROWS.map((row) => rowKey(account.id, row)),
    });
    expect(listEntries(account.id)).toHaveLength(3);
  });

  it('skips the whole batch when it is uploaded again', () => {
    const account = seedAccount('standard');
    importRows(account.id, ROWS);
    const summary = importRows(account.id, ROWS_REORDERED);

    expect(summary).toEqual({ received: 3, imported: 0, duplicates: 3, keys: [] });
    expect(listEntries(account.id)).toHaveLength(3);
  });

  it('imports only what is new in a mixed batch', () => {
    const account = seedAccount('standard');
    importRows(account.id, ROWS);

    const fresh: ImportRow = {
      amountCents: '500',
      kind: 'credit',
      memo: 'late takings',
      reference: 'INV-4',
    };
    const summary = importRows(account.id, [ROWS[0] as ImportRow, fresh, ROWS[2] as ImportRow]);

    expect(summary).toMatchObject({ received: 3, imported: 1, duplicates: 2 });
    expect(summary.keys).toEqual([rowKey(account.id, fresh)]);
    expect(listEntries(account.id)).toHaveLength(4);
  });

  it('keeps one customer out of another', () => {
    const first = seedAccount('standard', 'First');
    const second = seedAccount('standard', 'Second');
    importRows(first.id, ROWS);
    const summary = importRows(second.id, ROWS);

    expect(summary).toMatchObject({ imported: 3, duplicates: 0 });
    expect(listEntries(second.id)).toHaveLength(3);
  });

  it('posts what the row said', () => {
    const account = seedAccount('standard');
    importRows(account.id, [{ amountCents: '250', kind: 'debit', memo: 'fees' }]);

    const entry = listEntries(account.id)[0];
    expect(entry?.amountCents).toBe(250);
    expect(entry?.kind).toBe('debit');
    expect(entry?.memo).toBe('fees');
  });

  it('refuses an unknown account', () => {
    expect(codeOf(() => importRows('acc_nope', ROWS))).toBe('account_not_found');
  });
});
