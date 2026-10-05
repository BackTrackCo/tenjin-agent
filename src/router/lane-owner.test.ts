import { access, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from '@x402/core/http';
import type { PaymentRequirements } from '@x402/core/types';
import {
  BatchSettlementEvmScheme as ClientScheme,
  computeChannelId,
} from '@x402/evm/batch-settlement/client';
import { BatchSettlementEvmScheme as ServerScheme } from '@x402/evm/batch-settlement/server';
import type { TypedDataDefinition } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spendLedgerPath } from '../lib/paths';
import type { SpendPolicy } from '../lib/policy';
import type { TenjinSigner } from '../lib/wallet/provider';
import type { CommandContext } from '../context';
import { requestDecision } from './decision';
import { payForDecision, type RoutingFee } from './fee';
import { FUND_BACKOFF_MAX_MS, LaneOwner, type LaneOwnerDeps } from './lane-owner';
import {
  claimLane,
  feesInWindow,
  HOOK_CLAIM_TTL_MS,
  feeSummary,
  laneFiles,
  lanesDir,
  laneIndices,
  pausedReason,
  payerLanesDir,
  readFees,
  readLaneState,
  readPool,
  readWalletPool,
  ROUTING_ALLOWANCE_ATOMIC,
  ROUTING_FEE_ATOMIC,
  ROUTING_WINDOW_MS,
} from './lanes';

/**
 * The lane owner against a fake router that speaks the real x402 headers: the
 * SDK builds every deposit and voucher, and the SDK's recovery checks the
 * fake's corrective 402 against the wallet, which signs the vouchers, and a stubbed
 * chain read. No money moves and no network is touched.
 */

const NETWORK = 'eip155:84532';
const FEE = ROUTING_FEE_ATOMIC.toString();
const BASE = 'https://router.test';
const MISMATCH = 'invalid_batch_settlement_evm_cumulative_amount_mismatch';

interface Channel {
  balance: bigint;
  charged: bigint;
  last?: { maxClaimableAmount: string; signature: `0x${string}` };
}

class FakeRouter {
  readonly channels = new Map<string, Channel>();
  deposits = 0;
  settledFees = 0;
  /** Paid requests on the funding path, answered or not. */
  fundingAttempts = 0;
  /** Answer every paid request on the funding path with a 500, settling nothing. */
  failFunding = false;
  /** Settle the next answer, then drop the connection before it is read. */
  abortAfterSettle = false;
  readonly requirement: PaymentRequirements = {
    scheme: 'batch-settlement',
    network: NETWORK,
    asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    amount: FEE,
    payTo: privateKeyToAccount(generatePrivateKey()).address,
    maxTimeoutSeconds: 15,
    extra: {
      receiverAuthorizer: privateKeyToAccount(generatePrivateKey()).address,
      withdrawDelay: 86_400,
      name: 'USDC',
      version: '2',
    },
  };

