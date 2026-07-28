import { describe, it, expect } from 'vitest';
import {
  buildSearchRequest,
  buildOutcomeItem,
  postSearch,
  postOutcomes,
  type SearchResponse,
} from './agent-api';
import { CliError } from './errors';

interface Recorded {
  url: string;
  init: RequestInit;
}

/** A fetch stub that records the call and returns a canned Response. */
function stubFetch(response: Response): { fetch: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return response;
  }) as unknown as typeof fetch;
  return { fetch: fn, calls };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const CANDIDATES: SearchResponse = {
  schemaVersion: 1,
  searchId: '0197aaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  decision: 'CANDIDATES',
  calibration: 'lexical-v1',
  candidates: [
    {
      resourceId: '0197aaaa-bbbb-cccc-dddd-ffffffffffff',
      url: 'https://tenjin.blog/api/read/iris/slug',
      title: 'A resource',
      artifactType: 'document',
      price: '100000',
      asOf: null,
      validUntil: null,
      temporalMode: 'evergreen',
      appliesTo: { products: ['Vercel'] },
      questionsAnswered: ['q'],
      tasksSupported: [],
      scope: null,
      exclusions: null,
      matchReasons: ['answer-card lexical match'],
      estimatedTokens: 420,
      creator: { handle: 'iris' },
    },
  ],
};

describe('buildSearchRequest', () => {
  it('builds a minimal request with the default limit', () => {
    expect(buildSearchRequest({ question: 'hi' })).toEqual({
      schemaVersion: 1,
      question: 'hi',
      limit: 5,
    });
  });
  it('trims the question and carries the optional gates', () => {
    const r = buildSearchRequest({
      question: '  does it work?  ',
      freshWithin: 'P30D',
      maxPrice: '100000',
      appliesTo: { products: ['Vercel'] },
      limit: 3,
    });
    expect(r).toEqual({
      schemaVersion: 1,
      question: 'does it work?',
      freshWithin: 'P30D',
      maxPrice: '100000',
      appliesTo: { products: ['Vercel'] },
      limit: 3,
    });
  });
  it('rejects an empty question', () => {
    expect(() => buildSearchRequest({ question: '   ' })).toThrowError(CliError);
  });
  it('rejects a question over 512 chars', () => {
    expect(() => buildSearchRequest({ question: 'x'.repeat(513) })).toThrowError(/512/);
  });
  it('rejects a malformed freshWithin', () => {
    expect(() => buildSearchRequest({ question: 'q', freshWithin: '30 days' })).toThrowError(
      /fresh/i,
    );
  });
  it('rejects a non-atomic maxPrice', () => {
    expect(() => buildSearchRequest({ question: 'q', maxPrice: '0.10' })).toThrowError(
      /max-price/i,
    );
  });
  it('rejects a limit outside 1-10', () => {
    expect(() => buildSearchRequest({ question: 'q', limit: 0 })).toThrowError(/limit/i);
    expect(() => buildSearchRequest({ question: 'q', limit: 11 })).toThrowError(/limit/i);
  });
  it('rejects a non-canonical appliesTo key', () => {
    expect(() =>
      buildSearchRequest({ question: 'q', appliesTo: { Products: ['x'] } }),
    ).toThrowError(/appliesTo key/);
  });
});

describe('buildSearchRequest bounds (server strictObject mirror)', () => {
  it.each(['P0D', 'P0W', 'P00M', 'P0000Y'])('rejects the zero-valued window %s', (w) => {
    expect(() => buildSearchRequest({ question: 'q', freshWithin: w })).toThrowError(
      expect.objectContaining({ code: 'USAGE' }),
    );
  });

  it('rejects an applies-to value over 120 chars, an empty value, >20 values, and >8 keys', () => {
    expect(() =>
      buildSearchRequest({ question: 'q', appliesTo: { products: ['v'.repeat(121)] } }),
    ).toThrowError(expect.objectContaining({ code: 'USAGE' }));
    expect(() => buildSearchRequest({ question: 'q', appliesTo: { products: [''] } })).toThrowError(
      expect.objectContaining({ code: 'USAGE' }),
    );
    expect(() =>
      buildSearchRequest({
        question: 'q',
        appliesTo: { products: Array.from({ length: 21 }, (_, i) => `v${i}`) },
      }),
    ).toThrowError(expect.objectContaining({ code: 'USAGE' }));
    expect(() =>
      buildSearchRequest({
        question: 'q',
        appliesTo: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`key_${i}`, ['v']])),
      }),
    ).toThrowError(expect.objectContaining({ code: 'USAGE' }));
  });

  it('accepts a nonzero window and in-bounds appliesTo', () => {
    const body = buildSearchRequest({
      question: 'q',
      freshWithin: 'P30D',
      appliesTo: { products: ['Vercel'] },
    });
    expect(body.freshWithin).toBe('P30D');
    expect(body.appliesTo).toEqual({ products: ['Vercel'] });
  });
});

