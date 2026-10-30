import { randomUUID } from 'node:crypto';
import { createPublicClient, http, type TypedDataDefinition } from 'viem';
import { x402Client, x402HTTPClient, type PaymentPolicy } from '@x402/core/client';
import { toClientEvmSigner, type ClientEvmSigner } from '@x402/evm';
import {
  BatchSettlementEvmScheme,
  parseAnnouncedMinDeposit,
  type BatchSettlementDepositStrategyContext,
} from '@x402/evm/batch-settlement/client';
import { FileClientChannelStorage } from '@x402/evm/batch-settlement/client/file-storage';
import { wrapFetchWithPayment } from '@x402/fetch';
import { httpRequest, type HttpRequestOptions, type HttpResult } from '../lib/http';
import type { SpendPolicy } from '../lib/policy';
import { releaseUnchargedExposure, type SpendAuthorizer } from '../lib/wallet/spend';
import type { TenjinSigner } from '../lib/wallet/provider';
import { classifyUnlockError, DEFINITE_UNLOCK, type UnlockReason } from '../lib/wallet-unlock';
import { channelCredit } from './channel-credit';
import {
  acceptsFor,
  buildWarmBody,
  CHANNEL_BUSY,
  DEPOSIT_DEFERRED,
  isUnreachable,
  isWarmAnswer,
  PAYMENT_FAILED,
  DEADLINE_AFTER_PAYMENT_SENT,
  ROUTE_PAID_PATH,
  RouteSkipped,
  TOP_UP_UNAVAILABLE,
  TOPPING_UP,
  type DecisionRoute,
  type SkipFacts,
} from './decision';
import { isDefiniteBlock, type SignVerdict } from './eligibility';
import { DEPOSIT_GATE_TIMEOUT_MS, GATE_TIMEOUT_MS } from './gate';
import {
  CHANNEL_DEPOSIT_ATOMIC,
  FEE_ABOVE_CEILING,
  feeRefusal,
  MAX_CHANNEL_DEPOSIT_ATOMIC,
  payerDir,
  refusedWhy,
  ROUTING_DEPOSIT_KEY,
  ROUTING_FEE_CEILING_ATOMIC,
  routingDepositAtomic,
} from './fee';
import type { Harness } from './names';
import {
  clearRouterMemo,
  readRouterMemo,
  TOPPING_UP_MEMO_MS,
  WARM_ABSENT_MS,
  writeRouterMemo,
} from './router-memo';
import type { RouterObservation } from './router-observation';
import { quoteOf, routingOffers } from './routing-quote';
import { UNKNOWN_DETAIL, WALLET_REASONS } from './wallet-reasons';

/**
 * THE ROUTING FEE, PAID THE WAY THE SDK'S OWN CLIENT PAYS. It runs inside
 * `tenjin mcp`, never in a hook. The user approved it with the automatic spend
 * limits at install, and every deposit counts against them.
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
 * - THE QUOTE, UNDER A CEILING. The router's 402 is the only price. This pays
 *   it when it is at or below `ROUTING_FEE_CEILING_ATOMIC`, inside the SDK's
 *   per-payment cap, the deposit cap and the spend limits; a quote above the
 *   ceiling is not paid (`fee_above_ceiling`), and is read before the wallet
 *   is unlocked. Nothing else is pinned: not the payee, not the exact price.
 *   It pays only the configured router's paid route ({@link RoutingPayer.routeFor}),
 *   so the ceiling never applies to a provider's 402, which `runPay` checks
 *   against that service's own spec price. A charge below the quote (batch
 *   settlement lets the server charge less) is the SDK's to record.
 * - ONE CHANNEL PER WALLET, in the SDK's file storage under the wallet's own
 *   folder, with the SDK's default salt, so every `tenjin mcp` process on the
 *   machine finds the same channel. Calls inside a process take turns on it.
 *   Two sessions paying at the same moment meet the server's refusal of a
 *   second payment in flight on one channel (`channel_busy`): that call is
 *   skipped. A stale total after such a meeting is the SDK's to resync
 *   from the corrective 402, and a cumulative voucher cannot charge twice.
 * - A ROUTING CALL NEVER CARRIES A DEPOSIT. A prompt's hook leg
 *   has 3.5 s and a deposit settles on chain in about 5, so the channel is
 *   funded in the background instead ({@link RoutingPayer.topUpIfLow}): one
 *   `warm` call to the paid route, which the server answers in code and
 *   settles at $0, carries the deposit the stock SDK adds to it. The top-up
 *   starts when `tenjin mcp` starts on a channel that cannot cover a fee (a
 *   new one included), after a paid call leaves it so, and when a call's
 *   SDK asks for a deposit anyway. A call that meets one in flight in this
 *   process waits for it inside its own budget, since the fee is required and
 *   nothing routes without it, then pays a voucher. A router that answers
 *   `warm` with anything but its answer (an older server) has no form: for
 *   {@link WARM_ABSENT_MS} a deposit rides the next paid call, as it did
 *   before, and that call gets {@link DEPOSIT_GATE_TIMEOUT_MS}.
 * - A DEPOSIT IS AN AUTOMATIC PAYMENT. The SDK's `depositStrategy` sizes it
 *   ({@link routingDepositAtomic}: the smallest of the 402's `extra.minDeposit`,
 *   the wallet and the per-call limit, never below ten quoted fees) and
 *   reserves it through the local spend authorizer, so it counts against
 *   the per-call limit, the rolling daily budget and the creator allowlist
 *   like any other; it counts from the moment it is sent, and only an
 *   answered 4xx or 5xx gives it back. The deposit is the spend: each fee
 *   paid from it gets only the per-payment checks (the per-call limit, the
 *   allowlist, an explicit zero daily limit) and never counts again. The
 *   wallet's balance is read for it alone, so never on a leg while the
 *   router has the `warm` form.
 * - THE TIMEOUT. The wrapper runs inside `httpRequest`, whose deadline is the
 *   caller's, and the SDK's chain reads and the wallet read are each cut at
 *   what is left of it, so a leg returns inside the hook's 5 s. The top-up
 *   has its own {@link TOP_UP_TIMEOUT_MS}. A payment already sent when the
 *   time runs out is not cut: the call returns, and the request finishes in
 *   the background
 *   ({@link DETACHED_CEILING_MS} at most) so the SDK's channel records it; a
 *   deposit in it was counted in the spend ledger when it was sent.
 * - A CALL THIS CANNOT PAY (a refusal above, a failed or refused payment, a
 *   server error) throws `RouteSkipped` with the reason, and the caller skips
 *   it: the native tool runs, with no second request. The server is asked
 *   before the wallet is unlocked, so a router that charges nothing (the fee
 *   off, in development) costs no unlock and no notice.
 * - A WALLET THAT CANNOT SIGN skips with its classified reason
 *   (`classifyUnlockError`): a definite one (no wallet, a wrong or missing
 *   passphrase, a corrupt file) or an unknown one (a keychain that did not
 *   answer, an unlock still running at the call's deadline, an unclassified
 *   failure). A definite block is remembered for {@link SIGNER_RECHECK_MS}, or
 *   until `wallet.json` or the passphrase sidecar changes, so a known-wrong
 *   passphrase costs no scrypt on every prompt; once this process has seen
 *   the server ask for the fee, the call is not even sent. An unknown answer
 *   is never remembered as a block: the next call tries again.
 * - THE UNLOCK IS ONE FLIGHT, BOUNDED IN ITS WAIT, NEVER IN ITS READ. Every
 *   caller (and the prewarm) awaits the same unlock, each only up to its own
 *   call's budget less the paid call's reserve (`unlock_timeout`). Nothing
 *   here aborts the unlock or the
 *   store read under it, so an OS unlock dialog stays up, and whatever it
 *   answers is the next call's (B3).
 *
 * Left upstream, as cent-level papercuts: the SDK exports `ErrChannelBusy`
 * only from its server entry, and its fetch wrapper rewraps a hook's error as
 * a plain `Error`, so the reason rides on the call instead.
 */

