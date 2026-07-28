import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRead } from './read';
import { findDelivered, libraryDir, saveDelivery } from '../lib/library';
import { recordLookup } from '../lib/lookup-store';
import { buildPaymentRequired, makeReadServer, readBody, reply } from '../lib/read-test-utils';
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
    const result = await runRead({ ref: URL_ }, makeCtx(), { fetchImpl: neverFetch });
    const data = result.data as { alreadyDelivered: boolean; entitlement: string };
    expect(data.alreadyDelivered).toBe(true);
    expect(data.entitlement).toBe('purchased');
    expect(result.humanLines?.[0]).toContain('No payment made.');
  });

  it('re-delivers by resource id as well as by url', async () => {
    const body = readBody();
    // A bare id resolves through the local lookup store, exactly as it does for buy.
    await recordLookup(dir, {
      lookupId: '0197aaaa-bbbb-cccc-dddd-abcabcabcabc',
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
    const result = await runRead({ ref: body.id }, makeCtx(), { fetchImpl: neverFetch });
    expect((result.data as { alreadyDelivered: boolean }).alreadyDelivered).toBe(true);
  });
});

describe('runRead, paid refusal', () => {
  it('exits 3 naming the price and pointing at buy, without paying or saving', async () => {
    const pr = buildPaymentRequired();
    const { fetch, calls } = makeReadServer({ plain: () => reply.paymentRequired(pr) });

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
      price: { usd: '0.1', atomic: '100000' },
      buyCommand: `tenjin buy ${URL_}`,
    });

    // One unauthenticated probe, then a refusal: never a SIWX re-check (which would
    // need the wallet) and never a payment attempt.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.phase).toBe('plain');
    // Nothing is written to the library on a refusal.
    await expect(readdir(libraryDir(dir))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses rather than taking buy’s SIWX entitlement re-check, even when it would succeed', async () => {
    // The trap: the mock is configured to answer a SIWX re-check with the full body.
    // If `read` ever signed one (which means resolving the wallet), it would deliver
    // and this test would fail. Refusing here is the wallet-untouched proof.
    const pr = buildPaymentRequired();
    const { fetch, calls } = makeReadServer({
      plain: () => reply.paymentRequired(pr),
      siwx: () => reply.entitled(readBody()),
      payment: () => reply.entitled(readBody()),
    });

    await expect(runRead({ ref: URL_ }, makeCtx(), { fetchImpl: fetch })).rejects.toMatchObject({
      code: 'REFUSED',
      exitCode: 3,
    });
    expect(calls.map((c) => c.phase)).toEqual(['plain']);
    // And no delivery receipt was created for it.
    await expect(findDelivered(dir, readBody().id)).resolves.toBeNull();
  });
});

describe('runRead, module boundary', () => {
  const here = new URL('.', import.meta.url).pathname;

  /** Every local (relative) import specifier in a source file. */
  function importSpecs(source: string): string[] {
    return [...source.matchAll(/from\s+'(\.[^']+)'/g)].map((m) => m[1] as string);
  }

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

  // Direct imports are the part read controls. lib/siwx and lib/wallet/provider are
  // reachable further down the shared read-client graph (as types and a header
  // constant), so the transitive walk above cannot say anything about them; what
  // matters is that READ itself never pulls in the wallet, the spend policy, or the
  // signing helper, because those are what a payment would need.
  it('directly imports no wallet, spend-policy, or SIWX module', async () => {
    const source = await readFile(join(here, 'read.ts'), 'utf8');
    for (const spec of importSpecs(source)) {
      expect(spec).not.toMatch(/\/(x402-pay|policy|siwx|wallet)(\/|$)/);
    }
  });
});
