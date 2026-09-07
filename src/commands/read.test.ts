import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRead } from './read';
import { libraryDir, saveDelivery } from '../lib/library';
import { recordSearch } from '../lib/searches';
import {
  buildPaymentRequired,
  makeReadServer,
  readBody,
  reply,
  TEST_ORIGIN,
  testSessionKey,
  testWalletProvider,
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
  it('exits 3 on the first 402 when there is no wallet to ask the question with', async () => {
    // The cold-read case on a machine with no key: paid, nothing in the local
    // library, no session on disk, and no wallet to mint one. Ownership is
    // UNKNOWN rather than denied, and the refusal still lands on the FIRST 402.
    // The mock is a triple trap: an SIWX re-check would have DELIVERED, a session
    // presentation would have DELIVERED, and a payment would have SUCCEEDED — so
    // all three absent phases are real assertions, not accidents of setup.
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
    // The message names the price; the fix names the verb that can pay, and the
    // wallet that was missing — never a session verb, because there is none.
    expect(cliErr.message).toContain('0.10 USD');
    expect(cliErr.message).toContain('100000 atomic');
    expect(cliErr.fix).toContain('tenjin buy');
    expect(cliErr.fix).toContain('tenjin wallet create');
    expect(cliErr.fix).not.toContain('session start');
    expect(cliErr.details).toMatchObject({
      reason: 'payment_required',
      entitlementCheck: 'no_wallet',
      price: { usd: '0.1', atomic: '100000' },
      buyCommand: `tenjin buy ${URL_}`,
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
    // Not API_UNREACHABLE: exactly one presentation per run, so a delegation the
    // server declined ends the attempt. And NOT `'session'`: the server never
    // answered the ownership question, so telling the agent to buy would spend
    // money on a piece it may already own.
    const cliErr = err as CliError;
    expect(cliErr.code).toBe('REFUSED');
    expect(cliErr.details).toMatchObject({ entitlementCheck: 'session_rejected' });
    expect(calls.map((c) => c.phase)).toEqual(['plain', 'session']);
  });

  const UNUSABLE: Array<[string, Partial<SessionFile>]> = [
    ['expired', { exp: new Date(Date.now() - 1000).toISOString() }],
    ['too close to expiry for the 60s skew', { exp: new Date(Date.now() + 5000).toISOString() }],
    ['scoped to something the run does not cover', { scope: 'write' }],
  ];

  it.each(UNUSABLE)(
    'never presents a session that is %s, and cannot mint without a wallet',
    async (_name, over) => {
      await seedSession(over);
      const { fetch, calls } = makeReadServer({
        // No `session` handler: presenting one would throw rather than pass.
        plain: () => reply.paymentRequired(buildPaymentRequired()),
      });
      const err = await runRead({ ref: URL_ }, makeCtx(), { fetchImpl: fetch }).catch(
        (e: unknown) => e,
      );
      expect((err as CliError).code).toBe('REFUSED');
      expect((err as CliError).details).toMatchObject({ entitlementCheck: 'no_wallet' });
      expect(calls.map((c) => c.phase)).toEqual(['plain']);
    },
  );

  it.each(UNUSABLE)(
    'mints a fresh session over one that is %s, and presents that',
    async (_name, over) => {
      const stale = await seedSession(over);
      const { fetch, calls } = makeReadServer({
        plain: () => reply.paymentRequired(buildPaymentRequired()),
        session: () => reply.entitled(readBody()),
      });
      const result = await runRead({ ref: URL_ }, makeCtx(), {
        fetchImpl: fetch,
        provider: testWalletProvider(),
      });
      expect((result.data as { entitlement: string }).entitlement).toBe('entitled');
      expect(calls.map((c) => c.phase)).toEqual(['plain', 'session']);
      // The stale delegation was replaced on disk, not presented: what went out is
      // the new one, minted for the same origin at read scope.
      const onDisk = JSON.parse(await readFile(join(dir, 'session.json'), 'utf8')) as SessionFile;
      expect(onDisk.delegation).not.toBe(stale.delegation);
      expect(onDisk.scope).toBe('read');
      expect(onDisk.origin).toBe(TEST_ORIGIN);
    },
  );

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

  /** A provider that counts how many times the keystore was actually opened. */
  function countingProvider(): {
    provider: ReturnType<typeof testWalletProvider>;
    unlocks: number;
  } {
    const inner = testWalletProvider();
    const state = { unlocks: 0 };
    return {
      provider: {
        ...inner,
        getSigner: async () => {
          state.unlocks += 1;
          return inner.getSigner();
        },
      },
      get unlocks() {
        return state.unlocks;
      },
    };
  }

  it('opens the keystore once for an owned piece and reuses the delegation after', async () => {
    // The case a separate minting verb used to exist for: paid, owned, and not on
    // this machine. The first read mints; the second finds the delegation on disk and
    // asks the wallet for nothing.
    const counting = countingProvider();
    const { fetch, calls } = makeReadServer({
      plain: () => reply.paymentRequired(buildPaymentRequired()),
      session: () => reply.entitled(readBody()),
    });
    const first = await runRead({ ref: URL_ }, makeCtx(), {
      fetchImpl: fetch,
      provider: counting.provider,
    });
    expect((first.data as { entitlement: string }).entitlement).toBe('entitled');
    expect(counting.unlocks).toBe(1);
    const minted = JSON.parse(await readFile(join(dir, 'session.json'), 'utf8')) as SessionFile;
    expect(minted.scope).toBe('read');
    expect(minted.origin).toBe(TEST_ORIGIN);

    // The piece is in the library now, so a second read of the SAME url would not
    // reach step 3 at all. Ask for another one on the same origin instead.
    const other = 'https://tenjin.blog/api/read/iris/other';
    const second = await runRead({ ref: other }, makeCtx(), {
      fetchImpl: fetch,
      provider: counting.provider,
    });
    expect((second.data as { entitlement: string }).entitlement).toBe('entitled');
    expect(counting.unlocks).toBe(1);
    expect(calls.map((c) => c.phase)).toEqual(['plain', 'session', 'plain', 'session']);
    expect(
      JSON.parse(await readFile(join(dir, 'session.json'), 'utf8')) as SessionFile,
    ).toStrictEqual(minted);
  });

  it('never touches the keystore for a free piece', async () => {
    // Step 2 delivers, so nothing below it runs. The provider fails the test if
    // it is reached at all: a free read must cost no wallet interaction, which is
    // what keeps `read` usable on a machine with no wallet.
    const counting = countingProvider();
    const { fetch, calls } = makeReadServer({ plain: () => reply.entitled(readBody()) });
    const result = await runRead({ ref: URL_ }, makeCtx(), {
      fetchImpl: fetch,
      provider: counting.provider,
    });
    expect((result.data as { entitlement: string }).entitlement).toBe('free');
    expect(counting.unlocks).toBe(0);
    expect(calls.map((c) => c.phase)).toEqual(['plain']);
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

  // The structural pin the whole verb rests on: `read` must be UNABLE to pay, not
  // merely choose not to. This walks read's transitive local graph and asserts it
  // never reaches `lib/x402-pay`, the payment builder, imported by exactly one
  // command: buy.
  //
  // It is the ONE ban left. `read` mints its own read-scoped delegation now
  // (decision 15), so `lib/session-key` and the wallet are legitimately in the
  // graph and banning them would only be banning the feature. What still holds,
  // structurally, is that the key it ends up signing with is P-256: the wrong
  // curve for the EIP-712/secp256k1 signature an EIP-3009 payment authorization
  // needs, so no refactor inside this graph pays for anything.
  //
  // A future refactor that routes read through a paying helper fails here rather
  // than in production.
  it('never reaches lib/x402-pay through any transitive import', async () => {
    const seen = new Set<string>();

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
        expect(
          resolved.includes('/lib/x402-pay'),
          `${file} reaches ${spec}: the payment module must never be in read's graph`,
        ).toBe(false);
        await walk(`${resolved}.ts`);
        await walk(join(resolved, 'index.ts'));
      }
    }

    await walk(join(here, 'read.ts'));
    // Sanity: a broken walk would pass vacuously.
    expect(seen.size).toBeGreaterThan(5);
    expect([...seen].some((f) => f.includes('delivery'))).toBe(true);
    // Both halves of the session layer are actually IN the graph: the present
    // half it signs with, and the mint half it now reaches through the same
    // `resolveWriteAuth` publish uses. Stated positively so the ban above cannot
    // stay green over a read that quietly stopped recovering owned pieces.
    expect([...seen].some((f) => f.endsWith('/lib/session-present.ts'))).toBe(true);
    expect([...seen].some((f) => f.endsWith('/lib/session-key.ts'))).toBe(true);
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
  // request it is about to send. Not a transfer authorization. The scan is an
  // EXACT-SET assertion rather than a ban list, so a new `signFoo(` appearing
  // here fails even if nobody thought to ban it. `buildSiwxHeader` is absent
  // because read does not call it: the delegation's one wallet signature is made
  // inside `session-key.ts`, through `resolveWriteAuth`, which is the whole point
  // of routing the mint there rather than open-coding it.
  it('signs only through the session layer: exactly one sign* call, no SIWX of its own', async () => {
    const source = await readFile(join(here, 'read.ts'), 'utf8');
    const signCalls = [...source.matchAll(/\b(sign[A-Za-z]*)\s*\(/g)].map((m) => m[1]);
    expect(signCalls).toEqual(['signWithSession']);
    // The presentation and the mint are actually WIRED, not merely importable. A
    // type-only import keeps a module in the graph walk above, so without these
    // the pins stay green over a read that quietly stopped doing either.
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    for (const wired of [
      'loadSessionFile(',
      'isSessionPresentable(',
      'resolveWriteAuth(',
      'originOf(',
    ]) {
      expect(code, `read.ts must still call ${wired}`).toContain(wired);
    }
    expect(source).not.toContain('buildSiwxHeader');
    // The scope it asks for, pinned: a wider one would leave a write-capable
    // credential on disk behind an always-safe verb.
    expect(code).toContain("scope: 'read'");
    expect(code).not.toContain('read+write');
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

    const cliErr = err as CliError;
    expect(cliErr.code).toBe('REFUSED');
    // The load-bearing assertion: one call, unsigned. No delegation left the machine.
    expect(calls.map((c) => c.phase)).toEqual(['plain']);
    expect(calls[0]?.headers['tenjin-session-delegation']).toBeUndefined();
    expect(calls[0]?.headers.signature).toBeUndefined();
    expect(cliErr.details).toMatchObject({ entitlementCheck: 'session_origin_mismatch' });
  });

  // A mismatch is the ONE state that refuses to mint. Every other unusable
  // session ends in a fresh one, so without this an agent still carrying the
  // `--base-url` that caused the mismatch would wallet-sign a delegation against
  // the attacker host and clobber the good prod session.
  it('never mints against another origin while a session for one is cached', async () => {
    const { file } = await testSessionKey(); // minted for TEST_ORIGIN
    await saveSessionFile(dir, file);
    const { fetch } = makeReadServer({
      plain: () => reply.paymentRequired(buildPaymentRequired()),
      session: () => reply.entitled(readBody()),
    });
    const err = (await runRead(
      { ref: `${OTHER}/api/read/iris/slug` },
      makeCtx({ baseUrl: OTHER }),
      { fetchImpl: fetch },
    ).catch((e: unknown) => e)) as CliError;

    expect(err.details).not.toHaveProperty('sessionCommand');
    expect(err.fix).not.toContain('tenjin session start');
    // The remedy it DOES give: stop redirecting the CLI.
    expect(err.fix).toMatch(/minted for a different Tenjin deployment/i);
    expect(err.fix).toContain('tenjin config get baseUrl');
    // ...while with no cached session at all the same command MINTS and reads,
    // so this is a real distinction rather than the fix line having been blanked:
    // a mismatch is the one state that refuses to mint.
    await rm(join(dir, 'session.json'));
    const delivered = await runRead(
      { ref: `${OTHER}/api/read/iris/slug` },
      makeCtx({ baseUrl: OTHER }),
      { fetchImpl: fetch, provider: testWalletProvider() },
    );
    expect((delivered.data as { entitlement: string }).entitlement).toBe('entitled');
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
    expect((err as CliError).details).toMatchObject({ entitlementCheck: 'no_wallet' });
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
    expect(cliErr.details).toMatchObject({ entitlementCheck: 'session_inconclusive' });
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

describe('runRead, failures that must stay loud on the signed GET', () => {
  it('re-throws RATE_LIMITED with retryAfterSeconds instead of swallowing the backoff', async () => {
    // A 429 is a recoverable pause the CLI models explicitly everywhere else.
    // Folding it into a price refusal costs a looping agent its backoff signal
    // AND points it at the one command that opens the keystore.
    await saveSessionFile(dir, (await testSessionKey()).file);
    const { fetch } = makeReadServer({
      plain: () => reply.paymentRequired(buildPaymentRequired()),
      session: () => new Response('{}', { status: 429, headers: { 'retry-after': '30' } }),
    });
    await expect(runRead({ ref: URL_ }, makeCtx(), { fetchImpl: fetch })).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      details: { retryAfterSeconds: 30 },
    });
  });

  it('a cryptographically invalid cached key fails with a fix, never a bare DOMException', async () => {
    // Schema-valid (kty/crv/d/x/y all present, non-empty) but not a real key, so
    // it reaches subtle.importKey. read still degrades into its refusal, but the
    // translated error is what stops publish/edit exiting 1 on "Invalid keyData".
    const { file } = await testSessionKey();
    await saveSessionFile(dir, { ...file, privateKeyJwk: { ...file.privateKeyJwk, d: 'AA' } });
    const { fetch, calls } = makeReadServer({
      plain: () => reply.paymentRequired(buildPaymentRequired()),
      session: () => reply.entitled(readBody()),
    });
    const err = (await runRead({ ref: URL_ }, makeCtx(), { fetchImpl: fetch }).catch(
      (e: unknown) => e,
    )) as CliError;
    expect(err.code).toBe('REFUSED');
    expect(calls.map((c) => c.phase)).toEqual(['plain']);
  });
});

/**
 * TEAM MODE READS FROM TWO ORIGINS. A team-mode search surfaces candidates from
 * the team shelf AND from the public marketplace, so `read` has to resolve both
 * — a `read` that refused every public-shelf hit would make the fallback leg
 * useless. The bypass key still goes to one origin only.
 */
describe('runRead across two shelves', () => {
  const TEAM = 'https://team.example';
  const SECRET = 'shelf-secret-abc123';
  const BYPASS_HEADER = 'x-vercel-protection-bypass';
  const PUBLIC_URL = 'https://tenjin.blog/api/read/iris/slug';
  const TEAM_URL = `${TEAM}/api/read/iris/slug`;

  /** Team mode: baseUrl is the team shelf, publicShelfUrl is tenjin.blog. */
  async function writeShelfConfig(): Promise<void> {
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({
        baseUrl: TEAM,
        publicShelfUrl: TEST_ORIGIN,
        shelfBypassSecret: SECRET,
      }),
    );
  }

  /** No --base-url, so the config above decides. */
  function shelfCtx(): CommandContext {
    const sink = () => ({ write: () => true }) as unknown as NodeJS.WritableStream;
    return {
      flags: { json: false, timeout: 5000 },
      dataDir: dir,
      io: { stdout: sink(), stderr: sink(), isTTY: false },
    };
  }

  it('reads a free piece on the team shelf, with the key', async () => {
    await writeShelfConfig();
    const { fetch, calls } = makeReadServer({
      plain: () => reply.entitled(readBody({ price: '0' })),
    });
    const result = await runRead({ ref: TEAM_URL }, shelfCtx(), { fetchImpl: fetch });
    expect((result.data as { entitlement: string }).entitlement).toBe('free');
    expect(calls[0]?.headers[BYPASS_HEADER]).toBe(SECRET);
  });

  it('reads a free piece on the public shelf, and sends it no key', async () => {
    await writeShelfConfig();
    const { fetch, calls } = makeReadServer({
      plain: () => reply.entitled(readBody({ price: '0' })),
    });
    const result = await runRead({ ref: PUBLIC_URL }, shelfCtx(), { fetchImpl: fetch });
    expect((result.data as { entitlement: string }).entitlement).toBe('free');
    expect(calls[0]?.url).toBe(PUBLIC_URL);
    expect(calls[0]?.headers[BYPASS_HEADER]).toBeUndefined();
  });

  it('resolves a stored public-shelf candidate by id', async () => {
    await writeShelfConfig();
    const resourceId = '0197aaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    await recordSearch(dir, {
      searchId: '0197aaaa-bbbb-cccc-dddd-000000000001',
      at: new Date().toISOString(),
      question: 'q',
      decision: 'CANDIDATES',
      candidates: [{ resourceId, url: PUBLIC_URL, title: 'A resource', price: '0' }],
    });
    const { fetch, calls } = makeReadServer({
      plain: () => reply.entitled(readBody({ price: '0' })),
    });
    await runRead({ ref: resourceId }, shelfCtx(), { fetchImpl: fetch });
    expect(calls[0]?.url).toBe(PUBLIC_URL);
  });

  it('still refuses an origin that is neither shelf', async () => {
    await writeShelfConfig();
    await expect(
      runRead({ ref: 'https://evil.example/api/read/iris/slug' }, shelfCtx(), {
        fetchImpl: neverFetch,
      }),
    ).rejects.toMatchObject({ code: 'USAGE' });
  });

  it('refuses the public shelf in public mode, when it is not the configured base', async () => {
    // No secret: one shelf, and `publicShelfUrl` widens nothing. A read is
    // pinned to the configured base exactly as it always was.
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ baseUrl: TEAM, publicShelfUrl: TEST_ORIGIN }),
    );
    await expect(
      runRead({ ref: PUBLIC_URL }, shelfCtx(), { fetchImpl: neverFetch }),
    ).rejects.toMatchObject({ code: 'USAGE' });
  });
});
