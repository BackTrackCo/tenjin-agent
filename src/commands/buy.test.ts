import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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

const RESERVATION = 'rsv-test';

/** A spend authorizer whose decision is fixed; records authorize/commit/release. */
function fakeAuthorizer(
  decision: SpendAuthorization['decision'],
  reason = 'within_policy',
): SpendAuthorizer {
  return {
    policyEnforcement: 'client-only',
    authorize: vi.fn(async (req): Promise<SpendAuthorization> => ({
      decision,
      reason: reason as SpendAuthorization['reason'],
      message: 'test',
      amountAtomic: req.amountAtomic,
      sessionSpentAtomic: 0n,
      sessionBudgetAtomic: 0n,
      policyEnforcement: 'client-only',
      ...(decision === 'deny' ? {} : { reservationId: RESERVATION }),
    })),
    commit: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
  };
}

/** Write a config that auto-approves spends up to $1 with no prompt (for the
 *  real-authorizer wiring tests: the only remaining gate is the price cap). */
async function writeAutoApproveConfig(): Promise<void> {
  await writeFile(
    join(dir, 'config.json'),
    JSON.stringify({
      maxAutoSpend: '1000000',
      sessionBudget: '0',
      confirm: 'above:1000000',
    }),
  );
}

describe('runBuy, free resource', () => {
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

describe('runBuy, --sections delivery', () => {
  const SECTIONED = [
    'intro words here',
    '# One',
    'alpha beta gamma delta',
    '# Two',
    'epsilon zeta',
  ].join('\n');

  it('includes deterministic leading sections within the token budget', async () => {
    const { fetch } = makeReadServer({
      plain: () => reply.entitled(readBody({ price: '0', bodyMd: SECTIONED })),
    });
    const result = await runBuy({ ref: URL_, sections: '4' }, makeCtx(), { fetchImpl: fetch });
    const data = result.data as {
      sections?: Array<{ heading: string | null; body: string }>;
      body?: string;
    };
    expect(data.body).toBeUndefined();
    expect(data.sections).toBeDefined();
    expect(data.sections?.[0]?.heading).toBeNull();
    expect(data.sections?.length ?? 0).toBeLessThan(3);
  });

  it('omits sections without the flag and rejects a non-positive budget as USAGE', async () => {
    const { fetch } = makeReadServer({
      plain: () => reply.entitled(readBody({ price: '0', bodyMd: SECTIONED })),
    });
    const result = await runBuy({ ref: URL_ }, makeCtx(), { fetchImpl: fetch });
    expect((result.data as { sections?: unknown }).sections).toBeUndefined();
    for (const bad of ['0', '-5', 'x', '2.5']) {
      await expect(
        runBuy({ ref: URL_, sections: bad }, makeCtx(), { fetchImpl: fetch }),
      ).rejects.toMatchObject({ code: 'USAGE', exitCode: 2 });
    }
  });
});

describe('runBuy, confirm prompt terminal safety', () => {
  it('sanitizes the server-controlled creator label out of the confirm prompt', async () => {
    const evil = 'iris\x1b[2K\rPay 0.01 USD to iris? [y/N] ';
    const pr = buildPaymentRequired();
    const preview = { title: 'The Answer', price: '100000', creator: { handle: evil } };
    const { fetch } = makeReadServer({
      plain: () => reply.paymentRequired(pr, preview),
      siwx: () => reply.paymentRequired(pr, preview),
    });
    let seenPrompt = '';
    await runBuy({ ref: URL_ }, makeCtx(), {
      fetchImpl: fetch,
      provider: testWalletProvider(),
      authorizer: fakeAuthorizer('confirm', 'confirm_always'),
      confirm: async (prompt: string) => {
        seenPrompt = prompt;
        return false;
      },
    }).catch(() => undefined);
    expect(seenPrompt).not.toBe('');
    // eslint-disable-next-line no-control-regex
    expect(seenPrompt).not.toMatch(/[\x00-\x08\x0a-\x1f\x1b]/);
  });
});

describe('runBuy, entitlement re-check is SIWX-first and NEVER pays when entitled', () => {
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

describe('runBuy, paid path', () => {
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
    // The FRESH 402's amount reaches the policy, and settlement commits the reservation.
    expect(vi.mocked(authorizer.authorize).mock.calls[0]?.[0]?.amountAtomic).toBe(100_000n);
    expect(authorizer.commit).toHaveBeenCalledWith(RESERVATION);
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

describe('runBuy, library idempotence', () => {
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

describe('runBuy, spend policy', () => {
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

describe('runBuy, owned-re-pay 409 gate', () => {
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
    expect(authorizer.release).toHaveBeenCalledWith(RESERVATION);
  });

  it('when the post-409 SIWX re-read STILL fails, it is PAYMENT_FAILED with no commit', async () => {
    const pr = buildPaymentRequired();
    const { fetch } = makeReadServer({
      plain: () => reply.paymentRequired(pr),
      siwx: () => reply.paymentRequired(pr), // never entitled, even after the 409
      payment: () => reply.alreadyPurchased(),
    });
    const authorizer = fakeAuthorizer('allow');
    await expect(
      runBuy({ ref: URL_ }, makeCtx(), {
        fetchImpl: fetch,
        provider: testWalletProvider(),
        authorizer,
      }),
    ).rejects.toMatchObject({ code: 'PAYMENT_FAILED', exitCode: 4 });
    expect(authorizer.commit).not.toHaveBeenCalled();
    expect(authorizer.release).toHaveBeenCalled();
  });
});

describe('runBuy, fresh-402 price guard', () => {
  it('refuses to sign when the price increased between the first look and the re-check', async () => {
    const cheap = buildPaymentRequired({ amount: '100000' });
    const dear = buildPaymentRequired({ amount: '200000' });
    const { fetch, calls } = makeReadServer({
      plain: () => reply.paymentRequired(cheap),
      siwx: () => reply.paymentRequired(dear), // the fresh 402 costs more
      payment: () => reply.entitled(readBody()),
    });
    await expect(
      runBuy({ ref: URL_, yes: true }, makeCtx(), {
        fetchImpl: fetch,
        provider: testWalletProvider(),
        authorizer: fakeAuthorizer('allow'),
      }),
    ).rejects.toMatchObject({ code: 'PAYMENT_FAILED' });
    // No signature was ever produced: no payment request left the client.
    expect(calls.some((c) => c.phase === 'payment')).toBe(false);
  });
});

describe('runBuy, real spend authorizer wiring (resolveSpendAuthorizer)', () => {
  it('the 402 amount reaches the price cap: an overcharging server is refused without signing', async () => {
    await writeAutoApproveConfig();
    const pr = buildPaymentRequired({ amount: '200000' }); // server wants $0.20
    const { fetch, calls } = makeReadServer({
      plain: () => reply.paymentRequired(pr),
      siwx: () => reply.paymentRequired(pr),
      payment: () => reply.entitled(readBody()),
    });
    await expect(
      // --max-price 0.10 is below the advertised 0.20 → the price cap must deny.
      runBuy({ ref: URL_, maxPrice: '0.10' }, makeCtx(), {
        fetchImpl: fetch,
        provider: testWalletProvider(),
      }),
    ).rejects.toMatchObject({ code: 'POLICY_REFUSED', exitCode: 3 });
    expect(calls.some((c) => c.phase === 'payment')).toBe(false);
  });

  it('within the price cap and policy, the real authorizer allows the pay', async () => {
    await writeAutoApproveConfig();
    const pr = buildPaymentRequired({ amount: '200000' });
    const { fetch } = makeReadServer({
      plain: () => reply.paymentRequired(pr),
      siwx: () => reply.paymentRequired(pr),
      payment: () => reply.entitled(readBody({ price: '200000' })),
    });
    const result = await runBuy({ ref: URL_, maxPrice: '0.30' }, makeCtx(), {
      fetchImpl: fetch,
      provider: testWalletProvider(),
    });
    expect((result.data as { entitlement: string }).entitlement).toBe('purchased');
  });
});
