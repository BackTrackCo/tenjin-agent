import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { PrivateKeyAccount } from 'viem';
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from '@x402/core/http';
import { runBuy } from './buy';
import type { BuyArgs, BuyDeps } from './buy';
import { CliError } from '../lib/errors';
import { recordLookup } from '../lib/state';
import type { CommandContext } from '../context';
import type { Io } from '../lib/output';
import type { SpendDecision, WalletProvider } from '../lib/wallet';

// src/lib/siwx.ts mints the SIWX nonce as randomBytes(16).toString('base64url'),
// which can contain '-'/'_'; the EIP-4361 grammar only allows an alphanumeric
// nonce, so header building fails intermittently on real randomness (source bug,
// reported separately). Pin randomBytes to bytes whose base64url is alphanumeric
// so every SIWX build here is deterministic while still exercising the real path.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomBytes: (size: number) => Buffer.alloc(size, 0xab) };
});

const BASE_URL = 'https://tenjin.test';
const READ_URL = `${BASE_URL}/api/read/alice/hello`;
const POST_ID = '11111111-2222-4333-8444-555555555555';
const SLUG = 'hello';
const PAY_TO = `0x${'11'.repeat(20)}`;
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const TX_HASH = `0x${'ab'.repeat(32)}`;
const BODY_MD =
  '# Hello\n\nIntro words for the body.\n\n## Details\n\nMore section words that follow after the intro section here.\n';

// One real key: SIWX and the EIP-3009 authorization both sign locally, off-chain.
const ACCOUNT = privateKeyToAccount(generatePrivateKey());

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-buy-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function captureIo(isTTY = false): { io: Io; stderr: () => string } {
  const err: string[] = [];
  const mk = (sink: string[]) =>
    ({
      write: (chunk: string | Uint8Array) => {
        sink.push(chunk.toString());
        return true;
      },
    }) as unknown as NodeJS.WritableStream;
  const io: Io = { stdout: mk([]), stderr: mk(err), isTTY };
  return { io, stderr: () => err.join('') };
}

function ctxFor(io: Io = captureIo().io): CommandContext {
  return { flags: { json: false, timeout: 5000, baseUrl: BASE_URL }, dataDir: dir, io };
}

function previewBody(price: string): Record<string, unknown> {
  return {
    id: POST_ID,
    slug: SLUG,
    title: 'Hello',
    price,
    creator: { handle: 'alice' },
    bodyMdPreview: 'Intro words',
  };
}

function unlockedBody(price = '250000'): Record<string, unknown> {
  return {
    id: POST_ID,
    slug: SLUG,
    title: 'Hello',
    price,
    creator: { handle: 'alice' },
    bodyMd: BODY_MD,
  };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

/** A real v2 exact-scheme challenge the production decoder and signer both accept. */
function challengeHeader(amountAtomic: string, opts: { error?: string } = {}): string {
  return encodePaymentRequiredHeader({
    x402Version: 2,
    ...(opts.error !== undefined ? { error: opts.error } : {}),
    resource: { url: READ_URL },
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:8453',
        asset: USDC_BASE,
        amount: amountAtomic,
        payTo: PAY_TO,
        maxTimeoutSeconds: 300,
        extra: { name: 'USD Coin', version: '2', postId: POST_ID },
      },
    ],
    extensions: { 'sign-in-with-x': { supportedChains: [{ chainId: 'eip155:8453' }] } },
  });
}

const SETTLED_HEADER = encodePaymentResponseHeader({
  success: true,
  transaction: TX_HASH,
  network: 'eip155:8453',
});

function challenge402(amount: string): Response {
  return jsonResponse(previewBody(amount), 402, { 'payment-required': challengeHeader(amount) });
}

interface SeenRequest {
  url: string;
  headers: Record<string, string>;
}

interface BuyRoutes {
  bare: () => Response;
  siwx?: () => Response;
  paid?: () => Response;
}

