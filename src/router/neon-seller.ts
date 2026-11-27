import type { ChainRead } from './routing-payer';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { x402Client } from '@x402/core/client';
import { toClientEvmSigner } from '@x402/evm';
import { BatchSettlementEvmScheme } from '@x402/evm/batch-settlement/client';
import { FileClientChannelStorage } from '@x402/evm/batch-settlement/client/file-storage';
import { wrapFetchWithPayment } from '@x402/fetch';
import { encodeAbiParameters, keccak256, type Hex, type TypedDataDefinition } from 'viem';
import { CliError } from '../lib/errors';
import type { NeonTerms } from './neon-terms';
import { pinnedFetch, type PinnedFetchOptions } from './pinned-fetch';
import type { SpendAuthorizer } from '../lib/wallet/spend';
import type { WalletProvider } from '../lib/wallet';

/**
 * THE NEON WORKER'S PAYER for a seller whose row names the `batch-settlement` scheme: one deposit
 * opens an escrow channel, each call signs a voucher up to its quoted ceiling, and the call is
 * charged only what it used, which the response names in `X-Request-Cost-Atomic`. The seller,
 * its URL and its payee are the job's saved terms ({@link NeonTerms}), never a constant here.
 */
/**
 * The most one channel may hold, in atomic USDC: $0.50. A full 16,000-token turn is quoted at
 * about $0.25 before its input, so the cap sits above the largest quote a turn can ask for,
 * and no deposit takes the channel past it. What is left in it returns at the job's end.
 */
export const NEON_CHANNEL_DEPOSIT_CAP_ATOMIC = 500_000n;

/** The terms a payer needs to pay and to refund one seller's channel. */
export type SellerTerms = Pick<NeonTerms, 'url' | 'payTo' | 'network' | 'asset' | 'scheme'>;

/** The live 402 named a payee other than the row's: nothing was signed. */
export class PayeeMismatch extends CliError {
  constructor(expected: string, offered: readonly string[]) {
    super(
      'REGISTRY_MISMATCH',
      'The seller asks to be paid at an address other than its provider row names. Nothing was signed.',
      { details: { expected, offered } },
    );
  }
}

/** One seller's channel key: its origin and its payee. The payer, the wallet, comes after it. */
export function channelKey(terms: Pick<NeonTerms, 'url' | 'payTo'>) {
  return createHash('sha256')
    .update(`${new URL(terms.url).origin}\n${terms.payTo.toLowerCase()}`)
    .digest('hex')
    .slice(0, 24);
}

/** Where one seller's channels are kept: by its URL and payee, then by payer. */
export function channelDirectory(dataDir: string, terms: Pick<NeonTerms, 'url' | 'payTo'>) {
  return join(dataDir, 'inference-channel', channelKey(terms));
}

export class ChannelDepositRefused extends Error {}

/** What a person approved past their per-call limit, spent once, one payment at a time. */
export type PaymentApproval = {
  leftAtomic: bigint;
  consume: (amountAtomic: bigint) => Promise<boolean>;
  restore: (amountAtomic: bigint) => Promise<void>;
};

/**
 * EVERY VOUCHER COUNTS AGAINST THE PERSON'S LIMITS, a pre-funded channel's too. A voucher spends
 * from money already in the channel, so no wallet payment shows it: without this the daily
 * budget never saw a call a funded channel paid. The call's ceiling is authorized (per-call
 * limit, daily budget, allowlist) before the voucher is signed, and what the seller charged is
 * committed after. A ceiling that was sent and never answered stays committed in full.
 */
