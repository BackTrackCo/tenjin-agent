import { describe, it, expect } from 'vitest';
import {
  buildPostCreateBody,
  buildPostUpdateBody,
  getOwnPost,
  publishPost,
  updatePost,
  type PublishInput,
} from './posts-api';
import type { SignableRequest, WriteAuth } from './session-key';

const OPTS = { baseUrl: 'https://tenjin.blog', timeoutMs: 5000 };

const SEARCH_A = '0197aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee';
const SEARCH_B = '0197aaaa-bbbb-7ccc-8ddd-ffffffffffff';

interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function capturingFetch(responder: (call: CapturedCall, attempt: number) => Response): {
  fetch: typeof fetch;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    const h = init?.headers;
    if (h !== undefined) {
      for (const [k, v] of Object.entries(h as Record<string, string>))
        headers[k.toLowerCase()] = String(v);
    }
    const call: CapturedCall = {
      url: String(url),
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : '',
    };
    calls.push(call);
    return responder(call, calls.length);
  }) as unknown as typeof fetch;
  return { fetch: fetchFn, calls };
}

/** The signed body, or undefined for the bodiless GET branch of the union. */
function signedBody(req: SignableRequest): string | undefined {
  return req.method === 'GET' ? undefined : req.body;
}

/** A minimal WriteAuth that stamps a fixed header and records recover() calls. */
function fakeAuth(recover: (code: string | undefined) => boolean = () => false): {
  auth: WriteAuth;
  signed: SignableRequest[];
  recovered: (string | undefined)[];
} {
  const signed: SignableRequest[] = [];
  const recovered: (string | undefined)[] = [];
  return {
    signed,
    recovered,
    auth: {
      async headersFor(req) {
        signed.push(req);
        return {
          'Tenjin-Session-Delegation': 'D',
          'Signature-Input': 'tenjin=x',
          Signature: 'tenjin=:s:',
        };
      },
      async recover(code) {
        recovered.push(code);
        return recover(code);
      },
    },
  };
}

function ok201(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 201,
    headers: { 'content-type': 'application/json' },
  });
}

const CREATED_POST = {
  id: '0197aaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  slug: 'base-fees',
  title: 'Base fees',
  status: 'published',
  price: '100000',
  url: 'https://tenjin.blog/a/iris/base-fees',
  tags: [],
};

