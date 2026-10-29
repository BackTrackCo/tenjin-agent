import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileClientChannelStorage } from '@x402/evm/batch-settlement/client/file-storage';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CliError } from '../lib/errors';
import type { SpendPolicy } from '../lib/policy';
import type { TenjinSigner } from '../lib/wallet/provider';
import { readSpendSummary } from '../lib/wallet/spend';
import { unlockDetails, type UnlockReason } from '../lib/wallet-unlock';
import type { CommandContext } from '../context';
import { decodePaymentRequiredHeader, encodePaymentRequiredHeader } from '@x402/core/http';
import { CLIENT_ACCEPTS, requestDecision, RouteSkipped } from './decision';
import {
  CHANNEL_DEPOSIT_ATOMIC,
  FEE_ABOVE_CEILING,
  MAX_CHANNEL_DEPOSIT_ATOMIC,
  payerDir,
  ROUTING_FEE_CEILING_ATOMIC,
  unpaidSentence,
} from './fee';
import { BASE, FakeRouter, payerDeps, TEST_POLICY, testSigner } from './fee-test-utils';
import { readRouterMemo, WARM_ABSENT_MS, writeRouterMemo } from './router-memo';
import { DEPOSIT_GATE_TIMEOUT_MS, GATE_TIMEOUT_MS } from './gate';
import { WALLET_REASONS } from './wallet-reasons';
import {
  chainReader,
  DEPOSIT_MULTIPLIER,
  PAID_CALL_RESERVE_MS,
  RoutingPayer,
  RPC_TIMEOUT_MS,
  ROUTING_SPEND_CAP,
  SIGNER_RECHECK_MS,
  TOP_UP_BACKOFF_MS,
  type PayerObservation,
  type RoutingPayerDeps,
} from './routing-payer';

/**
 * The payer against a fake router that speaks the real x402 headers: the stock
 * SDK client builds every deposit and voucher, keeps the channel in its own
 * file storage and recovers from the fake's corrective 402.
 */

const wallet = privateKeyToAccount(generatePrivateKey());

let dir: string;
let clock: number;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-payer-'));
  clock = 1_800_000_000_000;
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

/** Holds the timers and the clock still; file I/O and microtasks keep running. */
function holdTime(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
}

/**
 * Timers the payer arms, observed through its injected `timers`, so a test
 * awaits "armed" instead of guessing when the work has started.
 */
function armedTimers() {
  const waiting: { ms: number; resolve: () => void }[] = [];
  const seen: number[] = [];
  const timers: NonNullable<RoutingPayerDeps['timers']> = {
    setTimeout: ((fn: () => void, ms?: number) => {
      const id = globalThis.setTimeout(fn, ms);
      seen.push(ms ?? 0);
      for (const w of waiting.filter((x) => x.ms === ms)) w.resolve();
      return id;
    }) as typeof setTimeout,
    clearTimeout: (id) => globalThis.clearTimeout(id),
  };
  const armed = (ms: number): Promise<void> =>
    seen.includes(ms) ? Promise.resolve() : new Promise((resolve) => waiting.push({ ms, resolve }));
  return { timers, armed };
}

/** Resolves when the router starts holding a paid request on its delay timer. */
function delayArmed(router: FakeRouter): Promise<void> {
  return new Promise((resolve) => {
    router.onDelayArmed = resolve;
  });
}

type PayerOpts = Partial<RoutingPayerDeps> & {
  policy_?: Partial<SpendPolicy>;
  walletAtomic?: bigint | null;
};

function payer(router: FakeRouter, opts: PayerOpts = {}): RoutingPayer {
  const { policy_, walletAtomic, ...rest } = opts;
  return new RoutingPayer(
    payerDeps(router, dir, wallet, {
      policy: async () => ({ ...TEST_POLICY, ...policy_ }),
      walletBalance: async () => (walletAtomic === undefined ? 10_000_000n : walletAtomic),
      now: () => clock,
      ...rest,
    }),
  );
}

const ctx = (): CommandContext => ({
  flags: { json: true, timeout: 5_000 },
  dataDir: dir,
  io: {
    stdout: { write: () => true } as unknown as NodeJS.WritableStream,
    stderr: { write: () => true } as unknown as NodeJS.WritableStream,
    isTTY: false,
  },
});

/** One routing call the way the hook and the tool make it. */
async function routeOnce(p: RoutingPayer, router: FakeRouter) {
  return requestDecision(
    'tool',
    { query: 'q' },
    {
      ctx: ctx(),
      baseUrl: BASE,
      fetchImpl: router.fetch,
      timeoutMs: 3_500,
      route: p.routeFor(BASE),
    },
  );
}

/** Why the payer did not pay a call, or undefined for a call it answered. */
function unpaidWhy(outcome: Awaited<ReturnType<typeof routeOnce>>): string | undefined {
  return outcome.status === 'skipped' ? outcome.why : undefined;
}

/** A call the payer could not pay: skipped, and nothing asked of the free route. */
function skippedWhy(outcome: Awaited<ReturnType<typeof routeOnce>>, router: FakeRouter) {
  expect(outcome.status).toBe('skipped');
  expect(router.log.filter((l) => !l.startsWith('POST /api/x402-router/route'))).toEqual([]);
  return unpaidWhy(outcome);
}

/** A router with no `warm` form, as a top-up would have learned it: a
 *  deposit rides the call that needs it, as it did before the form. */
async function noWarm(): Promise<void> {
  await writeRouterMemo(dir, 'warm-absent', BASE, { now: 0, ttlMs: Number.MAX_SAFE_INTEGER });
}

async function channelFiles(): Promise<string[]> {
  return (await readdir(join(payerDir(dir, wallet.address), 'client')).catch(() => [])).sort();
}

/** A getSigner that fails the way the wallet layer classifies it: a CliError carrying `details.unlock`. */
function unlockFails(reason: UnlockReason): () => Promise<never> {
  return async () => {
    throw new CliError('REFUSED', `the wallet cannot sign (${reason})`, {
      details: unlockDetails(reason),
    });
  };
}

