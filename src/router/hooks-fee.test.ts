import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GATE_TIMEOUT_MS } from './gate';
import { runHookCommand, runHookKind } from './hook-command';
import { runAnswerHook, runPromptHook, type HookDeps } from './hooks';
import { pausedReason, ROUTING_FEE_ATOMIC, writeFeeState } from './fee-state';
import { FakeRouter, payerDeps } from './fee-test-utils';
import { RoutingPayer } from './routing-payer';
import { readSpendSummary } from '../lib/wallet/spend';

/**
 * The hook legs on each side of the routing fee: the free path until the fee
 * is approved and the leg runs inside `tenjin mcp` (which passes its payer as
 * `route`), the stock SDK client on the paid path, no call at all when the
 * payer cannot pay, and one paused-routing line per session. The command form
 * (`tenjin hook`) is always the free path.
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
const wallet = privateKeyToAccount(generatePrivateKey());

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'router-hooks-fee-'));
  await mkdir(join(dir, '.git'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function config(value: Record<string, unknown>): Promise<void> {
  await writeFile(join(dir, 'config.json'), JSON.stringify(value));
}

/** A free router's offer, the answer the papercut was about. */
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

function contextOf(response: unknown): string | undefined {
  return (response as { hookSpecificOutput?: { additionalContext?: string } } | null)
    ?.hookSpecificOutput?.additionalContext;
}

describe('the hook legs and the routing fee', () => {
  it('takes the free path in the command form even when the fee is approved', async () => {
    await config({ routingFee: 'approved' });
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

  it('takes the free path inside tenjin mcp until the fee is approved', async () => {
    const fake = new FakeRouter();
    const outcome = await runPromptHook(prompt(), deps(fake.fetch, payer(fake)));
    expect(fake.log).toEqual(['POST /api/x402-router unpaid']);
    expect(outcome.response).toBeNull();
  });

  it('pays the routing fee through the payer once approved: an inline deposit, then vouchers', async () => {
    await config({ routingFee: 'approved' });
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
    await config({ routingFee: 'approved' });
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

  it('routes on the free path without approval and says nothing of a pause, with the paid path known', async () => {
    await config({ maxAutoSpend: '250000', sessionBudget: '5000000' });
    await writeFeeState(dir, { paidPath: 'available', checkedAtMs: NOW });
    const { fetchImpl, calls } = router(OFFER);
    const first = await runPromptHook(prompt(), deps(fetchImpl));
    expect(calls[0]).toEqual({ url: `${BASE}/api/x402-router`, signature: null });
    expect(contextOf(first.response)).toContain('CoinMarketCap fits this');
    expect(contextOf(first.response)).not.toContain('paused');
    expect(await pausedReason(dir, false)).toBeNull();
  });

  it('says once per session that routing is paused once the free path answers fee_required', async () => {
    await writeFeeState(dir, { paidPath: 'available', checkedAtMs: NOW });
    const { fetchImpl } = router(FEE_REQUIRED_ANSWER);
    const first = await runPromptHook(prompt(), deps(fetchImpl));
    expect(contextOf(first.response)).toContain('routing is paused');
    expect(contextOf(first.response)).toContain('`tenjin config set routingFee approved`');
    const second = await runPromptHook(prompt(), deps(fetchImpl));
    expect(second.response).toBeNull();
    const otherSession = await runPromptHook(prompt('sess-2'), deps(fetchImpl));
    expect(contextOf(otherSession.response)).toContain('`tenjin config set routingFee approved`');
  });

  it('names the approval command from the first fee_required answer, with no paid path known', async () => {
    const calls: string[] = [];
    let required = true;
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      calls.push(String(input));
      return new Response(JSON.stringify(required ? FEE_REQUIRED_ANSWER : NATIVE), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const first = await runPromptHook(prompt(), deps(fetchImpl));
    expect(calls).toEqual([`${BASE}/api/x402-router`]);
    expect(contextOf(first.response)).toContain('`tenjin config set routingFee approved`');
    expect(contextOf(first.response)).not.toContain('npm i -g');
    expect((await runPromptHook(prompt(), deps(fetchImpl))).response).toBeNull();
    // The free path routing again lifts the pause.
    required = false;
    await runPromptHook(prompt(), deps(fetchImpl));
    expect(await pausedReason(dir, false)).toBeNull();
  });

  it('says once per session when the wallet cannot fund a deposit, with the amount, and sends nothing paid', async () => {
    await config({ routingFee: 'approved' });
    const fake = new FakeRouter();
    const p = payer(fake, { walletBalance: async () => 50_000n });
    const first = await runPromptHook(prompt(), deps(fake.fetch, p));
    expect(contextOf(first.response)).toContain('`tenjin wallet fund 0.20`');
    expect(fake.paidRequests()).toBe(0);
    expect((await runPromptHook(prompt(), deps(fake.fetch, p))).response).toBeNull();
  });

  it('says once per session when tenjin mcp cannot unlock the wallet, naming the variable', async () => {
    await config({ routingFee: 'approved' });
    await writeFeeState(dir, { paidPath: 'available', checkedAtMs: NOW });
    const fake = new FakeRouter();
    const p = payer(fake, {
      getSigner: async () => {
        throw new Error('passphrase needed');
      },
    });
    const first = await runPromptHook(prompt(), deps(fake.fetch, p));
    expect(contextOf(first.response)).toContain('TENJIN_WALLET_PASSPHRASE');
    expect(fake.paidRequests()).toBe(0);
    expect((await runPromptHook(prompt(), deps(fake.fetch, p))).response).toBeNull();
  });

  /** `fake`, except that a request carrying a payment never answers. */
  function paidHangs(fake: FakeRouter): { fetchImpl: typeof fetch; paid: () => number } {
    let paid = 0;
    const fetchImpl = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init);
      if (!request.headers.has('payment-signature')) return fake.fetch(request);
      paid += 1;
      return new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(request.signal.reason));
      });
    }) as typeof fetch;
    return { fetchImpl, paid: () => paid };
  }

  it('keeps a paid voucher call that gets no answer inside the gate budget', async () => {
    await config({ routingFee: 'approved' });
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
    await config({ routingFee: 'approved' });
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

  it('keeps the paused-routing line off the answer hook', async () => {
    const { fetchImpl, calls } = router(FEE_REQUIRED_ANSWER);
    const answered = await runAnswerHook(
      {
        hook_event_name: 'PostToolUse',
        session_id: 'sess-answer',
        cwd: dir,
        tool_name: 'AskUserQuestion',
        tool_input: { questions: [{ question: 'Which coin?', options: [] }] },
        tool_response: { answers: { 'Which coin?': 'ETH, price in USD now' } },
      },
      deps(fetchImpl),
    );
    // It did route the answer, and said nothing about the pause.
    expect(calls).toHaveLength(1);
    expect(answered).toEqual({ response: null, action: 'native' });
    // The session's prompt hook still carries it, once.
    const prompted = await runPromptHook(prompt('sess-answer'), deps(fetchImpl));
    expect(contextOf(prompted.response)).toContain('routing is paused');
  });
});
