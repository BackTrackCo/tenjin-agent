import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from '@x402/core/http';
import type { HttpResponse } from './http';

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

function headerObject(
  header: string | undefined,
  decode: (header: string) => unknown,
): Record<string, unknown> | undefined {
  if (header === undefined || header.length > MAX_ERROR_CHARS) return undefined;
  try {
    return record(decode(header));
  } catch {
    return undefined;
  }
}

/**
 * Seller-reported low funds, for failure messaging only. Never evidence to
 * release an authorization, resize a deposit, or retry a payment.
 */
export function paymentShortOfFunds(
  res: Pick<HttpResponse, 'status' | 'header' | 'json'>,
): boolean {
  const settled = headerObject(
    res.header('PAYMENT-RESPONSE') ?? res.header('X-PAYMENT-RESPONSE'),
    decodePaymentResponseHeader,
  );
  if ([settled?.errorReason, settled?.errorMessage].some(isShortOfFunds)) return true;
  if (res.status !== 402) return false;
  const required = headerObject(res.header('PAYMENT-REQUIRED'), decodePaymentRequiredHeader);
  const body = record(res.json);
  return [required?.error, body?.error, body?.reason].some(isShortOfFunds);
}
