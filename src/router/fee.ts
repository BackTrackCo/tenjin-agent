import { join } from 'node:path';
import { formatUsdDisplay } from '../lib/money';
import { evaluateSpendPolicy, type PolicyReason, type SpendPolicy } from '../lib/policy';
import type { DecisionRoute } from './decision';
import { agentFixFor, WALLET_REASONS } from './wallet-reasons';

/**
 * THE ROUTING FEE, WITHOUT ANYTHING THAT PAYS. Every routing call on the paid
 * path pays $0.003 over x402 `batch-settlement`, and the stock SDK client in
 * `tenjin mcp` does all of it (`routing-payer.ts`). Everything else, `tenjin
 * hook` included, is the free path exactly as before this fee existed.
 *
 * Hook-safe: `tenjin hook` loads this module, and its chunk graph stays free
 * of the wallet and the x402 SDK (`dist-chunks.test.ts`).
 */

export const ROUTE_PAID_PATH = '/api/x402-router/route';

/** The flat fee per routing call, atomic USDC ($0.003). */
export const ROUTING_FEE_ATOMIC = 3_000n;
/** The largest channel deposit, atomic USDC ($0.25), made inline by the SDK
 *  on the first paid call of a channel that cannot cover the next fee. */
export const CHANNEL_DEPOSIT_ATOMIC = 250_000n;
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
 * it then gets only the per-payment checks: the per-call limit, the creator
 * allowlist (the router's host) and an explicit zero daily limit. It is never
 * refused for the day's running total, which the deposit already consumed.
 * Null when those checks allow the fee.
 */
export function feeRefusal(policy: SpendPolicy, host: string): string | null {
  const evaluation = evaluateSpendPolicy(
    { ...policy, sessionBudgetAtomic: policy.sessionBudgetAtomic === 0n ? 0n : null },
    { mode: 'automatic', amountAtomic: ROUTING_FEE_ATOMIC, creator: host, sessionSpentAtomic: 0n },
  );
  return evaluation.decision === 'allow' ? null : refusedWhy(evaluation.reason);
}

/** The paid path for this call, or null for the free path. `tenjin mcp` passes
 *  its payer's; absent, every call is free. */
export type RouteFor = (baseUrl: string) => Promise<DecisionRoute | null>;

/** The free path's reason code once the server routes only paid calls. */
export const FEE_REQUIRED = 'fee_required';

/** Whether a decision is the free path's `fee_required` answer. */
export function isFeeRequired(response: unknown): boolean {
  const decision = (response as { decision?: { action?: unknown; diagnostics?: unknown } })
    ?.decision;
  const diagnostics = decision?.diagnostics as { reasonCode?: unknown } | undefined;
  return decision?.action === 'native' && diagnostics?.reasonCode === FEE_REQUIRED;
}

/**
 * WHY A CALL WAS NOT PAID, for the user: the reason and the fix, keyed by the
 * payer's skip reason (or `fee_required`, when the free path answered it and
 * nothing else explains why). Null for a reason that is no fault and needs no
 * fix: another session's call on the channel, a server with no paid path, or
 * a call queued past its own budget, or a payment still out when the call's
 * budget ran out (it finishes in the background), or an unlock that did not
 * finish inside the call's budget (it keeps running, and the next call gets
 * its answer).
 *
 * THE WALLET'S OWN REASONS ARE `WALLET_REASONS`, spread in rather than written
 * twice, so a notice names the same cause in the same words as doctor. They
 * carry the PERSON `fix`, never `agentFix`: this sentence goes in the hook's
 * `systemMessage`, which the harness shows the person (B1, decision 15), and a
 * fix that names `tenjin wallet repair` says it asks in their own terminal.
 * Every other entry, `wallet_low` included, is byte for byte what it was (S5).
 */
const WALLET_UNPAID: Record<string, { reason: string; fix: string }> = Object.fromEntries(
  Object.entries(WALLET_REASONS).map(([key, { reason, fix }]) => [key, { reason, fix }]),
);
const UNPAID: Record<string, { reason: string; fix: string }> = {
  wallet_low: {
    reason: `the wallet holds less than the $${usd(CHANNEL_DEPOSIT_ATOMIC)} routing deposit`,
    fix: `Fund it with \`tenjin wallet fund ${SUGGESTED_FUND_USD}\`.`,
  },
  ...WALLET_UNPAID,
  limit_below_deposit: {
    reason: `the per-call spend limit is below the $${usd(CHANNEL_DEPOSIT_ATOMIC)} routing deposit`,
    fix: 'Run `tenjin doctor`.',
  },
  budget_reached: {
    reason: 'the daily spend limit has no room left for the routing fee or its deposit',
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
  [FEE_REQUIRED]: {
    reason: 'the router now charges it, and this session cannot pay it',
    fix: 'Run `tenjin doctor`.',
  },
};
const NO_FAULT = new Set([
  'channel_busy',
  'paid_path_absent',
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
 * The one line said when a routing call's deposit went through: the money is
 * prepaid credit the next calls draw from, not a lookup it bought. It still
 * counts toward the daily limit ({@link feeRefusal}).
 */
export function depositSentence(amountAtomic: bigint): string {
  return `Tenjin moved $${usd(amountAtomic)} into prepaid routing credit; each routing call uses $${usd(ROUTING_FEE_ATOMIC)}.`;
}

/**
 * The one line the user sees, once per session and reason, when a call was not
 * paid. Its reader picks the fix (B1): the person's by default; for the model
 * (the `request` tool's text) a wallet unlock reason's `agentFix`, which asks
 * the person to act and never for the passphrase, and any other reason's own.
 */
export function unpaidSentence(why: string, reader: 'person' | 'agent' = 'person'): string | null {
  const u = unpaid(why);
  if (u === null) return null;
  const fix = reader === 'agent' ? agentFixFor(why, u.fix) : u.fix;
  return `Tenjin routing could not pay its $${usd(ROUTING_FEE_ATOMIC)} fee (${u.reason}), so Tenjin is not routing calls until that is fixed. ${fix}`;
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
