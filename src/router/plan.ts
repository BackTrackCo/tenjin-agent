import { z } from 'zod';
import { toMoney } from '../lib/money';
import { policyFix } from '../lib/spend-gate';
import type { PlanAdmission, PlannedPayment } from '../lib/spend-plan';
import { createQuote, type Quote } from '../lib/spend-quotes';
import { readUsdcBalanceWithFallback } from '../lib/usdc-balance';
import { resolveWalletProvider, type WalletProvider } from '../lib/wallet';
import { OfferSpecSchema, type OfferSpec, type SpecOutcome } from './decision';
import { KeptChoicesSchema, type KeptChoices } from './specs';
import type { FailExtras, FailStatus, ProviderCall, RequestToolDeps } from './tool';

/**
 * A CALL'S SPEND PLAN, AS THE AGENT AND THE USER HEAR IT. Every request-tool
 * call that pays plans its payments first (`lib/spend-plan.ts`): a single
 * offer is a plan of one at its live price, a count is N takes at the price
 * one take is quoted, and a choice set is each option at its own quote. This
 * file says what such a plan buys, keeps one over the automatic limits as a
 * quote with exactly what it runs where the host offers `approve`, and words
 * the stop: the sentence the agent repeats, and, with a quote, the one call
 * that asks the user.
 *
 * Imported by `tool.ts` and `choices.ts` alone, so it stays in the request
 * tool's chunk.
 */

/** What a quote runs when the user says yes: a spec's call, a count's takes,
 *  a choice set's options, or a server-built call. Nothing about it changes
 *  after the quote: the agent cannot send a different input to approve. */
export type QuotedCall =
  | { kind: 'spec'; id: string; spec: OfferSpec; input: Record<string, unknown> }
  | {
      kind: 'count';
      id: string;
      spec: OfferSpec;
      input: Record<string, unknown>;
      count: number;
    }
  | {
      kind: 'choices';
      id: string;
      kept: KeptChoices;
      /** Each option's spec, in the set's order. */
      specs: OfferSpec[];
      /** The options the quote runs: those its seller quoted. */
      keys: string[];
      input: Record<string, unknown>;
    }
  | { kind: 'call'; call: ProviderCall };

const Input = z.record(z.string(), z.unknown());
const Digits = z.string().regex(/^\d+$/);

const QuotedCallSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('spec'),
    id: z.string().min(1),
    spec: OfferSpecSchema,
    input: Input,
  }),
  z.strictObject({
    kind: z.literal('count'),
    id: z.string().min(1),
    spec: OfferSpecSchema,
    input: Input,
    count: z.number().int().min(2).max(5),
  }),
  z.strictObject({
    kind: z.literal('choices'),
    id: z.string().min(1),
    kept: KeptChoicesSchema,
    specs: z.array(OfferSpecSchema).min(2).max(4),
    keys: z.array(z.string().min(1).max(64)).min(1).max(4),
    input: Input,
  }),
  z.strictObject({
    kind: z.literal('call'),
    call: z.strictObject({
      capabilityId: z.string().min(1).max(200),
      provider: z.string().min(1).max(120),
      media: z.boolean(),
      request: z.strictObject({
        url: z.string().min(1).max(16_384),
        method: z.string().min(1).max(8),
        headers: z.record(z.string(), z.string()),
        body: z.string().optional(),
      }),
      terms: z.strictObject({
        source: z.string().optional(),
        maxAmountAtomic: Digits,
        payTo: z.string().optional(),
        network: z.string().optional(),
        asset: z.string().optional(),
      }),
      requestKey: z.string().min(1).max(1_024),
      resultSchema: z.record(z.string(), z.unknown()).optional(),
      parameters: z.unknown(),
      sent: z.string().max(16_384),
      note: z.string().max(2_000).optional(),
    }),
  }),
]);

/** The call a kept quote runs, or null when its file does not hold one. */
export function quotedCall(quote: Quote): QuotedCall | null {
  const parsed = QuotedCallSchema.safeParse(quote.call);
  return parsed.success ? (parsed.data as QuotedCall) : null;
}

const usd = (atomic: bigint): string => `$${toMoney(atomic.toString()).usd}`;

/** What a plan buys, and the one sentence that says it with its cost. */
export interface PlanWords {
  what: string;
  sentence: string;
}

export function oneCall(provider: string, amountAtomic: bigint): PlanWords {
  return {
    what: `one call to ${provider}`,
    sentence: `One call to ${provider} costs ${usd(amountAtomic)}.`,
  };
}

export function takesOf(provider: string, amounts: readonly bigint[]): PlanWords {
  const what = `${amounts.length} takes of ${provider}`;
  const total = amounts.reduce((sum, amount) => sum + amount, 0n);
  const each = amounts.every((amount) => amount === amounts[0])
    ? `${usd(amounts[0] ?? 0n)} each`
    : amounts.map(usd).join(' + ');
  return { what, sentence: `${what} cost ${usd(total)} in total (${each}).` };
}

export function choicesOf(labels: readonly string[], amounts: readonly bigint[]): PlanWords {
  const what = `${labels.length} choices (${labels.join(', ')})`;
  const total = amounts.reduce((sum, amount) => sum + amount, 0n);
  return {
    what,
    sentence: `${what} cost ${usd(total)} in total (${amounts.map(usd).join(' + ')}).`,
  };
}