describe('buildPostCreateBody — bounds', () => {
  it('requires a title and body to publish', () => {
    expect(() => buildPostCreateBody({ status: 'published', bodyMd: 'x' })).toThrow(/title/);
    expect(() => buildPostCreateBody({ status: 'published', title: 'x' })).toThrow(/body/);
  });

  it('a draft may omit EITHER title or body, but not both', () => {
    expect(buildPostCreateBody({ status: 'draft', title: 'Just a title' })).toEqual({
      title: 'Just a title',
      status: 'draft',
    });
    expect(buildPostCreateBody({ status: 'draft', bodyMd: 'just a body' })).toEqual({
      bodyMd: 'just a body',
      status: 'draft',
    });
    // An all-empty draft is refused locally, matching the server superRefine.
    expect(() => buildPostCreateBody({ status: 'draft' })).toThrow(/title or a body/);
    expect(() => buildPostCreateBody({ status: 'draft', title: '  ', bodyMd: '  ' })).toThrow();
  });

  it('rejects a reserved or address-shaped handle', () => {
    expect(() => buildPostCreateBody({ status: 'draft', title: 't', handle: 'latest' })).toThrow(
      /Reserved/,
    );
    expect(() => buildPostCreateBody({ status: 'draft', title: 't', handle: '0xdead' })).toThrow(
      /Reserved/,
    );
  });

  it('rejects out-of-bound top-level fields', () => {
    expect(() => buildPostCreateBody({ status: 'draft', title: 'x'.repeat(201) })).toThrow();
    expect(() =>
      buildPostCreateBody({ status: 'draft', tags: ['a', 'b', 'c', 'd', 'e', 'f'] }),
    ).toThrow();
    expect(() => buildPostCreateBody({ status: 'draft', priceAtomic: '1a' })).toThrow();
    expect(() => buildPostCreateBody({ status: 'draft', handle: 'A!' })).toThrow();
  });

  // The wire rule the server rollout turns on: one search stays the bare string
  // a post-create that predates the array still takes.
  it('ships one searchId as a bare string and several as an array', () => {
    const base = { status: 'published', title: 'T', bodyMd: 'B' } as const;
    expect(buildPostCreateBody({ ...base, searchId: SEARCH_A }).searchId).toBe(SEARCH_A);
    expect(buildPostCreateBody({ ...base, searchId: [SEARCH_A] }).searchId).toBe(SEARCH_A);
    expect(buildPostCreateBody({ ...base, searchId: [SEARCH_A, SEARCH_B] }).searchId).toEqual([
      SEARCH_A,
      SEARCH_B,
    ]);
    expect(buildPostCreateBody({ ...base, searchId: [SEARCH_A, SEARCH_A] }).searchId).toBe(
      SEARCH_A,
    );
  });

  it('refuses a bad searchId anywhere in the list, and more than ten of them', () => {
    const base = { status: 'published', title: 'T', bodyMd: 'B' } as const;
    expect(() => buildPostCreateBody({ ...base, searchId: [SEARCH_A, 'nope'] })).toThrow(
      /Invalid searchId/,
    );
    const eleven = Array.from(
      { length: 11 },
      (_, i) => `0197aaaa-bbbb-7ccc-8ddd-0000000000${String(i).padStart(2, '0')}`,
    );
    expect(() => buildPostCreateBody({ ...base, searchId: eleven })).toThrow(/at most 10 searches/);
  });

  it('emits only defined keys (strictObject-safe), status last', () => {
    const body = buildPostCreateBody({
      status: 'published',
      title: 'T',
      bodyMd: 'B',
      priceAtomic: '100000',
    });
    expect(body).toEqual({ title: 'T', bodyMd: 'B', price: '100000', status: 'published' });
    expect('excerpt' in body).toBe(false);
    expect('resource' in body).toBe(false);
  });
});

