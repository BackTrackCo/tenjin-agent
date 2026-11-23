import type { ChainRead } from './routing-payer';
import { join } from 'node:path';
import { x402Client } from '@x402/core/client';
import { toClientEvmSigner } from '@x402/evm';
import { BatchSettlementEvmScheme } from '@x402/evm/batch-settlement/client';
import { FileClientChannelStorage } from '@x402/evm/batch-settlement/client/file-storage';
import { wrapFetchWithPayment } from '@x402/fetch';
import type { TypedDataDefinition } from 'viem';
import { USDC_ADDRESS } from '../lib/usdc';
import type { SpendAuthorizer } from '../lib/wallet/spend';
import type { WalletProvider } from '../lib/wallet';

/**
 * THE SECOND NEON SELLER, FOR THE EVALUATION ONLY: x402inference.com resells Gemini 4 Neon on an
 * OpenAI-compatible chat endpoint and takes the standard `batch-settlement` scheme on Base. One
 * deposit opens an escrow channel, each call signs a voucher up to its quoted ceiling, and the
 * call is charged only what it used, which the response names in `X-Request-Cost-Atomic`.
 * BlockRun stays the default seller.
 */
export const NEON_SELLER_ENV = 'TENJIN_NEON_SELLER';
export type NeonSellerName = 'blockrun' | 'x402inference';
export function neonSeller(env: NodeJS.ProcessEnv = process.env): NeonSellerName {
  return env[NEON_SELLER_ENV] === 'x402inference' ? 'x402inference' : 'blockrun';
}
export const X402INFERENCE_ORIGIN = 'https://x402inference.com';
export const X402INFERENCE_CHAT_URL = `${X402INFERENCE_ORIGIN}/accountless/chat/completions`;
/** The most one channel may hold, in atomic USDC: $0.25. No deposit takes it past this. */
export const X402INFERENCE_MAX_CHANNEL_DEPOSIT_ATOMIC = 250_000n;
const BASE = 'eip155:8453';

export class ChannelDepositRefused extends Error {}

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
  ) {}
  /** The hook before a payment is created: abort it where the limits refuse it. */
  async before(ceilingAtomic: bigint): Promise<void | { abort: true; reason: string }> {
    // A corrective retry signs again under the reservation the call already holds.
    if (this.held) return;
    const authorization = await this.authorizer.authorize({
      mode: 'automatic',
      amountAtomic: ceilingAtomic,
      creator: this.creator,
      requestKey: this.requestKey,
    });
    if (authorization.decision !== 'allow')
      return { abort: true, reason: authorization.message ?? 'Over your spend limits.' };
    this.reservation = authorization.reservationId;
    this.held = true;
  }
  /** After the call: the real charge, or the ceiling where it is not known and a voucher left. */
  async settle(costAtomic: bigint | undefined, ceilingAtomic: bigint, transmitted: boolean) {
    if (!this.held) return;
    this.held = false;
    if (!transmitted) return this.authorizer.release(this.reservation);
    // The reservation held the ceiling only to refuse a call over the limits. What counts is
    // what left the channel: the real charge, or the ceiling where it is not known.
    const charged = costAtomic ?? ceilingAtomic;
    await this.authorizer.release(this.reservation);
    await this.authorizer.commit(undefined, charged, { mode: 'automatic' });
  }
}

/**
 * HOW MUCH A DEPOSIT PUTS INTO THE CHANNEL: what fills it to the cap, never more, and never
 * less than the call needs. A channel that cannot hold what the call needs, or a deposit over
 * the person's limits, is refused before anything is signed.
 */
export async function channelDeposit(
  ctx: { minimumDepositAmount: string; currentBalance: string; maxDeposit?: string },
  admit: (amountAtomic: bigint) => Promise<void>,
  deposits: { sum: bigint } = { sum: 0n },
): Promise<bigint> {
  const needed = BigInt(ctx.minimumDepositAmount);
  const room = X402INFERENCE_MAX_CHANNEL_DEPOSIT_ATOMIC - BigInt(ctx.currentBalance);
  if (room <= 0n || room < needed)
    throw new ChannelDepositRefused('The channel is at its deposit cap');
  const max = ctx.maxDeposit === undefined ? room : BigInt(ctx.maxDeposit);
  const deposit = max < room ? max : room;
  if (deposit < needed) throw new ChannelDepositRefused('The deposit cannot cover the call');
  await admit(deposit);
  deposits.sum += deposit;
  return deposit;
}

