import { randomUUID } from 'node:crypto';
import { createPublicClient, http, type TypedDataDefinition } from 'viem';
import { x402Client, x402HTTPClient, type PaymentPolicy } from '@x402/core/client';
import { toClientEvmSigner, type ClientEvmSigner } from '@x402/evm';
import {
  BatchSettlementEvmScheme,
  type BatchSettlementDepositStrategyContext,
} from '@x402/evm/batch-settlement/client';
import { FileClientChannelStorage } from '@x402/evm/batch-settlement/client/file-storage';
import { wrapFetchWithPayment } from '@x402/fetch';
import { httpRequest, type HttpRequestOptions, type HttpResult } from '../lib/http';
import type { SpendPolicy } from '../lib/policy';
import { releaseUnchargedExposure, type SpendAuthorizer } from '../lib/wallet/spend';
import type { TenjinSigner } from '../lib/wallet/provider';
import { canonicalUsdcOnly } from '../lib/x402-pay';
import {
  CHANNEL_BUSY,
  isUnreachable,
  PAID_PATH_ABSENT,
  PAYMENT_FAILED,
  DEADLINE_AFTER_PAYMENT_SENT,
  RouteSkipped,
  type DecisionRoute,
} from './decision';
import { CliError } from '../lib/errors';
import { DEPOSIT_GATE_TIMEOUT_MS, GATE_TIMEOUT_MS } from './gate';
import {
  CHANNEL_DEPOSIT_ATOMIC,
  feeRefusal,
  MIN_DEPOSIT_ATOMIC,
  payerDir,
  refusedWhy,
  ROUTE_PAID_PATH,
  ROUTING_FEE_ATOMIC,
} from './fee';
import { readRouterMemo, writeRouterMemo } from './router-memo';

/**
 * THE ROUTING FEE, PAID THE WAY THE SDK'S OWN CLIENT PAYS. It runs inside
 * `tenjin mcp`, never in a hook. The user approved it with the automatic spend
 * limits at install, which name it, and every deposit counts against them.
 *
 * The shape is the x402 guide's "MCP server with x402": a local stdio MCP
 * server whose tool calls an HTTP API through `wrapFetchWithPayment` over an
 * `x402Client` with a `BatchSettlementEvmScheme` the wallet signs for. The
 * stock wrapper sends the call, reads the 402, builds the payment (with an
 * inline deposit when the channel cannot cover the fee), sends it, runs
 * `processPaymentResult` and retries once after a recovery. The channel lives
 * in the SDK's `FileClientChannelStorage`. Nothing here builds a payload, a
 * header or a channel total by hand.
 *
 * What is Tenjin's own, because the SDK has no equivalent:
 *
 * - ONE CHANNEL PER WALLET, in the SDK's file storage under the wallet's own
 *   folder, with the SDK's default salt, so every `tenjin mcp` process on the
 *   machine finds the same channel. Calls inside a process take turns on it.
 *   Two sessions paying at the same moment meet the server's refusal of a
 *   second payment in flight on one channel (`channel_busy`): that call takes
 *   the free path. A stale total after such a meeting is the SDK's to resync
 *   from the corrective 402, and a cumulative voucher cannot charge twice.
 * - A DEPOSIT IS AN AUTOMATIC PAYMENT. The SDK's `depositStrategy` sizes it
 *   and reserves it through the local spend authorizer, so it counts against
 *   the per-call limit, the rolling daily budget and the creator allowlist
 *   like any other; it counts from the moment it is sent, and only an
 *   answered 4xx or 5xx gives it back. The deposit is the spend: each fee
 *   paid from it gets only the per-payment checks (the per-call limit, the
 *   allowlist, an explicit zero daily limit) and never counts again.
 * - THE TIMEOUT. The wrapper runs inside `httpRequest`, whose deadline is the
 *   caller's, and the SDK's chain reads and the wallet read are each cut at
 *   what is left of it, so a leg returns inside the hook's 5 s. A call that
 *   carries a deposit gets {@link DEPOSIT_GATE_TIMEOUT_MS} in place of the
 *   gate's 3.5 s. A payment already sent when the time runs out is not cut:
 *   the call returns, and the request finishes in the background
 *   ({@link DETACHED_CEILING_MS} at most) so the SDK's channel records it; a
 *   deposit in it was counted in the spend ledger when it was sent.
 * - THE FREE PATH. A call this cannot pay (a refusal above, a failed or
 *   refused payment, a server error) throws `RouteSkipped` with the reason,
 *   and the caller sends it to the free path. The server is asked before the
 *   wallet is unlocked, so a server with no paid path (the fee off) costs no
 *   unlock and no notice; it is remembered in the machine's `router-memo`
 *   for an hour, or until the free path answers `fee_required`, so each call
 *   is not a wasted round trip.
 *
 * Left upstream, as cent-level papercuts: the SDK exports `ErrChannelBusy`
 * only from its server entry, and its fetch wrapper rewraps a hook's error as
 * a plain `Error`, so the reason rides on the call instead.
 */

