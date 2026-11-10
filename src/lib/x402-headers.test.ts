import { encodePaymentResponseHeader } from '@x402/core/http';
import { describe, expect, it } from 'vitest';
import { buildPaymentRequired } from './read-test-utils';
import { headerReader, paymentRequiredOf, settleResponseOf } from './x402-headers';

const TX = `0x${'ab'.repeat(32)}`;
const OTHER_TX = `0x${'cd'.repeat(32)}`;

function settle(transaction: string): string {
  return encodePaymentResponseHeader({
    success: true,
    transaction,
    network: 'eip155:8453',
  });
}

/** A case-insensitive lookup over `headers`, as `HttpResponse.header` is. */
function lookup(headers: Record<string, string>): (name: string) => string | undefined {
  const lowered = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return (name) => lowered.get(name.toLowerCase());
}

describe('settleResponseOf', () => {
  it.each([
    ['PAYMENT-RESPONSE', { 'PAYMENT-RESPONSE': settle(TX) }],
    ['X-PAYMENT-RESPONSE alone', { 'X-PAYMENT-RESPONSE': settle(TX) }],
    [
      'PAYMENT-RESPONSE over X-PAYMENT-RESPONSE',
      {
        'PAYMENT-RESPONSE': settle(TX),
        'X-PAYMENT-RESPONSE': settle(OTHER_TX),
      },
    ],
  ])('reads %s', (_label, headers) => {
    expect(settleResponseOf(headerReader, lookup(headers))?.transaction).toBe(TX);
  });

  // The SDK's own fall-through: an empty PAYMENT-RESPONSE is no header, so the
  // older X-PAYMENT-RESPONSE beside it is read.
  it('reads X-PAYMENT-RESPONSE beside an empty PAYMENT-RESPONSE', () => {
    const headers = lookup({ 'PAYMENT-RESPONSE': '', 'X-PAYMENT-RESPONSE': settle(TX) });
    expect(settleResponseOf(headerReader, headers)?.transaction).toBe(TX);
  });

  it.each([
    ['absent', {}],
    ['not base64 JSON', { 'PAYMENT-RESPONSE': 'not base64 json' }],
    ['a JSON array', { 'PAYMENT-RESPONSE': Buffer.from('[1]').toString('base64') }],
    ['JSON false', { 'PAYMENT-RESPONSE': Buffer.from('false').toString('base64') }],
  ])('is undefined, and never throws, when the header is %s', (_label, headers) => {
    expect(settleResponseOf(headerReader, lookup(headers))).toBeUndefined();
  });
});

describe('paymentRequiredOf', () => {
  const { header, paymentRequired } = buildPaymentRequired();

  it('reads the PAYMENT-REQUIRED header', () => {
    expect(paymentRequiredOf(headerReader, lookup({ 'PAYMENT-REQUIRED': header }))).toEqual(
      paymentRequired,
    );
  });
});
