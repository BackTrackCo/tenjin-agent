import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from '@x402/core/http';
import type { PaymentRequirements } from '@x402/core/types';
import type { TypedDataDefinition } from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import type { SpendPolicy } from '../lib/policy';
import type { TenjinSigner } from '../lib/wallet/provider';
import { createLocalSpendAuthorizer } from '../lib/wallet/spend';
import { ROUTE_PAID_PATH } from './decision';
import { CHANNEL_DEPOSIT_ATOMIC, LEGACY_ROUTING_QUOTE_ATOMIC } from './fee';
import type { RoutingPayerDeps } from './routing-payer';

/**
 * A FAKE ROUTER THAT SPEAKS THE REAL x402 `batch-settlement` HEADERS, for the
 * routing fee's tests. The stock SDK client builds every deposit and voucher
 * against it; it answers `PAYMENT-RESPONSE` the way a 2.28 server does (the
 * charged amount, and the channel state the client no longer copies), and a
 * stale voucher with a corrective 402 carrying the last voucher the wallet
 * signed, which the SDK's recovery checks. It serves one pending request per
 * channel, as the real server does. It answers the `warm` form the way a
 * router with the form does (its answer, settled at $0, with any deposit on
 * it), or, as a router from before the form, with a 400 and nothing settled.
 * No money moves and no network is touched.
 */

export const NETWORK = 'eip155:84532';
/** What the fake quotes by default: the router's fixed quote. */
export const FEE = LEGACY_ROUTING_QUOTE_ATOMIC.toString();
export const BASE = 'https://router.test';
export const MISMATCH = 'invalid_batch_settlement_evm_cumulative_amount_mismatch';
export const BUSY = 'invalid_batch_settlement_evm_channel_busy';
export const INSUFFICIENT = 'invalid_batch_settlement_evm_insufficient_balance';

/** A tool-form decision with nothing to buy. */
export const NATIVE = {
  schemaVersion: 1,
  routerVersion: 'test',
  decision: {
    action: 'native',
    diagnostics: { reasonCode: 'native', stage: 'gate', missing: [], nextAction: 'native' },
  },
};

interface Channel {
  balance: bigint;
  charged: bigint;
  last?: { maxClaimableAmount: string; signature: `0x${string}` };
  pending: boolean;
}

/** The `warm` answer, as a router with the form sends it. */
export const WARM = { schemaVersion: 1, routerVersion: 'test', warm: true };

export class FakeRouter {
  readonly channels = new Map<string, Channel>();
  deposits = 0;
  settledFees = 0;
  /** Paid `warm` calls answered, each settled at $0. */
  warms = 0;
  /** What carried each settled deposit: the top-up's `warm` call, or a routing call. */
  readonly depositedOn: ('warm' | 'call')[] = [];
  /** Every request, as `METHOD path [warm] paid|unpaid`. */
  readonly log: string[] = [];
  /** Settle the next paid answer, then drop the connection before it is read. */
  abortAfterSettle = false;
  /** How long each paid request holds its channel. */
  delayMs = 0;
  /** Holds each paid request's channel until it resolves, with no clock: the
   *  test decides when the settle happens. */
  hold: Promise<void> | null = null;
  /** Called as a paid request starts holding its channel, by `delayMs` or `hold`. */
  onDelayArmed?: () => void;
  /** The body a settled paid call answers with. */
  body: unknown = NATIVE;
  /** The wallet the facilitator verifies a deposit against; null checks nothing. */
  walletAtomic: bigint | null = null;
  /** A 402 reason every deposit is refused with, ahead of the balance check. */
  depositError: string | null = null;
  /** The `error` a deposit over {@link walletAtomic} is refused with. */
  insufficientError = INSUFFICIENT;
  readonly requirement: PaymentRequirements;
  /** The router's fixed quote, offered second beside this answer's own when
   *  the fake is built with `legacy`, as the router does for released CLIs. */
  readonly legacyRequirement: PaymentRequirements | null;
  /** The amount each paid request's voucher was signed for, in order. */
  readonly paidAmounts: bigint[] = [];

  /** What each settled call is charged: the matched quote unless `charge`
   *  says less, as batch settlement lets the server charge below its quote. */
  private readonly charge: bigint | null;

