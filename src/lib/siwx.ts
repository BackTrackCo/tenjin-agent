import { randomUUID } from 'node:crypto';
import { createSiweMessage } from 'viem/siwe';
import type { TenjinSigner } from './wallet/provider';

/**
 * Build the `SIGN-IN-WITH-X` header a returning buyer sends to re-read an owned
 * post for free (llms-full: Tenjin's SIWX is CLIENT-driven, no server challenge,
 * a client-minted single-use nonce, so `wrapFetchWithSIWx` does NOT apply). The
 * `domain` MUST be the site host INCLUDING any port (preview/local run on a port),
 * and `chainId` is the CAIP-2 network the live 402 advertised.
 */
export const SIWX_HEADER = 'SIGN-IN-WITH-X';

/** The key a 402 advertises the sign-in-with-x extension under, in its `extensions`. */
export const SIGN_IN_WITH_X = 'sign-in-with-x';

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
  const issuedAt = new Date(now);
  const expirationTime = new Date(now + (opts.ttlMs ?? 86_400_000));
  const resources =
    opts.resources !== undefined && opts.resources.length > 0 ? opts.resources : undefined;
  const info = {
    domain: url.host, // host, WITH port, matches the server's host-with-port compare
    uri: `${url.protocol}//${url.host}`,
    version: '1' as const,
    chainId: opts.chainId,
    type: 'eip191' as const,
    nonce: randomUUID().replace(/-/g, ''),
    issuedAt: issuedAt.toISOString(),
    expirationTime: expirationTime.toISOString(),
    statement: opts.statement ?? 'Sign in to Tenjin.',
    ...(resources !== undefined ? { resources } : {}),
  };
  // The EIP-4361 message x402's `createSIWxMessage` builds for an `eip155:*`
  // chain, byte for byte (siwx.test.ts), without the SDK's Solana stack.
  const message = createSiweMessage({
    domain: info.domain,
    address: signer.address,
    statement: info.statement,
    uri: info.uri,
    version: info.version,
    chainId: evmChainId(info.chainId),
    nonce: info.nonce,
    issuedAt,
    expirationTime,
    resources,
  });
  const signature = await signer.signMessage({ message });
  // x402's `encodeSIWxHeader`: base64 of the JSON payload.
  const payload = { ...info, address: signer.address, signatureScheme: 'eip191', signature };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

/** `eip155:8453` -> 8453. A wallet here is an EVM account, so no other namespace can sign. */
function evmChainId(chainId: string): number {
  const match = /^eip155:(\d+)$/.exec(chainId);
  if (match === null) {
    throw new Error(`Invalid EVM chainId format: ${chainId}. Expected eip155:<number>`);
  }
  return Number(match[1]);
}
