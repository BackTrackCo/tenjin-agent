import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRead } from './read';
import { findDelivered, libraryDir, saveDelivery } from '../lib/library';
import { recordSearch } from '../lib/search-store';
import {
  buildPaymentRequired,
  makeReadServer,
  readBody,
  reply,
  testSigner,
  testWalletProvider,
} from '../lib/read-test-utils';
import type { TenjinSigner, WalletProvider } from '../lib/wallet';
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

/**
 * A wallet provider that fails the test the moment anything asks it for a signer.
 * `read` resolves a signer ONLY on the paid branch, so every other path passes
 * this without unlocking a keystore.
 */
function neverSignsProvider(): WalletProvider {
  return {
    ...testWalletProvider(),
    getSigner: async (): Promise<TenjinSigner> => {
      throw new Error('the keystore must not be unlocked on this path');
    },
  };
}

/** Records whether a signer was ever asked for, without failing the test. */
function countingProvider(): { provider: WalletProvider; signerCalls: () => number } {
  let n = 0;
  const base = testWalletProvider();
  return {
    provider: {
      ...base,
      getSigner: async () => {
        n += 1;
        return testSigner();
      },
    },
    signerCalls: () => n,
  };
}

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
      provider: neverSignsProvider(),
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
      provider: neverSignsProvider(),
    });
    expect((result.data as { alreadyDelivered: boolean }).alreadyDelivered).toBe(true);
  });
});

describe('runRead, entitled remote re-read (SIWX)', () => {
  it('delivers a piece the wallet already owns via the SIWX auth check, paying nothing', async () => {
    // Nothing in the local library: this is the cross-machine case — entitled
    // server-side, absent from disk. The 402 probe is followed by a SIWX-signed
    // re-read, which the server answers with the full body.
    const pr = buildPaymentRequired();
    const { fetch, calls } = makeReadServer({
      plain: () => reply.paymentRequired(pr),
      siwx: () => reply.entitled(readBody()),
      payment: () => reply.entitled(readBody()),
    });
    const { provider, signerCalls } = countingProvider();

    const result = await runRead({ ref: URL_ }, makeCtx(), { fetchImpl: fetch, provider });
    const data = result.data as { entitlement: string; bodyPath: string };

    expect(data.entitlement).toBe('entitled');
    await expect(readFile(data.bodyPath, 'utf8')).resolves.toContain('full body');
    expect(result.humanLines?.[0]).toContain('already owned');
    // It is stored to the library through the normal delivery path, so the NEXT
    // read is a local hit that never touches the keystore.
    await expect(findDelivered(dir, readBody().id)).resolves.not.toBeNull();

    // Exactly probe-then-auth. The mock would have DELIVERED on a payment attempt,
    // so the absent `payment` phase is a real assertion, not an accident of setup.
    expect(calls.map((c) => c.phase)).toEqual(['plain', 'siwx']);
    expect(calls[1]?.headers['payment-signature']).toBeUndefined();
    expect(signerCalls()).toBe(1);
  });
});

describe('runRead, paid refusal', () => {
  it('exits 3 after the SIWX check comes back unentitled, without ever paying or saving', async () => {
    const pr = buildPaymentRequired();
    // The trap: a payment attempt would SUCCEED against this mock. Refusing anyway
    // is the proof that no payment is constructed, not merely that none succeeded.
    const { fetch, calls } = makeReadServer({
      plain: () => reply.paymentRequired(pr),
      siwx: () => reply.paymentRequired(pr),
      payment: () => reply.entitled(readBody()),
    });

    const err = await runRead({ ref: URL_ }, makeCtx(), {
      fetchImpl: fetch,
      provider: testWalletProvider(),
    }).catch((e: unknown) => e);
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
      entitlementCheck: 'siwx_unentitled',
      price: { usd: '0.1', atomic: '100000' },
      buyCommand: `tenjin buy ${URL_}`,
    });

    // Probe, auth check, refusal. Never a payment phase.
    expect(calls.map((c) => c.phase)).toEqual(['plain', 'siwx']);
    // Nothing is written to the library on a refusal.
    await expect(readdir(libraryDir(dir))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses cleanly when there is no wallet to prove entitlement with', async () => {
    // No wallet file was ever created in this temp data dir, so the real local
    // provider raises WALLET_MISSING. That must surface as read's exit-3 refusal,
    // not as a runtime wallet error: unprovable and absent look the same from here.
    const pr = buildPaymentRequired();
    const { fetch, calls } = makeReadServer({
      plain: () => reply.paymentRequired(pr),
      siwx: () => reply.entitled(readBody()),
    });

    const err = await runRead({ ref: URL_ }, makeCtx(), { fetchImpl: fetch }).catch(
      (e: unknown) => e,
    );
    expect((err as CliError).code).toBe('REFUSED');
    expect((err as CliError).exitCode).toBe(3);
    expect((err as CliError).details).toMatchObject({ entitlementCheck: 'skipped_no_wallet' });
    // It never got as far as signing, so no SIWX request was made.
    expect(calls.map((c) => c.phase)).toEqual(['plain']);
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
  // merely choose not to. lib/x402-pay is the payment module, imported by exactly
  // one command (buy); this walks read's transitive local graph to prove it is
  // absent, so a future refactor that routes read through a paying helper fails here
  // rather than in production.
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
  });

  // read DOES import the wallet and lib/siwx, by operator decision (#43), to sign
  // the AUTH message that proves an existing entitlement. What it must never touch
  // is the money half: the payment builder and the spend policy. lib/wallet is a
  // barrel that re-exports the spend authorizer, so an import check alone would not
  // catch a read that started authorizing spends — assert on the USAGE too.
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

  // The signature read makes must be the same class publish makes: an
  // authentication message, never a transfer authorization.
  it('signs only through buildSiwxHeader, the auth-message helper', async () => {
    const source = await readFile(join(here, 'read.ts'), 'utf8');
    const signCalls = [...source.matchAll(/\b(sign[A-Za-z]*)\s*\(/g)].map((m) => m[1]);
    expect(signCalls).toEqual([]);
    expect(source).toContain("import { buildSiwxHeader } from '../lib/siwx'");
  });
});
