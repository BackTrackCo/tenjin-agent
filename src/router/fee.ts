import type { PartialConfig } from '../lib/config';
import type { DecisionOutcome, DecisionPayment } from './decision';
import {
  claimLane,
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
  | { mode: 'free' }
  | { mode: 'paid'; dataDir: string; allowanceAtomic: bigint; prefer?: readonly number[] };

export function routingFeeApproved(config: PartialConfig): boolean {
  return config.routingFee === 'approved';
}

export function routingAllowanceAtomic(config: PartialConfig): bigint {
  return config.routingAllowance !== undefined
    ? BigInt(config.routingAllowance)
    : ROUTING_ALLOWANCE_ATOMIC;
}

export async function routingFeeFor(dataDir: string, config: PartialConfig): Promise<RoutingFee> {
  if (!routingFeeApproved(config)) return { mode: 'free' };
  const pool = await readPool(dataDir).catch(() => null);
  if (pool?.paidPath !== 'available') return { mode: 'free' };
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
 */
export async function payForDecision<T>(
  fee: RoutingFee,
  call: (payment: DecisionPayment | undefined) => Promise<DecisionOutcome<T>>,
  now: number = Date.now(),
): Promise<DecisionOutcome<T> | Skipped> {
  if (fee.mode === 'free') return call(undefined);
  const claimed = await claimLane(fee.dataDir, {
    now,
    allowanceAtomic: fee.allowanceAtomic,
    ...(fee.prefer !== undefined ? { prefer: fee.prefer } : {}),
  });
  if (claimed.lane === null) return { status: 'skipped', why: claimed.why };
  const { lane } = claimed;
  let outcome: DecisionOutcome<T> | undefined;
  try {
    outcome = await call({ path: ROUTE_PAID_PATH, signature: lane.header });
    return outcome;
  } finally {
    await lane.finish(outcome?.payment ?? { kind: 'no_answer' }).catch(() => undefined);
  }
}