/**
 * THE SDK'S PER-PAYMENT CAP for the routing fee, in place of its $1 default.
 * The SDK bounds each deposit by this cap times `depositMultiplier`, so the
 * two together are the largest deposit: $0.05 × 5 = $0.25
 * ({@link CHANNEL_DEPOSIT_ATOMIC}). The exact fee is the payment policy's to hold.
 */
export const ROUTING_SPEND_CAP = '$0.05';
/** The SDK's default multiplier, spelled out because the deposit is cap × it. */
export const DEPOSIT_MULTIPLIER = 5;

/** A deposit call's budget past the caller's: the hook leg's rest. */
const DEPOSIT_EXTRA_MS = DEPOSIT_GATE_TIMEOUT_MS - GATE_TIMEOUT_MS;
/** How long a paid request still out at its call's deadline may run on. */
export const DETACHED_CEILING_MS = 15_000;

/** A server that answers no paid path is asked again after an hour. */
const ABSENT_TTL_MS = 60 * 60_000;
/** The wallet balance read before a deposit, inside the caller's budget.
 *  Base's public RPC answered `balanceOf` in 0.16 to 0.26 s. */
export const BALANCE_TIMEOUT_MS = 1_000;
/**
 * THE SDK'S CHAIN READS: `recoverChannel` on a process's first call and the
 * recovery after a corrective 402. Bounded like the wallet read, with no
 * retries and never past the call's own budget, so a slow RPC costs the call
 * its routing rather than holding the prompt.
 */
export const RPC_TIMEOUT_MS = 2_000;

/** A chain read with its own timeout, in milliseconds. */
export type ChainRead = (
  args: Parameters<NonNullable<ClientEvmSigner['readContract']>>[0],
  timeoutMs: number,
) => Promise<unknown>;

/** The production {@link ChainRead}: one RPC request, no retry. */
export function chainReader(rpcUrl: string, fetchFn?: typeof fetch): ChainRead {
  return (args, timeoutMs) =>
    createPublicClient({
      transport: http(rpcUrl, {
        timeout: timeoutMs,
        retryCount: 0,
        ...(fetchFn !== undefined ? { fetchFn } : {}),
      }),
    }).readContract(args as Parameters<ReturnType<typeof createPublicClient>['readContract']>[0]);
}

export interface RoutingPayerDeps {
  dataDir: string;
  /** The wallet signer, unlocked without a prompt; it signs deposits and vouchers. */
  getSigner: () => Promise<TenjinSigner>;
  /** The spend policy, read fresh per deposit. */
  policy: () => Promise<SpendPolicy>;
  /** The local spend authorizer over that policy (`createLocalSpendAuthorizer`). */
  authorizer: (policy: SpendPolicy) => SpendAuthorizer;
  /** The wallet's USDC balance, or null when it cannot be read. */
  walletBalance: (address: string, timeoutMs: number) => Promise<bigint | null>;
  /** Chain reads for the SDK's channel recovery. */
  readContract?: ChainRead;
  fetchImpl?: typeof fetch;
  now?: () => number;
  warn?: (line: string) => void;
}

