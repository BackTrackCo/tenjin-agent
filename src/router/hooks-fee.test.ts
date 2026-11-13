import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEPOSIT_GATE_TIMEOUT_MS, GATE_TIMEOUT_MS } from './gate';
import { runHookCommand, runHookKind, STALE_HOOK_LINE } from './hook-command';
import { runPromptHook, type HookDeps } from './hooks';
import { LEGACY_ROUTING_QUOTE_ATOMIC } from './fee';
import { recordTermsTold, TERMS_CHANGED_SENTENCE } from './terms-notice';
import { runRequestTool } from './tool';
import { CliError } from '../lib/errors';
import { FakeRouter, payerDeps, TEST_POLICY, testSigner } from './fee-test-utils';
import { RoutingPayer, WALLET_LOW_BACKOFF_MS, type RoutingPayerDeps } from './routing-payer';
import { requestDecision } from './decision';
import { writeRouterMemo } from './router-memo';
import { readSpendSummary } from '../lib/wallet/spend';
import { KEYCHAIN_LOCKED_FIX, unlockDetails, type UnlockReason } from '../lib/wallet-unlock';
import {
  ASK_FOR_REPAIR,
  REPAIR_CLAUSE,
  WALLET_FUNDED,
  WALLET_REASONS,
  WALLET_UNLOCKED,
} from './wallet-reasons';

/**
 * The hook legs and the routing fee: every routing call goes to the paid
 * route, and inside `tenjin mcp` (which passes its payer as `route`) the stock
 * SDK client pays it. A call it cannot pay is skipped, with no request to any
 * other route; the command form (`tenjin hook`) routes nothing.
 */

const BASE = 'https://router.test';
const NOW = 1_800_000_000_000;
/** A router's offer. */
const OFFER = {
  schemaVersion: 1,
  routerVersion: 'v',
  decision: {
    action: 'execute',
    id: 'k3f9-abcd',
    capabilityId: 'cmc-quote',
    category: 'live price',
    provider: 'CoinMarketCap',
    capabilityDescription: 'live crypto quotes',
    endpoint: 'https://example.test/quote',
    providerPriceAtomic: '10000',
    usage: 'the coin and currency',
    hint: 'CoinMarketCap fits this: live crypto quotes. Call request({query: "ETH in USD", id: "k3f9-abcd"}) alone and wait for its result.',
  },
};
const KEY = generatePrivateKey();
const wallet = privateKeyToAccount(KEY);

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'router-hooks-fee-'));
  await mkdir(join(dir, '.git'));
  // What `tenjin install` writes, so the fixture's offer clears the spend vet
  // and a prompt carries no Help improve routing question.
  await writeFile(
    join(dir, 'config.json'),
    JSON.stringify({
      maxAutoSpend: '250000',
      sessionBudget: '5000000',
      install: { improveAsked: true },
    }),
  );
  // An install whose person approved limits on today's routing terms.
  await recordTermsTold(dir);
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

/** A router whose every call asks for the fee (a 402), and records what it
 *  was sent. */
