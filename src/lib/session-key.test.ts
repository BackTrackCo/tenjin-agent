import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, stat, mkdir, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { webcrypto } from 'node:crypto';
import {
  contentDigest,
  createSessionKeyAuth,
  createSiwxAuth,
  delegationResources,
  establishSession,
  isSessionUsable,
  loadSessionFile,
  saveSessionFile,
  recoveryFor,
  signWithSession,
  signatureBase,
  signatureParams,
  targetUri,
  type SessionFile,
} from './session-key';
import { privateKeyToAccount } from 'viem/accounts';
import { sessionPath } from './paths';
import { testSigner } from './read-test-utils';
import type { TenjinSigner } from './wallet/provider';

/** A second, distinct signer (a different wallet address) for swap-invalidation. */
function otherSigner(): TenjinSigner {
  const account = privateKeyToAccount(
    '0x0123456789012345678901234567890123456789012345678901234567890123',
  );
  return {
    address: account.address,
    signMessage: (a) => account.signMessage({ message: a.message }),
    signTypedData: (a) => account.signTypedData(a),
  };
}

const subtle = webcrypto.subtle;

// A real generated key for the round-trip signing test.
async function realKeyFile(): Promise<{ file: SessionFile; publicKey: webcrypto.CryptoKey }> {
  const pair = (await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as webcrypto.CryptoKeyPair;
  const rawPub = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  const jwk = (await subtle.exportKey('jwk', pair.privateKey)) as Record<string, unknown>;
  const file: SessionFile = {
    address: '0xabc',
    delegation: 'DELEGATION',
    exp: new Date(Date.now() + 3600_000).toISOString(),
    scope: 'read+write',
    publicKeyRaw: Buffer.from(rawPub).toString('base64url'),
    privateKeyJwk: jwk,
  };
  return { file, publicKey: pair.publicKey };
}

describe('RFC 9421 primitives are byte-exact', () => {
  it('Content-Digest is sha-256=:<base64 SHA-256(body)>: over the exact bytes', () => {
    const body = JSON.stringify({ title: 'Hi', bodyMd: '# Hi\n', status: 'published' });
    expect(contentDigest(body)).toBe('sha-256=:12Jb+/1pH+nxlw3RQadJjJ8a/hzIDFoxWX8Y8StWWVo=:');
  });

  it('@target-uri is scheme://host[:port]path[?query], nothing more', () => {
    expect(targetUri('https://tenjin.blog/api/posts')).toBe('https://tenjin.blog/api/posts');
    expect(targetUri('http://localhost:3000/api/posts?x=1')).toBe(
      'http://localhost:3000/api/posts?x=1',
    );
  });

  it('signature-params covers content-digest on a bodied request', () => {
    const params = signatureParams({
      method: 'POST',
      url: 'https://tenjin.blog/api/posts',
      contentDigest: 'sha-256=:abc:',
      created: 1_700_000_000,
      nonce: 'deadbeefdeadbeefdeadbeefdeadbeef',
      keyid: 'p256:PUB',
    });
    expect(params).toBe(
      '("@method" "@target-uri" "content-digest");created=1700000000;nonce="deadbeefdeadbeefdeadbeefdeadbeef";keyid="p256:PUB";alg="ecdsa-p256-sha256"',
    );
  });

  it('signature-params omits content-digest on a bodyless request', () => {
    const params = signatureParams({
      method: 'GET',
      url: 'https://tenjin.blog/api/posts',
      created: 1_700_000_000,
      nonce: 'ab',
      keyid: 'p256:PUB',
    });
    expect(params.startsWith('("@method" "@target-uri");')).toBe(true);
    expect(params).not.toContain('content-digest');
  });

  it('the signing base is the LF-joined canonical block with no trailing newline', () => {
    const base = signatureBase({
      method: 'POST',
      url: 'https://tenjin.blog/api/posts',
      contentDigest: 'sha-256=:12Jb+/1pH+nxlw3RQadJjJ8a/hzIDFoxWX8Y8StWWVo=:',
      created: 1_700_000_000,
      nonce: 'deadbeefdeadbeefdeadbeefdeadbeef',
      keyid: 'p256:PUB',
    });
    expect(base).toBe(
      [
        '"@method": POST',
        '"@target-uri": https://tenjin.blog/api/posts',
        '"content-digest": sha-256=:12Jb+/1pH+nxlw3RQadJjJ8a/hzIDFoxWX8Y8StWWVo=:',
        '"@signature-params": ("@method" "@target-uri" "content-digest");created=1700000000;nonce="deadbeefdeadbeefdeadbeefdeadbeef";keyid="p256:PUB";alg="ecdsa-p256-sha256"',
      ].join('\n'),
    );
    expect(base.endsWith('\n')).toBe(false);
  });
});

describe('delegation URN construction (D35)', () => {
  it('binds pubkey/exp/scope as the three tenjin session URNs', () => {
    const urns = delegationResources('PUBB64URL', '2026-07-22T00:00:00.000Z');
    expect(urns).toEqual([
      'urn:tenjin:session:pubkey:p256:PUBB64URL',
      'urn:tenjin:session:exp:2026-07-22T00:00:00.000Z',
      'urn:tenjin:session:scope:read+write',
    ]);
  });
});

describe('signWithSession emits a verifiable P-256 r||s signature', () => {
  it('produces a 64-byte IEEE-P1363 signature that verifies against the pubkey', async () => {
    const { file, publicKey } = await realKeyFile();
    const req = { method: 'POST' as const, url: 'https://tenjin.blog/api/posts', body: '{"a":1}' };
    const headers = await signWithSession(file, req, {
      now: () => 1_700_000_000_000,
      nonce: () => 'ab'.repeat(16),
    });

    expect(headers['Tenjin-Session-Delegation']).toBe('DELEGATION');
    expect(headers['Content-Digest']).toBe(contentDigest('{"a":1}'));
    expect(headers['Signature-Input']).toMatch(/^tenjin=\(/);
    const m = /^tenjin=:(.+):$/.exec(headers.Signature ?? '');
    expect(m).not.toBeNull();
    const sig = Buffer.from(m![1] ?? '', 'base64');
    expect(sig.length).toBe(64); // r||s, 32+32

    const base = signatureBase({
      method: 'POST',
      url: req.url,
      contentDigest: headers['Content-Digest'],
      created: 1_700_000_000,
      nonce: 'ab'.repeat(16),
      keyid: `p256:${file.publicKeyRaw}`,
    });
    const ok = await subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      sig,
      Buffer.from(base, 'utf8'),
    );
    expect(ok).toBe(true);
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

describe('isSessionUsable', () => {
  const base: SessionFile = {
    address: '0xabc',
    delegation: 'D',
    exp: new Date(2_000_000_000_000).toISOString(),
    scope: 'read+write',
    publicKeyRaw: 'P',
    privateKeyJwk: {},
  };

  it('accepts a bound, unexpired, read+write session', () => {
    expect(isSessionUsable(base, '0xABC', 1_000_000_000_000)).toBe(true);
  });
  it('rejects a different wallet address', () => {
    expect(isSessionUsable(base, '0xdef', 1_000_000_000_000)).toBe(false);
  });
  it('rejects one at/near expiry (60s skew)', () => {
    expect(isSessionUsable(base, '0xabc', 2_000_000_000_000)).toBe(false);
    expect(isSessionUsable(base, '0xabc', 1_999_999_999_000)).toBe(false);
  });
  it('rejects a non read+write scope', () => {
    expect(isSessionUsable({ ...base, scope: 'read' }, '0xabc', 1_000_000_000_000)).toBe(false);
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
    return { signer, baseUrl: 'https://tenjin.blog', chainId: 'eip155:8453', dataDir: dir };
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
    expect(payload.resources).toEqual(delegationResources(file.publicKeyRaw, file.exp));
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
      },
      count: () => n,
    };
  }

  it('mints on first use, then signs subsequent writes with the P-256 key only', async () => {
    const { signer, count } = spySigner();
    const config = { signer, baseUrl: 'https://tenjin.blog', chainId: 'eip155:8453', dataDir: dir };

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
    const config = { signer, baseUrl: 'https://tenjin.blog', chainId: 'eip155:8453', dataDir: dir };
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
    };
    const h2 = await createSessionKeyAuth({
      signer: swapSpy,
      baseUrl: 'https://tenjin.blog',
      chainId: 'eip155:8453',
      dataDir: dir,
    }).headersFor({ method: 'POST', url: 'https://tenjin.blog/api/posts', body: '{}' });
    expect(swapSigns).toBe(1);
    expect(h2['Tenjin-Session-Delegation']).not.toBe(h1['Tenjin-Session-Delegation']);
    expect(first.count()).toBe(1); // the first wallet was never asked to sign again
  });
});

describe('signWithSession freshness', () => {
  it('two signings of the same request differ in created, nonce, and signature', async () => {
    const { file } = await realKeyFile();
    const req = { method: 'POST' as const, url: 'https://tenjin.blog/api/posts', body: '{"a":1}' };
    let clock = 1_700_000_000_000;
    const sign = () => signWithSession(file, req, { now: () => (clock += 2000) });
    const a = await sign();
    const b = await sign();
    expect(a['Signature-Input']).not.toBe(b['Signature-Input']); // created + nonce move
    expect(a.Signature).not.toBe(b.Signature); // a fresh ECDSA signature each time
    expect(a['Content-Digest']).toBe(b['Content-Digest']); // same body ⇒ same digest
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
    };
    const auth = createSiwxAuth({
      signer,
      baseUrl: 'https://tenjin.blog',
      chainId: 'eip155:8453',
      dataDir: '/nonexistent',
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

describe('loadSessionFile degradation branches', () => {
  let d: string;
  beforeEach(async () => {
    d = await mkdtemp(join(tmpdir(), 'tenjin-session-load-'));
  });
  afterEach(async () => {
    await rm(d, { recursive: true, force: true });
  });

  it('returns null when the cache is absent', async () => {
    expect(await loadSessionFile(d)).toBeNull();
  });

  it('returns null on invalid JSON (a corrupt cache re-establishes, not throws)', async () => {
    await mkdir(d, { recursive: true });
    await writeFile(sessionPath(d), 'not json {{{', { mode: 0o600 });
    expect(await loadSessionFile(d)).toBeNull();
  });

  it('returns null on a schema mismatch (tampered/partial file)', async () => {
    await mkdir(d, { recursive: true });
    await writeFile(sessionPath(d), JSON.stringify({ address: '0xabc' }), { mode: 0o600 });
    expect(await loadSessionFile(d)).toBeNull();
  });

  it('fails closed on a group/world-readable cache (ssh posture)', async () => {
    if (process.platform === 'win32') return;
    const { file } = await realKeyFile();
    await saveSessionFile(d, file); // 0600
    await chmod(sessionPath(d), 0o644); // loosened out of band
    expect(await loadSessionFile(d)).toBeNull();
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
    });
    await auth.headersFor(req);
    expect(count()).toBe(1); // one fresh establish
    await auth.headersFor(req);
    expect(count()).toBe(1); // then reuses the freshly written session
  });

  it('re-establishes from an expired on-disk session', async () => {
    const { signer, count } = countingSigner();
    const { file } = await realKeyFile();
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
    });
    await auth.headersFor(req);
    expect(count()).toBe(1);
  });
});
