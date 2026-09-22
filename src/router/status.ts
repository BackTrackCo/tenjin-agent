import { toMoney } from '../lib/money';
import type { ConfirmPolicy } from '../lib/policy';
import { resolveContextSettings } from '../lib/settings';
import { readSpendSummary } from '../lib/wallet/spend';
import type { CommandContext, CommandResult } from '../context';

/**
 * `tenjin status`: what this machine has spent and what it is still holding.
 *
 * IT READS `spend.json`, NOT THE BACKEND. The rolling window, the committed
 * total and the reservations still open are the local truth about money, and
 * the reservations are also the record of a request whose outcome is unknown:
 * an authorization that was transmitted is committed, so anything still open
 * here is either in flight or a crash that has not yet aged out.
 */

export interface StatusDeps {
  now?: () => number;
}

export async function runRouterStatus(
  ctx: CommandContext,
  deps: StatusDeps = {},
): Promise<CommandResult> {
  const now = deps.now ?? Date.now;
  const settings = await resolveContextSettings(ctx);
  const ledger = await readSpendSummary(ctx.dataDir);
  const committedAtomic = BigInt(ledger?.committedAtomic ?? '0');
  const reservedAtomic = (ledger?.reservations ?? []).reduce(
    (sum, r) => sum + BigInt(r.amountAtomic),
    0n,
  );
  const budgetAtomic = BigInt(settings.policy.sessionBudgetAtomic);
  const data = {
    baseUrl: settings.baseUrl,
    window: {
      startedAtMs: ledger?.windowStartMs ?? null,
      committed: toMoney(committedAtomic.toString()),
      reserved: toMoney(reservedAtomic.toString()),
      budget: budgetAtomic === 0n ? null : toMoney(budgetAtomic.toString()),
    },
    caps: {
      maxAutoSpend: toMoney(settings.policy.maxAutoSpendAtomic.toString()),
      confirm: confirmLabel(settings.policy.confirm),
    },
    inFlight: (ledger?.reservations ?? []).map((r) => ({
      amount: toMoney(r.amountAtomic),
      ageSeconds: Math.max(0, Math.round((now() - r.atMs) / 1000)),
      ...(r.requestKey !== undefined ? { request: r.requestKey } : {}),
    })),
  };
  const budgetLine =
    budgetAtomic === 0n
      ? 'no session budget set'
      : `of ${toMoney(budgetAtomic.toString()).usd} USD in the rolling 24h window`;
  return {
    data,
    humanLines: [
      `spent ${toMoney(committedAtomic.toString()).usd} USD ${budgetLine}`,
      `reserved ${toMoney(reservedAtomic.toString()).usd} USD in ${data.inFlight.length} open request(s)`,
      `per call at most ${toMoney(settings.policy.maxAutoSpendAtomic.toString()).usd} USD, confirm ${confirmLabel(settings.policy.confirm)}`,
    ],
  };
}

function confirmLabel(confirm: ConfirmPolicy): string {
  return confirm.mode === 'always'
    ? 'always'
    : `above ${toMoney(confirm.thresholdAtomic.toString()).usd} USD`;
}
