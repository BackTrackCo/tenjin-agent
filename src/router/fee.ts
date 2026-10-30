import { join } from 'node:path';
import { formatUsdDisplay } from '../lib/money';
import { evaluateSpendPolicy, type PolicyReason, type SpendPolicy } from '../lib/policy';
import {
  DEPOSIT_DEFERRED,
  NO_PAYER,
  TOPPING_UP,
  type DecisionRoute,
  type SkipFacts,
} from './decision';
import { agentFixFor, WALLET_REASONS } from './wallet-reasons';

/**
 * THE ROUTING FEE, WITHOUT ANYTHING THAT PAYS. Every routing call goes to the
 * paid route and pays the fee its 402 quotes over x402 `batch-settlement`, and
 * the stock SDK client in `tenjin mcp` does all of it (`routing-payer.ts`).
 * Nothing else pays it: a call without that payer is skipped when the route
 * asks for it.
 *
 * THE SERVER QUOTES, THIS CLIENT CAPS. The fee is the server's to set, so no
 * fee amount lives here: only the ceiling a quote must not pass, like
 * EIP-1559's `maxFeePerGas`, and the spend limits that bound it beside that.
 *
 * Hook-safe: `tenjin hook` loads this module, and its chunk graph stays free
 * of the wallet and the x402 SDK (`dist-chunks.test.ts`).
 */

/**
 * THE ROUTING FEE CEILING, atomic USDC ($0.003): the most one routing call
 * pays, and the fee every install so far agreed to. A quote at or below it is
 * paid inside the spend limits; one above it is not paid at all
 * ({@link FEE_ABOVE_CEILING}). A lower price needs no release; a higher one
 * does. A count that has no quote to go on (calls a channel still covers, a
 * funded-enough check) uses it, so it never overstates.
 */
export const ROUTING_FEE_CEILING_ATOMIC = 3_000n;
/** The skip reason for a quote above {@link ROUTING_FEE_CEILING_ATOMIC}. */
export const FEE_ABOVE_CEILING = 'fee_above_ceiling';
/** The deposit hint ($0.03) when a 402 carries no `extra.minDeposit`: the
 *  production server's own, and the one doctor sizes from with no 402. */
export const CHANNEL_DEPOSIT_ATOMIC = 30_000n;
/** The SDK's deposit ceiling, atomic USDC ($0.25): its per-payment cap times
 *  `depositMultiplier` (`routing-payer.ts`). */
export const MAX_CHANNEL_DEPOSIT_ATOMIC = 250_000n;
/** The fewest quoted fees a deposit covers, so a top-up's on-chain settle is
 *  not spent on one or two calls. */
export const DEPOSIT_FLOOR_FEES = 10n;

/**
 * THE DEPOSIT TENJIN SIGNS (tenjin#1046): the smallest of the server's hint
 * (the 402's `extra.minDeposit`), the wallet and the per-call limit, so a
 * wallet holding more than the hint keeps the rest for the paid tools routing
 * suggests, which pay from the wallet, never the channel; one between the
 * floor and the hint deposits all it holds. Never below {@link DEPOSIT_FLOOR_FEES}
 * quoted fees or what the next voucher needs, and never above the SDK's
 * ceiling. A balance that could not be read bounds nothing. The caller
 * refuses a wallet below the result (`wallet_low`), and the spend authorizer
 * a limit below it.
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
 * THE DEPOSIT IS THE SPEND. It meets the whole policy once, the day's budget
 * included, when the SDK's `depositStrategy` reserves it. Each fee paid from
 * it then gets only the per-payment checks, at the amount quoted: the per-call
 * limit, the creator allowlist (the router's host) and an explicit zero daily
 * limit. It is never refused for the day's running total, which the deposit
 * already consumed. Null when those checks allow the fee.
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
 * WHY A CALL WAS NOT PAID, for the user: the reason and the fix, keyed by the
 * payer's skip reason (or `no_payer`, when the route asked for the fee and
 * nothing could pay it). Null for a reason that is no fault and needs no
 * fix: another session's call on the channel, or a call queued past its own
 * budget, or a payment still out when the call's
 * budget ran out (it finishes in the background), or an unlock that did not
 * finish inside the call's budget (it keeps running, and the next call gets
 * its answer), or a deposit the background top-up has not made yet.
 *
 * THE WALLET'S OWN REASONS ARE `WALLET_REASONS`, spread in rather than written
 * twice, so a notice names the same cause in the same words as doctor. They
 * carry the PERSON `fix`, never `agentFix`: this sentence goes in the hook's
 * `systemMessage`, which the harness shows the person (B1, decision 15), and a
 * fix that names `tenjin wallet repair` says it asks in their own terminal.
 */
