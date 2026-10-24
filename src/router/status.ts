import { formatUsdDisplay, toMoney } from '../lib/money';
import { loadRawConfig, retiredPaymentKeys, RETIRED_PAYMENT_GUIDANCE } from '../lib/config';
import { spentOf } from '../lib/spend-ledger';
import { resolveContextSettings } from '../lib/settings';
import { readUsdcBalanceWithFallback } from '../lib/usdc-balance';
import { describeWallet, resolveWalletProvider } from '../lib/wallet';
import { readSpendSummary } from '../lib/wallet/spend';
import type { CommandContext, CommandResult } from '../context';
import { channelCredit } from './channel-credit';
import { FUND_COMMAND_LINE, ROUTING_DEPOSIT_KEY, ROUTING_FEE_ATOMIC } from './fee';

/**
 * `tenjin status`: what this machine has spent and what it is still holding.
 *
 * IT READS `spend.json`, NOT THE BACKEND. The rolling window, the committed
 * total and the reservations still open are the local truth about money, and
 * the reservations are also the record of a request whose outcome is unknown:
 * an authorization that was transmitted is committed, so anything still open
 * here is either in flight or a crash that has not yet aged out.
 *
 * A ROUTING DEPOSIT IS NOT A LOOKUP. It is prepaid credit the routing fee
 * draws from, so it is shown apart from what lookups cost, with what the
 * channel still holds. It still counts toward the daily limit, like any
 * automatic payment.
 *
 * THE WALLET'S BALANCE LEADS, read from the chain with the same fallback a
 * lookup uses, because a wallet at $0 is why nothing pays. A read that does
 * not answer says so rather than failing the readout, and no wallet means no
 * read at all.
 */

export interface StatusDeps {
  now?: () => number;
  /** Seam for the wallet's routing credit; production reads its channel files. */
  routingCredit?: (ctx: CommandContext) => Promise<bigint>;
  /** Seam for the wallet and its USDC balance (null when the read failed);
   *  null with no wallet. Production reads the chain. */
  wallet?: (
    ctx: CommandContext,
    rpcUrl: string,
  ) => Promise<{ address: string; atomic: bigint | null } | null>;
}

/** The wallet's address and USDC balance, or null with no wallet. Never
 *  throws: a balance the RPC did not give is null. */
async function walletOnChain(
  ctx: CommandContext,
  rpcUrl: string,
): Promise<{ address: string; atomic: bigint | null } | null> {
  let address: string;
  try {
    ({ address } = await describeWallet(resolveWalletProvider(ctx)));
  } catch {
    return null;
  }
  const atomic = await readUsdcBalanceWithFallback(address, rpcUrl, {
    timeoutMs: Math.max(1, Math.floor(ctx.flags.timeout / 2)),
  }).catch(() => null);
  return { address, atomic };
}

/** What the wallet's routing channel still holds; 0n with no wallet, or one
 *  this cannot read without a prompt. */
async function walletRoutingCredit(ctx: CommandContext): Promise<bigint> {
  try {
    const { address } = await describeWallet(resolveWalletProvider(ctx));
    return await channelCredit(ctx.dataDir, address);
  } catch {
    return 0n;
  }
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
  const depositedAtomic = (ledger?.exposures ?? [])
    .filter((e) => e.nonce.startsWith(ROUTING_DEPOSIT_KEY))
    .reduce((sum, e) => sum + BigInt(e.amountAtomic), 0n);
  // Never below zero, whatever an older ledger holds.
  const lookupsAtomic = committedAtomic > depositedAtomic ? committedAtomic - depositedAtomic : 0n;
  const [creditAtomic, wallet] = await Promise.all([
    (deps.routingCredit ?? walletRoutingCredit)(ctx),
    (deps.wallet ?? walletOnChain)(ctx, settings.rpcUrl).catch(() => null),
  ]);
  const budgetAtomic = settings.policy.sessionBudgetAtomic;
  const data = {
    baseUrl: settings.baseUrl,
    warnings,
    wallet:
      wallet === null
        ? null
        : {
            address: wallet.address,
            balance: wallet.atomic === null ? null : toMoney(wallet.atomic.toString()),
          },
    window: {
      startedAtMs: ledger?.windowStartMs ?? null,
      committed: toMoney(committedAtomic.toString()),
      lookups: toMoney(lookupsAtomic.toString()),
      routingDeposits: toMoney(depositedAtomic.toString()),
      automaticExposure: toMoney(automaticAtomic.toString()),
      reserved: toMoney(reservedAtomic.toString()),
      budget: budgetAtomic === null ? null : toMoney(budgetAtomic.toString()),
    },
    routingCredit: {
      remaining: toMoney(creditAtomic.toString()),
      calls: Number(creditAtomic / ROUTING_FEE_ATOMIC),
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
  // THE LIMITS CAP THE TENJIN BALANCE, and say so: a bill an account of the
  // user's own sends (#37) is not counted against them.
  const automatic = `$${formatUsdDisplay(automaticAtomic.toString())}`;
  const budgetLine =
    budgetAtomic === null
      ? `Today ${automatic} spent automatically (Tenjin balance); no daily limit`
      : `Today ${automatic} of your $${formatUsdDisplay(budgetAtomic.toString())} daily limit (Tenjin balance, over the last 24 hours)`;
  const credit = [
    ...(depositedAtomic > 0n ? [`${toMoney(depositedAtomic.toString()).usd} USD prepaid`] : []),
    ...(depositedAtomic > 0n || creditAtomic > 0n
      ? [`${data.routingCredit.remaining.usd} USD left (~${data.routingCredit.calls} calls)`]
      : []),
  ];
  const walletLines =
    wallet === null
      ? []
      : wallet.atomic === null
        ? ['wallet balance unknown: the RPC did not answer; `tenjin wallet balance` retries']
        : [
            `wallet ${toMoney(wallet.atomic.toString()).usd} USD`,
            ...(wallet.atomic === 0n ? [FUND_COMMAND_LINE] : []),
          ];
  return {
    data,
    humanLines: [
      ...walletLines,
      `lookups ${toMoney(lookupsAtomic.toString()).usd} USD` +
        (credit.length > 0 ? ` · routing credit ${credit.join(', ')}` : ''),
      budgetLine,
      `reserved ${toMoney(reservedAtomic.toString()).usd} USD in ${data.inFlight.length} open request(s)`,
      `automatic router up to $${formatUsdDisplay(settings.policy.maxAutoSpendAtomic.toString())} a call (Tenjin balance); manual pay always requires consent`,
      ...warnings,
    ],
  };
}
