import { describe, it, expect } from 'vitest';
import { parseSIWxHeader } from '@x402/extensions/sign-in-with-x';
import { buildSiwxHeader, signInOnlyChallenge, SIWX_HEADER } from './siwx';
import { testSigner } from './read-test-utils';

describe('signInOnlyChallenge', () => {
  // A POST poll's PAYMENT-REQUIRED that decoded to JSON null threw on
  // `challenge.accepts`, out of the poll.
  it('reads a challenge that is not an object as no sign-in', () => {
    expect(signInOnlyChallenge(null)).toBeUndefined();
    expect(signInOnlyChallenge(7 as never)).toBeUndefined();
    expect(signInOnlyChallenge('402' as never)).toBeUndefined();
  });
});

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
