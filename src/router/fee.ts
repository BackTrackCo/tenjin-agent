import type { PartialConfig } from '../lib/config';
import type { DecisionOutcome, DecisionPayment } from './decision';
import {
  claimLane,
  noteFeeRequired,
  readPool,
  ROUTE_PAID_PATH,
  ROUTING_ALLOWANCE_ATOMIC,
  type NoLane,
} from './lanes';

/**
 * WHICH PATH A ROUTING CALL TAKES. The paid path is used only when the user
 * approved the routing fee AND the server answers that path (an owner probed it
 * and recorded `paidPath: available`). Anything else is the free path, exactly
 * as before this fee existed, so the client is inert until both hold.
 *
 * Hook-safe: no wallet, no x402 SDK. The owner (`lane-owner.ts`) does all the
 * signing and funding; this only spends a rung it already wrote.
 */
export type RoutingFee =
  /** `dataDir`, when given, is where a `fee_required` answer is noted. */
  | { mode: 'free'; dataDir?: string }
  | { mode: 'paid'; dataDir: string; allowanceAtomic: bigint; prefer?: readonly number[] };

/** The free path's reason code once the server routes only paid calls. */
export const FEE_REQUIRED = 'fee_required';

export function routingFeeApproved(config: PartialConfig): boolean {
  return config.routingFee === 'approved';
}

export function routingAllowanceAtomic(config: PartialConfig): bigint {
  return config.routingAllowance !== undefined
    ? BigInt(config.routingAllowance)
    : ROUTING_ALLOWANCE_ATOMIC;
}

export async function routingFeeFor(dataDir: string, config: PartialConfig): Promise<RoutingFee> {
  if (!routingFeeApproved(config)) return { mode: 'free', dataDir };
  const pool = await readPool(dataDir).catch(() => null);
  if (pool?.paidPath !== 'available') return { mode: 'free', dataDir };
  return { mode: 'paid', dataDir, allowanceAtomic: routingAllowanceAtomic(config) };
}

/** No lane could pay, so the call is not made and the native tool runs. */
export interface Skipped {
  status: 'skipped';
  why: NoLane;
}

/**
 * ONE ROUTING CALL, PAID WHEN IT HAS TO BE. On the paid path a lane is claimed
 * first; with none free (or recovering, or below one fee, or the allowance
 * spent) the call is skipped rather than sent unpaid. The lane's result is
 * written and its claim dropped whatever the call did.
 *
 * ONE BUDGET FOR THE CLAIM AND THE CALL. With `budgetMs` (the hook's, inside
 * the harness's timeout) `call` gets what the claim left of it as its timeout,
 * so the two together never run past the budget.
 */
export async function payForDecision<T>(
  fee: RoutingFee,
  call: (
    payment: DecisionPayment | undefined,
    timeoutMs: number | undefined,
  ) => Promise<DecisionOutcome<T>>,
  now: number = Date.now(),
  budgetMs?: number,
): Promise<DecisionOutcome<T> | Skipped> {
  if (fee.mode === 'free') {
    const outcome = await call(undefined, budgetMs);
    // A `fee_required` answer is how a machine without approval learns the
    // server takes the fee: doctor, the prompt hook and the tool then name
    // the approval command. Any other answer clears it; no answer says nothing.
    if (fee.dataDir !== undefined && outcome.status === 'decided') {
      await noteFeeRequired(fee.dataDir, isFeeRequired(outcome.decision), now).catch(
        () => undefined,
      );
    }
    return outcome;
  }
  const until = budgetMs === undefined ? undefined : Date.now() + budgetMs;
  const claimed = await claimLane(fee.dataDir, {
    now,
    allowanceAtomic: fee.allowanceAtomic,
    ...(fee.prefer !== undefined ? { prefer: fee.prefer } : {}),
  });
  if (claimed.lane === null) return { status: 'skipped', why: claimed.why };
  const { lane } = claimed;
  let outcome: DecisionOutcome<T> | undefined;
  try {
    outcome = await call(
      { path: ROUTE_PAID_PATH, signature: lane.header },
      until === undefined ? undefined : Math.max(0, until - Date.now()),
    );
    return outcome;
  } finally {
    await lane.finish(outcome?.payment ?? { kind: 'no_answer' }).catch(() => undefined);
  }
}

/** Whether a decision is the free path's `fee_required` answer. */
export function isFeeRequired(response: unknown): boolean {
  const decision = (response as { decision?: { action?: unknown; diagnostics?: unknown } })
    ?.decision;
  const diagnostics = decision?.diagnostics as { reasonCode?: unknown } | undefined;
  return decision?.action === 'native' && diagnostics?.reasonCode === FEE_REQUIRED;
}