describe('publishPost — 201', () => {
  it('POSTs the exact body + auth headers and returns a receipt', async () => {
    const { fetch, calls } = capturingFetch(() =>
      ok201({ ...CREATED_POST, resource: { cacheEligible: true, cacheEligibleMissing: [] } }),
    );
    const { auth, signed } = fakeAuth();
    const input: PublishInput = {
      status: 'published',
      title: 'Base fees',
      bodyMd: '# Base fees\n',
      priceAtomic: '100000',
      resource: { scope: 'L2 fees', questionsAnswered: ['q'] },
    };
    const result = await publishPost(input, auth, { ...OPTS, fetchImpl: fetch });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe('https://tenjin.blog/api/posts');
    expect(call.method).toBe('POST');
    // The wire body is exactly the built body, key order preserved.
    expect(call.body).toBe(
      JSON.stringify({
        title: 'Base fees',
        bodyMd: '# Base fees\n',
        price: '100000',
        status: 'published',
        resource: { scope: 'L2 fees', questionsAnswered: ['q'] },
      }),
    );
    // The signed digest covers exactly those bytes.
    expect(signedBody(signed[0]!)).toBe(call.body);
    expect(call.headers['tenjin-session-delegation']).toBe('D');
    expect(call.headers['user-agent']).toMatch(/^tenjin-cli\//);
    expect(call.headers['x-tenjin-client']).toBeUndefined();

    expect(result).toMatchObject({
      resourceId: CREATED_POST.id,
      url: CREATED_POST.url,
      status: 'published',
      priceAtomic: '100000',
      cacheEligible: true,
      cacheEligibleMissing: [],
      warnings: [],
    });
  });

  it('surfaces cacheEligibleMissing and server warnings', async () => {
    const { fetch } = capturingFetch(() =>
      ok201({
        ...CREATED_POST,
        warnings: ['dropped external image ./pic.png'],
        resource: { cacheEligible: false, cacheEligibleMissing: ['exclusions', 'scope'] },
      }),
    );
    const result = await publishPost(
      { status: 'published', title: 'T', bodyMd: 'B', resource: { questionsAnswered: ['q'] } },
      fakeAuth().auth,
      { ...OPTS, fetchImpl: fetch },
    );
    expect(result.cacheEligible).toBe(false);
    expect(result.cacheEligibleMissing).toEqual(['exclusions', 'scope']);
    expect(result.warnings).toEqual(['dropped external image ./pic.png']);
  });
});

describe('publishPost — 401 recovery matrix', () => {
  it('re-signs on a recoverable 401, then succeeds', async () => {
    let attempt = 0;
    const { fetch } = capturingFetch(() => {
      attempt++;
      if (attempt === 1) {
        return new Response(JSON.stringify({ error: { code: 'proof_expired' } }), {
          status: 401,
          headers: { 'www-authenticate': 'Session error="proof_expired"' },
        });
      }
      return ok201(CREATED_POST);
    });
    const { auth, recovered } = fakeAuth(() => true);
    const result = await publishPost({ status: 'published', title: 'T', bodyMd: 'B' }, auth, {
      ...OPTS,
      fetchImpl: fetch,
    });
    expect(recovered).toEqual(['proof_expired']);
    expect(result.resourceId).toBe(CREATED_POST.id);
  });

  it('falls back to the body error.code when a 401 carries no WWW-Authenticate header', async () => {
    let attempt = 0;
    const { fetch } = capturingFetch(() => {
      attempt++;
      if (attempt === 1) {
        // No www-authenticate header at all; the code lives only in the body.
        return new Response(JSON.stringify({ error: { code: 'proof_expired' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        });
      }
      return ok201(CREATED_POST);
    });
    const { auth, recovered } = fakeAuth(() => true);
    const result = await publishPost({ status: 'published', title: 'T', bodyMd: 'B' }, auth, {
      ...OPTS,
      fetchImpl: fetch,
    });
    expect(recovered).toEqual(['proof_expired']);
    expect(result.resourceId).toBe(CREATED_POST.id);
  });

  it('does not retry a fatal 401 (session_key_unbound)', async () => {
    const { fetch, calls } = capturingFetch(
      () =>
        new Response(JSON.stringify({ error: { code: 'session_key_unbound' } }), {
          status: 401,
          headers: { 'www-authenticate': 'Session error="session_key_unbound"' },
        }),
    );
    const { auth } = fakeAuth(() => false);
    await expect(
      publishPost({ status: 'published', title: 'T', bodyMd: 'B' }, auth, {
        ...OPTS,
        fetchImpl: fetch,
      }),
    ).rejects.toMatchObject({ code: 'PUBLISH_FAILED' });
    expect(calls).toHaveLength(1);
  });

  it('caps retries so an always-401 server cannot loop', async () => {
    const { fetch, calls } = capturingFetch(
      () =>
        new Response(JSON.stringify({ error: { code: 'proof_expired' } }), {
          status: 401,
          headers: { 'www-authenticate': 'Session error="proof_expired"' },
        }),
    );
    const { auth } = fakeAuth(() => true);
    await expect(
      publishPost({ status: 'published', title: 'T', bodyMd: 'B' }, auth, {
        ...OPTS,
        fetchImpl: fetch,
      }),
    ).rejects.toMatchObject({ code: 'PUBLISH_FAILED' });
    expect(calls.length).toBe(4); // initial + MAX_RECOVERIES
  });
});

describe('publishPost — write failures after approval', () => {
  it('maps a validation_failed to PUBLISH_FAILED (exit 4) carrying the server envelope', async () => {
    const { fetch } = capturingFetch(
      () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'validation_failed',
              message: 'bad card',
              details: { fieldErrors: { 'resource.scope': ['too long'] } },
            },
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        ),
    );
    await expect(
      publishPost({ status: 'published', title: 'T', bodyMd: 'B' }, fakeAuth().auth, {
        ...OPTS,
        fetchImpl: fetch,
      }),
    ).rejects.toMatchObject({ code: 'PUBLISH_FAILED', exitCode: 4 });
  });

  it('maps a 429 to RATE_LIMITED so an agent backs off', async () => {
    const { fetch } = capturingFetch(
      () => new Response('{}', { status: 429, headers: { 'retry-after': '30' } }),
    );
    await expect(
      publishPost({ status: 'published', title: 'T', bodyMd: 'B' }, fakeAuth().auth, {
        ...OPTS,
        fetchImpl: fetch,
      }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('maps a contract-mismatched 201 to CONTRACT_MISMATCH', async () => {
    const { fetch } = capturingFetch(() => ok201({ id: 'x' })); // missing slug/url/...
    await expect(
      publishPost({ status: 'published', title: 'T', bodyMd: 'B' }, fakeAuth().auth, {
        ...OPTS,
        fetchImpl: fetch,
      }),
    ).rejects.toMatchObject({ code: 'CONTRACT_MISMATCH' });
  });
});

// ---------------------------------------------------------------------------
// The owner-scoped read + merge-update surface.
// ---------------------------------------------------------------------------

const POST_ID = '0197aaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const STORED_POST = {
  ...CREATED_POST,
  excerpt: 'An excerpt.',
  bodyMd: '# Base fees\n',
  resource: {
    scope: 'L2 fees',
    questionsAnswered: ['q'],
    cacheEligible: false,
    cacheEligibleMissing: ['exclusions'],
    schemaVersion: 1,
  },
};

function ok200(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('buildPostUpdateBody — bounds', () => {
  it('emits only the defined keys, price converted from the atomic input', () => {
    expect(
      buildPostUpdateBody({ title: 'T', priceAtomic: '250000', resource: { scope: null } }),
    ).toEqual({ title: 'T', price: '250000', resource: { scope: null } });
  });

  it('needs no title or body (a partial update keeps what it omits)', () => {
    expect(buildPostUpdateBody({ excerpt: 'e' })).toEqual({ excerpt: 'e' });
  });

  it('refuses an empty title or body: neither can be cleared, and blanking is not an edit', () => {
    expect(() => buildPostUpdateBody({ title: '   ' })).toThrow(/title cannot be empty/);
    expect(() => buildPostUpdateBody({ bodyMd: '\n' })).toThrow(/bodyMd cannot be empty/);
  });

  it('rejects out-of-bound values, the same bounds the create body pins', () => {
    expect(() => buildPostUpdateBody({ title: 'x'.repeat(201) })).toThrow();
    expect(() => buildPostUpdateBody({ bodyMd: 'x'.repeat(200_001) })).toThrow();
    expect(() => buildPostUpdateBody({ excerpt: 'x'.repeat(501) })).toThrow();
    expect(() => buildPostUpdateBody({ tags: ['a', 'b', 'c', 'd', 'e', 'f'] })).toThrow();
    expect(() => buildPostUpdateBody({ tags: [''] })).toThrow();
    expect(() => buildPostUpdateBody({ priceAtomic: '1a' })).toThrow();
  });

  it('refuses an empty update rather than burning a nonce on a no-op', () => {
    expect(() => buildPostUpdateBody({})).toThrow(/Nothing to update/);
  });
});

describe('getOwnPost', () => {
  it('GETs the owner-scoped route with auth headers and no body', async () => {
    const { fetch, calls } = capturingFetch(() => ok200(STORED_POST));
    const { auth, signed } = fakeAuth();
    const post = await getOwnPost(POST_ID, auth, { ...OPTS, fetchImpl: fetch });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe('GET');
    expect(call.url).toBe(`https://tenjin.blog/api/posts/${POST_ID}`);
    expect(call.body).toBe('');
    expect(call.headers['tenjin-session-delegation']).toBe('D');
    expect(call.headers['user-agent']).toMatch(/^tenjin-cli\//);
    expect(call.headers['x-tenjin-client']).toBeUndefined();
    // A bodiless request is signed without a content-digest over phantom bytes.
    expect(signed[0]).toEqual({ method: 'GET', url: call.url });
    expect(post.resource?.questionsAnswered).toEqual(['q']);
  });

  it('maps 404 to RESOURCE_NOT_FOUND and 429 to RATE_LIMITED', async () => {
    const notFound = capturingFetch(() => ok200({ error: { code: 'post_not_found' } }, 404));
    await expect(
      getOwnPost(POST_ID, fakeAuth().auth, { ...OPTS, fetchImpl: notFound.fetch }),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND', exitCode: 1 });

    const limited = capturingFetch(() => new Response('{}', { status: 429 }));
    await expect(
      getOwnPost(POST_ID, fakeAuth().auth, { ...OPTS, fetchImpl: limited.fetch }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('a failed read is runtime-class, never the post-approval write class', async () => {
    const { fetch } = capturingFetch(
      () =>
        new Response(JSON.stringify({ error: { code: 'unauthenticated' } }), {
          status: 401,
          headers: { 'www-authenticate': 'Session error="session_key_unbound"' },
        }),
    );
    await expect(
      getOwnPost(POST_ID, fakeAuth(() => false).auth, { ...OPTS, fetchImpl: fetch }),
    ).rejects.toMatchObject({ exitCode: 1 });
  });

  it('re-signs a recoverable 401, then succeeds', async () => {
    let attempt = 0;
    const { fetch, calls } = capturingFetch(() => {
      attempt++;
      return attempt === 1
        ? new Response(JSON.stringify({ error: { code: 'proof_expired' } }), { status: 401 })
        : ok200(STORED_POST);
    });
    const { auth, recovered } = fakeAuth(() => true);
    const post = await getOwnPost(POST_ID, auth, { ...OPTS, fetchImpl: fetch });
    expect(recovered).toEqual(['proof_expired']);
    expect(calls).toHaveLength(2);
    expect(post.id).toBe(CREATED_POST.id);
  });
});

describe('updatePost', () => {
  it('PUTs the built body, signs those exact bytes, and returns the full post', async () => {
    const { fetch, calls } = capturingFetch(() => ok200({ ...STORED_POST, title: 'New' }));
    const { auth, signed } = fakeAuth();
    const post = await updatePost(
      POST_ID,
      { title: 'New', resource: { scope: null, questionsAnswered: [] } },
      auth,
      { ...OPTS, fetchImpl: fetch },
    );

    const call = calls[0]!;
    expect(call.method).toBe('PUT');
    expect(call.url).toBe(`https://tenjin.blog/api/posts/${POST_ID}`);
    expect(call.body).toBe(
      JSON.stringify({ title: 'New', resource: { scope: null, questionsAnswered: [] } }),
    );
    expect(signedBody(signed[0]!)).toBe(call.body);
    expect(signed[0]!.method).toBe('PUT');
    expect(call.headers['user-agent']).toMatch(/^tenjin-cli\//);
    expect(call.headers['x-tenjin-client']).toBeUndefined();
    expect(post.title).toBe('New');
  });

  it('signs every attempt afresh, because each PUT burns a single-use nonce', async () => {
    let attempt = 0;
    const { fetch } = capturingFetch(() => {
      attempt++;
      return attempt === 1
        ? new Response(JSON.stringify({ error: { code: 'nonce_already_used' } }), { status: 401 })
        : ok200(STORED_POST);
    });
    const { auth, signed } = fakeAuth(() => true);
    await updatePost(POST_ID, { title: 'New' }, auth, { ...OPTS, fetchImpl: fetch });
    expect(signed).toHaveLength(2);
  });

  it('names the rejected fields on a validation_failed (exit 4, after approval)', async () => {
    const { fetch } = capturingFetch(() =>
      ok200(
        {
          error: {
            code: 'validation_failed',
            message: 'validation failed',
            details: { fieldErrors: { 'resource.asOf': ['bad'], price: ['bad'] } },
          },
        },
        400,
      ),
    );
    await expect(
      updatePost(POST_ID, { title: 'New' }, fakeAuth().auth, { ...OPTS, fetchImpl: fetch }),
    ).rejects.toMatchObject({
      code: 'PUBLISH_FAILED',
      exitCode: 4,
      message: 'validation failed (resource.asOf, price)',
    });
  });

  it('maps 404 to RESOURCE_NOT_FOUND and a mismatched 200 to CONTRACT_MISMATCH', async () => {
    const notFound = capturingFetch(() => ok200({ error: { code: 'post_not_found' } }, 404));
    await expect(
      updatePost(POST_ID, { title: 'New' }, fakeAuth().auth, {
        ...OPTS,
        fetchImpl: notFound.fetch,
      }),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });

    const mismatch = capturingFetch(() => ok200({ id: 'x' }));
    await expect(
      updatePost(POST_ID, { title: 'New' }, fakeAuth().auth, {
        ...OPTS,
        fetchImpl: mismatch.fetch,
      }),
    ).rejects.toMatchObject({ code: 'CONTRACT_MISMATCH' });
  });
});
