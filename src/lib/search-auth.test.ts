import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliError } from './errors';
import { searchHeaders, walletFileExists } from './search-auth';
import { saveSessionFile } from './session-key';
import { testSessionKey } from './read-test-utils';
import { walletPath } from './paths';
import type { WriteAuth } from './session-key';

/**
 * The one signing path for every search the CLI and the daemon make.
 *
 * Three outcomes and nothing else, because the caller ROUTES on them: `signed`
 * goes to the shelf route, `no-wallet` is an ordinary public-only machine, and
 * `unauthenticated` falls back to the public route with the reason on the row.
 * A credential failure never withholds a public answer, so none of these throws.
 */

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-search-auth-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ORIGIN = 'https://tenjin.blog';
const REQ = { method: 'POST', url: `${ORIGIN}/api/search`, body: '{}' } as const;
const NOW = Date.parse('2026-09-14T00:00:00Z');

function opts(over: Partial<Parameters<typeof searchHeaders>[2]> = {}) {
  return { now: () => NOW, env: {} as NodeJS.ProcessEnv, mint: null, ...over };
}

/** A mint that records whether it was reached. */
function mint(headers: Record<string, string> = { 'X-Stub': '1' }) {
  let calls = 0;
  const fn = async (): Promise<WriteAuth> => {
    calls += 1;
    return {
      headersFor: async () => headers,
      recover: () => false,
    } as unknown as WriteAuth;
  };
  return { fn, calls: () => calls };
}

/** A wallet file, for the branch that asks whether one exists at all. */
function seedWallet(): void {
  writeFileSync(walletPath(dir), '{"address":"0xabc"}');
}

describe('searchHeaders', () => {
  it('signs with a cached delegation, and never reaches the mint', async () => {
    const { file } = await testSessionKey({ origin: ORIGIN });
    await saveSessionFile(dir, file);
    const m = mint();
    const result = await searchHeaders(dir, REQ, opts({ mint: m.fn }));
    expect(result.kind).toBe('signed');
    if (result.kind !== 'signed') return;
    // The real RFC 9421 set, not the stub's: the cached key did the signing.
    expect(result.headers['Tenjin-Session-Delegation']).toBe(file.delegation);
    expect(result.headers['Signature-Input']).toContain('keyid=');
    expect(result.headers['Content-Digest']).toBeDefined();
    // ORDER IS COST: minting decrypts the keystore, so it is not consulted
    // while a presentable session exists.
    expect(m.calls()).toBe(0);
  });

  it('mints when the cached delegation is for another origin, and signs with that', async () => {
    // A stale file bound to the old shelf origin is simply not presentable and
    // re-mints, which is what let `session_origin_mismatch` be deleted.
    const { file } = await testSessionKey({ origin: 'https://old-shelf.example' });
    await saveSessionFile(dir, file);
    const m = mint();
    const result = await searchHeaders(dir, REQ, opts({ mint: m.fn }));
    expect(result).toEqual({ kind: 'signed', headers: { 'X-Stub': '1' } });
    expect(m.calls()).toBe(1);
  });

  it('mints when the cached delegation has expired', async () => {
    const { file } = await testSessionKey({ origin: ORIGIN });
    await saveSessionFile(dir, { ...file, exp: new Date(NOW - 1000).toISOString() });
    const m = mint();
    expect(await searchHeaders(dir, REQ, opts({ mint: m.fn }))).toEqual({
      kind: 'signed',
      headers: { 'X-Stub': '1' },
    });
    expect(m.calls()).toBe(1);
  });

  /**
   * NO WALLET IS A CONFIGURATION, NOT A FAILURE. The mint is what answers the
   * question: `WALLET_MISSING` is the one refusal that means "there is nothing
   * here to sign with", and asking the filesystem instead would be a second
   * source of truth that gets it wrong for any caller supplying its own
   * provider.
   */
  it('is no-wallet when the mint says there is no wallet', async () => {
    const result = await searchHeaders(
      dir,
      REQ,
      opts({
        mint: async () => {
          throw new CliError('WALLET_MISSING', 'No wallet found.');
        },
      }),
    );
    expect(result).toEqual({ kind: 'no-wallet' });
  });

  it('is unauthenticated, with the error CLASS, when the wallet will not open', async () => {
    const result = await searchHeaders(
      dir,
      REQ,
      opts({
        mint: async () => {
          throw new CliError('USAGE', 'No wallet passphrase is available.', {
            fix: 'Set TENJIN_WALLET_PASSPHRASE.',
          });
        },
      }),
    );
    // The CLASS, never the message: this string lands in a ledger column and in
    // a doctor line, and a keystore error's message can carry a path.
    expect(result).toEqual({ kind: 'unauthenticated', detail: 'USAGE' });
  });

  it('is unauthenticated when a non-CliError escapes the mint', async () => {
    const result = await searchHeaders(
      dir,
      REQ,
      opts({
        mint: async () => {
          throw new TypeError('boom');
        },
      }),
    );
    expect(result).toEqual({ kind: 'unauthenticated', detail: 'TypeError' });
  });

  /**
   * `mint: null` is doctor's rule, not an omission: a diagnostic verb presents a
   * cached session and creates nothing. With nothing cached, the file is all it
   * has to go on, and that is the right question for it.
   */
  it('with mint null, reports what is on disk and creates nothing', async () => {
    expect(await searchHeaders(dir, REQ, opts())).toEqual({ kind: 'no-wallet' });
    seedWallet();
    expect(await searchHeaders(dir, REQ, opts())).toEqual({
      kind: 'unauthenticated',
      detail: 'no session is cached',
    });
    const { file } = await testSessionKey({ origin: ORIGIN });
    await saveSessionFile(dir, file);
    expect((await searchHeaders(dir, REQ, opts())).kind).toBe('signed');
  });

  it('is unauthenticated for a URL with no origin to bind to', async () => {
    const m = mint();
    const result = await searchHeaders(
      dir,
      { method: 'POST', url: 'not-a-url', body: '{}' },
      opts({ mint: m.fn }),
    );
    expect(result.kind).toBe('unauthenticated');
    expect(m.calls()).toBe(0);
  });
});

describe('walletFileExists', () => {
  it('is false on an empty data dir and true once a wallet is there', () => {
    expect(walletFileExists(dir, {})).toBe(false);
    seedWallet();
    expect(walletFileExists(dir, {})).toBe(true);
  });

  it('counts the env key, which is a credential with no file behind it', () => {
    expect(walletFileExists(dir, { TENJIN_WALLET_KEY: '0x' + 'a'.repeat(64) })).toBe(true);
    expect(walletFileExists(dir, { TENJIN_WALLET_KEY: '' })).toBe(false);
  });
});
