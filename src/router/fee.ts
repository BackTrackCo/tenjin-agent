import { join } from 'node:path';
import { MAX_AUTO_SPEND_FLOOR_ATOMIC } from '../lib/config';
import { atomicToUsd, formatUsdDisplay } from '../lib/money';
import { evaluateSpendPolicy, type PolicyReason, type SpendPolicy } from '../lib/policy';
import { NO_PAYER, type DecisionRoute } from './decision';
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
 * THE ROUTING FEE CEILING, atomic USDC ($0.25): the most one routing answer
 * pays, and the most one routing deposit holds ({@link MAX_CHANNEL_DEPOSIT_ATOMIC}).
 * The router quotes each answer its own fee, usually far below this; a quote
 * at or below it is paid inside the spend limits, and one above it is not
 * paid at all ({@link FEE_ABOVE_CEILING}). It is a limit, not a price.
 */
export const ROUTING_FEE_CEILING_ATOMIC = 250_000n;
/**
 * THE ROUTER'S FIXED QUOTE ($0.003), which it still offers beside a per-answer
 * quote for the CLIs released before per-answer quotes. This client pays it
 * only when it is the 402's only routing offer (`routing-quote.ts`). An
 * estimate with no 402 in hand (doctor's funded-enough check, the fund line
 * under an empty wallet) sizes from it.
 */
export const LEGACY_ROUTING_QUOTE_ATOMIC = 3_000n;
/** The skip reason for a quote above {@link ROUTING_FEE_CEILING_ATOMIC}. */
export const FEE_ABOVE_CEILING = 'fee_above_ceiling';
/** The deposit hint ($0.05) when a 402 carries no `extra.minDeposit`, and the
 *  one doctor sizes from with no 402. Production announces $0.03, the SDK's
 *  ten-quote default, until the router's update makes it $0.05. */
export const CHANNEL_DEPOSIT_ATOMIC = 50_000n;
/** The SDK's deposit ceiling, atomic USDC ($0.25): its per-payment cap times
 *  `depositMultiplier` (`routing-payer.ts`). */
export const MAX_CHANNEL_DEPOSIT_ATOMIC = 250_000n;
/** Keep this much USDC outside the routing channel for provider payments. */
export const ROUTING_WALLET_RESERVE_ATOMIC = 10_000n;
/** Buffered top-up for a wallet that cannot fit the normal SDK target. */
export const SMALL_CHANNEL_DEPOSIT_ATOMIC = 10_000n;
/** Below ten cents liquid, use the small deposit even when the buffer fits. */
export const SMALL_WALLET_THRESHOLD_ATOMIC = 100_000n;

/** Use the SDK target when it fits at ten cents or more; otherwise use the
 * small target, raised for a larger voucher deficit. Shrink to the balance
 * above the reserve; zero refuses less than the deficit. Null is doctor's estimate. */
export function routingDepositAtomic(o: {
  suggestedAtomic: bigint;
  neededAtomic: bigint;
  balanceAtomic: bigint | null;
  perCallAtomic: bigint;
  maxAtomic: bigint;
}): bigint {
  const least = (a: bigint, b: bigint) => (b < a ? b : a);
  const target = least(least(o.suggestedAtomic, o.perCallAtomic), o.maxAtomic);
  if (o.balanceAtomic === null) return target;
  if (
    o.balanceAtomic >= SMALL_WALLET_THRESHOLD_ATOMIC &&
    o.balanceAtomic >= target + ROUTING_WALLET_RESERVE_ATOMIC
  )
    return target;
  const smaller = least(
    target,
    o.neededAtomic > SMALL_CHANNEL_DEPOSIT_ATOMIC ? o.neededAtomic : SMALL_CHANNEL_DEPOSIT_ATOMIC,
  );
  const available = o.balanceAtomic - ROUTING_WALLET_RESERVE_ATOMIC;
  const amount = least(smaller, available);
  return amount > 0n && amount >= o.neededAtomic ? amount : 0n;
}

/**
 * The top-up every "add funds" hint names, in USD: the checkout's Apple
 * Pay and Google Pay minimum, which covers the routing deposit and a few
 * hundred lookups. `tenjin fund` sends it to the checkout as a preset.
 */
export const SUGGESTED_FUND_USD = '5';
/** The funding line a new wallet is told, after `tenjin wallet create`. */
export const FUNDING_LINE = `Add funds with \`tenjin fund ${SUGGESTED_FUND_USD}\`, or send USDC from a crypto wallet with \`tenjin fund --usdc\`.`;
/** The funding line under a balance of exactly $0, in `tenjin balance` and `tenjin status`. */
export const FUND_COMMAND_LINE = 'Add funds with `tenjin fund`, or ask your agent.';

/** The most a fund link's `need` may name as its price (the link route's bound). */
const NEED_PRICE_MAX_ATOMIC = 100_000_000n;
/** A `--for` label: the link route takes 1 to 60 characters. */
const NEED_LABEL_MAX = 60;

/**
 * THE COMMAND THAT OPENS CHECKOUT FOR ONE WAITING CALL: `tenjin fund 5 --for
 * "X post read" --price 0.006`, so the checkout page says what the money is
 * for. The amount is the suggested top-up, or the price in whole dollars when
 * that is more. The label keeps only characters that are inert inside double
 * quotes in any shell.
 */
