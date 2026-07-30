import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, stat, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSessionKeyAuth,
  createSiwxAuth,
  delegationResources,
  establishSession,
  loadSessionFile,
  saveSessionFile,
  recoveryFor,
  SESSION_CHAIN_ID,
} from './session-key';
import { privateKeyToAccount } from 'viem/accounts';
import { sessionPath } from './paths';
import { testSessionKey, testSigner } from './read-test-utils';
import type { TenjinSigner } from './wallet/provider';

/**
 * The MINT half: establishing a delegation, caching it, and the two WriteAuth
 * implementations. The present-only half it re-exports (RFC 9421 primitives,
 * signWithSession, loadSessionFile, the usability predicates) is covered in
 * session-present.test.ts, where `read` can reach it.
 */

/** A second, distinct signer (a different wallet address) for swap-invalidation. */
function otherSigner(): TenjinSigner {
  const account = privateKeyToAccount(
    '0x0123456789012345678901234567890123456789012345678901234567890123',
  );
  return {
    address: account.address,
    signMessage: (a) => account.signMessage({ message: a.message }),
    signTypedData: (a) => account.signTypedData(a),
    signTransaction: (tx) => account.signTransaction(tx),
  };
}

describe('the session chain id is shared, not re-declared per caller', () => {
  it('is Base mainnet, the chain the server constrains SIWX to', () => {
    expect(SESSION_CHAIN_ID).toBe('eip155:8453');
  });
});

describe('delegation URN construction (D35)', () => {
  it('binds pubkey/exp/scope as the three tenjin session URNs', () => {
    const urns = delegationResources('PUBB64URL', '2026-07-22T00:00:00.000Z', 'read+write');
    expect(urns).toEqual([
      'urn:tenjin:session:pubkey:p256:PUBB64URL',
      'urn:tenjin:session:exp:2026-07-22T00:00:00.000Z',
      'urn:tenjin:session:scope:read+write',
    ]);
  });
});

describe('recoveryFor maps every documented 401 code', () => {
  it.each([
    ['proof_expired', 'resign'],
    ['session_expired', 'reestablish'],
    ['proof_revoked', 'reestablish'],
    ['insufficient_scope', 'reestablish'],
    ['session_key_unbound', 'fatal'],
    [undefined, 'fatal'],
    ['something_else', 'fatal'],
  ])('%s -> %s', (code, expected) => {
    expect(recoveryFor(code as string | undefined)).toBe(expected);
  });
});

describe('establishSession + cache (0600, address-bound)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tenjin-session-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function config(signer: TenjinSigner = testSigner()) {
    return {
      signer,
      baseUrl: 'https://tenjin.blog',
      chainId: 'eip155:8453',
      dataDir: dir,
      scope: 'read+write' as const,
    };
  }

  it('wallet-signs once, binds the URNs, and caches the delegation + key 0600', async () => {
    const signer = testSigner();
    let signs = 0;
    const spy: TenjinSigner = {
      address: signer.address,
      signMessage: (a) => {
        signs++;
        return signer.signMessage(a);
      },
      signTypedData: (a) => signer.signTypedData(a),
      signTransaction: (tx) => signer.signTransaction(tx),
    };
    const file = await establishSession(config(spy));
    expect(signs).toBe(1);
    expect(file.address).toBe(signer.address.toLowerCase());
    expect(file.scope).toBe('read+write');
    expect(file.publicKeyRaw.length).toBeGreaterThan(0);

    const onDisk = await loadSessionFile(dir);
    expect(onDisk?.delegation).toBe(file.delegation);
    if (process.platform !== 'win32') {
      const mode = (await stat(sessionPath(dir))).mode & 0o777;
      expect(mode).toBe(0o600);
    }
    // The delegation is a base64 SIWX header binding the three URNs.
    const decoded = Buffer.from(file.delegation, 'base64').toString('utf8');
    const payload = JSON.parse(decoded) as { resources?: string[] };
    expect(payload.resources).toEqual(
      delegationResources(file.publicKeyRaw, file.exp, 'read+write'),
    );
  });
});