  constructor(private readonly paths: { paid: boolean } = { paid: true }) {}

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (!this.paths.paid) return new Response('{}', { status: 404 });
    const headers = new Headers(init?.headers);
    const signature = headers.get('payment-signature');
    if (signature === null) return this.required(url.toString());
    if (url.pathname === '/api/x402-router/channel') {
      this.fundingAttempts += 1;
      if (this.failFunding) return new Response('{}', { status: 500 });
    }
    const payload = decodePaymentSignatureHeader(signature).payload as {
      type: 'deposit' | 'voucher';
      voucher: { channelId: string; maxClaimableAmount: string; signature: `0x${string}` };
      deposit?: { amount: string };
    };
    const id = payload.voucher.channelId.toLowerCase();
    const channel = this.channels.get(id) ?? { balance: 0n, charged: 0n };
    this.channels.set(id, channel);
    if (payload.type === 'deposit') {
      channel.balance += BigInt(payload.deposit!.amount);
      this.deposits += 1;
    }
    if (BigInt(payload.voucher.maxClaimableAmount) !== channel.charged + ROUTING_FEE_ATOMIC) {
      return this.corrective(url.toString(), id, channel);
    }
    channel.last = {
      maxClaimableAmount: payload.voucher.maxClaimableAmount,
      signature: payload.voucher.signature,
    };
    // The funding path settles at $0; the paid path charges the fee.
    if (url.pathname === '/api/x402-router/route') {
      channel.charged += ROUTING_FEE_ATOMIC;
      this.settledFees += 1;
    }
    if (this.abortAfterSettle) {
      this.abortAfterSettle = false;
      throw new DOMException('The operation was aborted.', 'AbortError');
    }
    return new Response(JSON.stringify(NATIVE), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'PAYMENT-RESPONSE': encodePaymentResponseHeader({
          success: true,
          transaction: '0x',
          network: NETWORK,
          extra: { channelState: this.state(id, channel) },
        }),
      },
    });
  };

  readonly readContract = async (args: { args?: readonly unknown[] }) => {
    const channel = this.channels.get(String(args.args?.[0]).toLowerCase());
    return [channel?.balance ?? 0n, 0n] as const;
  };

  private state(id: string, channel: Channel) {
    return {
      channelId: id,
      balance: channel.balance.toString(),
      chargedCumulativeAmount: channel.charged.toString(),
      totalClaimed: '0',
    };
  }

  private required(url: string): Response {
    return new Response('{}', {
      status: 402,
      headers: {
        'PAYMENT-REQUIRED': encodePaymentRequiredHeader({
          x402Version: 2,
          resource: { url, description: 'routing', mimeType: 'application/json' },
          accepts: [this.requirement],
        }),
      },
    });
  }

  private corrective(url: string, id: string, channel: Channel): Response {
    return new Response('{}', {
      status: 402,
      headers: {
        'PAYMENT-REQUIRED': encodePaymentRequiredHeader({
          x402Version: 2,
          error: MISMATCH,
          resource: { url, description: 'routing', mimeType: 'application/json' },
          accepts: [
            {
              ...this.requirement,
              extra: {
                ...this.requirement.extra,
                channelState: this.state(id, channel),
                ...(channel.last !== undefined
                  ? {
                      voucherState: {
                        signedMaxClaimable: channel.last.maxClaimableAmount,
                        signature: channel.last.signature,
                      },
                    }
                  : {}),
              },
            },
          ],
        }),
      },
    });
  }
}

const NATIVE = {
  schemaVersion: 1,
  routerVersion: 'test',
  decision: {
    action: 'native',
    diagnostics: { reasonCode: 'native', stage: 'gate', missing: [], nextAction: 'native' },
  },
};

let dir: string;
let clock: number;
const wallet = privateKeyToAccount(generatePrivateKey());
/** The folder of {@link wallet}'s lanes. */
const laneDir = () => payerLanesDir(dir, wallet.address);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-lanes-'));
  clock = 1_800_000_000_000;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function signer(account = wallet): TenjinSigner {
  return {
    address: account.address,
    signMessage: (args) => account.signMessage(args),
    signTypedData: (args: TypedDataDefinition) => account.signTypedData(args),
    signTransaction: () => Promise.reject(new Error('unused')),
  };
}

type OwnerOpts = {
  policy?: Partial<SpendPolicy>;
  walletAtomic?: bigint | null;
  approved?: boolean;
};

function owner(router: FakeRouter, opts: OwnerOpts = {}): LaneOwner {
  return new LaneOwner(ownerDeps(router, opts));
}

function ownerDeps(router: FakeRouter, opts: OwnerOpts = {}): LaneOwnerDeps {
  return {
    dataDir: dir,
    baseUrl: BASE,
    approved: async () => opts.approved ?? true,
    walletAddress: async () => wallet.address,
    getSigner: async () => signer(),
    policy: async () => ({
      maxAutoSpendAtomic: 250_000n,
      sessionBudgetAtomic: 5_000_000n,
      allowlistCreators: [],
      ...opts.policy,
    }),
    walletBalance: async () => (opts.walletAtomic === undefined ? 10_000_000n : opts.walletAtomic),
    readContract: router.readContract as never,
    fetchImpl: router.fetch,
    now: () => clock,
    warn: () => undefined,
  };
}

