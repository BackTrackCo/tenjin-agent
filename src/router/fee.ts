import { join } from 'node:path';
import { formatUsdDisplay } from '../lib/money';
import { evaluateSpendPolicy, type PolicyReason, type SpendPolicy } from '../lib/policy';
import { NO_PAYER, type DecisionRoute } from './decision';
import { agentFixFor, WALLET_REASONS } from './wallet-reasons';
import { LOWERCASE_ADDRESS_RE } from '../lib/ids';

/**
 * The routing fee's rules, without anything that pays it. The stock SDK client
 * in `tenjin mcp` pays the fee each 402 quotes over x402 `batch-settlement`
 * (`routing-payer.ts`); a call without that payer is skipped.
 *
 * The server quotes and this client caps: no fee amount lives here, only the
 * ceiling a quote must not pass (like EIP-1559's `maxFeePerGas`) and the
 * spend limits beside it.
 *
 * Hook-safe: `tenjin hook` loads this module, so its chunk graph stays free of
 * the wallet and the x402 SDK (`dist-chunks.test.ts`).
 */

/**
 * The routing fee ceiling, atomic USDC ($0.003): the most one routing call
 * pays. A quote above it is not paid at all ({@link FEE_ABOVE_CEILING}), so a
 * lower price needs no release and a higher one does. A count with no quote to
 * go on uses it, so it never overstates.
 */
export const ROUTING_FEE_CEILING_ATOMIC = 3_000n;
/** The skip reason for a quote above {@link ROUTING_FEE_CEILING_ATOMIC}. */
export const FEE_ABOVE_CEILING = 'fee_above_ceiling';
/** The deposit hint ($0.05) when a 402 carries no `extra.minDeposit`, and the
 *  one doctor sizes from with no 402. Production announces $0.03, the SDK's
 *  ten-quote default, until the router's update makes it $0.05. */
export const CHANNEL_DEPOSIT_ATOMIC = 50_000n;
/** The SDK's deposit ceiling, atomic USDC ($0.25): its per-payment cap times
 *  `depositMultiplier` (`routing-payer.ts`). */
export const MAX_CHANNEL_DEPOSIT_ATOMIC = 250_000n;
/** The fewest quoted fees a deposit covers, so a deposit's on-chain settle is
 *  not spent on one or two calls. */
export const DEPOSIT_FLOOR_FEES = 10n;

/**
 * The deposit Tenjin signs: the smallest of the server's hint (the 402's
 * `extra.minDeposit`), the wallet and the per-call limit, so the rest of the
 * wallet stays for paid tools, which pay from the wallet, not the channel.
 * Never below {@link DEPOSIT_FLOOR_FEES} quoted fees or what the next voucher
 * needs, never above the SDK's ceiling. An unread balance bounds nothing. The
 * caller refuses a wallet below the result (`wallet_low`), and the spend
 * authorizer a limit below it.
 */
export function routingDepositAtomic(o: {
  hintAtomic: bigint;
  quoteAtomic: bigint;
  walletAtomic: bigint | null;
  perCallAtomic: bigint;
  maxAtomic: bigint;
  neededAtomic?: bigint;
}): bigint {
  const least = (a: bigint, b: bigint) => (b < a ? b : a);
  let amount = least(o.hintAtomic, o.perCallAtomic);
  if (o.walletAtomic !== null) amount = least(amount, o.walletAtomic);
  const floor = DEPOSIT_FLOOR_FEES * o.quoteAtomic;
  const needed = o.neededAtomic ?? 0n;
  if (amount < floor) amount = floor;
  if (amount < needed) amount = needed;
  return least(amount, o.maxAtomic);
}

/**
 * The top-up every "fund the wallet" hint names, in USD: the checkout's Apple
 * Pay and Google Pay minimum, which covers the routing deposit and a few
 * hundred lookups. `tenjin wallet fund` sends it to the checkout as a preset.
 */
export const SUGGESTED_FUND_USD = '5';
/** The funding line a new wallet is told, after `tenjin wallet create`. */
export const FUNDING_LINE = `Fund it with \`tenjin wallet fund ${SUGGESTED_FUND_USD}\`, or send USDC on Base.`;
/** The funding line under a wallet at exactly $0, in `tenjin wallet balance` and `tenjin status`: the command alone. */
export const FUND_COMMAND_LINE = `Fund it with \`tenjin wallet fund ${SUGGESTED_FUND_USD}\`.`;
/** The spend ledger key a deposit's exposure is recorded under, before its id. */
export const ROUTING_DEPOSIT_KEY = 'routing-deposit:';

/** A spend refusal, as the reason the call was not paid. */
const REFUSED: Partial<Record<PolicyReason, string>> = {
  not_allowlisted: 'not_allowlisted',
  session_budget_exceeded: 'budget_reached',
  above_auto_spend: 'limit_below_deposit',
};

/** The reason a spend refusal leaves a routing call unpaid. */
export function refusedWhy(reason: PolicyReason): string {
  return REFUSED[reason] ?? reason;
}

/**
 * The deposit is the spend: it meets the whole policy once, when the SDK's
 * `depositStrategy` reserves it. Each fee from it gets only the per-payment
 * checks (the per-call limit, the allowlist, an explicit zero daily limit),
 * never the day's running total, which the deposit already consumed. Null when
 * the fee is allowed.
 */
