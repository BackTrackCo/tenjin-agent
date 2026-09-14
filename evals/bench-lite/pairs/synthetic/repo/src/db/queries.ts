import { digest } from '../hash.ts';
import { mergeDefaults } from '../merge.ts';
import { fromStamp, nowStamp } from '../time.ts';
import type { Account, Entry, SettingsOverrides, SettingsVersion } from '../types.ts';
import type { AccountRow, EntryRow, SeenKeyRow, SettingsVersionRow } from './schema.ts';
import { Table } from './store.ts';

/** The tables this process holds. */
export const db = {
  accounts: new Table<AccountRow>(),
  entries: new Table<EntryRow>(),
  settingsVersions: new Table<SettingsVersionRow>(),
  seenKeys: new Table<SeenKeyRow>(),
};

let accountSeq = 0;
let entrySeq = 0;
let versionSeq = 0;
let seenSeq = 0;

/** Drop every table. Tests call this between cases. */
export function resetDb(): void {
  db.accounts.clear();
  db.entries.clear();
  db.settingsVersions.clear();
  db.seenKeys.clear();
  accountSeq = 0;
  entrySeq = 0;
  versionSeq = 0;
  seenSeq = 0;
}

function nextAccountId(name: string): string {
  accountSeq += 1;
  return `acc_${digest([name, String(accountSeq)]).slice(0, 10)}`;
}

function nextEntryId(accountId: string, memo: string): string {
  entrySeq += 1;
  return `ent_${digest([accountId, memo, String(entrySeq)]).slice(0, 12)}`;
}

export function rowToAccount(row: AccountRow): Account {
  return {
    id: row.id,
    name: row.name,
    plan: row.plan,
    overrides: { ...row.overrides },
    version: row.version,
    createdAt: fromStamp(row.createdAtStamp),
  };
}

export function rowToEntry(row: EntryRow): Entry {
  return {
    id: row.id,
    accountId: row.accountId,
    amountCents: row.amountCents,
    kind: row.kind,
    memo: row.memo,
    feeCents: row.feeCents,
    idempotencyKey: row.idempotencyKey,
    createdAt: fromStamp(row.createdAtStamp),
  };
}

export function rowToSettingsVersion(row: SettingsVersionRow): SettingsVersion {
  return {
    accountId: row.accountId,
    version: row.version,
    overrides: { ...row.overrides },
    createdAt: fromStamp(row.createdAtStamp),
  };
}

export function insertAccountRow(input: {
  name: string;
  plan: AccountRow['plan'];
  overrides: SettingsOverrides;
}): AccountRow {
  const row: AccountRow = {
    id: nextAccountId(input.name),
    name: input.name,
    plan: input.plan,
    overrides: { ...input.overrides },
    version: 1,
    createdAtStamp: nowStamp(),
  };
  db.accounts.insert(row);
  writeSettingsVersion(row);
  return row;
}

export function getAccountRow(accountId: string): AccountRow | undefined {
  return db.accounts.get(accountId);
}

export function listAccountRows(): AccountRow[] {
  return db.accounts.all();
}

function writeSettingsVersion(row: AccountRow): SettingsVersionRow {
  versionSeq += 1;
  const version: SettingsVersionRow = {
    id: `sv_${digest([row.id, String(row.version), String(versionSeq)]).slice(0, 10)}`,
    accountId: row.id,
    version: row.version,
    overrides: { ...row.overrides },
    createdAtStamp: nowStamp(),
  };
  db.settingsVersions.insert(version);
  return version;
}

/**
 * Layer `patch` onto the account's overrides, bump the version, and keep a
 * copy of the result in `settingsVersions`.
 *
 * This is the only write path for settings: nothing else may touch
 * `accounts.overrides`, because the version row has to be written with it.
 */
export function updateAccountOverrides(accountId: string, patch: SettingsOverrides): AccountRow {
  const current = db.accounts.get(accountId);
  if (!current) {
    throw new Error(`no such account: ${accountId}`);
  }
  const overrides = mergeDefaults(current.overrides, patch);
  const next = db.accounts.update(accountId, {
    overrides,
    version: current.version + 1,
  });
  writeSettingsVersion(next);
  return next;
}

export function listSettingsVersionRows(accountId: string): SettingsVersionRow[] {
  return db.settingsVersions
    .filter((row) => row.accountId === accountId)
    .sort((a, b) => a.version - b.version);
}

export function insertEntryRow(input: {
  accountId: string;
  amountCents: number;
  kind: EntryRow['kind'];
  memo: string;
  feeCents: number;
  idempotencyKey: string | null;
}): EntryRow {
  const row: EntryRow = {
    id: nextEntryId(input.accountId, input.memo),
    accountId: input.accountId,
    amountCents: input.amountCents,
    kind: input.kind,
    memo: input.memo,
    feeCents: input.feeCents,
    idempotencyKey: input.idempotencyKey,
    settled: false,
    createdAtStamp: nowStamp(),
  };
  db.entries.insert(row);
  return row;
}

/** Every entry for one account, oldest first. */
export function listEntryRows(accountId: string): EntryRow[] {
  return db.entries
    .filter((row) => row.accountId === accountId)
    .sort((a, b) => a.createdAtStamp - b.createdAtStamp || a.id.localeCompare(b.id));
}

export function findEntryByIdempotencyKey(accountId: string, key: string): EntryRow | undefined {
  return db.entries.find((row) => row.accountId === accountId && row.idempotencyKey === key);
}

export function markEntrySettled(entryId: string): void {
  db.entries.update(entryId, { settled: true });
}

/** True if this key was already recorded in this namespace. */
export function hasSeenKey(namespace: string, key: string): boolean {
  return db.seenKeys.find((row) => row.namespace === namespace && row.key === key) !== undefined;
}

/** Record a key in a namespace. Returns false if it was already there. */
export function markKeySeen(namespace: string, key: string): boolean {
  if (hasSeenKey(namespace, key)) {
    return false;
  }
  seenSeq += 1;
  db.seenKeys.insert({
    id: `key_${digest([namespace, key, String(seenSeq)]).slice(0, 10)}`,
    namespace,
    key,
    createdAtStamp: nowStamp(),
  });
  return true;
}
