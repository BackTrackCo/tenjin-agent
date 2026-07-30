import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRead } from './read';
import { libraryDir, saveDelivery } from '../lib/library';
import { recordSearch } from '../lib/search-store';
import {
  buildPaymentRequired,
  makeReadServer,
  readBody,
  reply,
  TEST_ORIGIN,
  testSessionKey,
  withTrailingSlashRedirect,
} from '../lib/read-test-utils';
import { saveSessionFile } from '../lib/session-key';
import { signatureBase } from '../lib/session-present';
import { CliError } from '../lib/errors';
import { webcrypto } from 'node:crypto';
import type { SessionFile } from '../lib/session-present';
import type { CommandContext, GlobalFlags } from '../context';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-read-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeCtx(flags: Partial<GlobalFlags> = {}): CommandContext {
  const sink = () => ({ write: () => true }) as unknown as NodeJS.WritableStream;
  return {
    // The fixtures are served from TEST_ORIGIN, which is also what the session
    // fixture binds to; a test that overrides it is testing the binding.
    flags: { json: false, timeout: 5000, baseUrl: TEST_ORIGIN, ...flags },
    dataDir: dir,
    io: { stdout: sink(), stderr: sink(), isTTY: false },
  };
}

const URL_ = 'https://tenjin.blog/api/read/iris/slug';

/** A fetch that fails the test if it is ever called. */
const neverFetch = (async () => {
  throw new Error('the network must not be touched on this path');
}) as unknown as typeof fetch;

describe('runRead, free delivery', () => {
  it('delivers a free 200 and saves it, with no wallet and no payment attempt', async () => {
    const { fetch, calls } = makeReadServer({
      plain: () => reply.entitled(readBody({ price: '0' })),
    });
    const result = await runRead({ ref: URL_ }, makeCtx(), { fetchImpl: fetch });
    const data = result.data as {
      entitlement: string;
      bodyPath: string;
      price: { atomic: string };
    };

    expect(data.entitlement).toBe('free');
    expect(data.price.atomic).toBe('0');
    await expect(readFile(data.bodyPath, 'utf8')).resolves.toContain('full body');
    // Exactly one unauthenticated GET: no SIWX re-check, no payment attempt.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.phase).toBe('plain');
    expect(calls[0]?.headers['sign-in-with-x']).toBeUndefined();
    expect(calls[0]?.headers['payment-signature']).toBeUndefined();
  });

  it('honors --print-body and --sections like buy does', async () => {
    const { fetch } = makeReadServer({ plain: () => reply.entitled(readBody({ price: '0' })) });
    const result = await runRead({ ref: URL_, printBody: true, sections: '800' }, makeCtx(), {
      fetchImpl: fetch,
    });
    const data = result.data as { body?: string; sections?: unknown };
    expect(data.body).toContain('full body');
    expect(data.sections).toBeDefined();
  });

  it('rejects a bad --sections budget as USAGE (exit 2) before any request', async () => {
    await expect(
      runRead({ ref: URL_, sections: 'lots' }, makeCtx(), { fetchImpl: neverFetch }),
    ).rejects.toMatchObject({ code: 'USAGE', exitCode: 2 });
  });
});

/**
 * The read route canonicalizes `/api/read/<handle>/<slug>/` to the no-slash form
 * with a 308, and `fetchRead` refuses to follow ANY redirect. So a URL a user
 * pasted with a trailing slash — a shape `parseReadPath` has always accepted —
 * has to be canonicalized before it reaches the transport, or the very first
 * probe fails. `resolveResourceRef` does that for `read`, `buy`, and `inspect`
 * alike; these tests drive it through the route mock that actually 308s.
 */
