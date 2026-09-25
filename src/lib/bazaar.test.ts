import { afterEach, describe, expect, it, vi } from 'vitest';
import { sweepRegistries, verifyAgainstRegistries } from './bazaar';
import type { PaymentRequirements } from '@x402/core/types';
const UV = 'https://facilitator.ultravioletadao.xyz';
const URL = 'https://seller.example/search';
const LIVE: PaymentRequirements = {
  scheme: 'exact',
  network: 'eip155:8453',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  payTo: '0x1111111111111111111111111111111111111111',
  amount: '100000',
  maxTimeoutSeconds: 300,
  extra: {},
};
const item = (over: Record<string, unknown> = {}) => ({
  url: URL,
  type: 'http',
  x402Version: 2,
  accepts: [LIVE],
  lastUpdated: 1789054515,
  ...over,
});
function page(items: unknown[], offset = 0, total = items.length, limit = 100) {
  return Response.json({ items, pagination: { offset, total, limit } });
}
function stub(handler: (url: globalThis.URL) => Response | Promise<Response>) {
  const mock = vi.fn((input: string | globalThis.URL | Request) =>
    handler(new globalThis.URL(String(input))),
  );
  vi.stubGlobal('fetch', mock);
  return mock;
}
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Ultravioleta discovery adapter', () => {
  it('translates search to supported params, normalizes timestamps and filters resource types locally', async () => {
    const fetch = stub((url) => {
      expect(url.pathname).toBe('/discovery/resources');
      expect(Object.fromEntries(url.searchParams)).toEqual({
        q: 'search',
        limit: '100',
        offset: '0',
      });
      return page([item(), item({ type: 'mcp', url: 'https://seller.example/mcp' })]);
    });
    const sweep = await sweepRegistries([`${UV.toUpperCase()}/`], {
      timeoutMs: 1000,
      query: 'search',
    });
    expect(sweep.errors).toEqual([]);
    expect(sweep.skippedNonHttp).toBe(1);
    expect(sweep.resources).toEqual([
      {
        url: URL,
        registry: `${UV.toUpperCase()}/`,
        accepts: [LIVE],
        lastUpdated: new Date(1789054515 * 1000).toISOString(),
      },
    ]);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('sweeps without sending a type, payTo or q parameter', async () => {
    stub((url) => {
      expect([...url.searchParams.keys()]).toEqual(['limit', 'offset']);
      return page([item()]);
    });
    expect((await sweepRegistries([UV], { timeoutMs: 1000 })).resources).toHaveLength(1);
  });
  it('queries the exact identity and checks all candidates, including a later page', async () => {
    const fetch = stub((url) => {
      expect(url.searchParams.get('q')).toBe(URL);
      const offset = Number(url.searchParams.get('offset'));
      return offset === 0
        ? page([item({ url: `${URL}/nearby` })], 0, 2, 1)
        : page([item()], 1, 2, 1);
    });
    expect(await verifyAgainstRegistries([UV], `${URL}?q=a`, LIVE, 1000)).toEqual({
      outcome: 'verified',
      registry: UV,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each([
    [[]],
    [[item({ url: 'https://seller.example/' })]],
    [[item({ url: 'https://seller.example/{path}' })]],
    [[item({ url: `${URL}/other` })]],
  ])('does not treat nearby or template matches as an exact listing', async (items) => {
    stub(() => page(items));
    expect(await verifyAgainstRegistries([UV], URL, LIVE, 1000)).toEqual({ outcome: 'unlisted' });
  });
  it('preserves unsupported options instead of turning them into exact payment evidence', async () => {
    const unsupported = {
      ...LIVE,
      scheme: 'upto',
      network: 'eip155:43114',
      asset: 'other-token',
      amount: '800000',
      payTo: 'another-recipient',
    };
    stub(() => page([item({ accepts: [unsupported] })]));
    expect((await sweepRegistries([UV], { timeoutMs: 1000 })).resources[0]?.accepts).toEqual([
      unsupported,
    ]);
    expect(await verifyAgainstRegistries([UV], URL, LIVE, 1000)).toMatchObject({
      outcome: 'mismatch',
    });
  });
  it.each([
    { accepts: [{ ...LIVE, amount: undefined }] },
    { accepts: [{ ...LIVE, amount: null }] },
    { accepts: [{ ...LIVE, amount: '' }] },
    { accepts: [{ ...LIVE, amount: '-1' }] },
    { url: 'not-a-url' },
    { lastUpdated: '1789054515' },
    { lastUpdated: 1e30 },
    { accepts: null },
  ])('malformed record is unverifiable: %j', async (over) => {
    stub(() => page([item(over)]));
    expect(await verifyAgainstRegistries([UV], URL, LIVE, 1000)).toMatchObject({
      outcome: 'unavailable',
    });
  });
  it('reports bounded pagination as incomplete, never proof of no listing', async () => {
    const fetch = stub((url) =>
      page([item({ url: `${URL}/nearby` })], Number(url.searchParams.get('offset')), 1000, 1),
    );
    expect(await verifyAgainstRegistries([UV], URL, LIVE, 1000)).toMatchObject({
      outcome: 'unavailable',
      errors: [{ message: expect.stringContaining('truncated') }],
    });
    expect(fetch).toHaveBeenCalledTimes(5);
    const sweep = await sweepRegistries([UV], { timeoutMs: 1000 });
    expect(sweep.resources).toHaveLength(5);
    expect(sweep.errors).toHaveLength(1);
  });
  it('reports stalled or inconsistent pagination as incomplete', async () => {
    stub(() => page([], 0, 99));
    expect(await verifyAgainstRegistries([UV], URL, LIVE, 1000)).toMatchObject({
      outcome: 'unavailable',
    });
    stub(() => page([item()], 20, 99));
    expect(await verifyAgainstRegistries([UV], URL, LIVE, 1000)).toMatchObject({
      outcome: 'unavailable',
    });
  });
  it('bounds the whole lookup, including all registries, by one deadline', async () => {
    const fetch = stub(() => new Promise(() => {}));
    const start = Date.now();
    expect(
      await verifyAgainstRegistries([UV, 'https://another.test'], URL, LIVE, 30),
    ).toMatchObject({ outcome: 'unavailable' });
    expect(Date.now() - start).toBeLessThan(500);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('bounds response bytes before parsing', async () => {
    stub(() => new Response('x'.repeat(2 * 1024 * 1024 + 1)));
    expect(await verifyAgainstRegistries([UV], URL, LIVE, 1000)).toMatchObject({
      outcome: 'unavailable',
    });
  });
  it('ignores health and freshness as authorization evidence', async () => {
    stub(() =>
      page([
        item({
          accepts: [],
          health: { status: 'alive' },
          priceFreshness: 'fresh',
          observedTerms: { accepts: [LIVE] },
        }),
      ]),
    );
    expect(await verifyAgainstRegistries([UV], URL, LIVE, 1000)).toMatchObject({
      outcome: 'mismatch',
    });
  });
});

describe('standard registries', () => {
  const standard = {
    resource: URL,
    type: 'http',
    x402Version: 2,
    accepts: [LIVE],
    lastUpdated: '2026-09-24T00:00:00Z',
  };
  it('keeps CDP and custom search on the existing SDK route', async () => {
    const fetch = stub((url) => {
      expect(url.pathname).toBe('/discovery/search');
      expect(url.searchParams.has('q')).toBe(false);
      return Response.json({ resources: [standard] });
    });
    const sweep = await sweepRegistries(['https://api.cdp.coinbase.com', 'https://custom.test'], {
      query: 'weather',
      timeoutMs: 1000,
    });
    expect(sweep.errors).toEqual([]);
    expect(sweep.resources).toHaveLength(2);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('keeps PayAI fallback on SDK listResources with its recipient filter', async () => {
    const fetch = stub((url) => {
      if (url.pathname.endsWith('/search')) return new Response('', { status: 404 });
      expect(url.searchParams.get('type')).toBe('http');
      expect(url.searchParams.get('payTo')).toBe(LIVE.payTo);
      return page([standard]);
    });
    expect(
      await verifyAgainstRegistries(['https://facilitator.payai.network'], URL, LIVE, 1000),
    ).toMatchObject({ outcome: 'verified' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('a search with truncated results does not prove absence', async () => {
    stub(() => Response.json({ resources: [], partialResults: true }));
    expect(await verifyAgainstRegistries(['https://registry.test'], URL, LIVE, 1000)).toMatchObject(
      { outcome: 'unavailable' },
    );
  });
  it('an answered empty registry cannot hide another unavailable registry', async () => {
    stub((url) =>
      url.host === 'down.test'
        ? new Response('', { status: 503 })
        : Response.json({ resources: [] }),
    );
    expect(
      await verifyAgainstRegistries(['https://empty.test', 'https://down.test'], URL, LIVE, 1000),
    ).toMatchObject({ outcome: 'unavailable' });
  });
  it('pay-time search is by identity so a different listed recipient is a mismatch', async () => {
    stub((url) => {
      expect(url.searchParams.has('payTo')).toBe(false);
      return Response.json({
        resources: [
          {
            ...standard,
            accepts: [{ ...LIVE, payTo: '0x2222222222222222222222222222222222222222' }],
          },
        ],
      });
    });
    expect(await verifyAgainstRegistries(['https://registry.test'], URL, LIVE, 1000)).toMatchObject(
      { outcome: 'mismatch', detail: expect.stringContaining('payTo') },
    );
  });
});