interface Channel {
  payer: `0x${string}`;
  http: x402HTTPClient;
}

/** A deposit the strategy reserved, and how far its paid request got. */
interface Deposit {
  authorizer: SpendAuthorizer;
  reservationId: string | undefined;
  amountAtomic: bigint;
  /** The ledger key its exposure is committed under when it is sent. */
  key: string;
  state: 'signed' | 'sent' | 'settled' | 'refused';
}

/** What the call in progress brings to the SDK's callbacks. */
interface Call {
  host: string;
  /** When the caller's budget ends; later once the SDK sizes a deposit. */
  until: number;
  /** The SDK sized a deposit for this call. */
  deposit?: boolean;
  /** Its payment was out when its budget ended: it finishes in the background. */
  detached?: boolean;
  /** Its budget ended before anything was paid. */
  expired?: boolean;
  /** What `httpRequest` returned. */
  result?: HttpResult;
  /** Why a check refused to pay; the wrapper rethrows the error as its own. */
  skipped?: string;
  /** Whether a request carrying a payment went out. */
  paid: boolean;
  /** Whether the router answered any request of this call. */
  answered: boolean;
  /** The wallet's channel, once the server asked for a payment. */
  channel?: Channel;
  deposits: Deposit[];
}

/**
 * THE PAYMENT POLICY, the guide's check of the requirement before signing:
 * `batch-settlement` in canonical USDC on Base, at exactly the $0.003 fee.
 * The server's `payTo` is not pinned: the client ships no treasury address, and
 * what the user approved is the fee, which this holds exactly.
 */
const routingPolicy: PaymentPolicy = (version, requirements) =>
  canonicalUsdcOnly(version, requirements).filter(
    (r) => r.scheme === 'batch-settlement' && r.amount === ROUTING_FEE_ATOMIC.toString(),
  );

/**
 * The server's refusal of a second payment in flight on one channel. The SDK
 * names it `ErrChannelBusy` but exports it only from its server entry.
 */
const CHANNEL_BUSY_ERROR = 'invalid_batch_settlement_evm_channel_busy';

