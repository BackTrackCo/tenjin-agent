import type { EntryKind, Plan, SettingsOverrides } from '../types.ts';

/**
 * Row shapes.
 *
 * A row is what the store holds: flat, no `Date` objects, timestamps in the
 * `*Stamp` storage form. `queries.ts` maps rows to domain objects.
 */

export interface AccountRow {
  id: string;
  name: string;
  plan: Plan;
  overrides: SettingsOverrides;
  version: number;
  createdAtStamp: number;
}

export interface EntryRow {
  id: string;
  accountId: string;
  amountCents: number;
  kind: EntryKind;
  memo: string;
  feeCents: number;
  idempotencyKey: string | null;
  settled: boolean;
  createdAtStamp: number;
}

export interface SettingsVersionRow {
  id: string;
  accountId: string;
  version: number;
  overrides: SettingsOverrides;
  createdAtStamp: number;
}

/**
 * A general-purpose key table. Anything that needs "have I seen this before"
 * without a column of its own lives here: import dedupe, webhook replay,
 * one-shot migrations.
 */
export interface SeenKeyRow {
  id: string;
  namespace: string;
  key: string;
  createdAtStamp: number;
}
