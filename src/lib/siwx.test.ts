import { describe, it, expect } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { verifyMessage } from 'viem';
import {
  parseSIWxHeader,
  verifySIWxSignature,
  createSIWxMessage,
} from '@x402/extensions/sign-in-with-x';
import type { SIWxPayload } from '@x402/extensions/sign-in-with-x';
import { buildSiwxHeader, DEFAULT_CHAIN_ID } from './siwx';
import { CliError } from './errors';
import type { TenjinSigner } from './wallet/provider';

const TEST_KEY = `0x${'ab'.repeat(32)}` as const;
const account = privateKeyToAccount(TEST_KEY);
const signer: TenjinSigner = {
  address: account.address,
  signMessage: (args) => account.signMessage({ message: args.message }),
  signTypedData: (args) => account.signTypedData(args),
};

function decode(header: string): SIWxPayload {
  return parseSIWxHeader(header);
}

// buildSiwxHeader is async, so a synchronous throw inside it still surfaces as
// a rejected promise, never a thrown value at the call site.
async function caught(fn: () => Promise<unknown>): Promise<CliError> {
  const err = await fn().catch((e: unknown) => e);
  expect(err).toBeInstanceOf(CliError);
  return err as CliError;
}

describe('buildSiwxHeader', () => {
  it('encodes a header that parseSIWxHeader accepts, with a signature verifysIWxSignature accepts', async () => {
    const header = await buildSiwxHeader(signer, { baseUrl: 'https://tenjin.blog' });
    const payload = decode(header);
    expect(payload.address.toLowerCase()).toBe(account.address.toLowerCase());
    const result = await verifySIWxSignature(payload);
    expect(result.valid).toBe(true);
    expect(result.address?.toLowerCase()).toBe(account.address.toLowerCase());
  });

  it('derives domain as the bare hostname and uri as the origin', async () => {
    const header = await buildSiwxHeader(signer, { baseUrl: 'https://tenjin.blog' });
    const payload = decode(header);
    expect(payload.domain).toBe('tenjin.blog');
    expect(payload.uri).toBe('https://tenjin.blog');
  });

  it('strips the port from domain for a localhost base URL, keeping it in uri', async () => {
    const header = await buildSiwxHeader(signer, { baseUrl: 'http://localhost:3000' });
    const payload = decode(header);
    expect(payload.domain).toBe('localhost');
    expect(payload.domain).not.toContain(':');
    expect(payload.uri).toBe('http://localhost:3000');
  });

  it('sets version to 1', async () => {
    const header = await buildSiwxHeader(signer, { baseUrl: 'https://tenjin.blog' });
    expect(decode(header).version).toBe('1');
  });

  it('defaults chainId to eip155:8453', async () => {
    const header = await buildSiwxHeader(signer, { baseUrl: 'https://tenjin.blog' });
    expect(decode(header).chainId).toBe(DEFAULT_CHAIN_ID);
    expect(DEFAULT_CHAIN_ID).toBe('eip155:8453');
  });

  it('honors a chainId override from the 402 challenge', async () => {
    const header = await buildSiwxHeader(signer, {
      baseUrl: 'https://tenjin.blog',
      chainId: 'eip155:84532',
    });
    expect(decode(header).chainId).toBe('eip155:84532');
  });

  it('signs with type eip191', async () => {
    const header = await buildSiwxHeader(signer, { baseUrl: 'https://tenjin.blog' });
    expect(decode(header).type).toBe('eip191');
  });

  it('mints a fresh nonce every call, even for the same base URL', async () => {
    const a = decode(await buildSiwxHeader(signer, { baseUrl: 'https://tenjin.blog' }));
    const b = decode(await buildSiwxHeader(signer, { baseUrl: 'https://tenjin.blog' }));
    expect(a.nonce).not.toBe(b.nonce);
  });

  // EIP-4361 restricts the nonce to alphanumerics; hex satisfies it on every
  // draw. Loop enough real (unmocked) builds that a re-introduced unsafe
  // alphabet (the original base64url bug hit ~half of draws) cannot slip by.
  it('every real nonce is EIP-4361-safe lowercase hex', async () => {
    for (let i = 0; i < 8; i += 1) {
      const payload = decode(await buildSiwxHeader(signer, { baseUrl: 'https://tenjin.blog' }));
      expect(payload.nonce).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it('stamps issuedAt as a parseable ISO timestamp close to now', async () => {
    const before = Date.now();
    const payload = decode(await buildSiwxHeader(signer, { baseUrl: 'https://tenjin.blog' }));
    const parsed = Date.parse(payload.issuedAt);
    expect(Number.isNaN(parsed)).toBe(false);
    expect(parsed).toBeGreaterThanOrEqual(before - 1000);
    expect(parsed).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('omits statement when not given, includes it verbatim when given', async () => {
    const bare = decode(await buildSiwxHeader(signer, { baseUrl: 'https://tenjin.blog' }));
    expect(bare.statement).toBeUndefined();
    const withStatement = decode(
      await buildSiwxHeader(signer, {
        baseUrl: 'https://tenjin.blog',
        statement: 'Sign in to Tenjin',
      }),
    );
    expect(withStatement.statement).toBe('Sign in to Tenjin');
  });

  it('the signature independently recovers to the signer via viem verifyMessage over createSIWxMessage', async () => {
    const payload = decode(await buildSiwxHeader(signer, { baseUrl: 'https://tenjin.blog' }));
    const message = createSIWxMessage(payload, payload.address);
    const valid = await verifyMessage({
      address: payload.address as `0x${string}`,
      message,
      signature: payload.signature as `0x${string}`,
    });
    expect(valid).toBe(true);
  });

  it.each(['not a url', ''])(
    'rejects an unparseable base URL (%j) as a USAGE CliError',
    async (bad) => {
      const err = await caught(() => buildSiwxHeader(signer, { baseUrl: bad }));
      expect(err.code).toBe('USAGE');
      expect(err.fix).toContain('--base-url');
    },
  );
});