describe('runRead, a URL pasted with a trailing slash', () => {
  it('reads it, asking the route only for the canonical path', async () => {
    const { fetch, calls } = makeReadServer({
      plain: () => reply.entitled(readBody({ price: '0' })),
    });
    const result = await runRead({ ref: `${URL_}/` }, makeCtx(), {
      fetchImpl: withTrailingSlashRedirect(fetch),
    });
    const data = result.data as { entitlement: string; url: string; bodyPath: string };

    expect(data.entitlement).toBe('free');
    // The transport was never handed the slashed spelling, so no 308 was ever
    // refused: exactly one served call, at the canonical URL.
    expect(calls.map((c) => c.url)).toEqual([URL_]);
    await expect(readFile(data.bodyPath, 'utf8')).resolves.toContain('full body');
  });

  it('records the canonical URL, so a re-read is a library hit with no network', async () => {
    const { fetch } = makeReadServer({ plain: () => reply.entitled(readBody({ price: '0' })) });
    await runRead({ ref: `${URL_}/` }, makeCtx(), {
      fetchImpl: withTrailingSlashRedirect(fetch),
    });
    // Second read, slashed again, network fatal: the receipt written by the first
    // read has to match it. (parseReadPath is slash-insensitive, so this holds
    // either way — it pins that canonicalization did not break the match.)
    const again = await runRead({ ref: `${URL_}/` }, makeCtx(), {
      fetchImpl: neverFetch,
    });
    expect((again.data as { alreadyDelivered: boolean }).alreadyDelivered).toBe(true);
  });

  it('still refuses a redirect that is NOT a trailing-slash hop, and saves nothing', async () => {
    // The pin stays strict. A canonical URL the route redirects anyway (here
    // cross-origin, the case the pin exists for) is a hard failure, and no bytes
    // from the other host become a durable entitlement record.
    const fetchImpl = (async () =>
      new Response('', {
        status: 302,
        headers: { location: 'https://evil.example/api/read/iris/slug' },
      })) as unknown as typeof fetch;
    await expect(runRead({ ref: URL_ }, makeCtx(), { fetchImpl })).rejects.toMatchObject({
      code: 'CONTRACT_MISMATCH',
    });
    await expect(readdir(libraryDir(dir))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('runRead, entitled re-read', () => {
  it('re-delivers an owned resource from the library with no network at all', async () => {
    const body = readBody();
    await saveDelivery(dir, {
      resourceId: body.id,
      slug: body.slug,
      title: body.title,
      handle: 'iris',
      url: URL_,
      priceAtomic: body.price,
      entitlement: 'purchased',
      bodyMd: body.bodyMd,
    });

    // neverFetch: a single request on this path fails the test.
    const result = await runRead({ ref: URL_ }, makeCtx(), {
      fetchImpl: neverFetch,
    });
    const data = result.data as { alreadyDelivered: boolean; entitlement: string };
    expect(data.alreadyDelivered).toBe(true);
    expect(data.entitlement).toBe('purchased');
    expect(result.humanLines?.[0]).toContain('No payment made.');
  });

  it('re-delivers by resource id as well as by url', async () => {
    const body = readBody();
    // A bare id resolves through the local search store, exactly as it does for buy.
    await recordSearch(dir, {
      searchId: '0197aaaa-bbbb-cccc-dddd-abcabcabcabc',
      at: new Date().toISOString(),
      question: 'q',
      decision: 'CANDIDATES',
      candidates: [{ resourceId: body.id, url: URL_, title: body.title, price: body.price }],
    });
    await saveDelivery(dir, {
      resourceId: body.id,
      slug: body.slug,
      title: body.title,
      handle: 'iris',
      url: URL_,
      priceAtomic: body.price,
      entitlement: 'purchased',
      bodyMd: body.bodyMd,
    });
    const result = await runRead({ ref: body.id }, makeCtx(), {
      fetchImpl: neverFetch,
    });
    expect((result.data as { alreadyDelivered: boolean }).alreadyDelivered).toBe(true);
  });
});

describe('runRead, paid refusal', () => {
  it('exits 3 straight off the first 402 with no session on disk, and no second request', async () => {
    // The cold-read case: paid, nothing in the local library, and no session key
    // to present. The refusal lands on the FIRST 402. The mock is a triple trap:
    // an SIWX re-check would have DELIVERED, a session presentation would have
    // DELIVERED, and a payment would have SUCCEEDED — so all three absent phases
    // are real assertions, not accidents of setup.
    const pr = buildPaymentRequired();
    const { fetch, calls } = makeReadServer({
      plain: () => reply.paymentRequired(pr),
      siwx: () => reply.entitled(readBody()),
      session: () => reply.entitled(readBody()),
      payment: () => reply.entitled(readBody()),
    });

    const err = await runRead({ ref: URL_ }, makeCtx(), { fetchImpl: fetch }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CliError);
    const cliErr = err as CliError;
    expect(cliErr.code).toBe('REFUSED');
    expect(cliErr.exitCode).toBe(3);
    // The message names the price; the fix names the verb that can pay, and —
    // because nothing was presented — the verb that might make it free.
    expect(cliErr.message).toContain('0.10 USD');
    expect(cliErr.message).toContain('100000 atomic');
    expect(cliErr.fix).toContain('tenjin buy');
    expect(cliErr.fix).toContain('tenjin session start --scope read');
    expect(cliErr.details).toMatchObject({
      reason: 'payment_required',
      entitlementCheck: 'not_performed',
      price: { usd: '0.1', atomic: '100000' },
      buyCommand: `tenjin buy ${URL_}`,
      sessionCommand: 'tenjin session start --scope read',
    });

    // Exactly one unauthenticated probe. No SIWX, no session, no payment.
    expect(calls.map((c) => c.phase)).toEqual(['plain']);
    expect(calls[0]?.headers['sign-in-with-x']).toBeUndefined();
    expect(calls[0]?.headers['tenjin-session-delegation']).toBeUndefined();
    expect(calls[0]?.headers['payment-signature']).toBeUndefined();
    // Nothing is written to the library on a refusal.
    await expect(readdir(libraryDir(dir))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

/**
 * Owned-library recovery: the piece is paid, not cached here, and this wallet
 * already bought it elsewhere. `read` proves that with a session key it LOADED —
 * it cannot mint one — on exactly one signed GET, and pays nothing either way.
 */
describe('runRead, owned-library recovery on a session key', () => {
  async function seedSession(over: Partial<SessionFile> = {}): Promise<SessionFile> {
    const { file } = await testSessionKey(over);
    await saveSessionFile(dir, file);
    return file;
  }

  it('presents the delegation on a bodyless GET and delivers the owned piece free', async () => {
    const file = await seedSession();
    const pr = buildPaymentRequired();
    const { fetch, calls } = makeReadServer({
      plain: () => reply.paymentRequired(pr),
      session: () => reply.entitled(readBody()),
      // A payment would have worked; it must still never be attempted.
      payment: () => reply.entitled(readBody()),
    });

    const result = await runRead({ ref: URL_ }, makeCtx(), { fetchImpl: fetch });
    const data = result.data as { entitlement: string; bodyPath: string };
    expect(data.entitlement).toBe('entitled');
    await expect(readFile(data.bodyPath, 'utf8')).resolves.toContain('full body');

    expect(calls.map((c) => c.phase)).toEqual(['plain', 'session']);
    const signed = calls[1]?.headers ?? {};
    expect(signed['tenjin-session-delegation']).toBe(file.delegation);
    expect(signed['signature-input']).toMatch(/^tenjin=\("@method" "@target-uri"\);/);
    expect(signed.signature).toMatch(/^tenjin=:.+:$/);
    // A GET has no body, so nothing may claim to cover one.
    expect(signed['content-digest']).toBeUndefined();
    expect(signed['signature-input']).not.toContain('content-digest');
    // And no money path was touched on the way.
    expect(signed['payment-signature']).toBeUndefined();
  });

  it('signs with the cached key itself, verifiably — not a placeholder header', async () => {
    // Without this the test above would pass against a client that emitted a
    // well-shaped signature over the wrong bytes (or over nothing at all).
    const { file, publicKey } = await testSessionKey();
    await saveSessionFile(dir, file);
    const { fetch, calls } = makeReadServer({
      plain: () => reply.paymentRequired(buildPaymentRequired()),
      session: () => reply.entitled(readBody()),
    });
    await runRead({ ref: URL_ }, makeCtx(), { fetchImpl: fetch });

    const h = calls[1]?.headers ?? {};
    const params = (h['signature-input'] ?? '').replace(/^tenjin=/, '');
    const sig = Buffer.from(/^tenjin=:(.+):$/.exec(h.signature ?? '')?.[1] ?? '', 'base64');
    const created = Number(/created=(\d+)/.exec(params)?.[1] ?? '0');
    const nonce = /nonce="([^"]+)"/.exec(params)?.[1] ?? '';
    const base = signatureBase({
      method: 'GET',
      url: URL_,
      created,
      nonce,
      keyid: `p256:${file.publicKeyRaw}`,
    });
    expect(
      await webcrypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        publicKey,
        sig,
        Buffer.from(base, 'utf8'),
      ),
    ).toBe(true);
  });

  it('accepts a cached read+write session (publish left it there) for the read', async () => {
    await seedSession({ scope: 'read+write' });
    const { fetch, calls } = makeReadServer({
      plain: () => reply.paymentRequired(buildPaymentRequired()),
      session: () => reply.entitled(readBody()),
    });
    const result = await runRead({ ref: URL_ }, makeCtx(), { fetchImpl: fetch });
    expect((result.data as { entitlement: string }).entitlement).toBe('entitled');
    expect(calls.map((c) => c.phase)).toEqual(['plain', 'session']);
  });

  it('presents a session bound to ANOTHER wallet and lets the server decide', async () => {
    // read holds no wallet, so it has no address to compare against. That costs
    // nothing: the delegation is self-authenticating, so a foreign file simply
    // does not entitle and lands on the ordinary refusal.
    await seedSession({ address: '0xsomeoneelse' });
    const { fetch, calls } = makeReadServer({
      plain: () => reply.paymentRequired(buildPaymentRequired()),
      session: () => reply.paymentRequired(buildPaymentRequired()),
    });
    const err = await runRead({ ref: URL_ }, makeCtx(), { fetchImpl: fetch }).catch(
      (e: unknown) => e,
    );
    expect((err as CliError).code).toBe('REFUSED');
    expect(calls.map((c) => c.phase)).toEqual(['plain', 'session']);
  });

  it('a second 402 on the signed retry refuses once, with entitlementCheck session', async () => {
    await seedSession();
    const { fetch, calls } = makeReadServer({
      plain: () => reply.paymentRequired(buildPaymentRequired()),
      session: () => reply.paymentRequired(buildPaymentRequired()),
    });
    const err = await runRead({ ref: URL_ }, makeCtx(), { fetchImpl: fetch }).catch(
      (e: unknown) => e,
    );
    const cliErr = err as CliError;
    expect(cliErr.code).toBe('REFUSED');
    expect(cliErr.exitCode).toBe(3);
    // A live delegation said "you do not own this", so buying is the only route —
    // and the fix must NOT send the agent to mint a session it already has.
    expect(cliErr.details).toMatchObject({ entitlementCheck: 'session' });
    expect(cliErr.details).not.toHaveProperty('sessionCommand');
    expect(cliErr.fix).not.toContain('tenjin session start');
    // Exactly two calls: no loop, no re-establish.
    expect(calls.map((c) => c.phase)).toEqual(['plain', 'session']);
    await expect(readdir(libraryDir(dir))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('a 401 rejecting the delegation refuses cleanly rather than erroring out', async () => {
    await seedSession();
    const { fetch, calls } = makeReadServer({
      plain: () => reply.paymentRequired(buildPaymentRequired()),
      session: () => reply.sessionRejected('session_expired'),
    });
    const err = await runRead({ ref: URL_ }, makeCtx(), { fetchImpl: fetch }).catch(
      (e: unknown) => e,
    );
    // Not API_UNREACHABLE: read cannot re-establish (that needs the wallet it
    // lacks), so it declines. And NOT `'session'`: the server never answered the
    // ownership question, so telling the agent to buy would spend money on a
    // piece it may already own. Re-minting is the move, so `sessionCommand` rides.
    const cliErr = err as CliError;
    expect(cliErr.code).toBe('REFUSED');
    expect(cliErr.details).toMatchObject({
      entitlementCheck: 'session_rejected',
      sessionCommand: 'tenjin session start --scope read',
    });
    expect(cliErr.fix).toContain('tenjin session start --scope read');
    expect(calls.map((c) => c.phase)).toEqual(['plain', 'session']);
  });

  it.each([
    ['expired', { exp: new Date(Date.now() - 1000).toISOString() }],
    ['too close to expiry for the 60s skew', { exp: new Date(Date.now() + 5000).toISOString() }],
    ['scoped to something the run does not cover', { scope: 'write' }],
  ])('never presents a session that is %s', async (_name, over) => {
    await seedSession(over as Partial<SessionFile>);
    const { fetch, calls } = makeReadServer({
      // No `session` handler: presenting one would throw rather than pass.
      plain: () => reply.paymentRequired(buildPaymentRequired()),
    });
    const err = await runRead({ ref: URL_ }, makeCtx(), { fetchImpl: fetch }).catch(
      (e: unknown) => e,
    );
    expect((err as CliError).code).toBe('REFUSED');
    expect((err as CliError).details).toMatchObject({ entitlementCheck: 'not_performed' });
    expect(calls.map((c) => c.phase)).toEqual(['plain']);
  });

  it('never presents a session for a piece already in the library (no network at all)', async () => {
    await seedSession();
    const body = readBody();
    await saveDelivery(dir, {
      resourceId: body.id,
      slug: body.slug,
      title: body.title,
      handle: 'iris',
      url: URL_,
      priceAtomic: body.price,
      entitlement: 'purchased',
      bodyMd: body.bodyMd,
    });
    const result = await runRead({ ref: URL_ }, makeCtx(), { fetchImpl: neverFetch });
    expect((result.data as { alreadyDelivered: boolean }).alreadyDelivered).toBe(true);
  });

  it('fails closed on a redirect during the signed retry, saving nothing', async () => {
    // The signed GET carries `tenjin-session-delegation`, which is in
    // CREDENTIAL_HEADERS, so the transport pins redirect: manual and refuses any
    // 3xx — and fetchRead pins blockRedirects on top. A followed hop would send
    // the signature to another host AND could write its bytes to the library as
    // an entitlement record.
    await seedSession();
    const { fetch } = makeReadServer({
      plain: () => reply.paymentRequired(buildPaymentRequired()),
      session: () =>
        new Response('', {
          status: 302,
          headers: { location: 'https://evil.example/api/read/iris/slug' },
        }),
    });
    await expect(runRead({ ref: URL_ }, makeCtx(), { fetchImpl: fetch })).rejects.toMatchObject({
      code: 'CONTRACT_MISMATCH',
    });
    await expect(readdir(libraryDir(dir))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('runRead, module boundary', () => {
  const here = new URL('.', import.meta.url).pathname;

  /**
   * Every local (relative) import specifier in a source file, in ALL THREE forms:
   * static `from '<spec>'`, dynamic `await import('<spec>')`, and the bare
   * side-effect `import '<spec>'`. Matching only the static form would be a false
   * green in this codebase specifically: `src/cli.ts` loads its commands through
   * `await import(...)` in 18 places, so a dynamic hop is the idiom here rather
   * than an exotic case, and a guard blind to it would wave through exactly the
   * refactor it exists to stop. All three QUOTE styles too: prettier normalizes
   * string literals to single quotes but is happy with a template-literal
   * specifier, so `import(\`../lib/x402-pay\`)` could land while a single-quote
   * matcher waved it through; double quotes cannot survive `format:check` but
   * cost nothing to cover.
   */
  function importSpecs(source: string): string[] {
    return [...source.matchAll(/(?:from|import)\s*\(?\s*(['"`])(\.[^'"`]+)\1/g)].map(
      (m) => m[2] as string,
    );
  }

  // Pin the matcher itself. Everything below is only as good as this regex, and its
  // failure mode is silence: an unmatched form yields [], which reads as "clean".
  it('importSpecs catches static, dynamic, and side-effect imports alike', () => {
    expect(importSpecs("import { fetchRead } from '../lib/read-client';")).toEqual([
      '../lib/read-client',
    ]);
    expect(importSpecs("const { buildExactPayment } = await import('../lib/x402-pay');")).toEqual([
      '../lib/x402-pay',
    ]);
    expect(importSpecs("import '../lib/x402-pay';")).toEqual(['../lib/x402-pay']);
    expect(importSpecs("import { z } from 'zod';")).toEqual([]); // bare specifiers are not local
    // Quote-style evasions: template literal (prettier-clean, so a live path) and
    // double quotes (format:check-blocked, but covered anyway).
    expect(importSpecs('const m = await import(`../lib/x402-pay`);')).toEqual(['../lib/x402-pay']);
    expect(importSpecs('const m = await import("../lib/x402-pay");')).toEqual(['../lib/x402-pay']);
    // Mismatched quotes are not an import the runtime would accept; stay silent.
    expect(importSpecs("await import('../lib/x402-pay`)")).toEqual([]);
  });

  // The structural pin the whole verb rests on: `read` must be UNABLE to pay OR
  // open a keystore, not merely choose not to. This walks read's transitive local
  // graph and asserts it never reaches:
  //   - lib/x402-pay        (the payment builder, imported by exactly one command: buy)
  //   - lib/session-key     (establishSession — MINTS wallet-signed delegations)
  //   - lib/wallet/*        (the keystore: provider resolution, local store, spend
  //                          authorizer), EXCEPT lib/wallet/provider, which is
  //                          type-only interface declarations with no runtime code —
  //                          lib/siwx names TenjinSigner in a signature, and a type
  //                          cannot unlock anything.
  //
  // `lib/session-present` is ALLOWED and is the whole point of the module split:
  // read may LOAD a delegation that already exists and sign one request with it,
  // which is how an owned-but-uncached piece comes back without paying. It may not
  // MINT one, because minting is the half that needs the wallet — and that half
  // stayed in lib/session-key, which is still banned above. The key read can
  // therefore hold is P-256: wrong curve for the EIP-712/secp256k1 signature an
  // EIP-3009 payment authorization needs, so no refactor inside this graph pays
  // for anything, and the delegation is read-scoped, which the SERVER refuses on
  // any write method.
  //
  // A future refactor that routes read through a paying or MINTING helper fails
  // here rather than in production.
  it('never reaches lib/x402-pay, lib/session-key, or the wallet through any transitive import', async () => {
    const seen = new Set<string>();

    function bannedReason(resolved: string): string | null {
      if (resolved.includes('/lib/x402-pay')) return 'the payment module';
      if (resolved.includes('/lib/session-key')) return 'the session-key module';
      if (resolved.includes('/lib/wallet') && !resolved.endsWith('/wallet/provider'))
        return 'a wallet module';
      return null;
    }

    async function walk(file: string): Promise<void> {
      if (seen.has(file)) return;
      seen.add(file);
      let source: string;
      try {
        source = await readFile(file, 'utf8');
      } catch {
        return; // a directory-style specifier or a .d.ts: nothing more to walk
      }
      for (const spec of importSpecs(source)) {
        const resolved = join(file, '..', spec);
        const reason = bannedReason(resolved);
        expect(
          reason,
          `${file} reaches ${spec}: ${reason ?? ''} must never be in read's graph`,
        ).toBeNull();
        await walk(`${resolved}.ts`);
        await walk(join(resolved, 'index.ts'));
      }
    }

    await walk(join(here, 'read.ts'));
    // Sanity: a broken walk would pass vacuously.
    expect(seen.size).toBeGreaterThan(5);
    expect([...seen].some((f) => f.includes('delivery'))).toBe(true);
    // The allowed half is actually IN the graph. Without this the "session-key is
    // banned" assertion above would stay green if read stopped presenting a
    // session at all, and the split would have quietly lost its reason to exist.
    expect([...seen].some((f) => f.endsWith('/lib/session-present.ts'))).toBe(true);
    // ...and the banned half is genuinely absent, stated positively rather than
    // resting on the walk having visited anything at all.
    expect([...seen].some((f) => f.endsWith('/lib/session-key.ts'))).toBe(false);

    // Name-level backstop, graph-wide (available now that the wallet barrel left
    // the graph): no file read can reach resolves a provider, opens a session, or
    // invokes a signer. `getSigner` is banned as a CALL (`.getSigner(`) because
    // lib/wallet/provider legitimately DECLARES it in the WalletProvider interface.
    for (const file of seen) {
      let source: string;
      try {
        source = await readFile(file, 'utf8');
      } catch {
        continue;
      }
      const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      for (const banned of ['establishSession', 'resolveWalletProvider', 'describeWallet']) {
        expect(code, `${file} must not reference ${banned}`).not.toContain(banned);
      }
      expect(code, `${file} must not call getSigner`).not.toMatch(/\.\s*getSigner\s*\(/);
    }
  });

  // The split's own invariant, pinned where the guarantee is claimed. The graph
  // walk above cannot catch this one: `lib/siwx` is ALREADY legitimately in
  // read's graph (read-client imports the header name from it), so "session-present
  // reaches siwx" is not expressible as a module ban. State it directly instead —
  // the allowed half must stay free of every seam a delegation could be minted
  // through, or the ban on `lib/session-key` becomes a formality someone routes
  // around by moving one function down a file.
  it('the ALLOWED half cannot mint: session-present reaches no wallet, siwx, or key generation', async () => {
    const source = await readFile(join(here, '..', 'lib', 'session-present.ts'), 'utf8');
    for (const spec of importSpecs(source)) {
      expect(spec, `session-present must not import ${spec}`).not.toMatch(
        /\/(wallet|siwx|session-key|x402-pay)(\/|$)/,
      );
    }
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    for (const banned of [
      'buildSiwxHeader', // the delegation's wallet signature
      'generateKey', // a fresh keypair is the other half of minting
      'TenjinSigner', // even the type: nothing here takes a signer
      'saveSessionFile', // writing a session is the mint half's job
      'establishSession',
    ]) {
      expect(code, `session-present must not reference ${banned}`).not.toContain(banned);
    }
  });

  // Belt-and-suspenders on read.ts itself: never the payment builder, never the
  // spend policy — by import OR by name. The graph walk above covers the module
  // level; this catches a re-export smuggled through an allowed path.
  it('never names the payment builder or the spend policy in its source', async () => {
    const source = await readFile(join(here, 'read.ts'), 'utf8');
    for (const spec of importSpecs(source)) {
      expect(spec).not.toMatch(/\/(x402-pay|policy)(\/|$)/);
    }
    for (const banned of [
      'buildExactPayment',
      'resolveSpendAuthorizer',
      'createLocalSpendAuthorizer',
      'SpendAuthorizer',
      'paymentHeaders',
      'x402',
    ]) {
      // The docblock explains what read does NOT do, so only the code half counts.
      const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      expect(code, `read.ts must not reference ${banned}`).not.toContain(banned);
    }
  });

  // read makes exactly ONE class of signature: a session-key signature over a
  // request it is about to send, with a delegation it loaded from disk. Not a
  // transfer authorization, not a SIWX auth message, not a fresh delegation. The
  // scan is an EXACT-SET assertion rather than a ban list, so a new `signFoo(`
  // appearing here fails even if nobody thought to ban it.
  it('signs only with a loaded session key: exactly one sign* call, no wallet or siwx import', async () => {
    const source = await readFile(join(here, 'read.ts'), 'utf8');
    const signCalls = [...source.matchAll(/\b(sign[A-Za-z]*)\s*\(/g)].map((m) => m[1]);
    expect(signCalls).toEqual(['signWithSession']);
    // The presentation is actually WIRED, not merely importable. A type-only
    // import keeps `session-present` in the graph walk above, and an extracted
    // helper keeps a `signWithSession(` call in the file, so without these the
    // pins stay green over a read that quietly stopped presenting anything —
    // which is how a security-relevant path becomes dead code unnoticed.
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    for (const wired of ['loadSessionFile(', 'isSessionPresentable(', 'originOf(']) {
      expect(code, `read.ts must still call ${wired}`).toContain(wired);
    }
    for (const spec of importSpecs(source)) {
      // `session-present` is deliberately NOT matched here: the ban is on the
      // minting module (`session-key`), which is the one that needs a wallet.
      expect(spec).not.toMatch(/\/(wallet|siwx|session-key)(\/|$)/);
    }
    expect(source).not.toContain('buildSiwxHeader');
    // The mint entry point by name, in case it is ever re-exported through an
    // allowed path: the graph walk covers modules, this covers the symbol.
    expect(source).not.toContain('establishSession');
  });
});

/**
 * The origin binding (the fix for the `--base-url` credential leak). A session
 * file records the origin it was minted against, and `read` presents only there.
 * Without this, `tenjin read <url> --base-url <attacker>` — one command line an
 * always-safe rule already clears — hands the delegation to a host the agent
 * chose, with `assertOnBaseOrigin` satisfied because the same flag set both sides.
 */
describe('runRead, the session key is bound to the origin it was minted for', () => {
  const OTHER = 'https://evil.example';

  it('never presents a session minted elsewhere, even when the flag sets both sides', async () => {
    const { file } = await testSessionKey(); // minted for https://tenjin.blog
    await saveSessionFile(dir, file);
    // The attacker host serves a shape-valid 402, which is all it takes to reach
    // step 3: paymentRequiredSchema validates shape, never provenance.
    const { fetch, calls } = makeReadServer({
      plain: () => reply.paymentRequired(buildPaymentRequired()),
      // Configured: presenting would throw here instead of leaking quietly.
      session: () => reply.entitled(readBody()),
    });
    const err = await runRead({ ref: `${OTHER}/api/read/iris/slug` }, makeCtx({ baseUrl: OTHER }), {
      fetchImpl: fetch,
    }).catch((e: unknown) => e);

    expect((err as CliError).code).toBe('REFUSED');
    // The load-bearing assertion: one call, unsigned. No delegation left the machine.
    expect(calls.map((c) => c.phase)).toEqual(['plain']);
    expect(calls[0]?.headers['tenjin-session-delegation']).toBeUndefined();
    expect(calls[0]?.headers.signature).toBeUndefined();
    // And the agent is told a session may help, because none was usable here.
    expect((err as CliError).details).toMatchObject({ entitlementCheck: 'not_performed' });
  });

  it('presents to the origin it WAS minted for, so the binding is not just a refusal', async () => {
    const { file } = await testSessionKey({ origin: OTHER });
    await saveSessionFile(dir, file);
    const { fetch, calls } = makeReadServer({
      plain: () => reply.paymentRequired(buildPaymentRequired()),
      session: () => reply.entitled(readBody()),
    });
    const result = await runRead(
      { ref: `${OTHER}/api/read/iris/slug` },
      makeCtx({ baseUrl: OTHER }),
      {
        fetchImpl: fetch,
      },
    );
    expect((result.data as { entitlement: string }).entitlement).toBe('entitled');
    expect(calls.map((c) => c.phase)).toEqual(['plain', 'session']);
  });
});

describe('runRead, a session file that cannot sign', () => {
  it('falls through to the refusal instead of escaping as an INTERNAL crash', async () => {
    // A garbage `d` used to reach subtle.importKey and throw a raw DOMException,
    // surfacing as exit 1 "Invalid keyData" with no fix — from the command whose
    // contract is that a bad session file degrades into the ordinary refusal.
    const { file } = await testSessionKey();
    await saveSessionFile(dir, {
      ...file,
      privateKeyJwk: { ...file.privateKeyJwk, d: 'not-a-key' },
    });
    const { fetch, calls } = makeReadServer({
      plain: () => reply.paymentRequired(buildPaymentRequired()),
      session: () => reply.entitled(readBody()),
    });
    const err = await runRead({ ref: URL_ }, makeCtx(), { fetchImpl: fetch }).catch(
      (e: unknown) => e,
    );
    expect((err as CliError).code).toBe('REFUSED');
    expect((err as CliError).exitCode).toBe(3);
    expect(calls.map((c) => c.phase)).toEqual(['plain']);
  });

  it('treats a structurally invalid key as no session at all', async () => {
    const { file } = await testSessionKey();
    await saveSessionFile(dir, { ...file, privateKeyJwk: {} as typeof file.privateKeyJwk });
    const { fetch } = makeReadServer({
      plain: () => reply.paymentRequired(buildPaymentRequired()),
    });
    const err = await runRead({ ref: URL_ }, makeCtx(), { fetchImpl: fetch }).catch(
      (e: unknown) => e,
    );
    expect((err as CliError).details).toMatchObject({ entitlementCheck: 'not_performed' });
  });
});

describe('runRead, the signed GET never loses the price it already knows', () => {
  it('a 5xx on the retry refuses with the price, not a bare transport error', async () => {
    await saveSessionFile(dir, (await testSessionKey()).file);
    const { fetch } = makeReadServer({
      plain: () => reply.paymentRequired(buildPaymentRequired()),
      session: () => new Response('{}', { status: 503 }),
    });
    const err = await runRead({ ref: URL_ }, makeCtx(), { fetchImpl: fetch }).catch(
      (e: unknown) => e,
    );
    const cliErr = err as CliError;
    expect(cliErr.code).toBe('REFUSED');
    expect(cliErr.message).toContain('0.10 USD');
    // The check did not complete, so buying is not the recommendation.
    expect(cliErr.details).toMatchObject({
      entitlementCheck: 'session_inconclusive',
      sessionCommand: 'tenjin session start --scope read',
    });
  });

  it('a 409 on the signed GET never becomes "this costs $X, run buy"', async () => {
    await saveSessionFile(dir, (await testSessionKey()).file);
    const { fetch } = makeReadServer({
      plain: () => reply.paymentRequired(buildPaymentRequired()),
      session: () => reply.alreadyPurchased(),
    });
    const err = await runRead({ ref: URL_ }, makeCtx(), { fetchImpl: fetch }).catch(
      (e: unknown) => e,
    );
    expect((err as CliError).details).toMatchObject({ entitlementCheck: 'session_inconclusive' });
  });

  it('still fails LOUD on a blocked redirect, which is a credential-exposure signal', async () => {
    await saveSessionFile(dir, (await testSessionKey()).file);
    const { fetch } = makeReadServer({
      plain: () => reply.paymentRequired(buildPaymentRequired()),
      session: () =>
        new Response('', { status: 302, headers: { location: 'https://evil.example/x' } }),
    });
    await expect(runRead({ ref: URL_ }, makeCtx(), { fetchImpl: fetch })).rejects.toMatchObject({
      code: 'CONTRACT_MISMATCH',
    });
  });
});

describe('runRead, the clock seam covers the signature too', () => {
  it('signs `created` from deps.now, not the wall clock', async () => {
    await saveSessionFile(dir, (await testSessionKey()).file);
    const { fetch, calls } = makeReadServer({
      plain: () => reply.paymentRequired(buildPaymentRequired()),
      session: () => reply.entitled(readBody()),
    });
    await runRead({ ref: URL_ }, makeCtx(), { fetchImpl: fetch, now: () => 1_700_000_000_000 });
    expect(calls[1]?.headers['signature-input']).toContain('created=1700000000');
  });
});