describe('RoutingPayer', () => {
  // tenjin#1046: the smallest of the server's hint, the wallet and the
  // per-call limit, never below ten quoted fees; the rest stays in the
  // wallet, which pays the tools routing suggests.
  it.each<[string, { amount?: string; walletAtomic: bigint; perCall?: bigint }, bigint]>([
    ['a $10 wallet signs the $0.03 hint', { walletAtomic: 10_000_000n }, 30_000n],
    ['a $0.50 wallet signs the $0.03 hint', { walletAtomic: 500_000n }, 30_000n],
    ['a $0.03 wallet signs all of it', { walletAtomic: 30_000n }, 30_000n],
    [
      'a $0.02 wallet under a $0.001 quote signs all of it',
      { amount: '1000', walletAtomic: 20_000n },
      20_000n,
    ],
    [
      'a $0.015 per-call limit under a $0.001 quote signs the limit',
      { amount: '1000', walletAtomic: 10_000_000n, perCall: 15_000n },
      15_000n,
    ],
  ])('sizes the deposit: %s', async (_label, o, signed) => {
    const router = new FakeRouter({
      ...(o.amount !== undefined ? { amount: o.amount, minDeposit: '30000' } : {}),
    });
    const p = payer(router, {
      walletAtomic: o.walletAtomic,
      ...(o.perCall !== undefined ? { policy_: { maxAutoSpendAtomic: o.perCall } } : {}),
    });
    const result = await routeOnce(p, router);
    expect(result.status).toBe('decided');
    expect([...router.channels.values()][0]?.balance).toBe(signed);
    expect((await readSpendSummary(dir))?.committedAtomic).toBe(signed.toString());
    // It rode the top-up's `warm` call, which settled at $0.
    expect(router.warms).toBe(1);
    expect(router.settledFees).toBe(1);
  });

  it('refuses a $0.02 wallet as wallet_low, names its balance, and signs nothing', async () => {
    const router = new FakeRouter();
    const p = payer(router, { walletAtomic: 20_000n });
    const outcome = await routeOnce(p, router);
    expect(skippedWhy(outcome, router)).toBe('wallet_low');
    expect(outcome).toMatchObject({ balanceAtomic: 20_000n, depositAtomic: 30_000n });
    expect(router.paidRequests()).toBe(0);
  });

  it("refuses a wallet below ten quoted fees, not below the server's hint", async () => {
    const router = new FakeRouter({ minDeposit: '90000' });
    const low = await routeOnce(payer(router, { walletAtomic: 29_999n }), router);
    expect(skippedWhy(low, router)).toBe('wallet_low');
    expect(low).toMatchObject({ balanceAtomic: 29_999n, depositAtomic: 30_000n });
    expect(router.paidRequests()).toBe(0);
    // Above the floor, under the hint: what the wallet holds.
    const enough = await routeOnce(payer(router, { walletAtomic: 60_000n }), router);
    expect(enough.status).toBe('decided');
    expect([...router.channels.values()][0]?.balance).toBe(60_000n);
  });

  it.each<[string, bigint | null]>([
    ['a $10 wallet', 10_000_000n],
    ['an unread balance', null],
  ])(
    'keeps the SDK ceiling when the server suggests an oversized deposit: %s',
    async (_label, walletAtomic) => {
      const router = new FakeRouter({ minDeposit: '1000000' });
      const result = await routeOnce(payer(router, { walletAtomic }), router);
      expect(unpaidWhy(result)).toBeUndefined();
      expect([...router.channels.values()][0]?.balance).toBe(MAX_CHANNEL_DEPOSIT_ATOMIC);
      expect((await readSpendSummary(dir))?.committedAtomic).toBe(
        MAX_CHANNEL_DEPOSIT_ATOMIC.toString(),
      );
    },
  );

  it("signs the server's hint when the wallet balance cannot be read", async () => {
    const router = new FakeRouter();
    const result = await routeOnce(payer(router, { walletAtomic: null }), router);
    expect(unpaidWhy(result)).toBeUndefined();
    expect([...router.channels.values()][0]?.balance).toBe(CHANNEL_DEPOSIT_ATOMIC);
  });

  it('signs the fallback hint when the 402 carries no extra.minDeposit', async () => {
    const router = new FakeRouter({ amount: '1000', minDeposit: null });
    const result = await routeOnce(payer(router), router);
    expect(result.status).toBe('decided');
    // Not the SDK's own five quotes: the hint Tenjin keeps for a 402 without one.
    expect([...router.channels.values()][0]?.balance).toBe(CHANNEL_DEPOSIT_ATOMIC);
  });

  it('reserves the last daily deposit only once when two wallets race', async () => {
    const router = new FakeRouter();
    const budget = { sessionBudgetAtomic: CHANNEL_DEPOSIT_ATOMIC };
    const first = payer(router, { policy_: budget });
    const second = payer(router, {
      policy_: budget,
      getSigner: async () => testSigner(privateKeyToAccount(generatePrivateKey())),
    });
    const results = await Promise.all([routeOnce(first, router), routeOnce(second, router)]);
    expect(results.map(unpaidWhy).filter(Boolean)).toEqual(['budget_reached']);
    expect(router.deposits).toBe(1);
    expect(router.settledFees).toBe(1);
    expect((await readSpendSummary(dir))?.committedAtomic).toBe(CHANNEL_DEPOSIT_ATOMIC.toString());
    expect((await readSpendSummary(dir))?.reservations).toEqual([]);
  });

  it('tops up once every ten billed calls, ahead of the call that needs it, counting vouchers once', async () => {
    const router = new FakeRouter();
    const p = payer(router);
    const perDeposit = Number(CHANNEL_DEPOSIT_ATOMIC / ROUTING_FEE_CEILING_ATOMIC);
    expect(perDeposit).toBe(10);
    for (let n = 0; n < perDeposit; n += 1) {
      expect(unpaidWhy(await routeOnce(p, router))).toBeUndefined();
    }
    // The tenth call left the channel unable to cover a fee: the top-up ran
    // in the background, before any call asked for it.
    await p.idle();
    expect(router.deposits).toBe(2);
    expect(router.warms).toBe(2);
    const paidBefore = router.paidRequests();
    expect(unpaidWhy(await routeOnce(p, router))).toBeUndefined();
    // The next call is a voucher, with no deposit and no wait.
    expect(router.paidRequests() - paidBefore).toBe(1);
    expect(router.settledFees).toBe(perDeposit + 1);
    expect((await readSpendSummary(dir))?.committedAtomic).toBe(
      (2n * CHANNEL_DEPOSIT_ATOMIC).toString(),
    );
  });

  it('routes on the paid route, unpaid, while the fee is off', async () => {
    const router = new FakeRouter({ paid: false });
    const p = payer(router);
    expect((await routeOnce(p, router)).status).toBe('decided');
    expect((await routeOnce(p, router)).status).toBe('decided');
    expect(router.log).toEqual([
      'POST /api/x402-router/route unpaid',
      'POST /api/x402-router/route unpaid',
    ]);
  });

  it('pays no voucher from a funded channel once the per-call limit is below the fee', async () => {
    const router = new FakeRouter();
    let maxAutoSpendAtomic = 250_000n;
    const p = payer(router, {
      policy: async () => ({ ...TEST_POLICY, maxAutoSpendAtomic }),
    });
    expect((await routeOnce(p, router)).status).toBe('decided');
    expect(router.settledFees).toBe(1);
    // The user turns automatic payment off: the channel still holds the deposit.
    maxAutoSpendAtomic = 0n;
    let unlocks = 0;
    const after = await routeOnce(
      payer(router, {
        policy: async () => ({ ...TEST_POLICY, maxAutoSpendAtomic }),
        getSigner: async () => {
          unlocks += 1;
          throw new Error('not reached');
        },
      }),
      router,
    );
    expect(skippedWhy(after, router)).toBe('limit_below_deposit');
    expect(router.settledFees).toBe(1);
    expect(unlocks).toBe(0);
    // The same payer, too.
    expect(skippedWhy(await routeOnce(p, router), router)).toBe('limit_below_deposit');
    expect(router.settledFees).toBe(1);
  });

  it.each<[string, Partial<SpendPolicy>, string]>([
    ['a daily limit of 0', { sessionBudgetAtomic: 0n }, 'budget_reached'],
    ['an allowlist without the router', { allowlistCreators: ['someone-else'] }, 'not_allowlisted'],
    ['a per-call limit below the fee', { maxAutoSpendAtomic: 2_000n }, 'limit_below_deposit'],
  ])('pays no voucher from a funded channel under %s', async (_label, change, why) => {
    const router = new FakeRouter();
    let policy: SpendPolicy = TEST_POLICY;
    const p = payer(router, { policy: async () => policy });
    expect((await routeOnce(p, router)).status).toBe('decided');
    expect(router.settledFees).toBe(1);
    const paidBefore = router.paidRequests();
    // The channel still holds the deposit; the user changes the policy.
    policy = { ...TEST_POLICY, ...change };
    expect(skippedWhy(await routeOnce(p, router), router)).toBe(why);
    expect(router.settledFees).toBe(1);
    expect(router.paidRequests()).toBe(paidBefore);
  });

  it('pays the next fee from a deposit that used the whole day, counting it once', async () => {
    const router = new FakeRouter();
    const p = payer(router, { policy_: { sessionBudgetAtomic: CHANNEL_DEPOSIT_ATOMIC } });
    expect((await routeOnce(p, router)).status).toBe('decided');
    expect((await readSpendSummary(dir))?.committedAtomic).toBe(CHANNEL_DEPOSIT_ATOMIC.toString());
    // The day's budget is spent, by the deposit itself: its fees still pay.
    const next = await routeOnce(p, router);
    expect(next).toMatchObject({ status: 'decided' });
    expect(unpaidWhy(next)).toBeUndefined();
    expect(router.settledFees).toBe(2);
    expect(router.deposits).toBe(1);
    expect((await readSpendSummary(dir))?.committedAtomic).toBe(CHANNEL_DEPOSIT_ATOMIC.toString());
  });

  it('refuses a second deposit the day has no room for, and the call is skipped', async () => {
    const router = new FakeRouter();
    // A $0.03 deposit holds 10 fees; the day has room for one deposit, not two.
    const p = payer(router, { policy_: { sessionBudgetAtomic: 2n * CHANNEL_DEPOSIT_ATOMIC - 1n } });
    for (let n = 0; n < Number(CHANNEL_DEPOSIT_ATOMIC / ROUTING_FEE_CEILING_ATOMIC); n += 1) {
      const paid = await routeOnce(p, router);
      expect(paid.status).toBe('decided');
      expect(unpaidWhy(paid)).toBeUndefined();
    }
    // The background top-up the tenth call started is refused, and holds the
    // next one off: the call that needs it gets that reason, sending nothing paid.
    await p.idle();
    expect(router.deposits).toBe(1);
    const paidBefore = router.paidRequests();
    expect(skippedWhy(await routeOnce(p, router), router)).toBe('budget_reached');
    expect(router.paidRequests()).toBe(paidBefore);
    expect(router.deposits).toBe(1);
    // The deposit counted once; the fees paid from it did not count again.
    expect((await readSpendSummary(dir, { now: () => clock }))?.committedAtomic).toBe(
      CHANNEL_DEPOSIT_ATOMIC.toString(),
    );
  });

  it('makes no deposit for a fee a daily limit of 0 refuses', async () => {
    const router = new FakeRouter();
    const p = payer(router, { policy_: { sessionBudgetAtomic: 0n } });
    expect(skippedWhy(await routeOnce(p, router), router)).toBe('budget_reached');
    expect(router.paidRequests()).toBe(0);
    expect(router.deposits).toBe(0);
  });

  /**
   * THE SERVER QUOTES, THE CEILING CAPS. Whatever the router's 402 asks at or
   * below the ceiling is paid, inside the spend limits; a quote above it is
   * not paid at all, is named with its price, and is read before the wallet
   * is unlocked.
   */
  it.each([['1000'], ['2999'], [ROUTING_FEE_CEILING_ATOMIC.toString()]])(
    'pays a quote of %s atomic, at or below the ceiling, and names it',
    async (amount) => {
      const router = new FakeRouter({ amount });
      const p = payer(router);
      const route = p.routeFor(BASE);
      for (let i = 0; i < 2; i += 1) {
        const outcome = await requestDecision(
          'tool',
          { query: 'q' },
          { ctx: ctx(), baseUrl: BASE, fetchImpl: router.fetch, timeoutMs: 3_500, route },
        );
        expect(outcome.status).toBe('decided');
      }
      expect(router.settledFees).toBe(2);
      expect([...router.channels.values()][0]!.charged).toBe(2n * BigInt(amount));
      expect(route.fee?.()).toBe(BigInt(amount));
    },
  );

  it('pays nothing to a quote above the ceiling, says why with its price, and never unlocks', async () => {
    const router = new FakeRouter({ amount: (ROUTING_FEE_CEILING_ATOMIC + 1n).toString() });
    let unlocks = 0;
    const p = payer(router, { getSigner: async () => ((unlocks += 1), testSigner(wallet)) });
    const outcome = await routeOnce(p, router);
    expect(skippedWhy(outcome, router)).toBe(FEE_ABOVE_CEILING);
    expect(outcome).toMatchObject({ quotedAtomic: ROUTING_FEE_CEILING_ATOMIC + 1n });
    expect(router.log).toEqual(['POST /api/x402-router/route unpaid']);
    expect(unlocks).toBe(0);
    expect(
      unpaidSentence(FEE_ABOVE_CEILING, 'person', {
        quotedAtomic: ROUTING_FEE_CEILING_ATOMIC + 1n,
      }),
    ).toBe(
      'Tenjin could not pay the routing fee (the router quoted $0.003001 a call, more than this install agreed to pay), so Tenjin is not routing calls until that is fixed. Your usual tools still work.',
    );
  });

  it('pays the offer within the ceiling when a 402 also offers one above it', async () => {
    const router = new FakeRouter({ amount: '2000' });
    const above = { ...router.requirement, amount: '9000' };
    const both = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const response = await router.fetch(input, init);
      const header = response.headers.get('PAYMENT-REQUIRED');
      if (response.status !== 402 || header === null) return response;
      const required = decodePaymentRequiredHeader(header);
      return new Response('{}', {
        status: 402,
        headers: {
          'content-type': 'application/json',
          'PAYMENT-REQUIRED': encodePaymentRequiredHeader({
            ...required,
            accepts: [above, ...required.accepts],
          }),
        },
      });
    }) as typeof fetch;
    const outcome = await requestDecision(
      'tool',
      { query: 'q' },
      {
        ctx: ctx(),
        baseUrl: BASE,
        fetchImpl: both,
        timeoutMs: 3_500,
        route: payer(router).routeFor(BASE),
      },
    );
    expect(outcome.status).toBe('decided');
    expect([...router.channels.values()][0]!.charged).toBe(2000n);
  });

  it('checks a voucher against the per-call limit at the quote, not the ceiling', async () => {
    const router = new FakeRouter({ amount: '1000' });
    let maxAutoSpendAtomic = 250_000n;
    const p = payer(router, { policy: async () => ({ ...TEST_POLICY, maxAutoSpendAtomic }) });
    expect((await routeOnce(p, router)).status).toBe('decided');
    // Below the ceiling, above the quote: the funded channel still pays.
    maxAutoSpendAtomic = 2_000n;
    expect((await routeOnce(p, router)).status).toBe('decided');
    // Below the quote: refused before anything is signed.
    maxAutoSpendAtomic = 999n;
    expect(skippedWhy(await routeOnce(p, router), router)).toBe('limit_below_deposit');
    expect(router.settledFees).toBe(2);
  });

  /**
   * A CHARGE BELOW THE QUOTE IS NO FAULT. Batch settlement lets the server
   * charge less than it quoted (the $0.001 charge under today's $0.003
   * quote): the SDK records the lower charge, and the next voucher builds on
   * it with no corrective 402.
   */
  it('takes a charge below the quote as paid, and builds the next voucher on it', async () => {
    const router = new FakeRouter({ amount: '3000', charge: '1000' });
    const p = payer(router);
    for (let i = 0; i < 3; i += 1) {
      expect(unpaidWhy(await routeOnce(p, router))).toBeUndefined();
    }
    expect(router.settledFees).toBe(3);
    // Three vouchers and the one `warm` call that carried the deposit.
    expect(router.paidRequests()).toBe(4);
    expect(router.warms).toBe(1);
    expect([...router.channels.values()][0]!.charged).toBe(3_000n);
    expect(router.deposits).toBe(1);
  });

  it('pays only the configured router: any other origin or path is refused unsent', async () => {
    const router = new FakeRouter();
    const route = payer(router).routeFor(BASE);
    for (const url of [
      'https://provider.test/api/x402-router/route',
      `${BASE}/api/x402-router`,
      `${BASE}/v1/search`,
    ]) {
      await expect(route.send(url, { method: 'POST', timeoutMs: 3_500 })).rejects.toBeInstanceOf(
        RouteSkipped,
      );
    }
    expect(router.log).toEqual([]);
  });

  it('tells the next route what the top-up deposited, so the deposit is said once', async () => {
    const router = new FakeRouter();
    const p = payer(router);
    const decideOn = async () => {
      const route = p.routeFor(BASE);
      await requestDecision(
        'tool',
        { query: 'q' },
        { ctx: ctx(), baseUrl: BASE, fetchImpl: router.fetch, timeoutMs: 3_500, route },
      );
      return route.deposited?.();
    };
    expect(await decideOn()).toBe(CHANNEL_DEPOSIT_ATOMIC);
    // The next call pays a voucher from that deposit: nothing new to say.
    expect(await decideOn()).toBe(0n);
    expect(router.deposits).toBe(1);
  });

  it("never deposits on a routing call: the top-up's warm call carries it, then vouchers", async () => {
    const router = new FakeRouter();
    const p = payer(router);
    const first = await routeOnce(p, router);
    expect(first.status).toBe('decided');
    expect(router.deposits).toBe(1);
    expect(router.warms).toBe(1);
    expect(router.settledFees).toBe(1);
    const second = await routeOnce(p, router);
    expect(second.status).toBe('decided');
    expect(router.deposits).toBe(1);
    expect(router.settledFees).toBe(2);
    expect(router.log).toEqual([
      // The call's SDK asks for a deposit: nothing is signed, and the top-up starts.
      'POST /api/x402-router/route unpaid',
      // The top-up: the stock wrapper's 402, then the deposit on a `warm` call.
      'POST /api/x402-router/route warm unpaid',
      'POST /api/x402-router/route warm paid',
      // The call, once more, waited inside its budget: a voucher.
      'POST /api/x402-router/route unpaid',
      'POST /api/x402-router/route paid',
      'POST /api/x402-router/route unpaid',
      'POST /api/x402-router/route paid',
    ]);
    // The channel lives in the SDK's own file storage, in the wallet's folder.
    const files = await channelFiles();
    expect(files).toHaveLength(1);
    const stored = await new FileClientChannelStorage({
      directory: payerDir(dir, wallet.address),
    }).get(files[0]!.replace('.json', ''));
    expect(stored).toMatchObject({
      balance: CHANNEL_DEPOSIT_ATOMIC.toString(),
      chargedCumulativeAmount: (2n * ROUTING_FEE_CEILING_ATOMIC).toString(),
    });
    // The deposit is an automatic payment in the spend ledger; the fees are not.
    expect(await readSpendSummary(dir, { now: () => clock })).toMatchObject({
      committedAtomic: CHANNEL_DEPOSIT_ATOMIC.toString(),
      reservations: [],
    });
  });

  it("sends warm as the server expects it: the fixture, with this build's accepts and harness", async () => {
    const router = new FakeRouter();
    const bodies: unknown[] = [];
    const watching: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const body = (await request.clone().json()) as { warm?: boolean };
      if (body.warm === true) bodies.push(body);
      return router.fetch(request);
    };
    await routeOnce(payer(router, { fetchImpl: watching, harness: 'codex' }), router);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toEqual({
      schemaVersion: 1,
      warm: true,
      accepts: [...CLIENT_ACCEPTS],
      harness: 'codex',
    });
  });

  it('tops up a new channel when tenjin mcp starts, so the first call pays a voucher', async () => {
    const router = new FakeRouter();
    const p = payer(router);
    await p.prewarm();
    await p.topUpIfLow(BASE);
    expect(router.deposits).toBe(1);
    expect(router.log).toEqual([
      'POST /api/x402-router/route warm unpaid',
      'POST /api/x402-router/route warm paid',
    ]);
    const before = router.log.length;
    expect((await routeOnce(p, router)).status).toBe('decided');
    expect(router.log.slice(before)).toEqual([
      'POST /api/x402-router/route unpaid',
      'POST /api/x402-router/route paid',
    ]);
    // A funded channel at the next start: nothing is sent.
    const again = payer(router);
    await again.prewarm();
    await again.topUpIfLow(BASE);
    expect(router.log).toHaveLength(before + 2);
  });

  it('makes no start top-up for a wallet that cannot sign, and sends nothing', async () => {
    const router = new FakeRouter();
    const p = payer(router, { getSigner: unlockFails('passphrase_missing') });
    await p.prewarm();
    await p.topUpIfLow(BASE);
    expect(router.log).toEqual([]);
  });

  it('waits for a top-up in flight inside its budget, then pays a voucher', async () => {
    const router = new FakeRouter();
    router.delayMs = 300;
    const p = payer(router, { now: () => Date.now() });
    await p.prewarm();
    const topping = p.topUpIfLow(BASE);
    await delayArmed(router);
    router.delayMs = 0;
    const outcome = await routeOnce(p, router);
    expect(outcome.status).toBe('decided');
    await topping;
    // It waited: no deposit of its own, and no 402 sent before the top-up landed.
    expect(router.deposits).toBe(1);
    expect(router.log).toEqual([
      'POST /api/x402-router/route warm unpaid',
      'POST /api/x402-router/route warm paid',
      'POST /api/x402-router/route unpaid',
      'POST /api/x402-router/route paid',
    ]);
  });

  it('skips a call whose budget ends before the top-up in flight lands, as no fault', async () => {
    const router = new FakeRouter();
    router.delayMs = 1_500;
    const warned: string[] = [];
    const p = payer(router, { now: () => Date.now(), warn: (l) => warned.push(l) });
    await p.prewarm();
    const topping = p.topUpIfLow(BASE);
    await delayArmed(router);
    const started = Date.now();
    const outcome = await requestDecision(
      'tool',
      { query: 'q' },
      {
        ctx: ctx(),
        baseUrl: BASE,
        fetchImpl: router.fetch,
        timeoutMs: PAID_CALL_RESERVE_MS + 200,
        route: p.routeFor(BASE),
      },
    );
    expect(outcome).toEqual({ status: 'skipped', why: 'topping_up' });
    // It stopped waiting with the paid call's reserve left, and sent nothing.
    expect(Date.now() - started).toBeLessThan(PAID_CALL_RESERVE_MS);
    expect(warned.join('\n')).toMatch(/topping_up \(cause top-up in flight, \d+ms, stage queue\)/);
    expect(unpaidSentence('topping_up')).toBeNull();
    await topping;
    expect(router.log.filter((l) => !l.includes(' warm '))).toEqual([]);
  });

  it('sends one top-up for two processes on one wallet: the other skips, then pays from it', async () => {
    const router = new FakeRouter();
    router.delayMs = 300;
    const a = payer(router, { now: () => Date.now() });
    const b = payer(router, { now: () => Date.now() });
    await a.prewarm();
    const topping = a.topUpIfLow(BASE);
    await delayArmed(router);
    router.delayMs = 0;
    // b meets a's `topping-up` memo: no warm of its own, and no fault.
    expect(unpaidWhy(await routeOnce(b, router))).toBe('deposit_deferred');
    await topping;
    expect((await routeOnce(b, router)).status).toBe('decided');
    expect(router.deposits).toBe(1);
    expect(router.log.filter((l) => l.endsWith(' warm paid'))).toHaveLength(1);
  });

  it('holds the next top-up off after a refusal, and says the refusal on the calls that need it', async () => {
    const router = new FakeRouter();
    let walletAtomic = 0n;
    const warned: string[] = [];
    const p = payer(router, {
      walletBalance: async () => walletAtomic,
      warn: (l) => warned.push(l),
    });
    const outcome = await routeOnce(p, router);
    expect(outcome).toMatchObject({ status: 'skipped', why: 'wallet_low', balanceAtomic: 0n });
    expect(warned.filter((l) => l.includes('top-up wallet_low'))).toHaveLength(1);
    // Funded within the backoff: the next call still gets the refusal, with
    // no second balance read and no top-up.
    walletAtomic = 10_000_000n;
    const asked = router.log.filter((l) => l.includes(' warm ')).length;
    expect(unpaidWhy(await routeOnce(p, router))).toBe('wallet_low');
    expect(router.log.filter((l) => l.includes(' warm '))).toHaveLength(asked);
    // Past it, the call that needs a deposit starts the next top-up and pays.
    clock += TOP_UP_BACKOFF_MS[0]!;
    expect((await routeOnce(p, router)).status).toBe('decided');
    expect(router.deposits).toBe(1);
  });

  it.each<[string, PayerOpts, number]>([
    ['a wallet too low stops at 2 minutes', { walletAtomic: 0n }, 120_000],
    [
      'a budget refusal goes on to 10 minutes',
      { policy_: { sessionBudgetAtomic: CHANNEL_DEPOSIT_ATOMIC - 1n } },
      600_000,
    ],
  ])('backs refused top-ups off 30 s, then 2 min, then: %s', async (_label, opts, third) => {
    const router = new FakeRouter();
    const p = payer(router, opts);
    const topUps = () => router.log.filter((l) => l.endsWith(' warm unpaid')).length;
    for (const [n, wait] of [30_000, 120_000, third].entries()) {
      // The call that needs a deposit starts a top-up, which is refused.
      await routeOnce(p, router);
      expect(topUps()).toBe(n + 1);
      // A moment before its backoff ends, the next call starts none.
      clock += wait - 1;
      await routeOnce(p, router);
      expect(topUps()).toBe(n + 1);
      clock += 1;
    }
    await routeOnce(p, router);
    expect(topUps()).toBe(4);
  });

  it('remembers a router with no warm form for an hour, and deposits on the call itself meanwhile', async () => {
    const router = new FakeRouter({ warm: false });
    const warned: string[] = [];
    const p = payer(router, { warn: (l) => warned.push(l) });
    const first = await routeOnce(p, router);
    expect(first.status).toBe('decided');
    expect(router.warms).toBe(0);
    expect(router.deposits).toBe(1);
    expect(router.log).toEqual([
      'POST /api/x402-router/route unpaid',
      // The server refused the field: nothing settled, the deposit given back.
      'POST /api/x402-router/route warm unpaid',
      'POST /api/x402-router/route warm paid',
      // Today's behaviour: the deposit rides the call.
      'POST /api/x402-router/route unpaid',
      'POST /api/x402-router/route paid',
    ]);
    expect(warned.join('\n')).toContain('top-up: the router has no warm form (http 400)');
    expect(await readRouterMemo(dir, 'warm-absent', BASE, clock)).toMatchObject({
      until: clock + WARM_ABSENT_MS,
    });
    // The refused deposit was released; the one on the call counts once.
    expect((await readSpendSummary(dir, { now: () => clock }))?.committedAtomic).toBe(
      CHANNEL_DEPOSIT_ATOMIC.toString(),
    );
    // Another process within the hour, on a new wallet, deposits on its call and sends no warm.
    const other = payer(router, {
      getSigner: async () => testSigner(privateKeyToAccount(generatePrivateKey())),
    });
    const before = router.log.length;
    expect((await routeOnce(other, router)).status).toBe('decided');
    expect(router.log.slice(before)).toEqual([
      'POST /api/x402-router/route unpaid',
      'POST /api/x402-router/route paid',
    ]);
  });

  it('sizes the deposit under a per-call limit an earlier release left lower, and refuses one below ten fees', async () => {
    const router = new FakeRouter();
    const under = payer(router, {
      policy_: { maxAutoSpendAtomic: MAX_CHANNEL_DEPOSIT_ATOMIC - 1n },
    });
    expect((await routeOnce(under, router)).status).toBe('decided');
    expect([...router.channels.values()][0]?.balance).toBe(CHANNEL_DEPOSIT_ATOMIC);
    const fresh = new FakeRouter();
    const p = payer(fresh, {
      policy_: { maxAutoSpendAtomic: CHANNEL_DEPOSIT_ATOMIC - 1n },
      getSigner: async () => testSigner(privateKeyToAccount(generatePrivateKey())),
    });
    expect(skippedWhy(await routeOnce(p, fresh), fresh)).toBe('limit_below_deposit');
    expect(fresh.paidRequests()).toBe(0);
    expect(fresh.deposits).toBe(0);
  });

  it('refuses a deposit the daily budget cannot take, and reserves nothing', async () => {
    const router = new FakeRouter();
    const p = payer(router, { policy_: { sessionBudgetAtomic: CHANNEL_DEPOSIT_ATOMIC - 1n } });
    expect(skippedWhy(await routeOnce(p, router), router)).toBe('budget_reached');
    expect(router.paidRequests()).toBe(0);
    expect((await readSpendSummary(dir, { now: () => clock }))?.reservations ?? []).toEqual([]);
  });

  /** `router`, except that a request carrying a payment gets `answer` instead. */
  function paidAnswer(router: FakeRouter, answer: () => Promise<Response>): typeof fetch {
    return async (input, init) => {
      const request = new Request(input, init);
      return request.headers.has('payment-signature') ? answer() : router.fetch(request);
    };
  }

  // The server settles nothing on an answered 4xx or 5xx (tenjin#951), so
  // those give the deposit back; an answer that never came may hide a settled
  // deposit, so it stays counted.
  it.each([
    ['an answered 402 releases it', async () => new Response('{}', { status: 402 }), '0'],
    ['an answered 500 releases it', async () => new Response('{}', { status: 500 }), '0'],
    [
      'a lost answer keeps it counted',
      async (): Promise<Response> => {
        throw new TypeError('fetch failed');
      },
      CHANNEL_DEPOSIT_ATOMIC.toString(),
    ],
  ])('settles a sent deposit in the ledger: %s', async (_label, answer, committed) => {
    const router = new FakeRouter();
    const fetchImpl = paidAnswer(router, answer);
    const p = payer(router, { fetchImpl });
    const route = p.routeFor(BASE);
    const outcome = await requestDecision(
      'tool',
      { query: 'q' },
      { ctx: ctx(), baseUrl: BASE, fetchImpl, timeoutMs: 3_500, route },
    );
    // The top-up's deposit failed, and the call that waited on it says so.
    expect(skippedWhy(outcome, router)).toBe('payment_failed');
    expect(await readSpendSummary(dir, { now: () => clock })).toMatchObject({
      committedAtomic: committed,
      reservations: [],
    });
  });

  it('counts a deposit from the moment it is sent, before any answer', async () => {
    const router = new FakeRouter();
    let seen: string | undefined;
    const fetchImpl = paidAnswer(router, async () => {
      seen = (await readSpendSummary(dir, { now: () => clock }))?.committedAtomic;
      throw new TypeError('fetch failed');
    });
    const p = payer(router, { fetchImpl });
    const route = p.routeFor(BASE);
    await requestDecision(
      'tool',
      { query: 'q' },
      { ctx: ctx(), baseUrl: BASE, fetchImpl, timeoutMs: 3_500, route },
    );
    // A process killed at this point leaves the deposit counted.
    expect(seen).toBe(CHANNEL_DEPOSIT_ATOMIC.toString());
  });

  it('recovers through the SDK after a lost answer: a corrective 402, one retry, no second charge', async () => {
    const router = new FakeRouter();
    const p = payer(router);
    await routeOnce(p, router);
    router.abortAfterSettle = true;
    const lost = await routeOnce(p, router);
    expect(skippedWhy(lost, router)).toBe('payment_failed');
    expect(router.settledFees).toBe(2);
    const paidBefore = router.paidRequests();
    const next = await routeOnce(p, router);
    expect(next.status).toBe('decided');
    expect(router.paidRequests() - paidBefore).toBe(2);
    // The stale voucher was refused, the SDK resynced from the wallet's own
    // last voucher, and the retry was charged once.
    expect(router.settledFees).toBe(3);
    expect(router.deposits).toBe(1);
    expect([...router.channels.values()][0]!.charged).toBe(3n * ROUTING_FEE_CEILING_ATOMIC);
  });

  it('skips a call whose socket reset, with no second request, unpaid', async () => {
    const router = new FakeRouter();
    const p = payer(router);
    const route = p.routeFor(BASE);
    let resets = 0;
    const resetOnce: typeof fetch = async (input, init) => {
      if (resets === 0) {
        resets += 1;
        throw Object.assign(new TypeError('fetch failed'), {
          cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
        });
      }
      return router.fetch(input, init);
    };
    const outcome = await requestDecision(
      'tool',
      { query: 'q' },
      { ctx: ctx(), baseUrl: BASE, fetchImpl: resetOnce, timeoutMs: 3_500, route },
    );
    expect(skippedWhy(outcome, router)).toBe('payment_failed');
    expect(router.log).toEqual([]);
    expect(router.settledFees).toBe(0);
  });

  it('shares one channel and its one deposit between processes that take turns', async () => {
    const router = new FakeRouter();
    const a = payer(router);
    const b = payer(router);
    for (const p of [a, b, a, b]) {
      expect((await routeOnce(p, router)).status).toBe('decided');
    }
    expect(router.channels.size).toBe(1);
    expect(router.deposits).toBe(1);
    expect(router.settledFees).toBe(4);
    // Nothing but the SDK's channel storage in the wallet's folder.
    expect(await readdir(payerDir(dir, wallet.address))).toEqual(['client']);
  });

  it("skips a call, unpaid, when another process's call is in flight on the channel", async () => {
    const router = new FakeRouter();
    await routeOnce(payer(router), router);
    router.delayMs = 200;
    const outcomes = await Promise.all([
      routeOnce(payer(router), router),
      routeOnce(payer(router), router),
    ]);
    expect(outcomes.map((o) => o.status).sort()).toEqual(['decided', 'skipped']);
    expect(outcomes.map(unpaidWhy).sort()).toEqual(['channel_busy', undefined]);
    expect(router.log.filter((l) => l === 'POST /api/x402-router unpaid')).toHaveLength(0);
    expect(router.channels.size).toBe(1);
    expect(router.deposits).toBe(1);
    // The refused voucher was charged nothing; the next call continues the total.
    expect(router.settledFees).toBe(2);
    router.delayMs = 0;
    expect((await routeOnce(payer(router), router)).status).toBe('decided');
    expect(router.settledFees).toBe(3);
    expect([...router.channels.values()][0]!.charged).toBe(3n * ROUTING_FEE_CEILING_ATOMIC);
  });

  it('takes turns inside one process: parallel calls share one channel and never collide', async () => {
    const router = new FakeRouter();
    router.delayMs = 20;
    const p = payer(router);
    const outcomes = await Promise.all([
      routeOnce(p, router),
      routeOnce(p, router),
      routeOnce(p, router),
    ]);
    expect(outcomes.map((o) => o.status)).toEqual(['decided', 'decided', 'decided']);
    expect(router.channels.size).toBe(1);
    expect(router.settledFees).toBe(3);
  });

  it("counts a queued call's budget from when it was sent, not from when its turn came", async () => {
    const router = new FakeRouter();
    const { timers, armed } = armedTimers();
    const p = payer(router, { now: () => Date.now(), timers });
    await routeOnce(p, router);
    router.delayMs = 300;
    const route = p.routeFor(BASE);
    holdTime();
    const call = (timeoutMs: number) =>
      requestDecision(
        'tool',
        { query: 'q' },
        { ctx: ctx(), baseUrl: BASE, fetchImpl: router.fetch, timeoutMs, route },
      );
    // The second waits behind the first for longer than its own budget.
    // The first must hold the channel before the second is sent: each call
    // reads the memo from disk first, so sending both at once races their order.
    const held = delayArmed(router);
    const firstCall = call(3_500);
    await held;
    const secondCall = call(100);
    await armed(100);
    await vi.advanceTimersByTimeAsync(300);
    const [first, second] = await Promise.all([firstCall, secondCall]);
    expect(first.status).toBe('decided');
    expect(second).toEqual({ status: 'skipped', why: 'busy' });
  });

  /** An RPC that never answers, the way viem's own fetch sees one. */
  const hangingRpc = (() => {
    let calls = 0;
    const fetchFn = ((_url: unknown, init?: RequestInit) => {
      calls += 1;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    }) as typeof fetch;
    return { fetchFn, calls: () => calls };
  })();

  it.each([
    ['its own 2 s', 3_500, RPC_TIMEOUT_MS],
    ["the call's smaller budget", 800, 800],
  ])(
    "skips the call within %s when the SDK's chain read hangs, sending nothing",
    async (_label, budgetMs, boundMs) => {
      const router = new FakeRouter();
      const before = hangingRpc.calls();
      const p = payer(router, {
        now: () => Date.now(),
        readContract: chainReader('http://rpc.test', hangingRpc.fetchFn),
      });
      const route = p.routeFor(BASE);
      const started = Date.now();
      const outcome = await requestDecision(
        'tool',
        { query: 'q' },
        { ctx: ctx(), baseUrl: BASE, fetchImpl: router.fetch, timeoutMs: budgetMs, route },
      );
      const took = Date.now() - started;
      expect(unpaidWhy(outcome)).toBe('chain_unreadable');
      // One request, no retry, cut at the bound.
      expect(hangingRpc.calls() - before).toBe(1);
      expect(took).toBeGreaterThanOrEqual(boundMs - 50);
      expect(took).toBeLessThan(boundMs + 400);
      expect(router.paidRequests()).toBe(0);
    },
    10_000,
  );

  const noWallet = async (): Promise<never> => {
    throw new CliError('WALLET_MISSING', 'no wallet');
  };
  const locked = async (): Promise<never> => {
    throw new Error('passphrase needed');
  };

  it.each([
    ['no wallet', noWallet],
    ['a locked wallet', locked],
  ])(
    'asks the server before the wallet: with the fee off, %s is never touched',
    async (_l, fail) => {
      const router = new FakeRouter({ paid: false });
      let unlocks = 0;
      const p = payer(router, { getSigner: () => ((unlocks += 1), fail()) });
      expect((await routeOnce(p, router)).status).toBe('decided');
      expect(unlocks).toBe(0);
    },
  );

  it('skips a call with no wallet once the server charges the fee, in one request', async () => {
    const router = new FakeRouter();
    const p = payer(router, { getSigner: noWallet });
    expect(skippedWhy(await routeOnce(p, router), router)).toBe('no_wallet');
    expect(router.log).toEqual(['POST /api/x402-router/route unpaid']);
  });

  it('pays nothing when the wallet cannot be unlocked, and an unclassified failure is wallet_locked', async () => {
    const router = new FakeRouter();
    const warned: string[] = [];
    const p = payer(router, {
      getSigner: async () => {
        throw new Error('passphrase needed');
      },
      warn: (line) => warned.push(line),
    });
    expect(skippedWhy(await routeOnce(p, router), router)).toBe('wallet_locked');
    expect(router.paidRequests()).toBe(0);
    // The error's own message is still the one diagnostic line.
    expect(warned.join('\n')).toContain('passphrase needed');
    // The fallback is unknown, never a block.
    expect(p.signVerdict()).toMatchObject({ status: 'unknown', reason: 'wallet_locked' });
  });

  it.each<UnlockReason>([
    'no_wallet',
    'wallet_corrupt',
    'env_key_invalid',
    'passphrase_missing',
    'passphrase_wrong',
    'env_passphrase_wrong',
    'keychain_locked',
    'unlock_timeout',
  ])('skips with the classified reason when the unlock fails with %s', async (reason) => {
    const router = new FakeRouter();
    const p = payer(router, { getSigner: unlockFails(reason) });
    expect(skippedWhy(await routeOnce(p, router), router)).toBe(reason);
    expect(router.paidRequests()).toBe(0);
  });

  it('signs no deposit from a wallet that cannot cover it', async () => {
    const router = new FakeRouter();
    const p = payer(router, { walletAtomic: CHANNEL_DEPOSIT_ATOMIC - 1n });
    expect(skippedWhy(await routeOnce(p, router), router)).toBe('wallet_low');
    expect(router.paidRequests()).toBe(0);
  });

  it('applies the creator allowlist to a deposit', async () => {
    const router = new FakeRouter();
    const p = payer(router, { policy_: { allowlistCreators: ['someone.else'] } });
    expect(skippedWhy(await routeOnce(p, router), router)).toBe('not_allowlisted');
    expect(router.paidRequests()).toBe(0);
  });

  it("takes the deposit ceiling from the SDK's own knobs: the spend cap times depositMultiplier", () => {
    expect(ROUTING_SPEND_CAP).toBe('$0.05');
    expect(50_000n * BigInt(DEPOSIT_MULTIPLIER)).toBe(MAX_CHANNEL_DEPOSIT_ATOMIC);
    expect(CHANNEL_DEPOSIT_ATOMIC).toBeLessThan(MAX_CHANNEL_DEPOSIT_ATOMIC);
  });
});