export function fundForCommand(label: string, priceAtomic: bigint): string {
  const wholePrice = (priceAtomic + 999_999n) / 1_000_000n;
  const amount =
    wholePrice > BigInt(SUGGESTED_FUND_USD) ? wholePrice.toString() : SUGGESTED_FUND_USD;
  const safe = [
    ...label
      .replace(/[^\p{L}\p{N} .,:'()/+&-]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  ]
    .slice(0, NEED_LABEL_MAX)
    .join('')
    .trim();
  const named =
    safe.length > 0 && priceAtomic > 0n && priceAtomic <= NEED_PRICE_MAX_ATOMIC
      ? ` --for "${safe}" --price ${atomicToUsd(priceAtomic.toString())}`
      : '';
  return `tenjin fund ${amount}${named}`;
}

/**
 * A PAID CALL REFUSED FOR LOW FUNDS, said with what the money is for: "This X
 * post read costs $0.006, more than your Tenjin balance. Ask the person once
 * to add funds; on yes, run `tenjin fund 5 --for "X post read" --price
 * 0.006`." That command opens checkout with the call named on the page. A
 * service with no display label is named by its provider ("A call to
 * BlockRun costs …").
 */
export function shortOfFunds(o: {
  label?: string | undefined;
  provider: string;
  priceAtomic: bigint;
}): string {
  const subject = o.label !== undefined ? `This ${o.label}` : `A call to ${o.provider}`;
  return `${subject} costs $${usd(o.priceAtomic)}, more than your Tenjin balance. Ask the person once to add funds; on yes, run \`${fundForCommand(o.label ?? o.provider, o.priceAtomic)}\`.`;
}
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
 * its answer), or a balance read before a deposit that failed or ran out of
 * time (nothing was signed or sent).
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
    // The least a wallet routes with ({@link routingDepositAtomic}): the
    // reserve kept for provider payments plus a deposit of one fixed quote,
    // $0.013. A dearer answer needs more, so the line says "at least".
    reason: `the wallet holds less than Tenjin needs to set aside for routing (at least $${usd(ROUTING_WALLET_RESERVE_ATOMIC + LEGACY_ROUTING_QUOTE_ATOMIC)})`,
    fix: `Add funds with \`tenjin fund ${SUGGESTED_FUND_USD}\`.`,
  },
  ...WALLET_UNPAID,
  // A SPEND LIMIT IS NEVER A FUNDING PROBLEM: adding money cannot help, so
  // these never point at checkout. They say the balance is not the cause and
  // name the setting that is.
  limit_below_deposit: {
    reason: 'the per-call spend limit cannot cover the routing fee or its deposit',
    fix: `Your balance is fine; this is the per-call limit. Raise it with \`tenjin config set maxAutoSpend ${usd(MAX_AUTO_SPEND_FLOOR_ATOMIC)}\`.`,
  },
  budget_reached: {
    reason: "today's spend limit is used up",
    fix: 'Your balance is fine, and adding funds would not help. The limit frees up as the 24 hours pass, or raise it with `tenjin config set sessionBudget <usd>`.',
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
  'balance_unreadable',
]);

/** The reason and fix for an unpaid call, or null when it needs no word. */
export function unpaid(why: string): { reason: string; fix: string } | null {
  if (NO_FAULT.has(why)) return null;
  return UNPAID[why] ?? UNPAID['payment_failed']!;
}

/**
 * The one line said when a routing call's deposit went through: the money is
 * funds set aside for the next routing fees, not a lookup it bought. It names
 * no fee: each one is the router's quote for its own answer, and the ceiling
 * is a limit, not a price. The deposit counted toward the spend limits once,
 * when it was sent ({@link feeRefusal}).
 */
export function depositSentence(amountAtomic: bigint): string {
  return `Tenjin set aside $${usd(amountAtomic)} for routing fees. It counts toward your spend limits once.`;
}

/**
 * What a call the wallet could not fund says. Routing has not stopped: an
 * answer that needs no payment can still come, so the line says only that
 * this answer went unpaid, and opens no checkout (explicit balance, payment
 * and doctor results keep `unpaid().fix`).
 */
export const WALLET_LOW_SENTENCE =
  'Tenjin could not pay for this routing answer. Routing answers that need no payment can still work. Your usual tools still work.';

/**
 * The one line the user sees, once per session and reason, when a call was not
 * paid. Its reader picks the fix (B1): the person's by default; for the model
 * (the `request` tool's text) a wallet unlock reason's `agentFix`, which asks
 * the person to act and never for the passphrase, and any other reason's own.
 * A quote above the ceiling names the price quoted, when the payer read one.
 */
/**
 * A spend limit, as the person reads it in chat: their agent raises it, so they
 * never get a command they did not type. The agent reader keeps the command.
 */
const PERSON_FIX: Partial<Record<string, string>> = {
  limit_below_deposit:
    'Your balance is fine; this is the per-call limit. Ask your agent to raise it.',
  budget_reached:
    'Your balance is fine, and adding funds would not help. The limit frees up as the 24 hours pass, or ask your agent to raise it.',
};

export function unpaidSentence(
  why: string,
  reader: 'person' | 'agent' = 'person',
  quotedAtomic?: bigint,
): string | null {
  const u = unpaid(why);
  if (u === null) return null;
  if (why === 'wallet_low') return WALLET_LOW_SENTENCE;
  const fix = reader === 'agent' ? agentFixFor(why, u.fix) : (PERSON_FIX[why] ?? u.fix);
  const reason =
    why === FEE_ABOVE_CEILING && quotedAtomic !== undefined
      ? `the router quoted $${usd(quotedAtomic)} a call, more than this install agreed to pay`
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
