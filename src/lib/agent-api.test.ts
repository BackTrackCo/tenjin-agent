import { describe, it, expect } from 'vitest';
import {
  buildSearchRequest,
  buildOutcomeItem,
  getLookupStats,
  getPostMetadata,
  postSearch,
  postOutcomes,
  type SearchResult,
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

/** A v3 decision-view result with one match. `items` replaces v2's `candidates`
 *  and `matched` replaces the `decision` word; the per-item projection is
 *  unchanged, which is why the candidate literal below is verbatim what v2 sent. */
const RESULT: SearchResult = {
  schemaVersion: 3,
  searchId: '0197aaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  calibration: 'lexical-v1',
  matched: 1,
  items: [
    {
      resourceId: '0197aaaa-bbbb-cccc-dddd-ffffffffffff',
      url: 'https://tenjin.blog/api/read/iris/slug',
      slug: 'slug',
      title: 'A resource',
      artifactType: 'document',
      price: '100000',
      asOf: null,
      validUntil: null,
      matchReasons: ['answer-card lexical match'],
      estimatedTokens: 420,
      creator: { handle: 'iris' },
    },
  ],
};

/** A v3 miss: nothing matched, so `items` is empty and `hint` says where to
 *  browse. There is no second envelope shape to branch on. */
const MISS: SearchResult = {
  schemaVersion: 3,
  searchId: '0197aaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  calibration: 'hybrid-v1',
  matched: 0,
  items: [],
  hint: 'No matches. Browse the catalog at GET /api/articles.',
};

describe('buildSearchRequest', () => {
  it('builds a minimal request with the default limit', () => {
    expect(buildSearchRequest({ question: 'hi' })).toEqual({
      schemaVersion: 3,
      view: 'decision',
      query: 'hi',
      limit: 5,
      trigger: 'cli',
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
    // The three narrowings ride UNDER `filters` in v3. A top-level spelling is
    // not a 400 server-side, it is STRIPPED into `warnings` and the search runs
    // unfiltered, so where they sit is the difference between a price cap and no
    // price cap at all.
    expect(r).toEqual({
      schemaVersion: 3,
      view: 'decision',
      query: 'does it work?',
      filters: {
        freshWithin: 'P30D',
        maxPrice: '100000',
        appliesTo: { products: ['Vercel'] },
      },
      limit: 3,
      trigger: 'cli',
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
    expect(body.filters?.freshWithin).toBe('P30D');
    expect(body.filters?.appliesTo).toEqual({ products: ['Vercel'] });
  });

  it('omits `filters` entirely when nothing narrows', () => {
    // `{}` is a filter set that filters nothing; sending it only invites a server
    // to read meaning into an empty object.
    expect(buildSearchRequest({ question: 'q' })).not.toHaveProperty('filters');
  });
});

describe('postSearch', () => {
  it('POSTs the v3 body to /api/search with the tenjin-cli User-Agent, never X-Tenjin-Client', async () => {
    const { fetch, calls } = stubFetch(json(200, RESULT));
    const res = await postSearch(buildSearchRequest({ question: 'q' }), {
      baseUrl: 'https://preview.example',
      timeoutMs: 5000,
      fetchImpl: fetch,
    });
    expect(res.matched).toBe(1);
    expect(res.items).toHaveLength(1);
    // The alias is gone: nothing in this client still calls /api/agent/search.
    expect(calls[0]?.url).toBe('https://preview.example/api/search');
    expect(calls[0]?.init.method).toBe('POST');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['user-agent']).toMatch(/^tenjin-cli\//);
    expect(headers['x-tenjin-client']).toBeUndefined();
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      schemaVersion: 3,
      view: 'decision',
      query: 'q',
      limit: 5,
      trigger: 'cli',
    });
  });

  it('names `view` explicitly rather than leaning on the server default', async () => {
    // The server defaults `view` to `decision`, but a default is the server's to
    // change and this client parses exactly one projection. Pin that it is sent.
    const { fetch, calls } = stubFetch(json(200, RESULT));
    await postSearch(buildSearchRequest({ question: 'q' }), {
      baseUrl: 'https://preview.example',
      timeoutMs: 5000,
      fetchImpl: fetch,
    });
    expect(JSON.parse(String(calls[0]?.init.body)).view).toBe('decision');
  });

  it('sends the documented `query` spelling, not the compatibility aliases', async () => {
    // `question` and `q` still resolve server-side, but they are undocumented
    // compatibility and the loser spellings come back in `warnings`. A client
    // written today sends what the contract publishes.
    const { fetch, calls } = stubFetch(json(200, RESULT));
    await postSearch(buildSearchRequest({ question: 'does it work?' }), {
      baseUrl: 'https://preview.example',
      timeoutMs: 5000,
      fetchImpl: fetch,
    });
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body.query).toBe('does it work?');
    expect(body).not.toHaveProperty('question');
    expect(body).not.toHaveProperty('q');
  });

  it('nests the narrowings under `filters` on the wire', async () => {
    const { fetch, calls } = stubFetch(json(200, RESULT));
    await postSearch(
      buildSearchRequest({ question: 'q', maxPrice: '100000', freshWithin: 'P30D' }),
      { baseUrl: 'https://preview.example', timeoutMs: 5000, fetchImpl: fetch },
    );
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body.filters).toEqual({ freshWithin: 'P30D', maxPrice: '100000' });
    expect(body).not.toHaveProperty('maxPrice');
    expect(body).not.toHaveProperty('freshWithin');
  });

  it('omits the eval-cohort header by default and sends it when opted in', async () => {
    const a = stubFetch(json(200, RESULT));
    await postSearch(buildSearchRequest({ question: 'q' }), {
      baseUrl: 'https://preview.example',
      timeoutMs: 5000,
      fetchImpl: a.fetch,
    });
    const aHeaders = a.calls[0]?.init.headers as Record<string, string>;
    expect(aHeaders['x-tenjin-eval-cohort']).toBeUndefined();

    const b = stubFetch(json(200, RESULT));
    await postSearch(buildSearchRequest({ question: 'q' }), {
      baseUrl: 'https://preview.example',
      timeoutMs: 5000,
      evalCohort: true,
      fetchImpl: b.fetch,
    });
    const bHeaders = b.calls[0]?.init.headers as Record<string, string>;
    expect(bHeaders['x-tenjin-eval-cohort']).toBe('1');
  });

  it('re-applies the server bounds to an oversized item, but never to the slug', async () => {
    const runawaySlug = 's'.repeat(4000);
    const bloated = {
      ...RESULT,
      items: [
        {
          ...(RESULT.items[0] as object),
          title: 'T'.repeat(1000),
          slug: runawaySlug,
          matchReasons: Array.from({ length: 20 }, () => 'r'.repeat(300)),
        },
      ],
    };
    const { fetch } = stubFetch(json(200, bloated));
    const res = await postSearch(buildSearchRequest({ question: 'q' }), {
      baseUrl: 'https://preview.example',
      timeoutMs: 5000,
      fetchImpl: fetch,
    });
    const c = res.items[0];
    expect(c?.title).toHaveLength(200);
    expect(c?.matchReasons).toHaveLength(3);
    expect(c?.matchReasons[0]).toHaveLength(80);
    // A clipped slug is not a shorter slug, it is a different one that resolves
    // to nothing while still reading as usable in --json. The server tolerates an
    // uncapped slug for the same reason, which is the one case `truncated` exists
    // for, so capping here would reject a response the server calls valid.
    expect(c?.slug).toBe(runawaySlug);
  });

  it('carries the optional truncated flag through, and omits it when unset', async () => {
    const { fetch } = stubFetch(json(200, { ...RESULT, truncated: true }));
    const res = await postSearch(buildSearchRequest({ question: 'q' }), {
      baseUrl: 'https://preview.example',
      timeoutMs: 5000,
      fetchImpl: fetch,
    });
    expect(res.truncated).toBe(true);

    const clean = stubFetch(json(200, RESULT));
    const res2 = await postSearch(buildSearchRequest({ question: 'q' }), {
      baseUrl: 'https://preview.example',
      timeoutMs: 5000,
      fetchImpl: clean.fetch,
    });
    expect(res2.truncated).toBeUndefined();
  });

  it('parses a miss as an empty result carrying the browse hint', async () => {
    const { fetch } = stubFetch(json(200, MISS));
    const res = await postSearch(buildSearchRequest({ question: 'q' }), {
      baseUrl: 'https://preview.example',
      timeoutMs: 5000,
      fetchImpl: fetch,
    });
    expect(res.matched).toBe(0);
    expect(res.items).toEqual([]);
    expect(res.hint).toBe('No matches. Browse the catalog at GET /api/articles.');
  });

  it('bounds the server-authored hint like every other rendered string', async () => {
    const { fetch } = stubFetch(json(200, { ...MISS, hint: 'h'.repeat(9000) }));
    const res = await postSearch(buildSearchRequest({ question: 'q' }), {
      baseUrl: 'https://preview.example',
      timeoutMs: 5000,
      fetchImpl: fetch,
    });
    expect(res.hint).toHaveLength(200);
  });

  it('strips a browse tail a server invents: v3 has none, so nothing renders it', async () => {
    // The v2 MISS tail is gone from the contract. The envelope schema is a plain
    // z.object, so a resurrected `browse` array is dropped rather than carried
    // into --json where an agent could mistake a pointer for a scored candidate.
    const { fetch } = stubFetch(
      json(200, {
        ...MISS,
        browse: [
          {
            resourceId: '0197aaaa-bbbb-cccc-dddd-ffffffffffff',
            url: 'https://preview.example/api/read/alice/a-piece',
            title: 'A browsable piece',
            price: '250000',
            creator: { handle: 'alice' },
          },
        ],
      }),
    );
    const res = await postSearch(buildSearchRequest({ question: 'q' }), {
      baseUrl: 'https://preview.example',
      timeoutMs: 5000,
      fetchImpl: fetch,
    });
    expect(res).not.toHaveProperty('browse');
  });

  it('strips `inspect` and `warnings`, which are real fields this CLI does not render', async () => {
    // Both are contract fields; neither has a renderer here, and both carry
    // unbounded server text. Declaring them would put that text into --json and
    // into an agent transcript with nothing to display it.
    const { fetch } = stubFetch(
      json(200, { ...RESULT, inspect: { resourceId: 'x' }, warnings: ['maxPrise'] }),
    );
    const res = await postSearch(buildSearchRequest({ question: 'q' }), {
      baseUrl: 'https://preview.example',
      timeoutMs: 5000,
      fetchImpl: fetch,
    });
    expect(res).not.toHaveProperty('inspect');
    expect(res).not.toHaveProperty('warnings');
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
    const { fetch } = stubFetch(json(200, { schemaVersion: 3, matched: 'lots' }));
    await expect(
      postSearch(buildSearchRequest({ question: 'q' }), {
        baseUrl: 'https://preview.example',
        timeoutMs: 5000,
        fetchImpl: fetch,
      }),
    ).rejects.toMatchObject({ code: 'CONTRACT_MISMATCH' });
  });

  it('names the outdated server when the deployment has no /api/search route at all', async () => {
    // The arm that fires in practice against a stale deploy: POST /api/search did
    // not exist before #137, so the Next router answers 404 with nothing
    // contract-shaped. Routed as API_UNREACHABLE the operator is told to retry a
    // path that will never exist on that server.
    const { fetch } = stubFetch(json(404, { error: 'Not Found' }));
    await expect(
      postSearch(buildSearchRequest({ question: 'q' }), {
        baseUrl: 'https://preview.example',
        timeoutMs: 5000,
        fetchImpl: fetch,
      }),
    ).rejects.toMatchObject({
      code: 'CONTRACT_MISMATCH',
      message: expect.stringContaining('predates search v3'),
    });
  });

  it('names the outdated server when a pre-v3 deployment refuses the request', async () => {
    // The REQUEST gate: a server that HAS the route but pins an older
    // `schemaVersion` dies before the handler runs. Two spellings are read,
    // because the two surfaces report differently — the v2 alias emits a zod
    // `flatten()` under `error.details.fieldErrors`, the v3 route lists sentences
    // under `error.details.problems`. Both are keyed on the FIELD name, never on
    // message wording.
    const fieldErrors = stubFetch(
      json(400, {
        error: {
          code: 'validation_failed',
          message: 'Invalid request body',
          details: {
            formErrors: [],
            fieldErrors: { schemaVersion: ['Invalid input: expected 2'] },
          },
        },
      }),
    );
    await expect(
      postSearch(buildSearchRequest({ question: 'q' }), {
        baseUrl: 'https://preview.example',
        timeoutMs: 5000,
        fetchImpl: fieldErrors.fetch,
      }),
    ).rejects.toMatchObject({
      code: 'CONTRACT_MISMATCH',
      message: expect.stringContaining('schemaVersion 3'),
    });

    const problems = stubFetch(
      json(400, {
        error: {
          code: 'validation_failed',
          message: 'schemaVersion must be 2',
          details: { problems: ['schemaVersion must be 2'] },
        },
      }),
    );
    await expect(
      postSearch(buildSearchRequest({ question: 'q' }), {
        baseUrl: 'https://preview.example',
        timeoutMs: 5000,
        fetchImpl: problems.fetch,
      }),
    ).rejects.toMatchObject({
      code: 'CONTRACT_MISMATCH',
      message: expect.stringContaining('schemaVersion 3'),
    });
  });

  it('leaves an unrelated 400 on the API_UNREACHABLE path', async () => {
    // The version arm keys on a `schemaVersion` complaint, so an ordinary
    // validation failure must not be mistaken for a stale deployment — in either
    // of the two 400 shapes.
    const { fetch } = stubFetch(
      json(400, {
        error: {
          code: 'validation_failed',
          message: 'Invalid request body',
          details: {
            formErrors: [],
            fieldErrors: { query: ['Too big: expected <=512'] },
            problems: ['query must be at most 512 characters'],
          },
        },
      }),
    );
    await expect(
      postSearch(buildSearchRequest({ question: 'q' }), {
        baseUrl: 'https://preview.example',
        timeoutMs: 5000,
        fetchImpl: fetch,
      }),
    ).rejects.toMatchObject({ code: 'API_UNREACHABLE' });
  });

  it('names the version when a server answers 200 with the v2 alias envelope', async () => {
    // A base URL still pointed at the deprecated alias answers 200 with
    // `decision` + `candidates` and schemaVersion 2. `items` is required here, so
    // that is a parse REFUSAL — and the version it served is named rather than
    // reported as an anonymous shape mismatch.
    const { fetch } = stubFetch(
      json(200, {
        schemaVersion: 2,
        searchId: RESULT.searchId,
        decision: 'CANDIDATES',
        calibration: 'lexical-v1',
        candidates: RESULT.items,
      }),
    );
    await expect(
      postSearch(buildSearchRequest({ question: 'q' }), {
        baseUrl: 'https://preview.example',
        timeoutMs: 5000,
        fetchImpl: fetch,
      }),
    ).rejects.toMatchObject({
      code: 'CONTRACT_MISMATCH',
      message: expect.stringContaining('schemaVersion 2'),
    });
  });

  it('keeps unknown future item fields (forward-compatible)', async () => {
    const withExtra = structuredClone(RESULT);
    (withExtra.items[0] as Record<string, unknown>).futureField = 'keep me';
    const { fetch } = stubFetch(json(200, withExtra));
    const res = await postSearch(buildSearchRequest({ question: 'q' }), {
      baseUrl: 'https://preview.example',
      timeoutMs: 5000,
      fetchImpl: fetch,
    });
    expect((res.items[0] as Record<string, unknown>).futureField).toBe('keep me');
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
    expect(calls[0]?.url).toBe(`https://preview.example/api/searches/${SEARCH_ID}/outcomes`);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ status: 'used' });
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['user-agent']).toMatch(/^tenjin-cli\//);
    expect(headers['x-tenjin-client']).toBeUndefined();
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

describe('getLookupStats', () => {
  const STATS = {
    windowDays: 7,
    triggers: [
      { trigger: 'prompt', lookups: 12, hits: 3, candidates: 7, used: 1, wrong: 2, useRate: 1 / 3 },
      { trigger: 'read', lookups: 4, hits: 0, candidates: 0, used: 0, wrong: 0, useRate: null },
    ],
  };

  it('GETs the window and parses the per-trigger rollup', async () => {
    const { fetch, calls } = stubFetch(json(200, STATS));
    const stats = await getLookupStats(7, {
      baseUrl: 'https://preview.example/',
      timeoutMs: 5000,
      fetchImpl: fetch,
    });
    expect(calls[0]?.url).toBe('https://preview.example/api/lookups/stats?days=7');
    expect(calls[0]?.init.method).toBe('GET');
    expect(stats.windowDays).toBe(7);
    expect(stats.triggers[0]).toMatchObject({ trigger: 'prompt', lookups: 12, used: 1 });
    // A trigger nothing has judged reports a null rate rather than a zero, so a
    // shelf with no reuse yet is not rendered as a shelf nobody reuses.
    expect(stats.triggers[1]?.useRate).toBeNull();
  });

  /** `push status` renders "unavailable" from a throw; a shelf that is down must
   *  not read as a shelf with no demand. */
  it('throws rather than reporting zeros when the shelf answers badly', async () => {
    const notFound = stubFetch(json(404, { error: 'nope' }));
    await expect(
      getLookupStats(7, {
        baseUrl: 'https://preview.example',
        timeoutMs: 5000,
        fetchImpl: notFound.fetch,
      }),
    ).rejects.toBeInstanceOf(CliError);

    const garbage = stubFetch(json(200, { windowDays: 7 }));
    await expect(
      getLookupStats(7, {
        baseUrl: 'https://preview.example',
        timeoutMs: 5000,
        fetchImpl: garbage.fetch,
      }),
    ).rejects.toMatchObject({ code: 'CONTRACT_MISMATCH' });
  });

  /**
   * `trigger` is the one field of this response that gets PRINTED, and the shelf
   * chooses it. An unbounded string is a shelf-controlled write to the
   * operator's terminal, so a name that is not one is a contract mismatch and
   * the block renders "unavailable" instead.
   */
  it('refuses a trigger name that is not a short lowercase word', async () => {
    for (const trigger of ['x'.repeat(17), 'Prompt', 'pro mpt', '\u001b[2Jprompt', '']) {
      const bad = stubFetch(
        json(200, {
          windowDays: 7,
          triggers: [
            { trigger, lookups: 1, hits: 0, candidates: 0, used: 0, wrong: 0, useRate: null },
          ],
        }),
      );
      await expect(
        getLookupStats(7, {
          baseUrl: 'https://preview.example',
          timeoutMs: 5000,
          fetchImpl: bad.fetch,
        }),
        trigger,
      ).rejects.toMatchObject({ code: 'CONTRACT_MISMATCH' });
    }
  });

  /**
   * tenjin-agent#252: `GET /api/lookups/stats` is cached server-side for
   * several minutes, and the response's own `Age` header is the only thing
   * that says so — a stale zero-`used` count otherwise reads as "grading
   * never reached the shelf" rather than "the cache has not turned over yet".
   */
  it('captures the Age response header as ageSeconds', async () => {
    const res = new Response(JSON.stringify(STATS), {
      status: 200,
      headers: { 'content-type': 'application/json', age: '137' },
    });
    const { fetch } = stubFetch(res);
    const stats = await getLookupStats(7, {
      baseUrl: 'https://preview.example',
      timeoutMs: 5000,
      fetchImpl: fetch,
    });
    expect(stats.ageSeconds).toBe(137);
  });

  /** Absent, never coerced to 0 — a freshness claim this CLI was never told. */
  it('leaves ageSeconds undefined with no Age header', async () => {
    const { fetch } = stubFetch(json(200, STATS));
    const stats = await getLookupStats(7, {
      baseUrl: 'https://preview.example',
      timeoutMs: 5000,
      fetchImpl: fetch,
    });
    expect(stats.ageSeconds).toBeUndefined();
  });

  /**
   * PR 277 review: `Number(raw)` alone accepts everything `Age` never
   * legitimately carries. An empty header is the sharpest case — some proxies
   * emit `Age: ""`, and `Number('') === 0` reads as a freshly-served answer,
   * exactly inverting the signal this field exists to give.
   */
  it.each([
    ['', 'empty'],
    ['   ', 'whitespace-only'],
    ['0x10', 'hex'],
    ['+5', 'leading plus'],
    ['1e300', 'exponent'],
    ['1.5', 'fractional'],
    ['-1', 'negative'],
    ['12abc', 'trailing garbage'],
  ])('leaves ageSeconds undefined for a non-integer Age header: %s (%s)', async (raw) => {
    const res = new Response(JSON.stringify(STATS), {
      status: 200,
      headers: { 'content-type': 'application/json', age: raw },
    });
    const { fetch } = stubFetch(res);
    const stats = await getLookupStats(7, {
      baseUrl: 'https://preview.example',
      timeoutMs: 5000,
      fetchImpl: fetch,
    });
    expect(stats.ageSeconds).toBeUndefined();
  });

  it('accepts a zero Age header (a genuinely fresh read, not the empty-string default)', async () => {
    const res = new Response(JSON.stringify(STATS), {
      status: 200,
      headers: { 'content-type': 'application/json', age: '0' },
    });
    const { fetch } = stubFetch(res);
    const stats = await getLookupStats(7, {
      baseUrl: 'https://preview.example',
      timeoutMs: 5000,
      fetchImpl: fetch,
    });
    expect(stats.ageSeconds).toBe(0);
  });

  /**
   * PR 277 round-2 review, nit 3: the digit-only shape check has no length
   * cap of its own, so `Age: "99999999999999999999999999"` still parsed and
   * rendered as "~1e+26s ago" — a proxy sending an absurd value should read as
   * unparseable, not as a freshness claim past any real cache lifetime.
   */
  it('leaves ageSeconds undefined for an Age header past the sanity cap', async () => {
    const res = new Response(JSON.stringify(STATS), {
      status: 200,
      headers: { 'content-type': 'application/json', age: '99999999999999999999999999' },
    });
    const { fetch } = stubFetch(res);
    const stats = await getLookupStats(7, {
      baseUrl: 'https://preview.example',
      timeoutMs: 5000,
      fetchImpl: fetch,
    });
    expect(stats.ageSeconds).toBeUndefined();
  });

  it('accepts an Age header at the sanity cap boundary', async () => {
    const res = new Response(JSON.stringify(STATS), {
      status: 200,
      headers: { 'content-type': 'application/json', age: '10000000' },
    });
    const { fetch } = stubFetch(res);
    const stats = await getLookupStats(7, {
      baseUrl: 'https://preview.example',
      timeoutMs: 5000,
      fetchImpl: fetch,
    });
    expect(stats.ageSeconds).toBe(10000000);
  });

  /** A pattern rather than the arm names, so a shelf that grows an arm still
   *  renders instead of failing the whole block. */
  it('accepts an arm name this build has never heard of', async () => {
    const { fetch } = stubFetch(
      json(200, {
        windowDays: 7,
        triggers: [
          { trigger: 'newarm', lookups: 1, hits: 1, candidates: 1, used: 1, wrong: 0, useRate: 1 },
        ],
      }),
    );
    const stats = await getLookupStats(7, {
      baseUrl: 'https://preview.example',
      timeoutMs: 5000,
      fetchImpl: fetch,
    });
    expect(stats.triggers[0]?.trigger).toBe('newarm');
  });
});

/**
 * PR 277 round-2 review, nit on state-store.ts:4132: `findPairingCandidate`
 * used to synthesize `title: ''` / `price: '0'` for a `pairing_post` link
 * missing them — a false default a future spend-check could have trusted.
 * `getPostMetadata` is the replacement: `GET /api/posts/<id>/public`
 * (tenjin PR #803), a sibling of the owner-scoped-SIWX `GET /api/posts/<id>`
 * route, serving `articleBase()`'s shape for PUBLISHED posts only — `handle`
 * lives under `creator`, not at the top level. It must never invent a value,
 * so every failure mode (404, any other non-200, a network error, or a body
 * this CLI cannot read) collapses to the same `null`.
 */
describe('getPostMetadata', () => {
  const POST = {
    id: '11111111-1111-4111-8111-111111111111',
    slug: 'fix-pnpm-enoent',
    title: 'Fix: pnpm — ENOENT',
    price: '100000',
    status: 'published',
    creator: { handle: 'iris' },
  };

  it('GETs the post by id off the /public sibling route and returns its title and price', async () => {
    const { fetch, calls } = stubFetch(json(200, POST));
    const meta = await getPostMetadata(POST.id, {
      baseUrl: 'https://preview.example/',
      timeoutMs: 5000,
      fetchImpl: fetch,
    });
    expect(calls[0]?.url).toBe(`https://preview.example/api/posts/${POST.id}/public`);
    expect(calls[0]?.init.method).toBe('GET');
    expect(meta).toEqual({ title: POST.title, price: POST.price });
  });

  it('tolerates extra fields the contract does not name', async () => {
    const { fetch } = stubFetch(json(200, { ...POST, tags: ['x'], readCount: 12 }));
    const meta = await getPostMetadata(POST.id, {
      baseUrl: 'https://preview.example',
      timeoutMs: 5000,
      fetchImpl: fetch,
    });
    expect(meta).toEqual({ title: POST.title, price: POST.price });
  });

  it('returns null on a 404 (draft, unknown id, or a deployment without the route)', async () => {
    const { fetch } = stubFetch(json(404, { error: 'not found' }));
    const meta = await getPostMetadata(POST.id, {
      baseUrl: 'https://preview.example',
      timeoutMs: 5000,
      fetchImpl: fetch,
    });
    expect(meta).toBeNull();
  });

  it('returns null on any other non-200 status', async () => {
    const { fetch } = stubFetch(json(500, { error: 'boom' }));
    const meta = await getPostMetadata(POST.id, {
      baseUrl: 'https://preview.example',
      timeoutMs: 5000,
      fetchImpl: fetch,
    });
    expect(meta).toBeNull();
  });

  it('returns null on a network failure rather than throwing', async () => {
    const throwing = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const meta = await getPostMetadata(POST.id, {
      baseUrl: 'https://preview.example',
      timeoutMs: 5000,
      fetchImpl: throwing,
    });
    expect(meta).toBeNull();
  });

  it('returns null on a body that does not match the contract', async () => {
    const { fetch } = stubFetch(json(200, { id: POST.id, title: 'x' }));
    const meta = await getPostMetadata(POST.id, {
      baseUrl: 'https://preview.example',
      timeoutMs: 5000,
      fetchImpl: fetch,
    });
    expect(meta).toBeNull();
  });

  it('returns null for a non-published status rather than trusting the body', async () => {
    const { fetch } = stubFetch(json(200, { ...POST, status: 'draft' }));
    const meta = await getPostMetadata(POST.id, {
      baseUrl: 'https://preview.example',
      timeoutMs: 5000,
      fetchImpl: fetch,
    });
    expect(meta).toBeNull();
  });
});
