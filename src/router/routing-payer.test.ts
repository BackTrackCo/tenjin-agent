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
} from './fee-state';
import { BASE, FakeRouter, testSigner } from './fee-test-utils';
import { RoutingPayer, slotSalt, type RoutingPayerDeps } from './routing-payer';

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

  it('gives each process its own slot and channel, and the next process takes over a dead one', async () => {
    const router = new FakeRouter();
    const alive = new Set([1, 2]);
    const isAlive = (pid: number) => alive.has(pid);
    const a = payer(router, { pid: 1, isAlive });
    const b = payer(router, { pid: 2, isAlive });
    await Promise.all([routeOnce(a, router), routeOnce(b, router)]);
    expect(router.channels.size).toBe(2);
    expect(router.deposits).toBe(2);
    expect(await channelFiles()).toHaveLength(2);
    // Process 1 is gone; process 3 takes slot 0 and its channel as it stands.
    alive.delete(1);
    alive.add(3);
    const c = payer(router, { pid: 3, isAlive });
    expect((await routeOnce(c, router)).status).toBe('decided');
    expect(router.channels.size).toBe(2);
    expect(router.deposits).toBe(2);
    expect(await channelFiles()).toHaveLength(2);
    // A live holder keeps its slot: process 2's next call stays on its channel.
    expect((await routeOnce(b, router)).status).toBe('decided');
    expect(router.channels.size).toBe(2);
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

  it('keys each slot by a deterministic salt, the same for every wallet', () => {
    expect(slotSalt(0)).toBe(slotSalt(0));
    expect(slotSalt(0)).not.toBe(slotSalt(1));
    expect(slotSalt(0)).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
