import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileClientChannelStorage } from '@x402/evm/batch-settlement/client/file-storage';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PartialConfig } from '../lib/config';
import type { SpendPolicy } from '../lib/policy';
import type { CommandContext } from '../context';
import { requestDecision } from './decision';
import {
  appendFee,
  CHANNEL_DEPOSIT_ATOMIC,
  feesInWindow,
  pausedReason,
  payerDir,
  readFeeState,
  ROUTING_FEE_ATOMIC,
  takeSlot,
} from './fee-state';
import { BASE, FakeRouter, testSigner } from './fee-test-utils';
import {
  chainReader,
  DEPOSIT_MULTIPLIER,
  RoutingPayer,
  RPC_TIMEOUT_MS,
  ROUTING_SPEND_CAP,
  slotSalt,
  type RoutingPayerDeps,
} from './routing-payer';

/**
 * The payer against a fake router that speaks the real x402 headers: the stock
 * SDK client builds every deposit and voucher, keeps the channel in its own
 * file storage and recovers from the fake's corrective 402.
 */

const APPROVED: PartialConfig = { routingFee: 'approved' };
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
  return new RoutingPayer({
    dataDir: dir,
    getSigner: async () => testSigner(wallet),
    policy: async () => ({
      maxAutoSpendAtomic: 250_000n,
      sessionBudgetAtomic: 5_000_000n,
      allowlistCreators: [],
      ...policy_,
    }),
    walletBalance: async () => (walletAtomic === undefined ? 10_000_000n : walletAtomic),
    readContract: router.readContract as never,
    fetchImpl: router.fetch,
    now: () => clock,
    pid: 1,
    isAlive: () => true,
    warn: () => undefined,
    ...rest,
  });
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
async function routeOnce(p: RoutingPayer, router: FakeRouter, config = APPROVED) {
  const route = await p.routeFor(config, BASE);
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

async function leases(): Promise<string[]> {
  const names = await readdir(payerDir(dir, wallet.address)).catch(() => [] as string[]);
  return names.filter((n) => n.endsWith('.lease')).sort();
}

async function channelFiles(): Promise<string[]> {
  return (await readdir(join(payerDir(dir, wallet.address), 'client')).catch(() => [])).sort();
}

describe('RoutingPayer', () => {
  it('sends nothing at all before the routing fee is approved: no probe, no payment', async () => {
    const router = new FakeRouter();
    const p = payer(router);
    expect(await p.routeFor({}, BASE)).toBeNull();
    expect(await p.routeFor({ routingFee: 'declined' }, BASE)).toBeNull();
    expect(router.log).toEqual([]);
    expect(await readFeeState(dir)).toBeNull();
  });

  it('takes the free path while the server answers no paid path, and records it', async () => {
    const router = new FakeRouter({ paid: false });
    const p = payer(router);
    expect(await p.routeFor(APPROVED, BASE)).toBeNull();
    expect((await readFeeState(dir))?.paidPath).toBe('absent');
    // Kept for an hour: the next call does not ask again.
    expect(await p.routeFor(APPROVED, BASE)).toBeNull();
    expect(router.log).toEqual(['POST /api/x402-router/route unpaid']);
  });

  it('pays nothing to a 402 asking more than the approved fee', async () => {
    const router = new FakeRouter({ amount: '30000' });
    expect(await payer(router).routeFor(APPROVED, BASE)).toBeNull();
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
    // One probe, then one round trip per call.
    expect(router.log).toEqual([
      'POST /api/x402-router/route unpaid',
      'POST /api/x402-router/route paid',
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
    expect(await feesInWindow(dir, clock)).toBe(2n * ROUTING_FEE_ATOMIC);
    expect(await readFeeState(dir)).toMatchObject({
      paidPath: 'available',
      payer: wallet.address.toLowerCase(),
      blocked: null,
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
    // The fee the lost answer hid is counted when the recovery finds it.
    expect(await feesInWindow(dir, clock)).toBe(3n * ROUTING_FEE_ATOMIC);
  });

  it('gives the slot back when no call is in flight: processes take turns on slot 0 and its one deposit', async () => {
    const router = new FakeRouter();
    const a = payer(router, { pid: 1 });
    const b = payer(router, { pid: 2 });
    for (const p of [a, b, a, b]) {
      expect((await routeOnce(p, router)).status).toBe('decided');
      // Between calls nothing holds a slot, though both processes stay up.
      expect(await leases()).toEqual([]);
    }
    expect(router.channels.size).toBe(1);
    expect(router.deposits).toBe(1);
    expect(router.settledFees).toBe(4);
    expect(await feesInWindow(dir, clock)).toBe(4n * ROUTING_FEE_ATOMIC);
  });

  it('holds one slot per call in flight: 8 calls at once use the 8 slots, and the ninth takes the free path', async () => {
    const router = new FakeRouter();
    router.delayMs = 200;
    const payers = Array.from({ length: 9 }, (_, i) => payer(router, { pid: i + 1 }));
    const outcomes = await Promise.all(payers.map((p) => routeOnce(p, router)));
    expect(outcomes.every((o) => o.status === 'decided')).toBe(true);
    const free = outcomes.filter((o) => o.status === 'decided' && o.freePath === 'no_slot');
    expect(free).toHaveLength(1);
    expect(router.log.filter((l) => l === 'POST /api/x402-router unpaid')).toHaveLength(1);
    expect(router.channels.size).toBe(8);
    expect(router.deposits).toBe(8);
    expect(router.settledFees).toBe(8);
    // All given back once the calls ended; the next call is on slot 0 again.
    expect(await leases()).toEqual([]);
    await routeOnce(payers[8]!, router);
    expect(router.deposits).toBe(8);
    expect(router.settledFees).toBe(9);
  });

  it("never shares a live process's slot, and reclaims the slot of a process that died mid-call", async () => {
    const router = new FakeRouter();
    const alive = new Set([1, 2]);
    const isAlive = (pid: number) => alive.has(pid);
    await routeOnce(payer(router, { pid: 1, isAlive }), router);
    // Process 1 is mid-call again: its lease on slot 0 stands.
    const slotDir = payerDir(dir, wallet.address);
    expect(await takeSlot(slotDir, 0, 1, isAlive)).not.toBeNull();
    const b = payer(router, { pid: 2, isAlive });
    await routeOnce(b, router);
    expect(router.channels.size).toBe(2);
    expect(router.deposits).toBe(2);
    // Then it dies without giving the slot back. The next call takes slot 0
    // over, on the channel as it stands: no new deposit.
    alive.delete(1);
    await routeOnce(b, router);
    expect(router.channels.size).toBe(2);
    expect(router.deposits).toBe(2);
    expect(router.settledFees).toBe(3);
    expect(await leases()).toEqual([]);
  });

  it('frees its slot on close, so the next process continues the same channel', async () => {
    const router = new FakeRouter();
    const a = payer(router, { pid: 1 });
    await routeOnce(a, router);
    await a.close();
    const b = payer(router, { pid: 2 });
    await routeOnce(b, router);
    expect(router.channels.size).toBe(1);
    expect(router.deposits).toBe(1);
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
    const route = (await p.routeFor(APPROVED, BASE))!;
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
      const route = (await p.routeFor(APPROVED, BASE))!;
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

  it('skips a call that would pass the routing allowance, sending nothing', async () => {
    const router = new FakeRouter();
    const p = payer(router);
    await routeOnce(p, router);
    const slotDir = payerDir(dir, wallet.address);
    await appendFee(slotDir, 0, { atMs: clock, feeAtomic: 497_000n }, clock);
    const paidBefore = router.paidRequests();
    const outcome = await routeOnce(p, router);
    expect(outcome).toEqual({ status: 'skipped', why: 'allowance' });
    expect(router.paidRequests()).toBe(paidBefore);
    // A day on, the window is empty again.
    clock += 86_400_000;
    expect((await routeOnce(p, router)).status).toBe('decided');
  });

  it('pauses with a notice when the wallet cannot be unlocked', async () => {
    const router = new FakeRouter();
    const p = payer(router, {
      getSigner: async () => {
        throw new Error('passphrase needed');
      },
    });
    expect(await routeOnce(p, router)).toEqual({ status: 'skipped', why: 'wallet_locked' });
    expect(router.paidRequests()).toBe(0);
    expect(await pausedReason(dir, true)).toEqual({ reason: 'wallet_locked' });
  });

  it('signs no deposit from a wallet that cannot cover it, and says how much to fund', async () => {
    const router = new FakeRouter();
    const p = payer(router, { walletAtomic: 100_000n });
    expect(await routeOnce(p, router)).toEqual({ status: 'skipped', why: 'wallet_low' });
    expect(router.paidRequests()).toBe(0);
    expect(await pausedReason(dir, true)).toEqual({
      reason: 'cannot_fund',
      walletAtomic: 100_000n,
    });
  });

  it('applies the creator allowlist to a deposit', async () => {
    const router = new FakeRouter();
    const p = payer(router, { policy_: { allowlistCreators: ['someone.else'] } });
    expect(await routeOnce(p, router)).toEqual({ status: 'skipped', why: 'not_allowlisted' });
    expect(router.paidRequests()).toBe(0);
    expect((await readFeeState(dir))?.blocked).toBe('not_allowlisted');
  });

  it("sizes the deposit with the SDK's own knobs: the spend cap times depositMultiplier", () => {
    expect(ROUTING_SPEND_CAP).toBe('$0.05');
    expect(50_000n * BigInt(DEPOSIT_MULTIPLIER)).toBe(CHANNEL_DEPOSIT_ATOMIC);
  });

  it('keys each slot by a deterministic salt, the same for every wallet', () => {
    expect(slotSalt(0)).toBe(slotSalt(0));
    expect(slotSalt(0)).not.toBe(slotSalt(1));
    expect(slotSalt(0)).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