/** The sign verdict before any unlock has settled, or while one runs over a stale block. */
const NOT_CHECKED: SignVerdict = {
  status: 'unknown',
  reason: 'not_checked',
  detail: UNKNOWN_DETAIL['not_checked']!,
};

/**
 * THE SDK'S PER-PAYMENT CAP for the routing fee, in place of its $1 default.
 * The SDK bounds each deposit by this cap times `depositMultiplier`, so the
 * two together are the largest deposit: $0.05 × 5 = $0.25
 * (`MAX_CHANNEL_DEPOSIT_ATOMIC`). The fee ceiling is the payment policy's to hold.
 */
export const ROUTING_SPEND_CAP = '$0.05';
/** The SDK's default multiplier, spelled out because the deposit is cap × it. */
export const DEPOSIT_MULTIPLIER = 5;

/** An inline deposit call's budget past the caller's: the hook leg's rest.
 *  Only a router with no `warm` form gets an inline deposit. */
const DEPOSIT_EXTRA_MS = DEPOSIT_GATE_TIMEOUT_MS - GATE_TIMEOUT_MS;
/** How long a paid request still out at its call's deadline may run on. */
export const DETACHED_CEILING_MS = 15_000;
/**
 * THE BACKGROUND TOP-UP'S OWN BUDGET: the 402, the wallet read and the `warm`
 * call, whose deposit waits on verify and the on-chain settle (5.0 s
 * measured on Base), with room. It is no prompt's: nothing waits on it but a
 * call that meets it, and that call only inside its own budget.
 */
export const TOP_UP_TIMEOUT_MS = 15_000;
/** How long a refused or failed top-up holds off the next, by how many in a
 *  row have failed; the last repeats. Contention backs off nothing. */
export const TOP_UP_BACKOFF_MS: readonly number[] = [30_000, 120_000, 600_000];
/**
 * A WALLET TOO LOW stops at 2 minutes: a new user funds it in the browser and
 * comes back in the same sitting. Each retry is a top-up (its 402 and the
 * balance read, and the deposit once funded), started by the first prompt
 * that needs a deposit once the wait ends, so routing resumes within about
 * 2 minutes of funding, not 10.
 */
export const WALLET_LOW_BACKOFF_MS: readonly number[] = [30_000, 120_000];

/** How long after this process last saw a 402 a wallet known not to sign
 *  sends nothing: the 402 is then certain. */
const FEE_SEEN_TTL_MS = 60 * 60_000;
/**
 * HOW LONG A DEFINITE SIGN BLOCK IS BELIEVED without unlocking again, unless
 * the wallet file or the passphrase sidecar changes first (`unlockStamp`): a
 * `tenjin wallet repair` is picked up at once, anything else within a minute.
 */
export const SIGNER_RECHECK_MS = 60_000;
/**
 * THE PAID CALL'S SHARE OF ITS BUDGET: a call waiting on an unlock stops
 * waiting this long before its budget ends, since an unlock that lands later
 * leaves no time to sign and send the payment and read its answer.
 */
export const PAID_CALL_RESERVE_MS = 1_000;
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
  /** The timer functions the payer arms; the globals unless a test injects its own. */
  timers?: Pick<typeof globalThis, 'setTimeout' | 'clearTimeout'>;
  warn?: (line: string) => void;
  /** Called only when the sign or routing verdict changes (status+reason). */
  observe?: (u: PayerObservation) => void;
  /** wallet.json + sidecar mtimes (`unlockStamp(readWalletFacts(...))`); a change re-checks a memoized block at once. */
  unlockStamp?: () => Promise<string>;
  /** The host this `tenjin mcp` serves, named on the top-up's `warm` call; absent is Claude Code. */
  harness?: Harness;
}

/**
 * WHAT THE PAYER LEARNED, for `tenjin mcp`'s live observation (P4): the
 * latest sign verdict (with the address once one unlocked) and the latest
 * routing outcome. Never a passphrase, a key or a store's output.
 */
export interface PayerObservation {
  sign?: RouterObservation['sign'];
  routing?: RouterObservation['routing'];
  address?: string;
}

/** The last settled unlock's verdict, when it settled, and the stamp it saw. */
interface SignMemo {
  verdict: SignVerdict;
  at: number;
  stamp: string | null;
  address?: string;
}

