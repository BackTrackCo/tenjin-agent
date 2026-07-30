import { webcrypto } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import type { PaymentRequired } from '@x402/core/types';
import type { SessionFile } from './session-present';
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
    signTransaction: (tx) => account.signTransaction(tx),
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

/**
 * A REAL P-256 session file (generated, not canned), plus its public key so a
 * test can verify the signature the CLI produced rather than only its shape.
 * Defaults to a live 1h `read` session bound to the test signer's address.
 */
export async function testSessionKey(
  over: Partial<SessionFile> = {},
): Promise<{ file: SessionFile; publicKey: webcrypto.CryptoKey }> {
  const subtle = webcrypto.subtle;
  const pair = (await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as webcrypto.CryptoKeyPair;
  const rawPub = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  const jwk = (await subtle.exportKey('jwk', pair.privateKey)) as Record<string, unknown>;
  return {
    file: {
      address: testSigner().address.toLowerCase(),
      delegation: 'DELEGATION',
      exp: new Date(Date.now() + 3_600_000).toISOString(),
      scope: 'read',
      publicKeyRaw: Buffer.from(rawPub).toString('base64url'),
      privateKeyJwk: jwk,
      ...over,
    },
    publicKey: pair.publicKey,
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

/** The public answer card the 402 body carries when the piece has one. Every
 *  field is present (nullable ones as null), the way the server projects it. */
export function previewCard(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    artifactType: 'document',
    temporalMode: 'snapshot',
    asOf: '2026-07-01T00:00:00.000Z',
    validUntil: '2026-08-01T00:00:00.000Z',
    questionsAnswered: ['What does a Base transaction cost?'],
    tasksSupported: ['estimate gas spend'],
    appliesTo: { products: ['Base'] },
    scope: 'L2 execution fees only',
    exclusions: 'No L1 data costs',
    provenanceSummary: 'Measured against mainnet over one week',
    methodologySummary: 'Sampled every block for seven days',
    maintenanceCadence: 'monthly',
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
  /** A 401 rejecting the presented delegation (expired, revoked, unbound). */
  sessionRejected: (code = 'session_expired'): Response =>
    jsonResponse(401, { code, message: 'The session delegation is not valid.' }),
};

export type ReadPhase = 'plain' | 'siwx' | 'session' | 'payment';

export interface RecordedCall {
  url: string;
  phase: ReadPhase;
  headers: Record<string, string>;
}

/**
 * A read-route mock that classifies each request by its headers: a
 * PAYMENT-SIGNATURE is a `payment` attempt, a SIGN-IN-WITH-X is a `siwx`
 * re-check, a Tenjin-Session-Delegation is a `session` presentation, otherwise a
 * plain GET — and returns the configured Response for that phase. Records every
 * call so a test can assert the exact ORDER of attempts and that (e.g.) a payment
 * was never attempted.
 *
 * An unconfigured phase THROWS rather than falling back, which is what makes an
 * absent phase a real assertion: a test that pins `['plain']` would otherwise
 * pass just as well against a mock that quietly served the second request.
 */
export function makeReadServer(config: {
  plain: () => Response;
  siwx?: () => Response;
  session?: () => Response;
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
          : headers['tenjin-session-delegation'] !== undefined
            ? 'session'
            : 'plain';
    calls.push({ url: String(url), phase, headers });
    const handler =
      phase === 'payment'
        ? config.payment
        : phase === 'siwx'
          ? config.siwx
          : phase === 'session'
            ? config.session
            : config.plain;
    if (handler === undefined) throw new Error(`no mock configured for phase ${phase}`);
    return handler();
  }) as unknown as typeof fetch;
  return { fetch: fn, calls };
}

/**
 * Wrap a read-route mock in the trailing-slash canonicalization the real route
 * performs: a request whose path ends in `/` gets a 308 to the no-slash form and
 * is NEVER answered with content. Requests already in canonical form pass through
 * to `inner` untouched, so the wrapped mock records only the calls that were
 * actually served.
 *
 * This is what makes the trailing-slash tests able to fail. `fetchRead` pins
 * `blockRedirects`, so a caller that sends the slashed spelling gets a hard
 * CONTRACT_MISMATCH at the first probe instead of the piece.
 */
export function withTrailingSlashRedirect(inner: typeof fetch): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(typeof input === 'object' && 'url' in input ? input.url : input);
    const path = url.split(/[?#]/)[0] ?? url;
    if (path.endsWith('/')) {
      return new Response('', { status: 308, headers: { location: path.slice(0, -1) } });
    }
    return await inner(input as Parameters<typeof fetch>[0], init);
  }) as unknown as typeof fetch;
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