export class VoucherSpend {
  private reservation: string | undefined;
  private held = false;
  constructor(
    private authorizer: SpendAuthorizer,
    private creator: string,
    private requestKey: string,
    private approval?: PaymentApproval,
  ) {}
  /** The hook before a payment is created: abort it where the limits refuse it. */
  async before(ceilingAtomic: bigint): Promise<void | { abort: true; reason: string }> {
    // A corrective retry signs again under the reservation the call already holds.
    if (this.held) return;
    const ask = (mode: 'automatic' | 'manual') =>
      this.authorizer.authorize({
        mode,
        amountAtomic: ceilingAtomic,
        creator: this.creator,
        requestKey: this.requestKey,
      });
    let authorization = await ask('automatic');
    // THE TOOL PAYER'S RULE: a payment over the per-call limit or the day's budget is the
    // person's to approve, and their yes (a quote for this job) pays that one payment as an
    // approved payment: the allowlist still applies, and it is recorded in the ledger as
    // approved spend, not in the automatic budget. The approval is spent before the payment is
    // created and given back where it is still refused, so it pays once.
    if (
      authorization.decision !== 'allow' &&
      (authorization.reason === 'above_auto_spend' ||
        authorization.reason === 'session_budget_exceeded') &&
      this.approval &&
      ceilingAtomic <= this.approval.leftAtomic &&
      (await this.approval.consume(ceilingAtomic))
    ) {
      authorization = await ask('manual');
      // An approved payment comes back as `confirm`: the person's yes already answered it.
      if (authorization.decision === 'confirm')
        authorization = { ...authorization, decision: 'allow' };
      if (authorization.decision !== 'allow') await this.approval.restore(ceilingAtomic);
    }
    if (authorization.decision !== 'allow')
      return { abort: true, reason: authorization.message ?? 'Over your spend limits.' };
    this.reservation = authorization.reservationId;
    this.held = true;
  }
  /**
   * After the call: the real charge, or the ceiling where it is not known and a voucher left.
   * The reservation is replaced by that amount in ONE ledger update, so no other automatic
   * payment can take the room in between. A failed write is thrown, never swallowed: the
   * reservation then stays, and the caller counts the call as uncertain.
   */
  async settle(
    costAtomic: bigint | undefined,
    ceilingAtomic: bigint,
    transmitted: boolean,
    /** The deposit authorization's nonce, where a deposit is what makes the voucher claimable. */
    nonce?: string,
  ) {
    if (!this.held) return;
    this.held = false;
    if (!transmitted) return this.authorizer.release(this.reservation);
    const charged = costAtomic ?? ceilingAtomic;
    await this.authorizer.commit(this.reservation, charged, {
      mode: 'automatic',
      exposureAtomic: charged,
      settledAtomic: charged,
      // Keyed by the deposit authorization's nonce, so `tenjin payments reconcile` can release
      // exactly this exposure once the chain shows that authorization expired unused.
      ...(nonce !== undefined ? { nonce } : {}),
    });
  }
}

/**
 * HOW MUCH OF A CHANNEL IS STILL UNSPENT: its balance less what the seller has charged, by the
 * larger of the charge this client counted and the amount the chain says was claimed. The deposit
 * cap bounds this, since this is what waits at the seller. The balance itself also holds what
 * was charged long ago, so a channel used for many jobs can show a balance above the cap while
 * holding nothing: bounding the balance would refuse every later deposit.
 */
export function unspentInChannel(ctx: {
  currentBalance: string;
  clientContext?: { chargedCumulativeAmount?: string; totalClaimed?: string };
}): bigint {
  const balance = BigInt(ctx.currentBalance);
  const charged = BigInt(ctx.clientContext?.chargedCumulativeAmount ?? '0');
  const claimed = BigInt(ctx.clientContext?.totalClaimed ?? '0');
  const spent = charged > claimed ? charged : claimed;
  return balance > spent ? balance - spent : 0n;
}

/**
 * HOW MUCH A DEPOSIT PUTS INTO THE CHANNEL: what fills it to the cap, never more, and never
 * less than the call needs. A channel that cannot hold what the call needs, or a deposit over
 * the person's limits, is refused before anything is signed.
 */
export async function channelDeposit(
  ctx: { minimumDepositAmount: string; currentBalance: string; maxDeposit?: string },
  /**
   * The person's limits meet a deposit before it is signed. It returns nothing where the whole
   * amount is admitted, or the most the limits admit where it is not, and throws where the payee
   * is refused outright.
   */
  admit: (amountAtomic: bigint) => Promise<bigint | void>,
  deposits: { sum: bigint } = { sum: 0n },
): Promise<bigint> {
  const needed = BigInt(ctx.minimumDepositAmount);
  const room = NEON_CHANNEL_DEPOSIT_CAP_ATOMIC - BigInt(ctx.currentBalance);
  if (room <= 0n || room < needed)
    throw new ChannelDepositRefused('The channel is at its deposit cap');
  const max = ctx.maxDeposit === undefined ? room : BigInt(ctx.maxDeposit);
  let deposit = max < room ? max : room;
  if (deposit < needed) throw new ChannelDepositRefused('The deposit cannot cover the call');
  // THE SMALLEST AMOUNT THE LIMITS ADMIT THAT STILL SERVES THE CALL: the channel is filled to its
  // cap where the limits allow it, and no further than they allow where they do not, but never
  // below what the call itself needs. A call that cannot be served inside the limits is refused
  // here, before anything is signed, and says why.
  const admitted = await admit(deposit);
  if (admitted !== undefined && admitted < deposit) {
    if (admitted < needed)
      throw new ChannelDepositRefused(
        `Your spend limits admit a deposit of ${dollars(admitted)} at most, and this call needs a channel deposit of at least ${dollars(needed)}`,
      );
    deposit = admitted;
    // The limits see the amount that is signed, too, and must take it whole.
    const again = await admit(deposit);
    if (again !== undefined && again < deposit)
      throw new ChannelDepositRefused(
        `Your spend limits do not admit a channel deposit of ${dollars(deposit)}`,
      );
  }
  deposits.sum += deposit;
  return deposit;
}