/** Money and policy refusals that are definite until something changes: a
 *  person acts, or the router lowers its quote. */
const ROUTING_BLOCKED: ReadonlySet<string> = new Set([
  'wallet_low',
  'limit_below_deposit',
  'budget_reached',
  'not_allowlisted',
  FEE_ABOVE_CEILING,
]);

/** Skips that say nothing about whether routing can pay: contention, a
 *  payment already out, a callback outside a call, a deposit on its way. */
const ROUTING_SILENT: ReadonlySet<string> = new Set([
  CHANNEL_BUSY,
  'busy',
  DEADLINE_AFTER_PAYMENT_SENT,
  'no_call',
  TOPPING_UP,
  DEPOSIT_DEFERRED,
  TOP_UP_UNAVAILABLE,
]);

/** Top-up refusals that back the next one off nothing: contention, a
 *  payment still out, a callback outside a call. */
const NO_BACKOFF: ReadonlySet<string> = new Set([
  CHANNEL_BUSY,
  'busy',
  DEADLINE_AFTER_PAYMENT_SENT,
  'no_call',
]);

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
  /** The router's paid route, which a top-up this call starts goes to. */
  router: string;
  /** The background top-up's `warm` call: the one call that may carry a
   *  deposit while the router has the form. */
  carrier?: boolean;
  /** When the caller's budget ends; later once the SDK sizes an inline deposit. */
  until: number;
  /** The SDK asked for a deposit on this call, made or deferred. */
  deposit?: boolean;
  /** What a refusal knew, for its sentence: a low wallet's balance. */
  facts?: SkipFacts;
  /** Its payment was out when its budget ended: it finishes in the background. */
  detached?: boolean;
  /** Its budget ended before anything was paid. */
  expired?: boolean;
  /** What `httpRequest` returned. */
  result?: HttpResult;
  /** Why a check refused to pay; the wrapper rethrows the error as its own. */
  skipped?: string;
  /** The routing fee the router's 402 quoted, once read. */
  quoted?: bigint;
  /** Whether a request carrying a payment went out. */
  paid: boolean;
  /** Whether the router answered any request of this call. */
  answered: boolean;
  /** The wallet's channel, once the server asked for a payment. */
  channel?: Channel;
  deposits: Deposit[];
}

/** How a background top-up ended. */
type TopUp =
  /** The router answered `warm`: the channel holds what the next fee needs,
   *  a deposit carried on it or none needed. */
  | { status: 'done' }
  /** The router has no `warm` form: a deposit rides the next paid call. */
  | { status: 'absent' }
  /** Another process on this machine is topping the channel up. */
  | { status: 'elsewhere' }
  /** It was not paid, and why. */
  | { status: 'refused'; skip: RouteSkipped };

/**
 * THE PAYMENT POLICY, the guide's check of the requirement before signing: a
 * routing offer at or below the fee ceiling. The server's `payTo` is not
 * pinned: the client ships no treasury address, and what the user approved
 * is a fee no higher than the ceiling, which this holds.
 */
const routingPolicy: PaymentPolicy = (version, requirements) =>
  routingOffers(version, requirements).filter(
    (r) => BigInt(r.amount) <= ROUTING_FEE_CEILING_ATOMIC,
  );

