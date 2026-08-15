import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPay } from './pay';
import { saveSweepListings } from '../lib/bazaar';
import { CliError } from '../lib/errors';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import { parseSIWxHeader } from '@x402/extensions/sign-in-with-x';
import type { PaymentRequired } from '@x402/core/types';
import { buildPaymentRequired, testWalletProvider } from '../lib/read-test-utils';
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
    const result = await runPay({ url: TENJIN_URL }, makeCtx(), { fetchImpl: fetch });
    const data = result.data as { paid: boolean; status: number; body: unknown; lane: string };
    expect(data.paid).toBe(false);
    expect(data.status).toBe(200);
    expect(data.body).toEqual({ answer: 42 });
    expect(data.lane).toBe('tenjin');
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

  it('never attaches SIWX or session credentials', async () => {
    const fixture = buildPaymentRequired();
    const { fetch, calls } = scriptedFetch([
      json(402, {}, { 'PAYMENT-REQUIRED': fixture.header }),
      json(200, { ok: true }),
    ]);
    await runPay({ url: TENJIN_URL }, makeCtx(), {
      fetchImpl: fetch,
      provider: testWalletProvider(),
      authorizer: fakeAuthorizer('allow'),
    });
    for (const call of calls) {
      expect(Object.keys(call.headers)).not.toContain('sign-in-with-x');
      expect(Object.keys(call.headers)).not.toContain('tenjin-session-delegation');
    }
  });

  it('a 402 after payment is PAYMENT_FAILED and releases the reservation', async () => {
    const fixture = buildPaymentRequired();
    const { fetch } = scriptedFetch([
      json(402, {}, { 'PAYMENT-REQUIRED': fixture.header }),
      json(402, { error: 'rejected' }, { 'PAYMENT-REQUIRED': fixture.header }),
    ]);
    const authorizer = fakeAuthorizer('allow');
    await expect(
      runPay({ url: TENJIN_URL }, makeCtx(), {
        fetchImpl: fetch,
        provider: testWalletProvider(),
        authorizer,
      }),
    ).rejects.toMatchObject({ code: 'PAYMENT_FAILED' });
    expect(authorizer.release).toHaveBeenCalledWith(RESERVATION);
    expect(authorizer.commit).not.toHaveBeenCalled();
  });

  it('a policy deny is POLICY_REFUSED before any payment', async () => {
    const fixture = buildPaymentRequired();
    const { fetch, calls } = scriptedFetch([json(402, {}, { 'PAYMENT-REQUIRED': fixture.header })]);
    await expect(
      runPay({ url: TENJIN_URL }, makeCtx(), {
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
    await expect(runPay({ url: TENJIN_URL }, makeCtx(), { fetchImpl: fetch })).rejects.toThrow(
      /redirected/,
    );
  });

  it('a non-402 error status is API_UNREACHABLE', async () => {
    const { fetch } = scriptedFetch([json(500, { error: 'boom' })]);
    await expect(
      runPay({ url: TENJIN_URL }, makeCtx(), { fetchImpl: fetch }),
    ).rejects.toMatchObject({ code: 'API_UNREACHABLE' });
  });

  it('a 402 with no PAYMENT-REQUIRED header is CONTRACT_MISMATCH', async () => {
    const { fetch } = scriptedFetch([json(402, { error: 'pay' })]);
    await expect(
      runPay({ url: TENJIN_URL }, makeCtx(), { fetchImpl: fetch }),
    ).rejects.toMatchObject({ code: 'CONTRACT_MISMATCH' });
  });
});

/** A challenge advertising the standard sign-in-with-x extension. */
function siwxFixture(url: string, amount = '100000'): { header: string } {
  const paymentRequired: PaymentRequired = {
    x402Version: 2,
    resource: { url, description: 'paid', mimeType: 'application/json' },
    accepts: [{ ...LIVE_ACCEPT, amount } as never],
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
      runPay({ url: TENJIN_URL, data: 'not json' }, makeCtx(), { fetchImpl: fetch }),
    ).rejects.toMatchObject({ code: 'USAGE' });
    expect(calls).toHaveLength(0);
  });

  it('rejects GET with a body, and unsupported methods', async () => {
    const { fetch } = scriptedFetch([]);
    await expect(
      runPay({ url: TENJIN_URL, method: 'GET', data: '{}' }, makeCtx(), { fetchImpl: fetch }),
    ).rejects.toMatchObject({ code: 'USAGE' });
    await expect(
      runPay({ url: TENJIN_URL, method: 'DELETE' }, makeCtx(), { fetchImpl: fetch }),
    ).rejects.toMatchObject({ code: 'USAGE' });
  });
});

describe('runPay, bazaar lane', () => {
  it('refuses a foreign origin while the toggle is off, before any network', async () => {
    const { fetch, calls } = scriptedFetch([]);
    await expect(
      runPay({ url: FOREIGN_URL }, makeCtx(), { fetchImpl: fetch }),
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
      runPay({ url: FOREIGN_URL }, makeCtx(), { fetchImpl: fetch, provider }),
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
      runPay({ url: FOREIGN_URL }, makeCtx(), { fetchImpl: fetch }),
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
      runPay({ url: FOREIGN_URL }, makeCtx(), { fetchImpl: fetch }),
    ).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });

  it('the bazaar lane refuses plain http', async () => {
    await writeConfig();
    const { fetch, calls } = scriptedFetch([]);
    await expect(
      runPay({ url: 'http://seller.example/api' }, makeCtx(), { fetchImpl: fetch }),
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
      { fetchImpl: fetch, provider: testWalletProvider(), authorizer: fakeAuthorizer('allow') },
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
      runPay({ url: FOREIGN_URL }, makeCtx(), { fetchImpl: fetch }),
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
      runPay({ url: FOREIGN_URL }, makeCtx(), { fetchImpl: fetch }),
    ).rejects.toMatchObject({ code: 'REGISTRY_MISMATCH' });
  });

  it('the toggle-off fix names the operator act, never the URL that failed', async () => {
    const { fetch } = scriptedFetch([]);
    try {
      await runPay({ url: FOREIGN_URL }, makeCtx(), { fetchImpl: fetch });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).fix).toContain('tenjin config set bazaarPay on');
      expect((err as CliError).fix).not.toContain('seller.example');
    }
  });
});
