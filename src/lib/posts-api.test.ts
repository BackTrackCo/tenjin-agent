import { describe, it, expect } from 'vitest';
import { buildPostCreateBody, publishPost, type PublishInput } from './posts-api';
import type { SignableRequest, WriteAuth } from './session-key';

const OPTS = { baseUrl: 'https://tenjin.blog', timeoutMs: 5000 };

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
    expect(signed[0]!.body).toBe(call.body);
    expect(call.headers['tenjin-session-delegation']).toBe('D');
    expect(call.headers['x-tenjin-client']).toMatch(/^tenjin-cli\//);

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