export function feeRefusal(policy: SpendPolicy, host: string, feeAtomic: bigint): string | null {
  const evaluation = evaluateSpendPolicy(
    { ...policy, sessionBudgetAtomic: policy.sessionBudgetAtomic === 0n ? 0n : null },
    { mode: 'automatic', amountAtomic: feeAtomic, creator: host, sessionSpentAtomic: 0n },
  );
  return evaluation.decision === 'allow' ? null : refusedWhy(evaluation.reason);
}

/** The payer's route for a call to the router at `baseUrl`. `tenjin mcp`
 *  passes its payer's; absent, a call goes unpaid. */
export type RouteFor = (baseUrl: string) => DecisionRoute;

/**
 * Why a call was not paid, for the user: the reason and the fix, keyed by the
 * payer's skip reason (or `no_payer`). {@link NO_FAULT} reasons need no word:
 * a busy channel, a queued call, a payment or unlock still finishing in the
 * background.
 *
 * The wallet's reasons come from `WALLET_REASONS` so a notice uses doctor's
 * words. They carry the person's `fix`, never `agentFix`: this sentence goes in
 * the hook's `systemMessage`, which the harness shows the person.
 */
const WALLET_UNPAID: Record<string, { reason: string; fix: string }> = Object.fromEntries(
  Object.entries(WALLET_REASONS).map(([key, { reason, fix }]) => [key, { reason, fix }]),
);
const UNPAID: Record<string, { reason: string; fix: string }> = {
  wallet_low: {
    reason: `the wallet holds less than the $${usd(DEPOSIT_FLOOR_FEES * ROUTING_FEE_CEILING_ATOMIC)} Tenjin needs to set aside for routing`,
    fix: `Fund it with \`tenjin wallet fund ${SUGGESTED_FUND_USD}\`.`,
  },
  ...WALLET_UNPAID,
  limit_below_deposit: {
    reason: 'the per-call spend limit cannot cover the routing fee or its deposit',
    fix: 'Run `tenjin doctor`.',
  },
  budget_reached: {
    reason: 'the daily budget has no room left for the routing fee or its deposit',
    fix: 'Run `tenjin doctor`.',
  },
  not_allowlisted: {
    reason: 'allowlistCreators does not include the router',
    fix: 'Run `tenjin doctor`.',
  },
  payment_failed: {
    reason: 'the routing payment failed',
    fix: 'Run `tenjin doctor`.',
  },
  [FEE_ABOVE_CEILING]: {
    reason: 'the router asks more per call than this install agreed to pay',
    fix: 'Your usual tools still work.',
  },
  [NO_PAYER]: {
    reason: 'the router charges it, and this session cannot pay it',
    fix: 'Run `tenjin doctor`.',
  },
};
const NO_FAULT = new Set([
  'channel_busy',
  'busy',
  'no_call',
  'deadline_after_payment_sent',
  'unlock_timeout',
]);

/** The reason and fix for an unpaid call, or null when it needs no word. */
export function unpaid(why: string): { reason: string; fix: string } | null {
  if (NO_FAULT.has(why)) return null;
  return UNPAID[why] ?? UNPAID['payment_failed']!;
}

/**
 * The line said when a routing deposit went through: funds set aside for the
 * next routing fees, not a lookup it bought. It names the ceiling, the one
 * bound every later call keeps.
 */
export function depositSentence(amountAtomic: bigint): string {
  return `Tenjin set aside $${usd(amountAtomic)} for routing. Each routing call costs at most $${usd(ROUTING_FEE_CEILING_ATOMIC)}. Unused funds remain yours.`;
}

/**
 * The line the user sees, once per session and reason, when a call was not
 * paid. The reader picks the fix: the person's by default; for the model (the
 * `request` tool's text) a wallet reason's `agentFix`, which asks the person to
 * act and never for the passphrase. A quote above the ceiling names its price.
 */
export function unpaidSentence(
  why: string,
  reader: 'person' | 'agent' = 'person',
  quotedAtomic?: bigint,
): string | null {
  const u = unpaid(why);
  if (u === null) return null;
  // An automatic fallback explains the missing funds without reopening checkout.
  // Explicit balance/payment/doctor results retain `unpaid().fix`.
  const fix =
    why === 'wallet_low'
      ? 'Your usual tools still work.'
      : reader === 'agent'
        ? agentFixFor(why, u.fix)
        : u.fix;
  const reason =
    why === FEE_ABOVE_CEILING && quotedAtomic !== undefined
      ? `the router quoted $${usd(quotedAtomic)} a call, more than this install agreed to pay`
      : u.reason;
  return `Tenjin could not pay the routing fee (${reason}), so Tenjin is not routing calls until that is fixed. ${fix}`;
}

/** One wallet's folder: the SDK's file storage for its routing channel
 *  (`client/<channelId>.json`). */
export function payerDir(dataDir: string, payer: string): string {
  const name = payer.toLowerCase();
  if (!LOWERCASE_ADDRESS_RE.test(name)) throw new Error(`not a wallet address: ${payer}`);
  return join(dataDir, 'router', 'fee', name);
}

/** Atomic USDC as dollars with at least two decimals, never a float. */
export function usd(atomic: bigint): string {
  return formatUsdDisplay(atomic.toString());
}
