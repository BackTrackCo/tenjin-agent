import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  fetchFailureToCliError,
  httpRequest,
  isBinaryContentType,
  setTenjinIdentity,
  transportFailure,
  INSTALL_ID_HEADER,
} from './http';
import { SIWX_HEADER } from './siwx';
import { CliError, exitCodeFor } from './errors';
import { CALLER_USER_AGENT_ENV, TENJIN_PRODUCT, TENJIN_USER_AGENT } from './client-meta';
import type { FetchJsonFailure, HttpRequestOptions } from './http';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, ...init });
}

describe('httpRequest timeouts', () => {
  it('aborts and reports a timeout when the request outlasts timeoutMs', async () => {
    // A fetch that never settles on its own but honors the abort signal, so the
    // internal timer is what ends it — proving the AbortController wiring.
    const hangingFetch: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('The operation was aborted', 'AbortError')),
        );
      });
    const res = await httpRequest('https://x.example/api', {
      timeoutMs: 10,
      fetchImpl: hangingFetch,
    });
    expect(res).toMatchObject({ ok: false, kind: 'timeout' });
  });

  it('times out on a response whose body never completes, instead of hanging', async () => {
    // Headers resolve immediately but the body stream never ends. It errors on
    // abort exactly as real fetch wires the signal into the body, so the timer —
    // which must stay armed through the body read — is what ends it.
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
    const res = await httpRequest('https://x.example/api', {
      timeoutMs: 20,
      fetchImpl: stalledFetch,
    });
    expect(res).toMatchObject({ ok: false, kind: 'timeout' });
  });

  it('keeps the headers that came before a body that ran out of time', async () => {
    const stalledFetch: typeof fetch = (async (_url, init) => {
      const body = new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener('abort', () =>
            controller.error(new DOMException('The operation was aborted', 'AbortError')),
          );
        },
      });
      return new Response(body, {
        status: 200,
        headers: { 'X-Status-Url': 'https://x.example/status/1' },
      });
    }) as typeof fetch;
    const res = await httpRequest('https://x.example/api', {
      timeoutMs: 20,
      fetchImpl: stalledFetch,
    });
    expect(res).toMatchObject({ ok: false, kind: 'timeout' });
    expect(!res.ok && res.header?.('x-status-url')).toBe('https://x.example/status/1');
  });
});

/**
 * The tenjin-cli User-Agent identity (spec: user-agent-telemetry-and-client-
 * attribution.md PR 3). The transport sends it on every request from a single
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

  it('a bodyless PATCH asks for JSON, as POST and PUT do', async () => {
    const { fetchImpl, calls } = headerCapture();
    await httpRequest('https://tenjin.blog/api/x', { method: 'PATCH', timeoutMs: 1000, fetchImpl });
    expect(calls[0]?.get('accept')).toBe('application/json');
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
 * composer itself; these pin that the transport reads BOTH seams and that the
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

  const COMPOSED = `${TENJIN_PRODUCT} codex/1.2.0 (+https://tenjin.sh)`;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('composes the env handoff', async () => {
    vi.stubEnv(CALLER_USER_AGENT_ENV, 'codex/1.2.0');
    const { fetchImpl, calls } = headerCapture();
    await httpRequest('https://tenjin.blog/api/search', { timeoutMs: 1000, fetchImpl });
    expect(calls[0]?.get('user-agent')).toBe(COMPOSED);
  });

  it('composes the programmatic handoff, which beats the env', async () => {
    vi.stubEnv(CALLER_USER_AGENT_ENV, 'from-env/9.9');
    const { fetchImpl, calls } = headerCapture();
    await httpRequest('https://tenjin.blog/api/search', {
      timeoutMs: 1000,
      callerUserAgent: 'codex/1.2.0',
      fetchImpl,
    });
    expect(calls[0]?.get('user-agent')).toBe(COMPOSED);
  });

  it('sends the identity alone when the handoff is unusable', async () => {
    vi.stubEnv(CALLER_USER_AGENT_ENV, 'codex/1.2.0 (host=laptop.local)');
    const { fetchImpl, calls } = headerCapture();
    await httpRequest('https://tenjin.blog/api/search', { timeoutMs: 1000, fetchImpl });
    expect(calls[0]?.get('user-agent')).toBe(TENJIN_USER_AGENT);
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
    ['blocked-redirect', 'API_UNREACHABLE'],
  ];
  it.each(cases)('maps a %s failure to %s', (kind, code) => {
    const failure = { ok: false, kind, message: 'boom' } as FetchJsonFailure;
    const err = fetchFailureToCliError(failure);
    expect(err).toBeInstanceOf(CliError);
    expect(err.code).toBe(code);
    expect(err.message).toBe('boom');
  });

  it('threads fix and details onto the CliError', () => {
    const failure: FetchJsonFailure = { ok: false, kind: 'network', message: 'down' };
    const err = fetchFailureToCliError(failure, { fix: 'retry', details: { status: 503 } });
    expect(err.fix).toBe('retry');
    expect(err.details).toEqual({ status: 503 });
  });
});

/**
 * The signed-redirect guard. Nothing signed may leave for a host the request did
 * not name, but `fetch`'s default `redirect: 'follow'` re-sends request headers
 * verbatim to whatever `Location` names, stripping only `Authorization`. So a 3xx
 * on a signed route would hand a signature bound to the real domain to another
 * host, replayable against it for the signature's lifetime. These pin that it
 * cannot happen.
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
      // The session-lifetime wallet signature an earlier release sent on every
      // session-signed write: still refused, so still pinned.
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
 * The transport documents a returned discriminated failure for every
 * transport-layer refusal, so it never throws one.
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
});

/**
 * An x402 challenge travels in a response header, and Node reads at most 16 KiB
 * of headers unless `--max-http-header-size` says otherwise. A seller that
 * embeds its whole output schema in the challenge can exceed that on its own
 * (AnyAPI's is 52 KB, measured 2026-09-22), and undici then aborts the request:
 * the generic path reported `fetch failed` with no status and nothing naming
 * the cause, which reads as "the endpoint is down" for a seller that is
 * answering perfectly.
 */