/** Atomic USDC as dollars, for a refusal the person reads. */
function dollars(atomic: bigint): string {
  const cents = (Number(atomic) / 1_000_000).toFixed(4);
  return '$' + cents.replace(/0+$/, '').replace(/[.]$/, '');
}

/** One answer from the seller: the reply body, the ceiling its voucher allowed, the real charge. */
/** What a timed withdrawal needs of a funded channel, kept from the call that funded it. */
export type ChannelConfig = {
  payer: string;
  receiverAuthorizer: string;
  withdrawDelay: number;
};

/** The deposit authorization a call signed: enough to ask the token later whether it was used. */
export type SignedDeposit = {
  from: string;
  nonce: string;
  /** Unix seconds; after it the authorization can no longer be used. */
  validBefore: string;
  network: string;
  asset: string;
  /** Nothing waited in the channel, so the voucher is claimable only through this deposit. */
  onlyThroughDeposit: boolean;
};

export type BatchAnswer = {
  status: number;
  text: string;
  /** The amount the 402 quoted as the most this call could cost. */
  ceilingAtomic?: bigint;
  /** What the call was charged (`X-Request-Cost-Atomic`), where the seller said. */
  costAtomic?: bigint;
  /** What a deposit put into the channel for this call, atomic. */
  depositedAtomic: bigint;
  /** The channel's own config as the seller's 402 named it, and the wallet that paid. */
  channel?: ChannelConfig;
};

export type BatchSellerOptions = {
  dataDir: string;
  /** The seller's saved terms: where it posts, who it is paid to, in what asset. */
  terms: SellerTerms;
  provider: WalletProvider;
  /** The person's own limits meet a deposit before it is signed (see {@link channelDeposit}). */
  admit: (amountAtomic: bigint) => Promise<bigint | void>;
  /** Where each call's ceiling and real charge are counted, pre-funded channel or not. */
  authorizer?: SpendAuthorizer;
  /** Names the call, so one request in flight cannot become two. */
  requestKey?: string;
  /**
   * Keeps the funded channel's own config. It runs BEFORE the first payment of a call is created,
   * so a call that is funded and then fails still leaves what a withdrawal needs. Where it throws,
   * nothing is signed.
   */
  onChannel?: (channel: ChannelConfig) => Promise<void>;
  /** The channel's salt, part of its identity: none is the SDK's own, and a retired channel's successor has its own. */
  salt?: Hex;
  /** What the person approved past their per-call limit, if anything is left of it. */
  approval?: PaymentApproval;
  fetchImpl?: typeof fetch;
  /**
   * Where a request may go, and how it connects (test seams). A provider request is never plain
   * `fetch`: it goes to the public address that was checked ({@link pinnedFetch}), unless a
   * `fetchImpl` stands in for the network.
   */
  destination?: PinnedFetchOptions['destination'];
  pinnedTransport?: PinnedFetchOptions['transport'];
  /** Chain reads for the scheme's channel checks. */
  readContract?: ChainRead;
};

/**
 * THE BATCH-SETTLEMENT PAYER: the SDK's own scheme with a channel store of its own for this
 * seller, and a policy that signs only an offer of the row's scheme, network, asset and payee whose
 * ceiling fits the job's room, and only deposits that keep the channel at or under the cap.
 */
export class BatchSeller {
  /** An authorization or voucher reached the seller: from here a failure is not proven unpaid. */
  transmitted = false;
  /** The deposit authorization the call signed, where it signed one. */
  signed?: SignedDeposit;
  constructor(private options: BatchSellerOptions) {}

