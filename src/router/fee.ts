import type { PartialConfig } from '../lib/config';
import type { DecisionRoute } from './decision';
import { ROUTING_ALLOWANCE_ATOMIC } from './fee-state';

/**
 * WHICH PATH A ROUTING CALL TAKES. The paid path is used only inside
 * `tenjin mcp`, only once the user approved the routing fee, and only while the
 * server answers that path (`routing-payer.ts`). Everything else, `tenjin hook`
 * included, is the free path exactly as before this fee existed.
 *
 * Hook-safe: no wallet, no x402 SDK.
 */

/** The paid path for this call, or null for the free path. `tenjin mcp` passes
 *  its payer's; absent, every call is free. */
export type RouteFor = (config: PartialConfig, baseUrl: string) => Promise<DecisionRoute | null>;

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

/** Whether a decision is the free path's `fee_required` answer. */
export function isFeeRequired(response: unknown): boolean {
  const decision = (response as { decision?: { action?: unknown; diagnostics?: unknown } })
    ?.decision;
  const diagnostics = decision?.diagnostics as { reasonCode?: unknown } | undefined;
  return decision?.action === 'native' && diagnostics?.reasonCode === FEE_REQUIRED;
}
