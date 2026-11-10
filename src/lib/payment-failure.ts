import type { HttpResponse } from './http';
import {
  headerReader,
  paymentRequiredOf,
  settleResponseOf,
  type X402HeaderReader,
} from './x402-headers';

/** Bound parsing of seller-controlled headers and embedded JSON details. */
const MAX_ERROR_CHARS = 16_384;

/** Compare only the code before the first colon, never words in its detail. */
export function reasonCode(error: string | undefined): string | undefined {
  if (error === undefined) return undefined;
  const colon = error.indexOf(':');
  return (colon === -1 ? error : error.slice(0, colon)).trim();
}

function fundsCode(code: string | undefined): boolean {
  return (
    code === 'insufficient_funds' ||
    code === 'invalid_exact_evm_insufficient_funds' ||
    // Preserve facilitator prefixes for insufficient_balance, but require a
    // whole code: prose ending in the same words is not a code.
    (code !== undefined && /^(?:[a-z0-9]+_)*insufficient_balance$/.test(code))
  );
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A code, or a structured invalidReason in a complete JSON detail. No recursion. */
function isShortOfFunds(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > MAX_ERROR_CHARS) return false;
  if (fundsCode(reasonCode(value))) return true;
  const colon = value.indexOf(':');
  if (colon === -1) return false;
  try {
    const detail = record(JSON.parse(value.slice(colon + 1)));
    return typeof detail?.invalidReason === 'string' && fundsCode(reasonCode(detail.invalidReason));
  } catch {
    return false;
  }
}

/**
 * Seller-reported low funds: for failure messaging, and to keep an approved
 * quote open for the person's next yes (`spend-plan.ts`). Never evidence to
 * release an authorization, resize a deposit, or retry a payment unasked.
 */
export function paymentShortOfFunds(
  res: Pick<HttpResponse, 'status' | 'header' | 'json'>,
  http: X402HeaderReader = headerReader,
): boolean {
  // A header over the bound reads as absent, so the SDK's own fall-through applies.
  const bounded = (name: string) => {
    const value = res.header(name);
    return value !== undefined && value.length > MAX_ERROR_CHARS ? undefined : value;
  };
  const settled = settleResponseOf(http, bounded);
  if ([settled?.errorReason, settled?.errorMessage].some(isShortOfFunds)) return true;
  if (res.status !== 402) return false;
  const required = paymentRequiredOf(http, bounded);
  const body = record(res.json);
  return [required?.error, body?.error, body?.reason].some(isShortOfFunds);
}