describe('postSearch', () => {
  it('POSTs the request with the client-attribution header and parses CANDIDATES', async () => {
    const { fetch, calls } = stubFetch(json(200, CANDIDATES));
    const res = await postSearch(buildSearchRequest({ question: 'q' }), {
      baseUrl: 'https://preview.example',
      timeoutMs: 5000,
      fetchImpl: fetch,
    });
    expect(res.decision).toBe('CANDIDATES');
    expect(calls[0]?.url).toBe('https://preview.example/api/agent/search');
    expect(calls[0]?.init.method).toBe('POST');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['x-tenjin-client']).toMatch(/^tenjin-cli\//);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      schemaVersion: 1,
      question: 'q',
      limit: 5,
    });
  });
  it('omits the eval-cohort header by default and sends it when opted in', async () => {
    const a = stubFetch(json(200, CANDIDATES));
    await postSearch(buildSearchRequest({ question: 'q' }), {
      baseUrl: 'https://preview.example',
      timeoutMs: 5000,
      fetchImpl: a.fetch,
    });
    const aHeaders = a.calls[0]?.init.headers as Record<string, string>;
    expect(aHeaders['x-tenjin-eval-cohort']).toBeUndefined();

    const b = stubFetch(json(200, CANDIDATES));
    await postSearch(buildSearchRequest({ question: 'q' }), {
      baseUrl: 'https://preview.example',
      timeoutMs: 5000,
      evalCohort: true,
      fetchImpl: b.fetch,
    });
    const bHeaders = b.calls[0]?.init.headers as Record<string, string>;
    expect(bHeaders['x-tenjin-eval-cohort']).toBe('1');
  });

  it('re-applies the server card bounds to an oversized candidate', async () => {
    const bloated = {
      ...CANDIDATES,
      candidates: [
        {
          ...(CANDIDATES.candidates?.[0] as object),
          title: 'T'.repeat(1000),
          scope: 'S'.repeat(1000),
          questionsAnswered: Array.from({ length: 50 }, () => 'q'.repeat(500)),
          matchReasons: Array.from({ length: 20 }, () => 'r'.repeat(300)),
          appliesTo: Object.fromEntries(
            Array.from({ length: 12 }, (_, i) => [
              `key_${i}`,
              Array.from({ length: 15 }, () => 'v'.repeat(200)),
            ]),
          ),
        },
      ],
    };
    const { fetch } = stubFetch(json(200, bloated));
    const res = await postSearch(buildSearchRequest({ question: 'q' }), {
      baseUrl: 'https://preview.example',
      timeoutMs: 5000,
      fetchImpl: fetch,
    });
    const c = res.candidates?.[0];
    expect(c?.title).toHaveLength(200);
    expect(c?.scope).toHaveLength(240);
    expect(c?.questionsAnswered).toHaveLength(4);
    expect(c?.questionsAnswered[0]).toHaveLength(160);
    expect(c?.matchReasons).toHaveLength(3);
    expect(c?.matchReasons[0]).toHaveLength(80);
    expect(Object.keys(c?.appliesTo ?? {})).toHaveLength(6);
    expect(Object.values(c?.appliesTo ?? {})[0]).toHaveLength(5);
  });

  it('parses a MISS with no candidates', async () => {
    const { fetch } = stubFetch(
      json(200, {
        schemaVersion: 1,
        searchId: '0197aaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        decision: 'MISS',
        calibration: 'lexical-v1',
      }),
    );
    const res = await postSearch(buildSearchRequest({ question: 'q' }), {
      baseUrl: 'https://preview.example',
      timeoutMs: 5000,
      fetchImpl: fetch,
    });
    expect(res.decision).toBe('MISS');
    expect(res.candidates).toBeUndefined();
  });

  const browsePointer = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    resourceId: '0197aaaa-bbbb-cccc-dddd-ffffffffffff',
    url: 'https://preview.example/api/read/alice/a-piece',
    title: 'A browsable piece',
    price: '250000',
    creator: { handle: 'alice' },
    ...over,
  });
  const miss = (browse: unknown[], decision = 'MISS'): unknown => ({
    schemaVersion: 1,
    searchId: '0197aaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    decision,
    calibration: 'hybrid-v1',
    browse,
  });
  const postMiss = async (body: unknown): Promise<SearchResponse> => {
    const { fetch } = stubFetch(json(200, body));
    return postSearch(buildSearchRequest({ question: 'q' }), {
      baseUrl: 'https://preview.example',
      timeoutMs: 5000,
      fetchImpl: fetch,
    });
  };

  it('re-applies the browse bounds: 4 pointers slice to BROWSE_MAX, a 5000-char title caps at 200', async () => {
    const res = await postMiss(
      miss([
        browsePointer({ title: 'T'.repeat(5000) }),
        browsePointer(),
        browsePointer(),
        browsePointer(),
      ]),
    );
    expect(res.browse).toHaveLength(3);
    expect(res.browse?.[0]?.title).toHaveLength(200);
  });

  it('drops unknown browse keys instead of passing them through to --json', async () => {
    // The schema is .passthrough() so the parse keeps a server-invented key; the
    // explicit projection in truncateResponse is what must strip it, or a future
    // `confidence` would reach agents as if it were a score.
    const res = await postMiss(miss([browsePointer({ confidence: 0.9, note: 'x'.repeat(9000) })]));
    expect(res.browse?.[0]).toEqual({
      resourceId: '0197aaaa-bbbb-cccc-dddd-ffffffffffff',
      url: 'https://preview.example/api/read/alice/a-piece',
      title: 'A browsable piece',
      price: '250000',
      creator: { handle: 'alice' },
    });
  });

  it('caps a runaway browse url and creator handle', async () => {
    const res = await postMiss(
      miss([
        browsePointer({
          url: `https://preview.example/${'u'.repeat(2000)}`,
          creator: { handle: 'h'.repeat(500) },
        }),
      ]),
    );
    expect(res.browse?.[0]?.url).toHaveLength(512);
    expect(res.browse?.[0]?.creator.handle).toHaveLength(64);
  });

  it('drops browse entirely on a CANDIDATES decision, where nothing would render it', async () => {
    const res = await postMiss({ ...(miss([browsePointer()], 'CANDIDATES') as object) });
    expect(res.decision).toBe('CANDIDATES');
    expect(res.browse).toBeUndefined();
  });

  it('fails the whole response when one browse pointer is malformed', async () => {
    // Deliberate and pinned: the client is fail-closed on every other contract
    // deviation, so a bad decorative tail surfaces as drift rather than being
    // silently dropped. Changing this to lenient is a product call, not a bugfix.
    await expect(
      postMiss(miss([browsePointer({ resourceId: 'not-a-uuid' })])),
    ).rejects.toMatchObject({ code: 'CONTRACT_MISMATCH' });
    await expect(postMiss(miss([browsePointer({ creator: undefined })]))).rejects.toMatchObject({
      code: 'CONTRACT_MISMATCH',
    });
  });

  it('maps a 400 validation error to API_UNREACHABLE with the server message', async () => {
    const { fetch } = stubFetch(json(400, { error: { message: 'Invalid request body' } }));
    await expect(
      postSearch(buildSearchRequest({ question: 'q' }), {
        baseUrl: 'https://preview.example',
        timeoutMs: 5000,
        fetchImpl: fetch,
      }),
    ).rejects.toMatchObject({ code: 'API_UNREACHABLE' });
  });
  it('flags a contract mismatch when the body is not the expected shape', async () => {
    const { fetch } = stubFetch(json(200, { schemaVersion: 1, decision: 'MAYBE' }));
    await expect(
      postSearch(buildSearchRequest({ question: 'q' }), {
        baseUrl: 'https://preview.example',
        timeoutMs: 5000,
        fetchImpl: fetch,
      }),
    ).rejects.toMatchObject({ code: 'CONTRACT_MISMATCH' });
  });
  it('keeps unknown future candidate fields (forward-compatible)', async () => {
    const withExtra = structuredClone(CANDIDATES);
    (withExtra.candidates![0] as Record<string, unknown>).futureField = 'keep me';
    const { fetch } = stubFetch(json(200, withExtra));
    const res = await postSearch(buildSearchRequest({ question: 'q' }), {
      baseUrl: 'https://preview.example',
      timeoutMs: 5000,
      fetchImpl: fetch,
    });
    expect((res.candidates?.[0] as Record<string, unknown>).futureField).toBe('keep me');
  });
});

