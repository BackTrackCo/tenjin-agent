import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  fetchJson,
  fetchFailureToCliError,
  httpRequest,
  shelfBypassHeaders,
  SHELF_BYPASS_HEADER,
} from './http';
import { SIWX_HEADER } from './siwx';
import { CliError } from './errors';
import { CALLER_USER_AGENT_ENV, TENJIN_PRODUCT, TENJIN_USER_AGENT } from './client-meta';
import type { FetchJsonFailure, HttpRequestOptions } from './http';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, ...init });
}

describe('fetchJson', () => {
  it('returns ok with parsed json on a 2xx', async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse({ items: [1, 2] });
    const res = await fetchJson('https://x.example/api', { timeoutMs: 1000, fetchImpl });
    expect(res).toMatchObject({ ok: true, status: 200, json: { items: [1, 2] } });
  });

  it('captures the x-request-id header when present', async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({ ok: 1 }, { headers: { 'x-request-id': 'req-123' } });
    const res = await fetchJson('https://x.example/api', { timeoutMs: 1000, fetchImpl });
    expect(res).toMatchObject({ ok: true, requestId: 'req-123' });
  });

  it('flags a 2xx body that is not JSON as invalid-json', async () => {
    const fetchImpl: typeof fetch = async () => new Response('not json{', { status: 200 });
    const res = await fetchJson('https://x.example/api', { timeoutMs: 1000, fetchImpl });
    expect(res).toMatchObject({ ok: false, kind: 'invalid-json', status: 200 });
  });

  /**
   * An access-protected deployment answers 200 with its own page, so the failure
   * is indistinguishable from a broken API by status alone. Only this transport
   * holds the Response, so it is the only place that can tell doctor which one
   * happened (#218).
   */
  describe('gateSuspected on an invalid-json 2xx', () => {
    /** A Response whose `url` is the FINAL one, as real fetch reports it after redirects. */
    function landedAt(finalUrl: string, body: string, init: ResponseInit = {}): Response {
      const res = new Response(body, { status: 200, ...init });
      Object.defineProperty(res, 'url', { value: finalUrl });
      return res;
    }

    it('is set when the body arrives as text/html', async () => {
      const fetchImpl: typeof fetch = async () =>
        new Response('<html><body>Authentication Required</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      const res = await fetchJson('https://shelf.example/openapi.json', {
        timeoutMs: 1000,
        fetchImpl,
      });
      expect(res).toMatchObject({ ok: false, kind: 'invalid-json', gateSuspected: true });
    });

    it('is set when a followed redirect landed the probe on another host', async () => {
      const fetchImpl: typeof fetch = async () =>
        landedAt('https://vercel.com/sso-api?url=shelf', 'not json{');
      const res = await fetchJson('https://shelf.example/openapi.json', {
        timeoutMs: 1000,
        fetchImpl,
      });
      expect(res).toMatchObject({ ok: false, kind: 'invalid-json', gateSuspected: true });
    });

    it('is unset for plain bad JSON served by the requested origin', async () => {
      const fetchImpl: typeof fetch = async () =>
        landedAt('https://shelf.example/openapi.json', 'not json{', {
          headers: { 'content-type': 'application/json' },
        });
      const res = await fetchJson('https://shelf.example/openapi.json', {
        timeoutMs: 1000,
        fetchImpl,
      });
      expect(res).toMatchObject({ ok: false, kind: 'invalid-json', gateSuspected: false });
    });

    // A Response built without a url (every stub in this file, and any non-fetch
    // impl) must not read as a redirect: an unknown final host is not a foreign one.
    it('is unset when the response carries no final URL to compare', async () => {
      const fetchImpl: typeof fetch = async () => new Response('not json{', { status: 200 });
      const res = await fetchJson('https://shelf.example/openapi.json', {
        timeoutMs: 1000,
        fetchImpl,
      });
      expect(res).toMatchObject({ ok: false, kind: 'invalid-json', gateSuspected: false });
    });
  });

  it('flags a non-2xx status as an http failure carrying the status', async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse({ error: {} }, { status: 500 });
    const res = await fetchJson('https://x.example/api', { timeoutMs: 1000, fetchImpl });
    expect(res).toMatchObject({ ok: false, kind: 'http', status: 500 });
  });

  it('flags a rejected fetch as a network failure', async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new TypeError('fetch failed');
    };
    const res = await fetchJson('https://x.example/api', { timeoutMs: 1000, fetchImpl });
    expect(res).toMatchObject({ ok: false, kind: 'network' });
  });

  it('aborts and reports a timeout when the request outlasts timeoutMs', async () => {
    // A fetch that never settles on its own but honors the abort signal, so the
    // internal timer is what ends it — proving the AbortController wiring.
    const hangingFetch: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('The operation was aborted', 'AbortError')),
        );
      });
    const res = await fetchJson('https://x.example/api', {
      timeoutMs: 10,
      fetchImpl: hangingFetch,
    });
    expect(res).toMatchObject({ ok: false, kind: 'timeout' });
  });

  it('times out on a response whose body never completes, instead of hanging', async () => {
    // Headers resolve immediately but the body stream never ends. It errors on
    // abort exactly as real fetch wires the signal into the body, so the timer —
    // which must stay armed through res.json() — is what ends it.
    const stalledFetch: typeof fetch = (async (_url, init) => {
      const body = new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener('abort', () =>
            controller.error(new DOMException('The operation was aborted', 'AbortError')),
          );
        },
      });
      return new Response(body, { status: 200 });
    }) as typeof fetch;
    const res = await fetchJson('https://x.example/api', {
      timeoutMs: 20,
      fetchImpl: stalledFetch,
    });
    expect(res).toMatchObject({ ok: false, kind: 'timeout' });
  });
});

