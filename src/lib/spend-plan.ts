import { evaluatePlan, type SpendPolicy } from './policy';
import { readSpendSummary, spentOf } from './spend-ledger';
import { quoteClosed, readQuote, useQuote, type Quote, type QuoteRefusal } from './spend-quotes';

/**
 * ONE SPEND RULE FOR EVERY ROUTER CALL. A call that pays first lists the
 * payments it will make at their quoted amounts: its plan. The plan's total
 * meets the automatic limits once, before anything is signed: `maxAutoSpend`
 * for the whole call and the rolling day's `sessionBudget`. Under them it
 * runs. Over them nothing is paid; on a host that asks
 * the user, the router keeps the plan as a quote for their yes
 * (`spend-quotes.ts`), and a quote they approved may pass both limits. Funds
 * are verified at settlement; a multi-payment plan can settle partially.
 *
 * A ROUTER PAYMENT IS SIGNED ONLY AGAINST A PLAN. Admitting a plan here, or
 * using up an approved quote, is the only way to get the slots `runPay`
 * accepts in router mode: one per payment, for at most its planned amount,
 * each spent once. A payment no plan admitted is refused at signing, so a
 * feature that forgets to plan cannot pay.
 */

export interface PlannedPayment {
  amountAtomic: bigint;
  /** The payee's host: the policy's creator identity. */
  creator: string;
}

/** What one payment of an admitted plan may sign. */
export interface PlanSlot {
  /** The most it may sign: its planned amount. */
  readonly amountAtomic: bigint;
  /** A person said yes to the plan, so it is theirs, not automatic. */
  readonly approved: boolean;
}

const minted = new WeakSet<PlanSlot>();
const spent = new WeakSet<PlanSlot>();

function mint(amountAtomic: bigint, approved: boolean): PlanSlot {
  const slot: PlanSlot = Object.freeze({ amountAtomic, approved });
  minted.add(slot);
  return slot;
}

/** Why a slot cannot pay this amount: not admitted here, already spent, or
 *  less than the live price. */
export type SlotRefusal = 'unplanned' | 'spent' | 'above_plan';

/** Spend a slot on a payment of `amountAtomic`, or say why it cannot be. */
export function spendSlot(slot: unknown, amountAtomic: bigint): SlotRefusal | null {
  if (typeof slot !== 'object' || slot === null || !minted.has(slot as PlanSlot)) {
    return 'unplanned';
  }
  const held = slot as PlanSlot;
  if (spent.has(held)) return 'spent';
  if (amountAtomic > held.amountAtomic) return 'above_plan';
  spent.add(held);
  return null;
}

/** A plan over the automatic limits: what a person is asked about. */
export interface PlanOver {
  reason: 'above_auto_spend' | 'session_budget_exceeded';
  totalAtomic: bigint;
  maxAutoSpendAtomic: bigint;
  /** What the rolling day's budget has left; null with no budget. */
  budgetLeftAtomic: bigint | null;
}

export type PlanAdmission =
  | { admitted: PlanSlot[] }
  | { over: PlanOver }
  /** A payee outside `allowlistCreators`: no one's yes clears that. */
  | { refused: { message: string } };

/** Admit a plan against local spend policy, without a balance preflight. */
export async function admitPlan(
  payments: readonly PlannedPayment[],
  opts: {
    dataDir: string;
    policy: SpendPolicy;
    now?: () => number;
  },
): Promise<PlanAdmission> {
  const totalAtomic = payments.reduce((sum, payment) => sum + payment.amountAtomic, 0n);
  const ledger = await readSpendSummary(opts.dataDir, {
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
  const spentAtomic = ledger === null ? 0n : spentOf(ledger);
  const evaluation = evaluatePlan(opts.policy, payments, spentAtomic);
  if (evaluation.reason === 'not_allowlisted') return { refused: { message: evaluation.message } };
  const over = evaluation.decision !== 'allow';
  if (over) {
    const budget = opts.policy.sessionBudgetAtomic;
    return {
      over: {
        reason:
          evaluation.reason === 'session_budget_exceeded'
            ? 'session_budget_exceeded'
            : 'above_auto_spend',
        totalAtomic,
        maxAutoSpendAtomic: opts.policy.maxAutoSpendAtomic,
        budgetLeftAtomic: budget === null ? null : budget > spentAtomic ? budget - spentAtomic : 0n,
      },
    };
  }
  return { admitted: payments.map((payment) => mint(payment.amountAtomic, false)) };
}

/**
 * RUN A QUOTE A PERSON APPROVED: its plan's slots, one per quoted payment,
 * minted approved, and the quote used up so it pays once. The caller is the
 * `approve` call, which reaches this process only after the host's own
 * prompt put it to a person; nothing on disk says anyone approved anything.
 * The caller opens the wallet first, so a wallet that will not open leaves
 * the quote open. Once used, a quote stays consumed even if settlement fails.
 */
export async function admitQuote(
  dataDir: string,
  id: string,
  opts: { now?: () => number } = {},
): Promise<{ admitted: PlanSlot[]; quote: Quote } | { refused: QuoteRefusal }> {
  const now = opts.now ?? Date.now;
  const kept = await readQuote(dataDir, id);
  if (kept === null) return { refused: 'missing' };
  const closed = quoteClosed(kept, now());
  if (closed !== null) return { refused: closed };
  const used = await useQuote(dataDir, id, now);
  if ('refused' in used) return used;
  return {
    quote: used.quote,
    admitted: used.quote.payments.map((payment) => mint(BigInt(payment.amountAtomic), true)),
  };
}