describe('RoutingPayer and the call budget', () => {
  /** One call with its own budget, in real time, and the lines the payer warned. */
  function timed(router: FakeRouter, timers?: RoutingPayerDeps['timers']) {
    const warned: string[] = [];
    const p = payer(router, { now: () => Date.now(), warn: (line) => warned.push(line), timers });
    const call = async (timeoutMs: number) => {
      const route = p.routeFor(BASE);
      return requestDecision(
        'tool',
        { query: 'q' },
        { ctx: ctx(), baseUrl: BASE, fetchImpl: router.fetch, timeoutMs, route },
      );
    };
    return { p, call, warned };
  }

  async function storedChannel() {
    const files = await channelFiles();
    return new FileClientChannelStorage({ directory: payerDir(dir, wallet.address) }).get(
      files[0]!.replace('.json', ''),
    );
  }

  it('waits past the gate budget for a call that carries a deposit, on a router with no warm form', async () => {
    await noWarm();
    const router = new FakeRouter();
    router.delayMs = 400;
    const { call } = timed(router);
    // 200 ms is the caller's budget; the deposit adds the hook leg's rest.
    expect((await call(200)).status).toBe('decided');
    expect(router.deposits).toBe(1);
  });

  it('returns an inline deposit still out at the longer budget as no fault, and records it when it lands', async () => {
    await noWarm();
    const router = new FakeRouter();
    router.delayMs = DEPOSIT_GATE_TIMEOUT_MS - GATE_TIMEOUT_MS + 600;
    const { call, warned } = timed(router);
    const started = Date.now();
    expect(await call(200)).toEqual({ status: 'skipped', why: 'deadline_after_payment_sent' });
    expect(Date.now() - started).toBeLessThan(DEPOSIT_GATE_TIMEOUT_MS - GATE_TIMEOUT_MS + 500);
    router.delayMs = 0;
    // Queued behind the late answer, then a voucher from the recorded channel.
    expect((await call(3_500)).status).toBe('decided');
    expect(router.deposits).toBe(1);
    expect(router.paidRequests()).toBe(2);
    expect(await storedChannel()).toMatchObject({
      balance: CHANNEL_DEPOSIT_ATOMIC.toString(),
      chargedCumulativeAmount: (2n * ROUTING_FEE_CEILING_ATOMIC).toString(),
    });
    expect((await readSpendSummary(dir))?.reservations).toEqual([]);
    expect(warned.join('\n')).toMatch(
      /deadline_after_payment_sent \(cause late http 200, \d+ms, stage deposit\)/,
    );
  });

  it('keeps the gate budget for a voucher, and lets one still out finish', async () => {
    const router = new FakeRouter();
    const { call, warned } = timed(router);
    expect((await call(3_500)).status).toBe('decided');
    router.delayMs = 600;
    const started = Date.now();
    expect(await call(200)).toEqual({ status: 'skipped', why: 'deadline_after_payment_sent' });
    // Not lengthened: no deposit rode on it.
    expect(Date.now() - started).toBeLessThan(500);
    router.delayMs = 0;
    expect((await call(3_500)).status).toBe('decided');
    // The late voucher was recorded: the next one continued the total.
    expect(router.paidRequests()).toBe(4);
    expect(router.warms).toBe(1);
    expect(router.settledFees).toBe(3);
    expect(warned.join('\n')).toContain('stage voucher');
  });

  it('still aborts a call whose budget ends before anything is paid', async () => {
    const router = new FakeRouter();
    // A probe that answers only after the budget, and honors the abort.
    const slowProbe: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      await new Promise((resolve, reject) => {
        setTimeout(resolve, 400);
        request.signal.addEventListener('abort', () => reject(request.signal.reason));
      });
      return router.fetch(request);
    };
    const { p, warned } = timed(router);
    const route = p.routeFor(BASE);
    const outcome = await requestDecision(
      'tool',
      { query: 'q' },
      { ctx: ctx(), baseUrl: BASE, fetchImpl: slowProbe, timeoutMs: 200, route },
    );
    expect(outcome).toEqual({ status: 'skipped', why: 'payment_failed' });
    expect(router.paidRequests()).toBe(0);
    expect(warned.join('\n')).toContain('payment_failed (cause timeout');
  });

  it('gives up on a queued call at its own deadline instead of waiting out a detached payment', async () => {
    const router = new FakeRouter();
    const { timers, armed } = armedTimers();
    const { call, warned } = timed(router, timers);
    expect((await call(3_500)).status).toBe('decided');
    // The next voucher answers after 1.5 s, past its 200 ms budget: it detaches.
    router.delayMs = 1_500;
    holdTime();
    const held = delayArmed(router);
    const ahead = call(200);
    const started = Date.now();
    await Promise.all([held, armed(200)]);
    const queuedCall = call(300);
    await armed(300);
    await vi.advanceTimersByTimeAsync(300);
    const queued = await queuedCall;
    expect(queued).toEqual({ status: 'skipped', why: 'busy' });
    expect(Date.now() - started).toBeLessThan(1_200);
    await vi.advanceTimersByTimeAsync(1_500);
    await ahead;
    // Every unanswered call says so once, a queued one included.
    expect(warned.join('\n')).toMatch(/busy \(cause queued, \d+ms, stage queue\)/);
  });

  it('reports a paid call whose body stalls past its time as sent, not failed', async () => {
    const router = new FakeRouter();
    // The paid answer settles, then its body never finishes.
    const stallPaid: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const response = await router.fetch(request);
      if (!request.headers.has('payment-signature') || response.status !== 200) return response;
      return new Response(new ReadableStream({ start: (c) => c.enqueue(new Uint8Array([123])) }), {
        status: 200,
        headers: response.headers,
      });
    };
    const { p, call } = timed(router);
    // A funded channel, so the stalled request is the call's own voucher.
    expect((await call(3_500)).status).toBe('decided');
    const route = p.routeFor(BASE);
    const outcome = await requestDecision(
      'tool',
      { query: 'q' },
      { ctx: ctx(), baseUrl: BASE, fetchImpl: stallPaid, timeoutMs: 200, route },
    );
    expect(router.settledFees).toBe(2);
    expect(outcome).toEqual({ status: 'skipped', why: 'deadline_after_payment_sent' });
  });

  it("bounds the body read by the call's deadline once the headers arrive", async () => {
    // A real router socket that sends its headers, then never finishes the body.
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const p = payer(new FakeRouter(), { now: () => Date.now(), fetchImpl: fetch });
      const route = p.routeFor(base);
      const started = Date.now();
      const outcome = await requestDecision(
        'tool',
        { query: 'q' },
        { ctx: ctx(), baseUrl: base, timeoutMs: 200, route },
      );
      expect(outcome.status).not.toBe('decided');
      expect(Date.now() - started).toBeLessThan(DEPOSIT_GATE_TIMEOUT_MS - GATE_TIMEOUT_MS + 1_000);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }, 4_000);
});