describe('createSessionKeyAuth reuses a cached session (no second wallet signature)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tenjin-session-auth-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function spySigner(): { signer: TenjinSigner; count: () => number } {
    const inner = testSigner();
    let n = 0;
    return {
      signer: {
        address: inner.address,
        signMessage: (a) => {
          n++;
          return inner.signMessage(a);
        },
        signTypedData: (a) => inner.signTypedData(a),
        signTransaction: (tx) => inner.signTransaction(tx),
      },
      count: () => n,
    };
  }

  it('mints on first use, then signs subsequent writes with the P-256 key only', async () => {
    const { signer, count } = spySigner();
    const config = {
      signer,
      baseUrl: 'https://tenjin.blog',
      chainId: 'eip155:8453',
      dataDir: dir,
      scope: 'read+write' as const,
    };

    const auth1 = createSessionKeyAuth(config);
    const h1 = await auth1.headersFor({
      method: 'POST',
      url: 'https://tenjin.blog/api/posts',
      body: '{}',
    });
    expect(count()).toBe(1); // one wallet signature to establish
    expect(h1['Signature-Input']).toMatch(/^tenjin=/);

    // A brand-new auth over the SAME dataDir loads the cached session: zero more
    // wallet signatures, still a valid session signature.
    const auth2 = createSessionKeyAuth(config);
    const h2 = await auth2.headersFor({
      method: 'POST',
      url: 'https://tenjin.blog/api/posts',
      body: '{}',
    });
    expect(count()).toBe(1);
    expect(h2['Tenjin-Session-Delegation']).toBe(h1['Tenjin-Session-Delegation']);
  });

  it('recover(reestablish-code) forces one fresh wallet signature; fatal code does not retry', async () => {
    const { signer, count } = spySigner();
    const config = {
      signer,
      baseUrl: 'https://tenjin.blog',
      chainId: 'eip155:8453',
      dataDir: dir,
      scope: 'read+write' as const,
    };
    const auth = createSessionKeyAuth(config);
    await auth.headersFor({ method: 'POST', url: 'https://tenjin.blog/api/posts', body: '{}' });
    expect(count()).toBe(1);

    expect(await auth.recover('proof_expired')).toBe(true); // re-sign, no wallet
    await auth.headersFor({ method: 'POST', url: 'https://tenjin.blog/api/posts', body: '{}' });
    expect(count()).toBe(1);

    expect(await auth.recover('session_expired')).toBe(true); // re-establish
    await auth.headersFor({ method: 'POST', url: 'https://tenjin.blog/api/posts', body: '{}' });
    expect(count()).toBe(2);

    expect(await auth.recover('session_key_unbound')).toBe(false); // fatal
  });

  it('a wallet swap invalidates the cached session (re-establishes under the new key)', async () => {
    const first = spySigner();
    const config1 = {
      signer: first.signer,
      baseUrl: 'https://tenjin.blog',
      chainId: 'eip155:8453',
      dataDir: dir,
      scope: 'read+write' as const,
    };
    const h1 = await createSessionKeyAuth(config1).headersFor({
      method: 'POST',
      url: 'https://tenjin.blog/api/posts',
      body: '{}',
    });
    expect(first.count()).toBe(1);

    // A different wallet over the SAME dataDir: the cached session is address-bound
    // to the first wallet, so it is not reused — the new wallet signs a fresh one.
    const swapped = otherSigner();
    let swapSigns = 0;
    const swapSpy: TenjinSigner = {
      address: swapped.address,
      signMessage: (a) => {
        swapSigns++;
        return swapped.signMessage(a);
      },
      signTypedData: (a) => swapped.signTypedData(a),
      signTransaction: (tx) => swapped.signTransaction(tx),
    };
    const h2 = await createSessionKeyAuth({
      signer: swapSpy,
      baseUrl: 'https://tenjin.blog',
      chainId: 'eip155:8453',
      dataDir: dir,
      scope: 'read+write',
    }).headersFor({ method: 'POST', url: 'https://tenjin.blog/api/posts', body: '{}' });
    expect(swapSigns).toBe(1);
    expect(h2['Tenjin-Session-Delegation']).not.toBe(h1['Tenjin-Session-Delegation']);
    expect(first.count()).toBe(1); // the first wallet was never asked to sign again
  });
});

describe('createSiwxAuth (plain-SIWX fallback)', () => {
  it('signs each write with a fresh SIGN-IN-WITH-X header (one wallet sig per write)', async () => {
    const inner = testSigner();
    let n = 0;
    const signer: TenjinSigner = {
      address: inner.address,
      signMessage: (a) => {
        n++;
        return inner.signMessage(a);
      },
      signTypedData: (a) => inner.signTypedData(a),
      signTransaction: (tx) => inner.signTransaction(tx),
    };
    const auth = createSiwxAuth({
      signer,
      baseUrl: 'https://tenjin.blog',
      chainId: 'eip155:8453',
      dataDir: '/nonexistent',
      scope: 'read+write',
    });
    const h = await auth.headersFor({
      method: 'POST',
      url: 'https://tenjin.blog/api/posts',
      body: '{}',
    });
    expect(h['SIGN-IN-WITH-X']).toBeDefined();
    expect(n).toBe(1);
    expect(await auth.recover('nonce_already_used')).toBe(true);
    expect(await auth.recover('session_key_unbound')).toBe(false);
  });
});

describe('createSessionKeyAuth recovers from a bad on-disk session', () => {
  let d: string;
  beforeEach(async () => {
    d = await mkdtemp(join(tmpdir(), 'tenjin-session-recover-'));
  });
  afterEach(async () => {
    await rm(d, { recursive: true, force: true });
  });

  function countingSigner(): { signer: TenjinSigner; count: () => number } {
    const inner = testSigner();
    let n = 0;
    return {
      count: () => n,
      signer: {
        address: inner.address,
        signMessage: (a) => {
          n++;
          return inner.signMessage(a);
        },
        signTypedData: (a) => inner.signTypedData(a),
        signTransaction: (tx) => inner.signTransaction(tx),
      },
    };
  }

  const req = { method: 'POST' as const, url: 'https://tenjin.blog/api/posts', body: '{}' };

  it('re-establishes exactly once from a corrupt session.json', async () => {
    await mkdir(d, { recursive: true });
    await writeFile(sessionPath(d), 'garbage', { mode: 0o600 });
    const { signer, count } = countingSigner();
    const auth = createSessionKeyAuth({
      signer,
      baseUrl: 'https://tenjin.blog',
      chainId: 'eip155:8453',
      dataDir: d,
      scope: 'read+write',
    });
    await auth.headersFor(req);
    expect(count()).toBe(1); // one fresh establish
    await auth.headersFor(req);
    expect(count()).toBe(1); // then reuses the freshly written session
  });

  it('re-establishes from an expired on-disk session', async () => {
    const { signer, count } = countingSigner();
    const { file } = await testSessionKey();
    await saveSessionFile(d, {
      ...file,
      address: signer.address.toLowerCase(),
      exp: new Date(Date.now() - 1000).toISOString(), // already expired
    });
    const auth = createSessionKeyAuth({
      signer,
      baseUrl: 'https://tenjin.blog',
      chainId: 'eip155:8453',
      dataDir: d,
      scope: 'read+write',
    });
    await auth.headersFor(req);
    expect(count()).toBe(1);
  });
});