/**
 * The tenjin-cli User-Agent identity (spec: user-agent-telemetry-and-client-
 * attribution.md PR 3). Both transports send it on every request from a single
 * source, merged through the Headers API so it survives regardless of what a
 * caller-supplied header carries or how it is cased.
 */
describe('User-Agent identity', () => {
  function headerCapture(): { fetchImpl: typeof fetch; calls: Headers[] } {
    const calls: Headers[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      calls.push(new Headers(init?.headers));
      return new Response(JSON.stringify({ ok: 1 }), { status: 200 });
    };
    return { fetchImpl, calls };
  }

  it('fetchJson sends the tenjin-cli User-Agent with no caller headers at all', async () => {
    const { fetchImpl, calls } = headerCapture();
    await fetchJson('https://tenjin.blog/openapi.json', { timeoutMs: 1000, fetchImpl });
    expect(calls[0]?.get('user-agent')).toBe(TENJIN_USER_AGENT);
  });

  it('fetchJson merges caller headers alongside the User-Agent', async () => {
    const { fetchImpl, calls } = headerCapture();
    await fetchJson('https://tenjin.blog/openapi.json', {
      timeoutMs: 1000,
      headers: { accept: 'application/json' },
      fetchImpl,
    });
    expect(calls[0]?.get('user-agent')).toBe(TENJIN_USER_AGENT);
    expect(calls[0]?.get('accept')).toBe('application/json');
  });

  it('fetchJson never sends X-Tenjin-Client', async () => {
    const { fetchImpl, calls } = headerCapture();
    await fetchJson('https://tenjin.blog/openapi.json', { timeoutMs: 1000, fetchImpl });
    expect(calls[0]?.has('x-tenjin-client')).toBe(false);
  });

  it('httpRequest sends the tenjin-cli User-Agent on a plain GET', async () => {
    const { fetchImpl, calls } = headerCapture();
    await httpRequest('https://tenjin.blog/api/search', { timeoutMs: 1000, fetchImpl });
    expect(calls[0]?.get('user-agent')).toBe(TENJIN_USER_AGENT);
    expect(calls[0]?.has('x-tenjin-client')).toBe(false);
  });

  it('httpRequest sends the User-Agent alongside a signed request, untouched by signing', async () => {
    const { fetchImpl, calls } = headerCapture();
    await httpRequest('https://tenjin.blog/api/posts', {
      method: 'POST',
      timeoutMs: 1000,
      headers: { [SIWX_HEADER]: 'siwx-value' },
      jsonBody: { title: 'x' },
      fetchImpl,
    });
    const sent = calls[0]!;
    expect(sent.get('user-agent')).toBe(TENJIN_USER_AGENT);
    expect(sent.get(SIWX_HEADER)).toBe('siwx-value');
    expect(sent.get('content-type')).toBe('application/json');
    expect(sent.has('x-tenjin-client')).toBe(false);
  });

  it('a caller header spelled `User-Agent` in any case cannot erase or duplicate the identity', async () => {
    const { fetchImpl, calls } = headerCapture();
    await httpRequest('https://tenjin.blog/api/search', {
      timeoutMs: 1000,
      // A caller-supplied value under a differently-cased key must not survive
      // alongside, or instead of, the CLI's own identity: exactly one User-Agent
      // reaches the wire, and it is always the CLI's.
      headers: { 'USER-AGENT': 'something-else/1.0' },
      fetchImpl,
    });
    const sent = calls[0]!;
    expect(sent.get('user-agent')).toBe(TENJIN_USER_AGENT);
    expect([...sent.keys()].filter((k) => k === 'user-agent')).toHaveLength(1);
  });

  it('call-specific accept/content-type still win their own slot without disturbing the User-Agent', async () => {
    const { fetchImpl, calls } = headerCapture();
    await httpRequest('https://tenjin.blog/api/read/x', {
      timeoutMs: 1000,
      headers: { Accept: 'application/json' },
      fetchImpl,
    });
    const sent = calls[0]!;
    expect(sent.get('accept')).toBe('application/json');
    expect(sent.get('user-agent')).toBe(TENJIN_USER_AGENT);
  });
});

