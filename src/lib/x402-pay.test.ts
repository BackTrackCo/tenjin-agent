import { describe, it, expect, vi } from 'vitest';
import { decodePaymentSignatureHeader } from '@x402/core/http';
import { verifyTypedData } from 'viem';
import { buildExactPayment, TENJIN_CLI_BUILDER_CODE } from './x402-pay';
import { buildPaymentRequired, testSigner, withBuilderCode } from './read-test-utils';

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

  // The SDK's own per-payment cap (2.23+, $1 by default) would refuse a manual
  // payment the user consented to above it; the cap is set to the amount the
  // spend policy already authorized, so the SDK enforces exactly that amount.
  it('signs an authorized amount above the SDK default $1 cap, and only that amount', async () => {
    const { paymentRequired } = buildPaymentRequired({ amount: '2500000' });
    const built = await buildExactPayment(paymentRequired, testSigner());
    expect(built.amountAtomic).toBe(2_500_000n);
    const payload = decodePaymentSignatureHeader(built.headers['PAYMENT-SIGNATURE'] as string);
    expect((payload.payload as { authorization: { value: string } }).authorization.value).toBe(
      '2500000',
    );
  });

  // The SDK signs a Permit2 transfer when the entry asks for one, and it
  // cannot settle without a Permit2 allowance this CLI never sets.
  it.each(['permit2', 'something-else'])(
    'refuses an entry whose transfer method is %s, signing nothing',
    async (assetTransferMethod) => {
      const { paymentRequired } = buildPaymentRequired({
        extra: { name: 'USD Coin', version: '2', assetTransferMethod },
      });
      const signer = testSigner();
      const signTypedData = vi.spyOn(signer, 'signTypedData');
      const refused = buildExactPayment(paymentRequired, signer);
      await expect(refused).rejects.toMatchObject({ code: 'PAYMENT_FAILED' });
      if (assetTransferMethod === 'permit2') {
        await expect(refused).rejects.toMatchObject({
          message: expect.stringContaining('Permit2'),
          details: { reason: 'permit2' },
        });
      }
      expect(signTypedData).not.toHaveBeenCalled();
    },
  );

  it('signs an entry that names EIP-3009, as one that names no method', async () => {
    const { paymentRequired } = buildPaymentRequired({
      extra: { name: 'USD Coin', version: '2', assetTransferMethod: 'eip3009' },
    });
    const built = await buildExactPayment(paymentRequired, testSigner());
    expect(built.authorization).toBeDefined();
  });

  // Who paid comes from the signer, so a payload of any shape still names it;
  // the chain read later targets the network and token it was signed on.
  it('records the signing wallet, and the network and asset the authorization is for', async () => {
    const signer = testSigner();
    const { paymentRequired } = buildPaymentRequired({
      network: 'eip155:84532',
      asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    });
    const built = await buildExactPayment(paymentRequired, signer);
    expect(built.payer).toBe(signer.address);
    expect(built.authorization).toMatchObject({
      from: signer.address,
      network: 'eip155:84532',
      asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    });
  });

  it('accepts USDC given in a different hex case (checksum compare, not string compare)', async () => {
    const { paymentRequired } = buildPaymentRequired({
      asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    });
    const built = await buildExactPayment(paymentRequired, testSigner());
    expect(built.headers['PAYMENT-SIGNATURE']).toBeTypeOf('string');
  });
});

