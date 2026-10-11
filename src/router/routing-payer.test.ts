import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileClientChannelStorage } from '@x402/evm/batch-settlement/client/file-storage';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliError } from '../lib/errors';
import type { SpendPolicy } from '../lib/policy';
import { readSpendSummary } from '../lib/wallet/spend';
import type { CommandContext } from '../context';
import { requestDecision } from './decision';
import { CHANNEL_DEPOSIT_ATOMIC, MIN_DEPOSIT_ATOMIC, payerDir, ROUTING_FEE_ATOMIC } from './fee';
import { BASE, FakeRouter, payerDeps, TEST_POLICY } from './fee-test-utils';
import { DEPOSIT_GATE_TIMEOUT_MS, GATE_TIMEOUT_MS } from './gate';
import {
  chainReader,
  DEPOSIT_MULTIPLIER,
  RoutingPayer,
  RPC_TIMEOUT_MS,
  ROUTING_SPEND_CAP,
  type RoutingPayerDeps,
} from './routing-payer';

/**
 * The payer against a fake router that speaks the real x402 headers: the stock
 * SDK client builds every deposit and voucher, keeps the channel in its own
 * file storage and recovers from the fake's corrective 402.
 */

const wallet = privateKeyToAccount(generatePrivateKey());

let dir: string;
let clock: number;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-payer-'));
  clock = 1_800_000_000_000;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

type PayerOpts = Partial<RoutingPayerDeps> & {
  policy_?: Partial<SpendPolicy>;
  walletAtomic?: bigint | null;
};

function payer(router: FakeRouter, opts: PayerOpts = {}): RoutingPayer {
  const { policy_, walletAtomic, ...rest } = opts;
  return new RoutingPayer(
    payerDeps(router, dir, wallet, {
      policy: async () => ({ ...TEST_POLICY, ...policy_ }),
      walletBalance: async () => (walletAtomic === undefined ? 10_000_000n : walletAtomic),
      now: () => clock,
      ...rest,
    }),
  );
}

const ctx = (): CommandContext => ({
  flags: { json: true, timeout: 5_000 },
  dataDir: dir,
  io: {
    stdout: { write: () => true } as unknown as NodeJS.WritableStream,
    stderr: { write: () => true } as unknown as NodeJS.WritableStream,
    isTTY: false,
  },
});

/** One routing call the way the hook and the tool make it. */
async function routeOnce(p: RoutingPayer, router: FakeRouter) {
  const route = await p.routeFor(BASE);
  return requestDecision(
    'tool',
    { query: 'q' },
    {
      ctx: ctx(),
      baseUrl: BASE,
      fetchImpl: router.fetch,
      timeoutMs: 3_500,
      ...(route !== null ? { route } : {}),
    },
  );
}

/** Why the paid path did not answer a call: the free path's reason, or the skip's. */
function unpaidWhy(outcome: Awaited<ReturnType<typeof routeOnce>>): string | undefined {
  return outcome.status === 'skipped' ? outcome.why : outcome.freePath;
}

/** A call the paid path could not take, answered on the free path, unpaid. */
function tookFreePath(outcome: Awaited<ReturnType<typeof routeOnce>>, router: FakeRouter) {
  expect(outcome.status).toBe('decided');
  expect(router.log.at(-1)).toBe('POST /api/x402-router unpaid');
  return unpaidWhy(outcome);
}

async function channelFiles(): Promise<string[]> {
  return (await readdir(join(payerDir(dir, wallet.address), 'client')).catch(() => [])).sort();
}

