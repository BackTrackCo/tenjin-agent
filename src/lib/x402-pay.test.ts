import { describe, it, expect } from 'vitest';
import { decodePaymentSignatureHeader } from '@x402/core/http';
import { verifyTypedData } from 'viem';
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

  // The signed authorization IS the money: assert its contents against the
  // requirement instead of trusting the reported amount (which is just an echo).
  it('signs an authorization whose value/to match the requirement and whose signature recovers', async () => {
    const signer = testSigner();
    const { paymentRequired } = buildPaymentRequired();
    const requirement = paymentRequired.accepts[0] as {
      asset: string;
      payTo: string;
      amount: string;
      extra?: { name?: string; version?: string };
    };
    const built = await buildExactPayment(paymentRequired, signer);
    const payload = decodePaymentSignatureHeader(built.headers['PAYMENT-SIGNATURE'] as string);
    const exact = payload.payload as {
      signature: `0x${string}`;
      authorization: {
        from: `0x${string}`;
        to: `0x${string}`;
        value: string;
        validAfter: string;
        validBefore: string;
        nonce: `0x${string}`;
      };
    };
    expect(exact.authorization.value).toBe(requirement.amount);
    expect(exact.authorization.to.toLowerCase()).toBe(requirement.payTo.toLowerCase());
    expect(exact.authorization.from.toLowerCase()).toBe(signer.address.toLowerCase());
    const valid = await verifyTypedData({
      address: signer.address,
      domain: {
        name: requirement.extra?.name as string,
        version: requirement.extra?.version as string,
        chainId: 8453,
        verifyingContract: requirement.asset as `0x${string}`,
      },
      types: {
        TransferWithAuthorization: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' },
        ],
      },
      primaryType: 'TransferWithAuthorization',
      message: {
        from: exact.authorization.from,
        to: exact.authorization.to,
        value: BigInt(exact.authorization.value),
        validAfter: BigInt(exact.authorization.validAfter),
        validBefore: BigInt(exact.authorization.validBefore),
        nonce: exact.authorization.nonce,
      },
      signature: exact.signature,
    });
    expect(valid).toBe(true);
  });

  // Asset/chain pinning: the wallet must never sign a bearer authorization for
  // an arbitrary chain or token a hostile 402 names.
  it('refuses a chain outside Base/Base Sepolia even for real USDC', async () => {
    const { paymentRequired } = buildPaymentRequired({
      network: 'eip155:1',
      asset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    });
    await expect(buildExactPayment(paymentRequired, testSigner())).rejects.toMatchObject({
      code: 'PAYMENT_FAILED',
      exitCode: 4,
    });
  });

  it('refuses a non-USDC asset on Base', async () => {
    const { paymentRequired } = buildPaymentRequired({
      asset: '0x1111111111111111111111111111111111111111',
    });
    await expect(buildExactPayment(paymentRequired, testSigner())).rejects.toMatchObject({
      code: 'PAYMENT_FAILED',
    });
  });

  it('accepts canonical USDC on Base Sepolia (preview deploys)', async () => {
    const { paymentRequired } = buildPaymentRequired({
      network: 'eip155:84532',
      asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    });
    const built = await buildExactPayment(paymentRequired, testSigner());
    expect(built.headers['PAYMENT-SIGNATURE']).toBeTypeOf('string');
  });

  it('accepts USDC given in a different hex case (checksum compare, not string compare)', async () => {
    const { paymentRequired } = buildPaymentRequired({
      asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    });
    const built = await buildExactPayment(paymentRequired, testSigner());
    expect(built.headers['PAYMENT-SIGNATURE']).toBeTypeOf('string');
  });
});
