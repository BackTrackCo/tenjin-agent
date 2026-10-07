import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GATE_TIMEOUT_MS } from './gate';
import { runHookCommand, runHookKind } from './hook-command';
import { runPromptHook, type HookDeps } from './hooks';
import { ROUTING_FEE_ATOMIC } from './fee';
import { CliError } from '../lib/errors';
import { FakeRouter, payerDeps } from './fee-test-utils';
import { RoutingPayer } from './routing-payer';
import { readSpendSummary } from '../lib/wallet/spend';

/**
 * The hook legs on each side of the routing fee: inside `tenjin mcp` (which
 * passes its payer as `route`) the stock SDK client pays on the paid path; the
 * command form (`tenjin hook`) is always the free path.
 */

const BASE = 'https://router.test';
const NOW = 1_800_000_000_000;
const NATIVE = {
  schemaVersion: 1,
  routerVersion: 'v',
  decision: {
    action: 'native',
    diagnostics: { reasonCode: 'native', stage: 'gate', missing: [], nextAction: 'native' },
  },
};
/** The free path's answer once the server routes only paid calls. */
const FEE_REQUIRED_ANSWER = {
  schemaVersion: 1,
  routerVersion: 'v',
  decision: {
    action: 'native',
    reason:
      'Tenjin routing needs a newer tenjin-cli. Tell the user to run `npm i -g tenjin-cli@latest`.',
    diagnostics: {
      reasonCode: 'fee_required',
      stage: 'capability',
      missing: [],
      nextAction: 'Update tenjin-cli (run `npm i -g tenjin-cli@latest`).',
    },
  },
};
/** A free router's offer. */
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
const wallet = privateKeyToAccount(generatePrivateKey());

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'router-hooks-fee-'));
  await mkdir(join(dir, '.git'));
  // What `tenjin install` writes, so the fixture's offer clears the spend vet.
  await writeFile(
    join(dir, 'config.json'),
    JSON.stringify({ maxAutoSpend: '250000', sessionBudget: '5000000' }),
  );
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A free router: every call answers `body` (native), and records what it was sent. */
function router(body: unknown = NATIVE): {
  fetchImpl: typeof fetch;
  calls: { url: string; signature: string | null }[];
} {
  const calls: { url: string; signature: string | null }[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({
      url: String(input),
      signature: new Headers(init?.headers).get('payment-signature'),
    });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
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
    ...(p !== undefined ? { route: p.routeFor.bind(p) } : {}),
  };
}

