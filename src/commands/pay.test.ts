import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPay } from './pay';
import { saveSweepListings } from '../lib/bazaar';
import { CliError } from '../lib/errors';
import { knownDeploymentOrigins } from '../lib/production-origin';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import { parseSIWxHeader } from '@x402/extensions/sign-in-with-x';
import type { PaymentRequired, PaymentRequirements } from '@x402/core/types';
import { buildPaymentRequired, testWalletProvider, withBuilderCode } from '../lib/read-test-utils';
import { TENJIN_CLI_BUILDER_CODE } from '../lib/x402-pay';
import type { SpendAuthorizer, SpendAuthorization } from '../lib/wallet';
import type { CommandContext, GlobalFlags } from '../context';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-pay-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

function makeCtx(flags: Partial<GlobalFlags> = {}, isTTY = false): CommandContext {
  const sink = () => ({ write: () => true }) as unknown as NodeJS.WritableStream;
  return {
    flags: { json: false, timeout: 5000, ...flags },
    dataDir: dir,
    io: { stdout: sink(), stderr: sink(), isTTY },
  };
}

const TENJIN_URL = 'https://tenjin.blog/api/answer';
const FOREIGN_URL = 'https://seller.example/api/enrich';
const REGISTRY = 'https://registry.test';

const RESERVATION = 'rsv-test';

/**
 * The Bazaar lane resolves its destination before it probes, and `.example`
 * names never resolve, so every call here carries a public answer. The guard
 * itself is tested against the real resolver in lib/destination.test.ts, and
 * the refusal path is tested below with a private answer.
 */
const PUBLIC_DNS = {
  destination: { resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }] },
};

function fakeAuthorizer(
  decision: SpendAuthorization['decision'],
  reason = 'within_policy',
): SpendAuthorizer {
  return {
    policyEnforcement: 'client-only',
    authorize: vi.fn(async (req): Promise<SpendAuthorization> => ({
      decision,
      reason: reason as SpendAuthorization['reason'],
      message: 'test',
      amountAtomic: req.amountAtomic,
      sessionSpentAtomic: 0n,
      sessionBudgetAtomic: 0n,
      policyEnforcement: 'client-only',
      ...(decision === 'deny' ? {} : { reservationId: RESERVATION }),
    })),
    commit: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
  };
}

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** A scripted endpoint: each call consumes the next canned Response. */
function scriptedFetch(responses: Response[]): { fetch: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const impl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? {}).forEach((v, k) => {
      headers[k] = v;
    });
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      ...(typeof init?.body === 'string' ? { body: init.body } : {}),
    });
    const next = responses.shift();
    if (next === undefined) throw new Error('scripted fetch exhausted');
    return next;
  }) as typeof fetch;
  return { fetch: impl, calls };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** A registry answer the SDK's bazaar client accepts: one listed resource. */
function registryListing(
  resourceUrl: string,
  accept: Record<string, unknown>,
): Record<string, unknown> {
  return {
    x402Version: 2,
    items: [
      {
        resource: resourceUrl,
        type: 'http',
        x402Version: 2,
        accepts: [accept],
        lastUpdated: '2026-08-14T00:00:00Z',
      },
    ],
    pagination: { limit: 100, offset: 0, total: 1 },
  };
}

const LIVE_ACCEPT = {
  scheme: 'exact',
  network: 'eip155:8453',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  amount: '100000',
  payTo: '0x1111111111111111111111111111111111111111',
  maxTimeoutSeconds: 300,
  extra: { name: 'USD Coin', version: '2' },
};

/** Registry hits go through GLOBAL fetch (the SDK client); endpoint hits go
 *  through the injected fetchImpl, so the two lanes cannot be confused. */
function stubRegistry(answer: () => Response): { urls: string[] } {
  const urls: string[] = [];
  vi.stubGlobal('fetch', (async (input: Parameters<typeof fetch>[0]) => {
    urls.push(String(input));
    return answer();
  }) as typeof fetch);
  return { urls };
}

async function writeConfig(over: Record<string, unknown> = {}): Promise<void> {
  await writeFile(
    join(dir, 'config.json'),
    JSON.stringify({ bazaarPay: true, bazaarRegistries: [REGISTRY], ...over }),
  );
}