function feeAsked(): {
  fetchImpl: typeof fetch;
  calls: { url: string; signature: string | null }[];
} {
  const calls: { url: string; signature: string | null }[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({
      url: String(input),
      signature: new Headers(init?.headers).get('payment-signature'),
    });
    return new Response('{}', { status: 402, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function payer(
  fake: FakeRouter,
  opts: Partial<ConstructorParameters<typeof RoutingPayer>[0]> = {},
) {
  return new RoutingPayer(payerDeps(fake, dir, wallet, opts));
}

function prompt(session = 'sess-1'): unknown {
  return {
    hook_event_name: 'UserPromptSubmit',
    session_id: session,
    cwd: dir,
    prompt: 'what is the current price of ETH in USD',
  };
}

function deps(fetchImpl: typeof fetch, p?: RoutingPayer): HookDeps {
  return {
    dataDir: dir,
    baseUrl: BASE,
    fetchImpl,
    now: () => NOW,
    warn: () => undefined,
    // A key the hooks' file facts call valid, so an offer is gated on the fee
    // alone here; the signer's own gating is `hooks.test.ts`'s.
    env: { TENJIN_WALLET_KEY: KEY },
    ...(p !== undefined ? { route: p.routeFor.bind(p) } : {}),
  };
}

it.each([
  // Funded by the top-up's `warm` deposit, which settles no fee.
  { channel: 'funded', paidBudgetMs: GATE_TIMEOUT_MS - 1_500, paidRequests: 3, settledFees: 2 },
  {
    channel: 'new',
    paidBudgetMs: DEPOSIT_GATE_TIMEOUT_MS - 1_500,
    paidRequests: 1,
    settledFees: 1,
  },
])(
  'sends the paid hook the budget left after a delayed challenge on a $channel channel',
  async ({ channel, paidBudgetMs, paidRequests, settledFees }) => {
    const fake = new FakeRouter();
    const budgets: { paid: boolean; budgetMs: number }[] = [];
    const bodies: Record<string, unknown>[] = [];
    let challengeArmed!: () => void;
    const armed = new Promise<void>((resolve) => (challengeArmed = resolve));
    const p = payer(fake);
    if (channel === 'funded') {
      await runPromptHook(prompt(), deps(fake.fetch, p));
      // The top-up's deposit, then the call's voucher.
      expect(fake.paidRequests()).toBe(2);
    } else {
      // A new channel's deposit rides the call only on a router with no `warm` form.
      await noWarm();
    }
    holdTime();
    const observe = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init);
      const body = (await request.clone().json()) as Record<string, unknown> & { budgetMs: number };
      const paid = request.headers.has('payment-signature');
      budgets.push({ paid, budgetMs: body.budgetMs });
      bodies.push(body);
      if (!paid) {
        const delayed = new Promise<void>((resolve) => setTimeout(resolve, 1_500));
        challengeArmed();
        await delayed;
      }
      return fake.fetch(request);
    }) as typeof fetch;
    const roundTrip = runPromptHook(prompt(), deps(observe, p));
    await armed;
    await vi.advanceTimersByTimeAsync(1_500);
    await roundTrip;
    expect(fake.paidRequests()).toBe(paidRequests);
    expect(fake.settledFees).toBe(settledFees);
    expect(budgets).toEqual([
      { paid: false, budgetMs: GATE_TIMEOUT_MS },
      { paid: true, budgetMs: paidBudgetMs },
    ]);
    expect({ ...bodies[0], budgetMs: 0 }).toEqual({ ...bodies[1], budgetMs: 0 });
  },
);

/**
 * Holds the timers and the clock still; file I/O and microtasks keep running.
 * The budget tests advance it by exactly the wait they model instead of
 * sleeping 4-6 s each, so a call that outlives its budget never resolves.
 */
function holdTime(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
}

/** Resolves when the router starts holding a paid request on its delay timer. */
function delayArmed(fake: FakeRouter): Promise<void> {
  return new Promise((resolve) => {
    fake.onDelayArmed = resolve;
  });
}

/** A full garbage collection, without starting Node with `--expose-gc`. */
function collectGarbage(): void {
  setFlagsFromString('--expose-gc');
  (runInNewContext('gc') as () => void)();
}

/** A router with no `warm` form, as a top-up would have learned it: a
 *  deposit rides the leg that needs it, as it did before the form. */
async function noWarm(): Promise<void> {
  await writeRouterMemo(dir, 'warm-absent', BASE, { now: 0, ttlMs: Number.MAX_SAFE_INTEGER });
}

function systemMessageOf(response: unknown): string | undefined {
  return (response as { systemMessage?: string } | null)?.systemMessage;
}

function contextOf(response: unknown): string | undefined {
  return (response as { hookSpecificOutput?: { additionalContext?: string } } | null)
    ?.hookSpecificOutput?.additionalContext;
}

/** `fake`, except that a request carrying a payment gets a server error. */
function paidFails(fake: FakeRouter): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.headers.has('payment-signature')) return new Response('{}', { status: 502 });
    return fake.fetch(request);
  }) as typeof fetch;
}

