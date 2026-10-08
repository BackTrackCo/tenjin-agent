import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runHookKind } from './hook-command';
import type { HookDeps } from './hooks';
import { FakeRouter, payerDeps } from './fee-test-utils';
import { RoutingPayer } from './routing-payer';
import { readRouterMemo, UNREACHABLE_BACKOFF_MS, writeRouterMemo } from './router-memo';
import { ROUTER_PATH } from './decision';
import { ROUTE_PAID_PATH } from './fee';

/**
 * THE ROUTING LEGS' BACKOFF. A call that could not reach the router (a
 * refused connection, no status) starts a minute in which every leg skips the
 * router and the native tool runs; a timeout, a reset socket or a body that
 * failed to read never starts it.
 */

const BASE = 'https://router.test';
const NATIVE = {
  schemaVersion: 1,
  routerVersion: 'v',
  decision: {
    action: 'native',
    diagnostics: { reasonCode: 'native', stage: 'gate', missing: [], nextAction: 'native' },
  },
};
const wallet = privateKeyToAccount(generatePrivateKey());

let dir: string;
let clock: number;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'router-hooks-backoff-'));
  await mkdir(join(dir, '.git'));
  await writeFile(
    join(dir, 'config.json'),
    JSON.stringify({ maxAutoSpend: '250000', sessionBudget: '5000000' }),
  );
  clock = 1_800_000_000_000;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A router whose next answer the test picks: a refused connection, or a status. */
function router() {
  const state = { down: true, status: 200, calls: 0 };
  const fetchImpl = (async () => {
    state.calls += 1;
    if (state.down) {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      });
    }
    return new Response(JSON.stringify(state.status === 200 ? NATIVE : {}), {
      status: state.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { state, fetchImpl };
}

function deps(
  fetchImpl: typeof fetch,
  route?: RoutingPayer,
  extra: Partial<HookDeps> = {},
): HookDeps {
  return {
    dataDir: dir,
    baseUrl: BASE,
    fetchImpl,
    now: () => clock,
    warn: () => undefined,
    ...(route !== undefined ? { route: route.routeFor.bind(route) } : {}),
    ...extra,
  };
}

/** `fetch failed` with the socket's own code in its cause, as undici throws it. */
function socketError(code: string): TypeError {
  return Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error(`socket ${code}`), { code }),
  });
}

/** A fetch that answers only when its signal aborts, as a slow router does. */
const hangs = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    new Request(input, init).signal.addEventListener('abort', () =>
      reject(new DOMException('The operation was aborted.', 'AbortError')),
    );
  })) as typeof fetch;

const prompt = () => ({
  hook_event_name: 'UserPromptSubmit',
  session_id: 'sess-1',
  cwd: dir,
  prompt: 'what is the current price of ETH in USD',
});

const memo = () => readRouterMemo(dir, 'unreachable', BASE, clock);