describe('a 402 challenge too large for this process to read', () => {
  const overflow = (shape: 'direct' | 'cause' | 'code'): typeof fetch =>
    (async () => {
      if (shape === 'code') {
        throw Object.assign(new TypeError('fetch failed'), {
          cause: Object.assign(new Error('unexpected'), { code: 'UND_ERR_HEADERS_OVERFLOW' }),
        });
      }
      if (shape === 'cause') {
        throw Object.assign(new TypeError('fetch failed'), {
          cause: new Error('Headers Overflow Error'),
        });
      }
      throw new Error('Headers Overflow Error');
    }) as typeof fetch;

  it.each(['direct', 'cause', 'code'] as const)(
    'names it rather than reporting a dead connection (%s)',
    async (shape) => {
      const result = await httpRequest('https://api.example.test/v1/run/thing', {
        method: 'POST',
        timeoutMs: 5_000,
        jsonBody: {},
        fetchImpl: overflow(shape),
      });
      expect(result.ok).toBe(false);
      const failure = result as Extract<typeof result, { ok: false }>;
      expect(failure.kind).toBe('oversized-header');
      // The ORIGIN, not the path: the whole host answers this way.
      expect(failure.message).toContain('https://api.example.test');
      expect(failure.message).not.toContain('/v1/run/thing');
      // The transport says what it could not read and NOTHING about payment:
      // it serves the unpaid probe and the paid retry alike, so either claim
      // would be wrong on one of them. The leg adds that sentence.
      expect(failure.message).toContain('could not be read');
      expect(failure.message).not.toMatch(/nothing was (sent|paid)|authorization/i);
    },
  );

  it('maps to CHALLENGE_TOO_LARGE with the operator knob, not a retry', async () => {
    const result = await httpRequest('https://api.example.test/pay', {
      timeoutMs: 5_000,
      fetchImpl: overflow('cause'),
    });
    const err = fetchFailureToCliError(result as Extract<typeof result, { ok: false }>);
    expect(err.code).toBe('CHALLENGE_TOO_LARGE');
    expect(exitCodeFor(err.code)).toBe(3);
    expect(err.fix).toContain('--max-http-header-size');
    expect(err.fix).not.toMatch(/try again|retry/i);
    expect(err.fix).not.toMatch(/nothing was (sent|paid)|authorization/i);
  });

  it('is still a plain network failure when the abort is anything else', async () => {
    const result = await httpRequest('https://api.example.test/pay', {
      timeoutMs: 5_000,
      fetchImpl: (async () => {
        throw new Error('socket hang up');
      }) as typeof fetch,
    });
    expect((result as Extract<typeof result, { ok: false }>).kind).toBe('network');
  });
});