/**
 * The caller handoff on the wire (spec: user-agent-telemetry-and-client-
 * attribution.md, "Composition contract"). `client-meta.test.ts` pins the
 * composer itself; these pin that both transports read BOTH seams and that the
 * composed field reaches fetch as exactly one header.
 */
describe('caller User-Agent handoff', () => {
  function headerCapture(): { fetchImpl: typeof fetch; calls: Headers[] } {
    const calls: Headers[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      calls.push(new Headers(init?.headers));
      return new Response(JSON.stringify({ ok: 1 }), { status: 200 });
    };
    return { fetchImpl, calls };
  }

  const COMPOSED = `${TENJIN_PRODUCT} codex/1.2.0 (+https://tenjin.blog)`;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('composes the env handoff onto both transports', async () => {
    vi.stubEnv(CALLER_USER_AGENT_ENV, 'codex/1.2.0');
    const { fetchImpl, calls } = headerCapture();
    await fetchJson('https://tenjin.blog/openapi.json', { timeoutMs: 1000, fetchImpl });
    await httpRequest('https://tenjin.blog/api/search', { timeoutMs: 1000, fetchImpl });
    expect(calls[0]?.get('user-agent')).toBe(COMPOSED);
    expect(calls[1]?.get('user-agent')).toBe(COMPOSED);
  });

  it('composes the programmatic handoff, which beats the env', async () => {
    vi.stubEnv(CALLER_USER_AGENT_ENV, 'from-env/9.9');
    const { fetchImpl, calls } = headerCapture();
    await fetchJson('https://tenjin.blog/openapi.json', {
      timeoutMs: 1000,
      callerUserAgent: 'codex/1.2.0',
      fetchImpl,
    });
    await httpRequest('https://tenjin.blog/api/search', {
      timeoutMs: 1000,
      callerUserAgent: 'codex/1.2.0',
      fetchImpl,
    });
    expect(calls[0]?.get('user-agent')).toBe(COMPOSED);
    expect(calls[1]?.get('user-agent')).toBe(COMPOSED);
  });

  it('sends the identity alone when the handoff is unusable, on both transports', async () => {
    vi.stubEnv(CALLER_USER_AGENT_ENV, 'codex/1.2.0 (host=laptop.local)');
    const { fetchImpl, calls } = headerCapture();
    await fetchJson('https://tenjin.blog/openapi.json', { timeoutMs: 1000, fetchImpl });
    await httpRequest('https://tenjin.blog/api/search', { timeoutMs: 1000, fetchImpl });
    expect(calls[0]?.get('user-agent')).toBe(TENJIN_USER_AGENT);
    expect(calls[1]?.get('user-agent')).toBe(TENJIN_USER_AGENT);
  });

  it('survives a call-specific User-Agent header, as exactly one field', async () => {
    vi.stubEnv(CALLER_USER_AGENT_ENV, 'codex/1.2.0');
    const { fetchImpl, calls } = headerCapture();
    await httpRequest('https://tenjin.blog/api/search', {
      timeoutMs: 1000,
      headers: { 'User-Agent': 'something-else/1.0' },
      fetchImpl,
    });
    const sent = calls[0]!;
    expect(sent.get('user-agent')).toBe(COMPOSED);
    expect([...sent.keys()].filter((key) => key === 'user-agent')).toHaveLength(1);
  });

  it('does not duplicate the identity when a retry re-sends a composed field as the handoff', async () => {
    const { fetchImpl, calls } = headerCapture();
    // The 402 -> pay -> retry shape: the second attempt hands off what the first
    // attempt already composed, which must not mint a second `tenjin-cli` token.
    await httpRequest('https://tenjin.blog/api/read/x', {
      timeoutMs: 1000,
      callerUserAgent: 'codex/1.2.0',
      fetchImpl,
    });
    await httpRequest('https://tenjin.blog/api/read/x', {
      timeoutMs: 1000,
      callerUserAgent: calls[0]?.get('user-agent') ?? '',
      headers: { 'payment-signature': 'sig-value' },
      fetchImpl,
    });
    const retried = calls[1]!.get('user-agent')!;
    expect(retried).toBe(COMPOSED);
    expect(retried.match(/tenjin-cli/g)).toHaveLength(1);
  });

  it('leaves a signed x402 retry byte-for-byte identical apart from the User-Agent', async () => {
    // Rule 6 of the contract: the handoff rides an UNSIGNED field. Payment and
    // SIWX signatures cover neither it nor anything it could shift.
    const signed = {
      'payment-signature': 'sig-value',
      [SIWX_HEADER]: 'siwx-value',
      'x-tenjin-search-id': 'search-1',
      accept: 'application/json',
    };
    const { fetchImpl, calls } = headerCapture();
    await httpRequest('https://tenjin.blog/api/read/x', {
      timeoutMs: 1000,
      headers: signed,
      fetchImpl,
    });
    await httpRequest('https://tenjin.blog/api/read/x', {
      timeoutMs: 1000,
      headers: signed,
      callerUserAgent: 'codex/1.2.0',
      fetchImpl,
    });
    const withoutUa = (headers: Headers): Array<[string, string]> =>
      [...headers.entries()].filter(([name]) => name !== 'user-agent');
    expect(withoutUa(calls[1]!)).toEqual(withoutUa(calls[0]!));
    expect(calls[0]!.get('user-agent')).toBe(TENJIN_USER_AGENT);
    expect(calls[1]!.get('user-agent')).toBe(COMPOSED);
  });
});

