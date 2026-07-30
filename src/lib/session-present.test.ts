import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { webcrypto } from 'node:crypto';
import {
  contentDigest,
  isSessionPresentable,
  isSessionUsable,
  loadSessionFile,
  scopeSatisfies,
  signWithSession,
  signatureBase,
  signatureParams,
  targetUri,
  type SessionFile,
} from './session-present';
// The cache WRITER lives with the mint half by design (read must not reach it).
// A test may cross that line freely — the pin is on read.ts's import graph, not
// on this file — and writing the fixture through the production writer is what
// makes the 0600 / loosened-mode branches below test the real pairing.
import { saveSessionFile } from './session-key';
import { sessionPath } from './paths';
import { testSessionKey } from './read-test-utils';

const subtle = webcrypto.subtle;

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

describe('signWithSession emits a verifiable P-256 r||s signature', () => {
  it('produces a 64-byte IEEE-P1363 signature that verifies against the pubkey', async () => {
    const { file, publicKey } = await testSessionKey({ scope: 'read+write' });
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

  it('a bodiless GET sends no Content-Digest and covers only method + target-uri', async () => {
    const { file, publicKey } = await testSessionKey();
    const url = 'https://tenjin.blog/api/read/iris/slug';
    const headers = await signWithSession(
      file,
      { method: 'GET', url },
      { now: () => 1_700_000_000_000, nonce: () => 'cd'.repeat(16) },
    );

    // Nothing may claim to cover bytes the request never sends.
    expect('Content-Digest' in headers).toBe(false);
    expect(headers['Signature-Input']).toMatch(/^tenjin=\("@method" "@target-uri"\);/);
    expect(headers['Signature-Input']).not.toContain('content-digest');

    // And the signature verifies against the digest-free base.
    const sig = Buffer.from(/^tenjin=:(.+):$/.exec(headers.Signature ?? '')![1] ?? '', 'base64');
    const base = signatureBase({
      method: 'GET',
      url,
      created: 1_700_000_000,
      nonce: 'cd'.repeat(16),
      keyid: `p256:${file.publicKeyRaw}`,
    });
    expect(
      await subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        publicKey,
        sig,
        Buffer.from(base, 'utf8'),
      ),
    ).toBe(true);
  });
});

describe('signWithSession freshness', () => {
  it('two signings of the same request differ in created, nonce, and signature', async () => {
    const { file } = await testSessionKey();
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

describe('scopeSatisfies (wider covers narrower, never the reverse)', () => {
  it.each([
    ['read', 'read' as const, true],
    ['read+write', 'read' as const, true],
    ['read+write', 'read+write' as const, true],
    ['read', 'read+write' as const, false],
    ['write', 'read' as const, false],
    ['', 'read' as const, false],
  ])('cached %s for a %s run -> %s', (cached, required, expected) => {
    expect(scopeSatisfies(cached, required)).toBe(expected);
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
    expect(isSessionUsable(base, '0xABC', 1_000_000_000_000, 'read+write')).toBe(true);
  });
  it('rejects a different wallet address', () => {
    expect(isSessionUsable(base, '0xdef', 1_000_000_000_000, 'read+write')).toBe(false);
  });
  it('rejects one at/near expiry (60s skew)', () => {
    expect(isSessionUsable(base, '0xabc', 2_000_000_000_000, 'read+write')).toBe(false);
    expect(isSessionUsable(base, '0xabc', 1_999_999_999_000, 'read+write')).toBe(false);
  });
  it('a read-scoped session does not satisfy a write run', () => {
    expect(
      isSessionUsable({ ...base, scope: 'read' }, '0xabc', 1_000_000_000_000, 'read+write'),
    ).toBe(false);
  });
  it('a read+write session satisfies a read run (wider covers narrower)', () => {
    expect(isSessionUsable(base, '0xabc', 1_000_000_000_000, 'read')).toBe(true);
  });
  it('a read-scoped session satisfies a read run', () => {
    expect(isSessionUsable({ ...base, scope: 'read' }, '0xabc', 1_000_000_000_000, 'read')).toBe(
      true,
    );
  });
  it('an unrecognized cached scope satisfies nothing', () => {
    expect(isSessionUsable({ ...base, scope: 'write' }, '0xabc', 1_000_000_000_000, 'read')).toBe(
      false,
    );
  });
});

/**
 * The address-free half, which is what `read` uses: it holds no wallet, so it has
 * no address to compare against. Everything else about the check has to be
 * identical, or the two callers would disagree about what a live session is.
 */
describe('isSessionPresentable (scope + expiry, no address binding)', () => {
  const base: SessionFile = {
    address: '0xabc',
    delegation: 'D',
    exp: new Date(2_000_000_000_000).toISOString(),
    scope: 'read',
    publicKeyRaw: 'P',
    privateKeyJwk: {},
  };

  it('accepts a live read session whatever address it is bound to', () => {
    expect(isSessionPresentable(base, 1_000_000_000_000, 'read')).toBe(true);
    expect(isSessionPresentable({ ...base, address: '0xsomeoneelse' }, 1e12, 'read')).toBe(true);
  });
  it('accepts a cached read+write session for a read run', () => {
    expect(isSessionPresentable({ ...base, scope: 'read+write' }, 1_000_000_000_000, 'read')).toBe(
      true,
    );
  });
  it('applies the same 60s expiry skew as isSessionUsable', () => {
    expect(isSessionPresentable(base, 1_999_999_999_000, 'read')).toBe(false);
    expect(isSessionPresentable(base, 2_000_000_000_000, 'read')).toBe(false);
  });
  it('rejects an unparseable exp rather than treating it as far future', () => {
    expect(isSessionPresentable({ ...base, exp: 'soon' }, 1_000_000_000_000, 'read')).toBe(false);
  });
  it('rejects a scope that does not cover the run', () => {
    expect(isSessionPresentable({ ...base, scope: 'write' }, 1_000_000_000_000, 'read')).toBe(
      false,
    );
    expect(isSessionPresentable(base, 1_000_000_000_000, 'read+write')).toBe(false);
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

  it('round-trips a file written by saveSessionFile', async () => {
    const { file } = await testSessionKey();
    await saveSessionFile(d, file);
    expect(await loadSessionFile(d)).toEqual(file);
  });

  it('fails closed on a group/world-readable cache (ssh posture)', async () => {
    if (process.platform === 'win32') return;
    const { file } = await testSessionKey();
    await saveSessionFile(d, file); // 0600
    await chmod(sessionPath(d), 0o644); // loosened out of band
    expect(await loadSessionFile(d)).toBeNull();
  });
});