describe('the layer a request failed at, before any origin answered', () => {
  const coded = (message: string, code: string) => Object.assign(new Error(message), { code });
  /** fetch's own wrapping, as Node 24 throws it for a proxy that refuses CONNECT. */
  const wrapped = (inner: Error) =>
    new TypeError('fetch failed', {
      cause: new Error('Request was cancelled.', { cause: inner }),
    });

  it.each([
    [
      coded('Proxy response (403) !== 200 when HTTP Tunneling', 'UND_ERR_ABORTED'),
      { layer: 'proxy', proxyStatus: 403 },
    ],
    [coded('getaddrinfo EAI_AGAIN tenjin.blog', 'EAI_AGAIN'), { layer: 'dns', code: 'EAI_AGAIN' }],
    [
      coded('certificate has expired', 'CERT_HAS_EXPIRED'),
      { layer: 'tls', code: 'CERT_HAS_EXPIRED' },
    ],
    [coded('connect ECONNREFUSED', 'ECONNREFUSED'), { layer: 'connect', code: 'ECONNREFUSED' }],
  ])('reads it off the cause chain (%s)', (inner, expected) => {
    expect(transportFailure(wrapped(inner))).toEqual(expected);
  });

  it('names nothing when no link names a layer', () => {
    expect(transportFailure(wrapped(new Error('socket hang up')))).toBeUndefined();
  });

  it('rides on the network failure httpRequest returns', async () => {
    const result = await httpRequest('https://tenjin.blog/api/x402-router', {
      method: 'POST',
      timeoutMs: 5_000,
      jsonBody: {},
      fetchImpl: (async () => {
        throw wrapped(coded('Proxy response (407) !== 200 when HTTP Tunneling', 'UND_ERR_ABORTED'));
      }) as typeof fetch,
    });
    expect(result).toMatchObject({
      ok: false,
      kind: 'network',
      transport: { layer: 'proxy', proxyStatus: 407 },
    });
  });
});

describe('the install id header', () => {
  const INSTALL = '6f1c2b1e-8d4a-4c3e-9a55-0d2f3b4c5d6e';
  const TENJIN = 'https://tenjin.test';

  afterEach(() => setTenjinIdentity(undefined));

  function useIdentity(installId: () => Promise<string | undefined>): void {
    setTenjinIdentity({ origins: async () => [TENJIN], installId });
  }

  interface Seen {
    url: string;
    method: string | undefined;
    body: unknown;
    redirect: RequestInit['redirect'];
    headers: Record<string, string>;
  }

  /** Answers each URL from `routes`, recording what every hop was sent. */
  function router(routes: Record<string, () => Response>): {
    fetchImpl: typeof fetch;
    seen: Seen[];
  } {
    const seen: Seen[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      seen.push({
        url,
        method: init?.method,
        body: init?.body,
        redirect: init?.redirect,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
      });
      const answer = routes[url];
      if (answer === undefined) throw new Error(`unrouted ${url}`);
      return answer();
    };
    return { fetchImpl, seen };
  }

  const ok = (): Response => jsonResponse({ ok: true });
  const hop = (status: number, location: string) => (): Response =>
    new Response('', { status, headers: { location } });

  it('rides Tenjin-origin requests, and no provider request', async () => {
    useIdentity(async () => INSTALL);
    const { fetchImpl, seen } = router({
      [`${TENJIN}/api/x402-router`]: ok,
      'https://api.exa.ai/search': ok,
    });
    await httpRequest(`${TENJIN}/api/x402-router`, {
      method: 'POST',
      timeoutMs: 1000,
      jsonBody: {},
      blockRedirects: true,
      fetchImpl,
    });
    await httpRequest('https://api.exa.ai/search', { method: 'POST', timeoutMs: 1000, fetchImpl });

    expect(seen.map((s) => s.headers[INSTALL_ID_HEADER])).toEqual([INSTALL, undefined]);
    // A provider request keeps `fetch`'s own transport, untouched.
    expect(seen[1]?.redirect).toBeUndefined();
  });

  it('is not sent to a sibling host or another port of the Tenjin host', async () => {
    useIdentity(async () => INSTALL);
    const urls = [
      'https://evil.tenjin.test/x',
      'https://tenjin.test:8443/x',
      'http://tenjin.test/x',
    ];
    const { fetchImpl, seen } = router(Object.fromEntries(urls.map((url) => [url, ok])));
    for (const url of urls) await httpRequest(url, { timeoutMs: 1000, fetchImpl });
    expect(seen).toHaveLength(3);
    expect(seen.every((s) => s.headers[INSTALL_ID_HEADER] === undefined)).toBe(true);
  });

  it('sends no header when there is no install id', async () => {
    useIdentity(async () => undefined);
    const { fetchImpl, seen } = router({ [`${TENJIN}/api/search`]: ok });
    await httpRequest(`${TENJIN}/api/search`, { timeoutMs: 1000, fetchImpl });
    expect(seen[0]?.headers).not.toHaveProperty(INSTALL_ID_HEADER);
  });

  it('sends the request without it when reading the id throws', async () => {
    useIdentity(async () => {
      throw new Error('EACCES');
    });
    const { fetchImpl, seen } = router({ [`${TENJIN}/api/search`]: ok });
    const res = await httpRequest(`${TENJIN}/api/search`, { timeoutMs: 1000, fetchImpl });
    expect(res).toMatchObject({ ok: true, status: 200 });
    expect(seen[0]?.headers).not.toHaveProperty(INSTALL_ID_HEADER);
    expect(seen[0]?.redirect).toBeUndefined();
  });

  it('leaves a pinned request failing closed on any redirect, as before', async () => {
    useIdentity(async () => INSTALL);
    const { fetchImpl, seen } = router({
      [`${TENJIN}/api/x402-router`]: hop(302, 'https://elsewhere.example/'),
    });
    const res = await httpRequest(`${TENJIN}/api/x402-router`, {
      method: 'POST',
      timeoutMs: 1000,
      jsonBody: {},
      blockRedirects: true,
      fetchImpl,
    });
    expect(res).toMatchObject({ ok: false, kind: 'blocked-redirect' });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.redirect).toBe('manual');
    expect(seen[0]?.headers[INSTALL_ID_HEADER]).toBe(INSTALL);
  });

  it('sends no install id, and mints none, on an anonymous request', async () => {
    const installId = vi.fn(async () => INSTALL);
    useIdentity(installId);
    const { fetchImpl, seen } = router({ [`${TENJIN}/api/x402-router`]: ok });
    await httpRequest(`${TENJIN}/api/x402-router`, {
      method: 'POST',
      timeoutMs: 1000,
      jsonBody: {},
      anonymous: true,
      fetchImpl,
    });
    expect(seen[0]?.headers).not.toHaveProperty(INSTALL_ID_HEADER);
    expect(installId).not.toHaveBeenCalled();
  });

  it("leaves an unpinned request on fetch's own redirect handling", async () => {
    useIdentity(async () => INSTALL);
    const { fetchImpl, seen } = router({ [`${TENJIN}/api/search`]: ok });
    await httpRequest(`${TENJIN}/api/search`, { timeoutMs: 1000, fetchImpl });
    expect(seen[0]?.headers[INSTALL_ID_HEADER]).toBe(INSTALL);
    expect(seen[0]?.redirect).toBeUndefined();
  });
});

