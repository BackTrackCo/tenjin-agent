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
  readSessionFile,
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
import { CliError } from './errors';
import { sessionPath } from './paths';
import { testSessionKey } from './read-test-utils';

const subtle = webcrypto.subtle;

const ORIGIN = 'https://tenjin.blog';

/** A predicate fixture: only address/origin/scope/exp are read by these tests. */
const FIXTURE: SessionFile = {
  address: '0xabc',
  origin: ORIGIN,
  delegation: 'D',
  exp: new Date(2_000_000_000_000).toISOString(),
  scope: 'read',
  publicKeyRaw: 'P',
  privateKeyJwk: { kty: 'EC', crv: 'P-256', d: 'd', x: 'x', y: 'y' },
};

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
  const base: SessionFile = { ...FIXTURE, scope: 'read+write' };

  it('accepts a bound, unexpired, read+write session', () => {
    expect(isSessionUsable(base, '0xABC', 1_000_000_000_000, 'read+write', ORIGIN)).toBe(true);
  });
  it('rejects a different wallet address', () => {
    expect(isSessionUsable(base, '0xdef', 1_000_000_000_000, 'read+write', ORIGIN)).toBe(false);
  });
  it('rejects one at/near expiry (60s skew)', () => {
    expect(isSessionUsable(base, '0xabc', 2_000_000_000_000, 'read+write', ORIGIN)).toBe(false);
    expect(isSessionUsable(base, '0xabc', 1_999_999_999_000, 'read+write', ORIGIN)).toBe(false);
  });
  it('a read-scoped session does not satisfy a write run', () => {
    expect(
      isSessionUsable({ ...base, scope: 'read' }, '0xabc', 1_000_000_000_000, 'read+write', ORIGIN),
    ).toBe(false);
  });
  it('a read+write session satisfies a read run (wider covers narrower)', () => {
    expect(isSessionUsable(base, '0xabc', 1_000_000_000_000, 'read', ORIGIN)).toBe(true);
  });
  it('a read-scoped session satisfies a read run', () => {
    expect(
      isSessionUsable({ ...base, scope: 'read' }, '0xabc', 1_000_000_000_000, 'read', ORIGIN),
    ).toBe(true);
  });
  it('an unrecognized cached scope satisfies nothing', () => {
    expect(
      isSessionUsable({ ...base, scope: 'write' }, '0xabc', 1_000_000_000_000, 'read', ORIGIN),
    ).toBe(false);
  });
});

/**
 * The address-free half, which is what `read` uses: it holds no wallet, so it has
 * no address to compare against. Everything else about the check has to be
 * identical, or the two callers would disagree about what a live session is.
 */