/** One answer from the seller: the reply body, the ceiling its voucher allowed, the real charge. */
export type BatchAnswer = {
  status: number;
  text: string;
  /** The amount the 402 quoted as the most this call could cost. */
  ceilingAtomic?: bigint;
  /** What the call was charged (`X-Request-Cost-Atomic`), where the seller said. */
  costAtomic?: bigint;
  /** What a deposit put into the channel for this call, atomic. */
  depositedAtomic: bigint;
};

export type BatchSellerOptions = {
  dataDir: string;
  provider: WalletProvider;
  /** The person's own limits meet a deposit before it is signed: throws where it is over them. */
  admit: (amountAtomic: bigint) => Promise<void>;
  /** Where each call's ceiling and real charge are counted, pre-funded channel or not. */
  authorizer?: SpendAuthorizer;
  /** Names the call, so one request in flight cannot become two. */
  requestKey?: string;
  fetchImpl?: typeof fetch;
  /** Chain reads for the scheme's channel checks. */
  readContract?: ChainRead;
};

/**
 * THE BATCH-SETTLEMENT PAYER: the SDK's own scheme with a channel store of its own for this
 * seller, and a policy that signs only a Base USDC `batch-settlement` offer whose ceiling fits
 * the job's room, and only deposits that keep the channel at or under the cap.
 */
export class BatchSeller {
  /** An authorization or voucher reached the seller: from here a failure is not proven unpaid. */
  transmitted = false;
  constructor(private options: BatchSellerOptions) {}

  private async scheme(
    signal: AbortSignal,
    deposits: { sum: bigint },
  ): Promise<{ scheme: BatchSettlementEvmScheme; payer: string }> {
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
      storage: new FileClientChannelStorage({
        directory: join(this.options.dataDir, 'x402inference-channel', payer),
      }),
      depositStrategy: (ctx) => channelDeposit(ctx, this.options.admit, deposits),
    });
    return { scheme, payer };
  }

  /** One chat completion, paid from the channel, with its ceiling held to `room`. */
  async post(body: string, signal: AbortSignal, room: bigint): Promise<BatchAnswer> {
    const deposits = { sum: 0n };
    const { scheme } = await this.scheme(signal, deposits);
    let ceiling: bigint | undefined;
    const client = new x402Client()
      .register('eip155:*', scheme)
      .registerPolicy((_version, offers) => {
        const fit = offers.filter(
          (offer) =>
            offer.scheme === 'batch-settlement' &&
            offer.network === BASE &&
            offer.asset.toLowerCase() === USDC_ADDRESS.toLowerCase() &&
            BigInt(offer.amount) <= room,
        );
        if (fit[0]) ceiling = BigInt(fit[0].amount);
        return fit;
      });
    const spend = this.options.authorizer
      ? new VoucherSpend(
          this.options.authorizer,
          new URL(X402INFERENCE_CHAT_URL).host,
          this.options.requestKey ?? `x402inference:${Date.now()}`,
        )
      : undefined;
    if (spend)
      client.onBeforePaymentCreation((ctx) =>
        spend.before(BigInt(ctx.selectedRequirements.amount)),
      );
    const base = this.options.fetchImpl ?? fetch;
    const watched: typeof fetch = (input, init) => {
      if (new Headers(init?.headers).has('payment-signature')) this.transmitted = true;
      return base(input, { ...init, signal });
    };
    let response: Response;
    try {
      response = await wrapFetchWithPayment(watched, client)(X402INFERENCE_CHAT_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body,
      });
    } catch (error) {
      await spend?.settle(undefined, ceiling ?? room, this.transmitted).catch(() => undefined);
      throw error;
    }
    const cost = response.headers.get('x-request-cost-atomic');
    await spend
      ?.settle(
        cost !== null && /^\d+$/.test(cost) ? BigInt(cost) : undefined,
        ceiling ?? room,
        this.transmitted,
      )
      .catch(() => undefined);
    return {
      status: response.status,
      text: await response.text(),
      ...(ceiling !== undefined ? { ceilingAtomic: ceiling } : {}),
      ...(cost !== null && /^\d+$/.test(cost) ? { costAtomic: BigInt(cost) } : {}),
      depositedAtomic: deposits.sum,
    };
  }

  /**
   * THE COOPERATIVE REFUND of the channel's remainder: the SDK signs a zero-charge refund
   * voucher and the seller returns what is left of the deposit. It is immediate where the
   * seller cooperates. Where it does not, the funds return only through the channel's own
   * unilateral withdrawal after its delay (900 s for this seller), which needs gas and is not
   * done here.
   */
  async refund(signal: AbortSignal) {
    const { scheme } = await this.scheme(signal, { sum: 0n });
    return scheme.refund(X402INFERENCE_CHAT_URL, { fetch: this.options.fetchImpl ?? fetch });
  }
}
