import { randomBytes } from 'node:crypto';
import { createSIWxPayload, encodeSIWxHeader } from '@x402/extensions/sign-in-with-x';
import { CliError } from './errors';
import type { TenjinSigner } from './wallet/provider';

/**
 * Client-driven SIWX (CAIP-122): there is no server challenge round trip. The
 * client mints nonce + issuedAt itself, signs the reconstructed EIP-4361 string
 * with EIP-191, and the server verifies statelessly (24h max age). Reads never
 * burn the nonce but a header is still built fresh per request: reusing one
 * across requests is indistinguishable from a replay to any future policy.
 *
 * `domain` must be the bare hostname of the base URL (the server compares
 * against its allowed-hosts list without a port); `uri` must share the base
 * URL's origin. Both derive from the configured base URL rather than a
 * challenge, so SIWX works for the entitled precheck before any 402 is seen.
 */
export interface SiwxOptions {
  baseUrl: string;
  /** CAIP-2 chain, from the 402 challenge when available. */
  chainId?: string;
  statement?: string;
}

export const DEFAULT_CHAIN_ID = 'eip155:8453';

export async function buildSiwxHeader(signer: TenjinSigner, opts: SiwxOptions): Promise<string> {
  let base: URL;
  try {
    base = new URL(opts.baseUrl);
  } catch {
    throw new CliError('USAGE', `Invalid base URL: ${JSON.stringify(opts.baseUrl)}`, {
      fix: 'Pass an absolute http(s) URL via --base-url or `tenjin config set baseUrl <url>`.',
    });
  }
  const payload = await createSIWxPayload(
    {
      domain: base.hostname,
      uri: base.origin,
      version: '1',
      // EIP-4361 restricts the nonce to alphanumerics; hex keeps every draw
      // valid (base64url's '-'/'_' made ~half of all builds throw in siwe-parser).
      nonce: randomBytes(16).toString('hex'),
      issuedAt: new Date().toISOString(),
      chainId: opts.chainId ?? DEFAULT_CHAIN_ID,
      type: 'eip191',
      signatureScheme: 'eip191',
      ...(opts.statement !== undefined ? { statement: opts.statement } : {}),
    },
    {
      address: signer.address,
      signMessage: ({ message }: { message: string }) => signer.signMessage({ message }),
    },
  );
  return encodeSIWxHeader(payload);
}
