import { decodePaymentRequiredHeader } from '@x402/core/http';
import type { PaymentRequirements } from '@x402/core/types';
import { canonicalUsdcOnly } from '../lib/x402-pay';
import { ROUTING_FEE_CEILING_ATOMIC } from './fee';

/**
 * THE ROUTING FEE A 402 QUOTES, read the same way by the payer, which pays it,
 * and by the router check in doctor and install, which reports it.
 */

/** The routing offers in a 402: `batch-settlement` in canonical USDC on
 *  Base, with an amount this client can read. */
export function routingOffers(
  version: number,
  requirements: PaymentRequirements[],
): PaymentRequirements[] {
  return canonicalUsdcOnly(version, requirements).filter(
    (r) => r.scheme === 'batch-settlement' && /^\d{1,30}$/.test(r.amount),
  );
}

/**
 * WHAT A 402 QUOTES: the largest routing offer at or below the ceiling, the
 * one the per-payment checks must allow whichever the SDK picks; else the
 * smallest above it; null when it carries none this client reads, which the
 * SDK then refuses as it always did.
 */
export function quoteOf(header: (name: string) => string | null | undefined): bigint | null {
  const value = header('PAYMENT-REQUIRED');
  if (value === null || value === undefined) return null;
  try {
    const required = decodePaymentRequiredHeader(value);
    const amounts = routingOffers(required.x402Version, required.accepts).map((r) =>
      BigInt(r.amount),
    );
    const within = amounts.filter((a) => a <= ROUTING_FEE_CEILING_ATOMIC);
    if (within.length > 0) return within.reduce((a, b) => (b > a ? b : a));
    return amounts.length > 0 ? amounts.reduce((a, b) => (b < a ? b : a)) : null;
  } catch {
    return null;
  }
}