describe('RoutingPayer and the wallet verdict', () => {
  /** One call on its own budget, in real time. */
  async function callWith(p: RoutingPayer, router: FakeRouter, timeoutMs: number) {
    const route = p.routeFor(BASE);
    return requestDecision(
      'tool',
      { query: 'q' },
      { ctx: ctx(), baseUrl: BASE, fetchImpl: router.fetch, timeoutMs, route },
    );
  }

  /** The paid-path requests the router saw since `from`. */
  const paidPathSince = (router: FakeRouter, from: number) =>
    router.log.slice(from).filter((l) => l.startsWith('POST /api/x402-router/route'));

  it('stops waiting for an unlock that never answers at the call deadline', async () => {
    const router = new FakeRouter();
    const getSigner = vi.fn(() => new Promise<TenjinSigner>(() => undefined));
    const p = payer(router, { now: () => Date.now(), getSigner });
    const started = Date.now();
    expect(unpaidWhy(await callWith(p, router, 300))).toBe('unlock_timeout');
    expect(Date.now() - started).toBeLessThan(300 + 400);
    expect(router.paidRequests()).toBe(0);
    // Still running, so nothing is known yet: never a block.
    expect(p.signVerdict()).toMatchObject({ status: 'unknown', reason: 'not_checked' });
  });

  it('stops waiting for an unlock before the paid call has no time left', async () => {
    const router = new FakeRouter();
    const getSigner = vi.fn(() => new Promise<TenjinSigner>(() => undefined));
    const p = payer(router, { now: () => Date.now(), getSigner });
    void p.prewarm();
    const started = Date.now();
    const outcome = await callWith(p, router, PAID_CALL_RESERVE_MS + 300);
    expect(skippedWhy(outcome, router)).toBe('unlock_timeout');
    expect(Date.now() - started).toBeLessThan(PAID_CALL_RESERVE_MS + 300);
    expect(getSigner).toHaveBeenCalledTimes(1);
  });

  it('runs one unlock for the prewarm and every call waiting on it', async () => {
    const router = new FakeRouter();
    const getSigner = vi.fn(() => new Promise<TenjinSigner>(() => undefined));
    const p = payer(router, { now: () => Date.now(), getSigner });
    void p.prewarm();
    const outcomes = await Promise.all([callWith(p, router, 300), callWith(p, router, 300)]);
    expect(outcomes.map(unpaidWhy)).toContain('unlock_timeout');
    expect(getSigner).toHaveBeenCalledTimes(1);
  });

  it('never cancels an unlock the call stopped waiting for, and the next call signs with it (B3)', async () => {
    const router = new FakeRouter();
    let answer!: (signer: TenjinSigner) => void;
    const getSigner = vi.fn(
      () =>
        new Promise<TenjinSigner>((resolve) => {
          answer = resolve;
        }),
    );
    // Another process funded the channel, so the call below pays a voucher.
    await callWith(payer(router), router, 3_500);
    const p = payer(router, { now: () => Date.now(), getSigner });
    expect(unpaidWhy(await callWith(p, router, 200))).toBe('unlock_timeout');
    // The person answers the unlock dialog after the call was skipped.
    answer(testSigner(wallet));
    await vi.waitFor(() => expect(p.signVerdict().status).toBe('ready'));
    const next = await callWith(p, router, 3_500);
    expect(next.status).toBe('decided');
    expect(unpaidWhy(next)).toBeUndefined();
    expect(router.settledFees).toBe(2);
    // One unlock in all, handed no abort signal or anything else to cancel it by.
    expect(getSigner).toHaveBeenCalledTimes(1);
    expect(getSigner).toHaveBeenCalledWith();
  });

  it('remembers a definite block: no unlock and no request until the wallet changes or a minute passes', async () => {
    const router = new FakeRouter();
    let stamp = '1:1';
    let unlocks = 0;
    const fail = unlockFails('passphrase_wrong');
    const p = payer(router, {
      getSigner: () => ((unlocks += 1), fail()),
      unlockStamp: async () => stamp,
    });
    expect(skippedWhy(await routeOnce(p, router), router)).toBe('passphrase_wrong');
    expect(unlocks).toBe(1);

    // After the 402 and the block: nothing is sent on the paid path, nothing unlocked.
    let from = router.log.length;
    expect(skippedWhy(await routeOnce(p, router), router)).toBe('passphrase_wrong');
    expect(paidPathSince(router, from)).toEqual([]);
    expect(unlocks).toBe(1);
    clock += SIGNER_RECHECK_MS - 1;
    from = router.log.length;
    expect(skippedWhy(await routeOnce(p, router), router)).toBe('passphrase_wrong');
    expect(paidPathSince(router, from)).toEqual([]);
    expect(unlocks).toBe(1);

    // A repair rewrites the sidecar: the next call checks again at once.
    stamp = '1:2';
    from = router.log.length;
    expect(skippedWhy(await routeOnce(p, router), router)).toBe('passphrase_wrong');
    expect(paidPathSince(router, from)).toEqual(['POST /api/x402-router/route unpaid']);
    expect(unlocks).toBe(2);

    // A minute later, too.
    clock += SIGNER_RECHECK_MS;
    from = router.log.length;
    expect(skippedWhy(await routeOnce(p, router), router)).toBe('passphrase_wrong');
    expect(paidPathSince(router, from)).toEqual(['POST /api/x402-router/route unpaid']);
    expect(unlocks).toBe(3);
  });

  it('stops reporting a definite block a minute on, and unlocks again with no call asking', async () => {
    const router = new FakeRouter();
    let created = false;
    const fail = unlockFails('no_wallet');
    const getSigner = vi.fn(() => (created ? Promise.resolve(testSigner(wallet)) : fail()));
    const p = payer(router, { getSigner });
    await p.prewarm();
    expect(p.signVerdict()).toMatchObject({ status: 'blocked', reason: 'no_wallet' });
    // `tenjin wallet create` mid-session, and no routing call ever asks for the fee.
    created = true;
    clock += SIGNER_RECHECK_MS - 1;
    expect(p.signVerdict()).toMatchObject({ status: 'blocked', reason: 'no_wallet' });
    clock += 1;
    // Stale: it gates nothing while the unlock it started runs.
    expect(p.signVerdict()).toMatchObject({ status: 'unknown', reason: 'not_checked' });
    await vi.waitFor(() => expect(p.signVerdict()).toEqual({ status: 'ready' }));
    expect(getSigner).toHaveBeenCalledTimes(2);
    expect(router.log).toEqual([]);
  });

  it('unlocks again at once when the wallet changes under a definite block', async () => {
    const router = new FakeRouter();
    let stamp = '1:1';
    let repaired = false;
    const fail = unlockFails('passphrase_wrong');
    const getSigner = vi.fn(() => (repaired ? Promise.resolve(testSigner(wallet)) : fail()));
    const p = payer(router, { getSigner, unlockStamp: async () => stamp });
    await p.prewarm();
    expect(p.signVerdict()).toMatchObject({ status: 'blocked', reason: 'passphrase_wrong' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(getSigner).toHaveBeenCalledTimes(1);
    repaired = true;
    stamp = '1:2';
    p.signVerdict();
    await vi.waitFor(() => expect(p.signVerdict()).toEqual({ status: 'ready' }));
    expect(getSigner).toHaveBeenCalledTimes(2);
  });

  it('asks the server first while this process has seen no 402, even over a known block', async () => {
    const router = new FakeRouter();
    let unlocks = 0;
    const fail = unlockFails('passphrase_missing');
    const p = payer(router, { getSigner: () => ((unlocks += 1), fail()) });
    await p.prewarm();
    expect(p.signVerdict()).toMatchObject({ status: 'blocked', reason: 'passphrase_missing' });
    expect(skippedWhy(await routeOnce(p, router), router)).toBe('passphrase_missing');
    expect(router.log[0]).toBe('POST /api/x402-router/route unpaid');
    // The 402 met the memo: the block skipped the unlock, not the request.
    expect(unlocks).toBe(1);
  });

  it.each<UnlockReason>(['keychain_locked', 'unlock_timeout'])(
    'never short-circuits on %s: every call asks and unlocks again',
    async (reason) => {
      const router = new FakeRouter();
      let unlocks = 0;
      const fail = unlockFails(reason);
      const p = payer(router, { getSigner: () => ((unlocks += 1), fail()) });
      for (let n = 1; n <= 3; n += 1) {
        const from = router.log.length;
        expect(skippedWhy(await routeOnce(p, router), router)).toBe(reason);
        expect(paidPathSince(router, from)).toEqual(['POST /api/x402-router/route unpaid']);
        expect(unlocks).toBe(n);
      }
      expect(p.signVerdict()).toMatchObject({ status: 'unknown', reason });
    },
  );

  it('sets the sign verdict from the prewarm, and reports it with the address', async () => {
    const router = new FakeRouter();
    const seen: PayerObservation[] = [];
    const p = payer(router, { observe: (u) => seen.push(u) });
    expect(p.signVerdict()).toMatchObject({ status: 'unknown', reason: 'not_checked' });
    await p.prewarm();
    expect(p.signVerdict()).toEqual({ status: 'ready' });
    expect(seen).toEqual([{ sign: { status: 'ready' }, address: wallet.address.toLowerCase() }]);
    // Nothing was asked of the server.
    expect(router.log).toEqual([]);
  });

  it('reports each sign and routing verdict once, when it changes', async () => {
    const router = new FakeRouter();
    const seen: PayerObservation[] = [];
    let stamp = '1:1';
    let broken = true;
    const fail = unlockFails('passphrase_wrong');
    const p = payer(router, {
      getSigner: () => (broken ? fail() : Promise.resolve(testSigner(wallet))),
      unlockStamp: async () => stamp,
      observe: (u) => seen.push(u),
    });
    const r = WALLET_REASONS.passphrase_wrong;
    await routeOnce(p, router);
    expect(seen).toEqual([
      { sign: { status: 'blocked', reason: 'passphrase_wrong', detail: r.reason, fix: r.fix } },
      { routing: { status: 'blocked', reason: 'passphrase_wrong', at: clock } },
    ]);
    // A repeat from the memo, and a re-check that says the same: nothing new.
    await routeOnce(p, router);
    clock += SIGNER_RECHECK_MS;
    await routeOnce(p, router);
    expect(seen).toHaveLength(2);

    // Repaired: the wallet signs, and the fee is paid.
    broken = false;
    stamp = '1:2';
    expect((await routeOnce(p, router)).status).toBe('decided');
    expect(seen.slice(2)).toEqual([
      { sign: { status: 'ready' }, address: wallet.address.toLowerCase() },
      { routing: { status: 'ready', at: clock } },
    ]);
    await routeOnce(p, router);
    expect(seen).toHaveLength(4);
  });

  it('reports a money refusal as blocked and a failed payment as unknown, and contention not at all', async () => {
    const low = new FakeRouter();
    const lowSeen: PayerObservation[] = [];
    await routeOnce(
      payer(low, { walletAtomic: CHANNEL_DEPOSIT_ATOMIC - 1n, observe: (u) => lowSeen.push(u) }),
      low,
    );
    expect(lowSeen.map((u) => u.routing).filter(Boolean)).toEqual([
      { status: 'blocked', reason: 'wallet_low', at: clock },
    ]);

    const greedy = new FakeRouter({ amount: '30000' });
    const greedySeen: PayerObservation[] = [];
    await routeOnce(payer(greedy, { observe: (u) => greedySeen.push(u) }), greedy);
    expect(greedySeen.map((u) => u.routing).filter(Boolean)).toEqual([
      { status: 'blocked', reason: FEE_ABOVE_CEILING, at: clock },
    ]);

    const failing = new FakeRouter();
    const failingSeen: PayerObservation[] = [];
    const fails = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.headers.has('payment-signature')) return new Response('{}', { status: 502 });
      return failing.fetch(request);
    }) as typeof fetch;
    await requestDecision(
      'tool',
      { query: 'q' },
      {
        ctx: ctx(),
        baseUrl: BASE,
        fetchImpl: fails,
        timeoutMs: 3_500,
        route: payer(failing, { fetchImpl: fails, observe: (u) => failingSeen.push(u) }).routeFor(
          BASE,
        ),
      },
    );
    expect(failingSeen.map((u) => u.routing).filter(Boolean)).toEqual([
      { status: 'unknown', reason: 'payment_failed', at: clock },
    ]);

    const off = new FakeRouter({ paid: false });
    const offSeen: PayerObservation[] = [];
    await routeOnce(payer(off, { observe: (u) => offSeen.push(u) }), off);
    expect(offSeen).toEqual([]);
  });
});