const ctx: () => CommandContext = () => ({
  flags: { json: true, timeout: 5_000 },
  dataDir: dir,
  io: {
    stdout: { write: () => true } as unknown as NodeJS.WritableStream,
    stderr: { write: () => true } as unknown as NodeJS.WritableStream,
    isTTY: false,
  },
});

const paid = (): RoutingFee => ({
  mode: 'paid',
  dataDir: dir,
  allowanceAtomic: ROUTING_ALLOWANCE_ATOMIC,
});

/** One routing call the way the hook makes it. */
async function routeOnce(router: FakeRouter) {
  return payForDecision(
    paid(),
    (payment) =>
      requestDecision(
        'tool',
        { query: 'q' },
        { ctx: ctx(), baseUrl: BASE, fetchImpl: router.fetch, ...(payment ? { payment } : {}) },
      ),
    clock,
  );
}

describe('LaneOwner', () => {
  it('records an absent paid path and does nothing else', async () => {
    const router = new FakeRouter({ paid: false });
    await owner(router).tick();
    expect((await readPool(dir))?.paidPath).toBe('absent');
    expect(await laneIndices(laneDir())).toEqual([]);
  });

  it('sends nothing at all while the routing fee is not approved: no probe, no lane, no deposit', async () => {
    const router = new FakeRouter();
    let calls = 0;
    const counted = new LaneOwner({
      ...ownerDeps(router, { approved: false }),
      fetchImpl: (async (...args: Parameters<typeof fetch>) => {
        calls += 1;
        return router.fetch(...args);
      }) as typeof fetch,
    });
    await counted.tick();
    expect(calls).toBe(0);
    expect(await readPool(dir)).toBeNull();
    expect(await laneIndices(laneDir())).toEqual([]);
  });

  it('funds a lane with one $0.25 deposit and pre-signs a ladder of ten rungs', async () => {
    const router = new FakeRouter();
    await owner(router).tick();
    expect(router.deposits).toBe(1);
    const state = await readLaneState(laneDir(), 0);
    expect(state).toMatchObject({ balanceAtomic: '250000', chargedAtomic: '0', status: 'ready' });
    expect(state?.ladder.map((r) => r.maxClaimableAtomic)).toEqual(
      Array.from({ length: 10 }, (_, i) => String((i + 1) * 3000)),
    );
  });

  it('pays routing calls from the ladder, one fee each', async () => {
    const router = new FakeRouter();
    await owner(router).tick();
    for (let i = 0; i < 3; i++) {
      expect((await routeOnce(router)).status).toBe('decided');
    }
    expect(router.settledFees).toBe(3);
    expect(await feesInWindow(dir, clock)).toBe(9_000n);
  });

  it('tops up a lane whose balance is below one fee, through the funding path', async () => {
    const router = new FakeRouter();
    const lanes = owner(router);
    await lanes.tick();
    const id = (await readLaneState(laneDir(), 0))!.channelId.toLowerCase();
    // The server has charged all but 2,000 of the deposit.
    router.channels.get(id)!.charged = 248_000n;
    router.channels.get(id)!.last = undefined;
    const state = (await readLaneState(laneDir(), 0))!;
    const { writeJson, laneFiles } = await import('./lanes');
    await writeJson(laneFiles.state(laneDir(), 0), { ...state, chargedAtomic: '248000' });
    await lanes.tick();
    expect(router.deposits).toBe(2);
    expect(await readLaneState(laneDir(), 0)).toMatchObject({
      balanceAtomic: '500000',
      chargedAtomic: '248000',
      status: 'ready',
    });
  });

  it('reads the channel from the chain before depositing again when a funding answer is lost', async () => {
    const router = new FakeRouter();
    const lanes = owner(router);
    // The deposit lands, then the connection drops before its answer is read.
    router.abortAfterSettle = true;
    await lanes.tick();
    expect(router.deposits).toBe(1);
    expect(await readLaneState(laneDir(), 0)).toMatchObject({
      balanceAtomic: '0',
      status: 'recovering',
    });
    await lanes.tick();
    expect(router.deposits).toBe(1);
    expect(await readLaneState(laneDir(), 0)).toMatchObject({
      balanceAtomic: '250000',
      status: 'ready',
    });
    expect((await routeOnce(router)).status).toBe('decided');
  });

  it('backs off deposits on a lane while the funding path fails: 30 s, doubling, reset on success', async () => {
    const router = new FakeRouter();
    router.failFunding = true;
    const lanes = owner(router);
    const start = clock;
    const attemptsAt = async (at: number) => {
      clock = at;
      await lanes.tick();
      return router.fundingAttempts;
    };
    expect(await attemptsAt(start)).toBe(1);
    // The lost answer goes to recovery, which finds nothing landed.
    expect(await readLaneState(laneDir(), 0)).toMatchObject({
      status: 'recovering',
      fundFailures: 1,
      fundRetryAtMs: start + 30_000,
    });
    expect(await attemptsAt(start + 5_000)).toBe(1);
    expect(await readLaneState(laneDir(), 0)).toMatchObject({ status: 'ready', fundFailures: 1 });
    expect(await attemptsAt(start + 29_999)).toBe(1);
    expect(await attemptsAt(start + 30_000)).toBe(2);
    expect(await attemptsAt(start + 30_000 + 59_999)).toBe(2);
    expect(await attemptsAt(start + 90_000)).toBe(3);
    expect(await readLaneState(laneDir(), 0)).toMatchObject({
      fundFailures: 3,
      fundRetryAtMs: start + 90_000 + 120_000,
    });
    router.failFunding = false;
    expect(await attemptsAt(start + 210_000)).toBe(4);
    const funded = (await readLaneState(laneDir(), 0))!;
    expect(funded).toMatchObject({ balanceAtomic: '250000', status: 'ready' });
    expect(funded.fundFailures).toBeUndefined();
    expect(funded.fundRetryAtMs).toBeUndefined();
    expect(router.deposits).toBe(1);
  });

  it('waits at most ten minutes between deposit attempts', async () => {
    const router = new FakeRouter();
    router.failFunding = true;
    const lanes = owner(router);
    await lanes.tick();
    const state = (await readLaneState(laneDir(), 0))!;
    const { writeJson, laneFiles } = await import('./lanes');
    await writeJson(laneFiles.state(laneDir(), 0), {
      ...state,
      status: 'ready',
      fundFailures: 6,
      fundRetryAtMs: clock,
    });
    await lanes.tick();
    expect(await readLaneState(laneDir(), 0)).toMatchObject({
      fundFailures: 7,
      fundRetryAtMs: clock + FUND_BACKOFF_MAX_MS,
    });
  });

  it('keeps the wait across a restart of tenjin mcp', async () => {
    const router = new FakeRouter();
    router.failFunding = true;
    await owner(router).tick();
    expect(router.fundingAttempts).toBe(1);
    // The process exits; a new one adopts the lane inside the wait.
    await rm(laneFiles.lease(laneDir(), 0));
    clock += 10_000;
    const restarted = owner(router);
    await restarted.tick();
    expect(restarted.ownedLanes()).toEqual([0]);
    clock += 19_999;
    await restarted.tick();
    expect(router.fundingAttempts).toBe(1);
    clock += 1;
    await restarted.tick();
    expect(router.fundingAttempts).toBe(2);
  });

  it('funds a lane under per-call and daily limits below the deposit, and records no spend', async () => {
    const router = new FakeRouter();
    await owner(router, {
      policy: { maxAutoSpendAtomic: 10_000n, sessionBudgetAtomic: 10_000n },
    }).tick();
    expect(router.deposits).toBe(1);
    expect((await readWalletPool(laneDir()))?.fundingBlocked).toBeNull();
    expect(await readLaneState(laneDir(), 0)).toMatchObject({
      balanceAtomic: '250000',
      status: 'ready',
    });
    await expect(access(spendLedgerPath(dir))).rejects.toThrow();
  });

  it('records no spend when a funding answer is lost', async () => {
    const router = new FakeRouter();
    router.abortAfterSettle = true;
    await owner(router, { policy: { sessionBudgetAtomic: 0n } }).tick();
    expect(router.deposits).toBe(1);
    await expect(access(spendLedgerPath(dir))).rejects.toThrow();
  });

  it('stops funding when allowlistCreators leaves out the router host', async () => {
    const router = new FakeRouter();
    await owner(router, { policy: { allowlistCreators: ['someone-else'] } }).tick();
    expect(router.deposits).toBe(0);
    expect((await readWalletPool(laneDir()))?.fundingBlocked).toBe('not_allowlisted');
    const claimed = await claimLane(dir, { now: clock, allowanceAtomic: ROUTING_ALLOWANCE_ATOMIC });
    expect(claimed.lane).toBeNull();
  });

  it('pauses for funds when the wallet cannot make the deposit', async () => {
    const router = new FakeRouter();
    await owner(router, { walletAtomic: 100_000n }).tick();
    expect(router.deposits).toBe(0);
    expect(await pausedReason(dir, true)).toEqual({
      reason: 'cannot_fund',
      walletAtomic: 100_000n,
    });
  });

  it('leaves a funding block standing through a pass from a process that funded nothing', async () => {
    const router = new FakeRouter();
    await owner(router, { walletAtomic: 100_000n }).tick();
    expect((await readWalletPool(laneDir()))?.fundingBlocked).toBe('wallet_low');
    // A second session's owner: the lane is leased to the first, so it
    // services nothing and has nothing to say about funding.
    const second = owner(router, { walletAtomic: 100_000n });
    await second.tick();
    expect(second.ownedLanes()).toEqual([]);
    expect((await readWalletPool(laneDir()))?.fundingBlocked).toBe('wallet_low');
    expect(await pausedReason(dir, true)).toMatchObject({ reason: 'cannot_fund' });
  });

  it('pauses, naming the passphrase, when the wallet cannot be unlocked without a prompt', async () => {
    const router = new FakeRouter();
    let locked = true;
    const lanes = new LaneOwner({
      ...ownerDeps(router),
      getSigner: async () => {
        if (locked) throw new Error('No wallet passphrase available.');
        return signer();
      },
    });
    await lanes.tick();
    expect(router.deposits).toBe(0);
    expect(await laneIndices(laneDir())).toEqual([]);
    expect(await pausedReason(dir, true)).toEqual({ reason: 'wallet_locked' });
    locked = false;
    await lanes.tick();
    expect(router.deposits).toBe(1);
    expect(await pausedReason(dir, true)).toBeNull();
  });

  it('gives a replaced wallet lanes of its own, and funds them', async () => {
    const router = new FakeRouter();
    await owner(router).tick();
    const before = await readLaneState(laneDir(), 0);
    const other = privateKeyToAccount(generatePrivateKey());
    const replaced = new LaneOwner({
      ...ownerDeps(router),
      walletAddress: async () => other.address,
      getSigner: async () => signer(other),
    });
    await replaced.tick();
    expect(router.deposits).toBe(2);
    const fresh = await readLaneState(payerLanesDir(dir, other.address), 0);
    expect(fresh).toMatchObject({ payer: other.address, balanceAtomic: '250000', status: 'ready' });
    expect(fresh?.channelId).not.toBe(before?.channelId);
    // The old wallet's lane is left exactly as it was.
    expect(await readLaneState(laneDir(), 0)).toEqual(before);
    expect(await pausedReason(dir, true)).toBeNull();
    expect((await routeOnce(router)).status).toBe('decided');
    expect(router.channels.get(fresh!.channelId.toLowerCase())?.charged).toBe(3_000n);
  });

  it('keeps a pass on the payer it started with when the wallet is replaced mid-pass', async () => {
    const router = new FakeRouter();
    const other = privateKeyToAccount(generatePrivateKey());
    // The first read of a pass sees the old wallet; every later read the new one.
    let reads = 0;
    const lanes = new LaneOwner({
      ...ownerDeps(router),
      walletAddress: async () => (reads++ === 0 ? wallet.address : other.address),
      getSigner: async () => signer(reads <= 1 ? wallet : other),
    });
    await lanes.tick();
    expect(await readLaneState(laneDir(), 0)).toMatchObject({
      payer: wallet.address,
      balanceAtomic: '250000',
    });
    expect(await laneIndices(payerLanesDir(dir, other.address))).toEqual([]);
    // The next pass starts with the new wallet and uses its folder.
    await lanes.tick();
    expect(await readLaneState(payerLanesDir(dir, other.address), 0)).toMatchObject({
      payer: other.address,
      balanceAtomic: '250000',
    });
    expect(await laneIndices(laneDir())).toEqual([0]);
    expect(router.deposits).toBe(2);
  });

  it('signs nothing for a payer whose wallet was replaced before the unlock', async () => {
    const router = new FakeRouter();
    const other = privateKeyToAccount(generatePrivateKey());
    let reads = 0;
    const lanes = new LaneOwner({
      ...ownerDeps(router),
      walletAddress: async () => (reads++ === 0 ? wallet.address : other.address),
      getSigner: async () => signer(other),
    });
    await lanes.tick();
    expect(router.deposits).toBe(0);
    expect(await laneIndices(laneDir())).toEqual([]);
    await lanes.tick();
    expect(await readLaneState(payerLanesDir(dir, other.address), 0)).toMatchObject({
      payer: other.address,
      balanceAtomic: '250000',
    });
    expect(router.deposits).toBe(1);
  });

  it("brings the old wallet's lanes back when it is in use again, and counts only its fees", async () => {
    const router = new FakeRouter();
    const other = privateKeyToAccount(generatePrivateKey());
    let inUse = wallet;
    const lanes = new LaneOwner({
      ...ownerDeps(router),
      walletAddress: async () => inUse.address,
      getSigner: async () => signer(inUse),
    });
    await lanes.tick();
    expect((await routeOnce(router)).status).toBe('decided');
    await lanes.tick();
    const old = (await readLaneState(laneDir(), 0))!;
    expect(old.chargedAtomic).toBe('3000');

    inUse = other;
    await lanes.tick();
    expect(router.deposits).toBe(2);
    expect(await feesInWindow(dir, clock)).toBe(0n);
    expect((await feeSummary(dir, clock)).creditAtomic).toBe('250000');

    inUse = wallet;
    await lanes.tick();
    // No new lane and no new deposit: the old lane, with what it still holds.
    expect(router.deposits).toBe(2);
    expect(lanes.ownedLanes()).toEqual([0]);
    expect(await readLaneState(laneDir(), 0)).toMatchObject({
      channelId: old.channelId,
      chargedAtomic: '3000',
      status: 'ready',
    });
    expect(await feesInWindow(dir, clock)).toBe(3_000n);
    expect(await feeSummary(dir, clock)).toMatchObject({
      chargedAtomic: '3000',
      creditAtomic: '247000',
    });
    expect((await routeOnce(router)).status).toBe('decided');
    expect(router.channels.get(old.channelId.toLowerCase())?.charged).toBe(6_000n);
  });

  it('moves lanes from the flat layout into their payer folder, with no new deposit', async () => {
    const router = new FakeRouter();
    await owner(router).tick();
    const before = await readLaneState(laneDir(), 0);
    // The layout of earlier builds: one wallet's files straight in the lanes directory.
    for (const name of await readdir(laneDir())) {
      if (name !== 'pool.json') await rename(join(laneDir(), name), join(lanesDir(dir), name));
    }
    await rm(join(lanesDir(dir), 'payer.json'));
    await rm(laneDir(), { recursive: true });
    await owner(router).tick();
    expect(router.deposits).toBe(1);
    expect(await readLaneState(laneDir(), 0)).toMatchObject({
      channelId: before?.channelId,
      balanceAtomic: '250000',
    });
    expect(await laneIndices(lanesDir(dir))).toEqual([]);
    expect((await routeOnce(router)).status).toBe('decided');
  });

  it('a killed hook: its claim expires, the next voucher meets a corrective 402, and the lane recovers with no double charge', async () => {
    const router = new FakeRouter();
    const lanes = owner(router);
    await lanes.tick();

    // A hook claims the lane and sends its rung; the server charges it; the
    // hook is killed before it writes anything back.
    const killed = await claimLane(dir, { now: clock, allowanceAtomic: ROUTING_ALLOWANCE_ATOMIC });
    expect(killed.lane).not.toBeNull();
    await router.fetch(`${BASE}/api/x402-router/route`, {
      method: 'POST',
      headers: { 'PAYMENT-SIGNATURE': killed.lane!.header },
    });
    expect(router.settledFees).toBe(1);

    // Inside the claim's ten seconds nobody else can take the lane.
    clock += 5_000;
    expect((await routeOnce(router)).status).toBe('skipped');

    // Past it, the claim is taken over; the stale rung meets a corrective 402.
    clock += 6_000;
    const stale = await routeOnce(router);
    expect(stale.status).toBe('failed');
    expect(router.settledFees).toBe(1);
    expect((await routeOnce(router)).status).toBe('skipped');

    // The owner hands the 402 to the SDK's recovery and signs from the new total.
    await lanes.tick();
    expect(await readLaneState(laneDir(), 0)).toMatchObject({
      chargedAtomic: '3000',
      status: 'ready',
    });
    // The fee only recovery found is in the ledger and the allowance.
    expect(await feesInWindow(dir, clock)).toBe(3_000n);
    expect((await routeOnce(router)).status).toBe('decided');
    expect(router.settledFees).toBe(2);
    expect(await feesInWindow(dir, clock)).toBe(6_000n);
    // The skipped call grew the pool, so the last call may take either lane:
    // across every channel, two answered calls cost exactly two fees.
    const charged = [...router.channels.values()].reduce((sum, c) => sum + c.charged, 0n);
    expect(charged).toBe(6_000n);
  });

  it('a client abort after the server settled leads to recovery on the next voucher', async () => {
    const router = new FakeRouter();
    const lanes = owner(router);
    await lanes.tick();
    router.abortAfterSettle = true;
    expect((await routeOnce(router)).status).toBe('failed');
    expect(router.settledFees).toBe(1);
    // The lane does not know it was charged, so its next rung is corrected.
    expect((await routeOnce(router)).status).toBe('failed');
    await lanes.tick();
    expect(await readLaneState(laneDir(), 0)).toMatchObject({
      chargedAtomic: '3000',
      status: 'ready',
    });
    expect((await routeOnce(router)).status).toBe('decided');
    expect(router.settledFees).toBe(2);
    expect(await feesInWindow(dir, clock)).toBe(6_000n);
  });

  it('is the only writer of fee lines: a fee counts from its result, then from one line', async () => {
    const router = new FakeRouter();
    const lanes = owner(router);
    await lanes.tick();
    expect((await routeOnce(router)).status).toBe('decided');
    expect(await readFees(laneDir(), 0)).toEqual([]);
    expect(await feesInWindow(dir, clock)).toBe(3_000n);
    await lanes.tick();
    expect(await readFees(laneDir(), 0)).toEqual([{ atMs: clock, feeAtomic: 3_000n }]);
    expect(await feesInWindow(dir, clock)).toBe(3_000n);
    // A day on, the owner drops the line and the window is empty.
    clock += ROUTING_WINDOW_MS;
    await lanes.tick();
    expect(await readFees(laneDir(), 0)).toEqual([]);
    expect(await feesInWindow(dir, clock)).toBe(0n);
  });

  it("counts a fee found through recovery once, even when the slow hook's result lands after it", async () => {
    const router = new FakeRouter();
    const lanes = owner(router);
    await lanes.tick();
    const slow = await claimLane(dir, { now: clock, allowanceAtomic: ROUTING_ALLOWANCE_ATOMIC });
    const answer = await router.fetch(`${BASE}/api/x402-router/route`, {
      method: 'POST',
      headers: { 'PAYMENT-SIGNATURE': slow.lane!.header },
    });
    clock += HOOK_CLAIM_TTL_MS + 1_000;
    expect((await routeOnce(router)).status).toBe('failed');
    expect(await feesInWindow(dir, clock)).toBe(0n);

    await lanes.tick();
    expect(await feesInWindow(dir, clock)).toBe(3_000n);
    expect(await claimLane(dir, { now: clock, allowanceAtomic: ROUTING_FEE_ATOMIC })).toEqual({
      lane: null,
      why: 'allowance',
    });

    await slow.lane!.finish({
      kind: 'answered',
      status: 200,
      paymentResponse: answer.headers.get('payment-response')!,
    });
    expect(await feesInWindow(dir, clock)).toBe(3_000n);
    await lanes.tick();
    expect(await readFees(laneDir(), 0)).toHaveLength(1);
    expect(await feesInWindow(dir, clock)).toBe(3_000n);
    expect(router.settledFees).toBe(1);
  });

  it('writes a fee that only recovery found once', async () => {
    const router = new FakeRouter();
    const lanes = owner(router);
    await lanes.tick();
    expect((await routeOnce(router)).status).toBe('decided');
    // The answer's result is lost, so the lane's next rung is corrected.
    await rm(laneFiles.result(laneDir(), 0));
    expect((await routeOnce(router)).status).toBe('failed');
    await lanes.tick();
    expect(await readLaneState(laneDir(), 0)).toMatchObject({
      chargedAtomic: '3000',
      status: 'ready',
    });
    expect(await readFees(laneDir(), 0)).toHaveLength(1);
    expect(await feesInWindow(dir, clock)).toBe(3_000n);
  });

  it('grows the pool by one lane when a payer found none free, up to the cap', async () => {
    const router = new FakeRouter();
    const lanes = owner(router);
    await lanes.tick();
    const held = await claimLane(dir, { now: clock, allowanceAtomic: ROUTING_ALLOWANCE_ATOMIC });
    expect(held.lane).not.toBeNull();
    expect(
      (await claimLane(dir, { now: clock, allowanceAtomic: ROUTING_ALLOWANCE_ATOMIC })).lane,
    ).toBeNull();
    await lanes.tick();
    await lanes.tick();
    expect(await laneIndices(laneDir())).toEqual([0, 1]);
    expect(lanes.ownedLanes()).toEqual([0, 1]);
    expect(router.deposits).toBe(2);
  });
});

