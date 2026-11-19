import { decodePaymentRequiredHeader } from '@x402/core/http';
import type { PaymentRequirements } from '@x402/core/types';
import { canonicalUsdcOnly } from '../lib/x402-pay';
import { LEGACY_ROUTING_QUOTE_ATOMIC, ROUTING_FEE_CEILING_ATOMIC } from './fee';

/**
 * THE ROUTING FEE A 402 QUOTES, read the same way by the payer, which pays it,
 * and by the router check in doctor and install, which reports it.
 *
 * THE PER-ANSWER QUOTE FIRST. The router quotes each answer its own fee and,
 * for CLIs released before that, also offers its fixed
 * {@link LEGACY_ROUTING_QUOTE_ATOMIC} beside it. This client pays the
 * per-answer quote whenever the 402 carries one, below the fixed quote too,
 * and the fixed quote only when it is the 402's only offer. A per-answer quote
 * above the ceiling is not paid, and the fixed quote is not chosen in its
 * place.
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
 * THE OFFER THIS CLIENT WOULD PAY, and whether the ceiling allows it: the
 * first per-answer offer at or below the ceiling; else the smallest one above
 * it, refused; else, with no per-answer offer at all, the fixed one. Undefined
 * for a 402 with no routing offer.
 */
export function chosenOffer(
  offers: PaymentRequirements[],
): { offer: PaymentRequirements; allowed: boolean } | undefined {
  const perAnswer = offers.filter((r) => BigInt(r.amount) !== LEGACY_ROUTING_QUOTE_ATOMIC);
  const within = perAnswer.find((r) => BigInt(r.amount) <= ROUTING_FEE_CEILING_ATOMIC);
  if (within !== undefined) return { offer: within, allowed: true };
  if (perAnswer.length > 0) {
    const smallest = perAnswer.reduce((a, b) => (BigInt(b.amount) < BigInt(a.amount) ? b : a));
    return { offer: smallest, allowed: false };
  }
  const fixed = offers[0];
  return fixed === undefined ? undefined : { offer: fixed, allowed: true };
}

/**
 * WHAT A 402 QUOTES: the amount of {@link chosenOffer}, the one the
 * per-payment checks must allow, or one above the ceiling that is refused;
 * null when it carries none this client reads, which the SDK then refuses as
 * it always did.
 */
export function quoteOf(header: (name: string) => string | null | undefined): bigint | null {
  const value = header('PAYMENT-REQUIRED');
  if (value === null || value === undefined) return null;
  try {
    const required = decodePaymentRequiredHeader(value);
    const chosen = chosenOffer(routingOffers(required.x402Version, required.accepts));
    return chosen === undefined ? null : BigInt(chosen.offer.amount);
  } catch {
    return null;
  }
}