  /**
   * The fetch every request to the seller goes through. With a `signal`, every request it makes
   * is bounded by it: the SDK's refund calls `fetch` with none of its own.
   */
  private fetcher(signal?: AbortSignal): typeof fetch {
    const base =
      this.options.fetchImpl ??
      pinnedFetch({
        ...(this.options.destination ? { destination: this.options.destination } : {}),
        ...(this.options.pinnedTransport ? { transport: this.options.pinnedTransport } : {}),
      });
    if (!signal) return base;
    return ((input, init) =>
      base(input, {
        ...init,
        signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal,
      })) as typeof fetch;
  }

  private async scheme(
    signal: AbortSignal,
    deposits: { sum: bigint; unspent?: bigint },
  ): Promise<{ scheme: BatchSettlementEvmScheme; payer: string; address: string }> {
    const signer = await this.options.provider.getSigner();
    const read = this.options.readContract;
    const clientSigner = toClientEvmSigner(
      {
        address: signer.address,
        signTypedData: (message) => {
          signal.throwIfAborted();
          return signer.signTypedData(message as unknown as TypedDataDefinition);
        },
      },
      read ? { readContract: (args) => read(args, 5_000) as never } : undefined,
    );
    const payer = signer.address.toLowerCase();
    const scheme = new BatchSettlementEvmScheme(clientSigner, {
      ...(this.options.salt ? { salt: this.options.salt } : {}),
      storage: new FileClientChannelStorage({
        directory: join(channelDirectory(this.options.dataDir, this.options.terms), payer),
      }),
      depositStrategy: (ctx) => {
        // What the channel held for the seller before this deposit: the voucher needs the deposit
        // to be claimable only where this is nothing.
        deposits.unspent = unspentInChannel(ctx);
        return channelDeposit(
          {
            minimumDepositAmount: ctx.minimumDepositAmount,
            // What the channel still holds for the seller to charge, not its whole balance: the
            // balance keeps what was already charged, so after a refund it can stay far above
            // the cap with nothing left in the channel.
            currentBalance: unspentInChannel(ctx).toString(),
            ...(ctx.maxDeposit !== undefined ? { maxDeposit: ctx.maxDeposit } : {}),
          },
          this.options.admit,
          deposits,
        );
      },
    });
    return { scheme, payer, address: signer.address };
  }

