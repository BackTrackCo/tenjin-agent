import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPaymentRequired, testWalletProvider } from '../lib/read-test-utils';
import { CliError } from '../lib/errors';
import { resolveSpendAuthorizer } from '../lib/wallet';
import type { SpendAuthorization, SpendAuthorizer } from '../lib/wallet';
import type { CommandContext } from '../context';
import { runPay } from '../commands/pay';
import { MAX_BODY_BYTES } from '../lib/request-schema';
import { extensionFor, failureOutcome, runRequestTool } from './tool';
import type { MediaTransport } from './paid';
import { readSpec, storeChoices, storeSpecs } from './specs';
import {
  DEADLINE_AFTER_PAYMENT_SENT,
  ROUTER_PATH,
  RouteSkipped,
  type Choices,
  type OfferSpec,
} from './decision';
import { httpRequest, type HttpRequestOptions } from '../lib/http';
import { bindDecision, claimRedirect, noteSession, renderProgress } from './progress';
import { readRouterMemo, writeRouterMemo } from './router-memo';
import { unlockDetails } from '../lib/wallet-unlock';
import { ASK_FOR_REPAIR, REPAIR_CLAUSE, WALLET_REASONS } from './wallet-reasons';

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

  it('says the routing fee could not be paid, not to update, when the free path answers fee_required', async () => {
    const { fetchImpl, calls } = net([
      {
        url: ROUTER,
        status: 200,
        body: {
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
        },
      },
    ]);
    // A "no paid path" this machine remembered from before the fee turned on.
    await writeRouterMemo(dir, 'paid-path-absent', ROUTER, { now: Date.now(), ttlMs: 3_600_000 });
    const result = await runRequestTool({ query: 'what is the weather' }, deps(fetchImpl));
    expect(calls).toHaveLength(1);
    // The fee is on now, so the next call asks for the paid path at once.
    expect(await readRouterMemo(dir, 'paid-path-absent', ROUTER, Date.now())).toBeNull();
    expect(result.envelope).toMatchObject({ status: 'native', cost: ['provider price 0 USD'] });
    expect(String(result.envelope.reason)).toContain('could not pay its $0.003 fee');
    expect(result.summary).toMatch(/^Use your usual tools:/);
    expect(result.summary).not.toContain('No paid lookup needed');
    expect(String(result.envelope.reason)).toContain('`tenjin doctor`');
    expect(JSON.stringify(result.envelope)).not.toContain('npm i -g');
  });

  /** The tool's text is the model's: a wallet reason carries its agentFix (B1). */
  it("gives the model a wallet reason's ask-the-person fix when the free path answers fee_required", async () => {
    const { fetchImpl } = net([
      {
        url: ROUTER,
        status: 200,
        body: {
          schemaVersion: 1,
          routerVersion: 'v',
          decision: {
            action: 'native',
            diagnostics: {
              reasonCode: 'fee_required',
              stage: 'capability',
              missing: [],
              nextAction: 'x',
            },
          },
        },
      },
    ]);
    const route = async () => ({
      path: '/api/x402-router/route',
      send: async (): Promise<never> => {
        throw new RouteSkipped('passphrase_missing');
      },
    });
    const result = await runRequestTool(
      { query: 'what is the weather' },
      { ...deps(fetchImpl), route },
    );
    const reason = String(result.envelope.reason);
    expect(reason).toContain(WALLET_REASONS.passphrase_missing.reason);
    expect(reason).toContain(ASK_FOR_REPAIR);
    expect(reason).not.toContain(REPAIR_CLAUSE);
  });

  it("gives the model a wallet reason's ask-the-person fix when the call runs out of time", async () => {
    const route = async () => ({
      path: '/api/x402-router/route',
      send: async (): Promise<never> => {
        await new Promise((resolve) => setTimeout(resolve, 80));
        throw new RouteSkipped('passphrase_wrong');
      },
    });
    const quick = { ...ctx(), flags: { ...ctx().flags, timeout: 50 } };
    const result = await runRequestTool(
      { query: 'what is the weather' },
      { ...deps(net([]).fetchImpl), ctx: quick, route },
    );
    const reason = String(result.envelope.reason);
    expect(reason).toContain(WALLET_REASONS.passphrase_wrong.reason);
    expect(reason).toContain(ASK_FOR_REPAIR);
    expect(reason).not.toContain(REPAIR_CLAUSE);
  });

  it('asks once more on the paid path when a stale "no paid path" memo sent the call free', async () => {
    const feeOn = {
      schemaVersion: 1,
      routerVersion: 'v',
      decision: {
        action: 'native',
        diagnostics: {
          reasonCode: 'fee_required',
          stage: 'capability',
          missing: [],
          nextAction: 'x',
        },
      },
    };
    const { fetchImpl, calls } = net([
      { url: ROUTER, status: 200, body: feeOn },
      { url: ROUTER, status: 200, body: NATIVE },
    ]);
    await writeRouterMemo(dir, 'paid-path-absent', ROUTER, { now: Date.now(), ttlMs: 3_600_000 });
    const route = async (baseUrl: string) =>
      (await readRouterMemo(dir, 'paid-path-absent', baseUrl, Date.now()))
        ? null
        : {
            path: '/api/x402-router/route',
            send: (url: string, options: HttpRequestOptions) => httpRequest(url, options),
          };
    const result = await runRequestTool(
      { query: 'what is the weather' },
      { ...deps(fetchImpl), route },
    );
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      '/api/x402-router',
      '/api/x402-router/route',
    ]);
    expect(result.envelope).toMatchObject({ status: 'native' });
    expect(String(result.envelope.reason)).not.toContain('could not pay');
  });

  it('names a routing deposit once, in the result of the call that took it', async () => {
    let deposited = 30_000n;
    const route = async () => ({
      path: '/api/x402-router/route',
      send: (url: string, options: HttpRequestOptions) => httpRequest(url, options),
      deposited: () => deposited,
    });
    const { fetchImpl } = net([
      { url: ROUTER, status: 200, body: NATIVE },
      { url: ROUTER, status: 200, body: NATIVE },
    ]);
    const first = await runRequestTool(
      { query: 'what is the weather' },
      { ...deps(fetchImpl), route },
    );
    expect(first.summary.split('\n').at(-1)).toBe(
      'Tenjin set aside $0.03 for routing. Each routing decision costs $0.003. Unused funds remain yours.',
    );
    deposited = 0n;
    const next = await runRequestTool(
      { query: 'what is the weather' },
      { ...deps(fetchImpl), route },
    );
    expect(next.summary).not.toContain('set aside');
  });

  it('says a routing payment went out when the call ran out of time after sending it', async () => {
    const route = async () => ({
      path: '/api/x402-router/route',
      send: async (): Promise<never> => {
        await new Promise((resolve) => setTimeout(resolve, 80));
        throw new RouteSkipped(DEADLINE_AFTER_PAYMENT_SENT);
      },
    });
    const { fetchImpl } = net([]);
    const quick = { ...ctx(), flags: { ...ctx().flags, timeout: 50 } };
    const result = await runRequestTool(
      { query: 'what is the weather' },
      { ...deps(fetchImpl), ctx: quick, route },
    );
    expect(String(result.envelope.reason)).toContain(
      'A routing payment (possibly the channel deposit) went out',
    );
    expect(String(result.envelope.reason)).not.toContain('nothing was routed or paid');
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

  it("hands the agent the seller's reason when it says it did not settle", async () => {
    const said = 'Facilitator settle failed (402): A valid payment method is required.';
    const settle = Buffer.from(
      JSON.stringify({ success: false, errorReason: said, transaction: '' }),
    ).toString('base64');
    const result = await refused({
      status: 402,
      body: {},
      headers: { 'PAYMENT-RESPONSE': settle },
    });
    expect(result.envelope).toMatchObject({
      status: 'failed',
      providerStatus: 402,
      providerError: '{}',
      settlementError: said,
      settlement: 'unknown',
      cost: ['provider price 0.01 USD'],
    });
    expect(String(result.envelope.reason)).toContain(
      'The endpoint did not settle the payment: Facilitator settle failed (402)',
    );
    expect(String(result.envelope.reason)).toContain('Use a different service');
  });

  it('carries no settlementError when the seller sent no payment-response header', async () => {
    const result = await refused({ body: { success: false, error: REASON } });
    expect(result.envelope).not.toHaveProperty('settlementError');
  });
});