describe('RoutingPayer', () => {
  it('takes the free path while the server answers no paid path, and asks again in an hour', async () => {
    const router = new FakeRouter({ paid: false });
    const p = payer(router);
    expect(await routeOnce(p, router)).toMatchObject({
      status: 'decided',
      freePath: 'paid_path_absent',
    });
    // Kept for an hour: the next call does not ask again.
    expect(await p.routeFor(BASE)).toBeNull();
    expect(router.log).toEqual([
      'POST /api/x402-router/route unpaid',
      'POST /api/x402-router unpaid',
    ]);
  });

  it('pays no voucher from a funded channel once the per-call limit is below the fee', async () => {
    const router = new FakeRouter();
    let maxAutoSpendAtomic = 250_000n;
    const p = payer(router, {
      policy: async () => ({ ...TEST_POLICY, maxAutoSpendAtomic }),
    });
    expect((await routeOnce(p, router)).status).toBe('decided');
    expect(router.settledFees).toBe(1);
    // The user turns automatic payment off: the channel still holds the deposit.
    maxAutoSpendAtomic = 0n;
    let unlocks = 0;
    const after = await routeOnce(
      payer(router, {
        policy: async () => ({ ...TEST_POLICY, maxAutoSpendAtomic }),
        getSigner: async () => {
          unlocks += 1;
          throw new Error('not reached');
        },
      }),
      router,
    );
    expect(tookFreePath(after, router)).toBe('limit_below_deposit');
    expect(router.settledFees).toBe(1);
    expect(unlocks).toBe(0);
    // The same payer, too.
    expect(tookFreePath(await routeOnce(p, router), router)).toBe('limit_below_deposit');
    expect(router.settledFees).toBe(1);
  });

  it.each<[string, Partial<SpendPolicy>, string]>([
    ['a daily limit of 0', { sessionBudgetAtomic: 0n }, 'budget_reached'],
    ['an allowlist without the router', { allowlistCreators: ['someone-else'] }, 'not_allowlisted'],
    ['a per-call limit below the fee', { maxAutoSpendAtomic: 2_000n }, 'limit_below_deposit'],
  ])('pays no voucher from a funded channel under %s', async (_label, change, why) => {
    const router = new FakeRouter();
    let policy: SpendPolicy = TEST_POLICY;
    const p = payer(router, { policy: async () => policy });
    expect((await routeOnce(p, router)).status).toBe('decided');
    expect(router.settledFees).toBe(1);
    // The channel still holds the deposit; the user changes the policy.
    policy = { ...TEST_POLICY, ...change };
    expect(tookFreePath(await routeOnce(p, router), router)).toBe(why);
    expect(router.settledFees).toBe(1);
    expect(router.paidRequests()).toBe(1);
  });

  it('pays the next fee from a deposit that used the whole day, counting it once', async () => {
    const router = new FakeRouter();
    const p = payer(router, { policy_: { sessionBudgetAtomic: CHANNEL_DEPOSIT_ATOMIC } });
    expect((await routeOnce(p, router)).status).toBe('decided');
    expect((await readSpendSummary(dir))?.committedAtomic).toBe(CHANNEL_DEPOSIT_ATOMIC.toString());
    // The day's budget is spent, by the deposit itself: its fees still pay.
    const next = await routeOnce(p, router);
    expect(next).toMatchObject({ status: 'decided' });
    expect(unpaidWhy(next)).toBeUndefined();
    expect(router.settledFees).toBe(2);
    expect(router.deposits).toBe(1);
    expect((await readSpendSummary(dir))?.committedAtomic).toBe(CHANNEL_DEPOSIT_ATOMIC.toString());
  });

  it('refuses a second deposit the day has no room for, and the call goes free', async () => {
    const router = new FakeRouter();
    // A $0.03 deposit holds ten fees; the day has room for one deposit, not two.
    const p = payer(router, {
      policy_: { maxAutoSpendAtomic: MIN_DEPOSIT_ATOMIC, sessionBudgetAtomic: 50_000n },
    });
    for (let n = 0; n < 10; n += 1) {
      const paid = await routeOnce(p, router);
      expect(paid.status).toBe('decided');
      expect(unpaidWhy(paid)).toBeUndefined();
    }
    expect(router.deposits).toBe(1);
    const paidBefore = router.paidRequests();
    expect(tookFreePath(await routeOnce(p, router), router)).toBe('budget_reached');
    expect(router.paidRequests()).toBe(paidBefore);
    expect(router.deposits).toBe(1);
    // The deposit counted once; the ten fees paid from it did not count again.
    expect((await readSpendSummary(dir, { now: () => clock }))?.committedAtomic).toBe(
      MIN_DEPOSIT_ATOMIC.toString(),
    );
  });

  it('makes no deposit for a fee a daily limit of 0 refuses', async () => {
    const router = new FakeRouter();
    const p = payer(router, { policy_: { sessionBudgetAtomic: 0n } });
    expect(tookFreePath(await routeOnce(p, router), router)).toBe('budget_reached');
    expect(router.paidRequests()).toBe(0);
    expect(router.deposits).toBe(0);
  });

  it('pays nothing to a 402 asking more than the approved fee', async () => {
    const router = new FakeRouter({ amount: '30000' });
    expect(tookFreePath(await routeOnce(payer(router), router), router)).toBe('payment_failed');
    expect(router.paidRequests()).toBe(0);
  });

  it('deposits inline on the first paid call, then pays vouchers from the channel', async () => {
    const router = new FakeRouter();
    const p = payer(router);
    const first = await routeOnce(p, router);
    expect(first.status).toBe('decided');
    expect(router.deposits).toBe(1);
    expect(router.settledFees).toBe(1);
    const second = await routeOnce(p, router);
    expect(second.status).toBe('decided');
    expect(router.deposits).toBe(1);
    expect(router.settledFees).toBe(2);
    // The stock wrapper: the 402, then the paid request, on every call.
    expect(router.log).toEqual([
      'POST /api/x402-router/route unpaid',
      'POST /api/x402-router/route paid',
      'POST /api/x402-router/route unpaid',
      'POST /api/x402-router/route paid',
    ]);
    // The channel lives in the SDK's own file storage, in the wallet's folder.
    const files = await channelFiles();
    expect(files).toHaveLength(1);
    const stored = await new FileClientChannelStorage({
      directory: payerDir(dir, wallet.address),
    }).get(files[0]!.replace('.json', ''));
    expect(stored).toMatchObject({
      balance: CHANNEL_DEPOSIT_ATOMIC.toString(),
      chargedCumulativeAmount: (2n * ROUTING_FEE_ATOMIC).toString(),
    });
    // The deposit is an automatic payment in the spend ledger; the fees are not.
    expect(await readSpendSummary(dir, { now: () => clock })).toMatchObject({
      committedAtomic: CHANNEL_DEPOSIT_ATOMIC.toString(),
      reservations: [],
    });
  });

  it('sizes the deposit down to a per-call limit under $0.25', async () => {
    const router = new FakeRouter();
    const p = payer(router, { policy_: { maxAutoSpendAtomic: 100_000n } });
    expect((await routeOnce(p, router)).status).toBe('decided');
    expect([...router.channels.values()][0]!.balance).toBe(100_000n);
    expect((await readSpendSummary(dir, { now: () => clock }))?.committedAtomic).toBe('100000');
  });

  it('refuses a deposit a per-call limit cannot hold ten fees of, sending nothing paid', async () => {
    const router = new FakeRouter();
    const p = payer(router, { policy_: { maxAutoSpendAtomic: MIN_DEPOSIT_ATOMIC - 1n } });
    expect(tookFreePath(await routeOnce(p, router), router)).toBe('limit_below_deposit');
    expect(router.paidRequests()).toBe(0);
    expect(await readSpendSummary(dir, { now: () => clock })).toBeNull();
  });

  it('refuses a deposit the daily budget cannot take, and reserves nothing', async () => {
    const router = new FakeRouter();
    const p = payer(router, { policy_: { sessionBudgetAtomic: 200_000n } });
    expect(tookFreePath(await routeOnce(p, router), router)).toBe('budget_reached');
    expect(router.paidRequests()).toBe(0);
    expect((await readSpendSummary(dir, { now: () => clock }))?.reservations ?? []).toEqual([]);
  });

  /** `router`, except that a request carrying a payment gets `answer` instead. */
  function paidAnswer(router: FakeRouter, answer: () => Promise<Response>): typeof fetch {
    return async (input, init) => {
      const request = new Request(input, init);
      return request.headers.has('payment-signature') ? answer() : router.fetch(request);
    };
  }

  // The server settles nothing on an answered 4xx or 5xx (tenjin#951), so
  // those give the deposit back; an answer that never came may hide a settled
  // deposit, so it stays counted.
  it.each([
    ['an answered 402 releases it', async () => new Response('{}', { status: 402 }), '0'],
    ['an answered 500 releases it', async () => new Response('{}', { status: 500 }), '0'],
    [
      'a lost answer keeps it counted',
      async (): Promise<Response> => {
        throw new TypeError('fetch failed');
      },
      CHANNEL_DEPOSIT_ATOMIC.toString(),
    ],
  ])('settles a sent deposit in the ledger: %s', async (_label, answer, committed) => {
    const router = new FakeRouter();
    const fetchImpl = paidAnswer(router, answer);
    const p = payer(router, { fetchImpl });
    const route = (await p.routeFor(BASE))!;
    const outcome = await requestDecision(
      'tool',
      { query: 'q' },
      { ctx: ctx(), baseUrl: BASE, fetchImpl, timeoutMs: 3_500, route },
    );
    expect(tookFreePath(outcome, router)).toBe('payment_failed');
    expect(await readSpendSummary(dir, { now: () => clock })).toMatchObject({
      committedAtomic: committed,
      reservations: [],
    });
  });

  it('counts a deposit from the moment it is sent, before any answer', async () => {
    const router = new FakeRouter();
    let seen: string | undefined;
    const fetchImpl = paidAnswer(router, async () => {
      seen = (await readSpendSummary(dir, { now: () => clock }))?.committedAtomic;
      throw new TypeError('fetch failed');
    });
    const p = payer(router, { fetchImpl });
    const route = (await p.routeFor(BASE))!;
    await requestDecision(
      'tool',
      { query: 'q' },
      { ctx: ctx(), baseUrl: BASE, fetchImpl, timeoutMs: 3_500, route },
    );
    // A process killed at this point leaves the deposit counted.
    expect(seen).toBe(CHANNEL_DEPOSIT_ATOMIC.toString());
  });

  it('recovers through the SDK after a lost answer: a corrective 402, one retry, no second charge', async () => {
    const router = new FakeRouter();
    const p = payer(router);
    await routeOnce(p, router);
    router.abortAfterSettle = true;
    const lost = await routeOnce(p, router);
    expect(tookFreePath(lost, router)).toBe('payment_failed');
    expect(router.settledFees).toBe(2);
    const paidBefore = router.paidRequests();
    const next = await routeOnce(p, router);
    expect(next.status).toBe('decided');
    expect(router.paidRequests() - paidBefore).toBe(2);
    // The stale voucher was refused, the SDK resynced from the wallet's own
    // last voucher, and the retry was charged once.
    expect(router.settledFees).toBe(3);
    expect(router.deposits).toBe(1);
    expect([...router.channels.values()][0]!.charged).toBe(3n * ROUTING_FEE_ATOMIC);
  });

  it('retries a reset socket on the free path, on a fresh connection, unpaid', async () => {
    const router = new FakeRouter();
    const p = payer(router);
    const route = await p.routeFor(BASE);
    let resets = 0;
    const resetOnce: typeof fetch = async (input, init) => {
      if (resets === 0) {
        resets += 1;
        throw Object.assign(new TypeError('fetch failed'), {
          cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
        });
      }
      return router.fetch(input, init);
    };
    const outcome = await requestDecision(
      'tool',
      { query: 'q' },
      { ctx: ctx(), baseUrl: BASE, fetchImpl: resetOnce, timeoutMs: 3_500, route: route! },
    );
    expect(tookFreePath(outcome, router)).toBe('payment_failed');
    expect(router.settledFees).toBe(0);
  });

  it('shares one channel and its one deposit between processes that take turns', async () => {
    const router = new FakeRouter();
    const a = payer(router);
    const b = payer(router);
    for (const p of [a, b, a, b]) {
      expect((await routeOnce(p, router)).status).toBe('decided');
    }
    expect(router.channels.size).toBe(1);
    expect(router.deposits).toBe(1);
    expect(router.settledFees).toBe(4);
    // Nothing but the SDK's channel storage in the wallet's folder.
    expect(await readdir(payerDir(dir, wallet.address))).toEqual(['client']);
  });

  it("takes the free path, unpaid, when another process's call is in flight on the channel", async () => {
    const router = new FakeRouter();
    await routeOnce(payer(router), router);
    router.delayMs = 200;
    const outcomes = await Promise.all([
      routeOnce(payer(router), router),
      routeOnce(payer(router), router),
    ]);
    expect(outcomes.map((o) => o.status)).toEqual(['decided', 'decided']);
    expect(outcomes.map((o) => (o.status === 'decided' ? o.freePath : null)).sort()).toEqual([
      'channel_busy',
      undefined,
    ]);
    expect(router.log.filter((l) => l === 'POST /api/x402-router unpaid')).toHaveLength(1);
    expect(router.channels.size).toBe(1);
    expect(router.deposits).toBe(1);
    // The refused voucher was charged nothing; the next call continues the total.
    expect(router.settledFees).toBe(2);
    router.delayMs = 0;
    expect((await routeOnce(payer(router), router)).status).toBe('decided');
    expect(router.settledFees).toBe(3);
    expect([...router.channels.values()][0]!.charged).toBe(3n * ROUTING_FEE_ATOMIC);
  });

  it('takes turns inside one process: parallel calls share one channel and never collide', async () => {
    const router = new FakeRouter();
    router.delayMs = 20;
    const p = payer(router);
    const outcomes = await Promise.all([
      routeOnce(p, router),
      routeOnce(p, router),
      routeOnce(p, router),
    ]);
    expect(outcomes.map((o) => o.status)).toEqual(['decided', 'decided', 'decided']);
    expect(router.channels.size).toBe(1);
    expect(router.settledFees).toBe(3);
  });

  it("counts a queued call's budget from when it was sent, not from when its turn came", async () => {
    const router = new FakeRouter();
    const p = payer(router, { now: () => Date.now() });
    await routeOnce(p, router);
    router.delayMs = 300;
    const route = (await p.routeFor(BASE))!;
    const call = (timeoutMs: number) =>
      requestDecision(
        'tool',
        { query: 'q' },
        { ctx: ctx(), baseUrl: BASE, fetchImpl: router.fetch, timeoutMs, route },
      );
    // The second waits behind the first for longer than its own budget.
    const [first, second] = await Promise.all([call(3_500), call(100)]);
    expect(first.status).toBe('decided');
    expect(second).toEqual({ status: 'skipped', why: 'busy' });
  });

  /** An RPC that never answers, the way viem's own fetch sees one. */
  const hangingRpc = (() => {
    let calls = 0;
    const fetchFn = ((_url: unknown, init?: RequestInit) => {
      calls += 1;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    }) as typeof fetch;
    return { fetchFn, calls: () => calls };
  })();

  it.each([
    ['its own 2 s', 3_500, RPC_TIMEOUT_MS],
    ["the call's smaller budget", 800, 800],
  ])(
    "skips the call within %s when the SDK's chain read hangs, sending nothing",
    async (_label, budgetMs, boundMs) => {
      const router = new FakeRouter();
      const before = hangingRpc.calls();
      const p = payer(router, {
        now: () => Date.now(),
        readContract: chainReader('http://rpc.test', hangingRpc.fetchFn),
      });
      const route = (await p.routeFor(BASE))!;
      const started = Date.now();
      const outcome = await requestDecision(
        'tool',
        { query: 'q' },
        { ctx: ctx(), baseUrl: BASE, fetchImpl: router.fetch, timeoutMs: budgetMs, route },
      );
      const took = Date.now() - started;
      expect(unpaidWhy(outcome)).toBe('chain_unreadable');
      // One request, no retry, cut at the bound.
      expect(hangingRpc.calls() - before).toBe(1);
      expect(took).toBeGreaterThanOrEqual(boundMs - 50);
      expect(took).toBeLessThan(boundMs + 400);
      expect(router.paidRequests()).toBe(0);
    },
    10_000,
  );

  const noWallet = async (): Promise<never> => {
    throw new CliError('WALLET_MISSING', 'no wallet');
  };
  const locked = async (): Promise<never> => {
    throw new Error('passphrase needed');
  };

  it.each([
    ['no wallet', noWallet],
    ['a locked wallet', locked],
  ])(
    'asks the server before the wallet: with the fee off, %s is never touched',
    async (_l, fail) => {
      const router = new FakeRouter({ paid: false });
      let unlocks = 0;
      const p = payer(router, { getSigner: () => ((unlocks += 1), fail()) });
      expect(unpaidWhy(await routeOnce(p, router))).toBe('paid_path_absent');
      expect(unlocks).toBe(0);
    },
  );

  it('takes the free path with no wallet once the server charges the fee', async () => {
    const router = new FakeRouter();
    const p = payer(router, { getSigner: noWallet });
    expect(tookFreePath(await routeOnce(p, router), router)).toBe('no_wallet');
    expect(router.log).toEqual([
      'POST /api/x402-router/route unpaid',
      'POST /api/x402-router unpaid',
    ]);
  });

  it('pays nothing when the wallet cannot be unlocked', async () => {
    const router = new FakeRouter();
    const p = payer(router, {
      getSigner: async () => {
        throw new Error('passphrase needed');
      },
    });
    expect(tookFreePath(await routeOnce(p, router), router)).toBe('wallet_locked');
    expect(router.paidRequests()).toBe(0);
  });

  it('signs no deposit from a wallet that cannot cover it', async () => {
    const router = new FakeRouter();
    const p = payer(router, { walletAtomic: 100_000n });
    expect(tookFreePath(await routeOnce(p, router), router)).toBe('wallet_low');
    expect(router.paidRequests()).toBe(0);
  });

  it('applies the creator allowlist to a deposit', async () => {
    const router = new FakeRouter();
    const p = payer(router, { policy_: { allowlistCreators: ['someone.else'] } });
    expect(tookFreePath(await routeOnce(p, router), router)).toBe('not_allowlisted');
    expect(router.paidRequests()).toBe(0);
  });

  it("sizes the deposit with the SDK's own knobs: the spend cap times depositMultiplier", () => {
    expect(ROUTING_SPEND_CAP).toBe('$0.05');
    expect(50_000n * BigInt(DEPOSIT_MULTIPLIER)).toBe(CHANNEL_DEPOSIT_ATOMIC);
  });
});

