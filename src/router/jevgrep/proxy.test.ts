import { request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startJevgrepProxy } from './proxy.js';
import type { JevgrepEvaluate } from './proxy.js';
import { JEV_LIMITS, JEV_MAX_QUESTIONS, JEV_MODEL } from './protocol.js';
import type { NativeEvaluationRequest } from './protocol.js';
import { createJevgrepAnswerCache } from './answer-cache.js';
import type { JevgrepAnswerCache } from './answer-cache.js';
import { encodeMapleRequest } from './maple';
import { MAPLE_JEVGREP_SUPPLIER, type JevgrepSupplier } from './supplier';

const body: NativeEvaluationRequest = {
  model: JEV_MODEL,
  state: 'public source',
  questions: { q: { type: 'noul', instructions: 'Relevant?' } },
};
const answer = { answers: { q: { type: 'noul' as const, noul: 0.8 } } };
const proxies: Array<Awaited<ReturnType<typeof startJevgrepProxy>>> = [];
const directories: string[] = [];
async function proxy(
  evaluate: JevgrepEvaluate = async () => answer,
  cache?: JevgrepAnswerCache,
  supplier?: JevgrepSupplier,
) {
  const p = await startJevgrepProxy({ evaluate, cache, supplier });
  proxies.push(p);
  return p;
}
function send(
  p: Awaited<ReturnType<typeof proxy>>,
  value: unknown = body,
  overrides: {
    route?: string;
    method?: string;
    headers?: Record<string, string>;
    raw?: string;
  } = {},
) {
  const data = overrides.raw ?? JSON.stringify(value);
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = httpRequest(
      p.baseURL + (overrides.route ?? '/systemone'),
      {
        method: overrides.method ?? 'POST',
        headers: {
          authorization: `Bearer ${p.token}`,
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(data)),
          ...overrides.headers,
        },
      },
      (res) => {
        let result = '';
        res.on('data', (part) => {
          result += part;
        });
        res.on('end', () => resolve({ status: res.statusCode!, body: result }));
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}
afterEach(async () => {
  await Promise.all(proxies.splice(0).map((p) => p.close()));
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
describe('bounded local evaluation proxy', () => {
  it('forwards only a valid authenticated native request', async () => {
    const evaluate = vi.fn(async () => answer);
    const p = await proxy(evaluate);
    expect((await send(p)).status).toBe(200);
    expect(evaluate.mock.calls).toHaveLength(1);
    expect(p.summary()).toMatchObject({ requests: 1, active: 0 });
  });
  it('admits multi-question declaration batches and refuses oversized counts before evaluation', async () => {
    const evaluate = vi.fn(async (request: NativeEvaluationRequest) => ({
      answers: Object.fromEntries(
        Object.keys(request.questions).map((id) => [id, { type: 'noul' as const, noul: 0.8 }]),
      ),
    }));
    const p = await proxy(evaluate);
    const questions = Object.fromEntries(
      ['q', 'scope', 'ref'].flatMap((kind) =>
        Array.from({ length: 128 }, (_, index) => [
          `${kind}${index}`,
          { type: 'noul', instructions: `Evaluate ${kind} for declaration ${index}.` },
        ]),
      ),
    );
    expect(Object.keys(questions)).toHaveLength(JEV_MAX_QUESTIONS);
    const accepted = await send(p, { ...body, questions });
    expect(accepted.status).toBe(200);
    expect(Object.keys(JSON.parse(accepted.body).answers)).toHaveLength(JEV_MAX_QUESTIONS);
    const rejected = await send(p, {
      ...body,
      questions: { ...questions, extra: { type: 'noul', instructions: 'Too many' } },
    });
    expect(rejected.status).toBe(400);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(p.summary()).toMatchObject({ requests: 1, active: 0, stopReason: 'invalid-request' });
  });
  it.each([
    ['request-shape', { ...body, model: 'private source must not appear' }],
    ['question-count', { ...body, questions: {} }],
    [
      'question-shape',
      { ...body, questions: { secret: { type: 'choice', instructions: 'private source' } } },
    ],
  ])(
    'reports only the safe local %s failure and stops before evaluation',
    async (reason, input) => {
      const evaluate = vi.fn(async () => answer);
      const p = await proxy(evaluate);
      const result = await send(p, input);
      expect(result.status).toBe(400);
      expect(JSON.parse(result.body)).toEqual({
        error: `Invalid native evaluation request: ${reason}`,
      });
      expect(p.summary()).toMatchObject({ requests: 0, stopReason: 'invalid-request' });
      expect((await send(p)).body).toContain('Local search stopped: invalid-request');
      expect(evaluate).not.toHaveBeenCalled();
    },
  );
  it('does not echo malformed JSON in local validation diagnostics', async () => {
    const evaluate = vi.fn(async () => answer);
    const p = await proxy(evaluate);
    const result = await send(p, body, { raw: '{"source":"private source",' });
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body)).toEqual({
      error: 'Invalid native evaluation request: invalid-json',
    });
    expect(p.summary()).toMatchObject({ requests: 0, stopReason: 'invalid-request' });
    expect(evaluate).not.toHaveBeenCalled();
  });
  it('rejects hostile Host/origin/token/route/method before dispatch', async () => {
    const evaluate = vi.fn(async () => answer);
    const p = await proxy(evaluate);
    const attempts: Array<{ route?: string; method?: string; headers?: Record<string, string> }> = [
      { headers: { host: 'evil.example' } },
      { headers: { origin: 'http://evil.example' } },
      { headers: { authorization: 'Bearer wrong' } },
      { route: '/systemone?redirect=http://evil.example' },
      { method: 'PUT' },
    ];
    for (const options of attempts) {
      expect((await send(p, body, options)).status).toBe(options.headers ? 403 : 404);
    }
    expect(evaluate).not.toHaveBeenCalled();
  });
  it('enforces per-request bytes and exact answer IDs', async () => {
    const evaluate = vi.fn(async () => ({ answers: {} }));
    const p = await proxy(evaluate);
    expect((await send(p)).status).toBe(409);
    expect(
      (await send(await proxy(), { ...body, state: 'x'.repeat(JEV_LIMITS.requestBytes) })).status,
    ).toBe(413);
    expect(evaluate).toHaveBeenCalledTimes(1);
  });
  it('keeps searching after an uncertain payment, refuses its replacement, and stops past the limit', async () => {
    let uncertain = true;
    const evaluate = vi.fn(async () => {
      if (!uncertain) return answer;
      uncertain = false;
      throw Object.assign(new Error('never expose provider secret'), {
        details: {
          reason: 'payment_uncertain',
          diagnostic: { code: 'PAYMENT_FAILED', phase: 'payment', status: 429 },
        },
      });
    });
    const p = await proxy(evaluate);
    const first = await send(p);
    expect(first.status).toBe(429);
    expect(first.body).not.toContain('secret');
    expect((await send(p)).status).toBe(200);
    expect(p.summary()).toMatchObject({ uncertainFailures: 1, stopReason: undefined });

    const unresolved = await proxy(async () => {
      throw Object.assign(new Error('secret'), { details: { reason: 'unresolved' } });
    });
    expect((await send(unresolved)).status).toBe(503);
    expect((await send(unresolved)).status).toBe(503);
    expect(unresolved.summary().stopReason).toBeUndefined();

    // A generic settlement failure under load is one more uncertain evaluation.
    const flaky = await proxy(async () => {
      throw Object.assign(new Error('secret'), {
        details: {
          reason: 'payment_uncertain',
          diagnostic: {
            code: 'PAYMENT_FAILED',
            phase: 'payment',
            status: 402,
            paymentFailure: { stage: 'settlement', reason: 'settlement_failed' },
          },
        },
      });
    });
    expect((await send(flaky)).status).toBe(429);
    expect(flaky.summary()).toMatchObject({ uncertainFailures: 1, stopReason: undefined });

    // The supplier's own facilitator billing repeats for every later request: stop at once.
    const rejected = await proxy(async () => {
      throw Object.assign(new Error('secret'), {
        details: {
          reason: 'payment_uncertain',
          diagnostic: {
            code: 'PAYMENT_FAILED',
            phase: 'payment',
            status: 402,
            paymentFailure: { stage: 'settlement', reason: 'provider_payment_method_required' },
          },
        },
      });
    });
    expect((await send(rejected)).status).toBe(409);
    expect(rejected.summary()).toMatchObject({
      uncertainFailures: 0,
      stopReason: 'payment_uncertain',
    });

    const repeated = await proxy(async () => {
      throw Object.assign(new Error('secret'), { details: { reason: 'payment_uncertain' } });
    });
    for (let i = 0; i < 16; i++) expect((await send(repeated)).status).toBe(429);
    expect((await send(repeated)).status).toBe(409);
    expect(repeated.summary()).toMatchObject({
      uncertainFailures: 16,
      stopReason: 'payment_uncertain',
    });
  });
  it.each(['budget', 'provider'])(
    'preserves safe payer reason %s and stops new dispatch',
    async (reason) => {
      const evaluate = vi.fn(async () => {
        throw Object.assign(new Error('never expose provider secret'), { details: { reason } });
      });
      const p = await proxy(evaluate);
      const first = await send(p);
      expect(first.status).toBe(409);
      expect(first.body).not.toContain('secret');
      expect(first.body).toContain(reason);
      expect(p.summary().stopReason).toBe(reason);
      expect((await send(p)).status).toBe(409);
      expect((await send(p, body, { headers: { authorization: 'Bearer wrong' } })).status).toBe(
        403,
      );
      expect(evaluate).toHaveBeenCalledTimes(1);
    },
  );
  it('answers 429 for a transient failure before payment, then stops past the limit', async () => {
    const transient = () =>
      Object.assign(new Error('never expose provider secret'), {
        details: { reason: 'provider', diagnostic: { code: 'NETWORK_ERROR', phase: 'payment' } },
      });
    let failures = 0;
    const evaluate = vi.fn(async () => {
      if (failures++ < 2) throw transient();
      return answer;
    });
    const p = await proxy(evaluate);
    const first = await send(p);
    expect(first.status).toBe(429);
    expect(first.body).not.toContain('secret');
    expect((await send(p)).status).toBe(429);
    expect((await send(p)).status).toBe(200);
    expect(p.summary()).toMatchObject({ transientFailures: 2, stopReason: undefined });

    const overloaded = await proxy(async () => {
      throw Object.assign(new Error('secret'), {
        details: {
          reason: 'provider',
          diagnostic: { code: 'UNKNOWN', phase: 'payment', status: 503 },
        },
      });
    });
    for (let i = 0; i < 32; i++) expect((await send(overloaded)).status).toBe(429);
    expect((await send(overloaded)).status).toBe(409);
    expect(overloaded.summary()).toMatchObject({ transientFailures: 32, stopReason: 'provider' });

    // A deterministic refusal before payment still stops the search.
    for (const details of [
      { reason: 'provider', diagnostic: { code: 'PAYMENT_FAILED', phase: 'payment', status: 402 } },
      {
        reason: 'provider',
        diagnostic: { code: 'REFUSED', phase: 'payment', reason: 'insufficient_funds' },
      },
    ]) {
      const terminal = await proxy(async () => {
        throw Object.assign(new Error('secret'), { details });
      });
      expect((await send(terminal)).status).toBe(409);
      expect(terminal.summary().stopReason).toBe(details.reason);
    }
  });
  it('admits at most the profile concurrency of evaluations at once', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const evaluate = vi.fn(async () => {
      await gate;
      return answer;
    });
    const p = await proxy(evaluate);
    const admitted = Array.from({ length: JEV_LIMITS.concurrency }, () => send(p));
    await vi.waitFor(() => expect(evaluate).toHaveBeenCalledTimes(JEV_LIMITS.concurrency));
    expect((await send(p)).status).toBe(429);
    release();
    await Promise.all(admitted);
  });
  it('stops at 60 evaluations without dispatching a 61st', async () => {
    const evaluate = vi.fn(async () => answer);
    const p = await proxy(evaluate);
    for (let i = 0; i < JEV_LIMITS.requests; i++) expect((await send(p)).status).toBe(200);
    expect((await send(p)).status).toBe(409);
    expect((await send(p)).body).toContain('request-limit');
    expect(evaluate).toHaveBeenCalledTimes(JEV_LIMITS.requests);
    expect(p.summary().stopReason).toBe('request-limit');
  });
  it('counts aggregate input bytes before new provider dispatch', async () => {
    const evaluate = vi.fn(async () => answer);
    const p = await proxy(evaluate);
    const large = { ...body, state: 'x'.repeat(120 * 1024) };
    for (let i = 0; i < 17; i++) expect((await send(p, large)).status).toBe(200);
    expect((await send(p, large)).status).toBe(413);
    expect((await send(p)).status).toBe(409);
    expect(evaluate).toHaveBeenCalledTimes(17);
    expect(p.summary().stopReason).toBe('total-byte-limit');
  });
  it('keeps a per-request byte stop terminal without misreporting authentication', async () => {
    const evaluate = vi.fn(async () => answer);
    const p = await proxy(evaluate);
    expect((await send(p, { ...body, state: 'x'.repeat(JEV_LIMITS.requestBytes) })).status).toBe(
      413,
    );
    const stopped = await send(p);
    expect(stopped.status).toBe(409);
    expect(stopped.body).toContain('request-byte-limit');
    expect(evaluate).not.toHaveBeenCalled();
  });
  it('reserves expanded Maple body bytes before aggregate provider admission', async () => {
    const evaluate = vi.fn(async () => answer);
    const p = await proxy(evaluate, undefined, MAPLE_JEVGREP_SUPPLIER);
    const escaped = { ...body, state: { source: '"\\'.repeat(15_000) } };
    const nativeBytes = Buffer.byteLength(JSON.stringify(escaped));
    const supplierBytes = Buffer.byteLength(encodeMapleRequest(escaped));
    const admitted = Math.floor(JEV_LIMITS.totalRequestBytes / supplierBytes);
    expect(supplierBytes).toBeGreaterThan(nativeBytes);
    expect(supplierBytes).toBeLessThan(JEV_LIMITS.requestBytes);
    // Ingress-only accounting would admit this next request and overrun egress.
    expect((admitted + 1) * nativeBytes).toBeLessThan(JEV_LIMITS.totalRequestBytes);
    for (let i = 0; i < admitted; i++) expect((await send(p, escaped)).status).toBe(200);
    expect((await send(p, escaped)).status).toBe(413);
    expect(evaluate).toHaveBeenCalledTimes(admitted);
    expect(p.summary()).toMatchObject({
      requests: admitted,
      requestBytes: admitted * supplierBytes,
      stopReason: 'total-byte-limit',
    });
  });
  it('checks Maple per-request expansion only for supplier misses', async () => {
    const evaluate = vi.fn(async () => answer);
    const escaped = { ...body, state: { source: '"\\'.repeat(17_000) } };
    expect(Buffer.byteLength(JSON.stringify(escaped))).toBeLessThan(JEV_LIMITS.requestBytes);
    const hit = await proxy(
      evaluate,
      { get: async () => answer, put: async () => {} },
      MAPLE_JEVGREP_SUPPLIER,
    );
    expect((await send(hit, escaped)).status).toBe(200);
    expect(hit.summary()).toMatchObject({ requests: 0, requestBytes: 0, cacheHits: 1 });
    const miss = await proxy(evaluate, undefined, MAPLE_JEVGREP_SUPPLIER);
    expect((await send(miss, escaped)).status).toBe(413);
    expect(miss.summary()).toMatchObject({
      requests: 0,
      requestBytes: 0,
      stopReason: 'request-byte-limit',
    });
    expect(evaluate).not.toHaveBeenCalled();
  });
  it('cancels pending callbacks and closes its listener', async () => {
    let seenSignal: AbortSignal | undefined;
    const p = await proxy(async (_body, signal) => {
      seenSignal = signal;
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      return answer;
    });
    const pending = send(p).catch(() => undefined);
    await vi.waitFor(() => expect(seenSignal).toBeDefined());
    await p.close();
    await pending;
    expect(seenSignal!.aborted).toBe(true);
    await expect(send(p)).rejects.toThrow();
  });
  it('reuses persisted answers on another proxy without paying for hits or their bytes', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'jev-proxy-cache-'));
    directories.push(dataDir);
    const options = {
      dataDir,
      root: '/approved',
      commit: 'a'.repeat(40),
      query: 'question',
      runtime: { kind: 'local-artifact' as const, path: '/fixture.tgz', sha256: 'b'.repeat(64) },
    };
    const evaluate = vi.fn(async () => answer);
    const first = await proxy(evaluate, createJevgrepAnswerCache(options));
    const large = { ...body, state: 'x'.repeat(120 * 1024) };
    expect((await send(first, large)).status).toBe(200);
    await first.close();
    const second = await proxy(evaluate, createJevgrepAnswerCache(options));
    expect(second.baseURL).not.toBe(first.baseURL);
    for (let i = 0; i < JEV_LIMITS.requests + 1; i++)
      expect((await send(second, large)).status).toBe(200);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(second.summary()).toMatchObject({
      requests: 0,
      requestBytes: 0,
      cacheHits: 61,
      stopReason: undefined,
    });
    expect(second.summary().localRequestBytes).toBeGreaterThan(JEV_LIMITS.totalRequestBytes);
    // A miss still uses the ordinary payer; a hit never changes its policy.
    expect((await send(second, { ...body, state: 'changed' })).status).toBe(200);
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(second.summary().requests).toBe(1);
  });
  it('coalesces concurrent identical misses before paid admission and does not cache invalid answers', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const evaluate = vi.fn(async () => {
      await gate;
      return answer;
    });
    const cache = { get: vi.fn(async () => undefined), put: vi.fn(async () => {}) };
    const p = await proxy(evaluate, cache);
    const first = send(p),
      second = send(p);
    await vi.waitFor(() => expect(p.summary().active).toBe(2));
    expect(evaluate).toHaveBeenCalledTimes(1);
    release();
    expect((await Promise.all([first, second])).map((r) => r.status)).toEqual([200, 200]);
    expect(p.summary()).toMatchObject({ requests: 1, joined: 1 });
    expect(cache.put).toHaveBeenCalledTimes(1);
    const badCache = { get: vi.fn(async () => undefined), put: vi.fn(async () => {}) };
    expect((await send(await proxy(async () => ({ answers: {} }), badCache))).status).toBe(409);
    expect(badCache.put).not.toHaveBeenCalled();
  });
  it('serves an existing answer at the paid ceiling but refuses the next uncached evaluation', async () => {
    const evaluate = vi.fn(async () => answer);
    const saved = new Set<string>();
    const p = await proxy(evaluate, {
      get: async (request) => (saved.has(JSON.stringify(request)) ? answer : undefined),
      put: async (request) => {
        saved.add(JSON.stringify(request));
      },
    });
    for (let i = 0; i < JEV_LIMITS.requests; i++)
      expect((await send(p, { ...body, state: `source-${i}` })).status).toBe(200);
    expect((await send(p, { ...body, state: 'source-0' })).status).toBe(200);
    expect((await send(p, { ...body, state: 'uncached' })).status).toBe(409);
    expect(p.summary()).toMatchObject({
      requests: JEV_LIMITS.requests,
      cacheHits: 1,
      stopReason: 'request-limit',
    });
    expect(evaluate).toHaveBeenCalledTimes(JEV_LIMITS.requests);
  });
  it('bounds repeated cache hits without consuming paid requests', async () => {
    const evaluate = vi.fn(async () => answer);
    const p = await proxy(evaluate, { get: async () => answer, put: async () => {} });
    for (let i = 0; i < JEV_LIMITS.localRequests; i++) expect((await send(p)).status).toBe(200);
    expect((await send(p)).status).toBe(409);
    expect(p.summary()).toMatchObject({
      requests: 0,
      requestBytes: 0,
      stopReason: 'local-request-limit',
    });
    expect(evaluate).not.toHaveBeenCalled();
  }, 30_000);
  it('bounds aggregate cache-hit ingress independently of supplier egress', async () => {
    const evaluate = vi.fn(async () => answer);
    const p = await proxy(evaluate, { get: async () => answer, put: async () => {} });
    const large = { ...body, state: 'x'.repeat(120 * 1024) };
    const count = Math.floor(
      JEV_LIMITS.localRequestBytes / Buffer.byteLength(JSON.stringify(large)),
    );
    for (let i = 0; i < count; i++) expect((await send(p, large)).status).toBe(200);
    expect((await send(p, large)).status).toBe(413);
    expect(p.summary()).toMatchObject({
      requests: 0,
      requestBytes: 0,
      stopReason: 'local-byte-limit',
    });
    expect(evaluate).not.toHaveBeenCalled();
  }, 30_000);
});

it('extended admission accepts large requests beyond the standard 60-call bound', async () => {
  const evaluate = vi.fn(async () => answer);
  const p = await startJevgrepProxy({ evaluate, profile: 'extended-v1' });
  proxies.push(p);
  expect((await send(p, { ...body, state: 'x'.repeat(160000) })).status).toBe(200);
  for (let i = 0; i < 60; i++) expect((await send(p, { ...body, state: i })).status).toBe(200);
  expect(p.summary()).toMatchObject({ requests: 61, stopReason: undefined });
  expect((await send(p, { ...body, state: 'x'.repeat(262144) })).status).toBe(413);
  expect(evaluate).toHaveBeenCalledTimes(61);
});
