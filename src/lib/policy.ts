/**
 * Spend-policy evaluation, pure and provider-agnostic. The wallet provider layer
 * (lib/wallet/spend.ts) owns the ledger and calls this; a future hosted provider
 * (Privy, B5) reuses the same decision rules, so the knobs live in exactly one
 * place. Nothing here does IO — the caller supplies the already-spent total and
 * decides how to satisfy a `confirm` decision (a `--yes`, a TTY prompt, or a
 * non-interactive refusal).
 */

/** How a `confirm` gate is configured (parsed from the stored config string). */
export type ConfirmPolicy = { mode: 'always' } | { mode: 'above'; thresholdAtomic: bigint };

export interface SpendPolicy {
  /** Amounts at or below this auto-approve WITHOUT a prompt (still subject to the
   *  confirm gate below). Default 0 → nothing auto-approves. */
  maxAutoSpendAtomic: bigint;
  /** Rolling local ceiling on cumulative session spend. 0 = disabled (no ceiling). */
  sessionBudgetAtomic: bigint;
  /** When a human confirmation is requested. */
  confirm: ConfirmPolicy;
  /** Creators (handle or 0x-address, lowercased) auto-payment is restricted to.
   *  Empty = no restriction. A non-empty list is a hard gate: a non-member is
   *  denied even with `--yes`. */
  allowlistCreators: string[];
}

export interface SpendRequest {
  amountAtomic: bigint;
  /** Creator identity from the 402 preview / candidate — handle or 0x address. */
  creator: string;
  /** The caller's `--max-price` cap, if given. A hard ceiling, never bypassable. */
  maxPriceAtomic?: bigint;
  /** Cumulative spend already recorded in this rolling session window. */
  sessionSpentAtomic: bigint;
}

/**
 * `allow`: within policy, proceed silently. `confirm`: an approval is required —
 * the caller satisfies it with `--yes`, an interactive prompt, or refuses. `deny`:
 * a hard gate blocked it (price cap, allowlist, session budget); NOT satisfiable
 * by `--yes` or a prompt.
 */
export type SpendDecision = 'allow' | 'confirm' | 'deny';

export type PolicyReason =
  | 'within_policy'
  | 'price_cap_exceeded'
  | 'not_allowlisted'
  | 'session_budget_exceeded'
  | 'above_auto_spend'
  | 'confirm_always'
  | 'above_confirm_threshold';

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

/**
 * Evaluate one spend against the policy. Hard gates run first (price cap →
 * allowlist → session budget); only if all pass is the confirm gate consulted. A
 * spend at or below `maxAutoSpend` that the confirm policy would not prompt for is
 * the only `allow`; everything else within the hard gates is `confirm`.
 */
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

  if (policy.sessionBudgetAtomic > 0n) {
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
      decision: 'confirm',
      reason: 'above_auto_spend',
      message: `Price ${req.amountAtomic} is above maxAutoSpend ${policy.maxAutoSpendAtomic}; confirmation required.`,
    };
  }

  if (policy.confirm.mode === 'always') {
    return {
      decision: 'confirm',
      reason: 'confirm_always',
      message: 'confirm policy is "always"; confirmation required.',
    };
  }

  if (req.amountAtomic > policy.confirm.thresholdAtomic) {
    return {
      decision: 'confirm',
      reason: 'above_confirm_threshold',
      message: `Price ${req.amountAtomic} is above the confirm threshold ${policy.confirm.thresholdAtomic}; confirmation required.`,
    };
  }

  return { decision: 'allow', reason: 'within_policy', message: 'within spend policy' };
}

/** Parse the stored `confirm` config value ("always" | "above:<atomic>"). */
export function parseConfirmPolicy(stored: string): ConfirmPolicy {
  if (stored === 'always') return { mode: 'always' };
  const m = /^above:(\d+)$/.exec(stored);
  if (m && m[1] !== undefined) return { mode: 'above', thresholdAtomic: BigInt(m[1]) };
  // The config schema already constrains this; a malformed value here is a bug,
  // so fail closed to the safest interpretation rather than throwing mid-buy.
  return { mode: 'always' };
}
