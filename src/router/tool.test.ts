import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPaymentRequired, testWalletProvider } from '../lib/read-test-utils';
import { resolveSpendAuthorizer } from '../lib/wallet';
import type { SpendAuthorization, SpendAuthorizer } from '../lib/wallet';
import type { CommandContext } from '../context';
import { runPay } from '../commands/pay';
import { runRequestTool } from './tool';
import { ROUTER_PATH } from './decision';
import {
  bindDecision,
  noteRedirect,
  noteSession,
  renderProgress,
  takeUndelivered,
} from './progress';

// Pass-through, so a refusal's typed details stay observable after the tool
// folds the error into its envelope.
vi.mock('../commands/pay', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../commands/pay')>();
  return { ...actual, runPay: vi.fn(actual.runPay) };
});

/**
 * The `request` tool after the fee: ONE free decision, then ONE payment, to the
 * provider. The id is the fast path and the query is always sent, so every test
 * here is about which decision ran, what it cost, and what the host is told.
 */

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'router-tool-'));
  // Its own git root: `router.*` resolves from here, never from the suite's cwd.
  await mkdir(join(dir, '.git'));
  await writeFile(
    join(dir, 'config.json'),
    JSON.stringify({ maxAutoSpend: '250000', sessionBudget: '5000000' }),
  );
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ROUTER = 'https://tenjin.sh';
const PROVIDER = 'https://pro-api.example.test/x402/v3/quotes';

function ctx(): CommandContext {
  const sink = () => ({ write: () => true }) as unknown as NodeJS.WritableStream;
  return {
    flags: { json: true, timeout: 5000, baseUrl: ROUTER },
    dataDir: dir,
    io: { stdout: sink(), stderr: sink(), isTTY: false },
  };
}

function authorizer(decision: SpendAuthorization['decision'] = 'allow'): SpendAuthorizer {
  return {
    policyEnforcement: 'client-only',
    authorize: vi.fn(async (req): Promise<SpendAuthorization> => ({
      decision,
      reason: decision === 'allow' ? 'within_policy' : 'confirm_always',
      message: 'test',
      amountAtomic: req.amountAtomic,
      sessionSpentAtomic: 0n,
      sessionBudgetAtomic: 0n,
      policyEnforcement: 'client-only',
      reservationId: 'rsv',
    })),
    commit: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
  };
}

function contract(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    arguments: { symbol: 'BTC,ETH', convert: 'USD' },
    request: {
      url: `${PROVIDER}?symbol=BTC%2CETH&convert=USD`,
      method: 'GET',
      headers: { accept: 'application/json' },
    },
    ...over,
  };
}

function decision(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    routerVersion: '2026-09-23.1',
    decision: {
      action: 'execute',
      capabilityId: 'cmc-quotes',
      category: 'crypto price quote',
      provider: 'CoinMarketCap',
      capabilityDescription: 'latest market quotes for one or more cryptocurrencies',
      providerPriceAtomic: '10000',
      contract: contract(),
      ...over,
    },
  };
}

const NATIVE = {
  schemaVersion: 1,
  routerVersion: 'v',
  decision: {
    action: 'native',
    reason: 'Your own tools cover this.',
    diagnostics: {
      reasonCode: 'native_sufficient',
      stage: 'capability',
      missing: [],
      nextAction: '',
    },
  },
};

interface Leg {
  url: string;
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** A scripted network: legs are matched in order, and every request recorded. */
function net(legs: Leg[]): {
  fetchImpl: typeof fetch;
  calls: { url: string; method: string; paid: boolean }[];
} {
  const calls: { url: string; method: string; paid: boolean }[] = [];
  const queue = [...legs];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? {}).forEach((v, k) => {
      headers[k] = v;
    });
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      paid: headers['payment-signature'] !== undefined,
    });
    const leg = queue.shift();
    if (leg === undefined) throw new Error(`unscripted request to ${String(input)}`);
    return new Response(JSON.stringify(leg.body), {
      status: leg.status,
      headers: { 'content-type': 'application/json', ...leg.headers },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function challenge(over: Record<string, unknown> = {}): string {
  return buildPaymentRequired({ amount: '10000', ...over }).header;
}

const PUBLIC = { resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }] };