describe('RoutingPayer and the call budget', () => {
  /** One call with its own budget, in real time, and the lines the payer warned. */
  function timed(router: FakeRouter) {
    const warned: string[] = [];
    const p = payer(router, { now: () => Date.now(), warn: (line) => warned.push(line) });
    const call = async (timeoutMs: number) => {
      const route = (await p.routeFor(BASE))!;
      return requestDecision(
        'tool',
        { query: 'q' },
        { ctx: ctx(), baseUrl: BASE, fetchImpl: router.fetch, timeoutMs, route },
      );
    };
    return { p, call, warned };
  }

  async function storedChannel() {
    const files = await channelFiles();
    return new FileClientChannelStorage({ directory: payerDir(dir, wallet.address) }).get(
      files[0]!.replace('.json', ''),
    );
  }

  it('waits past the gate budget for a call that carries a deposit', async () => {
    const router = new FakeRouter();
    router.delayMs = 400;
    const { call } = timed(router);
    // 200 ms is the caller's budget; the deposit adds the hook leg's rest.
    expect((await call(200)).status).toBe('decided');
    expect(router.deposits).toBe(1);
  });

  it('returns a deposit still out at the longer budget as no fault, and records it when it lands', async () => {
    const router = new FakeRouter();
    router.delayMs = DEPOSIT_GATE_TIMEOUT_MS - GATE_TIMEOUT_MS + 600;
    const { call, warned } = timed(router);
    const started = Date.now();
    expect(await call(200)).toEqual({ status: 'skipped', why: 'deadline_after_payment_sent' });
    expect(Date.now() - started).toBeLessThan(DEPOSIT_GATE_TIMEOUT_MS - GATE_TIMEOUT_MS + 500);
    router.delayMs = 0;
    // Queued behind the late answer, then a voucher from the recorded channel.
    expect((await call(3_500)).status).toBe('decided');
    expect(router.deposits).toBe(1);
    expect(router.paidRequests()).toBe(2);
    expect(await storedChannel()).toMatchObject({
      balance: CHANNEL_DEPOSIT_ATOMIC.toString(),
      chargedCumulativeAmount: (2n * ROUTING_FEE_ATOMIC).toString(),
    });
    expect((await readSpendSummary(dir))?.reservations).toEqual([]);
    expect(warned.join('\n')).toMatch(
      /deadline_after_payment_sent \(cause late http 200, \d+ms, stage deposit\)/,
    );
  });

  it('keeps the gate budget for a voucher, and lets one still out finish', async () => {
    const router = new FakeRouter();
    const { call, warned } = timed(router);
    expect((await call(3_500)).status).toBe('decided');
    router.delayMs = 600;
    const started = Date.now();
    expect(await call(200)).toEqual({ status: 'skipped', why: 'deadline_after_payment_sent' });
    // Not lengthened: no deposit rode on it.
    expect(Date.now() - started).toBeLessThan(500);
    router.delayMs = 0;
    expect((await call(3_500)).status).toBe('decided');
    // The late voucher was recorded: the next one continued the total.
    expect(router.paidRequests()).toBe(3);
    expect(router.settledFees).toBe(3);
    expect(warned.join('\n')).toContain('stage voucher');
  });

  it('still aborts a call whose budget ends before anything is paid', async () => {
    const router = new FakeRouter();
    // A probe that answers only after the budget, and honors the abort.
    const slowProbe: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      await new Promise((resolve, reject) => {
        setTimeout(resolve, 400);
        request.signal.addEventListener('abort', () => reject(request.signal.reason));
      });
      return router.fetch(request);
    };
    const { p, warned } = timed(router);
    const route = (await p.routeFor(BASE))!;
    const outcome = await requestDecision(
      'tool',
      { query: 'q' },
      { ctx: ctx(), baseUrl: BASE, fetchImpl: slowProbe, timeoutMs: 200, route },
    );
    expect(outcome).toEqual({ status: 'skipped', why: 'payment_failed' });
    expect(router.paidRequests()).toBe(0);
    expect(warned.join('\n')).toContain('payment_failed (cause timeout');
  });

  it('gives up on a queued call at its own deadline instead of waiting out a detached payment', async () => {
    const router = new FakeRouter();
    const { call, warned } = timed(router);
    expect((await call(3_500)).status).toBe('decided');
    // The next voucher answers after 1.5 s, past its 200 ms budget: it detaches.
    router.delayMs = 1_500;
    const ahead = call(200);
    const started = Date.now();
    const queued = await call(300);
    expect(queued).toEqual({ status: 'skipped', why: 'busy' });
    expect(Date.now() - started).toBeLessThan(1_200);
    await ahead;
    // Every unanswered call says so once, a queued one included.
    expect(warned.join('\n')).toMatch(/busy \(cause queued, \d+ms, stage queue\)/);
  });

  it('reports a paid call whose body stalls past its time as sent, not failed', async () => {
    const router = new FakeRouter();
    // The paid answer settles, then its body never finishes.
    const stallPaid: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const response = await router.fetch(request);
      if (!request.headers.has('payment-signature') || response.status !== 200) return response;
      return new Response(new ReadableStream({ start: (c) => c.enqueue(new Uint8Array([123])) }), {
        status: 200,
        headers: response.headers,
      });
    };
    const { p } = timed(router);
    const route = (await p.routeFor(BASE))!;
    const outcome = await requestDecision(
      'tool',
      { query: 'q' },
      { ctx: ctx(), baseUrl: BASE, fetchImpl: stallPaid, timeoutMs: 200, route },
    );
    expect(router.settledFees).toBe(1);
    expect(outcome).toEqual({ status: 'skipped', why: 'deadline_after_payment_sent' });
  });

  it("bounds the body read by the call's deadline once the headers arrive", async () => {
    // A real router socket that sends its headers, then never finishes the body.
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const p = payer(new FakeRouter(), { now: () => Date.now(), fetchImpl: fetch });
      const route = (await p.routeFor(base))!;
      const started = Date.now();
      const outcome = await requestDecision(
        'tool',
        { query: 'q' },
        { ctx: ctx(), baseUrl: base, timeoutMs: 200, route },
      );
      expect(outcome.status).not.toBe('decided');
      expect(Date.now() - started).toBeLessThan(DEPOSIT_GATE_TIMEOUT_MS - GATE_TIMEOUT_MS + 1_000);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }, 4_000);
});