  constructor(
    private readonly opts: {
      paid?: boolean;
      amount?: string;
      charge?: string;
      /** The 402's `extra.minDeposit`; `null` leaves the field out. */
      minDeposit?: string | null;
      /** Also offer the router's fixed quote, second. */
      legacy?: boolean;
      /** False: a router from before the `warm` form, which 400s it. */
      warm?: boolean;
      /** A background quote independent of the routing answer, as on the live router. */
      warmAmount?: string;
    } = {},
  ) {
    this.charge = opts.charge === undefined ? null : BigInt(opts.charge);
    this.requirement = {
      scheme: 'batch-settlement',
      network: NETWORK,
      asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      amount: opts.amount ?? FEE,
      payTo: privateKeyToAccount(generatePrivateKey()).address,
      maxTimeoutSeconds: 15,
      extra: {
        // The hint the production server announces explicitly, whatever it quotes.
        ...(opts.minDeposit === null
          ? {}
          : { minDeposit: opts.minDeposit ?? CHANNEL_DEPOSIT_ATOMIC.toString() }),
        receiverAuthorizer: privateKeyToAccount(generatePrivateKey()).address,
        withdrawDelay: 108_000,
        name: 'USDC',
        version: '2',
      },
    };
    this.legacyRequirement = opts.legacy === true ? { ...this.requirement, amount: FEE } : null;
  }

  /** The amount one paid request settles: the charge, at most the matched quote. */
  private charged(matched: bigint): bigint {
    return this.charge !== null && this.charge < matched ? this.charge : matched;
  }

  /** What every 402 offers: this answer's quote, then the fixed one when set. */
  private accepts(requirement: PaymentRequirements = this.requirement): PaymentRequirements[] {
    return this.legacyRequirement === null
      ? [requirement]
      : [requirement, { ...requirement, amount: this.legacyRequirement.amount }];
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const signature = request.headers.get('payment-signature');
    const warm = await isWarm(request);
    const requirement =
      warm && this.opts.warmAmount !== undefined
        ? { ...this.requirement, amount: this.opts.warmAmount }
        : this.requirement;
    this.log.push(
      `${request.method} ${url.pathname}${warm ? ' warm' : ''} ${signature ? 'paid' : 'unpaid'}`,
    );
    // A router from before the form: its strict request schema refuses the
    // field, after verify and before settle, so nothing is charged.
    const refusesWarm = warm && this.opts.warm === false;
    // The fee off (development): the paid route answers with no 402.
    if (url.pathname !== ROUTE_PAID_PATH || this.opts.paid === false) {
      if (refusesWarm) return json({ error: { code: 'bad_request', message: 'warm' } }, 400);
      return json(warm ? WARM : this.body, 200);
    }
    if (signature === null) return this.required(url.toString(), requirement);
    const decoded = decodePaymentSignatureHeader(signature);
    // The offer the voucher was signed for; the server charges at most it.
    const matched = BigInt(decoded.accepted?.amount ?? this.requirement.amount);
    const payload = decoded.payload as {
      type: 'deposit' | 'voucher';
      voucher: { channelId: string; maxClaimableAmount: string; signature: `0x${string}` };
      deposit?: { amount: string };
    };
    const id = payload.voucher.channelId.toLowerCase();
    const channel = this.channels.get(id) ?? { balance: 0n, charged: 0n, pending: false };
    this.channels.set(id, channel);
    if (channel.pending) return this.error(url.toString(), BUSY);
    if (BigInt(payload.voucher.maxClaimableAmount) !== channel.charged + matched) {
      return this.corrective(url.toString(), id, channel, requirement);
    }
    if (refusesWarm) return json({ error: { code: 'bad_request', message: 'warm' } }, 400);
    if (payload.type === 'deposit') {
      if (this.depositError !== null) return this.error(url.toString(), this.depositError);
      if (this.walletAtomic !== null && BigInt(payload.deposit!.amount) > this.walletAtomic) {
        return this.error(url.toString(), this.insufficientError);
      }
    }
    // `warm` is answered in code, with no gate, and settles at $0.
    const charge = warm ? 0n : this.charged(matched);
    channel.pending = true;
    try {
      if (this.hold !== null) {
        const held = this.hold;
        this.onDelayArmed?.();
        await held;
      } else if (this.delayMs > 0) {
        const held = new Promise((r) => setTimeout(r, this.delayMs));
        this.onDelayArmed?.();
        await held;
      }
      if (payload.type === 'deposit') {
        channel.balance += BigInt(payload.deposit!.amount);
        this.deposits += 1;
        this.depositedOn.push(warm ? 'warm' : 'call');
      }
      channel.last = {
        maxClaimableAmount: payload.voucher.maxClaimableAmount,
        signature: payload.voucher.signature,
      };
      channel.charged += charge;
      if (warm) this.warms += 1;
      else {
        this.paidAmounts.push(matched);
        this.settledFees += 1;
      }
    } finally {
      channel.pending = false;
    }
    if (this.abortAfterSettle) {
      this.abortAfterSettle = false;
      throw new DOMException('The operation was aborted.', 'AbortError');
    }
    return json(warm ? WARM : this.body, 200, {
      'PAYMENT-RESPONSE': encodePaymentResponseHeader({
        success: true,
        transaction: '0x',
        network: NETWORK,
        extra: { chargedAmount: charge.toString(), channelState: this.state(id, channel) },
      }),
    });
  };