/** Routes on request headers: payment-signature beats sign-in-with-x beats bare. */
function buyFetch(routes: BuyRoutes): { fetchImpl: typeof fetch; requests: SeenRequest[] } {
  const requests: SeenRequest[] = [];
  const fetchImpl = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const raw = (init?.headers ?? {}) as Record<string, string>;
    const headers = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k.toLowerCase(), v]));
    requests.push({ url: String(input), headers });
    if (headers['payment-signature'] !== undefined) {
      if (routes.paid === undefined) throw new Error('unexpected paid request');
      return routes.paid();
    }
    if (headers['sign-in-with-x'] !== undefined) {
      if (routes.siwx === undefined) throw new Error('unexpected siwx request');
      return routes.siwx();
    }
    return routes.bare();
  }) as typeof fetch;
  return { fetchImpl, requests };
}

function fakeProvider(opts: { decision?: SpendDecision; getSignerError?: CliError } = {}): {
  provider: WalletProvider;
  authorizeSpend: ReturnType<typeof vi.fn>;
  recordSpend: ReturnType<typeof vi.fn>;
  getSigner: ReturnType<typeof vi.fn>;
} {
  const authorizeSpend = vi.fn(
    async () => opts.decision ?? { decision: 'allow' as const, reasons: [] },
  );
  const recordSpend = vi.fn(async () => undefined);
  const getSigner = vi.fn(async () => {
    if (opts.getSignerError !== undefined) throw opts.getSignerError;
    return {
      address: ACCOUNT.address,
      signMessage: (args: { message: string }) => ACCOUNT.signMessage(args),
      signTypedData: (args: Parameters<PrivateKeyAccount['signTypedData']>[0]) =>
        ACCOUNT.signTypedData(args),
    };
  });
  const provider: WalletProvider = {
    id: 'fake',
    describe: async () => {
      throw new Error('buy never describes the wallet');
    },
    diagnostics: async () => ({ warnings: [] }),
    getSigner,
    authorizeSpend,
    recordSpend,
  };
  return { provider, authorizeSpend, recordSpend, getSigner };
}

