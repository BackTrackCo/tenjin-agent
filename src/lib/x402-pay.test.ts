import { describe, it, expect } from 'vitest';
import { decodePaymentSignatureHeader } from '@x402/core/http';
import { buildExactPayment } from './x402-pay';
import { buildPaymentRequired, testSigner } from './read-test-utils';

describe('buildExactPayment', () => {
  it('builds a PAYMENT-SIGNATURE header offline and reports the exact amount', async () => {
    const { paymentRequired } = buildPaymentRequired();
    const built = await buildExactPayment(paymentRequired, testSigner());
    expect(built.amountAtomic).toBe(100_000n);
    expect(built.headers['PAYMENT-SIGNATURE']).toBeTypeOf('string');
    // The header round-trips through the x402 decoder to a payload for this scheme.
    const payload = decodePaymentSignatureHeader(built.headers['PAYMENT-SIGNATURE'] as string);
    expect(payload.accepted.scheme).toBe('exact');
    expect(payload.x402Version).toBe(2);
  });

  it('refuses a non-exact scheme with PAYMENT_FAILED', async () => {
    const { paymentRequired } = buildPaymentRequired({ scheme: 'upto' });
    await expect(buildExactPayment(paymentRequired, testSigner())).rejects.toMatchObject({
      code: 'PAYMENT_FAILED',
    });
  });
});
