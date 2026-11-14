import { afterEach, describe, expect, it, vi } from 'vitest';
import { ORTHOGONAL_CATALOG_URL, searchOrthogonal } from './orthogonal-catalog';

afterEach(() => vi.unstubAllGlobals());

const speech = {
  name: 'Text to speech',
  method: 'POST',
  price: 'dynamic',
  description: 'Speech synthesis from text',
  bodyParams: [{ name: 'text', required: true, type: 'string' }],
  payment: { x402: { url: 'https://x402.orthogonal.com/voice/tts', chain: 'base', token: 'USDC' } },
};
const catalog = (endpoints: unknown[], hasMore = false) => ({
  success: true,
  apis: [{ name: 'Voice', endpoints }],
  pagination: { hasMore },
});

describe('manual provider catalogs', () => {
  it('reads only public metadata, ranks matching endpoints, and retains dynamic pricing and inputs', async () => {
    const fetch = vi.fn(async () =>
      Response.json(
        catalog([
          {
            ...speech,
            name: 'Weather',
            description: 'Forecast',
            payment: { x402: { url: 'https://x402.orthogonal.com/weather' } },
          },
          speech,
          speech,
          { ...speech, payment: null },
          { ...speech, payment: { x402: null } },
          { ...speech, name: null, path: '/voice/tts' },
        ]),
      ),
    );
    vi.stubGlobal('fetch', fetch);
    const result = await searchOrthogonal('speech synthesis', 1000);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(
      ORTHOGONAL_CATALOG_URL,
      expect.objectContaining({
        headers: { accept: 'application/json' },
        redirect: 'error',
      }),
    );
    expect(result.endpoints).toEqual([
      expect.objectContaining({
        url: speech.payment.x402.url,
        advertisedPrice: 'dynamic',
        input: { bodyParams: speech.bodyParams },
      }),
    ]);
    expect(result.partial).toBe(false);
    expect(result.errors).toEqual([]);
  });

  it('rejects foreign payment URLs and reports malformed catalog rows', async () => {
    vi.stubGlobal('fetch', async () =>
      Response.json(
        catalog([
          { ...speech, payment: { x402: { url: 'https://x402.orthogonal.com.evil.test/pay' } } },
          { ...speech, payment: { x402: { url: 'http://127.0.0.1/pay' } } },
          { ...speech, method: 'SHELL' },
        ]),
      ),
    );
    const result = await searchOrthogonal('', 1000);
    expect(result.endpoints).toEqual([]);
    expect(result.partial).toBe(true);
    expect(result.errors).not.toEqual([]);
  });

  it('bounds the shortlist and reports catalog pagination', async () => {
    vi.stubGlobal('fetch', async () =>
      Response.json(
        catalog(
          Array.from({ length: 25 }, (_, i) => ({
            ...speech,
            payment: { x402: { url: `https://x402.orthogonal.com/voice/${i}` } },
          })),
          true,
        ),
      ),
    );
    const result = await searchOrthogonal('speech', 1000);
    expect(result.endpoints).toHaveLength(20);
    expect(result.partial).toBe(true);
    expect(result.errors).toContain('Catalog has additional pages; coverage is partial');
  });

  it('returns a source failure without signing, following a redirect, or retrying', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 402 }));
    vi.stubGlobal('fetch', fetch);
    const result = await searchOrthogonal('speech', 1000);
    expect(fetch).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      endpoints: [],
      partial: true,
      errors: ['Catalog answered 402'],
    });
  });
});
