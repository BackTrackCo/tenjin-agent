import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPaymentRequired, testWalletProvider } from '../lib/read-test-utils';
import { resolveSpendAuthorizer } from '../lib/wallet';
import type { SpendAuthorization, SpendAuthorizer } from '../lib/wallet';
import type { CommandContext } from '../context';
import { runRequestTool } from './tool';
import { ROUTER_PATH } from './decision';

/**
 * The `request` tool after the fee: ONE free decision, then ONE payment, to the
 * provider. The id is the fast path and the query is always sent, so every test
 * here is about which decision ran, what it cost, and what the host is told.
 */

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'router-tool-'));
  await writeFile(
    join(dir, 'config.json'),
    JSON.stringify({ bazaarPay: true, maxAutoSpend: '250000', sessionBudget: '5000000' }),
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
    method: 'GET',
    url: PROVIDER,
    arguments: { symbol: 'BTC,ETH', convert: 'USD' },
    argumentSchema: {
      type: 'object',
      properties: { symbol: { type: 'string' }, convert: { type: 'string' } },
      required: ['symbol'],
      additionalProperties: false,
    },
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
      description: 'crypto price quote via pro-api.example.test',
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
    authorizer: auth,
    fetchImpl,
    payDeps: { fetchImpl, provider: testWalletProvider(), authorizer: auth, destination: PUBLIC },
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
    ['arguments that fail their own schema', contract({ arguments: { convert: 'USD' } })],
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

  /**
   * THE ONLY MONEY RULE: the amount actually signed meets the local policy.
   * There is no advertised-price check any more, so a decision naming a price
   * changes nothing; the live 402 is what the spend gate sees.
   */
  it('refuses at the spend gate when the live price is over the cap', async () => {
    const { fetchImpl } = net([
      { url: ROUTER, status: 200, body: decision() },
      {
        url: PROVIDER,
        status: 402,
        body: {},
        headers: { 'PAYMENT-REQUIRED': challenge({ amount: '900000' }) },
      },
    ]);
    const real = {
      ctx: ctx(),
      authorizer: resolveSpendAuthorizer(ctx(), {
        maxAutoSpendAtomic: 250_000n,
        sessionBudgetAtomic: 5_000_000n,
        confirm: { mode: 'above' as const, thresholdAtomic: 250_000n },
        allowlistCreators: [],
      }),
      fetchImpl,
      payDeps: { fetchImpl, provider: testWalletProvider(), destination: PUBLIC },
    };
    const result = await runRequestTool({ query: 'q' }, real);
    expect(result.envelope).toMatchObject({ status: 'needs_approval' });
    expect(result.isError).toBe(false);
  });

  it('pays under the cap with no prompt at all', async () => {
    const { fetchImpl } = net([{ url: ROUTER, status: 200, body: decision() }, ...providerLegs()]);
    const real = {
      ctx: ctx(),
      authorizer: resolveSpendAuthorizer(ctx(), {
        maxAutoSpendAtomic: 250_000n,
        sessionBudgetAtomic: 5_000_000n,
        confirm: { mode: 'above' as const, thresholdAtomic: 250_000n },
        allowlistCreators: [],
      }),
      fetchImpl,
      payDeps: { fetchImpl, provider: testWalletProvider(), destination: PUBLIC },
    };
    const result = await runRequestTool({ query: 'q' }, real);
    expect(result.envelope).toMatchObject({ status: 'fulfilled' });
  });
});
