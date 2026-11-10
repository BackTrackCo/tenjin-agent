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

  // KEPT DIFFERENCE: the SDK reads X-PAYMENT-RESPONSE when PAYMENT-RESPONSE is
  // empty. This CLI never did, so an empty v2 header cannot name a settlement
  // from a v1 header beside it.
  it('reads nothing from a v1 header beside an empty v2 one, where the SDK would', () => {
    const headers = lookup({ 'PAYMENT-RESPONSE': '', 'X-PAYMENT-RESPONSE': settle(TX) });
    expect(headerReader.getPaymentSettleResponse(headers).transaction).toBe(TX);
    expect(settleResponseOf(headerReader, headers)).toBeUndefined();
  });

  // KEPT DIFFERENCE: a v2 header over the bound ends the read too.
  it('reads nothing from a v1 header within the bound beside an oversized v2 one', () => {
    const v1 = settle(OTHER_TX);
    const v2 = encodePaymentResponseHeader({
      success: true,
      transaction: TX,
      network: 'eip155:8453',
      payer: `0x${'ef'.repeat(20)}`,
    });
    expect(v2.length).toBeGreaterThan(v1.length);
    const headers = lookup({ 'PAYMENT-RESPONSE': v2, 'X-PAYMENT-RESPONSE': v1 });
    expect(settleResponseOf(headerReader, headers, v1.length)).toBeUndefined();
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

  it('is undefined for a header over the bound', () => {
    expect(
      paymentRequiredOf(headerReader, lookup({ 'PAYMENT-REQUIRED': header }), header.length - 1),
    ).toBeUndefined();
  });
});
