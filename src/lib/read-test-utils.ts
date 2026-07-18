import { privateKeyToAccount } from 'viem/accounts';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import type { PaymentRequired } from '@x402/core/types';
import type { TenjinSigner, WalletProvider } from './wallet/provider';

/** Shared B2 test fixtures: a real (offline) viem signer, a fake wallet provider
 *  around it, and a header-aware mock of the read route. Not bundled into dist
 *  (nothing in the entry graph imports it), same pattern as wallet/test-support. */

// A well-known Anvil/hardhat test key; deterministic, holds no real funds.
export const TEST_PRIVATE_KEY =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

export function testSigner(): TenjinSigner {
  const account = privateKeyToAccount(TEST_PRIVATE_KEY);
  return {
    address: account.address,
    signMessage: (args) => account.signMessage({ message: args.message }),
    signTypedData: (args) => account.signTypedData(args),
  };
}

export function testWalletProvider(signer: TenjinSigner = testSigner()): WalletProvider {
  return {
    id: 'local',
    describe: async () => ({
      address: signer.address,
      provider: 'local',
      credentialSource: 'file',
      policyEnforcement: 'client-only',
    }),
    getSigner: async () => signer,
    diagnostics: async () => ({ warnings: [] }),
  };
}

export interface PaymentRequiredFixture {
  header: string;
  paymentRequired: PaymentRequired;
}

export function buildPaymentRequired(
  over: Partial<PaymentRequired['accepts'][number]> = {},
): PaymentRequiredFixture {
  const paymentRequired: PaymentRequired = {
    x402Version: 2,
    resource: {
      url: 'https://tenjin.blog/api/read/iris/slug',
      description: 'A paid resource',
      mimeType: 'application/json',
    },
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:8453',
        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        amount: '100000',
        payTo: '0x1111111111111111111111111111111111111111',
        maxTimeoutSeconds: 300,
        extra: { name: 'USD Coin', version: '2' },
        ...over,
      },
    ],
  };
  return { header: encodePaymentRequiredHeader(paymentRequired), paymentRequired };
}

export interface ReadBodyFixture {
  id: string;
  slug: string;
  title: string;
  bodyMd: string;
  price: string;
  creator: { handle: string; walletAddress: string };
}

export function readBody(over: Partial<ReadBodyFixture> = {}): ReadBodyFixture {
  return {
    id: '0197aaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    slug: 'slug',
    title: 'The Answer',
    bodyMd: '# The Answer\n\nfull body\n',
    price: '100000',
    creator: { handle: 'iris', walletAddress: '0x2222222222222222222222222222222222222222' },
    ...over,
  };
}

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export const reply = {
  entitled: (body: ReadBodyFixture, settlementHeader?: string): Response =>
    jsonResponse(
      200,
      body,
      settlementHeader !== undefined ? { 'PAYMENT-RESPONSE': settlementHeader } : {},
    ),
  paymentRequired: (
    fixture: PaymentRequiredFixture,
    preview: unknown = { title: 'The Answer', price: '100000', creator: { handle: 'iris' } },
  ): Response => jsonResponse(402, preview, { 'PAYMENT-REQUIRED': fixture.header }),
  alreadyPurchased: (): Response =>
    jsonResponse(409, { code: 'already_purchased', message: 'Already purchased.' }),
};

export type ReadPhase = 'plain' | 'siwx' | 'payment';

export interface RecordedCall {
  url: string;
  phase: ReadPhase;
  headers: Record<string, string>;
}

/**
 * A read-route mock that classifies each request by its headers, a
 * PAYMENT-SIGNATURE is a `payment` attempt, a SIGN-IN-WITH-X is a `siwx`
 * re-check, otherwise a plain GET, and returns the configured Response for that
 * phase. Records every call so a test can assert the exact ORDER of attempts and
 * that (e.g.) a payment was never attempted.
 */
export function makeReadServer(config: {
  plain: () => Response;
  siwx?: () => Response;
  payment?: () => Response;
}): { fetch: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = normalizeHeaders(init?.headers);
    const phase: ReadPhase =
      headers['payment-signature'] !== undefined
        ? 'payment'
        : headers['sign-in-with-x'] !== undefined
          ? 'siwx'
          : 'plain';
    calls.push({ url: String(url), phase, headers });
    const handler =
      phase === 'payment' ? config.payment : phase === 'siwx' ? config.siwx : config.plain;
    if (handler === undefined) throw new Error(`no mock configured for phase ${phase}`);
    return handler();
  }) as unknown as typeof fetch;
  return { fetch: fn, calls };
}

function normalizeHeaders(headers: RequestInit['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers === undefined) return out;
  if (headers instanceof Headers) {
    headers.forEach((v, k) => (out[k.toLowerCase()] = v));
  } else if (Array.isArray(headers)) {
    for (const [k, v] of headers) out[k.toLowerCase()] = v;
  } else {
    for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = String(v);
  }
  return out;
}