describe('the hook legs and the routing fee', () => {
  /** THE COMMAND FORM IS A STUB: it cannot pay, so it routes nothing, and
   *  tells the person once per session to set Tenjin up again. */
  it('routes nothing in the command form, and tells the person once to set Tenjin up again', async () => {
    let out = '';
    const io = { stdout: { write: (s: string) => ((out += s), true) } } as never;
    const run = (session: string) =>
      runHookCommand(io, {
        dataDir: dir,
        now: () => NOW,
        readEvent: async () => JSON.stringify(prompt(session)),
      });
    await run('sess-1');
    expect(JSON.parse(out)).toEqual({ systemMessage: STALE_HOOK_LINE });
    // The person's words: never a command to run.
    expect(STALE_HOOK_LINE).not.toContain('`');
    out = '';
    await run('sess-1');
    expect(out).toBe('');
    await run('sess-2');
    expect(JSON.parse(out)).toEqual({ systemMessage: STALE_HOOK_LINE });
  });

  it('pays the routing fee through the payer: the prompt never deposits, the top-up does', async () => {
    const fake = new FakeRouter();
    const p = payer(fake);
    await runPromptHook(prompt(), deps(fake.fetch, p));
    await runPromptHook(prompt(), deps(fake.fetch, p));
    expect(fake.log).toEqual([
      'POST /api/x402-router/route unpaid',
      // The background top-up, which the leg waits for inside its budget.
      'POST /api/x402-router/route warm unpaid',
      'POST /api/x402-router/route warm paid',
      'POST /api/x402-router/route unpaid',
      'POST /api/x402-router/route paid',
      'POST /api/x402-router/route unpaid',
      'POST /api/x402-router/route paid',
    ]);
    expect(fake.depositedOn).toEqual(['warm']);
    expect([...fake.channels.values()][0]!.charged).toBe(2n * LEGACY_ROUTING_QUOTE_ATOMIC);
  });

  it('tells the user once, beside the offer, that the deposit set funds aside for routing', async () => {
    // The line names the deposit and no fee. The fake announces the router's
    // $0.05 hint, and that is the deposit.
    const fake = new FakeRouter({ amount: '1000' });
    fake.body = OFFER;
    const p = payer(fake);
    const first = await runHookKind('prompt', prompt(), deps(fake.fetch, p));
    expect(contextOf(first)).toContain('CoinMarketCap fits this');
    expect(systemMessageOf(first)).toBe(
      'Tenjin set aside $0.05 for routing fees. It counts toward your spend limits once.',
    );
    // A voucher from that deposit is nothing new.
    const second = await runHookKind('prompt', prompt(), deps(fake.fetch, p));
    expect(systemMessageOf(second)).toBeUndefined();
    expect(fake.deposits).toBe(1);
  });

  it('tells an install that approved the old fee its new routing terms once, never asking', async () => {
    // An install from before per-answer quotes: nothing records the new terms told.
    await rm(join(dir, 'router', 'terms'), { recursive: true, force: true });
    const fake = new FakeRouter({ amount: '1000' });
    fake.body = OFFER;
    const p = payer(fake);
    const first = await runHookKind('prompt', prompt(), deps(fake.fetch, p));
    expect(systemMessageOf(first)).toContain(TERMS_CHANGED_SENTENCE);
    // Once per machine, a new session included.
    const later = await runHookKind('prompt', prompt('sess-2'), deps(fake.fetch, p));
    expect(systemMessageOf(later)).toBeUndefined();
  });

  it.each(['tool', 'hook'] as const)(
    'shares the terms notice across tool and hook when the %s routes first',
    async (first) => {
      await rm(join(dir, 'router', 'terms'), { recursive: true, force: true });
      const fake = new FakeRouter({ amount: '1000' });
      const p = payer(fake);
      const authorizer = payerDeps(fake, dir, wallet).authorizer(TEST_POLICY);
      const sink = { write: () => true } as unknown as NodeJS.WritableStream;
      const tool = async () =>
        (
          await runRequestTool(
            { query: 'what is the current price of ETH in USD' },
            {
              ctx: {
                dataDir: dir,
                flags: { json: true, timeout: 5000, baseUrl: BASE },
                io: { stdout: sink, stderr: sink, isTTY: false },
              },
              cwd: dir,
              authorizer,
              fetchImpl: fake.fetch,
              route: p.routeFor.bind(p),
            },
          )
        ).summary;
      const hook = async () =>
        systemMessageOf(await runHookKind('prompt', prompt(), deps(fake.fetch, p))) ?? '';

      expect(await (first === 'tool' ? tool() : hook())).toContain(TERMS_CHANGED_SENTENCE);
      expect((await stat(join(dir, 'router', 'terms', 'per-answer-quote'))).isFile()).toBe(true);
      expect(await tool()).not.toContain(TERMS_CHANGED_SENTENCE);
      expect(await hook()).not.toContain(TERMS_CHANGED_SENTENCE);
      expect(fake.settledFees).toBe(3);
    },
  );

  it("tells the person about a start top-up on the next hook leg, never in a tool call's result", async () => {
    const fake = new FakeRouter();
    const p = payer(fake);
    await p.prewarm();
    await p.topUpIfLow(BASE);
    expect(fake.depositedOn).toEqual(['warm']);
    // The agent's `request` call routes first: its result reads only `deposited`.
    const tool = p.routeFor(BASE);
    const ctx = {
      flags: { json: true, timeout: 5_000 },
      dataDir: dir,
      io: { stdout: null, stderr: null, isTTY: false },
    } as never;
    await requestDecision(
      'tool',
      { query: 'q' },
      { ctx, baseUrl: BASE, fetchImpl: fake.fetch, timeoutMs: 3_500, route: tool },
    );
    expect(tool.deposited?.()).toBe(0n);
    const leg = await runHookKind('prompt', prompt(), deps(fake.fetch, p));
    expect(systemMessageOf(leg)).toContain('Tenjin set aside $0.05 for routing fees.');
  });

  it("skips, and says nothing, when another session's call holds the channel", async () => {
    const fake = new FakeRouter();
    await runPromptHook(prompt(), deps(fake.fetch, payer(fake)));
    fake.delayMs = 200;
    const answers = await Promise.all([
      runHookKind('prompt', prompt('sess-a'), deps(fake.fetch, payer(fake))),
      runHookKind('prompt', prompt('sess-b'), deps(fake.fetch, payer(fake))),
    ]);
    expect(fake.settledFees).toBe(2);
    // Native answers and nothing for the user: a busy channel is no fault.
    expect(answers).toEqual([null, null]);
  });

  const ASK = 'POST /api/x402-router/route unpaid';
  /** The top-up's 402, which a refusal before signing ends at. */
  const WARM_ASK = 'POST /api/x402-router/route warm unpaid';
  it.each<[string, Partial<RoutingPayerDeps>, string, string[]]>([
    [
      'the wallet holds less than the deposit',
      { walletBalance: async () => 12_999n },
      'Routing answers that need no payment can still work.',
      [ASK, WARM_ASK],
    ],
    [
      'the wallet cannot be unlocked',
      {
        getSigner: async () => {
          throw new Error('passphrase needed');
        },
      },
      // Unclassified: the person is pointed at doctor, never at the variable.
      '`tenjin doctor`',
      [ASK],
    ],
    [
      'the machine has no wallet',
      {
        getSigner: async () => {
          throw new CliError('WALLET_MISSING', 'no wallet');
        },
      },
      '`tenjin doctor`',
      [ASK],
    ],
    [
      'the daily budget has no room for the deposit',
      {
        policy: async () => ({
          maxAutoSpendAtomic: 250_000n,
          sessionBudgetAtomic: 20_000n,
          allowlistCreators: [],
        }),
      },
      // A spend limit, never checkout: the balance is not the cause.
      'or ask your agent to raise it.',
      [ASK, WARM_ASK],
    ],
  ])(
    'skips the call, paying nothing, when %s, and tells the user once per session',
    async (_label, opts, says, log) => {
      const fake = new FakeRouter();
      fake.body = OFFER;
      const p = payer(fake, opts);
      const first = await runHookKind('prompt', prompt(), deps(fake.fetch, p));
      // Nothing was routed: no offer, and the native tool runs.
      expect(contextOf(first)).toBeUndefined();
      expect(systemMessageOf(first)).toContain('could not pay');
      expect(systemMessageOf(first)).toContain(says);
      expect(systemMessageOf(first)).not.toContain('tenjin fund');
      expect(systemMessageOf(first)).not.toContain('TENJIN_WALLET_PASSPHRASE');
      expect(fake.log).toEqual(log);
      // Not again in this session, and no second top-up while it is held off.
      const second = await runHookKind('prompt', prompt(), deps(fake.fetch, p));
      expect(contextOf(second)).toBeUndefined();
      expect(systemMessageOf(second)).toBeUndefined();
      expect(fake.log.filter((l) => l === WARM_ASK)).toHaveLength(log.includes(WARM_ASK) ? 1 : 0);
      expect(fake.paidRequests()).toBe(0);
      // A new session is told once too.
      const other = await runHookKind('prompt', prompt('sess-2'), deps(fake.fetch, p));
      expect(systemMessageOf(other)).toContain(says);
    },
  );

  it.each([
    ['no wallet', () => new CliError('WALLET_MISSING', 'no wallet')],
    ['a wallet it cannot unlock', () => new Error('passphrase needed')],
  ])('routes on the paid route with the fee off, on a machine with %s', async (_label, error) => {
    const fake = new FakeRouter({ paid: false });
    fake.body = OFFER;
    let unlocks = 0;
    const p = payer(fake, {
      getSigner: async () => {
        unlocks += 1;
        throw error();
      },
    });
    // The prewarm a real `tenjin mcp` starts is not this test's: only calls count.
    for (let i = 0; i < 2; i += 1) {
      const answer = await runHookKind('prompt', prompt(), deps(fake.fetch, p));
      expect(contextOf(answer)).toContain('CoinMarketCap fits this');
      expect(systemMessageOf(answer)).toBeUndefined();
    }
    expect(fake.log).toEqual([
      'POST /api/x402-router/route unpaid',
      'POST /api/x402-router/route unpaid',
    ]);
    expect(unlocks).toBe(0);
  });

  it('skips a leg with no payer when the paid route asks for the fee, and says so once', async () => {
    const { fetchImpl, calls } = feeAsked();
    const first = await runHookKind('prompt', prompt(), deps(fetchImpl));
    expect(contextOf(first)).toBeUndefined();
    expect(systemMessageOf(first)).toContain('the router charges it');
    expect(systemMessageOf(first)).toContain('`tenjin doctor`');
    const second = await runHookKind('prompt', prompt(), deps(fetchImpl));
    expect(second).toBeNull();
    expect(calls).toEqual([
      { url: `${BASE}/api/x402-router/route`, signature: null },
      { url: `${BASE}/api/x402-router/route`, signature: null },
    ]);
  });

  it('tells a machine an earlier release left at a zero per-call limit the reason, never a spend question', async () => {
    await writeFile(join(dir, 'config.json'), JSON.stringify({ maxAutoSpend: '0' }));
    const fake = new FakeRouter();
    fake.body = OFFER;
    const p = payer(fake, {
      policy: async () => ({
        maxAutoSpendAtomic: 0n,
        sessionBudgetAtomic: 5_000_000n,
        allowlistCreators: [],
      }),
    });
    const answer = await runHookKind('prompt', prompt(), deps(fake.fetch, p));
    const notice = systemMessageOf(answer);
    expect(notice).toContain(
      'the per-call spend limit cannot cover the routing fee or its deposit',
    );
    expect(notice).toContain('Ask your agent to raise it.');
    expect(notice).not.toContain('tenjin config');
    expect(notice).not.toContain('tenjin fund');
    expect(notice).not.toContain('not answered');
    expect(notice).not.toContain('tenjin install --yes');
    expect(fake.paidRequests()).toBe(0);
  });

  it('skips the call when the payment fails, and names doctor', async () => {
    const fake = new FakeRouter();
    const fails = paidFails(fake);
    const p = payer(fake, { fetchImpl: fails });
    const answer = await runHookKind('prompt', prompt('sess-fails'), deps(fails, p));
    // The leg's 402, the top-up's 402, then its paid `warm` that failed
    // (answered before the fake saw it), and nothing after.
    expect(fake.log).toEqual([
      'POST /api/x402-router/route unpaid',
      'POST /api/x402-router/route warm unpaid',
    ]);
    expect(systemMessageOf(answer)).toContain('the routing payment failed');
    expect(systemMessageOf(answer)).toContain('`tenjin doctor`');
    // The deposit the server refused is released, not counted.
    expect((await readSpendSummary(dir))?.committedAtomic ?? '0').toBe('0');
  });

  /**
   * `fake`, except that a request carrying a payment never answers until the
   * signal it was sent with aborts, the way a real transport ends it. A full
   * garbage collection runs while it waits: a budget that reached the request
   * only through Request copies was lost there about half the time.
   */
  function paidHangs(fake: FakeRouter): {
    fetchImpl: typeof fetch;
    paid: () => number;
    sent: Promise<void>;
  } {
    let paid = 0;
    let onSent!: () => void;
    const sent = new Promise<void>((resolve) => (onSent = resolve));
    const fetchImpl = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init);
      if (!request.headers.has('payment-signature')) return fake.fetch(request);
      paid += 1;
      onSent();
      const signal = init?.signal ?? request.signal;
      setTimeout(collectGarbage, 50);
      return new Promise<Response>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        signal.addEventListener('abort', () => reject(signal.reason));
      });
    }) as typeof fetch;
    return { fetchImpl, paid: () => paid, sent };
  }

  it('gives an inline deposit the longer budget on a router with no warm form: a settle at about 4 s is paid and names only the deposit', async () => {
    await noWarm();
    const fake = new FakeRouter();
    fake.body = OFFER;
    fake.delayMs = GATE_TIMEOUT_MS + 400;
    holdTime();
    const held = delayArmed(fake);
    const started = Date.now();
    const call = runHookKind('prompt', prompt(), deps(fake.fetch, payer(fake)));
    await held;
    await vi.advanceTimersByTimeAsync(fake.delayMs);
    const answer = await call;
    expect(Date.now() - started).toBeGreaterThan(GATE_TIMEOUT_MS);
    expect(contextOf(answer)).toContain('CoinMarketCap fits this');
    expect(systemMessageOf(answer)).toContain('set aside $0.05 for routing');
    expect(fake.depositedOn).toEqual(['call']);
    expect(fake.log.at(-1)).toBe('POST /api/x402-router/route paid');
    const ledger = await readSpendSummary(dir);
    expect(ledger?.reservations).toEqual([]);
    expect(ledger?.committedAtomic).not.toBe('0');
  });

  it('lets an inline deposit that settles past the budget finish in tenjin mcp, and says nothing', async () => {
    await noWarm();
    const fake = new FakeRouter();
    fake.body = OFFER;
    fake.delayMs = 6_000;
    // The payer's timers, observed, so the test releases the first call's
    // deposit only once the second is queued behind it.
    let onArmed: (() => void) | undefined;
    const timers: NonNullable<RoutingPayerDeps['timers']> = {
      setTimeout: ((fn: () => void, ms?: number) => {
        onArmed?.();
        return globalThis.setTimeout(fn, ms);
      }) as typeof setTimeout,
      clearTimeout: (id) => globalThis.clearTimeout(id),
    };
    const p = payer(fake, { timers });
    holdTime();
    const held = delayArmed(fake);
    const started = Date.now();
    const firstCall = runHookKind('prompt', prompt(), deps(fake.fetch, p));
    await held;
    await vi.advanceTimersByTimeAsync(DEPOSIT_GATE_TIMEOUT_MS);
    const first = await firstCall;
    // The leg returns at the deposit budget, inside the hook's 5 s, unpaid and silent.
    expect(Date.now() - started).toBeLessThan(DEPOSIT_GATE_TIMEOUT_MS + 400);
    expect(systemMessageOf(first)).toBeUndefined();
    fake.delayMs = 0;
    // The next call waits for the first to settle, then pays a voucher from
    // the channel the SDK recorded: no second deposit, no corrective 402.
    const queued = new Promise<void>((resolve) => (onArmed = resolve));
    const secondCall = runHookKind('prompt', prompt(), deps(fake.fetch, p));
    await queued;
    await vi.advanceTimersByTimeAsync(6_000 - DEPOSIT_GATE_TIMEOUT_MS);
    const second = await secondCall;
    expect(contextOf(second)).toContain('CoinMarketCap fits this');
    expect(systemMessageOf(second)).toBeUndefined();
    expect(fake.deposits).toBe(1);
    expect(fake.paidRequests()).toBe(2);
    expect([...fake.channels.values()][0]!.charged).toBe(2n * LEGACY_ROUTING_QUOTE_ATOMIC);
    const ledger = await readSpendSummary(dir);
    expect(ledger?.reservations).toEqual([]);
    expect(ledger?.committedAtomic).not.toBe('0');
  });

  it('still names doctor when the router refuses the payment at verify', async () => {
    const fake = new FakeRouter();
    const refuses = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.headers.has('payment-signature')) return new Response('{}', { status: 402 });
      return fake.fetch(request);
    }) as typeof fetch;
    const answer = await runHookKind('prompt', prompt('sess-refused'), deps(refuses, payer(fake)));
    expect(systemMessageOf(answer)).toContain('the routing payment failed');
    expect(systemMessageOf(answer)).toContain('`tenjin doctor`');
  });

  it('keeps a paid voucher call that gets no answer inside the gate budget', async () => {
    const fake = new FakeRouter();
    const p = payer(fake);
    // The first call deposits; the next is a plain voucher.
    await runPromptHook(prompt(), deps(fake.fetch, p));
    const hang = paidHangs(fake);
    holdTime();
    const started = Date.now();
    const call = runPromptHook(prompt(), { ...deps(fake.fetch, p), fetchImpl: hang.fetchImpl });
    await hang.sent;
    await vi.advanceTimersByTimeAsync(GATE_TIMEOUT_MS);
    await call;
    expect(Date.now() - started).toBeLessThan(GATE_TIMEOUT_MS + 500);
    expect(hang.paid()).toBe(1);
  });

  it('returns an inline deposit call that gets no answer inside the gate budget, and counts the deposit', async () => {
    await noWarm();
    holdTime();
    vi.setSystemTime(NOW);
    const fake = new FakeRouter();
    const p = payer(fake);
    const hang = paidHangs(fake);
    const started = Date.now();
    let returned = false;
    const call = runPromptHook(prompt(), {
      ...deps(fake.fetch, p),
      fetchImpl: hang.fetchImpl,
    }).then(() => {
      returned = true;
    });
    await hang.sent;
    await vi.advanceTimersByTimeAsync(DEPOSIT_GATE_TIMEOUT_MS - 1);
    expect(returned).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await call;
    expect(Date.now() - started).toBe(DEPOSIT_GATE_TIMEOUT_MS);
    expect(hang.paid()).toBe(1);
    // It went out and no answer came, so it may have landed: it counts.
    expect(await readSpendSummary(dir)).toMatchObject({ committedAtomic: '50000' });
  });
});

