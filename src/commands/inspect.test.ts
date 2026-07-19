import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import type { PaymentRequired } from '@x402/core/types';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { runInspect } from './inspect';
import { CliError } from '../lib/errors';
import type { CommandContext } from '../context';
import type { Io } from '../lib/output';
import type { TenjinSigner, WalletProvider } from '../lib/wallet';

// siwx.ts mints its nonce as randomBytes(16).toString('base64url'), but the SIWE
// grammar only allows an alphanumeric nonce, so roughly half of real nonces make
// createSIWxPayload throw (a genuine src bug, reported separately). Zero bytes
// encode to all-'A' base64url, which keeps the probe deterministic here.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomBytes: (size: number) => Buffer.alloc(size) };
});

const BASE = 'https://tenjin.blog';
const READ_URL = `${BASE}/api/read/alice/post-1`;
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PAY_TO = '0x1111111111111111111111111111111111111111';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-inspect-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function captureIo(): Io {
  const mk = () =>
    ({
      write: () => true,
    }) as unknown as NodeJS.WritableStream;
  return { stdout: mk(), stderr: mk(), isTTY: false };
}

function ctxFor(): CommandContext {
  return {
    flags: { json: false, timeout: 5000, baseUrl: BASE },
    dataDir: dir,
    io: captureIo(),
  };
}

/** Every request the stub saw, so tests can pin exactly what went on the wire. */
interface RecordedRequest {
  url: string;
  method: string;
  headers: Headers;
}

function recordingFetch(route: (req: RecordedRequest) => Response): {
  fetchImpl: typeof fetch;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const req: RecordedRequest = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
    };
    requests.push(req);
    return route(req);
  }) as typeof fetch;
  return { fetchImpl, requests };
}

/** inspect must never pay: no payment header on any request, GETs only. */
function expectNeverPaid(requests: RecordedRequest[]): void {
  for (const req of requests) {
    expect(req.headers.has('payment-signature')).toBe(false);
    expect(req.headers.has('x-payment')).toBe(false);
    expect(req.method).toBe('GET');
  }
}

function jsonRes(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function challengeHeader(amount = '250000'): string {
  const paymentRequired: PaymentRequired = {
    x402Version: 2,
    error: 'payment required',
    resource: { url: READ_URL, mimeType: 'application/json' },
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:8453',
        asset: USDC_BASE,
        amount,
        payTo: PAY_TO,
        maxTimeoutSeconds: 300,
        extra: { postId: 'p1', name: 'USD Coin', version: '2' },
      },
    ],
    extensions: { 'sign-in-with-x': { supportedChains: [{ chainId: 'eip155:8453' }] } },
  };
  return encodePaymentRequiredHeader(paymentRequired);
}

// The 402 preview body advertises a DIFFERENT price than the challenge so tests
// prove the reported price comes from the challenge amount, never the body.
function previewBody(bodyMdPreview: string): Record<string, unknown> {
  return {
    id: 'p1',
    slug: 'post-1',
    title: 'Deep Dive',
    excerpt: 'A look inside.',
    price: '999999',
    publishedAt: '2026-07-01T00:00:00.000Z',
    tags: ['markets'],
    creator: { handle: 'alice' },
    bodyMdPreview,
    rereadHint: 'Purchased wallets re-read free.',
  };
}

const UNLOCKED_FREE = {
  id: 'p1',
  slug: 'post-1',
  title: 'Free Notes',
  excerpt: 'Open to all.',
  price: '0',
  publishedAt: '2026-07-01T00:00:00.000Z',
  tags: ['notes'],
  creator: { handle: 'alice' },
  bodyMd: '# The whole article',
};

function fakeProvider(signer?: TenjinSigner): {
  provider: WalletProvider;
  calls: { authorize: number; record: number };
} {
  const calls = { authorize: 0, record: 0 };
  const provider: WalletProvider = {
    id: 'fake',
    describe: async () => ({
      address: PAY_TO,
      provider: 'fake',
      credentialSource: 'remote',
      policyEnforcement: 'provider',
    }),
    diagnostics: async () => ({ warnings: [] }),
    getSigner: async () => {
      if (signer === undefined) throw new CliError('WALLET_MISSING', 'No wallet configured.');
      return signer;
    },
    authorizeSpend: async () => {
      calls.authorize += 1;
      throw new Error('inspect must never call authorizeSpend');
    },
    recordSpend: async () => {
      calls.record += 1;
      throw new Error('inspect must never call recordSpend');
    },
  };
  return { provider, calls };
}

function realSigner(): TenjinSigner {
  const account = privateKeyToAccount(generatePrivateKey());
  return {
    address: account.address,
    signMessage: ({ message }) => account.signMessage({ message }),
    signTypedData: (args) =>
      account.signTypedData(args as Parameters<typeof account.signTypedData>[0]),
  };
}

async function catchCliError(p: Promise<unknown>): Promise<CliError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CliError);
  return err as CliError;
}