export class RoutingPayer {
  private channel: Channel | null = null;
  private call: Call | null = null;
  /** The call `pay` ran last, for its one diagnostic line. */
  private last: Call | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  /** A detached request still finishing; the next call waits for it. */
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly deps: RoutingPayerDeps) {}

  /**
   * The paid path for one call, or null for the free path for an hour after
   * the server answered no paid path. That answer is the machine's `router-memo`,
   * so every `tenjin mcp` process shares it.
   */
  async routeFor(baseUrl: string): Promise<DecisionRoute | null> {
    if (await readRouterMemo(this.deps.dataDir, 'paid-path-absent', baseUrl, this.now())) {
      return null;
    }
    return {
      path: ROUTE_PAID_PATH,
      send: (url, options) => {
        // The caller's budget starts now, not when this call's turn comes.
        const sent = this.now();
        const until = sent + options.timeoutMs;
        return this.turn(() => this.noted(sent, () => this.pay(url, options, until)), until, sent);
      },
    };
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private warn(line: string): void {
    (this.deps.warn ?? ((l: string) => process.stderr.write(`${l}\n`)))(
      `tenjin mcp: routing fee: ${line}`,
    );
  }

  /** Calls inside one process take turns on its channel, a detached
   *  request's tail included, so none starts from a stale channel. A queued
   *  call gives up at its own deadline (`busy`) rather than wait out the
   *  call ahead of it, and then never starts. The deadline covers the wait
   *  only: once a call runs, its own budget applies. */
  private turn<T>(run: () => Promise<T>, until: number, sent: number): Promise<T> {
    let gaveUp = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const go = () => {
      if (gaveUp) return Promise.reject(new RouteSkipped('busy'));
      // Its turn came: from here its own budget, which a deposit lengthens, applies.
      clearTimeout(timer);
      return run();
    };
    const next = this.queue.then(go, go);
    this.queue = next.catch(() => undefined).then(() => this.tail);
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => {
          gaveUp = true;
          // It never ran, so `noted` cannot say it: its one line is here.
          this.note('busy', null, sent);
          reject(new RouteSkipped('busy'));
        },
        Math.max(0, until - this.now()),
      );
    });
    return Promise.race([next, deadline]).finally(() => clearTimeout(timer));
  }

  /** One stderr line for a call the paid path did not answer; a detached
   *  one says it when its request ends. */
  private async noted(sent: number, run: () => Promise<HttpResult>): Promise<HttpResult> {
    this.last = null;
    try {
      return await run();
    } catch (err) {
      // Set by `run`, which the narrowing above cannot see.
      const call = this.last as Call | null;
      if (err instanceof RouteSkipped && call?.detached !== true) this.note(err.why, call, sent);
      throw err;
    }
  }

  private note(why: string, call: Call | null, sent: number, late?: string): void {
    const result = call?.result;
    const cause =
      late ??
      (call === null
        ? 'queued'
        : call.skipped !== undefined
          ? 'refused'
          : result === undefined
            ? 'none'
            : result.ok
              ? `http ${result.status}`
              : call.expired === true
                ? 'timeout'
                : result.kind);
    const stage =
      call === null
        ? 'queue'
        : call.paid
          ? call.deposit === true
            ? 'deposit'
            : 'voucher'
          : result?.ok === true
            ? 'answer'
            : 'challenge';
    this.warn(`${why} (cause ${cause}, ${this.now() - sent}ms, stage ${stage})`);
  }

  /**
   * THE DEADLINE CUTS NOTHING ALREADY PAID. Before a payment goes out, the
   * call's budget aborts it as always. Once one is out, aborting would lose
   * the answer that records it (the SDK's channel and the ledger) while the
   * server settles it anyway, so the call returns at its deadline and the
   * request runs on here, up to {@link DETACHED_CEILING_MS}; the next call
   * waits for it. `httpRequest`'s own timeout is the outer bound.
   */
  private detachable(call: Call, sent: number, run: typeof fetch): typeof fetch {
    return (input, init) => {
      const caller = init?.signal ?? undefined;
      const own = new AbortController();
      const work = run(input, { ...init, signal: own.signal });
      return new Promise<Response>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const settle = () => {
          clearTimeout(timer);
          caller?.removeEventListener('abort', onAbort);
        };
        const stop = (reason: unknown) => {
          settle();
          if (!call.paid) return own.abort(reason);
          call.detached = true;
          this.tail = this.finishDetached(call, sent, work, own);
          reject(reason);
        };
        const onAbort = () => stop(caller?.reason);
        // The call's own budget, which a deposit lengthens while it runs.
        const check = () => {
          const left = call.until - this.now();
          if (left > 0) timer = setTimeout(check, left);
          else {
            call.expired = true;
            stop(new DOMException('The routing call ran out of time.', 'TimeoutError'));
          }
        };
        check();
        if (caller?.aborted === true) onAbort();
        else caller?.addEventListener('abort', onAbort);
        work.then(
          (response) => {
            settle();
            // A detached request's answer is drained by `finishDetached`, so
            // its body is left unlocked.
            resolve(call.detached === true ? response : bounded(response, caller, own));
          },
          (err: unknown) => {
            settle();
            reject(err);
          },
        );
      });
    };
  }

  /** The detached request's end: its answer read and dropped, its one line. */
  private async finishDetached(
    call: Call,
    sent: number,
    work: Promise<Response>,
    own: AbortController,
  ): Promise<void> {
    const ceiling = setTimeout(() => own.abort(), DETACHED_CEILING_MS);
    ceiling.unref?.();
    try {
      const response = await work;
      await response.arrayBuffer().catch(() => undefined);
      const why = response.ok ? DEADLINE_AFTER_PAYMENT_SENT : PAYMENT_FAILED;
      this.note(why, call, sent, `late http ${response.status}`);
    } catch {
      this.note(PAYMENT_FAILED, call, sent, own.signal.aborted ? 'late ceiling' : 'late network');
    } finally {
      clearTimeout(ceiling);
    }
  }

  /**
   * ONE PAID CALL on the wallet's channel, inside the caller's budget. The
   * server's 402 becomes the stock wrapper's first answer, so asking before
   * the unlock adds no round trip.
   */
  private async pay(url: string, options: HttpRequestOptions, until: number): Promise<HttpResult> {
    if (until - this.now() <= 0) throw new RouteSkipped('busy');
    const call: Call = {
      host: new URL(url).host,
      until,
      paid: false,
      answered: false,
      deposits: [],
    };
    const base = options.fetchImpl ?? this.deps.fetchImpl ?? fetch;
    const askFirst: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      let asked: Response | undefined = await base(request.clone());
      call.answered = true;
      if (asked.status !== 402) return asked;
      try {
        // Each fee gets the per-payment checks (`feeRefusal`) before the
        // wallet is even unlocked, a voucher from a funded channel included.
        const refused = feeRefusal(await this.deps.policy(), call.host);
        if (refused !== null) throw new RouteSkipped(refused);
        call.channel = this.channelFor(await this.signer());
        if (until - this.now() <= 0) throw new RouteSkipped('busy');
      } catch (err) {
        if (err instanceof RouteSkipped) call.skipped = err.why;
        throw err;
      }
      const watched: typeof fetch = async (input, init) => {
        const request = new Request(input, init);
        const paying = request.headers.has('PAYMENT-SIGNATURE') && !request.signal.aborted;
        if (!paying && asked !== undefined) {
          const first = asked;
          asked = undefined;
          return first;
        }
        const deposit = paying ? call.deposits.find((d) => d.state === 'signed') : undefined;
        if (paying) call.paid = true;
        // FAIL CLOSED: the deposit counts from the moment it is sent, so a lost
        // answer or a process killed mid-call leaves it counted.
        if (deposit !== undefined) await this.commitDeposit(deposit);
        const response = await base(request);
        // Only an answered error proves it did not settle: the server settles
        // nothing on a 4xx or 5xx.
        if (deposit !== undefined && response.status >= 400) await this.releaseDeposit(deposit);
        else if (deposit !== undefined) deposit.state = 'settled';
        return response;
      };
      return wrapFetchWithPayment(watched, call.channel.http)(request);
    };
    this.call = call;
    this.last = call;
    let response: HttpResult;
    try {
      response = call.result = await httpRequest(url, {
        ...options,
        // The outer bound: a deposit's budget, which a call without one never reaches.
        timeoutMs: until + DEPOSIT_EXTRA_MS - this.now(),
        fetchImpl: this.detachable(call, until - options.timeoutMs, askFirst),
      });
    } finally {
      this.call = null;
      await this.settleDeposits(call);
    }
    if (call.skipped !== undefined) throw new RouteSkipped(call.skipped);
    // The router could not be reached: the free path is on the same host, so
    // the call ends as that transport failure. A timeout or a reset socket
    // takes the free path below, as any other unanswered call does.
    if (!response.ok && !call.answered && isUnreachable(response)) {
      throw new RouteSkipped(PAYMENT_FAILED, response);
    }
    // No answer, a failed payment or a server error: the free path takes it.
    if (!response.ok) {
      // A payment went out and the call's time ended before its answer did,
      // detached or with the body still arriving: no fault, it was charged.
      const late = call.detached === true || (call.paid && response.kind === 'timeout');
      throw new RouteSkipped(late ? DEADLINE_AFTER_PAYMENT_SENT : PAYMENT_FAILED);
    }
    if (!call.paid && response.status === 404) {
      // The server has no paid path: the free path, asked again in an hour.
      await writeRouterMemo(this.deps.dataDir, 'paid-path-absent', url, {
        now: this.now(),
        ttlMs: ABSENT_TTL_MS,
      });
      throw new RouteSkipped(PAID_PATH_ABSENT);
    }
    // Another session's call was in flight on the channel: nothing was
    // charged, and this call takes the free path.
    if (response.status === 402) {
      throw new RouteSkipped(
        call.channel !== undefined && paymentError(call.channel, response) === CHANNEL_BUSY_ERROR
          ? CHANNEL_BUSY
          : PAYMENT_FAILED,
      );
    }
    if (response.status >= 500) throw new RouteSkipped(PAYMENT_FAILED);
    return response;
  }

  /**
   * EACH RESERVED DEPOSIT ENDS IN THE LEDGER. It is committed as it is sent,
   * so a lost answer leaves it counted whether or not it landed (an over-count
   * of a few cents, never an under-count), and the SDK resyncs the channel on
   * the next call. An answered 4xx or 5xx gives exactly that exposure back. A
   * deposit signed but never sent releases its reservation (`settleDeposits`).
   */
  private async commitDeposit(d: Deposit): Promise<void> {
    // A ledger that cannot take the write stops the request: it is not sent.
    await d.authorizer.commit(d.reservationId, d.amountAtomic, { nonce: d.key });
    d.state = 'sent';
  }

  private async releaseDeposit(d: Deposit): Promise<void> {
    d.state = 'refused';
    const released = await releaseUnchargedExposure(this.deps.dataDir, d.key, {
      now: () => this.now(),
    });
    if (released === null) this.ledgerWarn(new Error('the refused deposit stays counted'));
  }

  private async settleDeposits(call: Call): Promise<void> {
    for (const d of call.deposits.filter((x) => x.state === 'signed')) {
      await d.authorizer.release(d.reservationId).catch((err: unknown) => this.ledgerWarn(err));
    }
  }

  private ledgerWarn(err: unknown): void {
    this.warn(`spend ledger: ${err instanceof Error ? err.message : String(err)}`);
  }

  /** Refuse to pay this call: nothing is signed, and the call is not made. */
  private refuse(why: string): never {
    if (this.call !== null) this.call.skipped = why;
    throw new RouteSkipped(why);
  }

  /**
   * THE SDK'S `depositStrategy`, called right before it signs a deposit: the
   * size, and the refusals. The SDK's ceiling ($0.25) comes down to a smaller
   * per-call limit while that still covers {@link MIN_DEPOSIT_ATOMIC}; a wallet
   * that cannot cover it, or a spend the authorizer denies (the daily budget,
   * the creator allowlist), refuses the deposit and the call is not paid.
   */
  private async deposit(ctx: BatchSettlementDepositStrategyContext): Promise<bigint> {
    const call = this.call;
    if (call === null) this.refuse('no_call');
    const policy = await this.deps.policy();
    const ceiling = BigInt(ctx.maxDeposit ?? CHANNEL_DEPOSIT_ATOMIC.toString());
    const amount = ceiling < policy.maxAutoSpendAtomic ? ceiling : policy.maxAutoSpendAtomic;
    const floor = BigInt(ctx.minimumDepositAmount);
    if (amount < (floor > MIN_DEPOSIT_ATOMIC ? floor : MIN_DEPOSIT_ATOMIC)) {
      this.refuse('limit_below_deposit');
    }
    const left = call.until - this.now();
    if (left <= 0) this.refuse('busy');
    const payer = this.channel!.payer;
    const wallet = await this.deps.walletBalance(payer, Math.min(BALANCE_TIMEOUT_MS, left));
    if (wallet !== null && wallet < amount) this.refuse('wallet_low');
    const authorizer = this.deps.authorizer(policy);
    const auth = await authorizer.authorize({
      mode: 'automatic',
      amountAtomic: amount,
      creator: call.host,
    });
    if (auth.decision !== 'allow') {
      await authorizer.release(auth.reservationId);
      this.refuse(refusedWhy(auth.reason));
    }
    call.deposits.push({
      authorizer,
      reservationId: auth.reservationId,
      amountAtomic: amount,
      key: `routing-deposit:${auth.reservationId ?? randomUUID()}`,
      state: 'signed',
    });
    return amount;
  }

  /**
   * THE WALLET, unlocked without a prompt. One that cannot be (no passphrase
   * in the environment or the OS credential store) pays nothing.
   */
  private async signer(): Promise<ClientEvmSigner> {
    let signer: TenjinSigner;
    try {
      signer = await this.deps.getSigner();
    } catch (err) {
      this.warn(err instanceof Error ? err.message : String(err));
      const missing = err instanceof CliError && err.code === 'WALLET_MISSING';
      throw new RouteSkipped(missing ? 'no_wallet' : 'wallet_locked');
    }
    return toClientEvmSigner(
      {
        address: signer.address,
        // Nothing is signed outside a call: a detached request finishes and
        // starts no retry, whose answer nobody would read.
        signTypedData: (message) =>
          this.call === null
            ? Promise.reject(new RouteSkipped('busy'))
            : signer.signTypedData(message as unknown as TypedDataDefinition),
      },
      this.deps.readContract !== undefined
        ? { readContract: (args) => this.chainRead(this.deps.readContract!, args) }
        : undefined,
    );
  }

  /**
   * ONE SDK CHAIN READ, inside {@link RPC_TIMEOUT_MS} and the call's budget.
   * One that fails or times out skips the call before anything is sent.
   */
  private async chainRead(read: ChainRead, args: Parameters<ChainRead>[0]): Promise<unknown> {
    const left = (this.call?.until ?? Infinity) - this.now();
    if (left <= 0) this.refuse('busy');
    try {
      return await read(args, Math.min(RPC_TIMEOUT_MS, left));
    } catch (err) {
      this.warn(`chain read: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
      this.refuse('chain_unreadable');
    }
  }

  /**
   * THE WALLET'S ONE CHANNEL: the stock client over the SDK's file storage in
   * the wallet's folder, built once per wallet. A replaced wallet gets its own
   * folder, and its old channel stays in the old one.
   */
  private channelFor(signer: ClientEvmSigner): Channel {
    const payer = signer.address.toLowerCase() as `0x${string}`;
    if (this.channel !== null && this.channel.payer === payer) return this.channel;
    const dir = payerDir(this.deps.dataDir, payer);
    const scheme = new BatchSettlementEvmScheme(signer, {
      storage: new FileClientChannelStorage({ directory: dir }),
      depositPolicy: { depositMultiplier: DEPOSIT_MULTIPLIER },
      depositStrategy: (ctx) => {
        // A DEPOSIT GETS THE LONGER BUDGET, once per call.
        if (this.call !== null && this.call.deposit !== true) {
          this.call.deposit = true;
          this.call.until += DEPOSIT_EXTRA_MS;
        }
        return this.deposit(ctx);
      },
    });
    const client = new x402Client()
      .register('eip155:*', scheme)
      .registerPolicy(routingPolicy)
      .setSpendControls({ maxAmountPerPayment: ROUTING_SPEND_CAP });
    this.channel = { payer, http: new x402HTTPClient(client) };
    return this.channel;
  }
}

/**
 * THE BODY READ STAYS BOUNDED once the headers are in: the caller's abort
 * still reaches it. Piped here, under `own`, rather than left to the fetch's
 * own signal, whose link to `own` is weak and can be collected mid-read.
 */
function bounded(
  response: Response,
  caller: AbortSignal | undefined,
  own: AbortController,
): Response {
  if (caller === undefined || response.body === null) return response;
  if (caller.aborted) own.abort(caller.reason);
  else caller.addEventListener('abort', () => own.abort(caller.reason), { once: true });
  const body = response.body.pipeThrough(new TransformStream(), { signal: own.signal });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/** The `error` a 402's payment-required header carries, if any. */
function paymentError(
  channel: Channel,
  response: Extract<HttpResult, { ok: true }>,
): string | undefined {
  try {
    return channel.http.getPaymentRequiredResponse((name) => response.header(name), response.json)
      .error;
  } catch {
    return undefined;
  }
}
