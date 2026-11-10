import { x402Client, x402HTTPClient } from '@x402/core/client';

/**
 * THE SDK READS THE x402 RESPONSE HEADERS. `x402HTTPClient` owns their names
 * (`PAYMENT-REQUIRED`, and `PAYMENT-RESPONSE` with v1's `X-PAYMENT-RESPONSE`)
 * and their decoding; this file keeps only what this CLI decided on top.
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

/**
 * THE FIRST HEADER PRESENT ENDS THE READ. The SDK asks for `PAYMENT-RESPONSE`
 * and, when that one is empty or absent, for `X-PAYMENT-RESPONSE`. This CLI has
 * always read the first one present, so an empty or oversized v2 header is
 * unreadable rather than a reason to read a v1 header beside it. Over
 * `maxChars` reads as empty, which the SDK treats as no header.
 */
function firstPresent(header: HeaderLookup, maxChars: number): (name: string) => string {
  let found = false;
  return (name) => {
    if (found) return '';
    const value = header(name);
    if (value === undefined || value === null) return '';
    found = true;
    return value.length > maxChars ? '' : value;
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The settlement a response's payment-response header carries, as an object.
 * `undefined` when the header is absent, empty, over `maxChars`, unreadable or
 * not a JSON object.
 */
export function settleResponseOf(
  http: X402HeaderReader,
  header: HeaderLookup,
  maxChars = Number.POSITIVE_INFINITY,
): Record<string, unknown> | undefined {
  try {
    return record(http.getPaymentSettleResponse(firstPresent(header, maxChars)));
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
  maxChars = Number.POSITIVE_INFINITY,
): Record<string, unknown> | undefined {
  try {
    return record(http.getPaymentRequiredResponse(firstPresent(header, maxChars)));
  } catch {
    return undefined;
  }
}