function deps(fetchImpl: typeof fetch, auth = authorizer()) {
  return {
    ctx: ctx(),
    cwd: dir,
    authorizer: auth,
    fetchImpl,
    payDeps: {
      readBalance: async () => 100_000_000n,
      fetchImpl,
      provider: testWalletProvider(),
      authorizer: auth,
      destination: PUBLIC,
    },
  };
}

/** The provider leg: a 402, then the paid 200. */
function providerLegs(body: unknown = { data: { BTC: 1 } }): Leg[] {
  return [
    { url: PROVIDER, status: 402, body: {}, headers: { 'PAYMENT-REQUIRED': challenge() } },
    { url: PROVIDER, status: 200, body },
  ];
}

describe('the request tool, one decision and one payment per lookup', () => {
  it('sends the query and the turn id, and pays the provider once', async () => {
    const { fetchImpl, calls } = net([
      { url: ROUTER, status: 200, body: decision() },
      ...providerLegs(),
    ]);
    const result = await runRequestTool(
      { query: 'BTC and ETH price', id: 'k3f9-abcd' },
      deps(fetchImpl),
    );

    expect(result.isError).toBe(false);
    expect(result.envelope).toMatchObject({
      status: 'fulfilled',
      // ONE cost line: the decision took nothing.
      cost: ['provider price 0.01 USD'],
    });
    // One decision call, no fetch by id and nothing waited for.
    expect(calls).toHaveLength(3);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toBe(`${ROUTER}${ROUTER_PATH}`);
    expect(calls.filter((c) => c.paid)).toHaveLength(1);
  });

  it('works the same with no id at all', async () => {
    const { fetchImpl, calls } = net([
      { url: ROUTER, status: 200, body: decision() },
      ...providerLegs(),
    ]);
    const result = await runRequestTool({ query: 'BTC and ETH price' }, deps(fetchImpl));
    expect(result.envelope).toMatchObject({ status: 'fulfilled' });
    expect(calls).toHaveLength(3);
  });

  /**
   * AN ID THE BACKEND DOES NOT KNOW IS THE BACKEND'S NOTE. Expired, foreign,
   * invented: the decision still runs from the query, and whatever the backend
   * says about the id arrives as its ordinary answer.
   */
  it('still decides from the query when the id means nothing to the backend', async () => {
    const { fetchImpl, calls } = net([
      { url: ROUTER, status: 200, body: decision() },
      ...providerLegs(),
    ]);
    const result = await runRequestTool(
      { query: 'BTC and ETH price', id: 'from-a-web-page' },
      deps(fetchImpl),
    );
    expect(result.envelope).toMatchObject({ status: 'fulfilled' });
    expect(calls).toHaveLength(3);
  });

  it('sends nothing, and pays nothing, for a query carrying a credential', async () => {
    const auth = authorizer();
    const { fetchImpl, calls } = net([{ url: ROUTER, status: 200, body: decision() }]);
    const result = await runRequestTool(
      { query: 'https://api.acme.io/v1/items?api-key=Zx81QpLm0aTe', id: 'k3f9-abcd' },
      deps(fetchImpl, auth),
    );
    expect(result.envelope).toMatchObject({
      status: 'native',
      reason: 'the query carries a credential-shaped value, so nothing was sent',
    });
    expect(calls).toHaveLength(0);
    expect(auth.authorize).not.toHaveBeenCalled();
  });

  it('needs a query at all, before anything is decided', async () => {
    const { fetchImpl, calls } = net([]);
    const result = await runRequestTool({ query: '   ' }, deps(fetchImpl));
    expect(result.envelope).toMatchObject({ status: 'needs_input' });
    expect(calls).toHaveLength(0);
  });
});

