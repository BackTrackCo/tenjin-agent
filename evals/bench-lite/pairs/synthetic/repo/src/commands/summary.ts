import { getAccount, resolveSettings } from '../accounts.ts';
import { balanceFor, listEntries } from '../ledger.ts';

export interface AccountSummary {
  accountId: string;
  name: string;
  plan: string;
  balanceCents: number;
  feesCents: number;
  entryCount: number;
  spendingLimitCents: number;
  lastEntryAt: string | null;
}

/** One account, the way the ops CLI prints it. */
export function accountSummary(accountId: string): AccountSummary {
  const account = getAccount(accountId);
  const balance = balanceFor(accountId);
  const settings = resolveSettings(accountId);
  const entries = listEntries(accountId);
  const last = entries.at(-1);

  return {
    accountId: account.id,
    name: account.name,
    plan: account.plan,
    balanceCents: balance.balanceCents,
    feesCents: balance.feesCents,
    entryCount: balance.entryCount,
    spendingLimitCents: settings.spendingLimitCents,
    lastEntryAt: last ? last.createdAt.toISOString() : null,
  };
}

/** The summary as the lines the CLI prints. */
export function formatSummary(summary: AccountSummary): string[] {
  return [
    `${summary.accountId}  ${summary.name}  (${summary.plan})`,
    `  balance   ${summary.balanceCents}`,
    `  fees      ${summary.feesCents}`,
    `  entries   ${summary.entryCount}`,
    `  limit     ${summary.spendingLimitCents}`,
    `  last      ${summary.lastEntryAt ?? '-'}`,
  ];
}
