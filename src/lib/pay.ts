import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from '@x402/core/http';
import { x402Client } from '@x402/core/client';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import type { PaymentRequired, SettleResponse } from '@x402/core/types';
import { CliError } from './errors';
import type { TenjinSigner } from './wallet/provider';

/**
 * The x402 v2 exact-scheme payment path, entirely through the official SDKs
 * (nothing custom rides the payment flow, per the compliance rule). The CLI
 * trusts a challenge only when it is the shape it knows how to pay safely:
 * v2, exact scheme, an eip155 network whose USDC address matches the pinned
 * per-network constant. Anything else is a contract mismatch, not a payment.
 */

/** USDC per supported CAIP-2 network. Paying an unknown asset is never attempted. */
export const USDC_BY_NETWORK: Record<string, string> = {
  'eip155:8453': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  'eip155:84532': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
};

interface AcceptEntry {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  extra?: Record<string, unknown>;
}

export interface DecodedChallenge {
  paymentRequired: PaymentRequired;
  amountAtomic: string;
  network: string;
  asset: string;
  payTo: string;
  /** The post id the server binds settlement to, when advertised. */
  postId: string | null;
  /** Server-side rejection reason on a re-served challenge (verify failure). */
  error: string | null;
  /** CAIP-2 chain advertised for SIWX, when the extension is present. */
  siwxChainId: string | null;
}

export function decodeChallenge(header: string): DecodedChallenge {
  let paymentRequired: PaymentRequired;
  try {
    paymentRequired = decodePaymentRequiredHeader(header);
  } catch (err) {
    throw new CliError(
      'CONTRACT_MISMATCH',
      'Could not decode the PAYMENT-REQUIRED challenge header.',
      { cause: err },
    );
  }
  const pr = paymentRequired as unknown as {
    x402Version?: number;
    accepts?: AcceptEntry[];
    error?: string;
    extensions?: Record<
      string,
      { info?: Record<string, unknown>; supportedChains?: { chainId?: string }[] }
    >;
  };
  if (pr.x402Version !== 2) {
    throw new CliError(
      'CONTRACT_MISMATCH',
      `Unsupported x402 version ${String(pr.x402Version)}; this CLI speaks v2.`,
      {
        fix: 'Upgrade tenjin-cli.',
      },
    );
  }
  const accepted = (pr.accepts ?? []).find(
    (a) => a.scheme === 'exact' && typeof a.network === 'string' && a.network.startsWith('eip155:'),
  );
  if (accepted === undefined) {
    throw new CliError(
      'CONTRACT_MISMATCH',
      'The challenge offers no exact-scheme EVM payment option.',
      {
        details: { accepts: pr.accepts?.map((a) => ({ scheme: a.scheme, network: a.network })) },
      },
    );
  }
  const expectedAsset = USDC_BY_NETWORK[accepted.network];
  if (expectedAsset === undefined || accepted.asset.toLowerCase() !== expectedAsset.toLowerCase()) {
    throw new CliError(
      'CONTRACT_MISMATCH',
      `The challenge asks for an asset this CLI will not pay: ${accepted.asset} on ${accepted.network}.`,
      {
        fix: 'Only USDC on Base (or Base Sepolia previews) is supported.',
      },
    );
  }
  if (!/^\d+$/.test(accepted.amount)) {
    throw new CliError(
      'CONTRACT_MISMATCH',
      `Challenge amount is not an atomic integer string: ${JSON.stringify(accepted.amount)}`,
    );
  }
  const postId =
    accepted.extra !== undefined && typeof accepted.extra.postId === 'string'
      ? accepted.extra.postId
      : null;
  const siwxChainId = pr.extensions?.['sign-in-with-x']?.supportedChains?.[0]?.chainId ?? null;
  return {
    paymentRequired,
    amountAtomic: accepted.amount,
    network: accepted.network,
    asset: accepted.asset,
    payTo: accepted.payTo,
    postId,
    error: typeof pr.error === 'string' ? pr.error : null,
    siwxChainId,
  };
}

/**
 * Sign the exact-scheme EIP-3009 authorization for a decoded challenge and
 * return the PAYMENT-SIGNATURE header value. The signer seam only needs
 * address + signTypedData, so a hosted provider slots in without touching this.
 */
export async function buildPaymentHeader(
  signer: TenjinSigner,
  challenge: DecodedChallenge,
): Promise<string> {
  const client = new x402Client();
  registerExactEvmScheme(client, {
    signer: {
      address: signer.address,
      signTypedData: (message) =>
        signer.signTypedData(message as Parameters<TenjinSigner['signTypedData']>[0]),
    },
  });
  try {
    const payload = await client.createPaymentPayload(challenge.paymentRequired);
    return encodePaymentSignatureHeader(payload);
  } catch (err) {
    throw new CliError(
      'PAYMENT_FAILED',
      `Could not construct the payment payload: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/** Settlement result from a PAYMENT-RESPONSE header; null txHash when malformed. */
export function decodeSettlement(header: string): {
  success: boolean;
  txHash: string | null;
  network: string | null;
} {
  let settle: SettleResponse;
  try {
    settle = decodePaymentResponseHeader(header);
  } catch {
    return { success: false, txHash: null, network: null };
  }
  const s = settle as unknown as { success?: boolean; transaction?: string; network?: string };
  const txHash =
    typeof s.transaction === 'string' && TX_HASH_RE.test(s.transaction) ? s.transaction : null;
  return {
    success: s.success === true,
    txHash,
    network: typeof s.network === 'string' ? s.network : null,
  };
}