describe('the routing legs back off a router they cannot reach', () => {
  it('starts the window on a transport failure, skips the router inside it, and asks again after', async () => {
    const r = router();
    await runHookKind('prompt', prompt(), deps(r.fetchImpl));
    expect(r.state.calls).toBe(1);
    expect(await memo()).toMatchObject({ until: clock + UNREACHABLE_BACKOFF_MS });

    // Inside the window: no request at all, the native tool runs.
    r.state.down = false;
    clock += UNREACHABLE_BACKOFF_MS - 1_000;
    expect(await runHookKind('prompt', prompt(), deps(r.fetchImpl))).toBeNull();
    expect(r.state.calls).toBe(1);

    // After it: asked again, and the answer clears the memo.
    clock += 1_000;
    await runHookKind('prompt', prompt(), deps(r.fetchImpl));
    expect(r.state.calls).toBe(2);
    expect(await memo()).toBeNull();
  });

  it('does not start the window on an HTTP answer, even a 5xx', async () => {
    const r = router();
    r.state.down = false;
    r.state.status = 503;
    await runHookKind('prompt', prompt(), deps(r.fetchImpl));
    await runHookKind('prompt', prompt(), deps(r.fetchImpl));
    expect(r.state.calls).toBe(2);
    expect(await memo()).toBeNull();
  });

  it('clears the memo on a call the router answers', async () => {
    const r = router();
    r.state.down = false;
    await writeRouterMemo(dir, 'unreachable', BASE, { now: clock - 120_000, ttlMs: 60_000 });
    await runHookKind('prompt', prompt(), deps(r.fetchImpl));
    expect(r.state.calls).toBe(1);
    expect(await readdir(join(dir, 'router-memo'))).toEqual([]);
  });

  it('does not start it on the call running out of its own time', async () => {
    let calls = 0;
    const slow = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls += 1;
      return hangs(input, init);
    }) as typeof fetch;
    await runHookKind('prompt', prompt(), deps(slow, undefined, { timeoutMs: 30 }));
    expect(await memo()).toBeNull();
    await runHookKind('prompt', prompt(), deps(slow, undefined, { timeoutMs: 30 }));
    expect(calls).toBe(2);
  });

  it('keeps the backoff one call started when a concurrent call times out', async () => {
    let calls = 0;
    let secondStarted!: () => void;
    const bothInFlight = new Promise<void>((resolve) => (secondStarted = resolve));
    const outage = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls += 1;
      // The first call is refused once the second is in flight, so neither
      // reads a memo the other wrote; the second hangs past its budget.
      if (calls === 1) {
        await bothInFlight;
        throw socketError('ECONNREFUSED');
      }
      secondStarted();
      return hangs(input, init);
    }) as typeof fetch;
    await Promise.all([
      runHookKind('prompt', prompt(), deps(outage, undefined, { timeoutMs: 200 })),
      runHookKind('prompt', prompt(), deps(outage, undefined, { timeoutMs: 200 })),
    ]);
    expect(calls).toBe(2);
    expect(await memo()).toMatchObject({ until: clock + UNREACHABLE_BACKOFF_MS });
  });

  it('does not start it on an answer whose body failed to read', async () => {
    const torn = (async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(socketError('ECONNREFUSED'));
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;
    await runHookKind('prompt', prompt(), deps(torn));
    expect(await memo()).toBeNull();
  });

  it.each(['ECONNRESET', 'UND_ERR_SOCKET'])(
    'does not start it on a reset socket (%s)',
    async (code) => {
      const reset = (async () => {
        throw socketError(code);
      }) as typeof fetch;
      await runHookKind('prompt', prompt(), deps(reset));
      expect(await memo()).toBeNull();
    },
  );

  it('retries a reset socket on the free path, on a fresh connection, and starts nothing', async () => {
    const fake = new FakeRouter();
    const seen: string[] = [];
    const resetOnPaid = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const path = new URL(new Request(input, init).url).pathname;
      seen.push(path);
      if (path === ROUTE_PAID_PATH) throw socketError('ECONNRESET');
      return fake.fetch(input, init);
    }) as typeof fetch;
    const p = new RoutingPayer(payerDeps(fake, dir, wallet, { now: () => clock }));
    await runHookKind('prompt', prompt(), deps(resetOnPaid, p));
    expect(seen).toEqual([ROUTE_PAID_PATH, ROUTER_PATH]);
    expect(await memo()).toBeNull();
  });

  it('does not start it from the free path a paid attempt fell back to', async () => {
    const fake = new FakeRouter();
    const paidErrsFreeRefuses = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const path = new URL(new Request(input, init).url).pathname;
      if (path === ROUTE_PAID_PATH) return new Response('{}', { status: 503 });
      throw socketError('ECONNREFUSED');
    }) as typeof fetch;
    const p = new RoutingPayer(payerDeps(fake, dir, wallet, { now: () => clock }));
    await runHookKind('prompt', prompt(), deps(paidErrsFreeRefuses, p));
    expect(await memo()).toBeNull();
  });

  it('does not start it from a paid call queued behind another until its budget ran out', async () => {
    const fake = new FakeRouter();
    // Real clocks: the queued call's budget runs while the first one holds the channel.
    const p = new RoutingPayer(payerDeps(fake, dir, wallet));
    const real = { now: () => Date.now(), timeoutMs: 40 };
    await Promise.all([
      runHookKind('prompt', prompt(), deps(hangs, p, real)),
      runHookKind('prompt', { ...prompt(), session_id: 'sess-2' }, deps(hangs, p, real)),
    ]);
    expect(await readRouterMemo(dir, 'unreachable', BASE, Date.now())).toBeNull();
  });

  it('starts it from the paid path too, without trying the free path on the same host', async () => {
    const fake = new FakeRouter();
    const r = router();
    const p = new RoutingPayer(payerDeps(fake, dir, wallet, { now: () => clock }));
    await runHookKind('prompt', prompt(), deps(r.fetchImpl, p));
    expect(r.state.calls).toBe(1);
    expect(await memo()).not.toBeNull();
  });
});

describe('router-memo', () => {
  it('reads a memo dated in the future, or past its window, as absent', async () => {
    await writeRouterMemo(dir, 'unreachable', BASE, { now: clock + 5_000, ttlMs: 60_000 });
    expect(await memo()).toBeNull();
    await writeRouterMemo(dir, 'unreachable', BASE, { now: clock - 60_000, ttlMs: 60_000 });
    expect(await memo()).toBeNull();
  });

  it('keeps one memo per router origin', async () => {
    await writeRouterMemo(dir, 'unreachable', 'http://localhost:3000', {
      now: clock,
      ttlMs: 60_000,
    });
    expect(await memo()).toBeNull();
  });

  it('reads an unreadable file as absent', async () => {
    await writeRouterMemo(dir, 'unreachable', BASE, { now: clock, ttlMs: 60_000 });
    const [name] = await readdir(join(dir, 'router-memo'));
    await writeFile(join(dir, 'router-memo', name as string), 'not json');
    expect(await memo()).toBeNull();
  });
});
