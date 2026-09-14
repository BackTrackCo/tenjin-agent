/** Shared domain types for the Ledgerline service. */

export type AccountId = string;

export type Plan = 'starter' | 'standard' | 'scale';

export type EntryKind = 'debit' | 'credit';

/**
 * The settings an account runs under. Every field has a plan default; an
 * account may carry an override for any subset of them.
 */
export interface AccountSettings {
  /** Hard cap on a single posted entry, in cents. */
  spendingLimitCents: number;
  /** Where statement mail goes; `null` means "do not send". */
  notifyEmail: string | null;
  /** Settle automatically at the end of the statement period. */
  autoSettle: boolean;
  /** Day of the month the statement closes, 1-28. */
  statementDay: number;
}

export type SettingsOverrides = Partial<AccountSettings>;

export interface Account {
  id: AccountId;
  name: string;
  plan: Plan;
  /** Only the fields this account overrides; everything else comes from the plan. */
  overrides: SettingsOverrides;
  /** Bumped on every accepted settings write. */
  version: number;
  createdAt: Date;
}

export interface Entry {
  id: string;
  accountId: AccountId;
  amountCents: number;
  kind: EntryKind;
  memo: string;
  /** Fee charged for posting this entry, from the pricing table. */
  feeCents: number;
  /** Set when the caller supplied one, or when the service derived one. */
  idempotencyKey: string | null;
  createdAt: Date;
}

export interface SettingsVersion {
  accountId: AccountId;
  version: number;
  overrides: SettingsOverrides;
  createdAt: Date;
}

export interface AuditEvent {
  action: string;
  accountId: AccountId | null;
  detail: Record<string, string | number | boolean | null>;
}

export interface AuditRecord extends AuditEvent {
  id: string;
  requestId: string;
  createdAt: Date;
}
