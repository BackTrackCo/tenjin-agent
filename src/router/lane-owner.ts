import { randomBytes } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import { decodePaymentRequiredHeader } from '@x402/core/http';
import type { PaymentRequired, PaymentRequirements } from '@x402/core/types';
import type { ClientEvmSigner } from '@x402/evm';
import {
  BatchSettlementEvmScheme,
  InMemoryClientChannelStorage,
  computeChannelId,
  processCorrectivePaymentRequired,
  processPaymentResponse,
  processSettleResponse,
  recoverChannel,
  type BatchSettlementClientDeps,
} from '@x402/evm/batch-settlement/client';
import type { TypedDataDefinition } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { httpRequest, type HttpResult } from '../lib/http';
import type { SpendAuthorizer } from '../lib/wallet';
import type { TenjinSigner } from '../lib/wallet/provider';
import {
  HOOK_CLAIM_TTL_MS,
  LADDER_RUNGS,
  LANE_DEPOSIT_ATOMIC,
  laneFiles,
  laneIndices,
  lanesDir,
  LEASE_TTL_MS,
  MAX_LANES,
  OWNER_CLAIM_TTL_MS,
  feeLines,
  readFees,
  recordChargedTotal,
  readLaneResult,
  readLaneState,
  readPool,
  ROUTE_CHANNEL_PATH,
  ROUTE_PAID_PATH,
  ROUTING_FEE_ATOMIC,
  ROUTING_WINDOW_MS,
  dropClaim,
  takeClaim,
  writeJson,
  writePool,
  type LaneState,
  type PoolState,
} from './lanes';

/**
 * THE LANE OWNER: the part of the routing fee that needs a key. It runs inside
 * `tenjin mcp`, never in a hook, and does nothing at all, not even a probe of
 * the paid path, until the routing fee is approved.
 *
 * Every payment step is the SDK's own: the funding path is paid with the
 * standard x402 client and the `batch-settlement` scheme, whose
 * `depositStrategy` sizes each deposit at $0.25; each ladder rung is the same
 * client's voucher payload for one cumulative cap, encoded with the standard
 * header encoder; and a corrective 402 goes to the SDK's channel recovery.
 * Nothing here builds a payload or a header by hand.
 *
 * Deposits are spends: each is authorized through the local spend policy
 * first, so a per-call limit under $0.25 or a spent daily budget stops funding
 * before anything is signed.
 */

/** How long the probe's answer stands before the server is asked again. */
const PROBE_TTL_MS = 10 * 60_000;
/** A server with no paid path is asked again hourly, by any process. */
const ABSENT_PROBE_TTL_MS = 60 * 60_000;
/** A pool demand note this recent grows the pool by one lane. */
const DEMAND_WINDOW_MS = 60_000;
/** Rebuild the ladder when fewer rungs than this are left above the total. */
const LADDER_LOW = LADDER_RUNGS / 2;

export interface LaneOwnerDeps {
  dataDir: string;
  baseUrl: string;
  /** Whether the routing fee is approved, read fresh each pass. */
  approved: () => Promise<boolean>;
  /** The wallet's address, without unlocking it. */
  walletAddress: () => Promise<`0x${string}` | null>;
  /** The wallet signer, unlocked only when a deposit is signed. */
  getSigner: () => Promise<TenjinSigner>;
  /** The spend policy, read fresh each pass. */
  authorizer: () => Promise<SpendAuthorizer>;
  /** The wallet's USDC balance, or null when it cannot be read. */
  walletBalance: (address: string) => Promise<bigint | null>;
  /**
   * THE LOCAL VOUCHER KEY: a key of its own that signs vouchers and nothing
   * else, every lane's `payerAuthorizer`, so a voucher never needs the wallet
   * unlocked and what it can authorize is capped by what a lane holds. Kept
   * encrypted at rest like the wallet key (`lib/wallet/voucher-key.ts`).
   */
  voucherKey: () => Promise<`0x${string}`>;
  /** Chain reads for the SDK's recovery. */
  readContract?: ClientEvmSigner['readContract'];
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  warn?: (line: string) => void;
}

