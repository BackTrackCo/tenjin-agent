import { describe, it, expect } from 'vitest';
import { fetchJson, fetchFailureToCliError, httpRequest } from './http';
import { SIWX_HEADER } from './siwx';
import { CliError } from './errors';
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