describe('fetchFailureToCliError', () => {
  const cases: Array<[FetchJsonFailure['kind'], string]> = [
    ['network', 'NETWORK_ERROR'],
    ['timeout', 'NETWORK_ERROR'],
    ['http', 'API_UNREACHABLE'],
    ['invalid-json', 'CONTRACT_MISMATCH'],
  ];
  it.each(cases)('maps a %s failure to %s', (kind, code) => {
    const failure = { ok: false, kind, message: 'boom' } as FetchJsonFailure;
    const err = fetchFailureToCliError(failure);
    expect(err).toBeInstanceOf(CliError);
    expect(err.code).toBe(code);
    expect(err.message).toBe('boom');
  });

  it('threads fix and details onto the CliError', () => {
    const failure: FetchJsonFailure = { ok: false, kind: 'http', status: 503, message: 'down' };
    const err = fetchFailureToCliError(failure, { fix: 'retry', details: { status: 503 } });
    expect(err.fix).toBe('retry');
    expect(err.details).toEqual({ status: 503 });
  });
});

/**
 * The signed-redirect guard. `resource-ref` promises "nothing signed may leave for
 * a host the user did not configure", but it only checks the URL the caller asked
 * for — `fetch`'s default `redirect: 'follow'` re-sends request headers verbatim to
 * whatever `Location` names, stripping only `Authorization`. So a 3xx on the read
 * route would hand a signature bound to the real domain to another host, replayable
 * against it for the signature's lifetime. These pin that it cannot happen.
 */