  /** The escrow's `channels(id)`: balance and total claimed. */
  readonly readContract = async (args: { args?: readonly unknown[] }) => {
    const channel = this.channels.get(String(args.args?.[0]).toLowerCase());
    return [channel?.balance ?? 0n, 0n] as const;
  };

  paidRequests(): number {
    return this.log.filter((l) => l.endsWith(' paid')).length;
  }

  private state(id: string, channel: Channel) {
    return {
      channelId: id,
      balance: channel.balance.toString(),
      chargedCumulativeAmount: channel.charged.toString(),
      totalClaimed: '0',
    };
  }

  private required(url: string, requirement: PaymentRequirements = this.requirement): Response {
    return json({}, 402, {
      'PAYMENT-REQUIRED': encodePaymentRequiredHeader({
        x402Version: 2,
        resource: { url, description: 'routing', mimeType: 'application/json' },
        accepts: this.accepts(requirement),
      }),
    });
  }

  private error(url: string, error: string): Response {
    return json({}, 402, {
      'PAYMENT-REQUIRED': encodePaymentRequiredHeader({
        x402Version: 2,
        error,
        resource: { url, description: 'routing', mimeType: 'application/json' },
        accepts: this.accepts(),
      }),
    });
  }

  private corrective(
    url: string,
    id: string,
    channel: Channel,
    requirement: PaymentRequirements = this.requirement,
  ): Response {
    return json({}, 402, {
      'PAYMENT-REQUIRED': encodePaymentRequiredHeader({
        x402Version: 2,
        error: MISMATCH,
        resource: { url, description: 'routing', mimeType: 'application/json' },
        accepts: this.accepts({
          ...requirement,
          extra: {
            ...requirement.extra,
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
        }),
      }),
    });
  }
}

/** Whether a request's JSON body is the `warm` form. */
async function isWarm(request: Request): Promise<boolean> {
  if (request.method !== 'POST') return false;
  try {
    return ((await request.clone().json()) as { warm?: unknown }).warm === true;
  } catch {
    return false;
  }
}

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** A wallet signer over a fresh test key. */
export function testSigner(
  account: PrivateKeyAccount = privateKeyToAccount(generatePrivateKey()),
): TenjinSigner {
  return {
    address: account.address,
    signMessage: (args) => account.signMessage(args),
    signTypedData: (args: TypedDataDefinition) => account.signTypedData(args),
    signTransaction: () => Promise.reject(new Error('unused')),
  };
}

/** The spend policy the payer tests run under unless they say otherwise. */
export const TEST_POLICY: SpendPolicy = {
  maxAutoSpendAtomic: 250_000n,
  sessionBudgetAtomic: 5_000_000n,
  allowlistCreators: [],
};

/**
 * A payer's deps against `router`, with the real local spend authorizer over
 * `dataDir`'s ledger.
 */
export function payerDeps(
  router: FakeRouter,
  dataDir: string,
  account: PrivateKeyAccount,
  overrides: Partial<RoutingPayerDeps> = {},
): RoutingPayerDeps {
  return {
    dataDir,
    getSigner: async () => testSigner(account),
    policy: async () => TEST_POLICY,
    authorizer: (policy) =>
      createLocalSpendAuthorizer({
        dir: dataDir,
        policy,
        ...(overrides.now !== undefined ? { now: overrides.now } : {}),
      }),
    walletBalance: async () => router.walletAtomic ?? 10_000_000n,
    readContract: router.readContract as never,
    fetchImpl: router.fetch,
    warn: () => undefined,
    ...overrides,
  };
}
