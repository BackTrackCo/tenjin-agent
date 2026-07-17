import { describe, it, expect } from 'vitest';
import { fetchJson, fetchFailureToCliError } from './http';
import { CliError } from './errors';
import type { FetchJsonFailure } from './http';

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
