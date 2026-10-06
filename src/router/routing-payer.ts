import { keccak256, stringToHex, type TypedDataDefinition } from 'viem';
import { x402Client, x402HTTPClient, type PaymentPolicy } from '@x402/core/client';
import type { PaymentRequired, PaymentRequirements } from '@x402/core/types';
import { toClientEvmSigner, type ClientEvmSigner } from '@x402/evm';
import { BatchSettlementEvmScheme, computeChannelId } from '@x402/evm/batch-settlement/client';
import { FileClientChannelStorage } from '@x402/evm/batch-settlement/client/file-storage';
import type { PartialConfig } from '../lib/config';
import { httpRequest, type HttpRequestOptions, type HttpResult } from '../lib/http';
import { creatorAllowed, type SpendPolicy } from '../lib/policy';
import type { TenjinSigner } from '../lib/wallet/provider';
import { canonicalUsdcOnly } from '../lib/x402-pay';
import { RouteSkipped, type DecisionRoute } from './decision';
import { routingAllowanceAtomic, routingFeeApproved } from './fee';
import {
  appendFee,
  CHANNEL_DEPOSIT_ATOMIC,
  dropSlot,
  feesInWindowFor,
  holdsSlot,
  MAX_SLOTS,
  payerDir,
  processAlive,
  ROUTE_PAID_PATH,
  ROUTING_FEE_ATOMIC,
  takeSlot,
  writeFeeState,
  type PayBlocked,
} from './fee-state';

/**
 * THE ROUTING FEE, PAID THE WAY THE SDK'S OWN CLIENT PAYS. It runs inside
 * `tenjin mcp`, never in a hook, and does nothing at all, not even a probe of
 * the paid path, until the routing fee is approved.
 *
 * The shape is the x402 guide's "MCP server with x402": a local stdio MCP
 * server whose tool pays an HTTP API through an `x402Client` with a
 * `BatchSettlementEvmScheme` the wallet signs for. Every payment step is the
 * stock client's: the SDK's `FileClientChannelStorage` for the channel, its
 * spend controls and payment policy before anything is signed, its
 * `onBeforePaymentCreation` hook for the checks the guide puts there,
 * `createPaymentPayload` (which deposits inline when the channel cannot cover
 * the fee), and `processPaymentResult`, which updates the channel from
 * `PAYMENT-RESPONSE` or recovers it from a corrective 402, after which the call
 * is retried once with a fresh payload, as the stock fetch wrapper does.
 * Nothing here builds a payload, a header or a channel total by hand.
 *
 * What is Tenjin's own, because the SDK has no equivalent:
 *
 * - ONE SLOT PER PROCESS. The server serves one pending request per channel
 *   and the SDK's file storage takes one writer per channel, so each process
 *   leases one slot of the wallet (`fee-state.ts`) and its channel is that
 *   slot's: a deterministic salt per slot index, so a restarted process, or the
 *   next one to take the slot, finds the same channel. Calls inside a process
 *   take turns on it.
 * - THE APPROVAL AND THE ALLOWANCE. Nothing is sent on the paid path before the
 *   routing fee is approved, and a call that would take the rolling 24 h fees
 *   past the routing allowance is not made: the SDK's cap is per payment, not
 *   per day. The fee lines come from the SDK's own charged total.
 * - A DEPOSIT IS NOT SPEND. It moves money into the wallet's own channel, so it
 *   counts against neither maxAutoSpend nor sessionBudget; the creator
 *   allowlist still applies to it, and a wallet that cannot cover it pauses
 *   paying with a notice rather than failing every call.
 */

/**
 * THE SDK'S PER-PAYMENT CAP for the routing fee, in place of its $1 default.
 * The SDK bounds each deposit by this cap times `depositMultiplier`, so the
 * two together are the deposit: $0.05 × 5 = $0.25 ({@link CHANNEL_DEPOSIT_ATOMIC}).
 * The exact fee is the payment policy's to hold.
 */
export const ROUTING_SPEND_CAP = '$0.05';
/** The SDK's default multiplier, spelled out because the deposit is cap × it. */
export const DEPOSIT_MULTIPLIER = 5;

/** How long the paid path's 402 stands before it is asked again. */
const PROBE_TTL_MS = 10 * 60_000;
/** A server with no paid path is asked again hourly. */
const ABSENT_PROBE_TTL_MS = 60 * 60_000;
/**
 * The probe's own ceiling; it is asked at most once per {@link PROBE_TTL_MS},
 * inside the caller's budget (the gate's 3.5 s in a hook leg).
 */
export const PROBE_TIMEOUT_MS = 2_000;
/** The wallet balance read before a deposit, also inside the caller's budget.
 *  Base's public RPC answered `balanceOf` in 0.16 to 0.26 s. */
