import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileClientChannelStorage } from '@x402/evm/batch-settlement/client/file-storage';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SpendPolicy } from '../lib/policy';
import { readSpendSummary } from '../lib/wallet/spend';
import type { CommandContext } from '../context';
import { requestDecision } from './decision';
import { CHANNEL_DEPOSIT_ATOMIC, payerDir, ROUTING_FEE_ATOMIC } from './fee';
import { BASE, FakeRouter, payerDeps, TEST_POLICY } from './fee-test-utils';
import {
  chainReader,
  DEPOSIT_MULTIPLIER,
  MIN_DEPOSIT_ATOMIC,
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

  it('pays nothing to a 402 asking more than the approved fee', async () => {
    const router = new FakeRouter({ amount: '30000' });
    expect((await routeOnce(payer(router), router)).status).toBe('failed');
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
    expect(await routeOnce(p, router)).toEqual({ status: 'skipped', why: 'limit_below_deposit' });
    expect(router.paidRequests()).toBe(0);
    expect(await readSpendSummary(dir, { now: () => clock })).toBeNull();
  });

  it('refuses a deposit the daily budget cannot take, and reserves nothing', async () => {
    const router = new FakeRouter();
    const p = payer(router, { policy_: { sessionBudgetAtomic: 200_000n } });
    expect(await routeOnce(p, router)).toEqual({ status: 'skipped', why: 'budget_reached' });
    expect(router.paidRequests()).toBe(0);
    expect((await readSpendSummary(dir, { now: () => clock }))?.reservations ?? []).toEqual([]);
  });

  it('releases a deposit the server refused', async () => {
    const router = new FakeRouter();
    const refusing: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      if (request.headers.has('payment-signature')) return new Response('{}', { status: 500 });
      return router.fetch(request);
    };
    const p = payer(router, { fetchImpl: refusing });
    const route = (await p.routeFor(BASE))!;
    const outcome = await requestDecision(
      'tool',
      { query: 'q' },
      { ctx: ctx(), baseUrl: BASE, fetchImpl: refusing, timeoutMs: 3_500, route },
    );
    expect(outcome.status).toBe('failed');
    expect(await readSpendSummary(dir, { now: () => clock })).toMatchObject({
      committedAtomic: '0',
      reservations: [],
    });
  });

  it('recovers through the SDK after a lost answer: a corrective 402, one retry, no second charge', async () => {
    const router = new FakeRouter();
    const p = payer(router);
    await routeOnce(p, router);
    router.abortAfterSettle = true;
    const lost = await routeOnce(p, router);
    expect(lost.status).toBe('failed');
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
      expect(outcome).toEqual({ status: 'skipped', why: 'chain_unreadable' });
      // One request, no retry, cut at the bound.
      expect(hangingRpc.calls() - before).toBe(1);
      expect(took).toBeGreaterThanOrEqual(boundMs - 50);
      expect(took).toBeLessThan(boundMs + 400);
      expect(router.paidRequests()).toBe(0);
    },
    10_000,
  );

  it('pays nothing when the wallet cannot be unlocked', async () => {
    const router = new FakeRouter();
    const p = payer(router, {
      getSigner: async () => {
        throw new Error('passphrase needed');
      },
    });
    expect(await routeOnce(p, router)).toEqual({ status: 'skipped', why: 'wallet_locked' });
    expect(router.paidRequests()).toBe(0);
  });

  it('signs no deposit from a wallet that cannot cover it', async () => {
    const router = new FakeRouter();
    const p = payer(router, { walletAtomic: 100_000n });
    expect(await routeOnce(p, router)).toEqual({ status: 'skipped', why: 'wallet_low' });
    expect(router.paidRequests()).toBe(0);
  });

  it('applies the creator allowlist to a deposit', async () => {
    const router = new FakeRouter();
    const p = payer(router, { policy_: { allowlistCreators: ['someone.else'] } });
    expect(await routeOnce(p, router)).toEqual({ status: 'skipped', why: 'not_allowlisted' });
    expect(router.paidRequests()).toBe(0);
  });

  it("sizes the deposit with the SDK's own knobs: the spend cap times depositMultiplier", () => {
    expect(ROUTING_SPEND_CAP).toBe('$0.05');
    expect(50_000n * BigInt(DEPOSIT_MULTIPLIER)).toBe(CHANNEL_DEPOSIT_ATOMIC);
  });
});