/** A full garbage collection, without starting Node with `--expose-gc`. */
function collectGarbage(): void {
  setFlagsFromString('--expose-gc');
  (runInNewContext('gc') as () => void)();
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
  it('takes the free path in the command form', async () => {
    const { fetchImpl, calls } = router();
    let out = '';
    await runHookCommand(
      'prompt',
      { stdout: { write: (s: string) => ((out += s), true) } } as never,
      { ...deps(fetchImpl), readEvent: async () => JSON.stringify(prompt()) },
    );
    expect(calls).toEqual([{ url: `${BASE}/api/x402-router`, signature: null }]);
    expect(out).toBe('');
  });

  it('pays the routing fee through the payer: an inline deposit, then vouchers', async () => {
    const fake = new FakeRouter();
    const p = payer(fake);
    await runPromptHook(prompt(), deps(fake.fetch, p));
    await runPromptHook(prompt(), deps(fake.fetch, p));
    expect(fake.log).toEqual([
      'POST /api/x402-router/route unpaid',
      'POST /api/x402-router/route paid',
      'POST /api/x402-router/route unpaid',
      'POST /api/x402-router/route paid',
    ]);
    expect(fake.deposits).toBe(1);
    expect([...fake.channels.values()][0]!.charged).toBe(2n * ROUTING_FEE_ATOMIC);
  });

  it("takes the free path, and says nothing, when another session's call holds the channel", async () => {
    const fake = new FakeRouter();
    await runPromptHook(prompt(), deps(fake.fetch, payer(fake)));
    fake.delayMs = 200;
    const answers = await Promise.all([
      runHookKind('prompt', prompt('sess-a'), deps(fake.fetch, payer(fake))),
      runHookKind('prompt', prompt('sess-b'), deps(fake.fetch, payer(fake))),
    ]);
    expect(fake.log.filter((l) => l === 'POST /api/x402-router unpaid')).toHaveLength(1);
    expect(fake.settledFees).toBe(2);
    // Native answers and nothing for the user: a busy channel is no fault.
    expect(answers).toEqual([null, null]);
  });

  it.each([
    [
      'the wallet holds less than the deposit',
      { walletBalance: async () => 50_000n },
      '`tenjin wallet fund 0.25`',
    ],
    [
      'the wallet cannot be unlocked',
      {
        getSigner: async () => {
          throw new Error('passphrase needed');
        },
      },
      'TENJIN_WALLET_PASSPHRASE',
    ],
    [
      'the machine has no wallet',
      {
        getSigner: async () => {
          throw new CliError('WALLET_MISSING', 'no wallet');
        },
      },
      '`tenjin doctor`',
    ],
    [
      'the daily budget has no room for the deposit',
      {
        policy: async () => ({
          maxAutoSpendAtomic: 250_000n,
          sessionBudgetAtomic: 100_000n,
          allowlistCreators: [],
        }),
      },
      '`tenjin doctor`',
    ],
  ])(
    'routes on the free path when %s, and tells the user once per session',
    async (_label, opts, fix) => {
      const fake = new FakeRouter();
      fake.body = OFFER;
      const p = payer(fake, opts);
      const first = await runHookKind('prompt', prompt(), deps(fake.fetch, p));
      // The free path's offer still reaches the model.
      expect(contextOf(first)).toContain('CoinMarketCap fits this');
      expect(systemMessageOf(first)).toContain('could not pay its $0.003 fee');
      expect(systemMessageOf(first)).toContain(fix);
      expect(fake.paidRequests()).toBe(0);
      expect(fake.log.at(-1)).toBe('POST /api/x402-router unpaid');
      // Not again in this session, though the free path keeps routing.
      const second = await runHookKind('prompt', prompt(), deps(fake.fetch, p));
      expect(contextOf(second)).toContain('CoinMarketCap fits this');
      expect(systemMessageOf(second)).toBeUndefined();
      // A new session is told once too.
      const other = await runHookKind('prompt', prompt('sess-2'), deps(fake.fetch, p));
      expect(systemMessageOf(other)).toContain(fix);
    },
  );

  it.each([
    ['no wallet', () => new CliError('WALLET_MISSING', 'no wallet')],
    ['a wallet it cannot unlock', () => new Error('passphrase needed')],
  ])('says nothing about a fee that is off, on a machine with %s', async (_label, error) => {
    const fake = new FakeRouter({ paid: false });
    fake.body = OFFER;
    const p = payer(fake, {
      getSigner: async () => {
        throw error();
      },
    });
    for (let i = 0; i < 2; i += 1) {
      const answer = await runHookKind('prompt', prompt(), deps(fake.fetch, p));
      expect(contextOf(answer)).toContain('CoinMarketCap fits this');
      expect(systemMessageOf(answer)).toBeUndefined();
    }
    // Asked once, then the free path alone for the hour.
    expect(fake.log).toEqual([
      'POST /api/x402-router/route unpaid',
      'POST /api/x402-router unpaid',
      'POST /api/x402-router unpaid',
    ]);
  });

  it('takes the free path when the payment fails, and names doctor', async () => {
    const fake = new FakeRouter();
    const p = payer(fake);
    const fails = paidFails(fake);
    const answer = await runHookKind('prompt', prompt('sess-fails'), deps(fails, p));
    // The 402, the paid request that failed (answered before the fake saw it),
    // then the free path.
    expect(fake.log).toEqual([
      'POST /api/x402-router/route unpaid',
      'POST /api/x402-router unpaid',
    ]);
    expect(systemMessageOf(answer)).toContain('the routing payment failed');
    expect(systemMessageOf(answer)).toContain('`tenjin doctor`');
    // The deposit the server refused is released, not counted.
    expect((await readSpendSummary(dir))?.committedAtomic ?? '0').toBe('0');
  });

  it('says once when the free path answers fee_required and nothing could pay, in the command form too', async () => {
    const { fetchImpl } = router(FEE_REQUIRED_ANSWER);
    let out = '';
    const io = { stdout: { write: (line: string) => ((out += line), true) } } as never;
    await runHookCommand('prompt', io, {
      ...deps(fetchImpl),
      readEvent: async () => JSON.stringify(prompt('sess-codex')),
    });
    const said = JSON.parse(out) as { systemMessage?: string };
    expect(said.systemMessage).toContain('the router now charges it');
    expect(said.systemMessage).toContain('`tenjin doctor`');
    expect(JSON.stringify(said)).not.toContain('npm i -g');
    out = '';
    await runHookCommand('prompt', io, {
      ...deps(fetchImpl),
      readEvent: async () => JSON.stringify(prompt('sess-codex')),
    });
    expect(out).toBe('');
  });

  /**
   * `fake`, except that a request carrying a payment never answers until the
   * signal it was sent with aborts, the way a real transport ends it. A full
   * garbage collection runs while it waits: a budget that reached the request
   * only through Request copies was lost there about half the time.
   */
  function paidHangs(fake: FakeRouter): { fetchImpl: typeof fetch; paid: () => number } {
    let paid = 0;
    const fetchImpl = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init);
      if (!request.headers.has('payment-signature')) return fake.fetch(request);
      paid += 1;
      const signal = init?.signal ?? request.signal;
      setTimeout(collectGarbage, 50);
      return new Promise<Response>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        signal.addEventListener('abort', () => reject(signal.reason));
      });
    }) as typeof fetch;
    return { fetchImpl, paid: () => paid };
  }

  it('keeps a paid voucher call that gets no answer inside the gate budget', async () => {
    const fake = new FakeRouter();
    const p = payer(fake);
    // The first call deposits; the next is a plain voucher.
    await runPromptHook(prompt(), deps(fake.fetch, p));
    const hang = paidHangs(fake);
    const started = Date.now();
    await runPromptHook(prompt(), { ...deps(fake.fetch, p), fetchImpl: hang.fetchImpl });
    expect(Date.now() - started).toBeLessThan(GATE_TIMEOUT_MS + 500);
    expect(hang.paid()).toBe(1);
  }, 15_000);

  it('returns a deposit call that gets no answer inside the gate budget, and counts the deposit', async () => {
    const fake = new FakeRouter();
    const p = payer(fake);
    const hang = paidHangs(fake);
    const started = Date.now();
    await runPromptHook(prompt(), { ...deps(fake.fetch, p), fetchImpl: hang.fetchImpl });
    expect(Date.now() - started).toBeLessThan(GATE_TIMEOUT_MS + 500);
    expect(hang.paid()).toBe(1);
    // It went out and no answer came, so it may have landed: it counts.
    expect(await readSpendSummary(dir)).toMatchObject({ committedAtomic: '250000' });
  }, 15_000);
});