/** How a funding attempt ended. */
interface Funding {
  blocked?: PoolState['fundingBlocked'];
  walletAtomic?: bigint;
  /** A deposit was sent and no settle came back: it may have landed. */
  depositUnknown?: true;
}

interface Probe {
  atMs: number;
  /** The paid path's 402, narrowed to its batch-settlement entry. */
  paid: PaymentRequired | null;
}

export class LaneOwner {
  private readonly id = randomBytes(8).toString('hex');
  private readonly owned = new Set<number>();
  private probe: Probe | null = null;
  private voucherKey: ReturnType<typeof privateKeyToAccount> | null = null;
  private running: Promise<void> | null = null;

  constructor(private readonly deps: LaneOwnerDeps) {}

  /** Lanes this process holds the lease on: the request tool pays from them first. */
  ownedLanes(): number[] {
    return [...this.owned].sort((a, b) => a - b);
  }

  /** One maintenance pass; a pass already running is joined, never doubled. */
  tick(): Promise<void> {
    this.running ??= this.pass().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** Run a pass now and every `intervalMs`; the returned function stops it. */
  start(intervalMs = 5_000): () => void {
    void this.tick().catch((err: unknown) => this.warn(err));
    const timer = setInterval(() => {
      void this.tick().catch((err: unknown) => this.warn(err));
    }, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private warn(err: unknown): void {
    (this.deps.warn ?? ((line: string) => process.stderr.write(`${line}\n`)))(
      `tenjin mcp: routing lanes: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  private async pass(): Promise<void> {
    // NOTHING BEFORE APPROVAL: no probe, no lane, no deposit.
    if (!(await this.deps.approved())) return;
    const paid = await this.paidRequirements();
    if (paid === null) return;
    const address = await this.deps.walletAddress();
    if (address === null) return;
    const dir = lanesDir(this.deps.dataDir);
    await this.leaseLanes(dir);
    let blocked: PoolState['fundingBlocked'] = null;
    let walletAtomic: bigint | null = null;
    for (const index of this.ownedLanes()) {
      const outcome = await this.serviceLane(dir, index, paid, address);
      if (outcome?.blocked !== undefined) {
        blocked = outcome.blocked;
        walletAtomic = outcome.walletAtomic ?? walletAtomic;
      }
    }
    await writePool(this.deps.dataDir, {
      fundingBlocked: blocked,
      ...(walletAtomic !== null ? { walletBalanceAtomic: walletAtomic.toString() } : {}),
    });
  }

  /**
   * THE PAID PATH'S OWN 402, which every voucher's `accepted` has to match.
   * Asked with no payment and an empty body, so the paywall answers before any
   * routing runs and nothing is charged. Asked only once the routing fee is
   * approved, and recorded in the pool, so the hooks know whether the server
   * answers the paid path at all.
   */
  private async paidRequirements(): Promise<PaymentRequired | null> {
    const now = this.now();
    if (this.probe !== null && now - this.probe.atMs < PROBE_TTL_MS) return this.probe.paid;
    const pool = await readPool(this.deps.dataDir);
    if (pool?.paidPath === 'absent' && now - pool.checkedAtMs < ABSENT_PROBE_TTL_MS) {
      this.probe = { atMs: pool.checkedAtMs, paid: null };
      return null;
    }
    const paid = await this.requirementsAt(ROUTE_PAID_PATH);
    this.probe = { atMs: now, paid };
    await writePool(this.deps.dataDir, {
      paidPath: paid === null ? 'absent' : 'available',
      checkedAtMs: now,
    });
    return paid;
  }

  private async requirementsAt(path: string): Promise<PaymentRequired | null> {
    const response = await this.post(path, {});
    if (!response.ok || response.status !== 402) return null;
    const header = response.header('payment-required');
    if (header === undefined) return null;
    let required: PaymentRequired;
    try {
      required = decodePaymentRequiredHeader(header);
    } catch {
      return null;
    }
    const accept = required.accepts.find(
      (a) => a.scheme === 'batch-settlement' && a.amount === ROUTING_FEE_ATOMIC.toString(),
    );
    return accept === undefined ? null : { ...required, accepts: [accept] };
  }

  private post(path: string, body: unknown, headers?: Record<string, string>): Promise<HttpResult> {
    return httpRequest(new URL(path, this.deps.baseUrl).toString(), {
      method: 'POST',
      timeoutMs: this.deps.timeoutMs ?? 30_000,
      blockRedirects: true,
      jsonBody: body,
      ...(headers !== undefined ? { headers } : {}),
      ...(this.deps.fetchImpl !== undefined ? { fetchImpl: this.deps.fetchImpl } : {}),
    });
  }

  /**
   * RENEW, ADOPT, GROW. Every lane whose lease this process holds is renewed;
   * one whose owner stopped renewing is adopted, under the lane's claim so two
   * processes cannot both take it; and a pool with recent demand and room
   * gets one more lane.
   */
  private async leaseLanes(dir: string): Promise<void> {
    const now = this.now();
    const indices = await laneIndices(dir);
    for (const index of indices) {
      const lease = await readLease(dir, index);
      if (lease?.owner === this.id || lease === null || lease.expiresAtMs <= now) {
        await this.holdLease(dir, index, lease?.owner === this.id);
      } else {
        this.owned.delete(index);
      }
    }
    const pool = await readPool(this.deps.dataDir);
    const demand = pool?.demandAtMs !== undefined && now - pool.demandAtMs < DEMAND_WINDOW_MS;
    if (indices.length === 0 || (demand && indices.length < MAX_LANES)) {
      const next = [...Array(MAX_LANES).keys()].find((i) => !indices.includes(i));
      if (next !== undefined) await this.createLane(dir, next);
      if (demand) await writePool(this.deps.dataDir, { demandAtMs: 0 });
    }
  }

  private async holdLease(dir: string, index: number, mine: boolean): Promise<void> {
    const now = this.now();
    if (mine) {
      await writeLease(dir, index, this.id, now);
      return;
    }
    const token = await takeClaim(dir, index, HOOK_CLAIM_TTL_MS, now);
    if (token === null) return;
    try {
      const lease = await readLease(dir, index);
      if (lease === null || lease.expiresAtMs <= now) {
        await writeLease(dir, index, this.id, now);
        this.owned.add(index);
      }
    } finally {
      await dropClaim(dir, index, token);
    }
  }

  private async createLane(dir: string, index: number): Promise<void> {
    const now = this.now();
    const token = await takeClaim(dir, index, HOOK_CLAIM_TTL_MS, now);
    if (token === null) return;
    try {
      if ((await readLaneState(dir, index)) !== null) return;
      const paid = this.probe?.paid;
      const address = await this.deps.walletAddress();
      if (paid == null || address === null) return;
      const salt = `0x${randomBytes(32).toString('hex')}` as `0x${string}`;
      const accept = paid.accepts[0] as PaymentRequirements;
      const scheme = new BatchSettlementEvmScheme(this.walletSigner(address), {
        salt,
        voucherSigner: await this.voucherSigner(),
      });
      const channelId = computeChannelId(scheme.buildChannelConfig(accept), accept.network);
      const state: LaneState = {
        version: 1,
        index,
        salt,
        channelId,
        balanceAtomic: '0',
        chargedAtomic: '0',
        status: 'ready',
        ladder: [],
        updatedAtMs: now,
      };
      await writeJson(laneFiles.state(dir, index), state);
      await writeLease(dir, index, this.id, now);
      this.owned.add(index);
    } finally {
      await dropClaim(dir, index, token);
    }
  }

  /**
   * ONE LANE, UNDER ITS CLAIM: fold in what the last payer wrote, recover after
   * a corrective 402, top up when the lane cannot pay one more fee, and sign
   * a fresh ladder when the old one runs low. A lane a hook holds right now is
   * left for the next pass.
   */
  private async serviceLane(
    dir: string,
    index: number,
    paid: PaymentRequired,
    address: `0x${string}`,
  ): Promise<Funding | null> {
    const now = this.now();
    const token = await takeClaim(dir, index, OWNER_CLAIM_TTL_MS, now);
    if (token === null) return null;
    try {
      const state = await readLaneState(dir, index);
      if (state === null) return null;
      const accept = paid.accepts[0] as PaymentRequirements;
      const storage = new InMemoryClientChannelStorage();
      await storage.set(state.channelId.toLowerCase(), {
        chargedCumulativeAmount: state.chargedAtomic,
        balance: state.balanceAtomic,
      });
      const clientDeps: BatchSettlementClientDeps = {
        signer: this.walletSigner(address),
        storage,
        salt: state.salt as `0x${string}`,
        voucherSigner: await this.voucherSigner(),
      };
      let status = await this.foldResult(dir, index, state, clientDeps, accept);
      let blocked: Funding = {};
      const ctx = await storage.get(state.channelId.toLowerCase());
      const charged = BigInt(ctx?.chargedCumulativeAmount ?? state.chargedAtomic);
      const balance = BigInt(ctx?.balance ?? state.balanceAtomic);
      if (status === 'ready' && balance - charged < ROUTING_FEE_ATOMIC) {
        blocked = await this.fund(clientDeps, state, address);
        // A deposit sent with no answer may have landed: the next pass reads
        // the channel from the chain before it deposits again.
        if (blocked.depositUnknown === true) status = 'recovering';
      }
      const fresh = await storage.get(state.channelId.toLowerCase());
      // A total learned through recovery may hold a fee no hook wrote down.
      await recordChargedTotal(dir, index, {
        floorAtomic: BigInt(state.chargedAtomic),
        chargedAtomic: BigInt(fresh?.chargedCumulativeAmount ?? state.chargedAtomic),
        atMs: now,
      });
      await this.pruneFees(dir, index, now);
      const next: LaneState = {
        ...state,
        chargedAtomic: fresh?.chargedCumulativeAmount ?? state.chargedAtomic,
        balanceAtomic: fresh?.balance ?? state.balanceAtomic,
        status,
        updatedAtMs: now,
        ladder: state.ladder,
      };
      next.ladder = status === 'ready' ? await this.ladderFor(next, paid, clientDeps) : [];
      await writeJson(laneFiles.state(dir, index), next);
      return blocked;
    } finally {
      await dropClaim(dir, index, token);
    }
  }

  /**
   * WHAT THE LAST PAYER SAW, handed to the SDK: a `PAYMENT-RESPONSE` updates
   * the channel's totals, and a corrective 402 runs the SDK's recovery, which
   * checks the server's state against the chain and against this client's own
   * voucher key before it accepts it. With no 402 to go on, the channel is
   * read back from the chain.
   */
  private async foldResult(
    dir: string,
    index: number,
    state: LaneState,
    clientDeps: BatchSettlementClientDeps,
    accept: PaymentRequirements,
  ): Promise<LaneState['status']> {
    const result = await readLaneResult(dir, index);
    const corrective = result !== null && result.outcome === 'corrective';
    if (result?.paymentResponse !== undefined) {
      const header = result.paymentResponse;
      await processPaymentResponse(clientDeps.storage, (name) =>
        name.toLowerCase() === 'payment-response' ? header : undefined,
      );
    }
    let status = state.status;
    if (corrective || status === 'recovering') {
      status = (await this.recover(clientDeps, accept, result?.paymentRequired))
        ? 'ready'
        : 'recovering';
    }
    await rm(laneFiles.result(dir, index), { force: true });
    return status;
  }

  private async recover(
    clientDeps: BatchSettlementClientDeps,
    accept: PaymentRequirements,
    header: string | undefined,
  ): Promise<boolean> {
    const deps = this.withReads(clientDeps);
    try {
      if (header !== undefined) {
        return await processCorrectivePaymentRequired(deps, decodePaymentRequiredHeader(header));
      }
      await recoverChannel(deps, accept);
      return true;
    } catch (err) {
      this.warn(err);
      return false;
    }
  }

  private withReads(clientDeps: BatchSettlementClientDeps): BatchSettlementClientDeps {
    const readContract = this.deps.readContract;
    return readContract === undefined
      ? clientDeps
      : { ...clientDeps, signer: { ...clientDeps.signer, readContract } };
  }

  /**
   * ONE $0.25 DEPOSIT THROUGH THE FUNDING PATH, inside the spend policy. The
   * standard client sees a channel that cannot cover the next fee and makes the
   * deposit itself; `depositStrategy` only names the amount. The funding path
   * runs no routing and settles at $0, so the deposit is the only money moved.
   */
  private async fund(
    clientDeps: BatchSettlementClientDeps,
    state: LaneState,
    address: `0x${string}`,
  ): Promise<Funding> {
    const authorizer = await this.deps.authorizer();
    const auth = await authorizer.authorize({
      amountAtomic: LANE_DEPOSIT_ATOMIC,
      creator: new URL(this.deps.baseUrl).host,
      requestKey: `routing-lane:${state.channelId}:${state.balanceAtomic}`,
    });
    if (auth.decision !== 'allow') return { blocked: 'spend_limit' };
    const wallet = await this.deps.walletBalance(address);
    if (wallet !== null && wallet < LANE_DEPOSIT_ATOMIC) {
      await authorizer.release(auth.reservationId);
      return { blocked: 'wallet_low', walletAtomic: wallet };
    }
    const funding = await this.requirementsAt(ROUTE_CHANNEL_PATH);
    if (funding === null) {
      await authorizer.release(auth.reservationId);
      return { blocked: null };
    }
    const signer = await this.deps.getSigner();
    const scheme = new BatchSettlementEvmScheme(
      {
        address,
        signTypedData: (message) => signer.signTypedData(message as unknown as TypedDataDefinition),
      },
      {
        storage: clientDeps.storage,
        salt: clientDeps.salt,
        ...(clientDeps.voucherSigner !== undefined
          ? { voucherSigner: clientDeps.voucherSigner }
          : {}),
        depositStrategy: () => LANE_DEPOSIT_ATOMIC.toString(),
      },
    );
    const network = (funding.accepts[0] as PaymentRequirements).network;
    const http = new x402HTTPClient(new x402Client().register(network, scheme));
    let sent = false;
    try {
      const payload = await http.createPaymentPayload(funding);
      const headers = http.encodePaymentSignatureHeader(payload);
      sent = true;
      const response = await this.post(ROUTE_CHANNEL_PATH, {}, headers);
      if (!response.ok || response.status >= 400) {
        throw new Error(
          response.ok ? `the funding path answered ${response.status}` : response.message,
        );
      }
      await processSettleResponse(
        clientDeps.storage,
        http.getPaymentSettleResponse((name) => response.header(name)),
      );
      await authorizer.commit(auth.reservationId, LANE_DEPOSIT_ATOMIC);
      return {};
    } catch (err) {
      // A deposit that may have left is counted, as every other spend is.
      if (sent) await authorizer.commit(auth.reservationId, LANE_DEPOSIT_ATOMIC);
      else await authorizer.release(auth.reservationId);
      this.warn(err);
      return sent ? { blocked: null, depositUnknown: true } : { blocked: null };
    }
  }

  /**
   * THE LADDER: one voucher per cumulative cap from the charged total plus one
   * fee, up to {@link LADDER_RUNGS} or the lane's balance. Each is the standard
   * client's voucher payload for that cap and the paid path's own requirements,
   * encoded by the standard encoder, so a hook sends it as it stands. A voucher
   * signs only the channel and the cap, so a rung is safe to keep.
   */
  private async ladderFor(
    state: LaneState,
    paid: PaymentRequired,
    clientDeps: BatchSettlementClientDeps,
  ): Promise<LaneState['ladder']> {
    const charged = BigInt(state.chargedAtomic);
    const balance = BigInt(state.balanceAtomic);
    const above = state.ladder.filter((r) => BigInt(r.maxClaimableAtomic) > charged);
    const first = (charged + ROUTING_FEE_ATOMIC).toString();
    if (above.length >= LADDER_LOW && above[0]?.maxClaimableAtomic === first) return above;
    const network = (paid.accepts[0] as PaymentRequirements).network;
    const ladder: LaneState['ladder'] = [];
    for (let i = 1n; i <= BigInt(LADDER_RUNGS); i++) {
      const cap = charged + i * ROUTING_FEE_ATOMIC;
      if (cap > balance) break;
      const storage = new InMemoryClientChannelStorage();
      await storage.set(state.channelId.toLowerCase(), {
        chargedCumulativeAmount: (cap - ROUTING_FEE_ATOMIC).toString(),
        balance: balance.toString(),
      });
      const scheme = new BatchSettlementEvmScheme(clientDeps.signer, {
        storage,
        salt: clientDeps.salt,
        ...(clientDeps.voucherSigner !== undefined
          ? { voucherSigner: clientDeps.voucherSigner }
          : {}),
      });
      const http = new x402HTTPClient(new x402Client().register(network, scheme));
      const payload = await http.createPaymentPayload(paid);
      const header = http.encodePaymentSignatureHeader(payload)['PAYMENT-SIGNATURE'];
      if (header === undefined) break;
      ladder.push({ maxClaimableAtomic: cap.toString(), header });
    }
    return ladder;
  }

  /**
   * Drop lines past the window, except the one naming the lane's highest
   * total: a fee recovery finds later at or under that total was counted when
   * it happened, and must not count again at recovery time.
   */
  private async pruneFees(dir: string, index: number, now: number): Promise<void> {
    const fees = await readFees(dir, index);
    let top: (typeof fees)[number] | undefined;
    for (const f of fees) {
      if (
        f.chargedAtomic !== undefined &&
        (top?.chargedAtomic === undefined || f.chargedAtomic > top.chargedAtomic)
      ) {
        top = f;
      }
    }
    const kept = fees.filter((f) => f === top || now - f.atMs < ROUTING_WINDOW_MS);
    if (kept.length === fees.length) return;
    await writeFile(laneFiles.fees(dir, index), feeLines(kept), { mode: 0o600 });
  }

  /**
   * The deposit signer as the scheme sees it. Building a channel config and a
   * voucher reads only the address; only a deposit signs with the wallet, and
   * that goes through {@link fund}, which unlocks it.
   */
  private walletSigner(address: `0x${string}`): ClientEvmSigner {
    return {
      address,
      signTypedData: () =>
        Promise.reject(new Error('the wallet signs deposits only, through the funding path')),
    };
  }

  /** Every lane's voucher signer, from {@link LaneOwnerDeps.voucherKey}. */
  private async voucherSigner(): Promise<ClientEvmSigner> {
    this.voucherKey ??= privateKeyToAccount(await this.deps.voucherKey());
    const account = this.voucherKey;
    return {
      address: account.address,
      signTypedData: (message) => account.signTypedData(message as unknown as TypedDataDefinition),
    };
  }
}

interface Lease {
  owner: string;
  pid: number;
  expiresAtMs: number;
}

async function readLease(dir: string, index: number): Promise<Lease | null> {
  try {
    const value = JSON.parse(await readFile(laneFiles.lease(dir, index), 'utf8')) as Lease;
    return typeof value.owner === 'string' && typeof value.expiresAtMs === 'number' ? value : null;
  } catch {
    return null;
  }
}

async function writeLease(dir: string, index: number, owner: string, now: number): Promise<void> {
  await writeJson(laneFiles.lease(dir, index), {
    owner,
    pid: process.pid,
    expiresAtMs: now + LEASE_TTL_MS,
  });
}