export const BALANCE_TIMEOUT_MS = 1_000;
/**
 * A CALL THAT CARRIES A DEPOSIT waits for the facilitator to settle it on chain
 * before the server answers, so it may run this long past the caller's budget,
 * capped by the requirement's own `maxTimeoutSeconds`. It happens once per
 * $0.25 of fees per slot; every other call keeps the caller's budget. The
 * gate's 3.5 s plus this still return inside the hook's 5 s
 * (`wire.test.ts` pins it); a deposit that takes longer costs that prompt its
 * hint, and the SDK recovers the channel on the next call.
 */
export const DEPOSIT_GRACE_MS = 1_000;

export interface RoutingPayerDeps {
  dataDir: string;
  /** The wallet signer, unlocked without a prompt; it signs deposits and vouchers. */
  getSigner: () => Promise<TenjinSigner>;
  /** The spend policy, read fresh per deposit: only its creator allowlist applies. */
  policy: () => Promise<SpendPolicy>;
  /** The wallet's USDC balance, or null when it cannot be read. */
  walletBalance: (address: string, timeoutMs: number) => Promise<bigint | null>;
  /** Chain reads for the SDK's channel recovery. */
  readContract?: ClientEvmSigner['readContract'];
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** This process's id and the liveness check for another's; tests run two
   *  "processes" in one. */
  pid?: number;
  isAlive?: (pid: number) => boolean;
  warn?: (line: string) => void;
}

interface Probe {
  atMs: number;
  required: PaymentRequired | null;
}

interface Slot {
  payer: `0x${string}`;
  index: number;
  token: string;
  dir: string;
  storage: FileClientChannelStorage;
  scheme: BatchSettlementEvmScheme;
  http: x402HTTPClient;
}

/** What the call in progress brings to the SDK's before-payment hook. */
interface Call {
  slot: Slot;
  allowance: bigint;
  host: string;
  /** When the caller's budget ends. */
  until: number;
  /** Set by the hook when the payload it lets through carries a deposit. */
  deposit: boolean;
}

/** The salt of slot `index`: the same for every wallet, so the channel id
 *  (which also hashes the payer) is the slot's own for each wallet. */
export function slotSalt(index: number): `0x${string}` {
  return keccak256(stringToHex(`tenjin-routing-slot:${index}`));
}

/**
 * THE PAYMENT POLICY, the guide's check of the requirement before signing:
 * `batch-settlement` in canonical USDC on Base, at exactly the approved fee.
 * The server's `payTo` is not pinned: the client ships no treasury address, and
 * what the user approved is the fee, which this holds exactly.
 */
const routingPolicy: PaymentPolicy = (version, requirements) =>
  canonicalUsdcOnly(version, requirements).filter(
    (r) => r.scheme === 'batch-settlement' && r.amount === ROUTING_FEE_ATOMIC.toString(),
  );

/** Reads a 402 the way the SDK does; it signs nothing. */
const reader = new x402HTTPClient(new x402Client());

