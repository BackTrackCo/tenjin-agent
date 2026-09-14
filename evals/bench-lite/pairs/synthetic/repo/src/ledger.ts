import { getAccount, resolveSettings } from './accounts.ts';
import { recordAudit } from './audit.ts';
import { config } from './config.ts';
import {
  findEntryByIdempotencyKey,
  insertEntryRow,
  listEntryRows,
  markEntrySettled,
  rowToEntry,
} from './db/queries.ts';
import { badRequest } from './errors.ts';
import { priceFor } from './pricing/index.ts';
import type { Entry, EntryKind } from './types.ts';

export interface PostEntryInput {
  accountId: string;
  amountCents: number;
  kind: EntryKind;
  memo?: string;
  idempotencyKey?: string | null;
}

export interface Balance {
  accountId: string;
  currency: string;
  balanceCents: number;
  feesCents: number;
  entryCount: number;
}

const KINDS: readonly EntryKind[] = ['debit', 'credit'];

function normaliseAmount(amountCents: number): number {
  if (typeof amountCents !== 'number' || !Number.isFinite(amountCents)) {
    throw badRequest('invalid_amount', 'amountCents must be a number');
  }
  if (!Number.isInteger(amountCents)) {
    if (config.strictAmounts) {
      throw badRequest('fractional_amount', 'amountCents must be a whole number of cents');
    }
    return Math.round(amountCents);
  }
  return amountCents;
}

/** Post one entry and return it. */
export function postEntry(input: PostEntryInput): Entry {
  const account = getAccount(input.accountId);
  if (!KINDS.includes(input.kind)) {
    throw badRequest('invalid_kind', `kind must be one of ${KINDS.join(', ')}`);
  }
  const amountCents = normaliseAmount(input.amountCents);
  if (amountCents <= 0) {
    throw badRequest('invalid_amount', 'amountCents must be greater than zero');
  }

  const settings = resolveSettings(account.id);
  if (amountCents > settings.spendingLimitCents) {
    throw badRequest('limit_exceeded', 'amountCents is over the account spending limit', {
      limitCents: settings.spendingLimitCents,
    });
  }

  const idempotencyKey = input.idempotencyKey ?? null;
  if (idempotencyKey !== null) {
    const existing = findEntryByIdempotencyKey(account.id, idempotencyKey);
    if (existing) {
      return rowToEntry(existing);
    }
  }

  const memo = (input.memo ?? '').slice(0, 140);
  const feeCents = priceFor(account.plan, input.kind, amountCents);
  const row = insertEntryRow({
    accountId: account.id,
    amountCents,
    kind: input.kind,
    memo,
    feeCents,
    idempotencyKey,
  });

  recordAudit({
    action: 'entry.posted',
    accountId: account.id,
    detail: { entryId: row.id, amountCents, kind: input.kind, feeCents },
  });

  return rowToEntry(row);
}

/** Post several entries at once. Rejects a batch larger than the configured cap. */
export function postEntries(inputs: PostEntryInput[]): Entry[] {
  if (inputs.length === 0) {
    throw badRequest('empty_batch', 'a batch must hold at least one entry');
  }
  if (inputs.length > config.maxBatchSize) {
    throw badRequest('batch_too_large', `a batch may hold at most ${config.maxBatchSize} entries`, {
      maxBatchSize: config.maxBatchSize,
    });
  }
  return inputs.map((input) => postEntry(input));
}

/** Every entry on an account, oldest first. */
export function listEntries(accountId: string): Entry[] {
  getAccount(accountId);
  return listEntryRows(accountId).map(rowToEntry);
}

/** What the account owes, net of fees. */
export function balanceFor(accountId: string): Balance {
  getAccount(accountId);
  const rows = listEntryRows(accountId);
  let balanceCents = 0;
  let feesCents = 0;
  for (const row of rows) {
    balanceCents += row.kind === 'credit' ? row.amountCents : -row.amountCents;
    feesCents += row.feeCents;
  }
  return {
    accountId,
    currency: config.currency,
    balanceCents: balanceCents - feesCents,
    feesCents,
    entryCount: rows.length,
  };
}

/** Mark an entry settled. Idempotent. */
export function settleEntry(entryId: string): void {
  markEntrySettled(entryId);
  recordAudit({ action: 'entry.settled', accountId: null, detail: { entryId } });
}