describe('httpRequest, signed requests never follow redirects', () => {
  /** Records the init `httpRequest` passed to fetch, so the redirect mode is assertable. */
  function recordingFetch(response: () => Response): {
    fetchImpl: typeof fetch;
    calls: { url: string; redirect: RequestInit['redirect'] }[];
  } {
    const calls: { url: string; redirect: RequestInit['redirect'] }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), redirect: init?.redirect });
      return response();
    };
    return { fetchImpl, calls };
  }

  const redirect = (status: number, location: string): Response =>
    new Response('', { status, headers: { location } });

  it('refuses a cross-origin 3xx carrying a SIWX header, and never re-sends it', async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      redirect(302, 'https://evil.example/collect'),
    );
    const res = await httpRequest('https://tenjin.blog/api/read/x', {
      timeoutMs: 1000,
      headers: { [SIWX_HEADER]: 'siwx-value' },
      fetchImpl,
    });

    expect(res).toMatchObject({ ok: false, kind: 'blocked-redirect', status: 302 });
    // The signature left exactly once, to the configured origin, and was not replayed.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://tenjin.blog/api/read/x');
    expect(calls[0]?.redirect).toBe('manual');
  });

  it('refuses a 3xx carrying a payment signature, matching the header case-insensitively', async () => {
    const { fetchImpl, calls } = recordingFetch(() => redirect(301, 'https://evil.example/'));
    const res = await httpRequest('https://tenjin.blog/api/read/x', {
      timeoutMs: 1000,
      // Lower-cased on purpose: header names are case-insensitive, and the guard
      // must not be dodgeable by changing how a caller spells the credential.
      headers: { 'payment-signature': 'pay-value' },
      fetchImpl,
    });

    expect(res).toMatchObject({ ok: false, kind: 'blocked-redirect', status: 301 });
    expect(calls[0]?.redirect).toBe('manual');
  });

  it('refuses a 3xx carrying the session delegation header (reusable SIWX signature)', async () => {
    const { fetchImpl, calls } = recordingFetch(() => redirect(302, 'https://evil.example/'));
    const res = await httpRequest('https://tenjin.blog/api/posts', {
      method: 'POST',
      timeoutMs: 1000,
      // The literal `session-key.ts` sends: a session-lifetime wallet signature,
      // re-sent verbatim on every session-signed write, so the most replayable
      // credential of the set.
      headers: { 'Tenjin-Session-Delegation': 'delegation-value' },
      jsonBody: {},
      fetchImpl,
    });

    expect(res).toMatchObject({ ok: false, kind: 'blocked-redirect', status: 302 });
    expect(calls[0]?.redirect).toBe('manual');
  });

  it('refuses a 3xx carrying the x402 v1 X-PAYMENT spelling (drift insurance)', async () => {
    const { fetchImpl, calls } = recordingFetch(() => redirect(302, 'https://evil.example/'));
    const res = await httpRequest('https://tenjin.blog/api/read/x', {
      timeoutMs: 1000,
      headers: { 'X-PAYMENT': 'pay-value' },
      fetchImpl,
    });

    expect(res).toMatchObject({ ok: false, kind: 'blocked-redirect', status: 302 });
    expect(calls[0]?.redirect).toBe('manual');
  });

  it('pins an UNSIGNED request when the caller sets blockRedirects (durable-artifact case)', async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      redirect(302, 'https://evil.example/content'),
    );
    const res = await httpRequest('https://tenjin.blog/api/read/x', {
      timeoutMs: 1000,
      headers: { accept: 'application/json' },
      blockRedirects: true,
      fetchImpl,
    });

    expect(res).toMatchObject({ ok: false, kind: 'blocked-redirect', status: 302 });
    expect(calls[0]?.redirect).toBe('manual');
    // The unsigned message must not claim a signed header was involved.
    expect((res as { message: string }).message).not.toContain('signed header');
  });

  it('leaves unsigned requests alone, redirects and all', async () => {
    const { fetchImpl, calls } = recordingFetch(
      () => new Response(JSON.stringify({ ok: 1 }), { status: 200 }),
    );
    const res = await httpRequest('https://tenjin.blog/api/search', {
      timeoutMs: 1000,
      headers: { accept: 'application/json' },
      fetchImpl,
    });

    // No credential, so no opt-out: the transport keeps its default follow behavior
    // and this stays a plain 200. The guard is scoped to signed traffic only.
    expect(res).toMatchObject({ ok: true, status: 200 });
    expect(calls[0]?.redirect).toBeUndefined();
  });

  it('lets a signed request through untouched when nothing redirects', async () => {
    const { fetchImpl } = recordingFetch(
      () => new Response(JSON.stringify({ id: 'ok' }), { status: 200 }),
    );
    const res = await httpRequest('https://tenjin.blog/api/read/x', {
      timeoutMs: 1000,
      headers: { [SIWX_HEADER]: 'siwx-value' },
      fetchImpl,
    });

    expect(res).toMatchObject({ ok: true, status: 200 });
  });

  /**
   * Everything above is read-path shaped: GETs plus one POST, all proving the guard
   * on the route this PR touches. tenjin-agent#46 (`tenjin edit`) adds the first
   * wallet-signed PUT — `PUT /api/posts/<id>` — and widens this module's `method`
   * union to admit it, so the guard is about to carry a class of traffic no case
   * here covers.
   *
   * It already holds for that traffic: `pinned` is derived from the headers alone
   * and is consulted before the status is read, so every verb inherits the refusal
   * for free. "For free" is precisely the kind of property a later refactor drops
   * without noticing, and a signed mutation is the worst place to find out — where
   * a replayed read signature leaks one purchase, a replayed PUT signature edits
   * the author's post on a host of the attacker's choosing. So the method axis gets
   * pinned explicitly rather than left as an implication, and neither PR has to
   * land first for it to hold.
   *
   * 307/308 are the dangerous statuses for a mutation specifically: unlike 301/302
   * they preserve the method AND the body, so a followed hop re-sends the entire
   * signed write rather than degrading it to a GET.
   */
  const MUTATING_METHODS: string[] = ['POST', 'PUT', 'PATCH', 'DELETE'];
  const CREDENTIALS: [string, string][] = [
    [SIWX_HEADER, 'siwx-value'],
    ['payment-signature', 'pay-value'],
    ['x-payment', 'pay-value'],
    ['tenjin-session-delegation', 'delegation-value'],
  ];

  for (const method of MUTATING_METHODS) {
    for (const [header, value] of CREDENTIALS) {
      for (const status of [307, 308]) {
        it(`refuses a ${status} on a signed ${method} carrying ${header}`, async () => {
          const { fetchImpl, calls } = recordingFetch(() =>
            redirect(status, 'https://evil.example/collect'),
          );
          const res = await httpRequest('https://tenjin.blog/api/posts/abc', {
            // Cast because THIS branch's union is still GET|POST; #46 widens it to
            // include PUT. The assertion is on the method literal, never on the
            // guard, and stays valid after that lands. PATCH/DELETE are not in the
            // union on either branch — they are here because the property under
            // test is that the refusal is header-derived and method-independent,
            // so a verb added later is covered the day it is added.
            method: method as NonNullable<HttpRequestOptions['method']>,
            timeoutMs: 1000,
            headers: { [header]: value },
            jsonBody: { title: 'edited' },
            fetchImpl,
          });

          expect(res).toMatchObject({ ok: false, kind: 'blocked-redirect', status });
          expect((res as { message: string }).message).toContain('signed header');
          // The signature left exactly once, to the configured origin, and the body
          // went nowhere else.
          expect(calls).toHaveLength(1);
          expect(calls[0]?.url).toBe('https://tenjin.blog/api/posts/abc');
          expect(calls[0]?.redirect).toBe('manual');
        });
      }
    }
  }

  it('still lets a signed PUT through when the origin answers without a hop', async () => {
    // Without this, the matrix above would be satisfied by a guard that simply
    // failed every signed mutation, which would break `edit` rather than secure it.
    const { fetchImpl, calls } = recordingFetch(
      () => new Response(JSON.stringify({ id: 'post-1' }), { status: 200 }),
    );
    const res = await httpRequest('https://tenjin.blog/api/posts/abc', {
      method: 'PUT' as NonNullable<HttpRequestOptions['method']>,
      timeoutMs: 1000,
      headers: { 'tenjin-session-delegation': 'delegation-value' },
      jsonBody: { title: 'edited' },
      fetchImpl,
    });

    expect(res).toMatchObject({ ok: true, status: 200 });
    expect(calls[0]?.redirect).toBe('manual');
  });
});