describe('one channel id on both sides', () => {
  // The server scheme does not export its channel-id function, so this asks it
  // through a public hook that computes one from a payload's channel config:
  // refund enrichment refuses a voucher whose id does not match, before it
  // ever looks the channel up.
  it("is the id the 2.21.0 server scheme computes from the client's channel config", async () => {
    const router = new FakeRouter();
    const client = new ClientScheme(
      { address: wallet.address, signTypedData: () => Promise.reject(new Error('unused')) },
      { salt: `0x${'ab'.repeat(32)}` },
    );
    const channelConfig = client.buildChannelConfig(router.requirement);
    // The SDK's default with no voucher signer: the wallet authorizes the vouchers.
    expect(channelConfig.payerAuthorizer).toBe(wallet.address);
    const clientId = computeChannelId(channelConfig, NETWORK);
    const server = new ServerScheme(router.requirement.payTo as `0x${string}`);
    const refund = (channelId: string) =>
      server.enrichSettlementPayload({
        paymentPayload: {
          x402Version: 2,
          accepted: router.requirement,
          payload: {
            type: 'refund',
            channelConfig,
            voucher: { channelId, maxClaimableAmount: '0', signature: '0x' },
          },
        },
        requirements: router.requirement,
      } as never);
    await expect(refund(clientId)).rejects.toThrow('invalid_batch_settlement_evm_missing_channel');
    await expect(refund(`0x${'00'.repeat(32)}`)).rejects.toThrow(
      'refund channelId does not match channelConfig',
    );
  });
});
