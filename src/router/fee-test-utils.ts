import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from '@x402/core/http';
import type { PaymentRequirements } from '@x402/core/types';
import type { TypedDataDefinition } from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import type { TenjinSigner } from '../lib/wallet/provider';
import { ROUTE_PAID_PATH, ROUTING_FEE_ATOMIC } from './fee-state';

/**
 * A FAKE ROUTER THAT SPEAKS THE REAL x402 `batch-settlement` HEADERS, for the
 * routing fee's tests. The stock SDK client builds every deposit and voucher
 * against it; it answers `PAYMENT-RESPONSE` the way a 2.28 server does (the
 * charged amount, and the channel state the client no longer copies), and a
 * stale voucher with a corrective 402 carrying the last voucher the wallet
 * signed, which the SDK's recovery checks. It serves one pending request per
 * channel, as the real server does. No money moves and no network is touched.
 */

export const NETWORK = 'eip155:84532';
export const FEE = ROUTING_FEE_ATOMIC.toString();
export const BASE = 'https://router.test';
export const MISMATCH = 'invalid_batch_settlement_evm_cumulative_amount_mismatch';
export const BUSY = 'invalid_batch_settlement_evm_channel_busy';

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

export class FakeRouter {
  readonly channels = new Map<string, Channel>();
  deposits = 0;
  settledFees = 0;
  /** Every request, as `METHOD path paid|unpaid`. */
  readonly log: string[] = [];
  /** Settle the next paid answer, then drop the connection before it is read. */
  abortAfterSettle = false;
  /** How long each paid request holds its channel. */
  delayMs = 0;
  /** The body a settled paid call answers with. */
  body: unknown = NATIVE;
  readonly requirement: PaymentRequirements;

  constructor(private readonly opts: { paid?: boolean; amount?: string } = {}) {
    this.requirement = {
      scheme: 'batch-settlement',
      network: NETWORK,
      asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      amount: opts.amount ?? FEE,
      payTo: privateKeyToAccount(generatePrivateKey()).address,
      maxTimeoutSeconds: 15,
      extra: {
        receiverAuthorizer: privateKeyToAccount(generatePrivateKey()).address,
        withdrawDelay: 108_000,
        name: 'USDC',
        version: '2',
      },
    };
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const signature = headers.get('payment-signature');
    this.log.push(`${init?.method ?? 'GET'} ${url.pathname} ${signature ? 'paid' : 'unpaid'}`);
    if (url.pathname !== ROUTE_PAID_PATH) return json(this.body, 200);
    if (this.opts.paid === false) return json({}, 404);
    if (signature === null) return this.required(url.toString());
    const payload = decodePaymentSignatureHeader(signature).payload as {
      type: 'deposit' | 'voucher';
      voucher: { channelId: string; maxClaimableAmount: string; signature: `0x${string}` };
      deposit?: { amount: string };
    };
    const id = payload.voucher.channelId.toLowerCase();
    const channel = this.channels.get(id) ?? { balance: 0n, charged: 0n, pending: false };
    this.channels.set(id, channel);
    if (channel.pending) return this.error(url.toString(), BUSY);
    if (BigInt(payload.voucher.maxClaimableAmount) !== channel.charged + ROUTING_FEE_ATOMIC) {
      return this.corrective(url.toString(), id, channel);
    }
    channel.pending = true;
    try {
      if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
      if (payload.type === 'deposit') {
        channel.balance += BigInt(payload.deposit!.amount);
        this.deposits += 1;
      }
      channel.last = {
        maxClaimableAmount: payload.voucher.maxClaimableAmount,
        signature: payload.voucher.signature,
      };
      channel.charged += ROUTING_FEE_ATOMIC;
      this.settledFees += 1;
    } finally {
      channel.pending = false;
    }
    if (this.abortAfterSettle) {
      this.abortAfterSettle = false;
      throw new DOMException('The operation was aborted.', 'AbortError');
    }
    return json(this.body, 200, {
      'PAYMENT-RESPONSE': encodePaymentResponseHeader({
        success: true,
        transaction: '0x',
        network: NETWORK,
        extra: { chargedAmount: FEE, channelState: this.state(id, channel) },
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

  private required(url: string): Response {
    return json({}, 402, {
      'PAYMENT-REQUIRED': encodePaymentRequiredHeader({
        x402Version: 2,
        resource: { url, description: 'routing', mimeType: 'application/json' },
        accepts: [this.requirement],
      }),
    });
  }

  private error(url: string, error: string): Response {
    return json({}, 402, {
      'PAYMENT-REQUIRED': encodePaymentRequiredHeader({
        x402Version: 2,
        error,
        resource: { url, description: 'routing', mimeType: 'application/json' },
        accepts: [this.requirement],
      }),
    });
  }

  private corrective(url: string, id: string, channel: Channel): Response {
    return json({}, 402, {
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
    });
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
