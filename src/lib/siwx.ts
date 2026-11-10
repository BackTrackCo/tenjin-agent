import { randomUUID } from 'node:crypto';
import type { PaymentRequired } from '@x402/core/types';
import {
  SIGN_IN_WITH_X,
  assertSIWxChallengeBoundToOrigin,
  createSIWxClientHook,
  createSIWxMessage,
  encodeSIWxHeader,
  type SIWxExtension,
} from '@x402/extensions/sign-in-with-x';
import { sanitizeForTerminal } from './output';
import type { TenjinSigner } from './wallet/provider';

/**
 * Build the `SIGN-IN-WITH-X` header a returning buyer sends to re-read an owned
 * post for free (llms-full: Tenjin's SIWX is CLIENT-driven, no server challenge,
 * a client-minted single-use nonce, so `wrapFetchWithSIWx` does NOT apply). The
 * `domain` MUST be the site host INCLUDING any port (preview/local run on a port),
 * and `chainId` is the CAIP-2 network the live 402 advertised.
 */
export const SIWX_HEADER = 'SIGN-IN-WITH-X';

/**
 * The chain a sign-in to Tenjin itself is signed over: Base mainnet, which the
 * server's SIWX chain constraint requires. A sign-in to a seller signs over the
 * network its live 402 advertised instead.
 */
export const SIWX_CHAIN_ID = 'eip155:8453';

export interface BuildSiwxOptions {
  baseUrl: string;
  chainId: string;
  /** Validity window in ms (default 24h, the server's cap). */
  ttlMs?: number;
}

export async function buildSiwxHeader(
  signer: TenjinSigner,
  opts: BuildSiwxOptions,
): Promise<string> {
  const url = new URL(opts.baseUrl);
  const now = Date.now();
  const info = {
    domain: url.host, // host, WITH port, matches the server's host-with-port compare
    uri: `${url.protocol}//${url.host}`,
    version: '1',
    chainId: opts.chainId,
    type: 'eip191' as const,
    nonce: randomUUID().replace(/-/g, ''),
    issuedAt: new Date(now).toISOString(),
    expirationTime: new Date(now + (opts.ttlMs ?? 86_400_000)).toISOString(),
    statement: 'Sign in to Tenjin.',
  };
  const message = createSIWxMessage(info, signer.address);
  const signature = await signer.signMessage({ message });
  return encodeSIWxHeader({
    ...info,
    address: signer.address,
    signatureScheme: 'eip191',
    signature,
  });
}

/**
 * A SELLER'S OWN SIGN-IN CHALLENGE: a 402 that lists no way to pay and carries
 * the standard `sign-in-with-x` extension, as Monid answers a poll of a run it
 * was paid for. The seller names its own nonce and a five-minute expiry, which
 * {@link buildSiwxHeader} cannot sign, since it mints its own nonce to sign in
 * to Tenjin. Any 402 that offers a payment is not one, so the path that
 * answers this never meets a price. The challenge is decoded seller JSON, so
 * it can be any value: one that is not an object is not a challenge.
 */
export function signInOnlyChallenge(challenge: PaymentRequired | null): SIWxExtension | undefined {
  if (typeof challenge !== 'object' || challenge === null) return undefined;
  if (!Array.isArray(challenge.accepts) || challenge.accepts.length > 0) return undefined;
  const extension = challenge.extensions?.[SIGN_IN_WITH_X] as Partial<SIWxExtension> | undefined;
  const info = extension?.info as Partial<SIWxExtension['info']> | undefined;
  if (info === undefined || info === null || typeof info !== 'object') return undefined;
  if (typeof info.domain !== 'string' || typeof info.uri !== 'string') return undefined;
  if (typeof info.nonce !== 'string' || !Array.isArray(extension?.supportedChains)) {
    return undefined;
  }
  return extension as SIWxExtension;
}

/** Why a seller's sign-in challenge was not signed. */
export type SignInRefusal = 'origin' | 'unpaid' | 'unsigned';

/** The headers that answer the challenge, or why it was not signed: a
 *  lower-case clause each caller frames as its own sentence. */
export type SignInAnswer =
  { headers: Record<string, string> } | { refused: SignInRefusal; reason: string };

/** The wallet a seller's challenge would be signed with, opened last. */
export interface SignInWallet {
  /** Its address, read without opening it, once the challenge is bound. */
  address: () => Promise<string>;
  /** Whether that address paid `host`, by the local payment ledger. */
  paidHost: (host: string, address: string) => Promise<boolean>;
  /** Opens the wallet; called only after both checks pass. */
  signer: () => Promise<TenjinSigner>;
}

/** A seller's text, bounded, for a line that names it. */
function named(value: unknown): string {
  return sanitizeForTerminal(String(value)).slice(0, 200);
}

/**
 * ANSWER A SELLER'S SIGN-IN CHALLENGE, OR SAY WHY NOT. The stock
 * `createSIWxClientHook` signs the seller's own challenge (its nonce, its
 * expiry), and only when both of these hold:
 *
 * 1. The challenge's `domain` and `uri` origin are the URL that sent it: the
 *    spec has a client refuse one that differs. Checked before the wallet is
 *    opened.
 * 2. This wallet paid that host, by the local payment ledger. That
 *    seller already holds the address from the payment, so the signature
 *    tells it only that this is the wallet that paid.
 *
 * Nothing here is a payment: the 402 offered none, and none is built.
 */
export async function answerSignInChallenge(
  challenge: PaymentRequired,
  extension: SIWxExtension,
  url: string,
  wallet: SignInWallet,
): Promise<SignInAnswer> {
  const target = new URL(url);
  try {
    assertSIWxChallengeBoundToOrigin(extension.info, target);
  } catch {
    return {
      refused: 'origin',
      reason: `its challenge names ${named(extension.info.domain)} and ${named(extension.info.uri)}, not the URL that sent it`,
    };
  }
  const unpaid: SignInAnswer = {
    refused: 'unpaid',
    reason: `this wallet has not paid ${target.host}`,
  };
  const address = await wallet.address();
  if (!(await wallet.paidHost(target.host, address))) return unpaid;
  const signer = await wallet.signer();
  // The wallet that opened is the one the ledger was read for, or nothing is signed.
  if (signer.address.toLowerCase() !== address.toLowerCase()) return unpaid;
  const answered = await createSIWxClientHook(signer)({
    paymentRequired: challenge,
    requestUrl: url,
  });
  // The stock hook answers nothing, rather than throwing, both for a challenge
  // with no chain this wallet signs for and for one it could not sign (a
  // field a sign-in message cannot carry, a signer that failed).
  if (answered === undefined || Object.keys(answered.headers).length === 0) {
    return {
      refused: 'unsigned',
      reason:
        'its challenge could not be signed: it names no eip191 chain, or its fields are not a valid sign-in message',
    };
  }
  return { headers: answered.headers };
}
