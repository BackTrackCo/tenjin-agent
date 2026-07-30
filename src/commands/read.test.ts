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
  withTrailingSlashRedirect,
} from '../lib/read-test-utils';
import { CliError } from '../lib/errors';
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
    flags: { json: false, timeout: 5000, ...flags },
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
  it('exits 3 straight off the first 402, with no wallet path and no second request', async () => {
    // The cold-read case: paid, and nothing in the local library. Since the SIWX
    // recovery path was cut (operator decision, #43), the refusal lands on the
    // FIRST 402 — read has no wallet to prove an entitlement with, whether or not
    // one exists on this machine. The mock is a double trap: an SIWX re-check
    // would have DELIVERED, and a payment attempt would have SUCCEEDED, so both
    // absent phases are real assertions, not accidents of setup.
    const pr = buildPaymentRequired();
    const { fetch, calls } = makeReadServer({
      plain: () => reply.paymentRequired(pr),
      siwx: () => reply.entitled(readBody()),
      payment: () => reply.entitled(readBody()),
    });

    const err = await runRead({ ref: URL_ }, makeCtx(), { fetchImpl: fetch }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CliError);
    const cliErr = err as CliError;
    expect(cliErr.code).toBe('REFUSED');
    expect(cliErr.exitCode).toBe(3);
    // The message names the price; the fix names the verb that can pay.
    expect(cliErr.message).toContain('0.10 USD');
    expect(cliErr.message).toContain('100000 atomic');
    expect(cliErr.fix).toContain('tenjin buy');
    expect(cliErr.details).toMatchObject({
      reason: 'payment_required',
      entitlementCheck: 'not_performed',
      price: { usd: '0.1', atomic: '100000' },
      buyCommand: `tenjin buy ${URL_}`,
    });

    // Exactly one unauthenticated probe. Never an SIWX phase, never a payment.
    expect(calls.map((c) => c.phase)).toEqual(['plain']);
    expect(calls[0]?.headers['sign-in-with-x']).toBeUndefined();
    expect(calls[0]?.headers['payment-signature']).toBeUndefined();
    // Nothing is written to the library on a refusal.
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
  //   - lib/session-key     (establishSession — mints wallet-signed delegations)
  //   - lib/wallet/*        (the keystore: provider resolution, local store, spend
  //                          authorizer), EXCEPT lib/wallet/provider, which is
  //                          type-only interface declarations with no runtime code —
  //                          lib/siwx names TenjinSigner in a signature, and a type
  //                          cannot unlock anything.
  // A future refactor that routes read through a paying or signing helper fails
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

  // Since the SIWX recovery path was cut (operator decision, #43), read makes NO
  // signature of any class: not a transfer authorization, not even an auth
  // message. Its source imports neither the wallet barrel nor lib/siwx.
  it('signs nothing at all: no sign* call, no wallet or siwx import', async () => {
    const source = await readFile(join(here, 'read.ts'), 'utf8');
    const signCalls = [...source.matchAll(/\b(sign[A-Za-z]*)\s*\(/g)].map((m) => m[1]);
    expect(signCalls).toEqual([]);
    for (const spec of importSpecs(source)) {
      expect(spec).not.toMatch(/\/(wallet|siwx|session-key)(\/|$)/);
    }
    expect(source).not.toContain('buildSiwxHeader');
  });
});
