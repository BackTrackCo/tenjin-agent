import { describe, it, expect } from 'vitest';
import {
  buildLookupRequest,
  buildOutcomeItem,
  postLookup,
  postOutcomes,
  type LookupResponse,
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

const CANDIDATES: LookupResponse = {
  schemaVersion: 1,
  lookupId: '0197aaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
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

describe('buildLookupRequest', () => {
  it('builds a minimal request with the default limit', () => {
    expect(buildLookupRequest({ question: 'hi' })).toEqual({
      schemaVersion: 1,
      question: 'hi',
      limit: 5,
    });
  });
  it('trims the question and carries the optional gates', () => {
    const r = buildLookupRequest({
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
    expect(() => buildLookupRequest({ question: '   ' })).toThrowError(CliError);
  });
  it('rejects a question over 512 chars', () => {
    expect(() => buildLookupRequest({ question: 'x'.repeat(513) })).toThrowError(/512/);
  });
  it('rejects a malformed freshWithin', () => {
    expect(() => buildLookupRequest({ question: 'q', freshWithin: '30 days' })).toThrowError(
      /fresh/i,
    );
  });
  it('rejects a non-atomic maxPrice', () => {
    expect(() => buildLookupRequest({ question: 'q', maxPrice: '0.10' })).toThrowError(
      /max-price/i,
    );
  });
  it('rejects a limit outside 1-10', () => {
    expect(() => buildLookupRequest({ question: 'q', limit: 0 })).toThrowError(/limit/i);
    expect(() => buildLookupRequest({ question: 'q', limit: 11 })).toThrowError(/limit/i);
  });
  it('rejects a non-canonical appliesTo key', () => {
    expect(() =>
      buildLookupRequest({ question: 'q', appliesTo: { Products: ['x'] } }),
    ).toThrowError(/appliesTo key/);
  });
});

describe('postLookup', () => {
  it('POSTs the request with the client-attribution header and parses CANDIDATES', async () => {
    const { fetch, calls } = stubFetch(json(200, CANDIDATES));
    const res = await postLookup(buildLookupRequest({ question: 'q' }), {
      baseUrl: 'https://preview.example',
      timeoutMs: 5000,
      fetchImpl: fetch,
    });
    expect(res.decision).toBe('CANDIDATES');
    expect(calls[0]?.url).toBe('https://preview.example/api/agent/lookup');
    expect(calls[0]?.init.method).toBe('POST');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['x-tenjin-client']).toMatch(/^tenjin-cli\//);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      schemaVersion: 1,
      question: 'q',
      limit: 5,
    });
  });
  it('parses a MISS with no candidates', async () => {
    const { fetch } = stubFetch(
      json(200, { schemaVersion: 1, lookupId: 'x', decision: 'MISS', calibration: 'lexical-v1' }),
    );
    const res = await postLookup(buildLookupRequest({ question: 'q' }), {
      baseUrl: 'https://preview.example',
      timeoutMs: 5000,
      fetchImpl: fetch,
    });
    expect(res.decision).toBe('MISS');
    expect(res.candidates).toBeUndefined();
  });
  it('maps a 400 validation error to API_UNREACHABLE with the server message', async () => {
    const { fetch } = stubFetch(json(400, { error: { message: 'Invalid request body' } }));
    await expect(
      postLookup(buildLookupRequest({ question: 'q' }), {
        baseUrl: 'https://preview.example',
        timeoutMs: 5000,
        fetchImpl: fetch,
      }),
    ).rejects.toMatchObject({ code: 'API_UNREACHABLE' });
  });
  it('flags a contract mismatch when the body is not the expected shape', async () => {
    const { fetch } = stubFetch(json(200, { schemaVersion: 1, decision: 'MAYBE' }));
    await expect(
      postLookup(buildLookupRequest({ question: 'q' }), {
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
    const res = await postLookup(buildLookupRequest({ question: 'q' }), {
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
  const LOOKUP_ID = '0197aaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  it('POSTs a single outcome as an object (not an array) and returns accepted', async () => {
    const { fetch, calls } = stubFetch(json(202, { accepted: 1 }));
    const res = await postOutcomes(LOOKUP_ID, [buildOutcomeItem({ status: 'used' })], {
      baseUrl: 'https://preview.example',
      timeoutMs: 5000,
      fetchImpl: fetch,
    });
    expect(res.accepted).toBe(1);
    expect(calls[0]?.url).toBe(`https://preview.example/api/agent/lookups/${LOOKUP_ID}/outcomes`);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ status: 'used' });
  });
  it('POSTs a batch as an array', async () => {
    const { fetch, calls } = stubFetch(json(202, { accepted: 2 }));
    await postOutcomes(
      LOOKUP_ID,
      [buildOutcomeItem({ status: 'used' }), buildOutcomeItem({ status: 'rejected' })],
      { baseUrl: 'https://preview.example', timeoutMs: 5000, fetchImpl: fetch },
    );
    expect(Array.isArray(JSON.parse(String(calls[0]?.init.body)))).toBe(true);
  });
  it('rejects an invalid lookup id before any request', async () => {
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
      postOutcomes(LOOKUP_ID, items, {
        baseUrl: 'https://preview.example',
        timeoutMs: 5000,
        fetchImpl: fetch,
      }),
    ).rejects.toMatchObject({ code: 'USAGE' });
  });
});
