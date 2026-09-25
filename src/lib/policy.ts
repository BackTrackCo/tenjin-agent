/**
 * Spend-policy evaluation, pure and provider-agnostic. The wallet provider layer
 * (lib/wallet/spend.ts) owns the ledger and calls this; a future hosted provider
 * (Privy, B5) reuses the same decision rules, so the knobs live in exactly one
 * place. Nothing here does IO, the caller supplies the already-spent total and
 * decides how to satisfy a `confirm` decision (a `--yes`, a TTY prompt, or a
 * non-interactive refusal).
 */

export type PaymentMode = 'automatic' | 'manual';

export interface SpendPolicy {
  /** Automatic per-call ceiling; zero blocks positive automatic payments. */
  maxAutoSpendAtomic: bigint;
  /** Rolling ceiling on automatic exposure. null = no ceiling; zero blocks positive automatic payments. */
  sessionBudgetAtomic: bigint | null;
  /** Creators (handle or 0x-address, lowercased) all payments are restricted to.
   *  Empty = no restriction. A non-empty list is a hard gate: a non-member is
   *  denied even with `--yes`. */
  allowlistCreators: string[];
}

export interface SpendRequest {
  /** Omitted by legacy consumers: conservatively automatic. */
  mode?: PaymentMode;
  amountAtomic: bigint;
  /** Creator identity from the 402 preview / candidate, handle or 0x address. */
  creator: string;
  /** The caller's `--max-price` cap, if given. A hard ceiling, never bypassable. */
  maxPriceAtomic?: bigint;
  /** Cumulative spend already recorded in this rolling session window. */
  sessionSpentAtomic: bigint;
}

/**
 * `allow`: within policy, proceed silently. `confirm`: an approval is required ,
 * the caller satisfies it with `--yes`, an interactive prompt, or refuses. `deny`:
 * a hard gate blocked it (price cap, allowlist, session budget); NOT satisfiable
 * by `--yes` or a prompt.
 */
export type SpendDecision = 'allow' | 'confirm' | 'deny';

/**
 * `duplicate_in_flight` is the one reason this pure evaluator never returns: it
 * is a fact about the ledger (an identical request already holds a reservation
 * in this turn), so the authorizer raises it. It lives in the union because
 * every caller renders a decision's reason from one vocabulary.
 */
export type PolicyReason =
  | 'within_policy'
  | 'duplicate_in_flight'
  | 'price_cap_exceeded'
  | 'not_allowlisted'
  | 'session_budget_exceeded'
  | 'above_auto_spend'
  | 'confirm_always';

export interface PolicyEvaluation {
  decision: SpendDecision;
  reason: PolicyReason;
  message: string;
}

/** Normalize a creator identity for allowlist comparison (case-insensitive; a
 *  word-handle and a 0x address are both single tokens). */
function normCreator(value: string): string {
  return value.trim().toLowerCase();
}

/** Hard price/creator checks apply in both modes. Manual payments require consent;
 * automatic payments must fit both configured ceilings without prompting. */
export function evaluateSpendPolicy(policy: SpendPolicy, req: SpendRequest): PolicyEvaluation {
  if (req.maxPriceAtomic !== undefined && req.amountAtomic > req.maxPriceAtomic) {
    return {
      decision: 'deny',
      reason: 'price_cap_exceeded',
      message: `Price ${req.amountAtomic} exceeds the --max-price cap ${req.maxPriceAtomic}.`,
    };
  }

  if (policy.allowlistCreators.length > 0) {
    const allowed = policy.allowlistCreators.map(normCreator);
    if (!allowed.includes(normCreator(req.creator))) {
      return {
        decision: 'deny',
        reason: 'not_allowlisted',
        message: `Creator "${req.creator}" is not in allowlistCreators.`,
      };
    }
  }

  if (req.mode === 'manual') {
    return req.amountAtomic > 0n
      ? {
          decision: 'confirm',
          reason: 'confirm_always',
          message: 'Manual payment requires explicit consent.',
        }
      : { decision: 'allow', reason: 'within_policy', message: 'No payment required.' };
  }

  if (policy.sessionBudgetAtomic !== null) {
    const projected = req.sessionSpentAtomic + req.amountAtomic;
    if (projected > policy.sessionBudgetAtomic) {
      return {
        decision: 'deny',
        reason: 'session_budget_exceeded',
        message: `This spend would bring the session total to ${projected}, over sessionBudget ${policy.sessionBudgetAtomic}.`,
      };
    }
  }

  if (req.amountAtomic > policy.maxAutoSpendAtomic) {
    return {
      decision: 'deny',
      reason: 'above_auto_spend',
      message: `Price ${req.amountAtomic} is above maxAutoSpend ${policy.maxAutoSpendAtomic}; automatic payment refused.`,
    };
  }

  return { decision: 'allow', reason: 'within_policy', message: 'within spend policy' };
}