async function catchCliError(p: Promise<unknown>): Promise<CliError> {
  const err: unknown = await p.then(
    () => {
      throw new Error('expected a CliError, got success');
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CliError);
  return err as CliError;
}

function run(
  args: Partial<BuyArgs>,
  deps: BuyDeps,
  ctx: CommandContext = ctxFor(),
): ReturnType<typeof runBuy> {
  return runBuy({ ref: 'alice/hello', ...args }, ctx, deps);
}

const libraryMdPath = (): string => join(dir, 'library', POST_ID, `${SLUG}.md`);

describe('runBuy free and entitled paths', () => {
  it('a free post saves to the library with nothing paid and no signer use', async () => {
    const { provider, authorizeSpend, getSigner } = fakeProvider();
    const { fetchImpl, requests } = buyFetch({ bare: () => jsonResponse(unlockedBody('0'), 200) });
    const res = await run({}, { fetchImpl, provider });
    const data = res.data as Record<string, unknown>;
    expect(data.entitlement).toBe('free');
    expect(data.paid).toEqual({ atomic: '0', usd: '0' });
    expect(data.txHash).toBeNull();
    expect(data.outline).toEqual(['# Hello', '## Details']);
    expect(data).not.toHaveProperty('body');
    expect(await readFile(libraryMdPath(), 'utf8')).toBe(BODY_MD);
    expect(getSigner).not.toHaveBeenCalled();
    expect(authorizeSpend).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
  });

  it('an entitled wallet unlocks on the SIWX precheck without any payment header', async () => {
    const { provider, authorizeSpend } = fakeProvider();
    const { fetchImpl, requests } = buyFetch({
      bare: () => challenge402('250000'),
      siwx: () => jsonResponse(unlockedBody(), 200),
    });
    const res = await run({}, { fetchImpl, provider });
    const data = res.data as Record<string, unknown>;
    expect(data.entitlement).toBe('already-entitled');
    expect(data.paid).toEqual({ atomic: '0', usd: '0' });
    expect(data.txHash).toBeNull();
    expect(authorizeSpend).not.toHaveBeenCalled();
    expect(requests.every((r) => !('payment-signature' in r.headers))).toBe(true);
  });
});

describe('runBuy refusal gates before any payment', () => {
  it('refuses over --max-price even with --yes and never requests payment', async () => {
    const { provider, authorizeSpend } = fakeProvider();
    const { fetchImpl, requests } = buyFetch({
      bare: () => challenge402('250000'),
      siwx: () => challenge402('250000'),
    });
    const err = await catchCliError(run({ maxPrice: '0.20', yes: true }, { fetchImpl, provider }));
    expect(err.code).toBe('REFUSED');
    expect(err.exitCode).toBe(3);
    expect(err.message).toContain('0.25');
    expect(err.message).toContain('0.2');
    expect(authorizeSpend).not.toHaveBeenCalled();
    expect(requests.every((r) => !('payment-signature' in r.headers))).toBe(true);
  });

  it('caps against the FRESH precheck challenge when the price rose after the bare 402', async () => {
    const { provider } = fakeProvider();
    const { fetchImpl, requests } = buyFetch({
      bare: () => challenge402('150000'),
      siwx: () => challenge402('250000'),
    });
    const err = await catchCliError(run({ maxPrice: '0.20' }, { fetchImpl, provider }));
    expect(err.code).toBe('REFUSED');
    expect(err.exitCode).toBe(3);
    expect((err.details as { price: { atomic: string } }).price.atomic).toBe('250000');
    expect(requests.every((r) => !('payment-signature' in r.headers))).toBe(true);
  });

  it('a policy refuse is REFUSED exit 3 with the reasons in details, no payment', async () => {
    const { provider } = fakeProvider({
      decision: { decision: 'refuse', reasons: ['session budget exhausted'] },
    });
    const { fetchImpl, requests } = buyFetch({
      bare: () => challenge402('250000'),
      siwx: () => challenge402('250000'),
    });
    const err = await catchCliError(run({}, { fetchImpl, provider }));
    expect(err.code).toBe('REFUSED');
    expect(err.exitCode).toBe(3);
    expect((err.details as { reasons: string[] }).reasons).toEqual(['session budget exhausted']);
    expect(requests.every((r) => !('payment-signature' in r.headers))).toBe(true);
  });
});

describe('runBuy confirm step', () => {
  const confirmRoutes = (): BuyRoutes => ({
    bare: () => challenge402('250000'),
    siwx: () => challenge402('250000'),
    paid: () => jsonResponse(unlockedBody(), 200, { 'payment-response': SETTLED_HEADER }),
  });
  const confirmProvider = () =>
    fakeProvider({ decision: { decision: 'confirm', reasons: ['above maxAutoSpend'] } });

  it('machine mode (no TTY) refuses a confirm decision and points at --yes', async () => {
    const { provider } = confirmProvider();
    const { fetchImpl } = buyFetch(confirmRoutes());
    const err = await catchCliError(run({}, { fetchImpl, provider }, ctxFor(captureIo(false).io)));
    expect(err.code).toBe('REFUSED');
    expect(err.exitCode).toBe(3);
    expect(err.fix).toContain('--yes');
  });

  it('an interactive yes proceeds to payment', async () => {
    const { provider } = confirmProvider();
    const { fetchImpl } = buyFetch(confirmRoutes());
    const confirmFn = vi.fn<(question: string) => Promise<boolean>>(async () => true);
    const res = await run({}, { fetchImpl, provider, confirmFn }, ctxFor(captureIo(true).io));
    expect((res.data as Record<string, unknown>).entitlement).toBe('paid');
    expect(confirmFn).toHaveBeenCalledOnce();
    expect(confirmFn.mock.calls[0]?.[0]).toContain('0.25 USD');
  });

  it('an interactive no refuses with the purchase_declined outcome hint', async () => {
    const { provider } = confirmProvider();
    const { fetchImpl, requests } = buyFetch(confirmRoutes());
    const err = await catchCliError(
      run({}, { fetchImpl, provider, confirmFn: async () => false }, ctxFor(captureIo(true).io)),
    );
    expect(err.code).toBe('REFUSED');
    expect(err.fix).toContain('purchase_declined');
    expect(requests.every((r) => !('payment-signature' in r.headers))).toBe(true);
  });
});

describe('runBuy paid path', () => {
  it('signs the live challenge amount, saves the body, and records the spend', async () => {
    const { provider, recordSpend } = fakeProvider();
    const { fetchImpl, requests } = buyFetch({
      bare: () => challenge402('250000'),
      siwx: () => challenge402('250000'),
      paid: () => jsonResponse(unlockedBody(), 200, { 'payment-response': SETTLED_HEADER }),
    });
    const res = await run({}, { fetchImpl, provider });

    const paidReq = requests.find((r) => 'payment-signature' in r.headers);
    expect(paidReq).toBeDefined();
    expect(paidReq?.headers['x-tenjin-client']).toContain('tenjin-cli/');
    const decoded = decodePaymentSignatureHeader(
      paidReq?.headers['payment-signature'] as string,
    ) as unknown as {
      payload?: { authorization?: { value?: string } };
    };
    expect(decoded.payload?.authorization?.value).toBe('250000');

    const data = res.data as Record<string, unknown>;
    expect(data.entitlement).toBe('paid');
    expect(data.txHash).toBe(TX_HASH);
    expect(data.paid).toEqual({ atomic: '250000', usd: '0.25' });
    expect(recordSpend).toHaveBeenCalledExactlyOnceWith({
      amountAtomic: '250000',
      resourceId: POST_ID,
    });
    expect(await readFile(libraryMdPath(), 'utf8')).toBe(BODY_MD);
    const expectedHash = `sha256:${createHash('sha256').update(BODY_MD, 'utf8').digest('hex')}`;
    expect(data.contentHash).toBe(expectedHash);
    expect(res.humanLines?.[0]).toContain(libraryMdPath());
  });

  it('falls back to a free SIWX re-read on a 409 already_purchased envelope', async () => {
    const { provider, recordSpend } = fakeProvider();
    let siwxCalls = 0;
    const { fetchImpl } = buyFetch({
      bare: () => challenge402('250000'),
      siwx: () => {
        siwxCalls += 1;
        return siwxCalls === 1 ? challenge402('250000') : jsonResponse(unlockedBody(), 200);
      },
      paid: () =>
        jsonResponse(
          { error: { code: 'already_purchased', message: 'this wallet owns the post' } },
          409,
        ),
    });
    const res = await run({}, { fetchImpl, provider });
    const data = res.data as Record<string, unknown>;
    expect(data.entitlement).toBe('already-entitled');
    expect(data.txHash).toBeNull();
    expect(recordSpend).not.toHaveBeenCalled();
    expect(siwxCalls).toBe(2);
  });
});

describe('runBuy lookup attribution', () => {
  const paidRoutes = (): BuyRoutes => ({
    bare: () => challenge402('250000'),
    siwx: () => challenge402('250000'),
    paid: () => jsonResponse(unlockedBody(), 200, { 'payment-response': SETTLED_HEADER }),
  });
  const HISTORY_LOOKUP_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const FLAG_LOOKUP_ID = '99999999-8888-4777-8666-555555555444';
  const seedHistory = (): Promise<void> =>
    recordLookup(dir, {
      lookupId: HISTORY_LOOKUP_ID,
      decision: 'CANDIDATES',
      at: '2026-07-19T00:00:00.000Z',
      candidates: [{ resourceId: POST_ID, url: READ_URL, title: 'Hello', price: '250000' }],
    });
  const paidHeaders = (requests: SeenRequest[]): Record<string, string> => {
    const paidReq = requests.find((r) => 'payment-signature' in r.headers);
    expect(paidReq).toBeDefined();
    return paidReq?.headers as Record<string, string>;
  };

  it('carries the matching lookup id from history when no flag is passed', async () => {
    await seedHistory();
    const { provider } = fakeProvider();
    const { fetchImpl, requests } = buyFetch(paidRoutes());
    await run({}, { fetchImpl, provider });
    expect(paidHeaders(requests)['x-tenjin-lookup-id']).toBe(HISTORY_LOOKUP_ID);
  });

  it('an explicit --lookup-id overrides the history match', async () => {
    await seedHistory();
    const { provider } = fakeProvider();
    const { fetchImpl, requests } = buyFetch(paidRoutes());
    await run({ lookupId: FLAG_LOOKUP_ID }, { fetchImpl, provider });
    expect(paidHeaders(requests)['x-tenjin-lookup-id']).toBe(FLAG_LOOKUP_ID);
  });

  it('sends no attribution header without history or flag', async () => {
    const { provider } = fakeProvider();
    const { fetchImpl, requests } = buyFetch(paidRoutes());
    await run({}, { fetchImpl, provider });
    expect('x-tenjin-lookup-id' in paidHeaders(requests)).toBe(false);
  });
});

describe('runBuy payment failures', () => {
  it('a 402 with a settlement header is PAYMENT_FAILED exit 4 pointing at the balance', async () => {
    const failedSettle = encodePaymentResponseHeader({
      success: false,
      errorReason: 'insufficient_funds',
      transaction: '',
      network: 'eip155:8453',
    });
    const { provider, recordSpend } = fakeProvider();
    const { fetchImpl } = buyFetch({
      bare: () => challenge402('250000'),
      siwx: () => challenge402('250000'),
      paid: () => jsonResponse(previewBody('250000'), 402, { 'payment-response': failedSettle }),
    });
    const err = await catchCliError(run({}, { fetchImpl, provider }));
    expect(err.code).toBe('PAYMENT_FAILED');
    expect(err.exitCode).toBe(4);
    expect(err.fix).toContain('balance');
    expect(recordSpend).not.toHaveBeenCalled();
  });

  it('a 402 re-challenge carrying an error is PAYMENT_FAILED exit 4 with the reason', async () => {
    const { provider } = fakeProvider();
    const { fetchImpl } = buyFetch({
      bare: () => challenge402('250000'),
      siwx: () => challenge402('250000'),
      paid: () =>
        jsonResponse(previewBody('250000'), 402, {
          'payment-required': challengeHeader('250000', { error: 'signature verification failed' }),
        }),
    });
    const err = await catchCliError(run({}, { fetchImpl, provider }));
    expect(err.code).toBe('PAYMENT_FAILED');
    expect(err.exitCode).toBe(4);
    expect(err.message).toContain('signature verification failed');
  });

  it('a missing wallet on a paid post is WALLET_MISSING with the price and the create fix', async () => {
    const { provider } = fakeProvider({
      getSignerError: new CliError('WALLET_MISSING', 'no wallet configured'),
    });
    const { fetchImpl } = buyFetch({ bare: () => challenge402('250000') });
    const err = await catchCliError(run({}, { fetchImpl, provider }));
    expect(err.code).toBe('WALLET_MISSING');
    expect(err.exitCode).toBe(1);
    expect(err.message).toContain('0.25');
    expect(err.fix).toContain('wallet create');
  });
});

describe('runBuy output shaping', () => {
  it('--print-body includes the body field', async () => {
    const { provider } = fakeProvider();
    const { fetchImpl } = buyFetch({ bare: () => jsonResponse(unlockedBody('0'), 200) });
    const res = await run({ printBody: true }, { fetchImpl, provider });
    expect((res.data as Record<string, unknown>).body).toBe(BODY_MD);
  });

  it('--sections selects leading sections deterministically within the budget', async () => {
    const { provider } = fakeProvider();
    const { fetchImpl } = buyFetch({ bare: () => jsonResponse(unlockedBody('0'), 200) });
    const res = await run({ sections: '10' }, { fetchImpl, provider });
    const sections = (
      res.data as { sections: { heading: string | null; level: number; body: string }[] }
    ).sections;
    expect(sections).toHaveLength(1);
    expect(sections[0]?.heading).toBe('Hello');
    expect(sections[0]?.level).toBe(1);
    expect(sections[0]?.body).toBe('Intro words for the body.');
  });

  it.each(['0', 'x', '-1', '2.5'])('--sections %s is USAGE exit 2', async (sections) => {
    const { provider } = fakeProvider();
    const { fetchImpl } = buyFetch({ bare: () => jsonResponse(unlockedBody('0'), 200) });
    const err = await catchCliError(run({ sections }, { fetchImpl, provider }));
    expect(err.code).toBe('USAGE');
    expect(err.exitCode).toBe(2);
  });
});