describe('routing outcomes that buy nothing', () => {
  it('returns native as a normal result with its next step and no cost', async () => {
    const { fetchImpl, calls } = net([{ url: ROUTER, status: 200, body: NATIVE }]);
    const result = await runRequestTool({ query: 'what is the weather' }, deps(fetchImpl));
    expect(result.isError).toBe(false);
    expect(result.envelope).toMatchObject({
      status: 'native',
      cost: ['provider price 0 USD'],
    });
    expect(String(result.envelope.nextStep)).toContain('Continue with your own tools');
    expect(calls).toHaveLength(1);
  });

  it('carries the backend diagnostics into a needs_input result', async () => {
    const { fetchImpl } = net([
      {
        url: ROUTER,
        status: 200,
        body: {
          schemaVersion: 1,
          routerVersion: 'v',
          decision: {
            action: 'needs_input',
            reason: 'Name the company to enrich.',
            diagnostics: {
              reasonCode: 'missing_required_argument',
              stage: 'bind',
              missing: ['company_domain'],
              nextAction: 'Ask the user for the company domain, then call request again.',
            },
          },
        },
      },
    ]);
    const result = await runRequestTool({ query: 'enrich them' }, deps(fetchImpl));
    expect(result.isError).toBe(false);
    expect(result.envelope).toMatchObject({
      status: 'needs_input',
      reasonCode: 'missing_required_argument',
      stage: 'bind',
      missing: ['company_domain'],
      nextStep: 'Ask the user for the company domain, then call request again.',
    });
  });

  it('surfaces a typed refusal from the decision endpoint as an error with its code', async () => {
    const { fetchImpl } = net([
      {
        url: ROUTER,
        status: 400,
        body: { error: { code: 'packet_too_large', message: 'over the bound' } },
      },
    ]);
    const result = await runRequestTool({ query: 'q' }, deps(fetchImpl));
    expect(result.isError).toBe(true);
    expect(result.envelope).toMatchObject({ status: 'failed', errorCode: 'packet_too_large' });
  });
});

/**
 * THE PROVIDER'S OWN WORDS REACH THE MODEL. A free docs lookup that matched no
 * library answers 404 with `{error: {message}}` telling the agent to use its
 * own tools; a bare "answered 404 ... then retry" sent it straight back to the
 * same call.
 */
describe('a provider that refuses the lookup', () => {
  const DOCS = decision({
    providerPriceAtomic: '0',
    category: 'library or API documentation',
    provider: 'Context7',
  });
  const MESSAGE = 'No indexed library matched this question. Use your own tools.';

  it("shows the provider's message on a 404 with a JSON error body, and no retry", async () => {
    const { fetchImpl, calls } = net([
      { url: ROUTER, status: 200, body: DOCS },
      {
        url: PROVIDER,
        status: 404,
        body: { error: { code: 'no_documentation_found', message: MESSAGE } },
      },
    ]);
    const result = await runRequestTool(
      { query: '@acme/billing-sdk createInvoice' },
      deps(fetchImpl),
    );
    expect(result.isError).toBe(true);
    expect(result.envelope.status).toBe('failed');
    const reason = String(result.envelope.reason);
    expect(reason).toContain(`answered 404: ${MESSAGE}`);
    expect(reason).not.toMatch(/retry/i);
    expect(result.summary).toContain(MESSAGE);
    expect(calls.some((call) => call.paid)).toBe(false);
  });

  it('keeps the plain status line, and its retry, for a 5xx with no message', async () => {
    const { fetchImpl } = net([
      { url: ROUTER, status: 200, body: DOCS },
      { url: PROVIDER, status: 502, body: { error: 'bad gateway' } },
    ]);
    const result = await runRequestTool({ query: 'zod v4 coerce' }, deps(fetchImpl));
    expect(String(result.envelope.reason)).toMatch(/answered 502\. .*then retry\.$/);
  });

  it('bounds the message and keeps it to one plain line', async () => {
    const { fetchImpl } = net([
      { url: ROUTER, status: 200, body: DOCS },
      {
        url: PROVIDER,
        status: 503,
        body: { error: { message: `Unavailable\u001b[2J\n${'x'.repeat(1_000)}` } },
      },
    ]);
    const result = await runRequestTool({ query: 'zod v4 coerce' }, deps(fetchImpl));
    const reason = String(result.envelope.reason);
    expect(reason).toContain('answered 503: Unavailable [2J xxx');
    expect(reason).not.toMatch(/\p{Cc}/u);
    expect(reason.length).toBeLessThan(600);
  });
});