describe('runPay, tenjin lane', () => {
  it('delivers a free 2xx without touching the wallet', async () => {
    const { fetch, calls } = scriptedFetch([json(200, { answer: 42 })]);
    const result = await runPay({ url: TENJIN_URL }, makeCtx(), {
      ...PUBLIC_DNS,
      fetchImpl: fetch,
    });
    const data = result.data as { paid: boolean; status: number; body: unknown; lane: string };
    expect(data.paid).toBe(false);
    expect(data.status).toBe(200);
    expect(data.body).toEqual({ answer: 42 });
    expect(data.lane).toBe('tenjin');
    expect(calls).toHaveLength(1);
  });

  // tenjin#738: at the cutover a Tenjin URL arrives on the deployment other
  // origin while the config still names the old one. It must stay in this lane.
  // The Bazaar lane is off here, so a fall-through would refuse outright.
  it('keeps a URL on the deployment other origin in this lane', async () => {
    const sibling = knownDeploymentOrigins().find((o) => o !== new URL(TENJIN_URL).origin);
    expect(sibling).toBeDefined();
    const { fetch, calls } = scriptedFetch([json(200, { answer: 42 })]);
    const result = await runPay({ url: `${sibling}/api/answer` }, makeCtx(), {
      ...PUBLIC_DNS,
      fetchImpl: fetch,
    });
    const data = result.data as { lane: string; status: number };
    expect(data.lane).toBe('tenjin');
    expect(data.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it('pays a 402 and delivers, committing the reservation', async () => {
    const fixture = buildPaymentRequired();
    const { fetch, calls } = scriptedFetch([
      json(402, { error: 'payment required' }, { 'PAYMENT-REQUIRED': fixture.header }),
      json(200, { answer: 'paid' }),
    ]);
    const authorizer = fakeAuthorizer('allow');
    const result = await runPay({ url: TENJIN_URL, data: '{"question":"q"}' }, makeCtx(), {
      ...PUBLIC_DNS,
      fetchImpl: fetch,
      provider: testWalletProvider(),
      authorizer,
    });
    const data = result.data as { paid: boolean; amountPaid: { atomic: string } };
    expect(data.paid).toBe(true);
    expect(data.amountPaid.atomic).toBe('100000');
    expect(calls).toHaveLength(2);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[1]!.headers['payment-signature']).toBeDefined();
    // The identical business request is retried: same body, same method.
    expect(calls[1]!.body).toBe(calls[0]!.body);
    expect(authorizer.commit).toHaveBeenCalledWith(RESERVATION, 100000n);
  });

  // A routing decision can name a contract on the configured origin, so the
  // terms it quoted bind here as on the Bazaar lane.
  it('refuses a 402 above the terms a caller was given, before signing', async () => {
    const fixture = buildPaymentRequired();
    const { fetch, calls } = scriptedFetch([json(402, {}, { 'PAYMENT-REQUIRED': fixture.header })]);
    const authorizer = fakeAuthorizer('allow');
    await expect(
      runPay(
        { url: TENJIN_URL, terms: { source: 'router', maxAmountAtomic: '99999' } },
        makeCtx(),
        { ...PUBLIC_DNS, fetchImpl: fetch, provider: testWalletProvider(), authorizer },
      ),
    ).rejects.toMatchObject({
      code: 'REGISTRY_MISMATCH',
      details: { advertised: { maxAmountAtomic: '99999' }, live: { amount: '100000' } },
    });
    expect(calls).toHaveLength(1);
    expect(authorizer.authorize).not.toHaveBeenCalled();
  });

  it('never attaches SIWX or session credentials', async () => {
    const fixture = buildPaymentRequired();
    const { fetch, calls } = scriptedFetch([
      json(402, {}, { 'PAYMENT-REQUIRED': fixture.header }),
      json(200, { ok: true }),
    ]);
    await runPay({ url: TENJIN_URL }, makeCtx(), {
      ...PUBLIC_DNS,
      fetchImpl: fetch,
      provider: testWalletProvider(),
      authorizer: fakeAuthorizer('allow'),
    });
    for (const call of calls) {
      expect(Object.keys(call.headers)).not.toContain('sign-in-with-x');
      expect(Object.keys(call.headers)).not.toContain('tenjin-session-delegation');
    }
  });

  // COMMITTED, not released: the signed authorization already left with the
  // paid request, so the endpoint can settle it whatever it answered.
  it('a 402 after payment is PAYMENT_FAILED and still commits the spend', async () => {
    const fixture = buildPaymentRequired();
    const { fetch } = scriptedFetch([
      json(402, {}, { 'PAYMENT-REQUIRED': fixture.header }),
      json(402, { error: 'rejected' }, { 'PAYMENT-REQUIRED': fixture.header }),
    ]);
    const authorizer = fakeAuthorizer('allow');
    await expect(
      runPay({ url: TENJIN_URL }, makeCtx(), {
        ...PUBLIC_DNS,
        fetchImpl: fetch,
        provider: testWalletProvider(),
        authorizer,
      }),
    ).rejects.toMatchObject({ code: 'PAYMENT_FAILED' });
    expect(authorizer.commit).toHaveBeenCalledWith(RESERVATION, 100000n);
    expect(authorizer.release).not.toHaveBeenCalled();
  });

  it('a policy deny is POLICY_REFUSED before any payment', async () => {
    const fixture = buildPaymentRequired();
    const { fetch, calls } = scriptedFetch([json(402, {}, { 'PAYMENT-REQUIRED': fixture.header })]);
    await expect(
      runPay({ url: TENJIN_URL }, makeCtx(), {
        ...PUBLIC_DNS,
        fetchImpl: fetch,
        provider: testWalletProvider(),
        authorizer: fakeAuthorizer('deny', 'price_cap_exceeded'),
      }),
    ).rejects.toMatchObject({ code: 'POLICY_REFUSED' });
    expect(calls).toHaveLength(1); // the probe only; no paid retry
  });

  it('a declined confirm releases the reservation and pays nothing', async () => {
    const fixture = buildPaymentRequired();
    const { fetch, calls } = scriptedFetch([json(402, {}, { 'PAYMENT-REQUIRED': fixture.header })]);
    const authorizer = fakeAuthorizer('confirm');
    await expect(
      runPay({ url: TENJIN_URL }, makeCtx(), {
        ...PUBLIC_DNS,
        fetchImpl: fetch,
        provider: testWalletProvider(),
        authorizer,
        confirm: async () => false,
      }),
    ).rejects.toMatchObject({ code: 'POLICY_REFUSED' });
    expect(authorizer.release).toHaveBeenCalledWith(RESERVATION);
    expect(calls).toHaveLength(1);
  });

  it('non-interactive without --yes refuses at the confirm gate', async () => {
    const fixture = buildPaymentRequired();
    const { fetch } = scriptedFetch([json(402, {}, { 'PAYMENT-REQUIRED': fixture.header })]);
    await expect(
      runPay({ url: TENJIN_URL }, makeCtx({}, false), {
        ...PUBLIC_DNS,
        fetchImpl: fetch,
        provider: testWalletProvider(),
        authorizer: fakeAuthorizer('confirm'),
      }),
    ).rejects.toMatchObject({ code: 'POLICY_REFUSED' });
  });

  it('a redirect on the probe fails closed', async () => {
    const { fetch } = scriptedFetch([
      new Response(null, { status: 308, headers: { location: 'https://elsewhere.example/' } }),
    ]);
    await expect(
      runPay({ url: TENJIN_URL }, makeCtx(), { ...PUBLIC_DNS, fetchImpl: fetch }),
    ).rejects.toThrow(/redirected/);
  });

  it('a non-402 error status is API_UNREACHABLE', async () => {
    const { fetch } = scriptedFetch([json(500, { error: 'boom' })]);
    await expect(
      runPay({ url: TENJIN_URL }, makeCtx(), { ...PUBLIC_DNS, fetchImpl: fetch }),
    ).rejects.toMatchObject({ code: 'API_UNREACHABLE' });
  });

  it('a 402 with no PAYMENT-REQUIRED header is CONTRACT_MISMATCH', async () => {
    const { fetch } = scriptedFetch([json(402, { error: 'pay' })]);
    await expect(
      runPay({ url: TENJIN_URL }, makeCtx(), { ...PUBLIC_DNS, fetchImpl: fetch }),
    ).rejects.toMatchObject({ code: 'CONTRACT_MISMATCH' });
  });
});

/** The builder-code `info` the CLI put on the wire, or undefined when it sent none. */
function attributionOf(header: string | undefined): { a?: string; s?: string[] } | undefined {
  const envelope = JSON.parse(Buffer.from(header ?? '', 'base64').toString('utf8')) as {
    extensions?: Record<string, { info?: { a?: string; s?: string[] } }>;
  };
  return envelope.extensions?.['builder-code']?.info;
}

describe('runPay, builder-code attribution', () => {
  it('sends the CLI service code when the 402 advertises builder-code', async () => {
    const fixture = buildPaymentRequired({}, withBuilderCode());
    const { fetch, calls } = scriptedFetch([
      json(402, {}, { 'PAYMENT-REQUIRED': fixture.header }),
      json(200, { ok: true }),
    ]);
    await runPay({ url: TENJIN_URL }, makeCtx(), {
      ...PUBLIC_DNS,
      fetchImpl: fetch,
      provider: testWalletProvider(),
      authorizer: fakeAuthorizer('allow'),
    });
    expect(attributionOf(calls[1]!.headers['payment-signature'])?.s).toEqual([
      TENJIN_CLI_BUILDER_CODE,
    ]);
  });

  // A seller who never declared the extension must not receive it: the SDK's
  // gating is what keeps this attribution spec-clean rather than a custom header.
  it('sends no builder-code extension to a seller that did not advertise it', async () => {
    const fixture = buildPaymentRequired();
    const { fetch, calls } = scriptedFetch([
      json(402, {}, { 'PAYMENT-REQUIRED': fixture.header }),
      json(200, { ok: true }),
    ]);
    await runPay({ url: TENJIN_URL }, makeCtx(), {
      ...PUBLIC_DNS,
      fetchImpl: fetch,
      provider: testWalletProvider(),
      authorizer: fakeAuthorizer('allow'),
    });
    expect(attributionOf(calls[1]!.headers['payment-signature'])).toBeUndefined();
  });

  // The lane the Tenjin server actually takes: it always declares
  // sign-in-with-x, so the payment is built from the FRESH challenge the
  // entitlement re-check returned rather than the first look. Pin that the
  // builder-code entry survives that swap.
  it('attributes the payment built from the sign-in-with-x re-check challenge', async () => {
    const withBoth = (): Partial<PaymentRequired> => ({
      extensions: {
        'sign-in-with-x': { info: { domain: new URL(TENJIN_URL).host } },
        ...withBuilderCode().extensions,
      },
    });
    const { fetch, calls } = scriptedFetch([
      json(402, {}, { 'PAYMENT-REQUIRED': buildPaymentRequired({}, withBoth()).header }),
      json(402, {}, { 'PAYMENT-REQUIRED': buildPaymentRequired({}, withBoth()).header }),
      json(200, { ok: true }),
    ]);
    await runPay({ url: TENJIN_URL }, makeCtx(), {
      ...PUBLIC_DNS,
      fetchImpl: fetch,
      provider: testWalletProvider(),
      authorizer: fakeAuthorizer('allow'),
    });
    expect(calls[1]!.headers['sign-in-with-x']).toBeDefined();
    const info = attributionOf(calls[2]!.headers['payment-signature']);
    expect(info?.s).toEqual([TENJIN_CLI_BUILDER_CODE]);
    expect(info?.a).toBe(TENJIN_CLI_BUILDER_CODE);
  });

  it('attributes a registry-verified foreign 402 without disturbing the evidence check', async () => {
    await writeConfig();
    stubRegistry(() => json(200, registryListing(FOREIGN_URL, LIVE_ACCEPT)));
    const fixture = buildPaymentRequired({}, withBuilderCode('bc_seller01'));
    const { fetch, calls } = scriptedFetch([
      json(402, {}, { 'PAYMENT-REQUIRED': fixture.header }),
      json(200, { enriched: true }),
    ]);
    const result = await runPay({ url: FOREIGN_URL }, makeCtx(), {
      ...PUBLIC_DNS,
      fetchImpl: fetch,
      provider: testWalletProvider(),
      authorizer: fakeAuthorizer('allow'),
    });
    expect((result.data as { lane: string; registry: string }).lane).toBe('bazaar');
    expect((result.data as { registry: string }).registry).toBe(REGISTRY);
    const info = attributionOf(calls[1]!.headers['payment-signature']);
    expect(info?.s).toEqual([TENJIN_CLI_BUILDER_CODE]);
    expect(info?.a).toBe('bc_seller01');
  });
});

/** A challenge advertising the standard sign-in-with-x extension. */
function siwxFixture(
  url: string,
  amount = '100000',
  acceptOver: Record<string, unknown> = {},
): { header: string } {
  const paymentRequired: PaymentRequired = {
    x402Version: 2,
    resource: { url, description: 'paid', mimeType: 'application/json' },
    accepts: [{ ...LIVE_ACCEPT, amount, ...acceptOver } as never],
    extensions: { 'sign-in-with-x': { info: { domain: new URL(url).host } } },
  };
  return { header: encodePaymentRequiredHeader(paymentRequired) };
}

describe('runPay, the sign-in-with-x extension', () => {
  it('an entitled wallet re-reads free, with the signature bound to the target host', async () => {
    const fixture = siwxFixture(TENJIN_URL);
    const { fetch, calls } = scriptedFetch([
      json(402, {}, { 'PAYMENT-REQUIRED': fixture.header }),
      json(200, { answer: 'yours already' }),
    ]);
    const authorizer = fakeAuthorizer('allow');
    const result = await runPay({ url: TENJIN_URL }, makeCtx(), {
      ...PUBLIC_DNS,
      fetchImpl: fetch,
      provider: testWalletProvider(),
      authorizer,
    });
    const data = result.data as { paid: boolean; entitled?: boolean };
    expect(data.paid).toBe(false);
    expect(data.entitled).toBe(true);
    expect(calls).toHaveLength(2);
    const siwx = calls[1]!.headers['sign-in-with-x'];
    expect(siwx).toBeDefined();
    const payload = parseSIWxHeader(siwx!) as { domain: string };
    expect(payload.domain).toBe('tenjin.blog');
    expect(calls[1]!.headers['payment-signature']).toBeUndefined();
    expect(authorizer.authorize).not.toHaveBeenCalled(); // nothing to spend
  });

  it('an unentitled wallet pays the FRESH challenge the re-check returned', async () => {
    const fixture = siwxFixture(TENJIN_URL);
    const { fetch, calls } = scriptedFetch([
      json(402, {}, { 'PAYMENT-REQUIRED': fixture.header }),
      json(402, {}, { 'PAYMENT-REQUIRED': siwxFixture(TENJIN_URL, '90000').header }),
      json(200, { answer: 'paid' }),
    ]);
    const authorizer = fakeAuthorizer('allow');
    const result = await runPay({ url: TENJIN_URL }, makeCtx(), {
      ...PUBLIC_DNS,
      fetchImpl: fetch,
      provider: testWalletProvider(),
      authorizer,
    });
    const data = result.data as { paid: boolean; amountPaid: { atomic: string } };
    expect(data.paid).toBe(true);
    // The fresh (lower) price is what was authorized and signed, like buy.
    expect(data.amountPaid.atomic).toBe('90000');
    expect(calls).toHaveLength(3);
    expect(calls[2]!.headers['payment-signature']).toBeDefined();
    expect(calls[2]!.headers['sign-in-with-x']).toBeUndefined(); // payment IS the credential
  });

  it('a price bump between the first look and signing is refused', async () => {
    const fixture = siwxFixture(TENJIN_URL, '100000');
    const { fetch } = scriptedFetch([
      json(402, {}, { 'PAYMENT-REQUIRED': fixture.header }),
      json(402, {}, { 'PAYMENT-REQUIRED': siwxFixture(TENJIN_URL, '200000').header }),
    ]);
    const authorizer = fakeAuthorizer('allow');
    await expect(
      runPay({ url: TENJIN_URL }, makeCtx(), {
        ...PUBLIC_DNS,
        fetchImpl: fetch,
        provider: testWalletProvider(),
        authorizer,
      }),
    ).rejects.toMatchObject({ code: 'PAYMENT_FAILED' });
    expect(authorizer.authorize).not.toHaveBeenCalled();
  });

  it('a foreign seller gets a signature bound to ITS origin, never the configured one', async () => {
    await writeConfig();
    stubRegistry(() => json(200, registryListing(FOREIGN_URL, LIVE_ACCEPT)));
    const fixture = siwxFixture(FOREIGN_URL);
    const { fetch, calls } = scriptedFetch([
      json(402, {}, { 'PAYMENT-REQUIRED': fixture.header }),
      json(200, { enriched: 'yours already' }),
    ]);
    const result = await runPay({ url: FOREIGN_URL }, makeCtx(), {
      ...PUBLIC_DNS,
      fetchImpl: fetch,
      provider: testWalletProvider(),
      authorizer: fakeAuthorizer('allow'),
    });
    expect((result.data as { entitled?: boolean }).entitled).toBe(true);
    const payload = parseSIWxHeader(calls[1]!.headers['sign-in-with-x']!) as {
      domain: string;
      uri: string;
    };
    expect(payload.domain).toBe('seller.example');
    expect(payload.uri).toContain('https://seller.example');
  });
});

describe('runPay, usage errors', () => {
  it('rejects a non-JSON --data before any network', async () => {
    const { fetch, calls } = scriptedFetch([]);
    await expect(
      runPay({ url: TENJIN_URL, data: 'not json' }, makeCtx(), { ...PUBLIC_DNS, fetchImpl: fetch }),
    ).rejects.toMatchObject({ code: 'USAGE' });
    expect(calls).toHaveLength(0);
  });

  it('rejects GET with a body, and unsupported methods', async () => {
    const { fetch } = scriptedFetch([]);
    await expect(
      runPay({ url: TENJIN_URL, method: 'GET', data: '{}' }, makeCtx(), {
        ...PUBLIC_DNS,
        fetchImpl: fetch,
      }),
    ).rejects.toMatchObject({ code: 'USAGE' });
    await expect(
      runPay({ url: TENJIN_URL, method: 'DELETE' }, makeCtx(), { ...PUBLIC_DNS, fetchImpl: fetch }),
    ).rejects.toMatchObject({ code: 'USAGE' });
  });
});

describe('runPay, bazaar lane', () => {
  it('refuses a foreign origin while the toggle is off, before any network', async () => {
    const { fetch, calls } = scriptedFetch([]);
    await expect(
      runPay({ url: FOREIGN_URL }, makeCtx(), { ...PUBLIC_DNS, fetchImpl: fetch }),
    ).rejects.toMatchObject({ code: 'USAGE' });
    expect(calls).toHaveLength(0);
  });

  it('pays a registry-verified foreign 402', async () => {
    await writeConfig();
    const registry = stubRegistry(() => json(200, registryListing(FOREIGN_URL, LIVE_ACCEPT)));
    const fixture = buildPaymentRequired();
    const { fetch, calls } = scriptedFetch([
      json(402, {}, { 'PAYMENT-REQUIRED': fixture.header }),
      json(200, { enriched: true }),
    ]);
    const result = await runPay({ url: FOREIGN_URL }, makeCtx(), {
      ...PUBLIC_DNS,
      fetchImpl: fetch,
      provider: testWalletProvider(),
      authorizer: fakeAuthorizer('allow'),
    });
    const data = result.data as { paid: boolean; lane: string; registry: string };
    expect(data.paid).toBe(true);
    expect(data.lane).toBe('bazaar');
    expect(data.registry).toBe(REGISTRY);
    expect(calls).toHaveLength(2);
    // The lookup was narrowed by the live payTo (the self-verifying filter).
    expect(registry.urls.some((u) => u.includes('payTo='))).toBe(true);
  });

  // The adversarial-money case the budget accounting exists for: a hostile
  // registry-listed seller answers 402 AFTER receiving each signature. The
  // authorization it holds is a bearer instrument it can still settle, so the
  // session budget must count the spend; releasing it here let every retry
  // sign a fresh authorization while the ledger counted zero of them.
  it('a hostile seller rejecting the paid leg still burns the session budget', async () => {
    await writeConfig();
    stubRegistry(() => json(200, registryListing(FOREIGN_URL, LIVE_ACCEPT)));
    const fixture = buildPaymentRequired();
    const { fetch, calls } = scriptedFetch([
      json(402, {}, { 'PAYMENT-REQUIRED': fixture.header }),
      json(402, { error: 'try again' }, { 'PAYMENT-REQUIRED': fixture.header }),
    ]);
    const authorizer = fakeAuthorizer('allow');
    try {
      await runPay({ url: FOREIGN_URL }, makeCtx(), {
        ...PUBLIC_DNS,
        fetchImpl: fetch,
        provider: testWalletProvider(),
        authorizer,
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe('PAYMENT_FAILED');
      // The coaching must not send an agent around the loop that compounds it.
      expect((err as CliError).fix).toContain('counted against the session budget');
      expect((err as CliError).fix).not.toMatch(/then retry/i);
    }
    expect(calls[1]!.headers['payment-signature']).toBeDefined();
    expect(authorizer.commit).toHaveBeenCalledWith(RESERVATION, 100000n);
    expect(authorizer.release).not.toHaveBeenCalled();
  });

  // The fresh post-SIWX challenge is what gets SIGNED, so it is re-verified
  // against the registry: a seller whose first 402 matches its listing but
  // whose fresh 402 swaps payTo at the same price passes the price-bump check
  // and must be caught here, before the wallet is consulted.
  it('a fresh challenge that swaps payTo after SIWX is REGISTRY_MISMATCH, nothing signed', async () => {
    await writeConfig();
    stubRegistry(() => json(200, registryListing(FOREIGN_URL, LIVE_ACCEPT)));
    const { fetch, calls } = scriptedFetch([
      json(402, {}, { 'PAYMENT-REQUIRED': siwxFixture(FOREIGN_URL).header }),
      json(
        402,
        {},
        {
          'PAYMENT-REQUIRED': siwxFixture(FOREIGN_URL, '100000', {
            payTo: '0x2222222222222222222222222222222222222222',
          }).header,
        },
      ),
    ]);
    const authorizer = fakeAuthorizer('allow');
    await expect(
      runPay({ url: FOREIGN_URL }, makeCtx(), {
        ...PUBLIC_DNS,
        fetchImpl: fetch,
        provider: testWalletProvider(),
        authorizer,
      }),
    ).rejects.toMatchObject({ code: 'REGISTRY_MISMATCH' });
    expect(calls).toHaveLength(2); // probe + SIWX re-check; never a paid leg
    expect(calls.every((c) => c.headers['payment-signature'] === undefined)).toBe(true);
    expect(authorizer.authorize).not.toHaveBeenCalled();
  });

  it('a live price above the advertised one is REGISTRY_MISMATCH, wallet untouched', async () => {
    await writeConfig();
    stubRegistry(() =>
      json(200, registryListing(FOREIGN_URL, { ...LIVE_ACCEPT, amount: '50000' })),
    );
    const fixture = buildPaymentRequired(); // live asks 100000
    const { fetch, calls } = scriptedFetch([json(402, {}, { 'PAYMENT-REQUIRED': fixture.header })]);
    const provider = testWalletProvider();
    const getSigner = vi.spyOn(provider, 'getSigner');
    await expect(
      runPay({ url: FOREIGN_URL }, makeCtx(), { ...PUBLIC_DNS, fetchImpl: fetch, provider }),
    ).rejects.toMatchObject({ code: 'REGISTRY_MISMATCH' });
    expect(getSigner).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  it('an unlisted resource is refused', async () => {
    await writeConfig();
    stubRegistry(() =>
      json(200, { x402Version: 2, items: [], pagination: { limit: 100, offset: 0, total: 0 } }),
    );
    const fixture = buildPaymentRequired();
    const { fetch } = scriptedFetch([json(402, {}, { 'PAYMENT-REQUIRED': fixture.header })]);
    await expect(
      runPay({ url: FOREIGN_URL }, makeCtx(), { ...PUBLIC_DNS, fetchImpl: fetch }),
    ).rejects.toMatchObject({ code: 'USAGE' });
  });

  it('unreachable registries fail the lane closed', async () => {
    await writeConfig();
    stubRegistry(() => {
      throw new Error('connection refused');
    });
    const fixture = buildPaymentRequired();
    const { fetch } = scriptedFetch([json(402, {}, { 'PAYMENT-REQUIRED': fixture.header })]);
    await expect(
      runPay({ url: FOREIGN_URL }, makeCtx(), { ...PUBLIC_DNS, fetchImpl: fetch }),
    ).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });

  it('the bazaar lane refuses plain http', async () => {
    await writeConfig();
    const { fetch, calls } = scriptedFetch([]);
    await expect(
      runPay({ url: 'http://seller.example/api' }, makeCtx(), { ...PUBLIC_DNS, fetchImpl: fetch }),
    ).rejects.toMatchObject({ code: 'USAGE' });
    expect(calls).toHaveLength(0);
  });

  it('verifies via a stored discover listing when the live lookup finds nothing', async () => {
    await writeConfig();
    // The live registry answers, but with an empty page: exactly the CDP shape,
    // whose list filter is a no-op and whose search cannot match a URL.
    stubRegistry(() =>
      json(200, { x402Version: 2, items: [], pagination: { limit: 20, offset: 0, total: 0 } }),
    );
    await saveSweepListings(dir, [
      { url: FOREIGN_URL, registry: REGISTRY, accepts: [LIVE_ACCEPT] as never },
    ]);
    const fixture = buildPaymentRequired();
    const { fetch } = scriptedFetch([
      json(402, {}, { 'PAYMENT-REQUIRED': fixture.header }),
      json(200, { enriched: true }),
    ]);
    const result = await runPay(
      // Query strings ride the request, not the listed identity.
      { url: `${FOREIGN_URL}?q=hello` },
      makeCtx(),
      {
        ...PUBLIC_DNS,
        fetchImpl: fetch,
        provider: testWalletProvider(),
        authorizer: fakeAuthorizer('allow'),
      },
    );
    const data = result.data as { paid: boolean; registry: string };
    expect(data.paid).toBe(true);
    expect(data.registry).toBe(REGISTRY);
  });

  it('an expired stored listing is not evidence', async () => {
    await writeConfig();
    stubRegistry(() =>
      json(200, { x402Version: 2, items: [], pagination: { limit: 20, offset: 0, total: 0 } }),
    );
    await saveSweepListings(
      dir,
      [{ url: FOREIGN_URL, registry: REGISTRY, accepts: [LIVE_ACCEPT] as never }],
      () => Date.now() - 25 * 60 * 60 * 1000,
    );
    const fixture = buildPaymentRequired();
    const { fetch } = scriptedFetch([json(402, {}, { 'PAYMENT-REQUIRED': fixture.header })]);
    await expect(
      runPay({ url: FOREIGN_URL }, makeCtx(), { ...PUBLIC_DNS, fetchImpl: fetch }),
    ).rejects.toMatchObject({ code: 'USAGE' });
  });

  // The mirror of the expiry test above, and the reason the window is bounded at
  // both ends: a stamp AHEAD of the clock (skew, a data dir restored from a
  // backup or copied between machines) used to yield a negative age that no TTL
  // comparison could ever exceed, so that one listing stayed evidence forever.
  it('a stored listing stamped in the future is not evidence either', async () => {
    await writeConfig();
    stubRegistry(() =>
      json(200, { x402Version: 2, items: [], pagination: { limit: 20, offset: 0, total: 0 } }),
    );
    await saveSweepListings(
      dir,
      [{ url: FOREIGN_URL, registry: REGISTRY, accepts: [LIVE_ACCEPT] as never }],
      () => Date.now() + 48 * 60 * 60 * 1000,
    );
    const fixture = buildPaymentRequired();
    const { fetch } = scriptedFetch([json(402, {}, { 'PAYMENT-REQUIRED': fixture.header })]);
    await expect(
      runPay({ url: FOREIGN_URL }, makeCtx(), { ...PUBLIC_DNS, fetchImpl: fetch }),
    ).rejects.toMatchObject({ code: 'USAGE' });
  });

  // The store is ours, so the only way in is a truncated write or a hand-edit.
  // A row whose `accepts` is not an array reached a `for...of` inside the
  // verification and threw a raw TypeError out of the gate that decides whether
  // anything may be signed; it is dropped at load instead.
  it('a malformed stored row is dropped, not thrown out of the registry check', async () => {
    await writeConfig();
    stubRegistry(() =>
      json(200, { x402Version: 2, items: [], pagination: { limit: 20, offset: 0, total: 0 } }),
    );
    await writeFile(
      join(dir, 'bazaar-listings.json'),
      JSON.stringify({
        listings: [
          { url: FOREIGN_URL, registry: REGISTRY, accepts: 'not-an-array', fetchedAt: 7 },
          {
            url: FOREIGN_URL,
            registry: REGISTRY,
            accepts: null,
            fetchedAt: new Date().toISOString(),
          },
        ],
      }),
    );
    const fixture = buildPaymentRequired();
    const { fetch } = scriptedFetch([json(402, {}, { 'PAYMENT-REQUIRED': fixture.header })]);
    await expect(
      runPay({ url: FOREIGN_URL }, makeCtx(), { ...PUBLIC_DNS, fetchImpl: fetch }),
    ).rejects.toMatchObject({ code: 'USAGE' });
  });

  it('a stored listing with a lower advertised price is REGISTRY_MISMATCH', async () => {
    await writeConfig();
    stubRegistry(() =>
      json(200, { x402Version: 2, items: [], pagination: { limit: 20, offset: 0, total: 0 } }),
    );
    await saveSweepListings(dir, [
      {
        url: FOREIGN_URL,
        registry: REGISTRY,
        accepts: [{ ...LIVE_ACCEPT, amount: '50000' }] as never,
      },
    ]);
    const fixture = buildPaymentRequired(); // live asks 100000
    const { fetch } = scriptedFetch([json(402, {}, { 'PAYMENT-REQUIRED': fixture.header })]);
    await expect(
      runPay({ url: FOREIGN_URL }, makeCtx(), { ...PUBLIC_DNS, fetchImpl: fetch }),
    ).rejects.toMatchObject({ code: 'REGISTRY_MISMATCH' });
  });

  it('the toggle-off fix names the operator act, never the URL that failed', async () => {
    const { fetch } = scriptedFetch([]);
    try {
      await runPay({ url: FOREIGN_URL }, makeCtx(), { ...PUBLIC_DNS, fetchImpl: fetch });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).fix).toContain('tenjin config set bazaarPay on');
      expect((err as CliError).fix).not.toContain('seller.example');
    }
  });
});

// The three checks PR 2 moved out of the draft auto-mode experiment into the
// shared money path, exercised where every caller meets them.
describe('runPay, the shared request gate', () => {
  const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const TERMS = { network: 'eip155:8453', asset: USDC, maxAmountAtomic: '100000' };

  it('refuses a destination whose name resolves onto this network, before any probe', async () => {
    await writeConfig();
    const { fetch, calls } = scriptedFetch([]);
    await expect(
      runPay({ url: FOREIGN_URL }, makeCtx(), {
        destination: { resolveHostname: async () => [{ address: '127.0.0.1', family: 4 }] },
        fetchImpl: fetch,
      }),
    ).rejects.toThrow('private or unsupported network address');
    expect(calls).toHaveLength(0);
  });

  it('pays on advertised terms without consulting a registry', async () => {
    await writeConfig();
    const registry = stubRegistry(() => json(500, {}));
    const fixture = buildPaymentRequired();
    const { fetch } = scriptedFetch([
      json(402, {}, { 'PAYMENT-REQUIRED': fixture.header }),
      json(200, { data: { BTC: 1 } }),
    ]);
    let prompt = '';
    const result = await runPay(
      { url: FOREIGN_URL, terms: { ...TERMS, source: 'a decision' } },
      makeCtx(),
      {
        ...PUBLIC_DNS,
        fetchImpl: fetch,
        provider: testWalletProvider(),
        authorizer: fakeAuthorizer('confirm'),
        confirm: async (line) => {
          prompt = line;
          return true;
        },
      },
    );
    expect((result.data as { paid: boolean }).paid).toBe(true);
    // The human approving the spend is told what vouched for the price.
    expect(prompt).toContain('a decision');
    expect(registry.urls).toHaveLength(0);
  });

  it.each([
    ['a higher live amount', { amount: '100001' }],
    ['another asset', { asset: '0x2222222222222222222222222222222222222222' }],
    ['another network', { network: 'eip155:84532' as const }],
  ])('refuses %s against the advertised terms, signing nothing', async (_label, over) => {
    await writeConfig();
    const fixture = buildPaymentRequired(over);
    const { fetch, calls } = scriptedFetch([json(402, {}, { 'PAYMENT-REQUIRED': fixture.header })]);
    const authorizer = fakeAuthorizer('allow');
    await expect(
      runPay({ url: FOREIGN_URL, terms: TERMS }, makeCtx(), {
        ...PUBLIC_DNS,
        fetchImpl: fetch,
        provider: testWalletProvider(),
        authorizer,
      }),
    ).rejects.toMatchObject({ code: 'REGISTRY_MISMATCH' });
    expect(calls).toHaveLength(1);
    expect(authorizer.authorize).not.toHaveBeenCalled();
  });

  it('carries the duplicate-guard key into the authorizer', async () => {
    const fixture = buildPaymentRequired();
    const { fetch } = scriptedFetch([
      json(402, {}, { 'PAYMENT-REQUIRED': fixture.header }),
      json(200, { ok: true }),
    ]);
    const authorizer = fakeAuthorizer('allow');
    await runPay({ url: TENJIN_URL, requestKey: 'cap:args' }, makeCtx(), {
      ...PUBLIC_DNS,
      fetchImpl: fetch,
      provider: testWalletProvider(),
      authorizer,
    });
    expect(authorizer.authorize).toHaveBeenCalledWith(
      expect.objectContaining({ requestKey: 'cap:args' }),
    );
  });

  it('reports a denied duplicate with the reason, paying nothing', async () => {
    const fixture = buildPaymentRequired();
    const { fetch, calls } = scriptedFetch([json(402, {}, { 'PAYMENT-REQUIRED': fixture.header })]);
    const err = await runPay({ url: TENJIN_URL, requestKey: 'cap:args' }, makeCtx(), {
      ...PUBLIC_DNS,
      fetchImpl: fetch,
      provider: testWalletProvider(),
      authorizer: fakeAuthorizer('deny', 'duplicate_in_flight'),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe('POLICY_REFUSED');
    expect((err as CliError).fix).toContain('in-flight');
    expect(calls).toHaveLength(1);
  });

  it('treats a 2xx that fails its success schema as a paid failure', async () => {
    const fixture = buildPaymentRequired();
    const { fetch } = scriptedFetch([
      json(402, {}, { 'PAYMENT-REQUIRED': fixture.header }),
      json(200, { status: 'error' }),
    ]);
    const authorizer = fakeAuthorizer('allow');
    const err = await runPay(
      {
        url: TENJIN_URL,
        resultSchema: { type: 'object', properties: { data: {} }, required: ['data'] },
      },
      makeCtx(),
      { ...PUBLIC_DNS, fetchImpl: fetch, provider: testWalletProvider(), authorizer },
    ).catch((e: unknown) => e);
    expect((err as CliError).code).toBe('CONTRACT_MISMATCH');
    // The authorization already left, so the spend stays accounted.
    expect(authorizer.commit).toHaveBeenCalled();
  });
});

// The success rule applies to every delivery this command makes, not only the
// paid one: a wallet that is already entitled would otherwise be handed an
// error body as a fulfilled result.
describe('runPay, the success rule on every delivery', () => {
  const SCHEMA = {
    type: 'object',
    properties: { success: { const: true } },
    required: ['success'],
  };

  it('refuses a free 2xx whose body fails the rule, paying nothing', async () => {
    const { fetch, calls } = scriptedFetch([json(200, { success: false })]);
    const err = await runPay({ url: TENJIN_URL, resultSchema: SCHEMA }, makeCtx(), {
      ...PUBLIC_DNS,
      fetchImpl: fetch,
    }).catch((e: unknown) => e);
    expect((err as CliError).code).toBe('CONTRACT_MISMATCH');
    expect((err as CliError).details).toMatchObject({ paid: false });
    expect(calls).toHaveLength(1);
  });

  it('refuses an entitled 2xx whose body fails the rule', async () => {
    const siwx = (): Partial<PaymentRequired> => ({
      extensions: { 'sign-in-with-x': { info: { domain: new URL(TENJIN_URL).host } } },
    });
    const { fetch } = scriptedFetch([
      json(402, {}, { 'PAYMENT-REQUIRED': buildPaymentRequired({}, siwx()).header }),
      json(200, { success: false }),
    ]);
    const authorizer = fakeAuthorizer('allow');
    const err = await runPay({ url: TENJIN_URL, resultSchema: SCHEMA }, makeCtx(), {
      ...PUBLIC_DNS,
      fetchImpl: fetch,
      provider: testWalletProvider(),
      authorizer,
    }).catch((e: unknown) => e);
    expect((err as CliError).code).toBe('CONTRACT_MISMATCH');
    expect(authorizer.commit).not.toHaveBeenCalled();
  });

  it('delivers a free 2xx that satisfies the rule', async () => {
    const { fetch } = scriptedFetch([json(200, { success: true })]);
    const result = await runPay({ url: TENJIN_URL, resultSchema: SCHEMA }, makeCtx(), {
      ...PUBLIC_DNS,
      fetchImpl: fetch,
    });
    expect((result.data as { paid: boolean }).paid).toBe(false);
  });

  /**
   * A body past the client's 128 KiB validation limit is not evidence the
   * endpoint broke its contract: the limit is ours, the rule never ran, and on
   * the paid leg the authorization has already settled. Refusing it charged the
   * caller and threw the product away.
   */
  const OVERSIZED = { success: true, blob: 'x'.repeat(200 * 1024) };

  it('delivers a PAID 2xx too large to validate, with the caveat, and keeps the charge', async () => {
    const fixture = buildPaymentRequired();
    const { fetch } = scriptedFetch([
      json(402, {}, { 'PAYMENT-REQUIRED': fixture.header }),
      json(200, OVERSIZED),
    ]);
    const authorizer = fakeAuthorizer('allow');
    const result = await runPay({ url: TENJIN_URL, resultSchema: SCHEMA }, makeCtx(), {
      ...PUBLIC_DNS,
      fetchImpl: fetch,
      provider: testWalletProvider(),
      authorizer,
    });
    const data = result.data as {
      paid: boolean;
      resultUnverified?: boolean;
      resultCaveat?: string;
      bodyText: string;
    };
    expect(data.paid).toBe(true);
    // The FLAG is what a machine branches on; the caveat is the prose beside it.
    expect(data.resultUnverified).toBe(true);
    // The body is delivered whole, not a preview of it.
    expect(data.bodyText).toBe(JSON.stringify(OVERSIZED));
    // The caveat states the byte count and that the check was skipped.
    expect(data.resultCaveat).toContain(String(Buffer.byteLength(JSON.stringify(OVERSIZED))));
    expect(data.resultCaveat).toContain('not checked');
    expect(data.resultCaveat).toContain('unverified');
    expect(result.humanLines?.some((line) => line.includes('unverified'))).toBe(true);
    // The ledger is unchanged by this: the money moved either way.
    expect(authorizer.commit).toHaveBeenCalledWith(RESERVATION, 100000n);
  });

  it('delivers a free 2xx too large to validate with the same caveat', async () => {
    const { fetch } = scriptedFetch([json(200, OVERSIZED)]);
    const result = await runPay({ url: TENJIN_URL, resultSchema: SCHEMA }, makeCtx(), {
      ...PUBLIC_DNS,
      fetchImpl: fetch,
    });
    const data = result.data as {
      paid: boolean;
      resultUnverified?: boolean;
      resultCaveat?: string;
    };
    expect(data.paid).toBe(false);
    expect(data.resultUnverified).toBe(true);
    expect(data.resultCaveat).toContain('not checked');
  });

  it('carries the transmitted amount on a paid failure, with settlement unknown', async () => {
    const fixture = buildPaymentRequired();
    const { fetch } = scriptedFetch([
      json(402, {}, { 'PAYMENT-REQUIRED': fixture.header }),
      json(500, { error: 'provider down' }),
    ]);
    const err = await runPay({ url: TENJIN_URL }, makeCtx(), {
      ...PUBLIC_DNS,
      fetchImpl: fetch,
      provider: testWalletProvider(),
      authorizer: fakeAuthorizer('allow'),
    }).catch((e: unknown) => e);
    expect((err as CliError).details).toMatchObject({
      amountAtomic: '100000',
      settlement: 'unknown',
    });
  });
});

// The paid leg's transport failures are post-transmission outcomes: the
// authorization has left and the reservation is committed, so the receipt owes
// the amount whatever the transport said.
describe('runPay, a transport failure after the payment was transmitted', () => {
  it('carries the amount and settlement unknown when the paid leg cannot be read', async () => {
    const fixture = buildPaymentRequired();
    let call = 0;
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      call += 1;
      if (!new Headers(init?.headers ?? {}).has('payment-signature')) {
        return new Response('{}', {
          status: 402,
          headers: { 'content-type': 'application/json', 'PAYMENT-REQUIRED': fixture.header },
        });
      }
      // The provider's own 402 was readable; its 200 is not, because its
      // headers overflow. The money has already gone either way.
      throw Object.assign(new TypeError('fetch failed'), {
        cause: new Error('Headers Overflow Error'),
      });
    }) as typeof fetch;
    const authorizer = fakeAuthorizer('allow');
    const err = await runPay({ url: TENJIN_URL }, makeCtx(), {
      ...PUBLIC_DNS,
      fetchImpl,
      provider: testWalletProvider(),
      authorizer,
    }).catch((e: unknown) => e);
    expect(call).toBe(2);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe('CHALLENGE_TOO_LARGE');
    expect((err as CliError).details).toMatchObject({
      amountAtomic: '100000',
      settlement: 'unknown',
    });
    expect((err as CliError).fix).not.toMatch(/nothing was (sent|paid)/i);
    expect((err as CliError).fix).toContain('authorization was transmitted');
    expect((err as CliError).fix).toContain('settlement is unknown');
    // The transport's remedy still rides along, after the leg's own sentence.
    expect((err as CliError).fix).toContain('--max-http-header-size');
    expect(authorizer.commit).toHaveBeenCalled();
  });

  it('still says nothing was paid when the PROBE is the leg that overflows', async () => {
    const fetchImpl = (async () => {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: new Error('Headers Overflow Error'),
      });
    }) as typeof fetch;
    const authorizer = fakeAuthorizer('allow');
    const err = await runPay({ url: TENJIN_URL }, makeCtx(), {
      ...PUBLIC_DNS,
      fetchImpl,
      provider: testWalletProvider(),
      authorizer,
    }).catch((e: unknown) => e);
    expect((err as CliError).code).toBe('CHALLENGE_TOO_LARGE');
    expect((err as CliError).fix).toContain('Nothing was sent and nothing was paid');
    expect((err as CliError).fix).toContain('--max-http-header-size');
    expect((err as CliError).details).toBeUndefined();
    expect(authorizer.commit).not.toHaveBeenCalled();
  });
});

/**
 * A 402 may advertise several entries in any order. CoinMarketCap's lists
 * seven with BNB chain first and the Base USDC entry third, so taking
 * `accepts[0]` compared an 18-decimal BNB entry against terms issued for Base
 * USDC and refused every quote before anything was signed.
 */
describe('runPay, a 402 that advertises several chains', () => {
  const BNB = '0x55d398326f99059fF775485246999027B3197955';
  const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const TERMS = { network: 'eip155:8453', asset: USDC_BASE, maxAmountAtomic: '10000' };

  /** Shaped like the live CoinMarketCap challenge: BNB first, Base USDC third. */
  function multiChain(over: Partial<PaymentRequirements>[] = []): string {
    const entry = (o: Partial<PaymentRequirements>): PaymentRequirements =>
      ({
        scheme: 'exact',
        network: 'eip155:56',
        asset: BNB,
        amount: '10000000000000000',
        payTo: '0x1111111111111111111111111111111111111111',
        maxTimeoutSeconds: 300,
        extra: { name: 'USD Coin', version: '2' },
        ...o,
      }) as PaymentRequirements;
    const accepts = [
      entry({}),
      entry({ asset: '0x2222222222222222222222222222222222222222' }),
      entry({ network: 'eip155:8453', asset: USDC_BASE, amount: '10000' }),
      entry({ network: 'eip155:137' }),
      ...over.map(entry),
    ];
    return buildPaymentRequired({}, { accepts } as never).header;
  }

  it('pays the entry the terms name, not the first one listed', async () => {
    await writeConfig();
    const { fetch, calls } = scriptedFetch([
      json(402, {}, { 'PAYMENT-REQUIRED': multiChain() }),
      json(200, { data: { BTC: 1 } }),
    ]);
    const result = await runPay({ url: FOREIGN_URL, terms: TERMS }, makeCtx(), {
      ...PUBLIC_DNS,
      fetchImpl: fetch,
      provider: testWalletProvider(),
      authorizer: fakeAuthorizer('allow'),
    });
    const data = result.data as { paid: boolean; amountPaid: { atomic: string }; network: string };
    expect(data.paid).toBe(true);
    // The Base USDC entry: 0.01, not the 18-decimal BNB amount listed first.
    expect(data.amountPaid.atomic).toBe('10000');
    expect(data.network).toBe('eip155:8453');
    expect(calls).toHaveLength(2);
  });

  it('signs the entry it checked, so the two can never be different deals', async () => {
    await writeConfig();
    const { fetch, calls } = scriptedFetch([
      json(402, {}, { 'PAYMENT-REQUIRED': multiChain() }),
      json(200, { ok: true }),
    ]);
    await runPay({ url: FOREIGN_URL, terms: TERMS }, makeCtx(), {
      ...PUBLIC_DNS,
      fetchImpl: fetch,
      provider: testWalletProvider(),
      authorizer: fakeAuthorizer('allow'),
    });
    const header = calls[1]!.headers['payment-signature']!;
    const payload = JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as {
      network?: string;
      accepted?: { network?: string };
    };
    expect(JSON.stringify(payload)).toContain('eip155:8453');
    expect(JSON.stringify(payload)).not.toContain('eip155:56');
  });

  it('refuses when no entry is on the advertised network and asset', async () => {
    await writeConfig();
    const { fetch, calls } = scriptedFetch([
      json(
        402,
        {},
        {
          'PAYMENT-REQUIRED': buildPaymentRequired({ network: 'eip155:56' as const, asset: BNB })
            .header,
        },
      ),
    ]);
    const authorizer = fakeAuthorizer('allow');
    const err = await runPay({ url: FOREIGN_URL, terms: TERMS }, makeCtx(), {
      ...PUBLIC_DNS,
      fetchImpl: fetch,
      provider: testWalletProvider(),
      authorizer,
    }).catch((e: unknown) => e);
    expect((err as CliError).code).toBe('REGISTRY_MISMATCH');
    expect((err as CliError).message).toContain('eip155:8453');
    expect(calls).toHaveLength(1);
    expect(authorizer.authorize).not.toHaveBeenCalled();
  });

  it('still refuses a MATCHING entry that costs more than advertised', async () => {
    await writeConfig();
    const { fetch } = scriptedFetch([
      json(
        402,
        {},
        {
          'PAYMENT-REQUIRED': multiChain([
            { network: 'eip155:8453', asset: USDC_BASE, amount: '99999' },
          ]),
        },
      ),
    ]);
    const err = await runPay(
      { url: FOREIGN_URL, terms: { ...TERMS, maxAmountAtomic: '9999' } },
      makeCtx(),
      { ...PUBLIC_DNS, fetchImpl: fetch, provider: testWalletProvider() },
    ).catch((e: unknown) => e);
    expect((err as CliError).code).toBe('REGISTRY_MISMATCH');
    expect((err as CliError).message).toContain('over the advertised');
  });

  it('checks payTo against the chosen entry when the terms pin one', async () => {
    await writeConfig();
    const { fetch } = scriptedFetch([json(402, {}, { 'PAYMENT-REQUIRED': multiChain() })]);
    const err = await runPay(
      {
        url: FOREIGN_URL,
        terms: { ...TERMS, payTo: '0x9999999999999999999999999999999999999999' },
      },
      makeCtx(),
      { ...PUBLIC_DNS, fetchImpl: fetch, provider: testWalletProvider() },
    ).catch((e: unknown) => e);
    expect((err as CliError).message).toContain('payTo');
  });

  it('leaves the no-terms lanes taking the first entry, as before', async () => {
    const { fetch } = scriptedFetch([
      json(402, {}, { 'PAYMENT-REQUIRED': buildPaymentRequired().header }),
      json(200, { ok: true }),
    ]);
    const result = await runPay({ url: TENJIN_URL }, makeCtx(), {
      ...PUBLIC_DNS,
      fetchImpl: fetch,
      provider: testWalletProvider(),
      authorizer: fakeAuthorizer('allow'),
    });
    expect((result.data as { amountPaid: { atomic: string } }).amountPaid.atomic).toBe('100000');
  });
});
