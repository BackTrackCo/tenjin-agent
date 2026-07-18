import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBuy } from './buy';
import { findDelivered, saveDelivery } from '../lib/library';
import { recordLookup } from '../lib/lookup-store';
import {
  buildPaymentRequired,
  makeReadServer,
  readBody,
  reply,
  testWalletProvider,
} from '../lib/read-test-utils';
import type { SpendAuthorizer, SpendAuthorization } from '../lib/wallet';
import type { CommandContext, GlobalFlags } from '../context';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-buy-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeCtx(flags: Partial<GlobalFlags> = {}, isTTY = false): CommandContext {
  const sink = () => ({ write: () => true }) as unknown as NodeJS.WritableStream;
  return {
    flags: { json: false, timeout: 5000, ...flags },
    dataDir: dir,
    io: { stdout: sink(), stderr: sink(), isTTY },
  };
}

const URL_ = 'https://tenjin.blog/api/read/iris/slug';

/** A spend authorizer whose decision is fixed; records authorize/commit calls. */
function fakeAuthorizer(
  decision: SpendAuthorization['decision'],
  reason = 'within_policy',
): SpendAuthorizer {
  return {
    policyEnforcement: 'client-only',
    authorize: vi.fn(async (): Promise<SpendAuthorization> => ({
      decision,
      reason: reason as SpendAuthorization['reason'],
      message: 'test',
      amountAtomic: 100_000n,
      sessionSpentAtomic: 0n,
      sessionBudgetAtomic: 0n,
      policyEnforcement: 'client-only',
    })),
    commit: vi.fn(async () => undefined),
  };
}

describe('runBuy — free resource', () => {
  it('delivers a free 200 without a wallet and without any payment', async () => {
    const { fetch, calls } = makeReadServer({
      plain: () => reply.entitled(readBody({ price: '0' })),
    });
    const result = await runBuy({ ref: URL_ }, makeCtx(), { fetchImpl: fetch });
    const data = result.data as { entitlement: string; bodyPath: string };
    expect(data.entitlement).toBe('free');
    expect(calls.map((c) => c.phase)).toEqual(['plain']);
    expect(await findDelivered(dir, readBody().id)).not.toBeNull();
  });
});

describe('runBuy — entitlement re-check is SIWX-first and NEVER pays when entitled', () => {
  it('re-reads free via SIWX and never consults spend policy or pays', async () => {
    const pr = buildPaymentRequired();
    const { fetch, calls } = makeReadServer({
      plain: () => reply.paymentRequired(pr),
      siwx: () => reply.entitled(readBody()),
    });
    const authorizer = fakeAuthorizer('allow');
    const result = await runBuy({ ref: URL_ }, makeCtx(), {
      fetchImpl: fetch,
      provider: testWalletProvider(),
      authorizer,
    });
    const data = result.data as { entitlement: string };
    expect(data.entitlement).toBe('entitled');
    // The order proves the invariant: plain GET, THEN a SIWX re-check, and NO payment.
    expect(calls.map((c) => c.phase)).toEqual(['plain', 'siwx']);
    expect(calls.some((c) => c.phase === 'payment')).toBe(false);
    expect(authorizer.authorize).not.toHaveBeenCalled();
    expect(authorizer.commit).not.toHaveBeenCalled();
  });
});

