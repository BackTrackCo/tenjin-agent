import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startJevgrepProxy } from './proxy.js';
import type { JevgrepEvaluate } from './proxy.js';
import { JEV_LIMITS, JEV_MODEL } from './protocol.js';

const body = {
  model: JEV_MODEL,
  state: 'public source',
  questions: { q: { type: 'noul', instructions: 'Relevant?' } },
};
const answer = { answers: { q: { type: 'noul' as const, noul: 0.8 } } };
const proxies: Array<Awaited<ReturnType<typeof startJevgrepProxy>>> = [];
async function proxy(evaluate: JevgrepEvaluate = async () => answer) {
  const p = await startJevgrepProxy({ evaluate });
  proxies.push(p);
  return p;
}
function send(
  p: Awaited<ReturnType<typeof proxy>>,
  value: unknown = body,
  overrides: { route?: string; method?: string; headers?: Record<string, string> } = {},
) {
  const data = JSON.stringify(value);
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
});
describe('bounded local evaluation proxy', () => {
  it('forwards only a valid authenticated native request', async () => {
    const evaluate = vi.fn(async () => answer);
    const p = await proxy(evaluate);
    expect((await send(p)).status).toBe(200);
    expect(evaluate.mock.calls).toHaveLength(1);
    expect(p.summary()).toMatchObject({ requests: 1, active: 0 });
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
  it.each(['budget', 'provider', 'payment_uncertain'])(
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
  it('admits at most two concurrent evaluations', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const evaluate = vi.fn(async () => {
      await gate;
      return answer;
    });
    const p = await proxy(evaluate);
    const first = send(p);
    const second = send(p);
    await vi.waitFor(() => expect(evaluate).toHaveBeenCalledTimes(2));
    expect((await send(p)).status).toBe(429);
    release();
    await Promise.all([first, second]);
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
});
