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
import type { PolicyReason, SpendPolicy } from '../lib/policy';
import type { SpendAuthorizer } from '../lib/wallet/spend';
import type { TenjinSigner } from '../lib/wallet/provider';
import { canonicalUsdcOnly } from '../lib/x402-pay';
import {
  CHANNEL_BUSY,
  PAID_PATH_ABSENT,
  PAYMENT_FAILED,
  RouteSkipped,
  type DecisionRoute,
} from './decision';
import { CliError } from '../lib/errors';
import {
  CHANNEL_DEPOSIT_ATOMIC,
  MIN_DEPOSIT_ATOMIC,
  payerDir,
  ROUTE_PAID_PATH,
  ROUTING_FEE_ATOMIC,
} from './fee';

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
 *   like any other; it is committed once it settles and released when it is
 *   refused. The fee itself comes out of the deposit and is not counted again.
 * - THE TIMEOUT. The wrapper runs inside `httpRequest`, whose deadline is the
 *   caller's, and the SDK's chain reads and the wallet read are each cut at
 *   what is left of it.
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
  state: 'signed' | 'sent' | 'settled' | 'refused';
}

/** What the call in progress brings to the SDK's callbacks. */
interface Call {
  host: string;
  /** When the caller's budget ends. */
  until: number;
  /** Why a check refused to pay; the wrapper rethrows the error as its own. */
  skipped?: string;
  /** Whether a request carrying a payment went out. */
  paid: boolean;
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

/** A spend refusal, as the reason the call was not paid. */
const REFUSED: Partial<Record<PolicyReason, string>> = {
  not_allowlisted: 'not_allowlisted',
  session_budget_exceeded: 'budget_reached',
  above_auto_spend: 'limit_below_deposit',
};

export class RoutingPayer {
  /** Paid-path URLs that answered no paid path, until when. */
  private readonly absent = new Map<string, number>();
  private channel: Channel | null = null;
  private call: Call | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: RoutingPayerDeps) {}

  /**
   * The paid path for one call, or null for the free path for an hour after
   * the server answered no paid path.
   */
  async routeFor(baseUrl: string): Promise<DecisionRoute | null> {
    const probe = new URL(ROUTE_PAID_PATH, baseUrl).toString();
    if ((this.absent.get(probe) ?? 0) > this.now()) return null;
    return {
      path: ROUTE_PAID_PATH,
      send: (url, options) => {
        // The caller's budget starts now, not when this call's turn comes.
        const until = this.now() + options.timeoutMs;
        return this.turn(() => this.pay(url, options, until));
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

  /** Calls inside one process take turns on its channel. */
  private turn<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** ONE PAID CALL on the wallet's channel, inside the caller's budget. */
  private async pay(url: string, options: HttpRequestOptions, until: number): Promise<HttpResult> {
    const signer = await this.signer();
    if (until - this.now() <= 0) throw new RouteSkipped('busy');
    const channel = this.channelFor(signer);
    const call: Call = { host: new URL(url).host, until, paid: false, deposits: [] };
    const base = options.fetchImpl ?? this.deps.fetchImpl ?? fetch;
    const watched: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const paying = request.headers.has('PAYMENT-SIGNATURE') && !request.signal.aborted;
      const deposit = paying ? call.deposits.find((d) => d.state === 'signed') : undefined;
      if (paying) call.paid = true;
      if (deposit !== undefined) deposit.state = 'sent';
      const response = await base(request);
      if (deposit !== undefined) {
        deposit.state =
          response.status < 400 && response.headers.has('PAYMENT-RESPONSE') ? 'settled' : 'refused';
      }
      return response;
    };
    this.call = call;
    let response: HttpResult;
    try {
      response = await httpRequest(url, {
        ...options,
        timeoutMs: until - this.now(),
        fetchImpl: wrapFetchWithPayment(watched, channel.http),
      });
    } finally {
      this.call = null;
      await this.settleDeposits(call);
    }
    if (call.skipped !== undefined) throw new RouteSkipped(call.skipped);
    // No answer, a failed payment or a server error: the free path takes it.
    if (!response.ok) throw new RouteSkipped(PAYMENT_FAILED);
    if (!call.paid && response.status === 404) {
      // The server has no paid path: the free path, asked again in an hour.
      this.absent.set(new URL(ROUTE_PAID_PATH, url).toString(), this.now() + ABSENT_TTL_MS);
      throw new RouteSkipped(PAID_PATH_ABSENT);
    }
    // Another session's call was in flight on the channel: nothing was
    // charged, and this call takes the free path.
    if (response.status === 402) {
      throw new RouteSkipped(
        paymentError(channel, response) === CHANNEL_BUSY_ERROR ? CHANNEL_BUSY : PAYMENT_FAILED,
      );
    }
    if (response.status >= 500) throw new RouteSkipped(PAYMENT_FAILED);
    return response;
  }

  /**
   * EACH RESERVED DEPOSIT ENDS IN THE LEDGER: committed when it settled, and
   * when its request went out with no answer, because it may have landed;
   * released when the server refused it or it was never sent.
   */
  private async settleDeposits(call: Call): Promise<void> {
    for (const d of call.deposits) {
      try {
        if (d.state === 'settled' || d.state === 'sent') {
          await d.authorizer.commit(d.reservationId, d.amountAtomic);
        } else {
          await d.authorizer.release(d.reservationId);
        }
      } catch (err) {
        this.warn(`spend ledger: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
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
      this.refuse(REFUSED[auth.reason] ?? auth.reason);
    }
    call.deposits.push({
      authorizer,
      reservationId: auth.reservationId,
      amountAtomic: amount,
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
        signTypedData: (message) => signer.signTypedData(message as unknown as TypedDataDefinition),
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
      depositStrategy: (ctx) => this.deposit(ctx),
    });
    const client = new x402Client()
      .register('eip155:*', scheme)
      .registerPolicy(routingPolicy)
      .setSpendControls({ maxAmountPerPayment: ROUTING_SPEND_CAP });
    this.channel = { payer, http: new x402HTTPClient(client) };
    return this.channel;
  }
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
