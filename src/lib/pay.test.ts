import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { verifyTypedData } from 'viem';
import {
  encodePaymentRequiredHeader,
  decodePaymentSignatureHeader,
  encodePaymentResponseHeader,
} from '@x402/core/http';
import type { PaymentRequired, SettleResponse } from '@x402/core/types';
import {
  decodeChallenge,
  buildPaymentHeader,
  decodeSettlement,
  USDC_BY_NETWORK,
  type DecodedChallenge,
} from './pay';
import { CliError } from './errors';
import type { TenjinSigner } from './wallet/provider';

const TEST_KEY = `0x${'cd'.repeat(32)}` as const;
const account = privateKeyToAccount(TEST_KEY);
const signer: TenjinSigner = {
  address: account.address,
  signMessage: (args) => account.signMessage({ message: args.message }),
  signTypedData: (args) => account.signTypedData(args),
};

const NETWORK = 'eip155:8453';
// Known-present key in the pinned constant; non-null since this test targets a
// network the module actually supports.
const USDC = USDC_BY_NETWORK[NETWORK]!;
const PAY_TO = `0x${'11'.repeat(20)}` as const;
const POST_ID = randomUUID();

interface AcceptOverrides {
  scheme?: string;
  network?: string;
  asset?: string;
  amount?: string;
  payTo?: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
}

function accept(overrides: AcceptOverrides = {}) {
  return {
    scheme: 'exact',
    network: NETWORK,
    asset: USDC,
    amount: '250000',
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
    extra: { name: 'USD Coin', version: '2', postId: POST_ID },
    ...overrides,
  };
}

/** Builds and base64-encodes a v2 PAYMENT-REQUIRED header, one accept entry by default. */
function challengeHeader(
  opts: {
    x402Version?: number;
    accepts?: ReturnType<typeof accept>[];
    siwx?: boolean;
    error?: string;
  } = {},
): string {
  const paymentRequired = {
    x402Version: opts.x402Version ?? 2,
    resource: { url: `https://tenjin.blog/api/articles/${POST_ID}` },
    accepts: opts.accepts ?? [accept()],
    ...(opts.error !== undefined ? { error: opts.error } : {}),
    ...(opts.siwx === false
      ? {}
      : {
          extensions: {
            'sign-in-with-x': {
              info: {
                domain: 'tenjin.blog',
                uri: 'https://tenjin.blog',
                version: '1',
                nonce: 'server-nonce',
                issuedAt: new Date().toISOString(),
              },
              supportedChains: [{ chainId: NETWORK, type: 'eip191' }],
            },
          },
        }),
  };
  return encodePaymentRequiredHeader(paymentRequired as unknown as PaymentRequired);
}

async function catchAsync(fn: () => Promise<unknown>): Promise<CliError> {
  const err = await fn().catch((e: unknown) => e);
  expect(err).toBeInstanceOf(CliError);
  return err as CliError;
}

function caught(fn: () => unknown): CliError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(CliError);
    return e as CliError;
  }
  throw new Error('expected decodeChallenge to throw');
}