export class RoutingPayer {
  private readonly probes = new Map<string, Probe>();
  private slot: Slot | null = null;
  private call: Call | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: RoutingPayerDeps) {}

  /**
   * The paid path for one call, or null for the free path: before approval,
   * while the server answers no paid path, or when its 402 cannot be read.
   */
  async routeFor(config: PartialConfig, baseUrl: string): Promise<DecisionRoute | null> {
    if (!routingFeeApproved(config)) return null;
    const required = await this.requirements(baseUrl);
    if (required === null) return null;
    const allowance = routingAllowanceAtomic(config);
    return {
      path: ROUTE_PAID_PATH,
      send: (url, options) => {
        // The caller's budget starts now, not when this call's turn comes.
        const until = this.now() + options.timeoutMs;
        return this.turn(() => this.pay(url, options, required, allowance, until));
      },
    };
  }

  /** Give up this process's slot, for a clean exit. */
  async close(): Promise<void> {
    const slot = this.slot;
    this.slot = null;
    if (slot !== null) await dropSlot(slot.dir, slot.index, slot.token).catch(() => undefined);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private warn(line: string): void {
    (this.deps.warn ?? ((l: string) => process.stderr.write(`${l}\n`)))(
      `tenjin mcp: routing fee: ${line}`,
    );
  }

  /** Calls inside one process take turns on its channel. */
  private turn<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /**
   * THE PAID PATH'S OWN 402, asked with no payment and an empty body, so the
   * paywall answers before any routing runs and nothing is charged. Kept for
   * ten minutes (an hour when the server has no paid path), so a routing call
   * is one round trip.
   */
  private async requirements(baseUrl: string): Promise<PaymentRequired | null> {
    const url = new URL(ROUTE_PAID_PATH, baseUrl).toString();
    const now = this.now();
    const cached = this.probes.get(url);
    if (cached !== undefined) {
      const ttl = cached.required === null ? ABSENT_PROBE_TTL_MS : PROBE_TTL_MS;
      if (now - cached.atMs < ttl) return cached.required;
    }
    const response = await httpRequest(url, {
      method: 'POST',
      timeoutMs: PROBE_TIMEOUT_MS,
      blockRedirects: true,
      jsonBody: {},
      ...(this.deps.fetchImpl !== undefined ? { fetchImpl: this.deps.fetchImpl } : {}),
    });
    // No answer says nothing about the server: the free path runs, and the
    // next call asks again.
    if (!response.ok) return null;
    let required: PaymentRequired | null = null;
    if (response.status === 402) {
      try {
        const parsed = reader.getPaymentRequiredResponse(
          (name) => response.header(name),
          response.json,
        );
        if (routingPolicy(parsed.x402Version, parsed.accepts).length > 0) required = parsed;
      } catch {
        required = null;
      }
    }
    this.probes.set(url, { atMs: now, required });
    await writeFeeState(this.deps.dataDir, {
      paidPath: required === null ? 'absent' : 'available',
      checkedAtMs: now,
    }).catch(() => undefined);
    return required;
  }

  /** ONE PAID CALL on this process's slot, inside the caller's budget. */
  private async pay(
    url: string,
    options: HttpRequestOptions,
    required: PaymentRequired,
    allowance: bigint,
    until: number,
  ): Promise<HttpResult> {
    const slot = await this.slotFor(await this.signer());
    if (until - this.now() <= 0) throw new RouteSkipped('busy');
    const call: Call = { slot, allowance, host: new URL(url).host, until, deposit: false };
    this.call = call;
    try {
      const accept = routingPolicy(required.x402Version, required.accepts)[0]!;
      const channelId = computeChannelId(slot.scheme.buildChannelConfig(accept), accept.network);
      const charged = async (): Promise<bigint> =>
        BigInt((await slot.storage.get(channelId.toLowerCase()))?.chargedCumulativeAmount ?? '0');
      let payload = await slot.http.createPaymentPayload(required);
      // Read after the payload: a cold start has just recovered the channel from
      // the chain, and what it had charged before is no fee of this call.
      const before = await charged();
      const remaining = until - this.now();
      // Signed but not sent: nothing leaves once the budget is spent.
      if (remaining <= 0) throw new RouteSkipped('busy');
      const timeoutMs = call.deposit
        ? Math.max(
            remaining,
            Math.min(accept.maxTimeoutSeconds * 1_000, remaining + DEPOSIT_GRACE_MS),
          )
        : remaining;
      const send = (body: typeof payload, ms: number) =>
        httpRequest(url, {
          ...options,
          timeoutMs: ms,
          headers: { ...options.headers, ...slot.http.encodePaymentSignatureHeader(body) },
        });
      let response = await send(payload, timeoutMs);
      if (response.ok) {
        const result = await this.processResult(slot, payload, response);
        if (result?.recovered === true) {
          // The SDK resynced the channel from the corrective 402: one retry with
          // a fresh payload, as the stock fetch wrapper does.
          payload = await slot.http.createPaymentPayload(required);
          response = await send(payload, Math.max(1, until - this.now()));
          if (response.ok) await this.processResult(slot, payload, response);
        }
        // A 402 the SDK did not recover from may mean new terms: ask again next time.
        if (response.ok && response.status === 402) {
          this.probes.delete(new URL(ROUTE_PAID_PATH, url).toString());
        }
      }
      const fee = (await charged()) - before;
      if (fee > 0n) {
        await appendFee(slot.dir, slot.index, { atMs: this.now(), feeAtomic: fee }, this.now());
      }
      if (response.ok && response.status < 400) await this.noteBlocked(null);
      return response;
    } finally {
      this.call = null;
    }
  }

  private async processResult(
    slot: Slot,
    payload: Awaited<ReturnType<x402HTTPClient['createPaymentPayload']>>,
    response: Extract<HttpResult, { ok: true }>,
  ): Promise<{ recovered: boolean } | null> {
    try {
      return await slot.http.processPaymentResult(
        payload,
        (name) => response.header(name),
        response.status,
      );
    } catch (err) {
      this.warn(err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  /**
   * THE GUIDE'S BEFORE-PAYMENT CHECKS, in the SDK's own hook, after its spend
   * controls and policy: the rolling allowance, and before a deposit the
   * creator allowlist and a wallet that can cover it. Each refusal throws
   * before anything is signed, and the call is not made.
   */
  private async beforePayment(requirements: PaymentRequirements): Promise<void> {
    const call = this.call;
    if (call === null) throw new RouteSkipped('no_call');
    const { slot } = call;
    if ((await feesInWindowFor(slot.dir, this.now())) + ROUTING_FEE_ATOMIC > call.allowance) {
      throw new RouteSkipped('allowance');
    }
    const channelId = computeChannelId(
      slot.scheme.buildChannelConfig(requirements),
      requirements.network,
    );
    const known = await slot.storage.get(channelId.toLowerCase());
    const credit =
      known === undefined
        ? 0n
        : BigInt(known.balance ?? '0') - BigInt(known.chargedCumulativeAmount ?? '0');
    if (credit >= BigInt(requirements.amount)) return;
    call.deposit = true;
    if (!creatorAllowed(await this.deps.policy(), call.host)) {
      await this.noteBlocked('not_allowlisted');
      throw new RouteSkipped('not_allowlisted');
    }
    const left = call.until - this.now();
    if (left <= 0) throw new RouteSkipped('busy');
    const wallet = await this.deps.walletBalance(slot.payer, Math.min(BALANCE_TIMEOUT_MS, left));
    if (wallet !== null && wallet < CHANNEL_DEPOSIT_ATOMIC) {
      await this.noteBlocked('wallet_low', wallet);
      throw new RouteSkipped('wallet_low');
    }
  }

  /**
   * THE WALLET, unlocked without a prompt. One that cannot be (no passphrase
   * in the environment or the OS credential store) pays nothing, and paying is
   * paused with a notice that says how to unlock it.
   */
  private async signer(): Promise<ClientEvmSigner> {
    let signer: TenjinSigner;
    try {
      signer = await this.deps.getSigner();
    } catch (err) {
      this.warn(err instanceof Error ? err.message : String(err));
      await this.noteBlocked('wallet_locked');
      throw new RouteSkipped('wallet_locked');
    }
    return toClientEvmSigner(
      {
        address: signer.address,
        signTypedData: (message) => signer.signTypedData(message as unknown as TypedDataDefinition),
      },
      this.deps.readContract !== undefined ? { readContract: this.deps.readContract } : undefined,
    );
  }

  /**
   * THIS PROCESS'S SLOT for the wallet in use: the one it holds while its lease
   * is still its own, else the first free one. A replaced wallet gets a slot of
   * its own, and its old channels stay in its old folder.
   */
  private async slotFor(signer: ClientEvmSigner): Promise<Slot> {
    const payer = signer.address.toLowerCase() as `0x${string}`;
    const held = this.slot;
    if (
      held !== null &&
      held.payer === payer &&
      (await holdsSlot(held.dir, held.index, held.token))
    ) {
      return held;
    }
    if (held !== null) await this.close();
    const dir = payerDir(this.deps.dataDir, payer);
    const pid = this.deps.pid ?? process.pid;
    const isAlive = this.deps.isAlive ?? processAlive;
    for (let index = 0; index < MAX_SLOTS; index++) {
      const token = await takeSlot(dir, index, pid, isAlive);
      if (token === null) continue;
      const storage = new FileClientChannelStorage({ directory: dir });
      const scheme = new BatchSettlementEvmScheme(signer, {
        salt: slotSalt(index),
        storage,
        depositPolicy: { depositMultiplier: DEPOSIT_MULTIPLIER },
        // The most the spend cap allows (cap × multiplier, $0.25), not the
        // server's minimum hint: a deposit is an on-chain settlement, so fewer
        // and larger is faster for the user.
        depositStrategy: ({ maxDeposit }) => maxDeposit,
      });
      const client = new x402Client()
        .register('eip155:*', scheme)
        .registerPolicy(routingPolicy)
        .setSpendControls({ maxAmountPerPayment: ROUTING_SPEND_CAP })
        .onBeforePaymentCreation(async ({ selectedRequirements }) => {
          await this.beforePayment(selectedRequirements);
        });
      this.slot = {
        payer,
        index,
        token,
        dir,
        storage,
        scheme,
        http: new x402HTTPClient(client),
      };
      await writeFeeState(this.deps.dataDir, { payer }).catch(() => undefined);
      return this.slot;
    }
    throw new RouteSkipped('no_slot');
  }

  private async noteBlocked(blocked: PayBlocked | null, walletAtomic?: bigint): Promise<void> {
    await writeFeeState(this.deps.dataDir, {
      blocked,
      ...(walletAtomic !== undefined ? { walletBalanceAtomic: walletAtomic.toString() } : {}),
    }).catch(() => undefined);
  }
}