describe('what the tool refuses to execute', () => {
  it.each([
    [
      'a method this build does not execute',
      contract({ request: { url: PROVIDER, method: 'DELETE', headers: {} } }),
    ],
    [
      'a header this build will not send',
      contract({
        request: { url: PROVIDER, method: 'GET', headers: { authorization: 'Bearer x' } },
      }),
    ],
    [
      'a URL this build cannot parse',
      contract({ request: { url: 'not a url', method: 'GET', headers: {} } }),
    ],
  ])('refuses %s, paying nothing', async (_label, bad) => {
    const { fetchImpl, calls } = net([
      { url: ROUTER, status: 200, body: decision({ contract: bad }) },
    ]);
    const result = await runRequestTool({ query: 'q' }, deps(fetchImpl));
    expect(result.envelope).toMatchObject({ status: 'failed' });
    expect(calls).toHaveLength(1);
  });

  it('refuses a live 402 above the advertised price before anything is signed', async () => {
    const auth = authorizer();
    const { fetchImpl, calls } = net([
      { url: ROUTER, status: 200, body: decision() },
      {
        url: PROVIDER,
        status: 402,
        body: {},
        headers: { 'PAYMENT-REQUIRED': challenge({ amount: '10001' }) },
      },
    ]);
    const result = await runRequestTool({ query: 'q' }, deps(fetchImpl, auth));
    expect(result.envelope).toMatchObject({ status: 'failed', cost: ['provider price 0 USD'] });
    expect(calls.filter((c) => c.paid)).toHaveLength(0);
    expect(auth.authorize).not.toHaveBeenCalled();
    await expect(vi.mocked(runPay).mock.results.at(-1)!.value).rejects.toMatchObject({
      code: 'REGISTRY_MISMATCH',
      details: { advertised: { maxAmountAtomic: '10000' }, live: { amount: '10001' } },
    });
  });

  /**
   * THE MONEY AUTHORITY: the amount actually signed meets the local policy. A
   * server can quote any price, so a live 402 within that quote still has to
   * fit the cap.
   */
  it('refuses at the spend gate when the live price is over the cap', async () => {
    const { fetchImpl } = net([
      { url: ROUTER, status: 200, body: decision({ providerPriceAtomic: '900000' }) },
      {
        url: PROVIDER,
        status: 402,
        body: {},
        headers: { 'PAYMENT-REQUIRED': challenge({ amount: '900000' }) },
      },
    ]);
    const real = {
      ctx: ctx(),
      cwd: dir,
      authorizer: resolveSpendAuthorizer(ctx(), {
        maxAutoSpendAtomic: 250_000n,
        sessionBudgetAtomic: 5_000_000n,

        allowlistCreators: [],
      }),
      fetchImpl,
      payDeps: {
        readBalance: async () => 100_000_000n,
        fetchImpl,
        provider: testWalletProvider(),
        destination: PUBLIC,
      },
    };
    const result = await runRequestTool({ query: 'q' }, real);
    expect(result.envelope).toMatchObject({ status: 'needs_approval' });
    expect(result.summary).toContain('Blocked by spending policy');
    expect(result.isError).toBe(false);
  });

  it('pays under the cap with no prompt at all', async () => {
    const { fetchImpl } = net([{ url: ROUTER, status: 200, body: decision() }, ...providerLegs()]);
    const real = {
      ctx: ctx(),
      cwd: dir,
      authorizer: resolveSpendAuthorizer(ctx(), {
        maxAutoSpendAtomic: 250_000n,
        sessionBudgetAtomic: 5_000_000n,

        allowlistCreators: [],
      }),
      fetchImpl,
      payDeps: {
        readBalance: async () => 100_000_000n,
        fetchImpl,
        provider: testWalletProvider(),
        destination: PUBLIC,
      },
    };
    const result = await runRequestTool({ query: 'q' }, real);
    expect(result.envelope).toMatchObject({ status: 'fulfilled' });
  });
});

