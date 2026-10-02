import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPaymentRequired, testWalletProvider } from '../lib/read-test-utils';
import { resolveSpendAuthorizer } from '../lib/wallet';
import type { SpendAuthorization, SpendAuthorizer } from '../lib/wallet';
import type { CommandContext } from '../context';
import { runPay } from '../commands/pay';
import { extensionFor, runRequestTool } from './tool';
import type { MediaTransport } from './paid';
import { storeSpecs } from './specs';
import { ROUTER_PATH, type OfferSpec } from './decision';
import { bindDecision, claimRedirect, noteSession, renderProgress } from './progress';

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
  /** Sent as is in place of `body`, for an answer that is not JSON (text or a file). */
  raw?: string | Uint8Array;
  headers?: Record<string, string>;
}

/** A scripted network: legs are matched in order, and every request recorded. */
function net(legs: Leg[]): {
  fetchImpl: typeof fetch;
  calls: { url: string; method: string; paid: boolean; body?: string }[];
} {
  const calls: { url: string; method: string; paid: boolean; body?: string }[] = [];
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
      ...(typeof init?.body === 'string' ? { body: init.body } : {}),
    });
    const leg = queue.shift();
    if (leg === undefined) throw new Error(`unscripted request to ${String(input)}`);
    return new Response(leg.raw ?? JSON.stringify(leg.body), {
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

/** NO TEST OPENS A SOCKET: a linked-media download answers from here, and a
 *  test that wants the file passes its own transport. */
const noMediaNetwork: MediaTransport = async (target) => {
  throw new Error(`no network in tests: ${target.url.toString()}`);
};

function deps(fetchImpl: typeof fetch, auth = authorizer()) {
  return {
    ctx: ctx(),
    cwd: dir,
    authorizer: auth,
    fetchImpl,
    mediaTransport: noMediaNetwork,
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

/**
 * A PAID CALL THE PROVIDER REFUSED SAYS WHY. Firecrawl answered 403 on a
 * LinkedIn URL after the authorization left, and the envelope carried neither
 * the status nor the provider's reason, so nobody could tell a refused target
 * from an outage. Settlement stays unknown: the authorization is still out.
 */
describe('a paid call the provider refused', () => {
  const REASON = 'This website is no longer supported, please reach out to support.';

  /** The paid leg answers 403 with `answer`, after a 402 and one signature. */
  async function refused(
    answer: Partial<Leg>,
  ): Promise<Awaited<ReturnType<typeof runRequestTool>>> {
    const { fetchImpl, calls } = net([
      { url: ROUTER, status: 200, body: decision() },
      { url: PROVIDER, status: 402, body: {}, headers: { 'PAYMENT-REQUIRED': challenge() } },
      { url: PROVIDER, status: 403, body: null, ...answer },
    ]);
    const result = await runRequestTool(
      { query: 'https://www.linkedin.com/in/someone', id: 'k3f9-abcd' },
      deps(fetchImpl),
    );
    expect(calls.filter((call) => call.paid)).toHaveLength(1);
    return result;
  }

  it("carries the provider's status and its JSON reason", async () => {
    const result = await refused({ body: { success: false, error: REASON } });
    expect(result.isError).toBe(true);
    expect(result.envelope).toMatchObject({
      status: 'failed',
      providerStatus: 403,
      providerError: JSON.stringify({ success: false, error: REASON }),
      settlement: 'unknown',
      cost: ['provider price 0.01 USD'],
      providerContentUntrusted: true,
    });
  });

  it('bounds a page that is not JSON and keeps it to one plain line', async () => {
    const result = await refused({
      raw: `<html>\n<h1>403</h1> ${REASON}\u001b[2J\u202e ${'x'.repeat(2_000)}</html>`,
    });
    expect(result.envelope).toMatchObject({ providerStatus: 403, settlement: 'unknown' });
    const snippet = String(result.envelope.providerError);
    expect(snippet.startsWith(`<html> <h1>403</h1> ${REASON}`)).toBe(true);
    expect(snippet).not.toMatch(/[\p{Cc}\u202e]/u);
    expect(Array.from(snippet)).toHaveLength(501);
    expect(snippet.endsWith('…')).toBe(true);
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
    // Nothing was signed: no cost reported, and no row in the paid ledger.
    expect(result.envelope).toMatchObject({ cost: ['provider price 0 USD'] });
    await expect(readFile(join(dir, 'paid', 'ledger.jsonl'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
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
 * NEVER REDIRECTED TWICE FOR ONE TARGET, the tool's half: a lookup releases
 * nothing. The hook promised the agent its own retry would run, so a delivered
 * lookup leaves the claim in place exactly as a failed one does, and the
 * native re-run of the same call is never denied again.
 */
describe('the redirect a lookup answers', () => {
  const TARGET = 'WebSearch BTC and ETH price';
  it.each([
    ['fulfilled', [{ url: ROUTER, status: 200, body: decision() }, ...providerLegs()]],
    ['failed', [{ url: ROUTER, status: 503, body: { error: { code: 'nope', message: 'no' } } }]],
  ] as const)('leaves the claim in place after a %s lookup', async (status, legs) => {
    await noteSession(dir, 'sess-1');
    await bindDecision(dir, 'sess-1', 'k3f9-abcd');
    expect(await claimRedirect(dir, 'sess-1', undefined, TARGET)).toBe(true);
    const { fetchImpl } = net([...legs]);
    const result = await runRequestTool(
      { query: 'BTC and ETH price', id: 'k3f9-abcd' },
      deps(fetchImpl),
    );
    expect(result.envelope.status).toBe(status);
    expect(await claimRedirect(dir, 'sess-1', undefined, TARGET)).toBe(false);
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

/**
 * A SERVICE NOBODY CURATED. The tool's fallback answer names it and pays
 * nothing; the host's second call, with the id and its own input, comes back
 * as an ordinary execute and pays through the same path and caps as any other.
 */
describe('a discovered service', () => {
  const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
  const wire = async (name: string): Promise<Record<string, unknown>> =>
    JSON.parse(await readFile(join(fixtures, name), 'utf8')) as Record<string, unknown>;
  const SELLER = 'https://blockrun.ai/api/v1/audio/sound-effects';

  it('hands the host the server line and the listing, and pays nothing', async () => {
    const auth = authorizer();
    const answer = await wire('wire-lookup-discovered.json');
    const { fetchImpl, calls } = net([{ url: ROUTER, status: 200, body: answer }]);
    const result = await runRequestTool(
      { query: 'generate a short whoosh sound effect' },
      deps(fetchImpl, auth),
    );
    const hint = (answer.decision as { hint: string }).hint;
    expect(result.isError).toBe(false);
    expect(result.summary).toBe(hint);
    expect(result.envelope).toMatchObject({
      status: 'discovered',
      id: '0195f3a1-6c4d-7a2b-9e10-5f6a7b8c9d03',
      service: { provider: 'BlockRun', url: SELLER, method: 'POST', price: '$0.053501' },
      cost: ['provider price 0 USD'],
      providerContentUntrusted: true,
    });
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]!.body!)).toMatchObject({ accepts: ['discovered', 'spec'] });
    expect(auth.authorize).not.toHaveBeenCalled();
  });

  it('sends the id and the input with no query, then pays the seller under its price', async () => {
    const auth = authorizer();
    const { fetchImpl, calls } = net([
      { url: ROUTER, status: 200, body: await wire('wire-lookup-execute-discovered.json') },
      { url: SELLER, status: 402, body: {}, headers: { 'PAYMENT-REQUIRED': challenge() } },
      { url: SELLER, status: 200, body: { ok: true } },
    ]);
    const request = await wire('wire-tool-request-discovered.json');
    const result = await runRequestTool(
      { id: request.id as string, input: request.input as Record<string, unknown> },
      deps(fetchImpl, auth),
    );
    expect(result.envelope).toMatchObject({
      status: 'fulfilled',
      supplier: 'blockrun.ai',
      cost: ['provider price 0.01 USD'],
    });
    expect(result.summary).toContain('blockrun.ai');
    // The body the tool sent is the shared fixture, byte for byte in meaning.
    expect(JSON.parse(calls[0]!.body!)).toEqual(request);
    expect(calls.filter((c) => c.paid)).toHaveLength(1);
    expect(calls[2]!.body).toBe(JSON.stringify(request.input));
    expect(auth.authorize).toHaveBeenCalledOnce();
  });

  it('refuses a live 402 above the listed price before anything is signed', async () => {
    const auth = authorizer();
    const { fetchImpl, calls } = net([
      { url: ROUTER, status: 200, body: await wire('wire-lookup-execute-discovered.json') },
      {
        url: SELLER,
        status: 402,
        body: {},
        headers: { 'PAYMENT-REQUIRED': challenge({ amount: '60000' }) },
      },
    ]);
    const result = await runRequestTool(
      { id: '0195f3a1-6c4d-7a2b-9e10-5f6a7b8c9d02', input: { text: 'whoosh' } },
      deps(fetchImpl, auth),
    );
    expect(result.isError).toBe(true);
    expect(calls.filter((c) => c.paid)).toHaveLength(0);
    expect(auth.authorize).not.toHaveBeenCalled();
  });

  it('sends nothing for an input carrying a credential', async () => {
    const { fetchImpl, calls } = net([]);
    const result = await runRequestTool(
      {
        id: '0195f3a1-6c4d-7a2b-9e10-5f6a7b8c9d02',
        input: { key: 'sk-ant-api03-' + 'a'.repeat(90) },
      },
      deps(fetchImpl),
    );
    expect(result.envelope).toMatchObject({
      status: 'native',
      reason: 'the input carries a credential-shaped value, so nothing was sent',
    });
    expect(calls).toHaveLength(0);
  });

  /** A KEY BEHIND AN ESCAPED NEWLINE OR TAB: in the serialized JSON it reads
   *  as one word with the escape's letter in front, so each leaf is masked
   *  on its own, keys included. */
  it.each([
    ['an sk-ant- key after a newline', { text: `note:\nsk-ant-api03-${'a'.repeat(90)}` }],
    ['an sk-ant- key after a tab', { text: `\tsk-ant-api03-${'b'.repeat(90)}` }],
    ['a ghp_ token after a newline', { text: `line one\nghp_${'c'.repeat(36)}` }],
    ['a ghp_ token after a tab, nested', { opts: [{ auth: `\tghp_${'d'.repeat(36)}` }] }],
    ['a token as a key', { [`\nghp_${'e'.repeat(36)}`]: 'x' }],
  ])('sends nothing for %s', async (_label, input) => {
    const { fetchImpl, calls } = net([]);
    const result = await runRequestTool(
      { id: '0195f3a1-6c4d-7a2b-9e10-5f6a7b8c9d02', input },
      deps(fetchImpl),
    );
    expect(result.envelope).toMatchObject({
      status: 'native',
      reason: 'the input carries a credential-shaped value, so nothing was sent',
    });
    expect(calls).toHaveLength(0);
  });

  it('refuses an input with no id before anything is sent', async () => {
    const { fetchImpl, calls } = net([]);
    const result = await runRequestTool({ input: { text: 'whoosh' } }, deps(fetchImpl));
    expect(result.envelope).toMatchObject({ status: 'needs_input' });
    expect(calls).toHaveLength(0);
  });

  it('refuses an input over the server cap before anything is sent', async () => {
    const { fetchImpl, calls } = net([]);
    const result = await runRequestTool(
      { id: '0195f3a1-6c4d-7a2b-9e10-5f6a7b8c9d02', input: { text: 'x'.repeat(17_000) } },
      deps(fetchImpl),
    );
    expect(result.envelope).toMatchObject({ status: 'needs_input' });
    expect(calls).toHaveLength(0);
  });

  /** A FILE IS SAVED, NOT INLINED: the result names the file, its type and size. */
  it('saves a binary body to a file and returns where it is', async () => {
    const audio = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0xff, 0xfb, 0x90]);
    const { fetchImpl } = net([
      { url: ROUTER, status: 200, body: await wire('wire-lookup-execute-discovered.json') },
      { url: SELLER, status: 402, body: {}, headers: { 'PAYMENT-REQUIRED': challenge() } },
      {
        url: SELLER,
        status: 200,
        body: null,
        raw: audio,
        headers: { 'content-type': 'audio/mpeg' },
      },
    ]);
    const result = await runRequestTool(
      { id: '0195f3a1-6c4d-7a2b-9e10-5f6a7b8c9d02', input: { text: 'whoosh' } },
      { ...deps(fetchImpl), now: () => 1_700_000_000_000 },
    );
    expect(result.envelope).toMatchObject({
      status: 'fulfilled',
      cost: ['provider price 0.01 USD'],
      result: { contentType: 'audio/mpeg', bytes: audio.byteLength },
    });
    // The capability, the time, and a random suffix: never another call's file.
    const savedTo = (result.envelope.result as { savedTo: string }).savedTo;
    expect(
      savedTo.startsWith(join(dir, 'downloads', 'discovered-bazaar-3f9c2a71-1700000000000-')),
    ).toBe(true);
    expect(savedTo).toMatch(/-[0-9a-f]{8}\.mp3$/);
    expect(new Uint8Array(await readFile(savedTo))).toEqual(audio);
  });

  /** THE TX HASH IS THE PROTOCOL'S, read from the payment-response header
   *  (v2 or v1), never from what the seller wrote in its body. */
  it.each(['PAYMENT-RESPONSE', 'X-PAYMENT-RESPONSE'])(
    'reports the settlement tx from the %s header',
    async (header) => {
      const tx = `0x${'ab'.repeat(32)}`;
      const settle = Buffer.from(
        JSON.stringify({ success: true, transaction: tx, network: 'eip155:8453', payer: '0x1' }),
      ).toString('base64');
      const { fetchImpl } = net([
        { url: ROUTER, status: 200, body: await wire('wire-lookup-execute-discovered.json') },
        { url: SELLER, status: 402, body: {}, headers: { 'PAYMENT-REQUIRED': challenge() } },
        {
          url: SELLER,
          status: 200,
          body: { transaction: `0x${'cd'.repeat(32)}` },
          headers: { [header]: settle },
        },
      ]);
      const result = await runRequestTool(
        { id: '0195f3a1-6c4d-7a2b-9e10-5f6a7b8c9d02', input: { text: 'whoosh' } },
        deps(fetchImpl),
      );
      expect(result.envelope).toMatchObject({ status: 'fulfilled', settlementTxHash: tx });
    },
  );

  it('reports no tx when the seller sent no payment-response header', async () => {
    const { fetchImpl } = net([
      { url: ROUTER, status: 200, body: await wire('wire-lookup-execute-discovered.json') },
      { url: SELLER, status: 402, body: {}, headers: { 'PAYMENT-REQUIRED': challenge() } },
      { url: SELLER, status: 200, body: { transaction: `0x${'cd'.repeat(32)}` } },
    ]);
    const result = await runRequestTool(
      { id: '0195f3a1-6c4d-7a2b-9e10-5f6a7b8c9d02', input: { text: 'whoosh' } },
      deps(fetchImpl),
    );
    expect(result.envelope.settlementTxHash).toBeUndefined();
  });

  /** THE USER'S OWN RECORD: one line per paid call, with what was sent
   *  masked and cut, the amount, the tx and the files it saved. */
  it('appends one ledger line per paid call, and saves the media it links to', async () => {
    const audio = new Uint8Array([0x49, 0x44, 0x33, 0x04]);
    const tx = `0x${'ab'.repeat(32)}`;
    const settle = Buffer.from(JSON.stringify({ success: true, transaction: tx })).toString(
      'base64',
    );
    const { fetchImpl } = net([
      { url: ROUTER, status: 200, body: await wire('wire-lookup-execute-discovered.json') },
      { url: SELLER, status: 402, body: {}, headers: { 'PAYMENT-REQUIRED': challenge() } },
      {
        url: SELLER,
        status: 200,
        body: {
          audio_url: 'https://cdn.example.test/out/whoosh.mp3?sig=1',
          page: 'https://x.test/',
        },
        headers: { 'PAYMENT-RESPONSE': settle },
      },
    ]);
    // The media leg goes through the pinned transport, connected to the
    // address the destination check validated.
    const connected: { url: string; address: string }[] = [];
    const mediaTransport: MediaTransport = async (target) => {
      connected.push({ url: target.url.toString(), address: target.address });
      return {
        status: 200,
        body: (async function* () {
          yield audio;
        })(),
        discard: () => undefined,
      };
    };
    const result = await runRequestTool(
      {
        id: '0195f3a1-6c4d-7a2b-9e10-5f6a7b8c9d02',
        input: { text: `whoosh ${'y'.repeat(5_000)}` },
      },
      { ...deps(fetchImpl), now: () => 1_700_000_000_000, mediaTransport },
    );
    expect(connected).toEqual([
      { url: 'https://cdn.example.test/out/whoosh.mp3?sig=1', address: '93.184.216.34' },
    ]);
    const saved = (result.envelope.savedFiles as string[])[0]!;
    expect(result.envelope).toMatchObject({ status: 'fulfilled', savedFiles: [saved] });
    expect(saved).toMatch(/discovered-bazaar-3f9c2a71-1-1700000000000-[0-9a-f]{8}\.mp3$/);
    expect(new Uint8Array(await readFile(saved))).toEqual(audio);
    const lines = (await readFile(join(dir, 'paid', 'ledger.jsonl'), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(record).toMatchObject({
      version: 1,
      ts: new Date(1_700_000_000_000).toISOString(),
      capabilityId: 'discovered:bazaar:3f9c2a71',
      provider: 'BlockRun',
      url: SELLER,
      amountAtomic: '10000',
      txHash: tx,
      settlement: 'settled',
      savedFiles: [saved],
    });
    expect(String(record.sent)).toHaveLength(4_096);
    // The signed authorization's identity, for reconcile to ask the token about.
    expect(record.authorization).toMatchObject({
      from: expect.stringMatching(/^0x[0-9a-fA-F]{40}$/) as string,
      nonce: expect.stringMatching(/^0x[0-9a-f]{64}$/) as string,
      validBefore: expect.stringMatching(/^\d+$/) as string,
    });
  });

  /** A SETTLEMENT LEFT UNKNOWN is resolved from the chain beside the next
   *  lookup, which never waits for it. */
  it('resolves an expired unknown settlement beside the next lookup', async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(dir, 'paid'), { recursive: true });
    const nonce = `0x${'5'.repeat(64)}`;
    await writeFile(
      join(dir, 'paid', 'ledger.jsonl'),
      `${JSON.stringify({
        version: 1,
        ts: '2026-01-01T00:00:00.000Z',
        capabilityId: 'cap',
        provider: 'Seller',
        url: SELLER,
        sent: 'q',
        amountAtomic: '10000',
        settlement: 'unknown',
        savedFiles: [],
        authorization: { from: `0x${'1'.repeat(40)}`, nonce, validBefore: '1700000000' },
      })}\n`,
    );
    const rpcCalls: string[] = [];
    const { fetchImpl: scripted } = net([{ url: ROUTER, status: 200, body: NATIVE }]);
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input) === 'https://mainnet.base.org') {
        if ((JSON.parse(String(init?.body)) as { method: string }).method !== 'eth_call') {
          const now = `0x${Math.floor(Date.now() / 1000).toString(16)}`;
          return new Response(
            JSON.stringify({ jsonrpc: '2.0', id: 1, result: { number: '0x1', timestamp: now } }),
          );
        }
        rpcCalls.push(String(init?.body));
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 1, result: `0x${'0'.repeat(63)}1` }),
        );
      }
      return scripted(input, init);
    }) as typeof fetch;
    const result = await runRequestTool({ query: 'weather' }, deps(fetchImpl));
    // The lookup itself does not wait for it.
    expect(result.envelope).toMatchObject({ status: 'native' });
    await expect
      .poll(
        async () =>
          (
            JSON.parse((await readFile(join(dir, 'paid', 'ledger.jsonl'), 'utf8')).trim()) as {
              settlement: string;
            }
          ).settlement,
      )
      .toBe('settled');
    expect(rpcCalls).toHaveLength(1);
  });

  it('records a paid call with no payment-response header as settlement unknown', async () => {
    const { fetchImpl } = net([{ url: ROUTER, status: 200, body: decision() }, ...providerLegs()]);
    await runRequestTool({ query: 'BTC and ETH price' }, deps(fetchImpl));
    const record = JSON.parse(
      (await readFile(join(dir, 'paid', 'ledger.jsonl'), 'utf8')).trim(),
    ) as Record<string, unknown>;
    expect(record).toMatchObject({ sent: 'BTC and ETH price', settlement: 'unknown' });
    expect(record.txHash).toBeUndefined();
  });

  it('records a paid call that failed after the authorization left, settlement unknown', async () => {
    const { fetchImpl } = net([
      { url: ROUTER, status: 200, body: await wire('wire-lookup-execute-discovered.json') },
      { url: SELLER, status: 402, body: {}, headers: { 'PAYMENT-REQUIRED': challenge() } },
      { url: SELLER, status: 500, body: { error: 'boom' } },
    ]);
    const result = await runRequestTool(
      { id: '0195f3a1-6c4d-7a2b-9e10-5f6a7b8c9d02', input: { text: 'whoosh' } },
      deps(fetchImpl),
    );
    expect(result.envelope).toMatchObject({ status: 'failed' });
    const record = JSON.parse(
      (await readFile(join(dir, 'paid', 'ledger.jsonl'), 'utf8')).trim(),
    ) as Record<string, unknown>;
    expect(record).toMatchObject({ amountAtomic: '10000', settlement: 'unknown', savedFiles: [] });
  });

  it('skips media on a private address, and never fails the call over it', async () => {
    const { fetchImpl, calls } = net([
      { url: ROUTER, status: 200, body: await wire('wire-lookup-execute-discovered.json') },
      { url: SELLER, status: 402, body: {}, headers: { 'PAYMENT-REQUIRED': challenge() } },
      { url: SELLER, status: 200, body: { url: 'https://10.0.0.5/a.png' } },
    ]);
    const result = await runRequestTool(
      { id: '0195f3a1-6c4d-7a2b-9e10-5f6a7b8c9d02', input: { text: 'whoosh' } },
      deps(fetchImpl),
    );
    expect(result.envelope).toMatchObject({ status: 'fulfilled' });
    expect(result.envelope.savedFiles).toBeUndefined();
    expect(calls.some((c) => c.url.includes('10.0.0.5'))).toBe(false);
  });

  /** A CURATED PAGE READ OR SEARCH NEVER DOWNLOADS what its page links to. */
  it('downloads nothing a curated result links to', async () => {
    const connected: string[] = [];
    const { fetchImpl } = net([
      { url: ROUTER, status: 200, body: decision() },
      ...providerLegs({ image: 'https://cdn.example.test/chart.png' }),
    ]);
    const result = await runRequestTool(
      { query: 'BTC and ETH price' },
      {
        ...deps(fetchImpl),
        mediaTransport: async (target) => {
          connected.push(target.url.toString());
          throw new Error('should not be called');
        },
      },
    );
    expect(result.envelope).toMatchObject({ status: 'fulfilled' });
    expect(result.envelope.savedFiles).toBeUndefined();
    expect(connected).toEqual([]);
  });

  it('keeps a JSON body inline, and a media link that cannot be fetched fails nothing', async () => {
    const { fetchImpl } = net([
      { url: ROUTER, status: 200, body: await wire('wire-lookup-execute-discovered.json') },
      { url: SELLER, status: 402, body: {}, headers: { 'PAYMENT-REQUIRED': challenge() } },
      { url: SELLER, status: 200, body: { url: 'https://cdn.example.test/a.mp3' } },
    ]);
    const result = await runRequestTool(
      { id: '0195f3a1-6c4d-7a2b-9e10-5f6a7b8c9d02', input: { text: 'whoosh' } },
      deps(fetchImpl),
    );
    expect(result.envelope.result).toBe(JSON.stringify({ url: 'https://cdn.example.test/a.mp3' }));
  });

  it.each([
    ['audio/mpeg', 'mp3'],
    ['audio/wav; codecs=1', 'wav'],
    ['image/png', 'png'],
    ['video/mp4', 'mp4'],
    ['application/octet-stream', 'bin'],
    ['audio/x-something+odd', 'bin'],
    ['model/gltf-binary', 'bin'],
    ['image/avif', 'avif'],
    ['application/html', 'bin'],
    ['text/html', 'bin'],
    ['application/x-sh', 'bin'],
  ])('names a %s file .%s', (type, ext) => {
    expect(extensionFor(type)).toBe(ext);
  });
});

/**
 * AN OFFER WITH A REQUEST SPEC: the hook kept the spec, so the tool shows it for
 * the id alone and runs it for the id and an input, building and paying the
 * request itself. The server is asked nothing and told only how it ended.
 */
describe('an offer with a request spec', () => {
  const SPEC_ID = '0195f3a1-6c4d-7a2b-9e10-5f6a7b8c9d01';
  const routerCalls = (calls: { url: string }[]) =>
    calls.filter((call) => call.url.startsWith(`${ROUTER}${ROUTER_PATH}`));
  /** The outcome report is fire-and-forget: let one that was sent land. */
  const reportsSettled = () => new Promise((resolve) => setTimeout(resolve, 25));
  const PAYEE = '0x1111111111111111111111111111111111111111';

  function quoteSpec(over: Partial<OfferSpec> = {}): OfferSpec {
    return {
      id: SPEC_ID,
      capabilityId: 'cmc-quotes',
      provider: 'CoinMarketCap',
      description: 'latest market quotes for one or more cryptocurrencies',
      priceAtomic: '10000',
      priceVaries: false,
      maxAmountAtomic: '10000',
      payTo: PAYEE,
      network: 'eip155:8453',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      request: {
        method: 'GET',
        url: PROVIDER,
        fields: { symbol: 'query', convert: 'query' },
        location: 'query',
      },
      input: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Comma-separated symbols' },
          convert: { type: 'string', enum: ['USD', 'EUR'] },
        },
        required: ['symbol'],
        additionalProperties: false,
      },
      pinned: {},
      example: { symbol: 'BTC' },
      returns: 'JSON quotes keyed by symbol',
      ...over,
    };
  }

  it('shows the spec for the id alone, and sends nothing', async () => {
    await storeSpecs(dir, [quoteSpec()]);
    const { fetchImpl, calls } = net([]);
    const result = await runRequestTool({ id: SPEC_ID }, deps(fetchImpl));
    expect(result.isError).toBe(false);
    expect(result.envelope).toMatchObject({
      status: 'spec',
      id: SPEC_ID,
      cost: ['provider price 0 USD'],
    });
    expect(result.summary).toContain('symbol (string, required); Comma-separated symbols');
    expect(result.summary).toContain('Returns: JSON quotes keyed by symbol');
    expect(calls).toEqual([]);
  });

  it('builds the request from the input, pays the provider, and reports how it ended', async () => {
    await storeSpecs(dir, [quoteSpec()]);
    const { fetchImpl, calls } = net([...providerLegs(), { url: ROUTER, status: 200, body: {} }]);
    const result = await runRequestTool(
      { id: SPEC_ID, input: { symbol: 'BTC,ETH', convert: 'USD' } },
      deps(fetchImpl),
    );
    expect(result.envelope).toMatchObject({
      status: 'fulfilled',
      parameters: { symbol: 'BTC,ETH', convert: 'USD' },
      cost: ['provider price 0.01 USD'],
    });
    expect(calls[0]).toMatchObject({
      url: `${PROVIDER}?symbol=BTC%2CETH&convert=USD`,
      method: 'GET',
      paid: false,
    });
    expect(calls[1]).toMatchObject({ paid: true });
    expect(vi.mocked(runPay).mock.calls.at(-1)![0]).toMatchObject({
      terms: {
        source: 'CoinMarketCap',
        maxAmountAtomic: '10000',
        payTo: PAYEE,
        network: 'eip155:8453',
      },
      execution: 'router',
    });
    // No decision was asked for: the one router call is the report.
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    expect(calls[2]).toMatchObject({ url: `${ROUTER}${ROUTER_PATH}`, method: 'POST' });
    expect(JSON.parse(calls[2]!.body!)).toMatchObject({
      schemaVersion: 1,
      id: SPEC_ID,
      status: 'fulfilled',
    });
  });

  it('refuses an input that misses the spec, naming every problem, and sends nothing', async () => {
    await storeSpecs(dir, [quoteSpec()]);
    const { fetchImpl, calls } = net([]);
    const result = await runRequestTool(
      { id: SPEC_ID, input: { convert: 'GBP', limit: 3 } },
      deps(fetchImpl),
    );
    expect(result.isError).toBe(false);
    expect(result.envelope).toMatchObject({
      status: 'needs_input',
      cost: ['provider price 0 USD'],
    });
    const reason = String(result.envelope.reason);
    expect(reason).toContain('symbol is required');
    expect(reason).toContain('convert must be one of "USD", "EUR"');
    expect(reason).toContain('the input has no field "limit"');
    // The whole spec comes back with the problems, so the next call can be right.
    expect(result.summary).toContain('symbol (string, required); Comma-separated symbols');
    expect(result.summary).toContain('convert (string); one of "USD", "EUR"');
    expect(result.summary).toContain('Example input: {"symbol":"BTC"}');
    expect(result.summary).toContain('Returns: JSON quotes keyed by symbol');
    expect(result.envelope.nextStep).toContain(`request({id: ${JSON.stringify(SPEC_ID)}, input:`);
    expect(result.envelope.parameters).toEqual({ convert: 'GBP', limit: 3 });
    expect(calls).toEqual([]);
  });

  it('refuses a field the spec does not name, even where its schema allows extras', async () => {
    const open = quoteSpec();
    delete open.input.additionalProperties;
    await storeSpecs(dir, [open]);
    const auth = authorizer();
    const { fetchImpl, calls } = net([]);
    const result = await runRequestTool(
      { id: SPEC_ID, input: { symbol: 'BTC', limit: 3 } },
      deps(fetchImpl, auth),
    );
    expect(result.envelope).toMatchObject({
      status: 'needs_input',
      cost: ['provider price 0 USD'],
    });
    expect(String(result.envelope.reason)).toContain('the input has no field "limit"');
    expect(result.summary).toContain('symbol (string, required); Comma-separated symbols');
    expect(calls).toEqual([]);
    expect(auth.authorize).not.toHaveBeenCalled();
  });

  it("signs nothing for a live 402 that pays someone other than the spec's payee", async () => {
    await storeSpecs(dir, [quoteSpec()]);
    const { fetchImpl, calls } = net([
      {
        url: PROVIDER,
        status: 402,
        body: {},
        headers: {
          'PAYMENT-REQUIRED': challenge({ payTo: '0x2222222222222222222222222222222222222222' }),
        },
      },
    ]);
    const result = await runRequestTool({ id: SPEC_ID, input: { symbol: 'BTC' } }, deps(fetchImpl));
    expect(result.envelope).toMatchObject({
      status: 'failed',
      cost: ['provider price 0 USD'],
      request: { method: 'GET', url: `${PROVIDER}?symbol=BTC` },
      parameters: { symbol: 'BTC' },
    });
    expect(calls.filter((call) => call.paid)).toEqual([]);
    await reportsSettled();
    expect(routerCalls(calls)).toEqual([]);
  });

  it('asks for a smaller input when a varying price lands over the spec ceiling', async () => {
    await storeSpecs(dir, [quoteSpec({ priceVaries: true, maxAmountAtomic: '1000000' })]);
    const auth = authorizer();
    const { fetchImpl, calls } = net([
      {
        url: PROVIDER,
        status: 402,
        body: {},
        headers: { 'PAYMENT-REQUIRED': challenge({ amount: '1500000' }) },
      },
    ]);
    const result = await runRequestTool(
      { id: SPEC_ID, input: { symbol: 'BTC' } },
      deps(fetchImpl, auth),
    );
    expect(result.envelope).toMatchObject({
      status: 'failed',
      cost: ['provider price 0 USD'],
      nextStep: 'Change the input and call again with the same id.',
    });
    const reason = String(result.envelope.reason);
    expect(reason).toContain("prices this input at $1.5, over this spec's $1 ceiling");
    expect(reason).not.toContain('fresh decision');
    expect(calls.filter((call) => call.paid)).toEqual([]);
    expect(auth.authorize).not.toHaveBeenCalled();
    await reportsSettled();
    expect(routerCalls(calls)).toEqual([]);
  });

  it('says a provider refused the input before payment, and what was sent', async () => {
    await storeSpecs(dir, [quoteSpec()]);
    const { fetchImpl, calls } = net([
      { url: PROVIDER, status: 400, body: { error: 'bad symbol' } },
    ]);
    const result = await runRequestTool({ id: SPEC_ID, input: { symbol: '??' } }, deps(fetchImpl));
    expect(result.envelope).toMatchObject({
      status: 'failed',
      providerStatus: 400,
      parameters: { symbol: '??' },
      nextStep: 'Fix the input and call again with the same id.',
    });
    expect(String(result.envelope.reason)).toContain(
      'CoinMarketCap rejected this input before any payment (HTTP 400)',
    );
    // Refused before payment: the offer was not taken, so nothing is reported.
    await reportsSettled();
    expect(routerCalls(calls)).toEqual([]);
  });

  it('reports nothing when the spend policy refuses the call before signing', async () => {
    await storeSpecs(dir, [quoteSpec()]);
    const auth = authorizer('deny');
    const { fetchImpl, calls } = net([
      { url: PROVIDER, status: 402, body: {}, headers: { 'PAYMENT-REQUIRED': challenge() } },
    ]);
    const result = await runRequestTool(
      { id: SPEC_ID, input: { symbol: 'BTC' } },
      deps(fetchImpl, auth),
    );
    expect(result.envelope).toMatchObject({
      status: 'needs_approval',
      cost: ['provider price 0 USD'],
    });
    expect(calls.filter((call) => call.paid)).toEqual([]);
    await reportsSettled();
    expect(routerCalls(calls)).toEqual([]);
  });

  it('pays once per spec id: a retry after a paid call sends and pays nothing', async () => {
    await storeSpecs(dir, [quoteSpec()]);
    const auth = authorizer();
    const { fetchImpl, calls } = net([...providerLegs(), { url: ROUTER, status: 200, body: {} }]);
    const first = await runRequestTool(
      { id: SPEC_ID, input: { symbol: 'BTC' } },
      deps(fetchImpl, auth),
    );
    expect(first.envelope).toMatchObject({ status: 'fulfilled' });
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    const retry = await runRequestTool(
      { id: SPEC_ID, input: { symbol: 'BTC' } },
      deps(fetchImpl, auth),
    );
    expect(retry.isError).toBe(false);
    expect(retry.envelope).toMatchObject({
      status: 'needs_input',
      cost: ['provider price 0 USD'],
    });
    expect(String(retry.envelope.reason)).toContain('already paid for');
    expect(String(retry.envelope.reason)).toContain('$0.01');
    expect(String(retry.envelope.nextStep)).toContain('request({query})');
    expect(calls).toHaveLength(3);
    expect(calls.filter((call) => call.paid)).toHaveLength(1);
    expect(auth.authorize).toHaveBeenCalledOnce();
  });

  it('keeps the claim when the spend ledger fails after the payment left: a retry signs nothing', async () => {
    await storeSpecs(dir, [quoteSpec()]);
    const auth = authorizer();
    // The authorization has left, then the ledger write behind `commit` fails:
    // the error carries no amount, so the call reads as unpaid.
    vi.mocked(auth.commit).mockRejectedValueOnce(
      new Error('the spend ledger could not be written'),
    );
    // A second paid leg is scripted, so a retry that signs again is observable.
    const { fetchImpl, calls } = net([...providerLegs(), ...providerLegs()]);
    const first = await runRequestTool(
      { id: SPEC_ID, input: { symbol: 'BTC' } },
      deps(fetchImpl, auth),
    );
    expect(first.envelope).toMatchObject({ status: 'failed' });
    expect(calls.filter((call) => call.paid)).toHaveLength(1);
    const retry = await runRequestTool(
      { id: SPEC_ID, input: { symbol: 'BTC' } },
      deps(fetchImpl, auth),
    );
    expect(retry.envelope).toMatchObject({ status: 'needs_input', cost: ['provider price 0 USD'] });
    expect(String(retry.envelope.reason)).toContain('signed a payment');
    expect(String(retry.envelope.reason)).toContain('may have left');
    expect(String(retry.envelope.nextStep)).toContain('request({query})');
    expect(calls.filter((call) => call.paid)).toHaveLength(1);
    expect(auth.authorize).toHaveBeenCalledOnce();
  });

  it('lets a spec run again after a call that paid nothing', async () => {
    await storeSpecs(dir, [quoteSpec()]);
    const { fetchImpl, calls } = net([
      { url: PROVIDER, status: 400, body: { error: 'bad symbol' } },
      ...providerLegs(),
      { url: ROUTER, status: 200, body: {} },
    ]);
    const refused = await runRequestTool({ id: SPEC_ID, input: { symbol: '??' } }, deps(fetchImpl));
    expect(refused.envelope).toMatchObject({ status: 'failed', providerStatus: 400 });
    const fixed = await runRequestTool({ id: SPEC_ID, input: { symbol: 'BTC' } }, deps(fetchImpl));
    expect(fixed.envelope).toMatchObject({ status: 'fulfilled' });
    expect(calls.filter((call) => call.paid)).toHaveLength(1);
    await vi.waitFor(() => expect(routerCalls(calls)).toHaveLength(1));
  });

  /** The id-less answer: the pick's spec beside its fresh id, the line with
   *  the call's skeleton, and the bound input when the server bound one. */
  function specAnswer(id: string, input?: Record<string, unknown>): Record<string, unknown> {
    const spec: Partial<OfferSpec> = quoteSpec();
    delete spec.id;
    const call = input !== undefined ? JSON.stringify(input) : '{"symbol":"<symbol>"}';
    return {
      schemaVersion: 1,
      routerVersion: '2026-09-23.1',
      decision: {
        action: 'spec',
        id,
        spec,
        hint: `CoinMarketCap fits this: latest market quotes. $0.01 via ${PROVIDER} . Call request({id: ${JSON.stringify(id)}, input: ${call}}) alone and wait for its result.`,
        ...(input !== undefined ? { input } : {}),
      },
    };
  }

  it("shows the server's pick for a query with no id as its spec and the call's skeleton, then runs it from that spec", async () => {
    const PICKED = '0195f3a1-6c4d-7a2b-9e10-5f6a7b8c9d21';
    const query = 'BTC and ETH spot price in USD';
    const answer = specAnswer(PICKED);
    const { fetchImpl, calls } = net([
      { url: ROUTER, status: 200, body: answer },
      ...providerLegs(),
      { url: ROUTER, status: 200, body: {} },
    ]);
    const shown = await runRequestTool({ query }, deps(fetchImpl));
    expect(shown.isError).toBe(false);
    expect(shown.envelope).toMatchObject({
      status: 'spec',
      id: PICKED,
      cost: ['provider price 0 USD'],
    });
    // The whole spec, then the skeleton the server wrote, as the next step.
    expect(shown.summary).toContain('symbol (string, required); Comma-separated symbols');
    const skeleton = `request({id: ${JSON.stringify(PICKED)}, input: {"symbol":"<symbol>"}})`;
    expect(shown.summary).toContain(`Next: CoinMarketCap fits this`);
    expect(shown.summary).toContain(skeleton);
    expect(String(shown.envelope.nextStep)).toContain(skeleton);
    expect(calls.filter((call) => call.url.startsWith(PROVIDER))).toEqual([]);
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      schemaVersion: 1,
      query,
      accepts: ['discovered', 'spec'],
    });
    // The next call runs from the kept spec: no second decision.
    const ran = await runRequestTool({ id: PICKED, input: { symbol: 'BTC' } }, deps(fetchImpl));
    expect(ran.envelope).toMatchObject({ status: 'fulfilled' });
    expect(calls[1]).toMatchObject({ url: `${PROVIDER}?symbol=BTC`, paid: false });
    expect(calls[2]).toMatchObject({ paid: true });
    await vi.waitFor(() => expect(calls).toHaveLength(4));
    expect(JSON.parse(calls[3]!.body!)).toMatchObject({ id: PICKED, status: 'fulfilled' });
  });

  it('runs and pays a query with no id in the same call when the server bound its input', async () => {
    const PICKED = '0195f3a1-6c4d-7a2b-9e10-5f6a7b8c9d22';
    const auth = authorizer();
    const { fetchImpl, calls } = net([
      { url: ROUTER, status: 200, body: specAnswer(PICKED, { symbol: 'BTC' }) },
      ...providerLegs(),
      { url: ROUTER, status: 200, body: {} },
    ]);
    const result = await runRequestTool({ query: 'BTC spot price' }, deps(fetchImpl, auth));
    expect(result.envelope).toMatchObject({
      status: 'fulfilled',
      parameters: { symbol: 'BTC' },
      cost: ['provider price 0.01 USD'],
    });
    // One decision, then the provider's probe and paid leg, built here from
    // the spec, under the spec's own terms.
    expect(calls[1]).toMatchObject({ url: `${PROVIDER}?symbol=BTC`, paid: false });
    expect(calls[2]).toMatchObject({ paid: true });
    expect(vi.mocked(runPay).mock.calls.at(-1)![0]).toMatchObject({
      terms: { source: 'CoinMarketCap', maxAmountAtomic: '10000', payTo: PAYEE },
    });
    expect(auth.authorize).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(calls).toHaveLength(4));
    expect(JSON.parse(calls[3]!.body!)).toMatchObject({ id: PICKED, status: 'fulfilled' });
    // Kept like a hook's spec, and paid once: the same id pays nothing again.
    const retry = await runRequestTool(
      { id: PICKED, input: { symbol: 'BTC' } },
      deps(fetchImpl, auth),
    );
    expect(String(retry.envelope.reason)).toContain('already paid for');
    expect(calls.filter((call) => call.paid)).toHaveLength(1);
  });

  it("checks the server's bound input like any other, and shows the spec when it misses", async () => {
    const PICKED = '0195f3a1-6c4d-7a2b-9e10-5f6a7b8c9d23';
    const auth = authorizer();
    const { fetchImpl, calls } = net([
      { url: ROUTER, status: 200, body: specAnswer(PICKED, { symbol: 'BTC', convert: 'GBP' }) },
    ]);
    const result = await runRequestTool({ query: 'BTC price in GBP' }, deps(fetchImpl, auth));
    expect(result.envelope).toMatchObject({
      status: 'needs_input',
      cost: ['provider price 0 USD'],
    });
    expect(String(result.envelope.reason)).toContain('convert must be one of "USD", "EUR"');
    expect(result.summary).toContain('symbol (string, required); Comma-separated symbols');
    expect(calls).toHaveLength(1);
    expect(auth.authorize).not.toHaveBeenCalled();
  });

  it("shows a list service's own spec for a query, not its line", async () => {
    const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
    const answer = JSON.parse(
      await readFile(join(fixtures, 'wire-hook-discovered-spec.json'), 'utf8'),
    ) as { decision: { id: string; specs: OfferSpec[] } };
    const { fetchImpl } = net([{ url: ROUTER, status: 200, body: answer }]);
    const result = await runRequestTool({ query: 'an image of a red fox' }, deps(fetchImpl));
    const [spec] = answer.decision.specs;
    expect(result.envelope).toMatchObject({ status: 'spec', id: answer.decision.id });
    expect(result.summary).toContain(`${spec!.provider}: ${spec!.description}`);
    expect(result.summary).not.toContain('Also offered');
  });

  it('asks the server, as before, for an id it holds no spec for', async () => {
    const { fetchImpl, calls } = net([{ url: ROUTER, status: 200, body: NATIVE }]);
    const result = await runRequestTool({ id: SPEC_ID }, deps(fetchImpl));
    expect(result.envelope).toMatchObject({ status: 'needs_input' });
    expect(String(result.envelope.reason)).toContain('No spec is kept for that id');
    expect(calls).toEqual([]);
    const withQuery = await runRequestTool({ id: SPEC_ID, query: 'BTC price' }, deps(fetchImpl));
    expect(withQuery.envelope).toMatchObject({ status: 'native' });
    expect(calls).toHaveLength(1);
  });
});