describe('buildOutcomeItem', () => {
  it('accepts every valid status', () => {
    for (const status of [
      'used',
      'partially_used',
      'rejected',
      'regenerated',
      'purchase_declined',
    ]) {
      expect(buildOutcomeItem({ status }).status).toBe(status);
    }
  });
  it('rejects an unknown status', () => {
    expect(() => buildOutcomeItem({ status: 'loved-it' })).toThrowError(/status/i);
  });
  it('rejects a non-uuid resourceId', () => {
    expect(() => buildOutcomeItem({ status: 'used', resourceId: 'nope' })).toThrowError(
      /resource/i,
    );
  });
  it('rejects a malformed content hash', () => {
    expect(() => buildOutcomeItem({ status: 'used', contentHash: 'md5:abc' })).toThrowError(
      /hash/i,
    );
  });
});

describe('postOutcomes', () => {
  const SEARCH_ID = '0197aaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  it('POSTs a single outcome as an object (not an array) and returns accepted', async () => {
    const { fetch, calls } = stubFetch(json(202, { accepted: 1 }));
    const res = await postOutcomes(SEARCH_ID, [buildOutcomeItem({ status: 'used' })], {
      baseUrl: 'https://preview.example',
      timeoutMs: 5000,
      fetchImpl: fetch,
    });
    expect(res.accepted).toBe(1);
    expect(calls[0]?.url).toBe(`https://preview.example/api/agent/searches/${SEARCH_ID}/outcomes`);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ status: 'used' });
  });
  it('POSTs a batch as an array', async () => {
    const { fetch, calls } = stubFetch(json(202, { accepted: 2 }));
    await postOutcomes(
      SEARCH_ID,
      [buildOutcomeItem({ status: 'used' }), buildOutcomeItem({ status: 'rejected' })],
      { baseUrl: 'https://preview.example', timeoutMs: 5000, fetchImpl: fetch },
    );
    expect(Array.isArray(JSON.parse(String(calls[0]?.init.body)))).toBe(true);
  });
  it('rejects an invalid search id before any request', async () => {
    const { fetch, calls } = stubFetch(json(202, { accepted: 1 }));
    await expect(
      postOutcomes('not-a-uuid', [buildOutcomeItem({ status: 'used' })], {
        baseUrl: 'https://preview.example',
        timeoutMs: 5000,
        fetchImpl: fetch,
      }),
    ).rejects.toMatchObject({ code: 'USAGE' });
    expect(calls).toHaveLength(0);
  });
  it('rejects a batch over 10', async () => {
    const { fetch } = stubFetch(json(202, { accepted: 11 }));
    const items = Array.from({ length: 11 }, () => buildOutcomeItem({ status: 'used' }));
    await expect(
      postOutcomes(SEARCH_ID, items, {
        baseUrl: 'https://preview.example',
        timeoutMs: 5000,
        fetchImpl: fetch,
      }),
    ).rejects.toMatchObject({ code: 'USAGE' });
  });
});