describe('the paid body handed back to the model', () => {
  it('returns a large paid body whole: the harness, not this tool, files an oversized result', async () => {
    // Firecrawl-sized, with a multi-byte character throughout.
    const body = { markdown: 'é'.repeat(300_000) };
    const { fetchImpl } = net([
      { url: ROUTER, status: 200, body: decision() },
      ...providerLegs(body),
    ]);
    const result = await runRequestTool({ query: 'read the page' }, deps(fetchImpl));
    expect(result.envelope).toMatchObject({ status: 'fulfilled' });
    expect(result.envelope.result).toBe(JSON.stringify(body));
  });

  /**
   * A PAID BODY IS ALWAYS DELIVERED. The success rule flags it; it never
   * withholds what the money already bought.
   */
  const RULE = {
    type: 'object',
    properties: { data: { type: 'object' } },
    required: ['data'],
  };
  const withRule = () => ({
    ...decision(),
    decision: { ...(decision().decision as object), contract: contract({ resultSchema: RULE }) },
  });

  it('delivers a paid body that misses its success rule, unverified, naming the rule', async () => {
    const body = { error: 'rate limited' };
    const { fetchImpl } = net([
      { url: ROUTER, status: 200, body: withRule() },
      ...providerLegs(body),
    ]);
    const result = await runRequestTool({ query: 'q' }, deps(fetchImpl));
    expect(result.isError).toBe(true);
    expect(result.envelope).toMatchObject({
      status: 'unverified',
      result: JSON.stringify(body),
      cost: ['provider price 0.01 USD'],
    });
    expect(result.envelope.resultCaveat).toContain('does not satisfy its success schema');
    expect(result.envelope.resultCaveat).toContain('data');
  });

  it('delivers a paid body too large to check, unverified, as before', async () => {
    const body = { data: { blob: 'x'.repeat(200 * 1024) } };
    const { fetchImpl } = net([
      { url: ROUTER, status: 200, body: withRule() },
      ...providerLegs(body),
    ]);
    const result = await runRequestTool({ query: 'q' }, deps(fetchImpl));
    expect(result.envelope).toMatchObject({ status: 'unverified' });
    expect(result.envelope.resultCaveat).toContain('not checked');
  });

  it('fulfils a paid body that passes its success rule', async () => {
    const body = { data: { BTC: 1 } };
    const { fetchImpl } = net([
      { url: ROUTER, status: 200, body: withRule() },
      ...providerLegs(body),
    ]);
    const result = await runRequestTool({ query: 'q' }, deps(fetchImpl));
    expect(result.isError).toBe(false);
    expect(result.envelope).toMatchObject({ status: 'fulfilled', result: JSON.stringify(body) });
    expect(result.envelope.resultCaveat).toBeUndefined();
  });
});

describe('what the tool leaves for the status line', () => {
  it('shows the executed provider and its price, and returns the same envelope', async () => {
    await noteSession(dir, 'sess-1');
    await bindDecision(dir, 'sess-1', 'k3f9-abcd');
    const { fetchImpl } = net([{ url: ROUTER, status: 200, body: decision() }, ...providerLegs()]);

    const result = await runRequestTool(
      { query: 'BTC and ETH price', id: 'k3f9-abcd' },
      deps(fetchImpl),
    );

    expect(result.isError).toBe(false);
    expect(result.envelope).toMatchObject({
      status: 'fulfilled',
      cost: ['provider price 0.01 USD'],
    });
    expect(await renderProgress(dir, 'sess-1')).toBe(
      'x402 · request: fulfilled pro-api.example.test/x402/v3/quotes · {"symbol":"BTC,ETH","convert":"USD"} · $0.01',
    );
  });

  it('records a native decision as native, with nothing called and nothing paid', async () => {
    await noteSession(dir, 'sess-1');
    const { fetchImpl } = net([{ url: ROUTER, status: 200, body: NATIVE }]);

    const result = await runRequestTool({ query: 'what is 2 + 2' }, deps(fetchImpl));

    expect(result.envelope).toMatchObject({ status: 'native' });
    expect(await renderProgress(dir, 'sess-1')).toBe('x402 · request: native');
  });

  it('attributes nothing when two sessions are live and the call carries no id', async () => {
    await noteSession(dir, 'sess-1');
    await noteSession(dir, 'sess-2');
    const { fetchImpl } = net([{ url: ROUTER, status: 200, body: decision() }, ...providerLegs()]);

    const result = await runRequestTool({ query: 'BTC and ETH price' }, deps(fetchImpl));

    expect(result.isError).toBe(false);
    expect(await renderProgress(dir, 'sess-1')).toBe('x402 · ready');
    expect(await renderProgress(dir, 'sess-2')).toBe('x402 · ready');
  });
});

/**
 * NEVER BLOCKED TWICE IN A ROW, the tool's half: only a `fulfilled` lookup
 * delivers the pre-call redirect that named its id. Anything less leaves it
 * undelivered, and the hook withholds that agent's next offer in its category.
 */