describe('a paid long job that named a status URL before its time ran out', () => {
  it('hands the agent the URL and says a second call would pay again', async () => {
    const scripted = net([
      { url: ROUTER, status: 200, body: decision() },
      {
        url: PROVIDER,
        status: 402,
        body: {},
        headers: { 'PAYMENT-REQUIRED': challenge({ maxTimeoutSeconds: 1 }) },
      },
    ]);
    // The paid leg: its headers at once, its body never before the deadline.
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (!new Headers(init?.headers).has('payment-signature'))
        return scripted.fetchImpl(input, init);
      const body = new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener('abort', () =>
            controller.error(new DOMException('The operation was aborted', 'AbortError')),
          );
        },
      });
      return new Response(body, {
        status: 200,
        headers: { 'X-Status-Url': 'https://pro-api.example.test/jobs/42' },
      });
    }) as typeof fetch;
    const quick = { ...ctx(), flags: { ...ctx().flags, timeout: 50 } };
    const result = await runRequestTool(
      { query: 'BTC price', id: 'k3f9-abcd' },
      { ...deps(fetchImpl), ctx: quick },
    );
    expect(result.envelope).toMatchObject({
      status: 'failed',
      statusUrl: 'https://pro-api.example.test/jobs/42',
      settlement: 'unknown',
      cost: ['provider price 0.01 USD'],
      nextStep:
        'Check statusUrl for the result. Do not call request again for this: it would pay again.',
    });
    expect(String(result.envelope.reason)).toContain('The seller is still working on this');
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
   * THE MONEY AUTHORITY: the call's plan, at the live price, meets the local
   * policy. A server can quote any price, so a live 402 within that quote
   * still has to fit the limit; over it, the call is quoted for the user's
   * yes and nothing is signed.
   */
  it('quotes a call whose live price is over the limit, and signs nothing', async () => {
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
    const result = await runRequestTool({ query: 'q' }, { ...real, approves: true });
    expect(result.envelope).toMatchObject({
      status: 'needs_approval',
      quote: { total: '$0.9', id: expect.stringMatching(/^q_/) as string },
    });
    expect(result.summary).toContain("Needs the user's approval");
    expect(String(result.envelope.reason)).toContain(
      'That is over the $0.25 this machine pays for one call without asking, so nothing was paid.',
    );
    expect(String(result.envelope.nextStep)).toMatch(/^Call approve\(\{quote: "q_/);
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
    const body = { data: { blob: 'x'.repeat(MAX_BODY_BYTES) } };
    const { fetchImpl } = net([
      { url: ROUTER, status: 200, body: withRule() },
      ...providerLegs(body),
    ]);
    const result = await runRequestTool({ query: 'q' }, deps(fetchImpl));
    expect(result.envelope).toMatchObject({ status: 'unverified' });
    expect(result.envelope.resultCaveat).toContain('not checked');
  });

  it('checks a 150 KB paid body against its rule, and fulfils one that passes', async () => {
    const body = { data: { organization: { blurb: 'x'.repeat(150 * 1024) } } };
    const { fetchImpl } = net([
      { url: ROUTER, status: 200, body: withRule() },
      ...providerLegs(body),
    ]);
    const result = await runRequestTool({ query: 'q' }, deps(fetchImpl));
    expect(result.isError).toBe(false);
    expect(result.envelope).toMatchObject({ status: 'fulfilled', result: JSON.stringify(body) });
    expect(result.envelope.resultCaveat).toBeUndefined();
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
  const SOUND_ID = '0195f3a1-6c4d-7a2b-9e10-5f6a7b8c9d02';
  /** The spec the hook kept for the sound-effect offer: the only way a list
   *  service's call is built and paid. */
  const kept = (over: Partial<OfferSpec> = {}) =>
    storeSpecs(dir, [
      {
        id: SOUND_ID,
        capabilityId: 'discovered:bazaar:3f9c2a71',
        provider: 'BlockRun',
        description: 'AI sound effect generation (ElevenLabs)',
        priceAtomic: '53501',
        priceVaries: false,
        maxAmountAtomic: '53501',
        payTo: '0x1111111111111111111111111111111111111111',
        network: 'eip155:8453',
        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        request: {
          method: 'POST',
          url: SELLER,
          fields: { text: 'body', duration_seconds: 'body' },
          location: 'body',
        },
        input: {
          type: 'object',
          properties: { text: { type: 'string' }, duration_seconds: { type: 'number' } },
          required: ['text'],
          additionalProperties: false,
        },
        pinned: {},
        ...over,
      },
    ]);

  it("shows an open-Bazaar answer's spec under its id, keeps it, and pays nothing", async () => {
    const auth = authorizer();
    const answer = await wire('wire-lookup-discovered.json');
    const { fetchImpl } = net([{ url: ROUTER, status: 200, body: answer }]);
    const result = await runRequestTool(
      { query: 'generate a short whoosh sound effect' },
      deps(fetchImpl, auth),
    );
    const id = (answer.decision as { id: string }).id;
    expect(result).toMatchObject({ isError: false, envelope: { status: 'spec', id } });
    expect(await readSpec(dir, id)).toMatchObject({ id, provider: 'BlockRun' });
    expect(auth.authorize).not.toHaveBeenCalled();
  });

  /** An answer with no specs, as a router before specs sent: the server's
   *  line and the seller's listing, and nothing kept to run. */
  it('hands the host the server line and the listing, and pays nothing', async () => {
    const auth = authorizer();
    const wired = await wire('wire-lookup-discovered.json');
    const bare = { ...(wired.decision as Record<string, unknown>) };
    delete bare.specs;
    const answer = { ...wired, decision: bare };
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
    expect(JSON.parse(calls[0]!.body!)).toMatchObject({
      accepts: ['catalog', 'spec', 'label', 'fields', 'jobs', 'headers', 'note', 'tolerant'],
    });
    expect(auth.authorize).not.toHaveBeenCalled();
  });

  it("runs a kept list service's spec, paying the seller under its price", async () => {
    await kept();
    const auth = authorizer();
    const { fetchImpl, calls } = net([
      { url: SELLER, status: 402, body: {}, headers: { 'PAYMENT-REQUIRED': challenge() } },
      { url: SELLER, status: 200, body: { ok: true } },
    ]);
    const input = { text: 'a short airy whoosh, dry, close-miked', duration_seconds: 1.2 };
    const result = await runRequestTool({ id: SOUND_ID, input }, deps(fetchImpl, auth));
    expect(result.envelope).toMatchObject({
      status: 'fulfilled',
      supplier: 'blockrun.ai',
      cost: ['provider price 0.01 USD'],
    });
    expect(result.summary).toContain('blockrun.ai');
    // Built here from the spec: no decision call before the seller.
    expect(calls[0]!.url).toBe(SELLER);
    expect(calls.filter((c) => c.paid)).toHaveLength(1);
    expect(calls[1]!.body).toBe(JSON.stringify(input));
    expect(auth.authorize).toHaveBeenCalledOnce();
  });

  it('answers an input whose spec is no longer kept with a fresh query, sending nothing', async () => {
    const auth = authorizer();
    const { fetchImpl, calls } = net([]);
    const result = await runRequestTool(
      { id: SOUND_ID, input: { text: 'whoosh' } },
      deps(fetchImpl, auth),
    );
    expect(result.envelope).toMatchObject({
      status: 'needs_input',
      nextStep: expect.stringContaining('request({query})') as string,
    });
    expect(calls).toHaveLength(0);
    expect(auth.authorize).not.toHaveBeenCalled();
  });

  it('refuses a live 402 above the listed price before anything is signed', async () => {
    await kept();
    const auth = authorizer();
    const { fetchImpl, calls } = net([
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
    await kept();
    const audio = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0xff, 0xfb, 0x90]);
    const { fetchImpl } = net([
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

  /** A SPEC'S FILE CAP holds the body it brings back: one over it is not kept. */
  it("keeps no binary body over the spec's own maxBytes", async () => {
    await kept({ maxBytes: 4 });
    const audio = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0xff, 0xfb, 0x90]);
    const { fetchImpl } = net([
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
      deps(fetchImpl),
    );
    expect(result.envelope.status).not.toBe('fulfilled');
    expect(String(result.envelope.reason)).toContain('over the 4-byte cap');
    expect(await readdir(join(dir, 'downloads')).catch(() => [])).toEqual([]);
  });

  /** THE TX HASH IS THE PROTOCOL'S, read from the payment-response header
   *  (v2 or v1), never from what the seller wrote in its body. */
  it.each(['PAYMENT-RESPONSE', 'X-PAYMENT-RESPONSE'])(
    'reports the settlement tx from the %s header',
    async (header) => {
      await kept();
      const tx = `0x${'ab'.repeat(32)}`;
      const settle = Buffer.from(
        JSON.stringify({ success: true, transaction: tx, network: 'eip155:8453', payer: '0x1' }),
      ).toString('base64');
      const { fetchImpl } = net([
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
    await kept();
    const { fetchImpl } = net([
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
    await kept();
    const audio = new Uint8Array([0x49, 0x44, 0x33, 0x04]);
    const tx = `0x${'ab'.repeat(32)}`;
    const settle = Buffer.from(JSON.stringify({ success: true, transaction: tx })).toString(
      'base64',
    );
    const { fetchImpl } = net([
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
    await kept();
    const { fetchImpl } = net([
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
    await kept();
    const { fetchImpl, calls } = net([
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

  /** THE SPEC'S `output` SAYS WHETHER FILES ARE SAVED, whatever the id; a
   *  spec without one falls back to the `discovered:` id. */
  it.each([
    ['a catalog media service', { capabilityId: 'blockrun-sound-effects', output: 'media' }, 1],
    ['a discovered id whose spec says json', { output: 'json' }, 0],
    ['a discovered id with no output', {}, 1],
  ] as const)('saves linked files by the spec output: %s', async (_label, over, downloads) => {
    await kept(over);
    const { fetchImpl } = net([
      { url: SELLER, status: 402, body: {}, headers: { 'PAYMENT-REQUIRED': challenge() } },
      { url: SELLER, status: 200, body: { audio_url: 'https://cdn.example.test/out/a.mp3' } },
    ]);
    const connected: string[] = [];
    const result = await runRequestTool(
      { id: SOUND_ID, input: { text: 'whoosh' } },
      {
        ...deps(fetchImpl),
        mediaTransport: async (target) => {
          connected.push(target.url.toString());
          return {
            status: 200,
            body: (async function* () {
              yield new Uint8Array([0x49, 0x44, 0x33, 0x04]);
            })(),
            discard: () => undefined,
          };
        },
      },
    );
    expect(result.envelope).toMatchObject({ status: 'fulfilled' });
    expect(connected).toHaveLength(downloads);
  });

  /** A LIST SERVICE UNDER ITS CATALOG ID, kept from the hook's `discovered`
   *  offer as a `catalog` client gets it, still has its files saved: its spec
   *  says `media` where the `discovered:` id used to. */
  it('saves the linked files of a list service kept under its catalog id', async () => {
    const { decision } = (await wire('wire-hook-discovered-catalog.json')) as {
      decision: { id: string; specs: OfferSpec[] };
    };
    const spec = decision.specs[0]!;
    expect(spec).toMatchObject({ capabilityId: 'blockrun-sound-effects', output: 'media' });
    await storeSpecs(dir, decision.specs);
    const { fetchImpl } = net([
      {
        url: spec.request.url,
        status: 402,
        body: {},
        headers: { 'PAYMENT-REQUIRED': challenge({ payTo: spec.payTo }) },
      },
      {
        url: spec.request.url,
        status: 200,
        body: { data: [{ url: 'https://cdn.example.test/out/whoosh.mp3', format: 'mp3' }] },
      },
      { url: ROUTER, status: 200, body: {} },
    ]);
    const connected: string[] = [];
    const result = await runRequestTool(
      { id: decision.id, input: { text: 'a short airy whoosh' } },
      {
        ...deps(fetchImpl),
        mediaTransport: async (target) => {
          connected.push(target.url.toString());
          return {
            status: 200,
            body: (async function* () {
              yield new Uint8Array([0x49, 0x44, 0x33, 0x04]);
            })(),
            discard: () => undefined,
          };
        },
      },
    );
    expect(result.envelope).toMatchObject({ status: 'fulfilled' });
    expect(connected).toEqual(['https://cdn.example.test/out/whoosh.mp3']);
    expect(result.envelope.savedFiles).toHaveLength(1);
  });

  it('keeps a JSON body inline, and a media link that cannot be fetched fails nothing', async () => {
    await kept();
    const { fetchImpl } = net([
      { url: SELLER, status: 402, body: {}, headers: { 'PAYMENT-REQUIRED': challenge() } },
      { url: SELLER, status: 200, body: { url: 'https://cdn.example.test/a.mp3' } },
    ]);
    const result = await runRequestTool(
      { id: '0195f3a1-6c4d-7a2b-9e10-5f6a7b8c9d02', input: { text: 'whoosh' } },
      deps(fetchImpl),
    );
    expect(result.envelope.result).toBe(JSON.stringify({ url: 'https://cdn.example.test/a.mp3' }));
  });

  /** THE FILE INSIDE THE JSON: agent402's Veo answered with the video as
   *  4.2 MB of base64, which reached the agent whole with nothing saved. */
  it('saves a video returned inline as base64, and hands back a note naming the file', async () => {
    await kept();
    const video = new Uint8Array(64 * 1024).fill(0x2a);
    video.set([0x00, 0x00, 0x00, 0x18, ...Buffer.from('ftypisom')]);
    const b64 = Buffer.from(video).toString('base64');
    const { fetchImpl } = net([
      { url: SELLER, status: 402, body: {}, headers: { 'PAYMENT-REQUIRED': challenge() } },
      {
        url: SELLER,
        status: 200,
        body: { data: [{ b64_json: b64, media_type: 'video/mp4', duration_seconds: 4 }] },
      },
    ]);
    const result = await runRequestTool(
      { id: '0195f3a1-6c4d-7a2b-9e10-5f6a7b8c9d02', input: { text: 'a whoosh, as video' } },
      deps(fetchImpl),
    );
    expect(result.envelope).toMatchObject({ status: 'fulfilled' });
    const savedFiles = result.envelope.savedFiles as string[];
    expect(savedFiles).toHaveLength(1);
    expect(savedFiles[0]!.startsWith(join(dir, 'downloads'))).toBe(true);
    expect(savedFiles[0]!.endsWith('.mp4')).toBe(true);
    expect(Buffer.from(await readFile(savedFiles[0]!)).equals(Buffer.from(video))).toBe(true);
    const shown = String(result.envelope.result);
    expect(shown).not.toContain(b64.slice(0, 200));
    expect(JSON.parse(shown)).toEqual({
      data: [
        {
          b64_json: `[inline file saved to ${savedFiles[0]!} (video/mp4, ${video.byteLength} bytes)]`,
          media_type: 'video/mp4',
          duration_seconds: 4,
        },
      ],
    });
    const record = JSON.parse(
      (await readFile(join(dir, 'paid', 'ledger.jsonl'), 'utf8')).trim(),
    ) as Record<string, unknown>;
    expect(record.savedFiles).toEqual(savedFiles);
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
  const routerCalls = <T extends { url: string }>(calls: T[]) =>
    calls.filter((call) => call.url.startsWith(`${ROUTER}${ROUTER_PATH}`));
  /** The one report a call sent, once it has landed: it is fire and forget. */
  const reported = async (calls: { url: string; body?: string }[]) => {
    await vi.waitFor(() => expect(routerCalls(calls)).toHaveLength(1));
    return JSON.parse(routerCalls(calls)[0]!.body!) as Record<string, unknown>;
  };
  /** Nothing reached the provider: the only call, if any, is the report. */
  const providerCalls = (calls: { url: string }[]) =>
    calls.filter((call) => call.url.startsWith(PROVIDER));
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
    // A spec that names no fields hands the body back as it came, and saves nothing.
    expect(result.envelope.result).toBe(JSON.stringify({ data: { BTC: 1 } }));
    expect(result.envelope).not.toHaveProperty('fullResultPath');
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
    // The shape the shared fixture pins: the provider's status rides along.
    const report = JSON.parse(calls[2]!.body!) as Record<string, unknown>;
    expect(report).toMatchObject({
      schemaVersion: 1,
      id: SPEC_ID,
      status: 'fulfilled',
      httpStatus: 200,
    });
    const fixture = JSON.parse(
      await readFile(
        fileURLToPath(new URL('./fixtures/wire-outcome-request.json', import.meta.url)),
        'utf8',
      ),
    ) as Record<string, unknown>;
    expect(Object.keys(report).sort()).toEqual([...Object.keys(fixture), 'harness'].sort());
  });

  it('refuses an input that misses the spec, naming every problem, and reports it unpaid', async () => {
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
    expect(providerCalls(calls)).toEqual([]);
    expect(await reported(calls)).toEqual({
      schemaVersion: 1,
      id: SPEC_ID,
      harness: 'claude',
      status: 'unpaid',
      reason: 'input',
      ms: expect.any(Number) as number,
    });
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
    expect(providerCalls(calls)).toEqual([]);
    expect(auth.authorize).not.toHaveBeenCalled();
    expect(await reported(calls)).toMatchObject({ status: 'unpaid', reason: 'input' });
  });

  it('sends and pays nothing for a spec whose input schema cannot be checked, and says why', async () => {
    // `text` is no JSON Schema type: the schema never compiles, so nothing
    // here can say the input fits.
    await storeSpecs(dir, [
      quoteSpec({
        input: { type: 'object', properties: { symbol: { type: 'text' } }, required: ['symbol'] },
      }),
    ]);
    const auth = authorizer();
    const { fetchImpl, calls } = net([{ url: ROUTER, status: 200, body: {} }]);
    const result = await runRequestTool(
      { id: SPEC_ID, input: { symbol: 'BTC' } },
      deps(fetchImpl, auth),
    );
    expect(result.envelope).toMatchObject({
      status: 'failed',
      reason:
        'The spec for CoinMarketCap has an input schema this build cannot check, so the call was not sent and nothing was paid.',
      cost: ['provider price 0 USD'],
      parameters: { symbol: 'BTC' },
    });
    expect(providerCalls(calls)).toEqual([]);
    expect(auth.authorize).not.toHaveBeenCalled();
    expect(await reported(calls)).toMatchObject({ status: 'unpaid', reason: 'terms' });
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
    expect(await reported(calls)).toMatchObject({ status: 'unpaid', reason: 'terms' });
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
    expect(await reported(calls)).toMatchObject({ status: 'unpaid', reason: 'terms' });
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
    // Refused before payment: reported, as unpaid, which the server never
    // counts as the offer taken.
    expect(await reported(calls)).toMatchObject({
      status: 'unpaid',
      reason: 'input',
      httpStatus: 400,
    });
  });

  it('reports needs_approval when the spend policy refuses the call before signing', async () => {
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
    const report = await reported(calls);
    expect(report).toMatchObject({ status: 'needs_approval' });
    expect(report).not.toHaveProperty('reason');
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
    const { fetchImpl, calls } = net([
      ...providerLegs(),
      { url: ROUTER, status: 200, body: {} },
      ...providerLegs(),
    ]);
    const first = await runRequestTool(
      { id: SPEC_ID, input: { symbol: 'BTC' } },
      deps(fetchImpl, auth),
    );
    expect(first.envelope).toMatchObject({ status: 'failed' });
    expect(calls.filter((call) => call.paid)).toHaveLength(1);
    // The payment may have moved, so the call ran: `failed`, never `unpaid`.
    const report = await reported(calls);
    expect(report).toMatchObject({ status: 'failed' });
    expect(report).not.toHaveProperty('reason');
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
      { url: ROUTER, status: 200, body: {} },
      ...providerLegs(),
      { url: ROUTER, status: 200, body: {} },
    ]);
    const refused = await runRequestTool({ id: SPEC_ID, input: { symbol: '??' } }, deps(fetchImpl));
    expect(refused.envelope).toMatchObject({ status: 'failed', providerStatus: 400 });
    expect(await reported(calls)).toMatchObject({ status: 'unpaid', reason: 'input' });
    const fixed = await runRequestTool({ id: SPEC_ID, input: { symbol: 'BTC' } }, deps(fetchImpl));
    expect(fixed.envelope).toMatchObject({ status: 'fulfilled' });
    expect(calls.filter((call) => call.paid)).toHaveLength(1);
    await vi.waitFor(() => expect(routerCalls(calls)).toHaveLength(2));
    expect(JSON.parse(routerCalls(calls)[1]!.body!)).toMatchObject({ status: 'fulfilled' });
  });

  it('reports a provider that answers 503 before payment as unpaid, with its status', async () => {
    await storeSpecs(dir, [quoteSpec()]);
    const { fetchImpl, calls } = net([
      { url: PROVIDER, status: 503, body: { error: { message: 'busy' } } },
      { url: ROUTER, status: 200, body: {} },
    ]);
    const result = await runRequestTool({ id: SPEC_ID, input: { symbol: 'BTC' } }, deps(fetchImpl));
    expect(result.envelope).toMatchObject({ status: 'failed', providerStatus: 503 });
    expect(await reported(calls)).toEqual({
      schemaVersion: 1,
      id: SPEC_ID,
      harness: 'claude',
      status: 'unpaid',
      reason: 'provider',
      httpStatus: 503,
      ms: expect.any(Number) as number,
    });
  });

  it('reports a wallet that cannot be opened as unpaid for the wallet, not the terms', async () => {
    await storeSpecs(dir, [quoteSpec()]);
    const auth = authorizer();
    const { fetchImpl, calls } = net([
      { url: PROVIDER, status: 402, body: {}, headers: { 'PAYMENT-REQUIRED': challenge() } },
      { url: ROUTER, status: 200, body: {} },
    ]);
    // What a session with no passphrase to hand gets: the same USAGE code a
    // refused destination throws.
    const locked = {
      ...testWalletProvider(),
      getSigner: async () => {
        throw new CliError('USAGE', 'No wallet passphrase is available.');
      },
    };
    const base = deps(fetchImpl, auth);
    const result = await runRequestTool(
      { id: SPEC_ID, input: { symbol: 'BTC' } },
      { ...base, payDeps: { ...base.payDeps, provider: locked } },
    );
    expect(result.envelope).toMatchObject({ status: 'failed', cost: ['provider price 0 USD'] });
    expect(auth.authorize).not.toHaveBeenCalled();
    expect(await reported(calls)).toMatchObject({ status: 'unpaid', reason: 'wallet' });
  });

  /** The id-less answer: the pick's spec beside its fresh id, and the line
   *  with the call's skeleton. */
  function specAnswer(id: string): Record<string, unknown> {
    const spec: Partial<OfferSpec> = quoteSpec();
    delete spec.id;
    const call = '{"symbol":"<symbol>"}';
    return {
      schemaVersion: 1,
      routerVersion: '2026-09-23.1',
      decision: {
        action: 'spec',
        id,
        spec,
        hint: `CoinMarketCap fits this: latest market quotes. $0.01 via ${PROVIDER} . Call request({id: ${JSON.stringify(id)}, input: ${call}}) alone and wait for its result.`,
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
      accepts: ['catalog', 'spec', 'label', 'fields', 'jobs', 'headers', 'note', 'tolerant'],
      harness: 'claude',
    });
    // The next call runs from the kept spec: no second decision.
    const ran = await runRequestTool({ id: PICKED, input: { symbol: 'BTC' } }, deps(fetchImpl));
    expect(ran.envelope).toMatchObject({ status: 'fulfilled' });
    expect(calls[1]).toMatchObject({ url: `${PROVIDER}?symbol=BTC`, paid: false });
    expect(calls[2]).toMatchObject({ paid: true });
    await vi.waitFor(() => expect(calls).toHaveLength(4));
    expect(JSON.parse(calls[3]!.body!)).toMatchObject({ id: PICKED, status: 'fulfilled' });
  });

  it('pays nothing from a query with no id, even when the answer carries an input', async () => {
    const PICKED = '0195f3a1-6c4d-7a2b-9e10-5f6a7b8c9d22';
    const auth = authorizer();
    const answer = specAnswer(PICKED);
    (answer.decision as Record<string, unknown>).input = { symbol: 'BTC' };
    const { fetchImpl, calls } = net([{ url: ROUTER, status: 200, body: answer }]);
    const result = await runRequestTool({ query: 'BTC spot price' }, deps(fetchImpl, auth));
    // A spec answer is a pick, never a run: an input an older router bound
    // still parses, and the spec is kept and shown with its skeleton, but
    // nothing reaches the provider and nothing is signed.
    expect(result.isError).toBe(false);
    expect(result.envelope).toMatchObject({ status: 'spec', id: PICKED });
    expect(String(result.envelope.nextStep)).toContain(
      `request({id: ${JSON.stringify(PICKED)}, input: {"symbol":"<symbol>"}})`,
    );
    // Kept: the id alone shows the spec from this machine, with no second call.
    const shown = await runRequestTool({ id: PICKED }, deps(fetchImpl, auth));
    expect(shown.envelope).toMatchObject({ status: 'spec', id: PICKED });
    expect(calls).toHaveLength(1);
    expect(auth.authorize).not.toHaveBeenCalled();
  });

  it("shows the paired skeleton answer's spec and the line to fill, and pays nothing", async () => {
    const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
    const answer = JSON.parse(
      await readFile(join(fixtures, 'wire-lookup-spec-skeleton.json'), 'utf8'),
    ) as { decision: { id: string; hint: string; spec: OfferSpec } };
    const auth = authorizer();
    const { fetchImpl, calls } = net([{ url: ROUTER, status: 200, body: answer }]);
    const result = await runRequestTool(
      { query: 'Patrick Collison at Stripe' },
      deps(fetchImpl, auth),
    );
    const { id, hint, spec } = answer.decision;
    expect(result.envelope).toMatchObject({ status: 'spec', id, nextStep: hint });
    expect(result.summary).toContain(`${spec.provider}: ${spec.description}`);
    expect(result.summary).toContain(`Next: ${hint}`);
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

  it('builds nothing for an id it holds no spec for, and sends only a query with it', async () => {
    const { fetchImpl, calls } = net([{ url: ROUTER, status: 200, body: NATIVE }]);
    const result = await runRequestTool({ id: SPEC_ID }, deps(fetchImpl));
    expect(result.envelope).toMatchObject({ status: 'needs_input' });
    expect(String(result.envelope.reason)).toContain('No spec is kept for that id');
    // An input for it is answered here: no server call, nothing paid.
    const withInput = await runRequestTool(
      { id: SPEC_ID, input: { symbol: 'BTC' } },
      deps(fetchImpl),
    );
    expect(withInput.envelope).toMatchObject({ status: 'needs_input' });
    expect(String(withInput.envelope.nextStep)).toContain('request({query})');
    expect(calls).toEqual([]);
    // A query with it goes to the server, which binds the free docs offer.
    const withQuery = await runRequestTool({ id: SPEC_ID, query: 'BTC price' }, deps(fetchImpl));
    expect(withQuery.envelope).toMatchObject({ status: 'native' });
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      schemaVersion: 1,
      query: 'BTC price',
      id: SPEC_ID,
      accepts: ['catalog', 'spec', 'label', 'fields', 'jobs', 'headers', 'note', 'tolerant'],
      harness: 'claude',
    });
  });
});

/**
 * ONE CHOICE FROM A LINE'S SET is that option's own offer: its spec, its id,
 * its one payment and its outcome report, exactly as `request({id: option.id})`
 * would run it. `all` is `choices.test.ts`.
 */
describe('a choice from the set a line offered', () => {
  const read = async () =>
    JSON.parse(
      await readFile(
        fileURLToPath(new URL('./fixtures/wire-hook-discovered-choices.json', import.meta.url)),
        'utf8',
      ),
    ) as { decision: { id: string; hint: string; specs: OfferSpec[]; choices: Choices } };
  const keep = async () => {
    const { decision } = await read();
    await storeSpecs(dir, decision.specs);
    await storeChoices(dir, decision.id, { choices: decision.choices, hint: decision.hint });
    // The option that is not the line's own offer: a choice is what runs it.
    return { id: decision.id, other: decision.specs[1]! };
  };

  it("runs the chosen option's spec under the option's own id", async () => {
    const { id, other } = await keep();
    const { fetchImpl, calls } = net([
      {
        url: other.request.url,
        status: 402,
        body: {},
        headers: { 'PAYMENT-REQUIRED': challenge({ amount: '50000', payTo: other.payTo }) },
      },
      { url: other.request.url, status: 200, body: { id: 'img_1', data: [] } },
      { url: ROUTER, status: 200, body: {} },
    ]);
    const result = await runRequestTool(
      { id, choice: 'nano-banana-2.1', input: { prompt: 'a lighthouse at dusk' } },
      deps(fetchImpl),
    );
    expect(result.envelope).toMatchObject({
      status: 'fulfilled',
      supplier: 'x402.aispace.bot',
      cost: ['provider price 0.05 USD'],
    });
    expect(calls[0]).toMatchObject({ url: other.request.url, paid: false });
    expect(JSON.parse(calls[1]!.body!)).toEqual({
      prompt: 'a lighthouse at dusk',
      model: 'nano-banana-2-1',
      resolution: '1K',
      return_binary: true,
    });
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    expect(JSON.parse(calls[2]!.body!)).toMatchObject({ id: other.id, status: 'fulfilled' });
    // The payment was claimed under the option's id, which pays once.
    const again = await runRequestTool(
      { id: other.id, input: { prompt: 'a lighthouse at dusk' } },
      deps(fetchImpl),
    );
    expect(String(again.envelope.reason)).toContain('already paid for');
  });

  it("shows the chosen option's spec when no input comes with it, and pays nothing", async () => {
    const { id, other } = await keep();
    const { fetchImpl, calls } = net([]);
    const result = await runRequestTool({ id, choice: 'nano-banana-2.1' }, deps(fetchImpl));
    expect(result.envelope).toMatchObject({ status: 'spec', id: other.id });
    expect(result.summary).toContain('Nano Banana 2.1');
    expect(calls).toEqual([]);
  });

  it('refuses a choice for an id with no set kept, and a key the set does not name', async () => {
    const { decision } = await read();
    const { fetchImpl, calls } = net([]);
    const none = await runRequestTool(
      { id: decision.id, choice: 'nano-banana-2.1', input: { prompt: 'x' } },
      deps(fetchImpl),
    );
    expect(none.envelope).toMatchObject({ status: 'needs_input' });
    expect(String(none.envelope.reason)).toContain('No choices are kept');
    await keep();
    const unknown = await runRequestTool(
      { id: decision.id, choice: 'flux', input: { prompt: 'x' } },
      deps(fetchImpl),
    );
    expect(unknown.envelope).toMatchObject({ status: 'needs_input' });
    expect(String(unknown.envelope.reason)).toContain('"gpt-image-2.5", "nano-banana-2.1", "all"');
    expect(calls).toEqual([]);
  });
});

/**
 * A SPEC THAT NAMES THE FIELDS IT RETURNS. The success rule runs on the whole
 * body; the agent is then handed only the promised fields, and the whole body
 * is saved by the offer's id. An Apollo person hit embeds the employer's whole
 * organization record, which is what made a good match too large to check.
 */
describe('a spec that names the fields it returns', () => {
  async function apolloSpec(id: string): Promise<OfferSpec> {
    const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
    const answer = JSON.parse(
      await readFile(join(fixtures, 'wire-lookup-spec-skeleton.json'), 'utf8'),
    ) as { decision: { spec: Omit<OfferSpec, 'id'> } };
    return { ...answer.decision.spec, id };
  }
  const INPUT = { first_name: 'Patrick', last_name: 'Collison', domain: 'stripe.com' };
  const PROMISED = {
    match_confidence: 'high',
    name: 'Patrick Collison',
    title: 'CEO',
    headline: 'Co-founder and CEO at Stripe',
    linkedin_url: 'http://www.linkedin.com/in/patrickcollison',
    email: 'patrick@stripe.com',
    email_status: 'verified',
    city: 'San Francisco',
    state: 'California',
    country: 'United States',
  };
  function hit(technologies: number) {
    return {
      person: {
        ...PROMISED,
        id: '5f2a',
        first_name: 'Patrick',
        last_name: 'Collison',
        photo_url: 'https://example.test/p.jpg',
        organization: {
          name: 'Stripe',
          primary_domain: 'stripe.com',
          website_url: 'http://www.stripe.com',
          linkedin_url: 'http://www.linkedin.com/company/stripe',
          technologies: Array.from({ length: technologies }, (_, i) => ({
            uid: `technology_${i}`,
            name: `Technology ${i}`,
            category: 'Other',
          })),
        },
        employment_history: [
          {
            organization_name: 'Stripe',
            title: 'CEO',
            start_date: '2010-01-01',
            end_date: null,
            current: true,
            description: 'Payments infrastructure for the internet.',
            organization_id: '5f2b',
          },
        ],
      },
    };
  }
  function legsFor(spec: OfferSpec, body: unknown, raw?: string): Leg[] {
    const quote = challenge({ payTo: spec.payTo, amount: spec.maxAmountAtomic });
    return [
      { url: spec.request.url, status: 402, body: {}, headers: { 'PAYMENT-REQUIRED': quote } },
      { url: spec.request.url, status: 200, body, ...(raw !== undefined ? { raw } : {}) },
      { url: ROUTER, status: 200, body: {} },
    ];
  }
  const savedAt = (id: string) =>
    join(dir, 'results', `${createHash('sha256').update(id).digest('hex')}.json`);

  it('checks a 150 KB hit on the whole body, hands back the promised fields, and saves the whole body', async () => {
    const id = '0195f3a1-6c4d-7a2b-9e10-5f6a7b8c9d31';
    const spec = await apolloSpec(id);
    await storeSpecs(dir, [spec]);
    const body = hit(2_500);
    const text = JSON.stringify(body);
    expect(Buffer.byteLength(text)).toBeGreaterThan(150 * 1024);
    const { fetchImpl } = net(legsFor(spec, body));
    const result = await runRequestTool({ id, input: INPUT }, deps(fetchImpl));
    expect(result.isError).toBe(false);
    expect(result.envelope).toMatchObject({ status: 'fulfilled', fullResultPath: savedAt(id) });
    expect(result.envelope.resultCaveat).toBeUndefined();
    expect(JSON.parse(String(result.envelope.result))).toEqual({
      person: {
        ...PROMISED,
        organization: {
          name: 'Stripe',
          primary_domain: 'stripe.com',
          website_url: 'http://www.stripe.com',
          linkedin_url: 'http://www.linkedin.com/company/stripe',
        },
        employment_history: [
          {
            organization_name: 'Stripe',
            title: 'CEO',
            start_date: '2010-01-01',
            end_date: null,
            current: true,
          },
        ],
      },
    });
    // The whole body, byte for byte, readable by this user alone.
    expect(await readFile(savedAt(id), 'utf8')).toBe(text);
    if (process.platform !== 'win32') {
      expect((await stat(savedAt(id))).mode & 0o777).toBe(0o600);
    }
  });

  it('cuts a billed miss the same way, unverified, with the whole body saved', async () => {
    const id = '0195f3a1-6c4d-7a2b-9e10-5f6a7b8c9d32';
    const spec = await apolloSpec(id);
    await storeSpecs(dir, [spec]);
    const miss = { person: { match_confidence: 'none', email: null, search_id: 'abc' } };
    const { fetchImpl } = net(legsFor(spec, miss));
    const result = await runRequestTool({ id, input: INPUT }, deps(fetchImpl));
    expect(result.isError).toBe(true);
    expect(result.envelope).toMatchObject({ status: 'unverified', fullResultPath: savedAt(id) });
    expect(String(result.envelope.resultCaveat)).toContain('match_confidence');
    expect(JSON.parse(String(result.envelope.result))).toEqual({
      person: { match_confidence: 'none', email: null },
    });
    expect(await readFile(savedAt(id), 'utf8')).toBe(JSON.stringify(miss));
  });

  it('hands back an over-cap body whole and unverified, as before, and saves nothing', async () => {
    const id = '0195f3a1-6c4d-7a2b-9e10-5f6a7b8c9d33';
    const spec = await apolloSpec(id);
    await storeSpecs(dir, [spec]);
    const body = { person: { ...PROMISED, blob: 'x'.repeat(MAX_BODY_BYTES) } };
    const { fetchImpl } = net(legsFor(spec, body));
    const result = await runRequestTool({ id, input: INPUT }, deps(fetchImpl));
    expect(result.envelope).toMatchObject({ status: 'unverified' });
    expect(String(result.envelope.resultCaveat)).toContain('not checked');
    expect(result.envelope.result).toBe(JSON.stringify(body));
    expect(result.envelope).not.toHaveProperty('fullResultPath');
    await expect(readdir(join(dir, 'results'))).rejects.toThrow();
  });

  it('hands back the whole body when it cannot be saved, and never fails the call over it', async () => {
    const id = '0195f3a1-6c4d-7a2b-9e10-5f6a7b8c9d34';
    const spec = await apolloSpec(id);
    await storeSpecs(dir, [spec]);
    // A file where the directory should be: the save fails.
    await writeFile(join(dir, 'results'), 'not a directory');
    const body = hit(10);
    const { fetchImpl } = net(legsFor(spec, body));
    const result = await runRequestTool({ id, input: INPUT }, deps(fetchImpl));
    expect(result.isError).toBe(false);
    expect(result.envelope).toMatchObject({ status: 'fulfilled', result: JSON.stringify(body) });
    expect(result.envelope).not.toHaveProperty('fullResultPath');
  });
});

/**
 * WHAT A FAILED SPEC CALL REPORTS, from the error alone: money that may have
 * moved is `failed`, the spend policy `needs_approval`, and anything stopped
 * before a signature is `unpaid` with the side that stopped it.
 */
describe('the outcome a failed call reports', () => {
  const error = (code: ConstructorParameters<typeof CliError>[0], details?: unknown) =>
    new CliError(code, 'x', details !== undefined ? { details } : {});
  const before = { mayHaveMoved: false, rejectedInput: false };
  const moved = { mayHaveMoved: true, rejectedInput: false };

  it.each([
    ['another status', error('API_UNREACHABLE', { status: 503 }), 'provider'],
    ['a 400 to an input the server built', error('API_UNREACHABLE', { status: 400 }), 'provider'],
    ['a redirect this build will not follow', error('API_UNREACHABLE'), 'provider'],
    ['a challenge with no header', error('CONTRACT_MISMATCH'), 'provider'],
    ['a challenge too large to read', error('CHALLENGE_TOO_LARGE'), 'provider'],
    ['a dead socket or a timeout', error('NETWORK_ERROR'), 'unreachable'],
    ['a 402 off the spec terms', error('REGISTRY_MISMATCH'), 'terms'],
    ['nothing payable, or a price that rose', error('PAYMENT_FAILED'), 'terms'],
    ['terms this build refuses', error('REFUSED', { reason: 'invalid_router_terms' }), 'terms'],
    ['a destination this build will not pay', error('USAGE'), 'terms'],
    ['a locked wallet', error('USAGE', { walletUnavailable: true }), 'wallet'],
    ['no wallet', error('WALLET_MISSING', { walletUnavailable: true }), 'wallet'],
    ['too little USDC', error('REFUSED', { reason: 'insufficient_funds' }), 'wallet'],
    ['an unreadable balance', error('REFUSED', { reason: 'balance_unavailable' }), 'wallet'],
  ])('%s before payment is unpaid', (_label, err, reason) => {
    expect(failureOutcome(err, before)).toEqual({ status: 'unpaid', reason });
  });

  it('says input for an input the agent built that the provider refused', () => {
    expect(
      failureOutcome(error('API_UNREACHABLE', { status: 422 }), { ...before, rejectedInput: true }),
    ).toEqual({ status: 'unpaid', reason: 'input' });
  });

  it.each([
    ['a paid leg that never answered', error('NETWORK_ERROR', { amountAtomic: '10000' })],
    ['a payment the seller refused', error('PAYMENT_FAILED', { status: 402 })],
    ['a bug after the payment left', new Error('boom')],
  ])('keeps %s, which may have moved money, as failed', (_label, err) => {
    expect(failureOutcome(err, moved)).toEqual({ status: 'failed' });
  });

  it('keeps the spend policy as needs_approval', () => {
    expect(failureOutcome(error('POLICY_REFUSED'), before)).toEqual({ status: 'needs_approval' });
  });

  it.each([
    ['a failure no reason describes', error('INTERNAL')],
    ['a bug before anything was signed', new TypeError('boom')],
  ])('reports nothing for %s', (_label, err) => {
    expect(failureOutcome(err, before)).toBeNull();
  });
});

/**
 * B1: the request tool's text is read by the MODEL, so an error carrying
 * `details.unlock` reaches it with that reason's `agentFix` (ask the person,
 * never ask for the passphrase). Every other CliError keeps its own fix.
 */
describe('the fix a failed request hands the model', () => {
  const text = (result: Awaited<ReturnType<typeof runRequestTool>>) =>
    `${result.summary}\n${JSON.stringify(result.envelope)}`;

  async function failsWith(err: CliError) {
    const { fetchImpl } = net([
      { url: ROUTER, status: 200, body: decision() },
      { url: PROVIDER, status: 402, body: {}, headers: { 'PAYMENT-REQUIRED': challenge() } },
    ]);
    vi.mocked(runPay).mockRejectedValueOnce(err);
    return runRequestTool({ query: 'BTC and ETH price', id: 'k3f9-abcd' }, deps(fetchImpl));
  }

  it('swaps a passphrase_missing fix for the ask-the-person one', async () => {
    const result = await failsWith(
      new CliError('PROVIDER_ERROR', 'no saved passphrase can be reached', {
        fix: WALLET_REASONS.passphrase_missing.fix,
        details: unlockDetails('passphrase_missing', 'file'),
      }),
    );
    expect(text(result)).toContain(ASK_FOR_REPAIR);
    expect(text(result)).not.toContain('TENJIN_WALLET_PASSPHRASE=');
    expect(text(result)).not.toContain(REPAIR_CLAUSE);
  });

  it('keeps a non-wallet CliError fix, and never swaps in wallet advice', async () => {
    const result = await failsWith(
      new CliError('REGISTRY_MISMATCH', 'the live terms differ', { fix: 'X-fix' }),
    );
    expect(text(result)).toContain('X-fix');
    expect(text(result)).not.toContain('Run `tenjin doctor`.');
    for (const entry of Object.values(WALLET_REASONS)) {
      expect(text(result)).not.toContain(entry.agentFix);
    }
  });

  it('keeps an undetailed WALLET_MISSING fix byte for byte', async () => {
    const fix = 'Run `tenjin wallet create` to make one, then retry.';
    const result = await failsWith(new CliError('WALLET_MISSING', 'no wallet here', { fix }));
    expect(text(result)).toContain(`no wallet here ${fix}`);
    expect(text(result)).not.toContain(ASK_FOR_REPAIR);
  });
});

/**
 * THE TOOL LIST, READ FOR FREE, end to end against a scripted router: a browse
 * returns the server's rows and pays nothing, a row's id fetched with `tool`
 * keeps its spec under the fresh id the server minted, and `{id, input}` then
 * runs that spec like any offer. Neither read takes the paid routing path.
 */
describe('the tool list, read for free', () => {
  const wire = (name: string): Record<string, unknown> =>
    JSON.parse(
      readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8'),
    ) as Record<string, unknown>;
  const BROWSE = wire('wire-browse.json');
  const BY_ID = wire('wire-lookup-spec-by-id.json');
  const ACCEPTS = ['catalog', 'spec', 'label', 'fields', 'jobs', 'headers', 'note', 'tolerant'];
  /** A paid routing path that must never be asked. */
  const route = vi.fn(async () => {
    throw new Error('the paid routing path was asked');
  });

  it('lists the rows for a need, sends only the browse, and pays nothing', async () => {
    const { fetchImpl, calls } = net([{ url: ROUTER, status: 200, body: BROWSE }]);
    const auth = authorizer();
    const result = await runRequestTool(
      { browse: 'live crypto prices' },
      { ...deps(fetchImpl, auth), route },
    );
    expect(result.isError).toBe(false);
    expect(result.envelope).toMatchObject({
      status: 'browse',
      cost: ['provider price 0 USD'],
      rows: [
        { id: 'cmc-quotes', label: 'CoinMarketCap quotes', price: '1¢' },
        { id: 'stableenrich-exa-answer', label: 'Exa Answer', kind: 'Web research' },
      ],
    });
    expect(result.summary).toContain(
      'CoinMarketCap quotes (id cmc-quotes, 1¢, Live crypto prices)',
    );
    expect(result.summary).toContain('request({tool: "<id>"})');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: `${ROUTER}${ROUTER_PATH}`, method: 'POST', paid: false });
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      schemaVersion: 1,
      browse: 'live crypto prices',
      accepts: ACCEPTS,
      harness: 'claude',
    });
    expect(route).not.toHaveBeenCalled();
    expect(auth.authorize).not.toHaveBeenCalled();
  });

  it('names the Codex harness on a browse and on a row id request', async () => {
    const listed = net([{ url: ROUTER, status: 200, body: BROWSE }]);
    await runRequestTool(
      { browse: 'live crypto prices' },
      { ...deps(listed.fetchImpl), route, harness: 'codex' },
    );
    expect(JSON.parse(listed.calls[0]!.body!)).toMatchObject({ harness: 'codex' });
    const spec = net([{ url: ROUTER, status: 200, body: BY_ID }]);
    await runRequestTool(
      { tool: 'cmc-quotes' },
      { ...deps(spec.fetchImpl), route, harness: 'codex' },
    );
    expect(JSON.parse(spec.calls[0]!.body!)).toMatchObject({
      tool: 'cmc-quotes',
      harness: 'codex',
    });
  });

  it('browses every tool for an empty need, and says so when none fit', async () => {
    const { fetchImpl, calls } = net([{ url: ROUTER, status: 200, body: { ...BROWSE, rows: [] } }]);
    const result = await runRequestTool({ browse: '' }, deps(fetchImpl));
    expect(JSON.parse(calls[0]!.body!)).toMatchObject({ browse: '' });
    expect(result).toMatchObject({ isError: false, envelope: { status: 'browse', rows: [] } });
    expect(result.summary).toMatch(/^No tool in the list fits/);
  });

  it('shows a free row as free and flattens the text to one line', async () => {
    const rows = BROWSE.rows as Record<string, unknown>[];
    const { fetchImpl } = net([
      {
        url: ROUTER,
        status: 200,
        body: {
          ...BROWSE,
          rows: [{ ...rows[0]!, does: 'Live\ncrypto‮prices', free: true, price: 'Free' }],
        },
      },
    ]);
    const result = await runRequestTool({ browse: 'prices' }, deps(fetchImpl));
    expect(result.envelope).toMatchObject({
      rows: [{ does: 'Live crypto prices', price: 'free' }],
    });
  });

  it.each([
    ['an id', { browse: 'prices', id: 'k3f9-abcd' }],
    ['a query', { tool: 'cmc-quotes', query: 'prices' }],
    ['both forms', { browse: 'prices', tool: 'cmc-quotes' }],
  ])('refuses a read of the list sent with %s, and sends nothing', async (_label, args) => {
    const { fetchImpl, calls } = net([]);
    const result = await runRequestTool(args, deps(fetchImpl));
    expect(result.envelope).toMatchObject({ status: 'needs_input' });
    expect(calls).toEqual([]);
  });

  it('never sends a need that carries a credential', async () => {
    const { fetchImpl, calls } = net([]);
    const result = await runRequestTool(
      { browse: 'use sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' },
      deps(fetchImpl),
    );
    expect(result.envelope).toMatchObject({ status: 'native' });
    expect(calls).toEqual([]);
  });

  it('reads an answer it cannot parse as a failure, with nothing paid', async () => {
    const { fetchImpl } = net([
      { url: ROUTER, status: 200, body: { ...BROWSE, schemaVersion: 2 } },
    ]);
    const result = await runRequestTool({ browse: 'prices' }, deps(fetchImpl));
    expect(result).toMatchObject({
      isError: true,
      envelope: { status: 'failed', cost: ['provider price 0 USD'] },
    });
  });

  it("keeps a row's spec under the server's id, then runs it from {id, input}", async () => {
    await noteSession(dir, 'sess-1');
    const decision = BY_ID.decision as { id: string; spec: Record<string, unknown> };
    const served = {
      ...BY_ID,
      decision: {
        ...decision,
        spec: {
          ...decision.spec,
          payTo: '0x1111111111111111111111111111111111111111',
          request: { ...(decision.spec.request as object), url: PROVIDER },
        },
      },
    };
    const first = net([{ url: ROUTER, status: 200, body: served }]);
    const shown = await runRequestTool({ tool: 'cmc-quotes' }, { ...deps(first.fetchImpl), route });
    expect(shown.envelope).toMatchObject({ status: 'spec', id: decision.id });
    expect(shown.summary).toContain(`request({id: "${decision.id}"`);
    expect(JSON.parse(first.calls[0]!.body!)).toEqual({
      schemaVersion: 1,
      tool: 'cmc-quotes',
      accepts: ACCEPTS,
      harness: 'claude',
    });
    expect(route).not.toHaveBeenCalled();

    const second = net([...providerLegs(), { url: ROUTER, status: 200, body: {} }]);
    const ran = await runRequestTool(
      { id: decision.id, input: { symbol: 'BTC,ETH', convert: 'USD' } },
      deps(second.fetchImpl),
    );
    expect(ran.envelope).toMatchObject({ status: 'fulfilled', cost: ['provider price 0.01 USD'] });
    // The footer names the service by its label, and the ledger keeps it.
    expect(await renderProgress(dir, 'sess-1')).toBe(
      'x402 · request: fulfilled CoinMarketCap quotes · {"symbol":"BTC,ETH","convert":"USD"} · $0.01',
    );
    const ledger = (await readFile(join(dir, 'paid', 'ledger.jsonl'), 'utf8')).trim().split('\n');
    expect(JSON.parse(ledger.at(-1)!)).toMatchObject({
      capabilityId: 'cmc-quotes',
      label: 'CoinMarketCap quotes',
    });
  });

  it('skips a spec that needs a feature this build lacks, by name, and keeps nothing', async () => {
    const decision = BY_ID.decision as { id: string; spec: Record<string, unknown> };
    const served = {
      ...BY_ID,
      decision: { ...decision, spec: { ...decision.spec, requires: ['streaming'] } },
    };
    const { fetchImpl } = net([{ url: ROUTER, status: 200, body: served }]);
    const result = await runRequestTool({ tool: 'cmc-quotes' }, deps(fetchImpl));
    expect(result).toMatchObject({
      isError: false,
      envelope: { status: 'native', reasonCode: 'requires_unmet', missing: ['streaming'] },
    });
    expect(result.summary).toContain('`streaming`');
    const ran = await runRequestTool(
      { id: decision.id, input: { symbol: 'BTC' } },
      deps(net([]).fetchImpl),
    );
    expect(ran.envelope).toMatchObject({ status: 'needs_input' });
  });

  it("passes on the server's needs_input for a row with no spec, and keeps nothing", async () => {
    const answer = {
      schemaVersion: 1,
      routerVersion: 'v',
      decision: {
        action: 'needs_input',
        reason:
          'This tool has no spec: call request({query}) with the task, and it is looked up from there.',
        diagnostics: { reasonCode: 'spec_missing', stage: 'bind', missing: [], nextAction: '' },
      },
    };
    const { fetchImpl } = net([{ url: ROUTER, status: 200, body: answer }]);
    const result = await runRequestTool({ tool: 'context7-docs' }, deps(fetchImpl));
    expect(result.envelope).toMatchObject({ status: 'needs_input', reasonCode: 'spec_missing' });
    expect(result.summary).toContain('request({query})');
  });
});
