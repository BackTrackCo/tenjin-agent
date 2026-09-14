import { recordAudit } from './audit.ts';
import {
  getAccountRow,
  insertAccountRow,
  listAccountRows,
  listSettingsVersionRows,
  rowToAccount,
  rowToSettingsVersion,
  updateAccountOverrides,
} from './db/queries.ts';
import { badRequest, notFound } from './errors.ts';
import { mergeAll } from './merge.ts';
import type {
  Account,
  AccountSettings,
  Plan,
  SettingsOverrides,
  SettingsVersion,
} from './types.ts';

/** What an account gets if it overrides nothing. */
export const PLAN_DEFAULTS: Record<Plan, AccountSettings> = {
  starter: {
    spendingLimitCents: 50_000,
    notifyEmail: null,
    autoSettle: false,
    statementDay: 1,
  },
  standard: {
    spendingLimitCents: 250_000,
    notifyEmail: null,
    autoSettle: true,
    statementDay: 1,
  },
  scale: {
    spendingLimitCents: 5_000_000,
    notifyEmail: null,
    autoSettle: true,
    statementDay: 15,
  },
};

/**
 * Org-wide settings, layered over the plan defaults and under the account's
 * own overrides. Ops owns this; it is not per-account.
 */
export const ORG_OVERRIDES: SettingsOverrides = {
  statementDay: 5,
};

const PLANS: readonly Plan[] = ['starter', 'standard', 'scale'];

export function isPlan(value: string): value is Plan {
  return (PLANS as readonly string[]).includes(value);
}

export function createAccount(input: {
  name: string;
  plan: Plan;
  overrides?: SettingsOverrides;
}): Account {
  const name = input.name.trim();
  if (name.length === 0) {
    throw badRequest('invalid_name', 'name must not be empty');
  }
  if (!isPlan(input.plan)) {
    throw badRequest('invalid_plan', `unknown plan: ${input.plan}`);
  }
  const overrides = validateOverrides(input.overrides ?? {});
  const row = insertAccountRow({ name, plan: input.plan, overrides });
  recordAudit({
    action: 'account.created',
    accountId: row.id,
    detail: { plan: row.plan, name: row.name },
  });
  return rowToAccount(row);
}

export function getAccount(accountId: string): Account {
  const row = getAccountRow(accountId);
  if (!row) {
    throw notFound('account_not_found', `no such account: ${accountId}`);
  }
  return rowToAccount(row);
}

export function listAccounts(): Account[] {
  return listAccountRows().map(rowToAccount);
}

/** The settings this account actually runs under. */
export function resolveSettings(accountId: string): AccountSettings {
  const row = getAccountRow(accountId);
  if (!row) {
    throw notFound('account_not_found', `no such account: ${accountId}`);
  }
  return mergeAll(PLAN_DEFAULTS[row.plan], ORG_OVERRIDES, row.overrides);
}

/** Set one or more overrides on an account and return the resolved settings. */
export function updateSettings(accountId: string, patch: SettingsOverrides): AccountSettings {
  const row = getAccountRow(accountId);
  if (!row) {
    throw notFound('account_not_found', `no such account: ${accountId}`);
  }
  const clean = validateOverrides(patch);
  const next = updateAccountOverrides(accountId, clean);
  recordAudit({
    action: 'settings.updated',
    accountId,
    detail: { version: next.version, fields: Object.keys(clean).sort().join(',') },
  });
  return resolveSettings(accountId);
}

/** Every settings version ever written for this account, oldest first. */
export function listSettingsVersions(accountId: string): SettingsVersion[] {
  return listSettingsVersionRows(accountId).map(rowToSettingsVersion);
}

/** One settings version, by its number. */
export function getSettingsVersion(accountId: string, version: number): SettingsVersion {
  const found = listSettingsVersions(accountId).find((entry) => entry.version === version);
  if (!found) {
    throw notFound('version_not_found', `account ${accountId} has no version ${version}`);
  }
  return found;
}

/** Reject a settings payload the service would not be able to honour. */
export function validateOverrides(patch: SettingsOverrides): SettingsOverrides {
  const out: SettingsOverrides = { ...patch };
  if ('spendingLimitCents' in out && out.spendingLimitCents !== undefined) {
    const limit = out.spendingLimitCents;
    if (!Number.isInteger(limit) || limit < 0) {
      throw badRequest('invalid_limit', 'spendingLimitCents must be a non-negative integer');
    }
  }
  if ('statementDay' in out && out.statementDay !== undefined) {
    const day = out.statementDay;
    if (!Number.isInteger(day) || day < 1 || day > 28) {
      throw badRequest('invalid_statement_day', 'statementDay must be an integer from 1 to 28');
    }
  }
  if ('notifyEmail' in out && out.notifyEmail !== undefined && out.notifyEmail !== null) {
    if (!out.notifyEmail.includes('@')) {
      throw badRequest('invalid_email', 'notifyEmail must be an address or null');
    }
  }
  return out;
}