describe('the redirect a lookup answers', () => {
  const CATEGORY = 'crypto price quote';
  const RULE = { type: 'object', properties: { data: { type: 'object' } }, required: ['data'] };
  it.each([
    ['fulfilled', [{ url: ROUTER, status: 200, body: decision() }, ...providerLegs()]],
    [
      'unverified',
      [
        {
          url: ROUTER,
          status: 200,
          body: decision({ contract: contract({ resultSchema: RULE }) }),
        },
        ...providerLegs({ error: 'rate limited' }),
      ],
    ],
    ['failed', [{ url: ROUTER, status: 503, body: { error: { code: 'nope', message: 'no' } } }]],
  ] as const)('is delivered only by a fulfilled lookup: %s', async (status, legs) => {
    await noteSession(dir, 'sess-1');
    await bindDecision(dir, 'sess-1', 'k3f9-abcd');
    await noteRedirect(dir, 'sess-1', undefined, { id: 'k3f9-abcd', category: CATEGORY });
    const { fetchImpl } = net([...legs]);
    const result = await runRequestTool(
      { query: 'BTC and ETH price', id: 'k3f9-abcd' },
      deps(fetchImpl),
    );
    expect(result.envelope.status).toBe(status);
    expect(await takeUndelivered(dir, 'sess-1', undefined, CATEGORY)).toBe(status !== 'fulfilled');
  });

  it('never counts a free lookup as delivered, since its 200 proves nothing', async () => {
    const DOCS = 'library or API documentation';
    await noteSession(dir, 'sess-1');
    await bindDecision(dir, 'sess-1', 'k3f9-abcd');
    await noteRedirect(dir, 'sess-1', undefined, { id: 'k3f9-abcd', category: DOCS });
    const { fetchImpl, calls } = net([
      {
        url: ROUTER,
        status: 200,
        body: decision({ providerPriceAtomic: '0', category: DOCS, provider: 'Context7' }),
      },
      // A 200 naming another library: the lookup succeeded, the match did not.
      { url: PROVIDER, status: 200, body: 'Context7 matched: /dodopayments/billingsdk.' },
    ]);
    const result = await runRequestTool(
      { query: '@acme/billing-sdk createInvoice', id: 'k3f9-abcd' },
      deps(fetchImpl),
    );
    expect(result.envelope.status).toBe('fulfilled');
    expect(calls.some((call) => call.paid)).toBe(false);
    expect(await takeUndelivered(dir, 'sess-1', undefined, DOCS)).toBe(true);
  });

  it("marks only the agent whose redirect named the id, never another's", async () => {
    await noteSession(dir, 'sess-1');
    await bindDecision(dir, 'sess-1', 'k3f9-abcd');
    await noteRedirect(dir, 'sess-1', undefined, { id: 'a-later-one', category: CATEGORY });
    await noteRedirect(dir, 'sess-1', 'a1', { id: 'k3f9-abcd', category: CATEGORY });
    const { fetchImpl } = net([{ url: ROUTER, status: 200, body: decision() }, ...providerLegs()]);
    const result = await runRequestTool(
      { query: 'BTC and ETH price', id: 'k3f9-abcd' },
      deps(fetchImpl),
    );
    expect(result.envelope.status).toBe('fulfilled');
    expect(await takeUndelivered(dir, 'sess-1', 'a1', CATEGORY)).toBe(false);
    expect(await takeUndelivered(dir, 'sess-1', undefined, CATEGORY)).toBe(true);
  });
});

/**
 * THE TOOL OBEYS THE SAME SWITCH AS THE HOOKS. It is pre-allowed, so without
 * this a repository marked private would still have a path off the machine.
 */
describe('the request tool in a directory where the router is off', () => {
  it('refuses with needs_input naming the key, and sends and pays nothing', async () => {
    const repo = join(dir, 'repo');
    await mkdir(join(repo, '.git'), { recursive: true });
    await mkdir(join(repo, '.tenjin'), { recursive: true });
    const file = join(repo, '.tenjin', 'config.json');
    await writeFile(file, JSON.stringify({ router: { enabled: false } }));
    const { fetchImpl, calls } = net([
      { url: ROUTER, status: 200, body: decision() },
      ...providerLegs(),
    ]);
    const auth = authorizer();
    const result = await runRequestTool(
      { query: 'BTC and ETH price', id: 'k3f9-abcd' },
      { ...deps(fetchImpl, auth), cwd: repo },
    );
    expect(result.isError).toBe(false);
    expect(result.envelope.status).toBe('needs_input');
    expect(result.envelope.reason).toContain('router.enabled');
    expect(result.envelope.reason).toContain(file);
    expect(result.envelope.nextStep).toContain('Nothing was sent');
    expect(calls).toHaveLength(0);
    expect(auth.authorize).not.toHaveBeenCalled();
  });
});
