import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  createSIWxMessage,
  encodeSIWxHeader,
  parseSIWxHeader,
} from '@x402/extensions/sign-in-with-x';
import { buildSiwxHeader, SIWX_HEADER, type BuildSiwxOptions } from './siwx';
import { delegationResources } from './session-key';
import { testSigner } from './read-test-utils';
import type { TenjinSigner } from './wallet/provider';

describe('buildSiwxHeader', () => {
  it('is the SIGN-IN-WITH-X header name', () => {
    expect(SIWX_HEADER).toBe('SIGN-IN-WITH-X');
  });

  it('signs over the site host (WITH port) and the advertised chainId', async () => {
    const signer = testSigner();
    const header = await buildSiwxHeader(signer, {
      baseUrl: 'http://localhost:3000',
      chainId: 'eip155:8453',
    });
    const payload = parseSIWxHeader(header) as Record<string, unknown>;
    expect(payload.domain).toBe('localhost:3000');
    expect(payload.chainId).toBe('eip155:8453');
    expect(String(payload.address).toLowerCase()).toBe(signer.address.toLowerCase());
    expect(payload.signatureScheme).toBe('eip191');
  });

  it('mints a fresh single-use nonce per call', async () => {
    const signer = testSigner();
    const a = parseSIWxHeader(
      await buildSiwxHeader(signer, { baseUrl: 'https://tenjin.blog', chainId: 'eip155:8453' }),
    ) as Record<string, unknown>;
    const b = parseSIWxHeader(
      await buildSiwxHeader(signer, { baseUrl: 'https://tenjin.blog', chainId: 'eip155:8453' }),
    ) as Record<string, unknown>;
    expect(a.nonce).not.toBe(b.nonce);
  });
});

/**
 * The header as the x402 SDK built it before viem's `createSiweMessage` took
 * over, from the same options, clock and nonce. A signer here is deterministic
 * (RFC 6979), so equal headers mean equal signed messages too.
 */
async function sdkHeader(
  signer: TenjinSigner,
  opts: BuildSiwxOptions,
  now: number,
  nonce: string,
): Promise<{ message: string; header: string }> {
  const url = new URL(opts.baseUrl);
  const info = {
    domain: url.host,
    uri: `${url.protocol}//${url.host}`,
    version: '1',
    chainId: opts.chainId as `${string}:${string}`,
    type: 'eip191' as const,
    nonce,
    issuedAt: new Date(now).toISOString(),
    expirationTime: new Date(now + (opts.ttlMs ?? 86_400_000)).toISOString(),
    statement: opts.statement ?? 'Sign in to Tenjin.',
    ...(opts.resources !== undefined && opts.resources.length > 0
      ? { resources: opts.resources }
      : {}),
  };
  const message = createSIWxMessage(info, signer.address);
  const signature = await signer.signMessage({ message });
  const header = encodeSIWxHeader({
    ...info,
    address: signer.address,
    signatureScheme: 'eip191',
    signature,
  });
  return { message, header };
}

describe('buildSiwxHeader matches the x402 SDK byte for byte', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const NOW = Date.parse('2026-10-24T12:34:56.789Z');
  const DAY_MS = 24 * 60 * 60 * 1000;

  it.each<[string, BuildSiwxOptions]>([
    ['a plain sign-in', { baseUrl: 'https://tenjin.sh', chainId: 'eip155:8453' }],
    ['a host with a port', { baseUrl: 'http://localhost:3000', chainId: 'eip155:84532' }],
    [
      "a seller's origin on an IP and port",
      { baseUrl: 'http://127.0.0.1:4021/x', chainId: 'eip155:8453' },
    ],
    [
      'a session-key delegation',
      {
        baseUrl: 'https://tenjin.sh',
        chainId: 'eip155:8453',
        ttlMs: DAY_MS,
        statement: 'Delegate a Tenjin session key.',
        resources: delegationResources(
          'BHq2F8kQ0oZ-r1_Xs3Vn7mJcT9yLwA4eDpUiGf6bNtRzKxYhOaS2lMvC5uE8jWd0n3sPq7tH1gZcVfBi_kL9mRo',
          new Date(NOW + DAY_MS).toISOString(),
          'read+write',
        ),
      },
    ],
  ])('%s', async (_name, opts) => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const base = testSigner();
    const signed: string[] = [];
    const signer: TenjinSigner = {
      ...base,
      signMessage: (args) => {
        signed.push(args.message);
        return base.signMessage(args);
      },
    };

    const header = await buildSiwxHeader(signer, opts);
    const { nonce } = parseSIWxHeader(header);
    const expected = await sdkHeader(base, opts, NOW, nonce);

    expect(signed).toEqual([expected.message]);
    expect(header).toBe(expected.header);
  });
});