/**
 * Both transports document a returned discriminated failure for every
 * transport-layer refusal, so neither may throw where the other returns.
 */
describe('a caller header the Headers API rejects is a returned failure, not a throw', () => {
  // A space is not a legal token character, so `new Headers` throws on it.
  const malformed = { 'bad header': 'v' };
  function unreachedFetch(): { fetchImpl: typeof fetch; calls: number[] } {
    const calls: number[] = [];
    const fetchImpl: typeof fetch = async () => {
      calls.push(1);
      return new Response('{}', { status: 200 });
    };
    return { fetchImpl, calls };
  }

  it('httpRequest returns a network failure and dispatches nothing', async () => {
    const { fetchImpl, calls } = unreachedFetch();
    const res = await httpRequest('https://tenjin.blog/api/search', {
      timeoutMs: 1000,
      headers: malformed,
      fetchImpl,
    });
    expect(res).toMatchObject({ ok: false, kind: 'network' });
    // Counted, not inferred from an error: a request that could not be assembled
    // must not reach the wire in a half-built state, least of all an unpinned one.
    expect(calls).toHaveLength(0);
  });

  it('httpRequest refuses a signed request it cannot assemble, rather than sending it unpinned', async () => {
    const { fetchImpl, calls } = unreachedFetch();
    const res = await httpRequest('https://tenjin.blog/api/posts', {
      method: 'POST',
      timeoutMs: 1000,
      headers: { ...malformed, [SIWX_HEADER]: 'siwx-value' },
      jsonBody: { title: 'x' },
      fetchImpl,
    });
    expect(res).toMatchObject({ ok: false, kind: 'network' });
    expect(calls).toHaveLength(0);
  });

  it('fetchJson returns a network failure', async () => {
    const { fetchImpl, calls } = unreachedFetch();
    const res = await fetchJson('https://tenjin.blog/openapi.json', {
      timeoutMs: 1000,
      headers: malformed,
      fetchImpl,
    });
    expect(res).toMatchObject({ ok: false, kind: 'network' });
    expect(calls).toHaveLength(0);
  });
});