describe('buildExactPayment, builder-code attribution', () => {
  it('carries the client service code when the 402 advertises builder-code', async () => {
    // A foreign seller's own code, so the two Schema 2 roles are visibly
    // distinct: `a` is whoever exposed the endpoint, `s` is who brokered it.
    const { paymentRequired } = buildPaymentRequired({}, withBuilderCode('bc_seller01'));
    const built = await buildExactPayment(paymentRequired, testSigner());
    const payload = decodePaymentSignatureHeader(built.headers['PAYMENT-SIGNATURE'] as string);
    const info = builderCodeInfo(payload.extensions);
    expect(info?.s).toEqual([TENJIN_CLI_BUILDER_CODE]);
    // The seller's own app code survives the merge: `s` adds to `a`, never replaces it.
    expect(info?.a).toBe('bc_seller01');
  });

  // Against Tenjin's own 402 the one registered code lands in both roles; the
  // suffix still says which side each occurrence came from.
  it('fills both roles with the one code when Tenjin is also the seller', async () => {
    const { paymentRequired } = buildPaymentRequired({}, withBuilderCode());
    const built = await buildExactPayment(paymentRequired, testSigner());
    const payload = decodePaymentSignatureHeader(built.headers['PAYMENT-SIGNATURE'] as string);
    const info = builderCodeInfo(payload.extensions);
    expect(info?.a).toBe(TENJIN_CLI_BUILDER_CODE);
    expect(info?.s).toEqual([TENJIN_CLI_BUILDER_CODE]);
  });

  // REGRESSION PIN. The SDK merges the enriched payload onto the server's
  // extensions as the base and copies a client field only where the server left
  // it unset, so before the strip a seller that declared its own `info.s` kept
  // it and Tenjin's code vanished with no error. Any 402 can do this, so this is
  // the foreign-seller lane, not only the hostile one.
  it('keeps Tenjin as the only client code when the seller declares its own `s`', async () => {
    const { paymentRequired } = buildPaymentRequired(
      {},
      withBuilderCode('bc_seller01', ['bc_attacker']),
    );
    const built = await buildExactPayment(paymentRequired, testSigner());
    const payload = decodePaymentSignatureHeader(built.headers['PAYMENT-SIGNATURE'] as string);
    const info = builderCodeInfo(payload.extensions);
    expect(info?.s).toEqual([TENJIN_CLI_BUILDER_CODE]);
    // `a` is the seller's own field and still rides untouched.
    expect(info?.a).toBe('bc_seller01');
  });

  // The SDK's default since @x402/core 2.21: every registered client extension
  // enriches every payment, so a seller that never advertised builder-code
  // still gets Tenjin's service code, and no seller field.
  it("sends the SDK's builder-code entry to a seller that never advertised one", async () => {
    const { paymentRequired } = buildPaymentRequired();
    const built = await buildExactPayment(paymentRequired, testSigner());
    const payload = decodePaymentSignatureHeader(built.headers['PAYMENT-SIGNATURE'] as string);
    expect(builderCodeInfo(payload.extensions)).toEqual({ s: [TENJIN_CLI_BUILDER_CODE] });
  });

  // Attribution is metadata, not terms: what the wallet authorizes must be
  // identical whether or not the seller asked for a builder code.
  it('leaves the authorized terms identical with and without the extension', async () => {
    const signer = testSigner();
    const plain = await buildExactPayment(buildPaymentRequired().paymentRequired, signer);
    const attributed = await buildExactPayment(
      buildPaymentRequired({}, withBuilderCode()).paymentRequired,
      signer,
    );
    expect(attributed.amountAtomic).toBe(plain.amountAtomic);
    const a = decodePaymentSignatureHeader(attributed.headers['PAYMENT-SIGNATURE'] as string);
    const p = decodePaymentSignatureHeader(plain.headers['PAYMENT-SIGNATURE'] as string);
    expect(a.accepted).toEqual(p.accepted);
    // nonce and the validity window are fresh per signature by design, so the
    // comparable terms are who pays whom, how much, and on what.
    const auth = (x: typeof a): Record<string, unknown> => {
      const { authorization } = x.payload as { authorization: Record<string, unknown> };
      return {
        from: authorization.from,
        to: authorization.to,
        value: authorization.value,
      };
    };
    expect(auth(a)).toEqual(auth(p));
  });
});

/** The merged `builder-code` extension info as it rides the payload, or undefined. */
function builderCodeInfo(extensions: unknown): { a?: string; s?: string[] | string } | undefined {
  const entry = (extensions as Record<string, { info?: unknown }> | undefined)?.['builder-code'];
  return entry?.info as { a?: string; s?: string[] | string } | undefined;
}