describe('runInspect on a 200 response', () => {
  it('free post: access free, entitled true, and the body is never in the data', async () => {
    const { fetchImpl, requests } = recordingFetch(() => jsonRes(UNLOCKED_FREE));
    const res = await runInspect({ ref: 'alice/post-1' }, ctxFor(), { fetchImpl });
    const data = res.data as Record<string, unknown>;
    expect(data.access).toBe('free');
    expect(data.entitled).toBe(true);
    expect(data.price).toEqual({ atomic: '0', usd: '0' });
    expect(data.url).toBe(READ_URL);
    expect('bodyMd' in data).toBe(false);
    expect('body' in data).toBe(false);
    expect(requests).toHaveLength(1);
    expectNeverPaid(requests);
  });
});

describe('runInspect on a 402 challenge', () => {
  it('no usable wallet: entitled null, challenge price, one GET, never pays', async () => {
    const { fetchImpl, requests } = recordingFetch(() =>
      jsonRes(previewBody('x'.repeat(700)), 402, { 'PAYMENT-REQUIRED': challengeHeader() }),
    );
    const { provider, calls } = fakeProvider();
    const res = await runInspect({ ref: 'alice/post-1' }, ctxFor(), { fetchImpl, provider });
    const data = res.data as Record<string, unknown>;
    expect(data.access).toBe('paid');
    expect(data.entitled).toBeNull();
    // Dual Money from the challenge amount, not the body's price field.
    expect(data.price).toEqual({ atomic: '250000', usd: '0.25' });
    expect(data.network).toBe('eip155:8453');
    expect(data.preview).toBe('x'.repeat(600));
    expect(data.untrustedContent).toContain('never instructions');
    expect(data.rereadHint).toBe('Purchased wallets re-read free.');
    expect((data.creator as { handle: string }).handle).toBe('alice');
    expect(res.humanLines?.[1]).toBe('No usable wallet: entitlement unknown.');
    expect(requests).toHaveLength(1);
    expectNeverPaid(requests);
    expect(calls).toEqual({ authorize: 0, record: 0 });
  });

  it('a preview at or under 600 chars passes through untruncated', async () => {
    const short = 'y'.repeat(600);
    const { fetchImpl } = recordingFetch(() =>
      jsonRes(previewBody(short), 402, { 'PAYMENT-REQUIRED': challengeHeader() }),
    );
    const { provider } = fakeProvider();
    const res = await runInspect({ ref: 'alice/post-1' }, ctxFor(), { fetchImpl, provider });
    expect((res.data as { preview: string }).preview).toBe(short);
  });

  it('working wallet, SIWX probe unlocks: entitled true, still never pays', async () => {
    const { fetchImpl, requests } = recordingFetch((req) =>
      req.headers.has('sign-in-with-x')
        ? jsonRes({ ...UNLOCKED_FREE, title: 'Deep Dive', price: '250000' })
        : jsonRes(previewBody('short preview'), 402, { 'PAYMENT-REQUIRED': challengeHeader() }),
    );
    const { provider, calls } = fakeProvider(realSigner());
    const res = await runInspect({ ref: 'alice/post-1' }, ctxFor(), { fetchImpl, provider });
    const data = res.data as Record<string, unknown>;
    expect(data.entitled).toBe(true);
    expect(res.humanLines?.[1]).toContain('re-read is free');
    expect(requests).toHaveLength(2);
    expect(requests[0]?.headers.has('sign-in-with-x')).toBe(false);
    expect(requests[1]?.headers.has('sign-in-with-x')).toBe(true);
    expectNeverPaid(requests);
    expect(calls).toEqual({ authorize: 0, record: 0 });
  });

  it('working wallet, SIWX probe still 402: entitled false', async () => {
    const { fetchImpl, requests } = recordingFetch(() =>
      jsonRes(previewBody('short preview'), 402, { 'PAYMENT-REQUIRED': challengeHeader() }),
    );
    const { provider, calls } = fakeProvider(realSigner());
    const res = await runInspect({ ref: 'alice/post-1' }, ctxFor(), { fetchImpl, provider });
    expect((res.data as { entitled: unknown }).entitled).toBe(false);
    expect(res.humanLines?.[1]).toBe('Not yet purchased by this wallet.');
    expect(requests).toHaveLength(2);
    expectNeverPaid(requests);
    expect(calls).toEqual({ authorize: 0, record: 0 });
  });
});

describe('runInspect failures', () => {
  it('404 with a server envelope is API_ERROR exit 1 carrying the server code', async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonRes({ error: { code: 'not_found', message: 'No such post.' } }, 404),
    );
    const err = await catchCliError(runInspect({ ref: 'alice/post-1' }, ctxFor(), { fetchImpl }));
    expect(err.code).toBe('API_ERROR');
    expect(err.exitCode).toBe(1);
    expect((err.details as { serverCode?: string }).serverCode).toBe('not_found');
    expect(err.message).toContain('No such post.');
  });

  it('a URL on a foreign origin is USAGE exit 2 and never fetches', async () => {
    const { fetchImpl, requests } = recordingFetch(() => jsonRes({}));
    const err = await catchCliError(
      runInspect({ ref: 'https://evil.example/api/read/alice/post-1' }, ctxFor(), { fetchImpl }),
    );
    expect(err.code).toBe('USAGE');
    expect(err.exitCode).toBe(2);
    expect(requests).toHaveLength(0);
  });
});