/** A call to anything but the configured router's paid route is not paid. */
const NOT_ROUTE = 'not_the_routing_route';

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
  /** The one unlock in flight, which every caller and the prewarm await. */
  private unlocking: Promise<TenjinSigner> | null = null;
  /** Calls waiting on `unlocking` right now (the prewarm is not one). */
  private waiters = 0;
  /** A signer an unlock settled with after every call waiting on it gave up:
   *  the next call signs with it rather than unlocking again (B3). */
  private handoff: TenjinSigner | null = null;
  /** The last settled unlock's verdict (decision 16). */
  private memo: SignMemo | null = null;
  /** When this process last saw the server ask for the fee. */
  private paidPathSeenAt: number | null = null;
  /** The sign and routing verdicts last reported to `observe`, as status:reason. */
  private reported: { sign?: string; routing?: string } = {};
  /** The background top-up in flight, which a call that meets it waits for. */
  private topping: Promise<TopUp> | null = null;
  /** The last top-up started, settled or not: what a call that deferred its
   *  deposit waits on. */
  private lastTopUp: Promise<TopUp> | null = null;
  /** The last top-up's refusal, which holds the next off until `until`. */
  private failed: {
    skip: RouteSkipped;
    steps: readonly number[];
    count: number;
    until: number;
  } | null = null;
  /** What settled top-ups deposited that no leg has said yet. */
  private toppedUp = 0n;
  /** The fee the router last quoted any call, for a line with no quote of its own. */
  private quoted: bigint | undefined;
  /** Background work a test or a shutdown can wait out ({@link idle}). */
  private pending: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: RoutingPayerDeps) {}

  /**
   * THE UNLOCK, ahead of any call: `tenjin mcp` starts it when it starts, so
   * the first prompt finds a verdict (and usually a signer) waiting. The same
   * single flight as a call's, with no budget; its answer goes to the memo and
   * to `observe`, and nothing else. Never rejects.
   */
  async prewarm(): Promise<void> {
    await this.unlock().catch(() => undefined);
  }

  /**
   * What the last settled unlock said, with no waiting; unknown `not_checked`
   * before any. A definite block is believed only as the pay path believes it
   * (decision 16): within {@link SIGNER_RECHECK_MS}, with no unlock running
   * and nothing it was read from changed. Past that it reads unknown, which
   * gates nothing, and an unlock starts in the background, so a wallet created
   * or repaired mid-session is picked up although no call asks for the fee.
   * The stamp is read in the background too: a change starts the unlock, and
   * the next caller reads its answer.
   */
  signVerdict(): SignVerdict {
    const memo = this.memo;
    if (memo === null) return NOT_CHECKED;
    if (!isDefiniteBlock(memo.verdict)) return memo.verdict;
    if (this.unlocking !== null) return NOT_CHECKED;
    if (this.now() - memo.at >= SIGNER_RECHECK_MS) {
      void this.prewarm();
      return NOT_CHECKED;
    }
    void this.stamp().then((stamp) => {
      if (this.memo === memo && stamp !== memo.stamp) void this.prewarm();
    });
    return memo.verdict;
  }

  /**
   * The paid route for one routing call to the router at `baseUrl`. ONLY
   * THAT ROUTE IS PAID: a URL on any other origin or path is refused before
   * anything is sent, so the routing fee's ceiling and channel never meet a
   * provider's 402.
   */
  routeFor(baseUrl: string): DecisionRoute {
    const calls: Call[] = [];
    const route = new URL(ROUTE_PAID_PATH, baseUrl);
    return {
      send: async (url, options) => {
        const target = new URL(url);
        if (target.origin !== route.origin || target.pathname !== route.pathname) {
          throw new RouteSkipped(NOT_ROUTE);
        }
        // The caller's budget starts now, not when this call's turn comes.
        const sent = this.now();
        const until = sent + options.timeoutMs;
        const once = () =>
          this.turn(
            () => this.noted(sent, () => this.pay(url, options, until, calls)),
            until,
            sent,
          );
        // A TOP-UP IN FLIGHT IN THIS PROCESS: the call waits for it inside its
        // own budget instead of skipping. The fee is required, so there is no
        // free path to fall back to.
        if (
          this.topping !== null &&
          (await this.waitForTopUp(this.topping, until, sent)) === null
        ) {
          throw new RouteSkipped(TOPPING_UP);
        }
        try {
          return await once();
        } catch (err) {
          // ITS OWN SDK ASKED FOR A DEPOSIT, which only the top-up makes: once
          // that lands, the call is made once more, as a voucher. The top-up's
          // refusal is this call's reason too (a low wallet, a failed payment;
          // contention or an unavailable router, no fault), as a skip of its
          // own: never the top-up's transport failure, since this call reached
          // the router. A payment still out is on its way, and stays deferred.
          const flight = this.lastTopUp;
          if (!(err instanceof RouteSkipped) || err.why !== DEPOSIT_DEFERRED || flight === null) {
            throw err;
          }
          const outcome = await this.waitForTopUp(flight, until, sent);
          if (outcome === null) throw new RouteSkipped(TOPPING_UP);
          if (outcome.status === 'refused' && outcome.skip.why !== DEADLINE_AFTER_PAYMENT_SENT) {
            throw new RouteSkipped(outcome.skip.why, outcome.skip.facts());
          }
          if (outcome.status !== 'done' && outcome.status !== 'absent') throw err;
          return await once();
        }
      },
      deposited: () => settledIn(calls),
      toppedUp: () => this.takeToppedUp(),
      fee: () =>
        calls.reduce<bigint | undefined>((last, call) => call.quoted ?? last, undefined) ??
        this.quoted,
    };
  }

  /**
   * THE SESSION'S FIRST TOP-UP. `tenjin mcp` calls this as it starts, after
   * the prewarm, so a new channel, or one that cannot cover the next fee, is
   * funded before the first prompt needs it. The channel is read from the
   * SDK's own files, with no request; with no quote seen yet, the ceiling is
   * the fee it must cover. Never rejects.
   */
  async topUpIfLow(baseUrl: string): Promise<void> {
    await this.unlocking?.catch(() => undefined);
    const memo = this.memo;
    if (memo?.verdict.status !== 'ready' || memo.address === undefined) return;
    const credit = await channelCredit(this.deps.dataDir, memo.address).catch(() => null);
    if (credit === null || credit >= (this.quoted ?? ROUTING_FEE_CEILING_ATOMIC)) return;
    await this.topUpWhenDue(new URL(ROUTE_PAID_PATH, baseUrl).toString(), memo.address);
  }

  /** Resolves once no top-up is in flight or about to start, and no payment
   *  is still finishing in the background: for `tenjin mcp`'s exit and the
   *  tests, anything that must not end the process mid-deposit. */
  async idle(): Promise<void> {
    for (;;) {
      const pending = this.pending;
      await pending;
      await this.topping;
      await this.tail;
      if (pending === this.pending && this.topping === null) return;
    }
  }

  private get timers(): Pick<typeof globalThis, 'setTimeout' | 'clearTimeout'> {
    return this.deps.timers ?? globalThis;
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
  private turn<T>(run: () => Promise<T>, until: number, sent: number, carrier = false): Promise<T> {
    let gaveUp = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const go = () => {
      if (gaveUp) return Promise.reject(new RouteSkipped('busy'));
      // Its turn came: from here its own budget, which a deposit lengthens, applies.
      this.timers.clearTimeout(timer);
      return run();
    };
    const next = this.queue.then(go, go);
    this.queue = next.catch(() => undefined).then(() => this.tail);
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = this.timers.setTimeout(
        () => {
          gaveUp = true;
          // It never ran, so `noted` cannot say it: its one line is here.
          this.note('busy', null, sent, undefined, carrier);
          reject(new RouteSkipped('busy'));
        },
        Math.max(0, until - this.now()),
      );
    });
    return Promise.race([next, deadline]).finally(() => this.timers.clearTimeout(timer));
  }

  /** One stderr line for a call the paid path did not answer; a detached
   *  one says it when its request ends. `carrier`: the top-up's own call. */
  private async noted(
    sent: number,
    run: () => Promise<HttpResult>,
    carrier = false,
  ): Promise<HttpResult> {
    this.last = null;
    try {
      return await run();
    } catch (err) {
      // Set by `run`, which the narrowing above cannot see.
      const call = this.last as Call | null;
      if (err instanceof RouteSkipped && call?.detached !== true) {
        this.note(err.why, call, sent, undefined, carrier);
      }
      if (err instanceof RouteSkipped) this.reportRouting(err.why);
      throw err;
    }
  }

  private note(why: string, call: Call | null, sent: number, late?: string, carrier = false): void {
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
    const what = carrier || call?.carrier === true ? `top-up ${why}` : why;
    this.warn(`${what} (cause ${cause}, ${this.now() - sent}ms, stage ${stage})`);
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
          this.timers.clearTimeout(timer);
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
          if (left > 0) timer = this.timers.setTimeout(check, left);
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
    const ceiling = this.timers.setTimeout(() => own.abort(), DETACHED_CEILING_MS);
    ceiling.unref?.();
    try {
      const response = await work;
      await response.arrayBuffer().catch(() => undefined);
      const why = response.ok ? DEADLINE_AFTER_PAYMENT_SENT : PAYMENT_FAILED;
      this.note(why, call, sent, `late http ${response.status}`);
    } catch {
      this.note(PAYMENT_FAILED, call, sent, own.signal.aborted ? 'late ceiling' : 'late network');
    } finally {
      this.timers.clearTimeout(ceiling);
    }
  }

  /**
   * ONE PAID CALL on the wallet's channel, inside the caller's budget. The
   * server's 402 becomes the stock wrapper's first answer, so asking before
   * the unlock adds no round trip.
   */
  private async pay(
    url: string,
    options: HttpRequestOptions,
    until: number,
    calls: Call[],
    carrier = false,
  ): Promise<HttpResult> {
    if (until - this.now() <= 0) throw new RouteSkipped('busy');
    const call: Call = {
      host: new URL(url).host,
      router: url,
      ...(carrier ? { carrier } : {}),
      until,
      paid: false,
      answered: false,
      deposits: [],
    };
    // The route's own record, which its `deposited` reads once the call ends.
    calls.push(call);
    // A WALLET KNOWN NOT TO SIGN, ON A SERVER KNOWN TO CHARGE: the 402 is
    // certain and nothing could answer it, so nothing is sent. Before this
    // process has seen a 402, the server is asked first as always (a fee that
    // is off costs no unlock), and an unknown verdict never gets here.
    if (this.paidPathSeenAt !== null && this.now() - this.paidPathSeenAt < FEE_SEEN_TTL_MS) {
      const blocked = await this.freshBlock();
      if (blocked !== null) {
        this.last = call;
        call.skipped = blocked.reason;
        throw new RouteSkipped(blocked.reason);
      }
    }
    const base = options.fetchImpl ?? this.deps.fetchImpl ?? fetch;
    const askFirst: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      // Every send below gets the caller's budget signal itself. A signal that
      // only follows it through copied Requests stops following once a copy is
      // garbage collected, and the call then outlives the hook's budget.
      const signal = init?.signal ?? request.signal;
      let asked: Response | undefined = await base(request.clone(), { signal });
      call.answered = true;
      if (asked.status !== 402) return asked;
      this.paidPathSeenAt = this.now();
      try {
        // THE QUOTE, read before the wallet is even unlocked: one above the
        // ceiling is not paid, and the rest get the per-payment checks
        // (`feeRefusal`) at the amount quoted, a voucher from a funded channel
        // included. With no routing offer to read, the ceiling stands in, and
        // the SDK refuses the 402 below as it always has.
        const challenge = asked.headers;
        const quoted = quoteOf((name) => challenge.get(name));
        if (quoted !== null) call.quoted = this.quoted = quoted;
        if (quoted !== null && quoted > ROUTING_FEE_CEILING_ATOMIC) {
          throw new RouteSkipped(FEE_ABOVE_CEILING);
        }
        const refused = feeRefusal(
          await this.deps.policy(),
          call.host,
          quoted ?? ROUTING_FEE_CEILING_ATOMIC,
        );
        if (refused !== null) throw new RouteSkipped(refused);
        call.channel = this.channelFor(await this.signer(call));
        if (until - this.now() <= 0) throw new RouteSkipped('busy');
      } catch (err) {
        if (err instanceof RouteSkipped) call.skipped = err.why;
        throw err;
      }
      const watched: typeof fetch = async (input, init) => {
        const request = new Request(input, init);
        const paying = request.headers.has('PAYMENT-SIGNATURE') && !signal.aborted;
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
        const response = await base(request, { signal });
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
    if (call.skipped !== undefined) {
      throw new RouteSkipped(call.skipped, {
        ...(call.quoted !== undefined ? { quotedAtomic: call.quoted } : {}),
        ...call.facts,
      });
    }
    // The router could not be reached: the call ends as that transport
    // failure, which starts the backoff. A timeout or a reset socket is
    // skipped below, as any other unanswered call is.
    if (!response.ok && !call.answered && isUnreachable(response)) {
      throw new RouteSkipped(PAYMENT_FAILED, { unreached: response });
    }
    // No answer, a failed payment or a server error: the call is skipped.
    if (!response.ok) {
      // A payment went out and the call's time ended before its answer did,
      // detached or with the body still arriving: no fault, it was charged.
      const late = call.detached === true || (call.paid && response.kind === 'timeout');
      throw new RouteSkipped(late ? DEADLINE_AFTER_PAYMENT_SENT : PAYMENT_FAILED);
    }
    // Another session's call was in flight on the channel: nothing was
    // charged, and this call is skipped.
    if (response.status === 402) {
      throw new RouteSkipped(
        call.channel !== undefined && paymentError(call.channel, response) === CHANNEL_BUSY_ERROR
          ? CHANNEL_BUSY
          : PAYMENT_FAILED,
      );
    }
    if (response.status >= 500) throw new RouteSkipped(PAYMENT_FAILED);
    // A fee paid and answered: routing works, whatever was said before.
    if (call.paid && response.status < 400) {
      this.report({ routing: { status: 'ready', at: this.now() } });
      if (!carrier) this.track(this.afterPaid(call));
    }
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
   * A ROUTING CALL'S DEPOSIT, NOT MADE: the top-up starts in its place, and
   * the call skips with `deposit_deferred` for `send` to wait out. While a
   * refused top-up holds the next off, its refusal (a low wallet, with its
   * balance, or a failed payment) is the call's own reason, which the hook
   * says once per session, and nothing is sent for it.
   */
  private deferral(call: Call): never {
    const failed = this.backedOff();
    if (failed !== null) {
      // A refusal said again: not the balance it read, which may be old now.
      call.facts = failed.quotedAtomic !== undefined ? { quotedAtomic: failed.quotedAtomic } : {};
      this.refuse(failed.why);
    }
    void this.topUp(call.router, this.channel!.payer);
    this.refuse(DEPOSIT_DEFERRED);
  }

  /** Whether the router at `router` is known to have no `warm` form. */
  private async warmAbsent(router: string): Promise<boolean> {
    return (await readRouterMemo(this.deps.dataDir, 'warm-absent', router, this.now())) !== null;
  }

  /** `payer`'s top-up, unless one is in flight, a refused one holds it off,
   *  or the router has no `warm` form (the next paid call deposits instead). */
  private async topUpWhenDue(router: string, payer: string): Promise<void> {
    if (this.topping !== null || this.backedOff() !== null) return;
    if (await this.warmAbsent(router)) return;
    await this.topUp(router, payer);
  }

  /** The one top-up in flight, joined or started. Never rejects. */
  private topUp(router: string, payer: string): Promise<TopUp> {
    if (this.topping !== null) return this.topping;
    const flight: Promise<TopUp> = this.runTopUp(router, payer)
      .catch(() => this.refusedTopUp(new RouteSkipped(PAYMENT_FAILED)))
      .finally(() => {
        if (this.topping === flight) this.topping = null;
      });
    this.topping = this.lastTopUp = flight;
    this.track(flight);
    return flight;
  }

  /**
   * THE BACKGROUND TOP-UP: one `warm` call to the paid route, through the
   * same turns, payment checks, spend ledger and detach as any call, on its
   * own {@link TOP_UP_TIMEOUT_MS}. The stock SDK adds the deposit the channel
   * needs to it ({@link deposit} sizes it), and the server answers in code and
   * charges $0. Another process's top-up of the same wallet's channel on this
   * machine (its `topping-up` memo, which names the wallet) holds this one
   * off. A refusal prints its one routing-fee line and backs the next off
   * ({@link TOP_UP_BACKOFF_MS}). A router that answers with
   * anything but the `warm` answer has no form, and the `warm-absent` memo
   * says so for {@link WARM_ABSENT_MS}.
   */
  private async runTopUp(router: string, payer: string): Promise<TopUp> {
    const { dataDir } = this.deps;
    const marker = await readRouterMemo(dataDir, 'topping-up', router, this.now());
    if (marker?.detail === payer) return { status: 'elsewhere' };
    await writeRouterMemo(dataDir, 'topping-up', router, {
      now: this.now(),
      ttlMs: TOPPING_UP_MEMO_MS,
      detail: payer,
    });
    try {
      const calls: Call[] = [];
      const sent = this.now();
      const until = sent + TOP_UP_TIMEOUT_MS;
      const options: HttpRequestOptions = {
        method: 'POST',
        timeoutMs: TOP_UP_TIMEOUT_MS,
        blockRedirects: true,
        jsonBody: buildWarmBody({
          accepts: acceptsFor(false),
          harness: this.deps.harness ?? 'claude',
        }),
      };
      let response: HttpResult;
      try {
        response = await this.turn(
          () => this.noted(sent, () => this.pay(router, options, until, calls, true), true),
          until,
          sent,
          true,
        );
      } catch (err) {
        if (!(err instanceof RouteSkipped)) throw err;
        // No connection reached the router: no fault, as on any call.
        if (err.unreached !== undefined) {
          return this.refusedTopUp(new RouteSkipped(TOP_UP_UNAVAILABLE));
        }
        // A DEPOSIT STILL OUT at the budget finishes in the background (the
        // detached request is `tail`): it is said once its answer lands.
        if (err.why === DEADLINE_AFTER_PAYMENT_SENT) {
          const late = this.tail;
          this.track(late.then(() => void (this.toppedUp += settledIn(calls))));
        }
        return this.refusedTopUp(err);
      }
      this.toppedUp += settledIn(calls);
      const status = response.ok ? response.status : 0;
      if (status >= 200 && status < 300 && response.ok && isWarmAnswer(response.json)) {
        this.failed = null;
        return { status: 'done' };
      }
      // A rate limit is no answer about the form: it backs off, and is no
      // fault, as on any call.
      if (status === 429) {
        this.note(TOP_UP_UNAVAILABLE, calls.at(-1) ?? null, sent, undefined, true);
        return this.refusedTopUp(new RouteSkipped(TOP_UP_UNAVAILABLE));
      }
      await writeRouterMemo(dataDir, 'warm-absent', router, {
        now: this.now(),
        ttlMs: WARM_ABSENT_MS,
        detail: `http ${status}`,
      });
      this.warn(
        `top-up: the router has no warm form (http ${status}), so a deposit rides the next paid call`,
      );
      return { status: 'absent' };
    } finally {
      // Another wallet's marker, written over this one meanwhile, stays.
      const now = this.now();
      if ((await readRouterMemo(dataDir, 'topping-up', router, now))?.detail === payer) {
        await clearRouterMemo(dataDir, 'topping-up', router);
      }
    }
  }

  /** A top-up not paid: the next one waits out the backoff, unless the cause
   *  was contention or a payment still out, which back off nothing. A wallet
   *  too low has the shorter schedule ({@link WALLET_LOW_BACKOFF_MS}); a
   *  refusal on the other schedule starts it from its first step, so a server
   *  error just after a funded wallet waits 30 s, not 10 min. */
  private refusedTopUp(skip: RouteSkipped): TopUp {
    if (!NO_BACKOFF.has(skip.why)) {
      const steps = skip.why === 'wallet_low' ? WALLET_LOW_BACKOFF_MS : TOP_UP_BACKOFF_MS;
      const count = this.failed?.steps === steps ? this.failed.count + 1 : 1;
      const wait = steps[Math.min(count, steps.length) - 1]!;
      this.failed = { skip, steps, count, until: this.now() + wait };
    }
    return { status: 'refused', skip };
  }

  /** The last top-up's refusal while it still holds the next off; else null. */
  private backedOff(): RouteSkipped | null {
    return this.failed !== null && this.now() < this.failed.until ? this.failed.skip : null;
  }

  /**
   * A CHANNEL RUNNING LOW: after a paid call, the SDK's record (one small file
   * read, no request) says whether the next fee would need a deposit, and if
   * so the top-up starts now rather than on the prompt that would need it.
   * The SDK deposits only once the next voucher passes the balance, so the
   * mark is one quoted fee.
   */
  private async afterPaid(call: Call): Promise<void> {
    const payer = call.channel?.payer;
    if (payer === undefined) return;
    const credit = await channelCredit(this.deps.dataDir, payer).catch(() => null);
    if (credit === null || credit >= (call.quoted ?? ROUTING_FEE_CEILING_ATOMIC)) return;
    await this.topUpWhenDue(call.router, payer);
  }

  /** `flight` raced against the call's budget less the paid call's reserve:
   *  its outcome, or null, with the call's one line, when time ran out first. */
  private async waitForTopUp(
    flight: Promise<TopUp>,
    until: number,
    sent: number,
  ): Promise<TopUp | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<null>((resolve) => {
      timer = this.timers.setTimeout(
        () => resolve(null),
        Math.max(0, until - PAID_CALL_RESERVE_MS - this.now()),
      );
    });
    try {
      const outcome = await Promise.race([flight, deadline]);
      if (outcome === null) this.note(TOPPING_UP, null, sent, 'top-up in flight');
      return outcome;
    } finally {
      this.timers.clearTimeout(timer);
    }
  }

  /** What settled top-ups deposited since a leg last said it, now said. */
  private takeToppedUp(): bigint {
    const amount = this.toppedUp;
    this.toppedUp = 0n;
    return amount;
  }

  /** Work that runs on after its caller returns, for {@link idle}. */
  private track(work: Promise<unknown>): void {
    // Settled to undefined, so no result is kept alive by the next one.
    this.pending = Promise.all([this.pending, work.catch(() => undefined)]).then(() => undefined);
  }

  /**
   * THE SDK'S `depositStrategy`, called right before it signs a deposit.
   *
   * ONLY THE TOP-UP'S `warm` CALL DEPOSITS. Any other call's deposit is not
   * made: the top-up starts instead ({@link deferral}), and the call waits
   * for it in `send`. A router known to have no `warm` form gets today's
   * deposit on the call that needs it, with the longer budget.
   *
   * THE SIZE is {@link routingDepositAtomic}: the smallest of the 402's
   * `extra.minDeposit` ({@link CHANNEL_DEPOSIT_ATOMIC} when it has none), the
   * wallet and the per-call limit, never below ten quoted fees, and inside the
   * SDK's ceiling (cap × multiplier). A wallet below it is `wallet_low`, with
   * its balance; a spend the authorizer denies (the per-call limit, the daily
   * budget, the creator allowlist) refuses it too, and nothing is paid.
   */
  private async deposit(ctx: BatchSettlementDepositStrategyContext): Promise<bigint> {
    const call = this.call;
    if (call === null) this.refuse('no_call');
    if (call.deposit !== true) {
      call.deposit = true;
      // AN INLINE DEPOSIT GETS THE LONGER BUDGET, once per call, before the
      // memo read below, so the call's deadline cannot pass during it. A
      // deferred call ends at once, whatever its budget says.
      if (call.carrier !== true) call.until += DEPOSIT_EXTRA_MS;
    }
    if (call.carrier !== true && !(await this.warmAbsent(call.router))) this.deferral(call);
    const policy = await this.deps.policy();
    const quote = BigInt(ctx.requestAmount);
    const left = call.until - this.now();
    if (left <= 0) this.refuse('busy');
    const payer = this.channel!.payer;
    const wallet = await this.deps.walletBalance(payer, Math.min(BALANCE_TIMEOUT_MS, left));
    const sdkMax = ctx.maxDeposit === undefined ? null : BigInt(ctx.maxDeposit);
    const amount = routingDepositAtomic({
      hintAtomic:
        parseAnnouncedMinDeposit(ctx.paymentRequirements.extra?.['minDeposit'], quote) ??
        CHANNEL_DEPOSIT_ATOMIC,
      quoteAtomic: quote,
      walletAtomic: wallet,
      perCallAtomic: policy.maxAutoSpendAtomic,
      maxAtomic:
        sdkMax !== null && sdkMax < MAX_CHANNEL_DEPOSIT_ATOMIC
          ? sdkMax
          : MAX_CHANNEL_DEPOSIT_ATOMIC,
      neededAtomic: BigInt(ctx.minimumDepositAmount),
    });
    if (wallet !== null && wallet < amount) {
      call.facts = { balanceAtomic: wallet, depositAtomic: amount };
      this.refuse('wallet_low');
    }
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
      key: `${ROUTING_DEPOSIT_KEY}${auth.reservationId ?? randomUUID()}`,
      state: 'signed',
    });
    return amount;
  }

  /**
   * THE WALLET, unlocked without a prompt, for `call`. One that cannot be pays
   * nothing, and the call skips with WHY, as `classifyUnlockError` names it: a
   * definite reason (`no_wallet`, `passphrase_wrong`, ...), `keychain_locked`,
   * `unlock_timeout`, or `wallet_locked` for a failure nobody classified.
   *
   * A definite block the memo still believes skips before any unlock
   * ({@link freshBlock}). Otherwise the call joins the one unlock in flight
   * (or starts it) and waits for it only until {@link PAID_CALL_RESERVE_MS}
   * before its own budget ends, then skips with `unlock_timeout`. THE BUDGET
   * BOUNDS THE WAIT, NEVER THE READ
   * (B3): the unlock runs on, unaborted, its store read under no deadline, so
   * an OS unlock dialog stays up; its answer lands in the memo, and a signer
   * nobody was left waiting for is the next call's.
   *
   * The warned line is the classified error's message, which never carries a
   * store's output (S2).
   */
  private async signer(call: Call): Promise<ClientEvmSigner> {
    const blocked = await this.freshBlock();
    if (blocked !== null) throw new RouteSkipped(blocked.reason);
    let signer: TenjinSigner;
    const held = this.handoff;
    this.handoff = null;
    if (held !== null && (await this.freshReady())) signer = held;
    else {
      this.waiters += 1;
      try {
        signer = await this.waitFor(this.unlock(), call.until - PAID_CALL_RESERVE_MS);
      } catch (err) {
        if (err instanceof RouteSkipped) throw err;
        this.warn(err instanceof Error ? err.message : String(err));
        throw new RouteSkipped(classifyUnlockError(err).reason);
      } finally {
        this.waiters -= 1;
      }
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
   * THE ONE UNLOCK IN FLIGHT, joined or started. Its settlement, whoever is
   * still waiting, sets the memo (with the stamp read as it started, so a
   * repair that lands mid-unlock still reads as a change) and reports the
   * sign verdict, and clears the flight. A success no call is waiting for is
   * kept for the next call. Nothing here can abort it.
   */
  private unlock(): Promise<TenjinSigner> {
    if (this.unlocking !== null) return this.unlocking;
    const stamp = this.stamp();
    const flight = (async () => {
      try {
        const signer = await this.deps.getSigner();
        const address = signer.address.toLowerCase();
        this.settle({ status: 'ready' }, await stamp, address);
        if (this.waiters === 0) this.handoff = signer;
        return signer;
      } catch (err) {
        this.settle(verdictOf(err), await stamp);
        throw err;
      } finally {
        this.unlocking = null;
      }
    })();
    // A flight every waiter gave up on still settles; its rejection is the memo's.
    flight.catch(() => undefined);
    this.unlocking = flight;
    return flight;
  }

  /** `unlock` raced against `until`: `unlock_timeout` when the budget ends
   *  first, and the unlock is left running. */
  private async waitFor(unlock: Promise<TenjinSigner>, until: number): Promise<TenjinSigner> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = this.timers.setTimeout(
        () => reject(new RouteSkipped('unlock_timeout')),
        Math.max(0, until - this.now()),
      );
    });
    try {
      return await Promise.race([unlock, deadline]);
    } finally {
      this.timers.clearTimeout(timer);
    }
  }

  /** The memo, set from a settled unlock, and its verdict reported. */
  private settle(verdict: SignVerdict, stamp: string | null, address?: string): void {
    this.memo = {
      verdict,
      at: this.now(),
      stamp,
      ...(address !== undefined ? { address } : {}),
    };
    this.report({ sign: signObservation(verdict), ...(address !== undefined ? { address } : {}) });
  }

  /** The wallet's unlock stamp, or null when there is none to read. */
  private async stamp(): Promise<string | null> {
    try {
      return (await this.deps.unlockStamp?.()) ?? null;
    } catch {
      return null;
    }
  }

  /** Whether the memo was set within {@link SIGNER_RECHECK_MS} and nothing it
   *  was read from has changed since. */
  private async freshMemo(memo: SignMemo): Promise<boolean> {
    return this.now() - memo.at < SIGNER_RECHECK_MS && (await this.stamp()) === memo.stamp;
  }

  /** The memo's definite block while it is fresh; null otherwise, an unknown
   *  verdict always (decision 16: only a definite block may skip anything). */
  private async freshBlock(): Promise<Extract<SignVerdict, { status: 'blocked' }> | null> {
    const memo = this.memo;
    if (memo === null || !isDefiniteBlock(memo.verdict)) return null;
    return (await this.freshMemo(memo)) ? memo.verdict : null;
  }

  /** Whether the memo is a fresh ready, so a handed-off signer is still this wallet's. */
  private async freshReady(): Promise<boolean> {
    const memo = this.memo;
    return memo !== null && memo.verdict.status === 'ready' && (await this.freshMemo(memo));
  }

  /** A routing outcome, reported when it says something (see {@link ROUTING_SILENT}). */
  private reportRouting(why: string): void {
    if (ROUTING_SILENT.has(why)) return;
    const blocked = DEFINITE_UNLOCK.has(why as UnlockReason) || ROUTING_BLOCKED.has(why);
    this.report({
      routing: { status: blocked ? 'blocked' : 'unknown', reason: why, at: this.now() },
    });
  }

  /** `deps.observe`, with only the parts whose status or reason changed; not
   *  called at all on a repeat. An observer that throws is ignored. */
  private report(u: PayerObservation): void {
    const out: PayerObservation = {};
    if (u.sign !== undefined) {
      const key = `${u.sign.status}:${u.sign.reason ?? ''}`;
      if (key !== this.reported.sign) {
        this.reported.sign = key;
        out.sign = u.sign;
        if (u.address !== undefined) out.address = u.address;
      }
    }
    if (u.routing !== undefined) {
      const key = `${u.routing.status}:${u.routing.reason ?? ''}`;
      if (key !== this.reported.routing) {
        this.reported.routing = key;
        out.routing = u.routing;
      }
    }
    if (out.sign === undefined && out.routing === undefined) return;
    try {
      this.deps.observe?.(out);
    } catch {
      // Advisory: an observation never fails a call.
    }
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

/** What the deposits of `calls` that settled put into the channel. */
function settledIn(calls: Call[]): bigint {
  return calls
    .flatMap((call) => call.deposits)
    .filter((d) => d.state === 'settled')
    .reduce((sum, d) => sum + d.amountAtomic, 0n);
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

/**
 * A failed unlock as a sign verdict: a definite reason is blocked, worded from
 * WALLET_REASONS with the PERSON fix (model-facing callers swap in
 * `agentFixFor`, decision 15); anything else is unknown. Never the error's own
 * message, which may predate B1.
 */
function verdictOf(err: unknown): SignVerdict {
  const c = classifyUnlockError(err);
  if (c.definite && c.reason !== 'wallet_locked' && c.reason !== 'unlock_timeout') {
    const r = WALLET_REASONS[c.reason];
    return { status: 'blocked', reason: c.reason, detail: r.reason, fix: r.fix };
  }
  return {
    status: 'unknown',
    reason: c.reason,
    detail: UNKNOWN_DETAIL[c.reason] ?? UNKNOWN_DETAIL['check_failed']!,
  };
}

/** A sign verdict in the live observation's shape. */
function signObservation(v: SignVerdict): RouterObservation['sign'] {
  if (v.status === 'ready') {
    return { status: 'ready', ...(v.source !== undefined ? { source: v.source } : {}) };
  }
  if (v.status === 'blocked') {
    return { status: 'blocked', reason: v.reason, detail: v.detail, fix: v.fix };
  }
  return { status: 'unknown', reason: v.reason, detail: v.detail };
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