/** Why a plan over the limits is asked about rather than paid. */
function whyAsked(over: Extract<PlanAdmission, { over: unknown }>['over']): string {
  return over.reason === 'session_budget_exceeded'
    ? `That is more than today's automatic budget has left (${usd(over.budgetLeftAtomic ?? 0n)})`
    : `That is over the ${usd(over.maxAutoSpendAtomic)} this machine pays for one call without asking`;
}

/** The one call that puts a quote to the user, with what they are shown. */
export function approveCall(quote: Quote): string {
  return `approve({quote: ${JSON.stringify(quote.id)}, total: ${JSON.stringify(usd(BigInt(quote.totalAtomic)))}, what: ${JSON.stringify(quote.what)}})`;
}

/** The step a quote's result names: the approve call, and nothing else. */
export function approveStep(quote: Quote): string {
  return `Call ${approveCall(quote)}: it asks the user and runs only on their yes. Do not suggest changing a setting.`;
}

/** A quote as the agent is handed it. */
export function quoteView(quote: Quote): Record<string, unknown> {
  return {
    id: quote.id,
    what: quote.what,
    total: usd(BigInt(quote.totalAtomic)),
    expiresAt: quote.expiresAt,
  };
}

/** How a plan that was not admitted ends the call: nothing paid. */
export interface PlanStop {
  status: Extract<FailStatus, 'needs_approval' | 'failed'>;
  reason: string;
  extras: FailExtras;
  /** What the server is told: an approval is not a refusal of the offer. */
  outcome: Omit<SpecOutcome, 'id' | 'ms'>;
}

/**
 * WHY A PLAN DID NOT RUN, AND WHAT FOLLOWS. Over the automatic limits it is
 * kept as a quote, and the answer is the sentence and the approve call. A
 * payee outside `allowlistCreators` is the user's own hard rule, which no
 * approval clears. A wallet short of the total is the fund command, as for
 * any payment. `alternative` is the smaller call the agent may make instead.
 * A host that does not offer `approve` keeps no quote: nobody could run it.
 */
export async function planStop(
  admission: Exclude<PlanAdmission, { admitted: unknown }>,
  plan: PlanWords & { payments: readonly PlannedPayment[]; call: QuotedCall },
  deps: Pick<RequestToolDeps, 'ctx' | 'now' | 'approves'>,
  alternative?: string,
): Promise<PlanStop> {
  const or = alternative !== undefined ? `, or ${alternative}` : '';
  if ('refused' in admission) {
    return {
      status: 'needs_approval',
      reason: `${plan.sentence} ${admission.refused.message} ${policyFix('not_allowlisted', 'this host')}`,
      extras: { nextStep: `Tell the user${or}; nothing was paid.` },
      outcome: { status: 'needs_approval' },
    };
  }
  if ('short' in admission) {
    const { balanceAtomic, totalAtomic } = admission.short;
    return {
      status: 'failed',
      reason: `${plan.sentence} The wallet holds ${usd(balanceAtomic)}, ${usd(totalAtomic - balanceAtomic)} short. The wallet has insufficient USDC; no payment was signed. Fund this wallet on Base with \`tenjin wallet fund\` before paying.`,
      extras: { nextStep: `Tell the user${or}; nothing was paid.` },
      outcome: { status: 'unpaid', reason: 'wallet' },
    };
  }
  const why = whyAsked(admission.over);
  if (deps.approves !== true) {
    return {
      status: 'needs_approval',
      reason: `${plan.sentence} ${why}, so nothing was paid.`,
      extras: { nextStep: `Tell the user what it would cost${or}; nothing was paid.` },
      outcome: { status: 'needs_approval' },
    };
  }
  try {
    const quote = await createQuote(
      deps.ctx.dataDir,
      { what: plan.what, sentence: plan.sentence, payments: plan.payments, call: plan.call },
      deps.now,
    );
    return {
      status: 'needs_approval',
      reason: `${plan.sentence} ${why}, so nothing was paid.`,
      extras: { quote: quoteView(quote), nextStep: approveStep(quote) },
      outcome: { status: 'needs_approval' },
    };
  } catch (err) {
    return {
      status: 'needs_approval',
      reason: `${plan.sentence} ${why}, and this machine could not keep a quote for it (${err instanceof Error ? err.message : String(err)}), so nothing was paid.`,
      extras: { nextStep: `Tell the user it needs their approval${or}; nothing was paid.` },
      outcome: { status: 'needs_approval' },
    };
  }
}

/** The wallet a call pays from, as `runPay` resolves it: the pre-warmed
 *  provider, the test seam's, or this machine's own. */
export function paymentProvider(deps: RequestToolDeps): WalletProvider {
  return deps.provider ?? deps.payDeps?.provider ?? resolveWalletProvider(deps.ctx);
}

/** The paying wallet's USDC balance, read the way `runPay` reads it, or null
 *  when there is no wallet or the read failed. */
export async function walletBalance(deps: RequestToolDeps, rpcUrl: string): Promise<bigint | null> {
  try {
    const { address } = await paymentProvider(deps).describe();
    const read = deps.payDeps?.readBalance ?? readUsdcBalanceWithFallback;
    return await read(address, rpcUrl, {
      timeoutMs: Math.max(1, Math.floor(deps.ctx.flags.timeout / 2)),
    });
  } catch {
    return null;
  }
}