describe('decodeChallenge', () => {
  it('happy path extracts amount/network/asset/payTo/postId/siwxChainId', () => {
    const decoded = decodeChallenge(challengeHeader());
    expect(decoded.amountAtomic).toBe('250000');
    expect(decoded.network).toBe(NETWORK);
    expect(decoded.asset.toLowerCase()).toBe(USDC.toLowerCase());
    expect(decoded.payTo).toBe(PAY_TO);
    expect(decoded.postId).toBe(POST_ID);
    expect(decoded.siwxChainId).toBe(NETWORK);
    expect(decoded.error).toBeNull();
  });

  it('carries a server-side error string through when the challenge was re-served on a verify failure', () => {
    const decoded = decodeChallenge(challengeHeader({ error: 'insufficient_funds' }));
    expect(decoded.error).toBe('insufficient_funds');
  });

  it('reports a null postId and siwxChainId when the challenge omits them', () => {
    const decoded = decodeChallenge(
      challengeHeader({ accepts: [accept({ extra: {} })], siwx: false }),
    );
    expect(decoded.postId).toBeNull();
    expect(decoded.siwxChainId).toBeNull();
  });

  it('x402Version 1 is CONTRACT_MISMATCH', () => {
    const err = caught(() => decodeChallenge(challengeHeader({ x402Version: 1 })));
    expect(err.code).toBe('CONTRACT_MISMATCH');
  });

  it('no exact-scheme EVM accept is CONTRACT_MISMATCH', () => {
    const err = caught(() =>
      decodeChallenge(challengeHeader({ accepts: [accept({ scheme: 'upto' })] })),
    );
    expect(err.code).toBe('CONTRACT_MISMATCH');
  });

  it('an empty accepts array is CONTRACT_MISMATCH', () => {
    const err = caught(() => decodeChallenge(challengeHeader({ accepts: [] })));
    expect(err.code).toBe('CONTRACT_MISMATCH');
  });

  it('a non-eip155 network is CONTRACT_MISMATCH', () => {
    const err = caught(() =>
      decodeChallenge(
        challengeHeader({
          accepts: [accept({ network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' })],
        }),
      ),
    );
    expect(err.code).toBe('CONTRACT_MISMATCH');
  });

  it('an asset address that does not match the pinned USDC constant is CONTRACT_MISMATCH', () => {
    const err = caught(() =>
      decodeChallenge(challengeHeader({ accepts: [accept({ asset: `0x${'22'.repeat(20)}` })] })),
    );
    expect(err.code).toBe('CONTRACT_MISMATCH');
  });

  it('a non-integer amount string is CONTRACT_MISMATCH', () => {
    const err = caught(() =>
      decodeChallenge(challengeHeader({ accepts: [accept({ amount: '250000.5' })] })),
    );
    expect(err.code).toBe('CONTRACT_MISMATCH');
  });
});

describe('buildPaymentHeader', () => {
  it('signs an EIP-3009 authorization matching the challenge, verifiable via EIP-712', async () => {
    const decoded = decodeChallenge(challengeHeader());
    const header = await buildPaymentHeader(signer, decoded);
    const decodedPayload = decodePaymentSignatureHeader(header) as unknown as {
      payload: {
        authorization: {
          from: string;
          to: string;
          value: string;
          validAfter: string;
          validBefore: string;
          nonce: string;
        };
        signature: `0x${string}`;
      };
    };
    const auth = decodedPayload.payload.authorization;
    expect(auth.value).toBe('250000');
    expect(auth.from.toLowerCase()).toBe(signer.address.toLowerCase());
    expect(auth.to.toLowerCase()).toBe(PAY_TO.toLowerCase());
    expect(auth.nonce).toMatch(/^0x[0-9a-fA-F]{64}$/);

    const valid = await verifyTypedData({
      address: signer.address,
      domain: {
        name: 'USD Coin',
        version: '2',
        chainId: 8453,
        verifyingContract: USDC as `0x${string}`,
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
        from: auth.from as `0x${string}`,
        to: auth.to as `0x${string}`,
        value: BigInt(auth.value),
        validAfter: BigInt(auth.validAfter),
        validBefore: BigInt(auth.validBefore),
        nonce: auth.nonce as `0x${string}`,
      },
      signature: decodedPayload.payload.signature,
    });
    expect(valid).toBe(true);
  });

  it('wraps a scheme construction failure (missing EIP-712 domain params) as PAYMENT_FAILED', async () => {
    const decoded: DecodedChallenge = decodeChallenge(
      challengeHeader({ accepts: [accept({ extra: { postId: POST_ID } })] }),
    );
    const err = await catchAsync(() => buildPaymentHeader(signer, decoded));
    expect(err.code).toBe('PAYMENT_FAILED');
  });
});

describe('decodeSettlement', () => {
  it('a valid header extracts success, txHash, and network', () => {
    const txHash = `0x${'ab'.repeat(32)}`;
    const header = encodePaymentResponseHeader({
      success: true,
      transaction: txHash,
      network: NETWORK,
      payer: signer.address,
    } as unknown as SettleResponse);
    expect(decodeSettlement(header)).toEqual({ success: true, txHash, network: NETWORK });
  });

  it('a malformed transaction hash decodes to a null txHash, other fields still reported', () => {
    const header = encodePaymentResponseHeader({
      success: true,
      transaction: '0xnothex',
      network: NETWORK,
    } as unknown as SettleResponse);
    expect(decodeSettlement(header)).toEqual({ success: true, txHash: null, network: NETWORK });
  });

  it('a garbage header decodes to failure with everything null', () => {
    expect(decodeSettlement('not-base64-garbage!!!')).toEqual({
      success: false,
      txHash: null,
      network: null,
    });
  });
});
