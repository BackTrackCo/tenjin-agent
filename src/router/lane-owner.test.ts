import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from '@x402/core/http';
import type { PaymentRequirements } from '@x402/core/types';
import type { TypedDataDefinition } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLocalSpendAuthorizer } from '../lib/wallet/spend';
import type { TenjinSigner } from '../lib/wallet/provider';
import type { CommandContext } from '../context';
import { requestDecision } from './decision';
import { payForDecision, type RoutingFee } from './fee';
import { LaneOwner } from './lane-owner';
import {
  claimLane,
  feesInWindow,
  lanesDir,
  laneIndices,
  pausedReason,
  readLaneState,
  readPool,
  ROUTING_ALLOWANCE_ATOMIC,
  ROUTING_FEE_ATOMIC,
} from './lanes';

/**
 * The lane owner against a fake router that speaks the real x402 headers: the
 * SDK builds every deposit and voucher, and the SDK's recovery checks the
 * fake's corrective 402 against this client's own voucher key and a stubbed
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

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-lanes-'));
  clock = 1_800_000_000_000;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function signer(): TenjinSigner {
  return {
    address: wallet.address,
    signMessage: (args) => wallet.signMessage(args),
    signTypedData: (args: TypedDataDefinition) => wallet.signTypedData(args),
    signTransaction: () => Promise.reject(new Error('unused')),
  };
}

function owner(
  router: FakeRouter,
  opts: { maxAutoSpendAtomic?: bigint; walletAtomic?: bigint | null; approved?: boolean } = {},
): LaneOwner {
  return new LaneOwner({
    dataDir: dir,
    baseUrl: BASE,
    approved: async () => opts.approved ?? true,
    walletAddress: async () => wallet.address,
    getSigner: async () => signer(),
    authorizer: async () =>
      createLocalSpendAuthorizer({
        dir,
        policy: {
          maxAutoSpendAtomic: opts.maxAutoSpendAtomic ?? 250_000n,
          sessionBudgetAtomic: 5_000_000n,
          allowlistCreators: [],
        },
        now: () => clock,
      }),
    walletBalance: async () => (opts.walletAtomic === undefined ? 10_000_000n : opts.walletAtomic),
    readContract: router.readContract as never,
    fetchImpl: router.fetch,
    now: () => clock,
    warn: () => undefined,
  });
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
    expect(await laneIndices(lanesDir(dir))).toEqual([]);
  });

  it('probes but never funds while the routing fee is not approved', async () => {
    const router = new FakeRouter();
    await owner(router, { approved: false }).tick();
    expect((await readPool(dir))?.paidPath).toBe('available');
    expect(router.deposits).toBe(0);
    expect(await pausedReason(dir, false)).toEqual({ reason: 'approval_missing' });
  });

  it('funds a lane with one $0.25 deposit and pre-signs a ladder of ten rungs', async () => {
    const router = new FakeRouter();
    await owner(router).tick();
    expect(router.deposits).toBe(1);
    const state = await readLaneState(lanesDir(dir), 0);
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
    const id = (await readLaneState(lanesDir(dir), 0))!.channelId.toLowerCase();
    // The server has charged all but 2,000 of the deposit.
    router.channels.get(id)!.charged = 248_000n;
    router.channels.get(id)!.last = undefined;
    const state = (await readLaneState(lanesDir(dir), 0))!;
    const { writeJson, laneFiles } = await import('./lanes');
    await writeJson(laneFiles.state(lanesDir(dir), 0), { ...state, chargedAtomic: '248000' });
    await lanes.tick();
    expect(router.deposits).toBe(2);
    expect(await readLaneState(lanesDir(dir), 0)).toMatchObject({
      balanceAtomic: '500000',
      chargedAtomic: '248000',
      status: 'ready',
    });
  });

  it('stops funding when the spend limits refuse the deposit', async () => {
    const router = new FakeRouter();
    await owner(router, { maxAutoSpendAtomic: 100_000n }).tick();
    expect(router.deposits).toBe(0);
    expect((await readPool(dir))?.fundingBlocked).toBe('spend_limit');
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
    expect(await readLaneState(lanesDir(dir), 0)).toMatchObject({
      chargedAtomic: '3000',
      status: 'ready',
    });
    expect((await routeOnce(router)).status).toBe('decided');
    expect(router.settledFees).toBe(2);
    const id = (await readLaneState(lanesDir(dir), 0))!.channelId.toLowerCase();
    expect(router.channels.get(id)!.charged).toBe(6_000n);
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
    expect(await readLaneState(lanesDir(dir), 0)).toMatchObject({
      chargedAtomic: '3000',
      status: 'ready',
    });
    expect((await routeOnce(router)).status).toBe('decided');
    expect(router.settledFees).toBe(2);
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
    expect(await laneIndices(lanesDir(dir))).toEqual([0, 1]);
    expect(lanes.ownedLanes()).toEqual([0, 1]);
    expect(router.deposits).toBe(2);
  });
});
