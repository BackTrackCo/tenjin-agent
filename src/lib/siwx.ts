import { randomUUID } from 'node:crypto';
import { createSIWxMessage, encodeSIWxHeader } from '@x402/extensions/sign-in-with-x';
import type { TenjinSigner } from './wallet/provider';

/**
 * Build the `SIGN-IN-WITH-X` header a returning buyer sends to re-read an owned
 * post for free (llms-full: Tenjin's SIWX is CLIENT-driven, no server challenge,
 * a client-minted single-use nonce, so `wrapFetchWithSIWx` does NOT apply). The
 * `domain` MUST be the site host INCLUDING any port (preview/local run on a port),
 * and `chainId` is the CAIP-2 network the live 402 advertised.
 */
export const SIWX_HEADER = 'SIGN-IN-WITH-X';

export interface BuildSiwxOptions {
  baseUrl: string;
  chainId: string;
  /** Validity window in ms (default 24h, the server's cap). */
  ttlMs?: number;
  /**
   * CAIP-122 `resources` URNs to bind into the signed message. Empty/omitted for
   * a plain sign-in; the session-key layer (B3, D35) passes the three
   * `urn:tenjin:session:*` URNs so one wallet signature delegates a P-256 key.
   */
  resources?: string[];
  /** Override the human-readable statement (session delegation says so plainly). */
  statement?: string;
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
    statement: opts.statement ?? 'Sign in to Tenjin.',
    ...(opts.resources !== undefined && opts.resources.length > 0
      ? { resources: opts.resources }
      : {}),
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