describe('runBuy — paid path', () => {
  it('pays only after SIWX shows unentitled, then commits the session ledger', async () => {
    const pr = buildPaymentRequired();
    const { fetch, calls } = makeReadServer({
      plain: () => reply.paymentRequired(pr),
      siwx: () => reply.paymentRequired(pr),
      payment: () => reply.entitled(readBody()),
    });
    const authorizer = fakeAuthorizer('allow');
    const result = await runBuy({ ref: URL_ }, makeCtx(), {
      fetchImpl: fetch,
      provider: testWalletProvider(),
      authorizer,
    });
    const data = result.data as { entitlement: string; paid?: { atomic: string } };
    expect(data.entitlement).toBe('purchased');
    expect(data.paid?.atomic).toBe('100000');
    expect(calls.map((c) => c.phase)).toEqual(['plain', 'siwx', 'payment']);
    expect(authorizer.authorize).toHaveBeenCalledOnce();
    expect(authorizer.commit).toHaveBeenCalledWith(100_000n);
  });

  it('attaches X-Tenjin-Client on every request and X-Tenjin-Lookup-Id after a lookup', async () => {
    const pr = buildPaymentRequired();
    await recordLookup(dir, {
      lookupId: '0197aaaa-bbbb-cccc-dddd-abcabcabcabc',
      at: new Date().toISOString(),
      question: 'q',
      decision: 'CANDIDATES',
      candidates: [{ resourceId: readBody().id, url: URL_, title: 't', price: '100000' }],
    });
    const { fetch, calls } = makeReadServer({
      plain: () => reply.paymentRequired(pr),
      siwx: () => reply.paymentRequired(pr),
      payment: () => reply.entitled(readBody()),
    });
    await runBuy({ ref: URL_ }, makeCtx(), {
      fetchImpl: fetch,
      provider: testWalletProvider(),
      authorizer: fakeAuthorizer('allow'),
    });
    for (const call of calls) {
      expect(call.headers['x-tenjin-client']).toMatch(/^tenjin-cli\//);
      expect(call.headers['x-tenjin-lookup-id']).toBe('0197aaaa-bbbb-cccc-dddd-abcabcabcabc');
    }
  });
});

describe('runBuy — library idempotence', () => {
  it('re-delivers an already-delivered resource from disk with no network and no pay', async () => {
    const body = readBody();
    await saveDelivery(dir, {
      resourceId: body.id,
      slug: body.slug,
      title: body.title,
      handle: 'iris',
      url: URL_,
      priceAtomic: '100000',
      entitlement: 'purchased',
      bodyMd: body.bodyMd,
    });
    await recordLookup(dir, {
      lookupId: '0197aaaa-bbbb-cccc-dddd-abcabcabcabc',
      at: new Date().toISOString(),
      question: 'q',
      decision: 'CANDIDATES',
      candidates: [{ resourceId: body.id, url: URL_, title: body.title, price: '100000' }],
    });
    const fetchFn = vi.fn(async () => {
      throw new Error('network must not be touched for an already-delivered buy');
    });

    const result = await runBuy({ ref: body.id }, makeCtx(), {
      fetchImpl: fetchFn as unknown as typeof fetch,
    });
    const data = result.data as { alreadyDelivered: boolean; entitlement: string };
    expect(data.alreadyDelivered).toBe(true);
    expect(data.entitlement).toBe('purchased');
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('runBuy — spend policy', () => {
  it('a hard deny (e.g. price cap) refuses with exit-3 POLICY_REFUSED and never pays', async () => {
    const pr = buildPaymentRequired();
    const { fetch, calls } = makeReadServer({
      plain: () => reply.paymentRequired(pr),
      siwx: () => reply.paymentRequired(pr),
      payment: () => reply.entitled(readBody()),
    });
    await expect(
      runBuy({ ref: URL_, yes: true }, makeCtx(), {
        fetchImpl: fetch,
        provider: testWalletProvider(),
        authorizer: fakeAuthorizer('deny', 'price_cap_exceeded'),
      }),
    ).rejects.toMatchObject({ code: 'POLICY_REFUSED', exitCode: 3 });
    expect(calls.some((c) => c.phase === 'payment')).toBe(false);
  });

  it('a confirm decision, non-interactive and without --yes, refuses (exit 3) and never pays', async () => {
    const pr = buildPaymentRequired();
    const { fetch, calls } = makeReadServer({
      plain: () => reply.paymentRequired(pr),
      siwx: () => reply.paymentRequired(pr),
      payment: () => reply.entitled(readBody()),
    });
    await expect(
      runBuy({ ref: URL_ }, makeCtx({}, false), {
        fetchImpl: fetch,
        provider: testWalletProvider(),
        authorizer: fakeAuthorizer('confirm', 'confirm_always'),
      }),
    ).rejects.toMatchObject({ code: 'POLICY_REFUSED', exitCode: 3 });
    expect(calls.some((c) => c.phase === 'payment')).toBe(false);
  });

  it('--yes satisfies a confirm decision and proceeds to pay', async () => {
    const pr = buildPaymentRequired();
    const { fetch } = makeReadServer({
      plain: () => reply.paymentRequired(pr),
      siwx: () => reply.paymentRequired(pr),
      payment: () => reply.entitled(readBody()),
    });
    const result = await runBuy({ ref: URL_, yes: true }, makeCtx(), {
      fetchImpl: fetch,
      provider: testWalletProvider(),
      authorizer: fakeAuthorizer('confirm', 'confirm_always'),
    });
    expect((result.data as { entitlement: string }).entitlement).toBe('purchased');
  });

  it('an interactive decline refuses (exit 3)', async () => {
    const pr = buildPaymentRequired();
    const { fetch } = makeReadServer({
      plain: () => reply.paymentRequired(pr),
      siwx: () => reply.paymentRequired(pr),
      payment: () => reply.entitled(readBody()),
    });
    await expect(
      runBuy({ ref: URL_ }, makeCtx({}, true), {
        fetchImpl: fetch,
        provider: testWalletProvider(),
        authorizer: fakeAuthorizer('confirm', 'confirm_always'),
        confirm: async () => false,
      }),
    ).rejects.toMatchObject({ code: 'POLICY_REFUSED', exitCode: 3 });
  });
});

describe('runBuy — owned-re-pay 409 gate', () => {
  it('a rejected re-pay falls back to a free SIWX re-read and never commits a spend', async () => {
    const pr = buildPaymentRequired();
    let siwxCalls = 0;
    const { fetch, calls } = makeReadServer({
      plain: () => reply.paymentRequired(pr),
      siwx: () => {
        siwxCalls += 1;
        // First SIWX is the pre-pay re-check (still unentitled); the second is the
        // post-409 recovery (now entitled).
        return siwxCalls === 1 ? reply.paymentRequired(pr) : reply.entitled(readBody());
      },
      payment: () => reply.alreadyPurchased(),
    });
    const authorizer = fakeAuthorizer('allow');
    const result = await runBuy({ ref: URL_ }, makeCtx(), {
      fetchImpl: fetch,
      provider: testWalletProvider(),
      authorizer,
    });
    expect((result.data as { entitlement: string }).entitlement).toBe('entitled');
    expect(calls.map((c) => c.phase)).toEqual(['plain', 'siwx', 'payment', 'siwx']);
    expect(authorizer.commit).not.toHaveBeenCalled();
  });
});
