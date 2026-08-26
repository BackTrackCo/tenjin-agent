import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBuy } from './buy';
import { findDelivered, saveDelivery } from '../lib/library';
import { recordSearch } from '../lib/search-store';
import { verifyTypedData } from 'viem';
import {
  buildPaymentRequired,
  makeReadServer,
  readBody,
  reply,
  testSigner,
  testWalletProvider,
  withBuilderCode,
  withTrailingSlashRedirect,
} from '../lib/read-test-utils';
import { TENJIN_USER_AGENT } from '../lib/client-meta';
import { TENJIN_CLI_BUILDER_CODE } from '../lib/x402-pay';
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

/** The fields of the x402 v2 PAYMENT-SIGNATURE envelope this suite verifies. */
interface X402Envelope {
  payload: {
    authorization: {
      from: `0x${string}`;
      to: `0x${string}`;
      value: string;
      validAfter: string;
      validBefore: string;
      nonce: `0x${string}`;
    };
    signature: `0x${string}`;
  };
  accepted: { asset: `0x${string}`; extra: { name: string; version: string } };
}

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

  // `buy` resolves through `resolveResourceRef` too, so the trailing-slash
  // canonicalization covers it identically: without it the route's 308 meets
  // `fetchRead`'s redirect pin and buy dies at its own first probe, before any
  // price is even seen. Same origin, same handle/slug, same piece — the URL
  // spelling is all that changed, so nothing about what buy pays for moves.
  it('probes the canonical path when the URL was pasted with a trailing slash', async () => {
    const { fetch, calls } = makeReadServer({
      plain: () => reply.entitled(readBody({ price: '0' })),
    });
    const result = await runBuy({ ref: `${URL_}/` }, makeCtx(), {
      fetchImpl: withTrailingSlashRedirect(fetch),
    });
    expect((result.data as { entitlement: string }).entitlement).toBe('free');
    expect(calls.map((c) => c.url)).toEqual([URL_]);
    expect(calls.some((c) => c.phase === 'payment')).toBe(false);
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
    expect(authorizer.commit).toHaveBeenCalledWith(RESERVATION, 100_000n);
  });

  it('attaches the tenjin-cli User-Agent on every request, never X-Tenjin-Client, and X-Tenjin-Search-Id after a search', async () => {
    const pr = buildPaymentRequired();
    await recordSearch(dir, {
      searchId: '0197aaaa-bbbb-cccc-dddd-abcabcabcabc',
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
      expect(call.headers['user-agent']).toMatch(/^tenjin-cli\//);
      expect(call.headers['x-tenjin-client']).toBeUndefined();
    }
    // The attribution header rides ONLY the paid re-request (spec 09 §3), so a
    // search that never converts is not over-counted by probe/SIWX reads.
    const paidCall = calls.find((c) => c.phase === 'payment');
    expect(paidCall?.headers['x-tenjin-search-id']).toBe('0197aaaa-bbbb-cccc-dddd-abcabcabcabc');
    for (const call of calls.filter((c) => c.phase !== 'payment')) {
      expect(call.headers['x-tenjin-search-id']).toBeUndefined();
    }
  });

  it('adds the User-Agent to the signed x402 retry without touching what the wallet signed', async () => {
    const pr = buildPaymentRequired();
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
    const paid = calls.find((c) => c.phase === 'payment');
    // Exact set, not a subset: the whole point of the claim is that the paid
    // retry gained the identity and NOTHING else, so a fourth header appearing
    // on the one signed request the CLI sends has to fail here.
    expect(Object.keys(paid?.headers ?? {}).sort()).toEqual([
      'accept',
      'payment-signature',
      'user-agent',
    ]);
    expect(paid?.headers['user-agent']).toBe(TENJIN_USER_AGENT);

    // Recover the signer from the payload that actually went over the wire. This
    // is the byte-identity check: EIP-712 recovery fails on a single altered
    // byte, so a passing verify proves the transport handed the server exactly
    // what the wallet produced. It also shows WHY the header is harmless — the
    // signed struct is EIP-3009 transfer authorization, with no HTTP header in
    // its domain, its types, or its message.
    const envelope = JSON.parse(
      Buffer.from(paid?.headers['payment-signature'] ?? '', 'base64').toString('utf8'),
    ) as X402Envelope;
    const auth = envelope.payload.authorization;
    await expect(
      verifyTypedData({
        address: auth.from,
        domain: {
          name: envelope.accepted.extra.name,
          version: envelope.accepted.extra.version,
          chainId: 8453,
          verifyingContract: envelope.accepted.asset,
        },
        types: {
          TransferWithAuthorization: [
            { name: 'from', type: 'address' },
            { name: 'to', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'validAfter', type: 'uint256' },
            { name: 'validBefore', type: 'uint256' },
            { name: 'nonce', type: 'bytes32' },
          ],
        },
        primaryType: 'TransferWithAuthorization',
        message: {
          from: auth.from,
          to: auth.to,
          value: BigInt(auth.value),
          validAfter: BigInt(auth.validAfter),
          validBefore: BigInt(auth.validBefore),
          nonce: auth.nonce,
        },
        signature: envelope.payload.signature,
      }),
    ).resolves.toBe(true);
    expect(auth.from).toBe(testSigner().address);
    expect(JSON.stringify(envelope)).not.toContain('tenjin-cli/');
  });

  // A first-party buy is Tenjin paying Tenjin: the one registered code fills the
  // seller role (`a`, from the 402) and the client role (`s`, from this CLI).
  it('attributes the paid retry with the builder code when the 402 advertises one', async () => {
    const pr = buildPaymentRequired({}, withBuilderCode());
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
    const paid = calls.find((c) => c.phase === 'payment');
    const envelope = JSON.parse(
      Buffer.from(paid?.headers['payment-signature'] ?? '', 'base64').toString('utf8'),
    ) as X402Envelope & { extensions?: Record<string, { info?: { a?: string; s?: string[] } }> };
    expect(envelope.extensions?.['builder-code']?.info?.s).toEqual([TENJIN_CLI_BUILDER_CODE]);
    expect(envelope.extensions?.['builder-code']?.info?.a).toBe(TENJIN_CLI_BUILDER_CODE);
    // Terms are untouched by attribution: still the advertised price and payee.
    expect(envelope.payload.authorization.value).toBe('100000');
    expect(envelope.payload.authorization.to.toLowerCase()).toBe(
      '0x1111111111111111111111111111111111111111',
    );
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
    await recordSearch(dir, {
      searchId: '0197aaaa-bbbb-cccc-dddd-abcabcabcabc',
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

/**
 * A team-mode `buy` of a PUBLIC-shelf candidate. The search that surfaced it ran
 * two legs, so the candidate is on an origin that is not `baseUrl` — and the
 * SIWX header is bound to a domain, so signing it for the configured origin
 * while requesting another one produces a credential that host will refuse.
 */
describe('runBuy across two shelves', () => {
  const TEAM = 'https://team.example';
  const SECRET = 'shelf-secret-abc123';
  const BYPASS_HEADER = 'x-vercel-protection-bypass';

  async function writeShelfConfig(): Promise<void> {
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({
        baseUrl: TEAM,
        publicShelfUrl: 'https://tenjin.blog',
        shelfBypassSecret: SECRET,
      }),
    );
  }

  it('signs SIWX for the shelf the URL is on, and sends it no bypass key', async () => {
    await writeShelfConfig();
    const pr = buildPaymentRequired();
    const { fetch, calls } = makeReadServer({
      plain: () => reply.paymentRequired(pr),
      siwx: () => reply.entitled(readBody()),
    });
    // URL_ is on tenjin.blog: the public shelf, not the configured base.
    const result = await runBuy({ ref: URL_ }, makeCtx(), {
      fetchImpl: fetch,
      provider: testWalletProvider(),
      authorizer: fakeAuthorizer('allow'),
    });
    expect((result.data as { entitlement: string }).entitlement).toBe('entitled');

    const siwx = calls.find((c) => c.phase === 'siwx');
    expect(siwx).toBeDefined();
    // The SIWX message names the origin actually being read, not the team shelf.
    const decoded = Buffer.from(siwx!.headers['sign-in-with-x'] ?? '', 'base64').toString('utf8');
    expect(decoded).toContain('tenjin.blog');
    expect(decoded).not.toContain('team.example');
    // And the team's door key stayed home, on every request.
    for (const c of calls) expect(c.headers[BYPASS_HEADER]).toBeUndefined();
  });

  it('carries the bypass key on a buy from the team shelf itself', async () => {
    await writeShelfConfig();
    const pr = buildPaymentRequired();
    const { fetch, calls } = makeReadServer({
      plain: () => reply.paymentRequired(pr),
      siwx: () => reply.entitled(readBody()),
    });
    await runBuy({ ref: `${TEAM}/api/read/iris/slug` }, makeCtx(), {
      fetchImpl: fetch,
      provider: testWalletProvider(),
      authorizer: fakeAuthorizer('allow'),
    });
    for (const c of calls) expect(c.headers[BYPASS_HEADER]).toBe(SECRET);
    const siwx = calls.find((c) => c.phase === 'siwx');
    const decoded = Buffer.from(siwx!.headers['sign-in-with-x'] ?? '', 'base64').toString('utf8');
    expect(decoded).toContain('team.example');
  });
});
