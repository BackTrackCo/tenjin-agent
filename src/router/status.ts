import { toMoney } from '../lib/money';
import { loadRawConfig, retiredPaymentKeys, RETIRED_PAYMENT_GUIDANCE } from '../lib/config';
import { spentOf } from '../lib/spend-ledger';
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
  // The same projection an authorization would make, so what this prints is
  // what the next lookup would actually be measured against.
  const ledger = await readSpendSummary(ctx.dataDir, { now });
  const committedAtomic = BigInt(ledger?.committedAtomic ?? '0');
  const reservedAtomic = (ledger?.reservations ?? []).reduce(
    (sum, r) => sum + BigInt(r.amountAtomic),
    0n,
  );
  const retired = retiredPaymentKeys(await loadRawConfig(ctx.dataDir));
  const warnings = retired.length
    ? [`Ignored retired keys: ${retired.join(', ')}. ${RETIRED_PAYMENT_GUIDANCE}`]
    : [];
  const automaticAtomic = ledger === null ? 0n : spentOf(ledger);
  const budgetAtomic = settings.policy.sessionBudgetAtomic;
  const data = {
    baseUrl: settings.baseUrl,
    warnings,
    window: {
      startedAtMs: ledger?.windowStartMs ?? null,
      committed: toMoney(committedAtomic.toString()),
      automaticExposure: toMoney(automaticAtomic.toString()),
      reserved: toMoney(reservedAtomic.toString()),
      budget: budgetAtomic === null ? null : toMoney(budgetAtomic.toString()),
    },
    caps: {
      maxAutoSpend: toMoney(settings.policy.maxAutoSpendAtomic.toString()),
    },
    inFlight: (ledger?.reservations ?? []).map((r) => ({
      amount: toMoney(r.amountAtomic),
      ageSeconds: Math.max(0, Math.round((now() - r.atMs) / 1000)),
      ...(r.requestKey !== undefined ? { request: r.requestKey } : {}),
    })),
  };
  const budgetLine =
    budgetAtomic === null
      ? 'no daily limit'
      : `of ${toMoney(budgetAtomic.toString()).usd} USD in the rolling 24h window`;
  return {
    data,
    humanLines: [
      `spent ${toMoney(committedAtomic.toString()).usd} USD total; automatic exposure ${toMoney(automaticAtomic.toString()).usd} USD ${budgetLine}`,
      `reserved ${toMoney(reservedAtomic.toString()).usd} USD in ${data.inFlight.length} open request(s)`,
      `automatic router up to ${toMoney(settings.policy.maxAutoSpendAtomic.toString()).usd} USD per call; manual pay always requires consent`,
      ...warnings,
    ],
  };
}