/**
 * WALLET NOTICES, once per (session, reason), with a clear line (decision 15).
 * They go in `systemMessage`, which the person reads, so they carry the PERSON
 * fix, never the model's `agentFix`.
 */
describe('wallet notices', () => {
  /** A signer that fails with `reason` while `state.reason` is set, else signs. */
  function switchable(state: { reason: UnlockReason | 'abort' | null }) {
    return {
      getSigner: async () => {
        const reason = state.reason;
        if (reason === null) return testSigner(wallet);
        if (reason === 'abort') throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        throw new CliError('PROVIDER_ERROR', 'cannot unlock', { details: unlockDetails(reason) });
      },
    };
  }

  it('tells a second notice when the reason changes, and none for the same reason', async () => {
    const fake = new FakeRouter();
    const state: { reason: UnlockReason | 'abort' | null } = { reason: 'keychain_locked' };
    const p = payer(fake, switchable(state));
    const first = await runHookKind('prompt', prompt(), deps(fake.fetch, p));
    expect(systemMessageOf(first)).toContain(WALLET_REASONS.keychain_locked.reason);
    expect(systemMessageOf(first)).toContain(KEYCHAIN_LOCKED_FIX);
    expect(systemMessageOf(first)).not.toContain('--insecure-storage');
    const again = await runHookKind('prompt', prompt(), deps(fake.fetch, p));
    expect(systemMessageOf(again)).toBeUndefined();
    state.reason = 'passphrase_missing';
    const changed = await runHookKind('prompt', prompt(), deps(fake.fetch, p));
    expect(systemMessageOf(changed)).toContain(WALLET_REASONS.passphrase_missing.reason);
    // The person's fix, with the clause; never the model's.
    expect(systemMessageOf(changed)).toContain(REPAIR_CLAUSE);
    expect(systemMessageOf(changed)).not.toContain(ASK_FOR_REPAIR);
    expect(systemMessageOf(changed)).not.toContain('TENJIN_WALLET_PASSPHRASE=');
    const repeat = await runHookKind('prompt', prompt(), deps(fake.fetch, p));
    expect(systemMessageOf(repeat)).toBeUndefined();
  });

  it('says the wallet is unlocked once, after a paid decided call', async () => {
    const fake = new FakeRouter();
    const state: { reason: UnlockReason | 'abort' | null } = { reason: 'keychain_locked' };
    const p = payer(fake, switchable(state));
    const locked = await runHookKind('prompt', prompt(), deps(fake.fetch, p));
    expect(systemMessageOf(locked)).toContain(KEYCHAIN_LOCKED_FIX);
    state.reason = null;
    const paid = await runHookKind('prompt', prompt(), deps(fake.fetch, p));
    expect(fake.paidRequests()).toBeGreaterThan(0);
    expect(systemMessageOf(paid)?.split('\n')).toContain(WALLET_UNLOCKED);
    const next = await runHookKind('prompt', prompt(), deps(fake.fetch, p));
    expect(systemMessageOf(next)).toBeUndefined();
  });

  it('says nothing about funding before the facilitator answers', async () => {
    const fake = new FakeRouter();
    const p = payer(fake);
    const answer = await runHookKind('prompt', prompt(), deps(fake.fetch, p));
    expect(systemMessageOf(answer)).not.toContain('tenjin fund');
    expect(fake.paidRequests()).toBeGreaterThan(0);
  });

  it('skips as wallet_low before sending a deposit that would consume the reserve', async () => {
    const fake = new FakeRouter();
    fake.walletAtomic = 2_000n;
    const answer = await runHookKind('prompt', prompt(), deps(fake.fetch, payer(fake)));
    // The deposit-only balance read refuses before signing.
    expect(fake.paidRequests()).toBe(0);
    expect(fake.deposits).toBe(0);
    expect(systemMessageOf(answer)).toContain('could not pay');
    expect(systemMessageOf(answer)).toContain('Your usual tools still work.');
    expect(systemMessageOf(answer)).not.toContain('tenjin fund');
  });

  it('says the wallet is funded once, after a paid call that wallet_low held back', async () => {
    const fake = new FakeRouter();
    fake.walletAtomic = 2_000n;
    let clock = NOW;
    const p = payer(fake, { now: () => clock });
    const low = await runHookKind('prompt', prompt(), deps(fake.fetch, p));
    expect(systemMessageOf(low)).toContain('could not pay');
    expect(systemMessageOf(low)).toContain('Your usual tools still work.');
    expect(systemMessageOf(low)).not.toContain('tenjin fund');
    fake.walletAtomic = 10_000_000n;
    // The balance is read only by the next top-up, once the refused one's
    // backoff ends: then the prompt pays, and the funding is said once.
    clock += WALLET_LOW_BACKOFF_MS[0]!;
    const paid = await runHookKind('prompt', prompt(), deps(fake.fetch, p));
    expect(systemMessageOf(paid)?.split('\n')).toContain(WALLET_FUNDED);
    expect(systemMessageOf(paid)).toContain('Tenjin set aside $0.05 for routing fees.');
  });

  it('says nothing for an unlock that ran out of time', async () => {
    const fake = new FakeRouter();
    const p = payer(fake, switchable({ reason: 'abort' }));
    const answer = await runHookKind('prompt', prompt(), deps(fake.fetch, p));
    expect(systemMessageOf(answer)).toBeUndefined();
  });
});
