import { x402Client, x402HTTPClient } from '@x402/core/client';

/**
 * THE SDK READS THE x402 RESPONSE HEADERS. `x402HTTPClient` owns their names
 * (`PAYMENT-REQUIRED`, and `PAYMENT-RESPONSE` with v1's `X-PAYMENT-RESPONSE`)
 * and their decoding, including the fall-through to `X-PAYMENT-RESPONSE` when
 * `PAYMENT-RESPONSE` is empty or absent. This file only makes a read total.
 */
export type X402HeaderReader = Pick<
  x402HTTPClient,
  'getPaymentRequiredResponse' | 'getPaymentSettleResponse'
>;

/** A response's case-insensitive header lookup (`HttpResponse.header`, `Headers.get`). */
type HeaderLookup = (name: string) => string | null | undefined;

/**
 * The reader for a read where no payer client exists: a job's answer read in a
 * later call, and the routing quote, read before the wallet is opened and by
 * the router check. Nothing is registered on it, so it reads headers and can
 * build no payment. Where a payer client exists, its own `http` reads instead.
 */
export const headerReader: X402HeaderReader = new x402HTTPClient(new x402Client());

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The settlement a response's payment-response header carries, as an object.
 * `undefined` when no header is readable or it is not a JSON object.
 */
export function settleResponseOf(
  http: X402HeaderReader,
  header: HeaderLookup,
): Record<string, unknown> | undefined {
  try {
    return record(http.getPaymentSettleResponse(header));
  } catch {
    return undefined;
  }
}

/**
 * The declaration a response's payment-required header carries, as an object,
 * on the same terms. The body is never read: a v1 challenge in the body is not
 * a payment-required header.
 */
export function paymentRequiredOf(
  http: X402HeaderReader,
  header: HeaderLookup,
): Record<string, unknown> | undefined {
  try {
    return record(http.getPaymentRequiredResponse(header));
  } catch {
    return undefined;
  }
}