const WALLET_UNPAID: Record<string, { reason: string; fix: string }> = Object.fromEntries(
  Object.entries(WALLET_REASONS).map(([key, { reason, fix }]) => [key, { reason, fix }]),
);
const UNPAID: Record<string, { reason: string; fix: string }> = {
  wallet_low: {
    reason: `the wallet holds less than the $${usd(CHANNEL_DEPOSIT_ATOMIC)} Tenjin needs to set aside for routing`,
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
  TOPPING_UP,
  DEPOSIT_DEFERRED,
]);

/** The reason and fix for an unpaid call, or null when it needs no word. */
export function unpaid(why: string): { reason: string; fix: string } | null {
  if (NO_FAULT.has(why)) return null;
  return UNPAID[why] ?? UNPAID['payment_failed']!;
}

/**
 * The one line said when a deposit went through: on the next leg after the
 * background top-up that made it, or on the call that carried it on a router
 * with no `warm` form. The money is
 * funds set aside for the next routing fees, not a lookup it bought, and the
 * fee is the one the router quoted, when one was read. It still counts toward
 * the daily limit ({@link feeRefusal}).
 */
export function depositSentence(amountAtomic: bigint, feeAtomic?: bigint): string {
  const each = feeAtomic !== undefined ? ` Each routing decision costs $${usd(feeAtomic)}.` : '';
  return `Tenjin set aside $${usd(amountAtomic)} for routing.${each} Unused funds remain yours.`;
}

/**
 * The one line the user sees, once per session and reason, when a call was not
 * paid. Its reader picks the fix (B1): the person's by default; for the model
 * (the `request` tool's text) a wallet unlock reason's `agentFix`, which asks
 * the person to act and never for the passphrase, and any other reason's own.
 * A quote above the ceiling names the price quoted, when the payer read one;
 * a wallet too low names its balance and the deposit it fell short of, when
 * they were read for a deposit. This sentence, said once per session, is
 * where the person sees that balance.
 */
export function unpaidSentence(
  why: string,
  reader: 'person' | 'agent' = 'person',
  facts: SkipFacts = {},
): string | null {
  const { quotedAtomic, balanceAtomic, depositAtomic } = facts;
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
      : why === 'wallet_low' && balanceAtomic !== undefined && depositAtomic !== undefined
        ? `the wallet holds $${usd(balanceAtomic)}, less than the $${usd(depositAtomic)} Tenjin needs to set aside for routing`
        : u.reason;
  return `Tenjin could not pay the routing fee (${reason}), so Tenjin is not routing calls until that is fixed. ${fix}`;
}

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

/** One wallet's folder: the SDK's file storage for its routing channel
 *  (`client/<channelId>.json`). */
export function payerDir(dataDir: string, payer: string): string {
  const name = payer.toLowerCase();
  if (!ADDRESS_RE.test(name)) throw new Error(`not a wallet address: ${payer}`);
  return join(dataDir, 'router', 'fee', name);
}

/** Atomic USDC as dollars with at least two decimals, never a float. */
export function usd(atomic: bigint): string {
  return formatUsdDisplay(atomic.toString());
}