describe('a binary body, kept as bytes only when asked', () => {
  const bytes = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0x80]);
  const fetchImpl = (async () =>
    new Response(bytes, {
      status: 200,
      headers: { 'content-type': 'audio/mpeg' },
    })) as typeof fetch;

  it('returns the bytes and an empty text with binaryBody', async () => {
    const res = await httpRequest('https://seller.example.test/a', {
      timeoutMs: 1000,
      fetchImpl,
      binaryBody: true,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.bytes).toEqual(bytes);
    expect(res.text).toBe('');
    expect(res.json).toBeUndefined();
  });

  it('refuses a binary body over the cap, read in chunks and never buffered whole', async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 100) throw new Error('read past the cap');
        controller.enqueue(new Uint8Array(4));
      },
    });
    const endless = (async () =>
      new Response(stream, {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' },
      })) as typeof fetch;
    const res = await httpRequest('https://seller.example.test/a', {
      timeoutMs: 1000,
      fetchImpl: endless,
      binaryBody: true,
      maxBinaryBytes: 10,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain('over the');
    expect(pulled).toBeLessThan(10);
  });

  it('refuses a declared length over the cap without reading it', async () => {
    const declared = (async () =>
      new Response(new Uint8Array(16), {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': '16' },
      })) as typeof fetch;
    const res = await httpRequest('https://seller.example.test/a', {
      timeoutMs: 1000,
      fetchImpl: declared,
      binaryBody: true,
      maxBinaryBytes: 8,
    });
    expect(res.ok).toBe(false);
  });

  it('reads text as before without it', async () => {
    const res = await httpRequest('https://seller.example.test/a', { timeoutMs: 1000, fetchImpl });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.bytes).toBeUndefined();
    expect(res.text.length).toBeGreaterThan(0);
  });

  it.each([
    ['audio/mpeg', true],
    ['image/png', true],
    ['application/octet-stream', true],
    ['application/pdf', true],
    ['application/json; charset=utf-8', false],
    ['application/problem+json', false],
    ['text/html', false],
    ['application/xml', false],
    ['image/svg+xml', false],
    ['', false],
  ])('%s is binary: %s', (type, binary) => {
    expect(isBinaryContentType(type)).toBe(binary);
  });
});