  /** One chat completion, paid from the channel, with its ceiling held to `room`. */
  async post(body: string, signal: AbortSignal, room: bigint): Promise<BatchAnswer> {
    const deposits: { sum: bigint; unspent?: bigint } = { sum: 0n };
    const { scheme, address } = await this.scheme(signal, deposits);
    let ceiling: bigint | undefined;
    let channel: ChannelConfig | undefined;
    const { terms } = this.options;
    // What the live 402 offered at another payee than the row names: nothing is signed for it.
    let wrongPayees: string[] = [];
    const client = new x402Client()
      .register('eip155:*', scheme)
      .registerPolicy((_version, offers) => {
        const ours = offers.filter(
          (offer) =>
            offer.scheme === terms.scheme &&
            offer.network === terms.network &&
            offer.asset.toLowerCase() === terms.asset.toLowerCase(),
        );
        wrongPayees = ours
          .filter((offer) => offer.payTo.toLowerCase() !== terms.payTo.toLowerCase())
          .map((offer) => offer.payTo);
        const fit = ours.filter(
          (offer) =>
            offer.payTo.toLowerCase() === terms.payTo.toLowerCase() && BigInt(offer.amount) <= room,
        );
        if (fit[0]) {
          ceiling = BigInt(fit[0].amount);
          const extra = fit[0].extra as
            { receiverAuthorizer?: unknown; withdrawDelay?: unknown } | undefined;
          if (typeof extra?.receiverAuthorizer === 'string')
            channel = {
              payer: address,
              receiverAuthorizer: extra.receiverAuthorizer,
              withdrawDelay: typeof extra.withdrawDelay === 'number' ? extra.withdrawDelay : 900,
            };
        }
        return fit;
      });
    const spend = this.options.authorizer
      ? new VoucherSpend(
          this.options.authorizer,
          new URL(terms.url).host,
          this.options.requestKey ?? `neon:${Date.now()}`,
          this.options.approval,
        )
      : undefined;
    // WHAT WAS SIGNED, kept so a payment the seller did not answer with a charge is never released
    // on its word: the deposit authorization's nonce and expiry are what a chain read can prove.
    client.onAfterPaymentCreation(async (ctx) => {
      const inner = ctx.paymentPayload.payload as {
        type?: string;
        voucher?: { channelId?: string };
        deposit?: {
          authorization?: { erc3009Authorization?: { validBefore?: string; salt?: string } };
        };
      };
      const auth = inner.deposit?.authorization?.erc3009Authorization;
      if (inner.type !== 'deposit' || !auth?.salt || !auth.validBefore || !inner.voucher?.channelId)
        return;
      this.signed = {
        from: address,
        // The nonce `receiveWithAuthorization` consumes, as the scheme derives it.
        nonce: keccak256(
          encodeAbiParameters(
            [{ type: 'bytes32' }, { type: 'uint256' }],
            [inner.voucher.channelId as Hex, BigInt(auth.salt)],
          ),
        ),
        validBefore: auth.validBefore,
        network: terms.network,
        asset: terms.asset,
        // The voucher needs this deposit to be claimable only where nothing waited in the channel.
        onlyThroughDeposit: deposits.unspent === 0n,
      };
    });
    // Before anything is signed: the person's limits, then the channel's config is kept.
    client.onBeforePaymentCreation(async (ctx) => {
      const refused = await spend?.before(BigInt(ctx.selectedRequirements.amount));
      if (refused) return refused;
      if (channel && this.options.onChannel) {
        try {
          await this.options.onChannel(channel);
        } catch {
          await spend?.settle(undefined, ceiling ?? room, false);
          return {
            abort: true,
            reason: 'The channel config could not be kept, so nothing was signed.',
          };
        }
      }
      return undefined;
    });
    const base = this.fetcher();
    const watched: typeof fetch = (input, init) => {
      // The payment wrapper calls fetch with a Request and no init: read its headers too.
      const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
      if (headers.has('payment-signature')) this.transmitted = true;
      return base(input, { ...init, signal });
    };
    let response: Response;
    try {
      response = await wrapFetchWithPayment(watched, client)(terms.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body,
      });
    } catch (error) {
      await spend?.settle(undefined, ceiling ?? room, this.transmitted, this.proofNonce());
      // A payee that is not the row's is told apart from any other refusal to sign.
      if (!this.transmitted && wrongPayees.length > 0 && ceiling === undefined)
        throw new PayeeMismatch(terms.payTo, wrongPayees);
      throw error;
    }
    const cost = response.headers.get('x-request-cost-atomic');
    // A seller's status is not proof that its signature holder cannot use what was signed: a
    // payment that was sent and not answered with a charge stays counted. Only a charge it names
    // is the charge; an answer without one leaves the exposure keyed by the deposit authorization,
    // which `tenjin payments reconcile` releases once the chain shows it expired unused.
    const charged = cost !== null && /^\d+$/.test(cost);
    await spend?.settle(
      charged ? BigInt(cost) : undefined,
      ceiling ?? room,
      this.transmitted,
      response.status >= 200 && response.status < 300 && charged ? undefined : this.proofNonce(),
    );
    return {
      status: response.status,
      text: await response.text(),
      ...(ceiling !== undefined ? { ceilingAtomic: ceiling } : {}),
      ...(cost !== null && /^\d+$/.test(cost) ? { costAtomic: BigInt(cost) } : {}),
      depositedAtomic: deposits.sum,
      ...(channel !== undefined ? { channel } : {}),
    };
  }

  /** The nonce a chain read can prove unused, where the deposit is what makes the voucher claimable. */
  private proofNonce(): string | undefined {
    return this.signed?.onlyThroughDeposit ? this.signed.nonce : undefined;
  }

  /**
   * THE COOPERATIVE REFUND of the channel's remainder: the SDK signs a zero-charge refund
   * voucher and the seller returns what is left of the deposit. It is immediate where the
   * seller cooperates. Where it does not, the funds return only through the channel's own
   * timed on-chain withdrawal, which needs gas (`tenjin refund` runs it).
   */
  async refund(signal: AbortSignal) {
    const { scheme } = await this.scheme(signal, { sum: 0n });
    return scheme.refund(this.options.terms.url, { fetch: this.fetcher(signal) });
  }
}