/**
 * THE ORIGIN TEST, IN THE TRANSPORT. The bypass secret opens a deployment, and
 * the CLI talks to two shelves in one session — sometimes inside one fire. The
 * decision therefore lives here, driven by the request URL, so a call site that
 * passes the key while fetching the wrong host sends nothing rather than the
 * key.
 */
describe('the team shelf bypass header', () => {
  const SECRET = 'shelf-secret-abc123';
  const bypass = { origin: 'https://team.example', secret: SECRET };

  function recorder(): { fetchImpl: typeof fetch; seen: Array<Record<string, string>> } {
    const seen: Array<Record<string, string>> = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      seen.push(Object.fromEntries(new Headers(init?.headers).entries()));
      return jsonResponse({ ok: true });
    };
    return { fetchImpl, seen };
  }

  it('is attached on the bypass origin and on no other, through both transports', async () => {
    for (const send of [
      (url: string, o: { fetchImpl: typeof fetch }) =>
        fetchJson(url, { timeoutMs: 1000, bypass, fetchImpl: o.fetchImpl }),
      (url: string, o: { fetchImpl: typeof fetch }) =>
        httpRequest(url, { timeoutMs: 1000, bypass, fetchImpl: o.fetchImpl }),
    ]) {
      const rec = recorder();
      await send('https://team.example/api/search', rec);
      await send('https://public.example/api/search', rec);
      // Not a sibling host, and not a different port on the same host: an origin
      // is scheme + host + port, and anything else is somebody else's server.
      await send('https://evil.team.example/api/search', rec);
      await send('https://team.example:8443/api/search', rec);
      expect(rec.seen.map((h) => h[SHELF_BYPASS_HEADER])).toEqual([
        SECRET,
        undefined,
        undefined,
        undefined,
      ]);
    }
  });

  it('sends nothing for an empty secret or an unparseable URL', () => {
    expect(
      shelfBypassHeaders('https://team.example/x', { origin: bypass.origin, secret: '' }),
    ).toEqual({});
    expect(shelfBypassHeaders('https://team.example/x', undefined)).toEqual({});
    expect(shelfBypassHeaders('not-a-url', bypass)).toEqual({});
  });

  /**
   * A 3xx MUST NOT CARRY THE DOOR KEY ONWARD. `fetch` re-sends request headers
   * verbatim to a redirect target (only `Authorization` is stripped), so a
   * Vercel Authentication interstitial on the shelf origin — what a rotated
   * bypass secret actually gets — would hand the key to `vercel.com` or to
   * whatever else `Location` names, and the key is all anyone needs to walk in.
   * The bypass is not replayable like a signature, so it is not in
   * CREDENTIAL_HEADERS; it pins anyway, because disclosure is the harm here.
   */
  describe('pins redirects the way a signed header does', () => {
    function recordingFetch(response: () => Response): {
      fetchImpl: typeof fetch;
      calls: { url: string; redirect: RequestInit['redirect'] }[];
    } {
      const calls: { url: string; redirect: RequestInit['redirect'] }[] = [];
      const fetchImpl: typeof fetch = async (input, init) => {
        calls.push({ url: String(input), redirect: init?.redirect });
        return response();
      };
      return { fetchImpl, calls };
    }

    const ssoRedirect = (): Response =>
      new Response('', {
        status: 307,
        headers: { location: 'https://vercel.com/sso-api?url=team.example' },
      });

    it('refuses a 3xx on the bypass origin, through httpRequest', async () => {
      const { fetchImpl, calls } = recordingFetch(ssoRedirect);
      const res = await httpRequest('https://team.example/api/search', {
        method: 'POST',
        timeoutMs: 1000,
        bypass,
        jsonBody: { query: 'q' },
        fetchImpl,
      });

      expect(res).toMatchObject({ ok: false, kind: 'blocked-redirect', status: 307 });
      expect((res as { message: string }).message).toContain('bypass key');
      // One request, to the configured origin, and the key was never re-sent.
      expect(calls).toHaveLength(1);
      expect(calls[0]?.redirect).toBe('manual');
    });

    it('refuses a 3xx on the bypass origin, through fetchJson (doctor probes)', async () => {
      const { fetchImpl, calls } = recordingFetch(ssoRedirect);
      const res = await fetchJson('https://team.example/api/search', {
        timeoutMs: 1000,
        bypass,
        fetchImpl,
      });

      // NOT reported as a plain http status: an unfollowed redirect must not be
      // mistaken for a server answer and retried by hand.
      expect(res).toMatchObject({ ok: false, kind: 'blocked-redirect', status: 307 });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.redirect).toBe('manual');
    });

    it('leaves an off-origin request on ordinary transport', async () => {
      // The public shelf gets no key, so it has nothing to disclose and keeps
      // normal redirect following: the pin is armed by the header, not by intent.
      for (const send of [
        (fetchImpl: typeof fetch) =>
          httpRequest('https://public.example/api/search', { timeoutMs: 1000, bypass, fetchImpl }),
        (fetchImpl: typeof fetch) =>
          fetchJson('https://public.example/api/search', { timeoutMs: 1000, bypass, fetchImpl }),
      ]) {
        const { fetchImpl, calls } = recordingFetch(() => jsonResponse({ ok: true }));
        await send(fetchImpl);
        expect(calls[0]?.redirect).toBeUndefined();
      }
    });
  });

  it('wins the slot on its own origin, and contributes nothing off it', async () => {
    // The bypass is merged OVER the caller's headers, so on-origin the real
    // secret replaces whatever a call site put in that slot; off-origin the rule
    // adds nothing at all, and the caller's own header is the caller's business.
    const rec = recorder();
    const planted = { [SHELF_BYPASS_HEADER]: 'planted' };
    await httpRequest('https://team.example/api/search', {
      timeoutMs: 1000,
      headers: planted,
      bypass,
      fetchImpl: rec.fetchImpl,
    });
    await httpRequest('https://public.example/api/search', {
      timeoutMs: 1000,
      headers: planted,
      bypass,
      fetchImpl: rec.fetchImpl,
    });
    expect(rec.seen[0]?.[SHELF_BYPASS_HEADER]).toBe(SECRET);
    expect(rec.seen[1]?.[SHELF_BYPASS_HEADER]).toBe('planted');
  });
});