describe('isSessionPresentable (scope + expiry, no address binding)', () => {
  const base: SessionFile = FIXTURE;

  it('accepts a live read session whatever address it is bound to', () => {
    expect(isSessionPresentable(base, 1_000_000_000_000, 'read', ORIGIN)).toBe(true);
    expect(isSessionPresentable({ ...base, address: '0xsomeoneelse' }, 1e12, 'read', ORIGIN)).toBe(
      true,
    );
  });
  it('accepts a cached read+write session for a read run', () => {
    expect(
      isSessionPresentable({ ...base, scope: 'read+write' }, 1_000_000_000_000, 'read', ORIGIN),
    ).toBe(true);
  });
  it('applies the same 60s expiry skew as isSessionUsable', () => {
    expect(isSessionPresentable(base, 1_999_999_999_000, 'read', ORIGIN)).toBe(false);
    expect(isSessionPresentable(base, 2_000_000_000_000, 'read', ORIGIN)).toBe(false);
  });
  it('rejects an unparseable exp rather than treating it as far future', () => {
    expect(isSessionPresentable({ ...base, exp: 'soon' }, 1_000_000_000_000, 'read', ORIGIN)).toBe(
      false,
    );
  });
  it('rejects a scope that does not cover the run', () => {
    expect(
      isSessionPresentable({ ...base, scope: 'write' }, 1_000_000_000_000, 'read', ORIGIN),
    ).toBe(false);
    expect(isSessionPresentable(base, 1_000_000_000_000, 'read+write', ORIGIN)).toBe(false);
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

/**
 * The origin binding. The delegation is a wallet-derived credential and
 * `--base-url` rides every leaf command, so "which deployment was this minted
 * for" is a security property, not bookkeeping — the predicate is where it holds.
 */
describe('the origin binding', () => {
  it('refuses to present a session minted for another origin', () => {
    expect(isSessionPresentable(FIXTURE, 1_000_000_000_000, 'read', 'https://evil.example')).toBe(
      false,
    );
    expect(
      isSessionUsable(FIXTURE, '0xabc', 1_000_000_000_000, 'read', 'https://evil.example'),
    ).toBe(false);
  });

  it('compares origins exactly: a different port or scheme is a different origin', () => {
    for (const other of [
      'http://tenjin.blog',
      'https://tenjin.blog:8443',
      'https://tenjin.blog.evil.com',
    ]) {
      expect(isSessionPresentable(FIXTURE, 1_000_000_000_000, 'read', other)).toBe(false);
    }
  });

  it('accepts the origin it was minted for', () => {
    expect(isSessionPresentable(FIXTURE, 1_000_000_000_000, 'read', ORIGIN)).toBe(true);
  });
});

describe('the session schema rejects a key that could not sign', () => {
  let d: string;
  beforeEach(async () => {
    d = await mkdtemp(join(tmpdir(), 'tenjin-session-jwk-'));
  });
  afterEach(async () => {
    await rm(d, { recursive: true, force: true });
  });

  // A loose record let these through the load boundary and into subtle.importKey,
  // which throws a raw DOMException — an exit-1 INTERNAL with no fix, out of a
  // command whose contract is that a bad cache degrades into a refusal.
  it.each([
    ['an empty object', {}],
    ['a missing private scalar', { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' }],
    ['the wrong curve', { kty: 'EC', crv: 'P-384', d: 'd', x: 'x', y: 'y' }],
    ['the wrong key type', { kty: 'RSA', crv: 'P-256', d: 'd', x: 'x', y: 'y' }],
    ['an empty private scalar', { kty: 'EC', crv: 'P-256', d: '', x: 'x', y: 'y' }],
  ])('reports %s as a corrupt cache, not a usable session', async (_name, jwk) => {
    const { file } = await testSessionKey();
    await writeFile(sessionPath(d), JSON.stringify({ ...file, privateKeyJwk: jwk }), {
      mode: 0o600,
    });
    expect((await readSessionFile(d)).kind).toBe('corrupt');
    expect(await loadSessionFile(d)).toBeNull();
  });

  // The SAFETY property is that it is never presentable; the classification is a
  // separate question. A pre-origin file is one an older CLI wrote, so it reports
  // as `outdated` (a version fact) rather than `corrupt` (a tamper signal), and it
  // is still refused for presentation.
  it('a session file missing its origin is outdated, and can never be presented blind', async () => {
    const { file } = await testSessionKey();
    const withoutOrigin: Record<string, unknown> = { ...file };
    delete withoutOrigin.origin;
    await writeFile(sessionPath(d), JSON.stringify(withoutOrigin), { mode: 0o600 });
    expect(await readSessionFile(d)).toMatchObject({ kind: 'outdated', field: 'origin' });
    expect(await loadSessionFile(d)).toBeNull();
  });

  // zod reports in schema order and `origin` sits early, so judging by the FIRST
  // issue let a file missing its private scalar ride in on the legacy exemption.
  it('a pre-origin file that ALSO lost its private scalar is corrupt, not outdated', async () => {
    const { file } = await testSessionKey();
    const broken: Record<string, unknown> = { ...file };
    delete broken.origin;
    const jwk = { ...(file.privateKeyJwk as Record<string, unknown>) };
    delete jwk.d;
    broken.privateKeyJwk = jwk;
    await writeFile(sessionPath(d), JSON.stringify(broken), { mode: 0o600 });
    expect((await readSessionFile(d)).kind).toBe('corrupt');
    expect(await loadSessionFile(d)).toBeNull();
  });

  // The discriminator is the key's ABSENCE, not zod's message, so a field that is
  // present and wrong stays in the tamper bucket where it belongs.
  it('a session file whose origin is present but the wrong type is still corrupt', async () => {
    const { file } = await testSessionKey();
    await writeFile(sessionPath(d), JSON.stringify({ ...file, origin: 42 }), { mode: 0o600 });
    expect((await readSessionFile(d)).kind).toBe('corrupt');
    expect(await loadSessionFile(d)).toBeNull();
  });
});

/** The states `loadSessionFile` flattens, which `doctor` needs kept apart. */
describe('readSessionFile distinguishes what loadSessionFile collapses', () => {
  let d: string;
  beforeEach(async () => {
    d = await mkdtemp(join(tmpdir(), 'tenjin-session-state-'));
  });
  afterEach(async () => {
    await rm(d, { recursive: true, force: true });
  });

  it('absent', async () => {
    expect(await readSessionFile(d)).toEqual({ kind: 'absent' });
  });

  it('corrupt JSON, with the reason', async () => {
    await writeFile(sessionPath(d), 'nope {{{', { mode: 0o600 });
    expect(await readSessionFile(d)).toMatchObject({ kind: 'corrupt', reason: 'not valid JSON' });
  });

  // The FULL mode, not the offending subset: a tamper report that prints a mode
  // the file does not have (0755 rendered as 0655) is worse than no number.
  it('loosened, carrying the real mode the file has', async () => {
    if (process.platform === 'win32') return;
    await saveSessionFile(d, (await testSessionKey()).file);
    await chmod(sessionPath(d), 0o644);
    expect(await readSessionFile(d)).toMatchObject({ kind: 'loosened', mode: 0o644 });
    await chmod(sessionPath(d), 0o755);
    expect(await readSessionFile(d)).toMatchObject({ kind: 'loosened', mode: 0o755 });
  });

  it('unreadable is the ONE state loadSessionFile refuses to flatten to null', async () => {
    // Silently re-establishing over a file that exists and merely could not be
    // read would overwrite a session that may be perfectly good.
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    await writeFile(sessionPath(d), '{}', { mode: 0o600 });
    await chmod(sessionPath(d), 0o000);
    expect((await readSessionFile(d)).kind).toBe('unreadable');
    await expect(loadSessionFile(d)).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('ok, returning the parsed file', async () => {
    const { file } = await testSessionKey();
    await saveSessionFile(d, file);
    expect(await readSessionFile(d)).toEqual({ kind: 'ok', file });
  });
});

/**
 * The half the schema cannot cover. A JWK can satisfy every field of
 * P256JwkSchema and still be cryptographically invalid, at which point
 * subtle.importKey throws a raw DOMException — an exit-1 INTERNAL reading
 * "Invalid keyData" with no `fix`, out of `publish` and `edit` as well as `read`.
 * Translating at the import site is what makes every caller degrade identically.
 */
describe('a schema-valid but cryptographically invalid key is a typed error', () => {
  const req = { method: 'GET' as const, url: 'https://tenjin.blog/api/read/iris/slug' };

  it.each([
    ['a one-character d', 'AA'],
    ['a 31-byte d', Buffer.alloc(31, 1).toString('base64url')],
    ['d = 0', Buffer.alloc(32, 0).toString('base64url')],
    ['d = n (the curve order)', 'AAAAAP__________vOb6racXnoTzucrC_GMlUQ'],
  ])('%s throws a CliError with a fix, not a DOMException', async (_name, d) => {
    const { file } = await testSessionKey();
    const err = await signWithSession({ ...file, privateKeyJwk: { ...file.privateKeyJwk, d } }, req)
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    const cliErr = err as CliError;
    expect(cliErr.code).toBe('INTERNAL');
    expect(cliErr.message).toMatch(/not a usable P-256 key/i);
    // The half a bare DOMException never had: something to actually do.
    expect(cliErr.fix).toMatch(/tenjin session start --scope read/);
    // And the original is preserved for anyone debugging it.
    expect(cliErr.cause).toBeDefined();
  });

  it('an off-curve public point is caught the same way', async () => {
    const { file } = await testSessionKey();
    const bad = { ...file.privateKeyJwk, x: Buffer.alloc(32, 9).toString('base64url') };
    await expect(signWithSession({ ...file, privateKeyJwk: bad }, req)).rejects.toMatchObject({
      code: 'INTERNAL',
    });
  });

  it('a real key still signs, so the guard is not refusing everything', async () => {
    const { file } = await testSessionKey();
    await expect(signWithSession(file, req)).resolves.toHaveProperty('Signature');
  });
});
