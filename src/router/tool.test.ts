import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import type { PaymentRequired } from '@x402/core/types';
import { buildPaymentRequired, testWalletProvider } from '../lib/read-test-utils';
import { resolveSpendAuthorizer } from '../lib/wallet';
import type { SpendAuthorization, SpendAuthorizer } from '../lib/wallet';
import type { TenjinSigner } from '../lib/wallet/provider';
import type { CommandContext } from '../context';
import { RequirementsCache } from './decision';
import { runRequestTool } from './tool';
import { buildPromptPacket } from './context';
import { writeSessionPacket } from './session-file';

let dir: string;
let signer: TenjinSigner;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'router-tool-'));
  await writeFile(
    join(dir, 'config.json'),
    JSON.stringify({ bazaarPay: true, maxAutoSpend: '100000', sessionBudget: '1000000' }),
  );
  signer = await testWalletProvider().getSigner();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ROUTER = 'https://tenjin.sh';
const PROVIDER = 'https://pro-api.example.test/x402/v3/quotes';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

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
  const args = (over.arguments ?? { symbol: 'BTC,ETH', convert: 'USD' }) as Record<string, unknown>;
  // The server builds the request; the client sends it verbatim. Built here the
  // way the server does so a fixture cannot drift from what production sends.
  const built = new URL(PROVIDER);
  for (const [key, value] of Object.entries(args)) {
    if (value !== null && typeof value !== 'object') built.searchParams.set(key, String(value));
  }
  return {
    method: 'GET',
    url: PROVIDER,
    request: {
      url: built.toString(),
      method: 'GET',
      headers: { accept: 'application/json' },
      ...((over.request as Record<string, unknown> | undefined) ?? {}),
    },
    arguments: { symbol: 'BTC,ETH', convert: 'USD' },
    argumentSchema: {
      type: 'object',
      properties: { symbol: { type: 'string' }, convert: { type: 'string' } },
      required: ['symbol'],
      additionalProperties: false,
    },
    advertised: { network: 'eip155:8453', asset: USDC, maxAmountAtomic: '100000' },
    registryListed: true,
    ...over,
  };
}

/**
 * A decision as the 2026-09-23 contract puts it on the wire: `billing` on every
 * 200, settled only for an executable decision, and `diagnostics` on every
 * outcome this client cannot execute. `billing` and `diagnostics` here can be
 * overridden per test, and the defaults follow the action so a fixture cannot
 * claim a fee for an answer the router waives.
 */
function decision(over: Record<string, unknown> = {}): unknown {
  const inner = { action: 'execute', capabilityId: 'cmc-quotes', contract: contract(), ...over };
  const executed = inner.action === 'execute';
  const { billing, diagnostics, ...decisionFields } = inner as Record<string, unknown>;
  return {
    schemaVersion: 1,
    routerVersion: '2026-09-23.1',
    requestId: 'r-1',
    decision: decisionFields,
    billing: billing ?? {
      settled: executed,
      amountAtomic: executed ? '1000' : '0',
      asset: USDC,
      network: 'eip155:8453',
      reasonCode: executed ? 'executed' : `waived_${String(decisionFields.action)}`,
    },
    ...(executed
      ? {}
      : {
          diagnostics: diagnostics ?? {
            reasonCode: inner.action === 'native' ? 'covered_by_host_tools' : 'unresolved_intent',
            stage: inner.action === 'native' ? 'capability' : 'bind',
            missing: [],
            nextAction: '',
          },
        }),
  };
}

interface Leg {
  url: string;
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}
/** A scripted network: legs are matched in order, and every request is recorded. */
function net(legs: Leg[]): { fetchImpl: typeof fetch; calls: { url: string; paid: boolean }[] } {
  const calls: { url: string; paid: boolean }[] = [];
  const queue = [...legs];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? {}).forEach((v, k) => {
      headers[k] = v;
    });
    calls.push({ url: String(input), paid: headers['payment-signature'] !== undefined });
    const leg = queue.shift();
    if (leg === undefined) throw new Error(`unscripted request to ${String(input)}`);
    return new Response(JSON.stringify(leg.body), {
      status: leg.status,
      headers: { 'content-type': 'application/json', ...leg.headers },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function challenge(over: Partial<PaymentRequired['accepts'][number]> = {}): string {
  return buildPaymentRequired({ amount: '1000', ...over }).header;
}

function deps(fetchImpl: typeof fetch, auth = authorizer()) {
  return {
    ctx: ctx(),
    signer,
    authorizer: auth,
    cache: new RequirementsCache(),
    fetchImpl,
    payDeps: { fetchImpl, provider: testWalletProvider(), authorizer: auth, destination: PUBLIC },
  };
}

const PUBLIC = { resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }] };

describe('the request tool', () => {
  it('pays the decision, pays the provider, and reports both costs', async () => {
    const { fetchImpl, calls } = net([
      { url: ROUTER, status: 402, body: {}, headers: { 'PAYMENT-REQUIRED': challenge() } },
      { url: ROUTER, status: 200, body: decision() },
      {
        url: PROVIDER,
        status: 402,
        body: {},
        headers: { 'PAYMENT-REQUIRED': challenge({ amount: '10000' }) },
      },
      { url: PROVIDER, status: 200, body: { data: { BTC: 1 } } },
    ]);
    const result = await runRequestTool({ query: 'BTC and ETH in USD' }, deps(fetchImpl));
    expect(result.isError).toBe(false);
    expect(result.envelope).toMatchObject({
      status: 'fulfilled',
      supplier: 'pro-api.example.test',
      parameters: { symbol: 'BTC,ETH', convert: 'USD' },
      cost: ['router fee 0.001 USD', 'provider price 0.01 USD'],
      providerContentUntrusted: true,
    });
    expect(calls.map((c) => c.paid)).toEqual([false, true, false, true]);
    expect(calls[3]!.url).toContain('symbol=BTC%2CETH');
  });

  /**
   * A ROUTING OUTCOME IS NOT A TOOL FAILURE. `native`, `needs_input` and
   * `needs_approval` are the router answering; raising the MCP error flag on
   * them put a red box in front of the user on the most ordinary answer there
   * is. The status still says what happened, the next step says what to do, and
   * the routing fee is still reported.
   */
  it.each([
    ['native', { action: 'native', reason: 'Your own tools cover this.' }, 'Continue with'],
    ['needs_input', { action: 'needs_input', reason: 'Name the coins.' }, 'Ask the user'],
  ])(
    'returns %s as a normal result with its status, next step and waived fee',
    async (status, over, nextStep) => {
      const { fetchImpl, calls } = net([
        { url: ROUTER, status: 402, body: {}, headers: { 'PAYMENT-REQUIRED': challenge() } },
        { url: ROUTER, status: 200, body: decision({ ...over, contract: undefined }) },
      ]);
      const result = await runRequestTool({ query: 'something' }, deps(fetchImpl));
      expect(result.isError).toBe(false);
      expect(result.summary).not.toContain('x402 request');
      expect(result.envelope).toMatchObject({ status, reason: over.reason });
      expect(String(result.envelope.nextStep)).toContain(nextStep);
      // THE FEE IS WHAT SETTLED. The router waives an outcome it cannot execute,
      // and the authorization it never took rides separately as exposure.
      expect(result.envelope.cost).toEqual(['router fee 0 USD', 'provider price 0 USD']);
      expect(result.envelope.authorizationExposure).toBe('0.001');
      expect(calls).toHaveLength(2);
    },
  );

  it('still marks a genuine failure as an error', async () => {
    const { fetchImpl } = net([
      { url: ROUTER, status: 402, body: {}, headers: { 'PAYMENT-REQUIRED': challenge() } },
      { url: ROUTER, status: 200, body: { nope: true } },
    ]);
    const result = await runRequestTool({ query: 'something' }, deps(fetchImpl));
    expect(result.isError).toBe(true);
    expect(result.envelope).toMatchObject({ status: 'failed' });
    expect(result.envelope.nextStep).toBeUndefined();
  });

  it.each([
    [
      'arguments that fail their own schema',
      { contract: contract({ arguments: { convert: 'USD' } }) },
    ],
    [
      'a success rule this build will not compile',
      { contract: contract({ resultSchema: { type: 'string', pattern: '^(a+)+$' } }) },
    ],
    [
      'a method this build does not execute',
      { contract: contract({ request: { method: 'DELETE' } }) },
    ],
    [
      'a header this build will not send',
      { contract: contract({ request: { headers: { authorization: 'Bearer x' } } }) },
    ],
  ])('refuses %s, signing nothing for the provider', async (_label, over) => {
    const { fetchImpl, calls } = net([
      { url: ROUTER, status: 402, body: {}, headers: { 'PAYMENT-REQUIRED': challenge() } },
      { url: ROUTER, status: 200, body: decision(over) },
    ]);
    const result = await runRequestTool({ query: 'q' }, deps(fetchImpl));
    expect(result.envelope).toMatchObject({ status: 'failed' });
    expect(calls).toHaveLength(2);
  });

  it('refuses an advertised amount above maxAutoSpend with the command that fixes it', async () => {
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ bazaarPay: true, maxAutoSpend: '50000' }),
    );
    const { fetchImpl, calls } = net([
      { url: ROUTER, status: 402, body: {}, headers: { 'PAYMENT-REQUIRED': challenge() } },
      { url: ROUTER, status: 200, body: decision() },
    ]);
    const result = await runRequestTool({ query: 'q' }, deps(fetchImpl));
    expect(result.envelope).toMatchObject({ status: 'needs_approval' });
    expect(String((result.envelope as { reason: string }).reason)).toContain(
      'tenjin config set maxAutoSpend',
    );
    expect(calls).toHaveLength(2);
  });

  it('refuses a live 402 above the advertised terms after the decision was paid', async () => {
    const { fetchImpl, calls } = net([
      { url: ROUTER, status: 402, body: {}, headers: { 'PAYMENT-REQUIRED': challenge() } },
      { url: ROUTER, status: 200, body: decision() },
      {
        url: PROVIDER,
        status: 402,
        body: {},
        headers: { 'PAYMENT-REQUIRED': challenge({ amount: '100001' }) },
      },
    ]);
    const result = await runRequestTool({ query: 'q' }, deps(fetchImpl));
    expect(result.envelope).toMatchObject({ status: 'failed' });
    expect(calls.filter((c) => c.url.startsWith(PROVIDER) && c.paid)).toHaveLength(0);
  });

  it.each([
    ['a 5xx', { url: ROUTER, status: 500, body: { error: 'down' } }],
    ['a decision this build cannot read', { url: ROUTER, status: 200, body: { nope: true } }],
  ])('reports %s from the router as failed', async (_label, second) => {
    const { fetchImpl } = net([
      { url: ROUTER, status: 402, body: {}, headers: { 'PAYMENT-REQUIRED': challenge() } },
      second as Leg,
    ]);
    const result = await runRequestTool({ query: 'q' }, deps(fetchImpl));
    expect(result.envelope).toMatchObject({ status: 'failed' });
  });

  it('commits the routing fee when the response is lost after transmission', async () => {
    const auth = authorizer();
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const headers = new Headers(init?.headers ?? {});
      if (!headers.has('payment-signature')) {
        return new Response('{}', {
          status: 402,
          headers: { 'content-type': 'application/json', 'PAYMENT-REQUIRED': challenge() },
        });
      }
      throw new Error('socket closed');
    }) as typeof fetch;
    const result = await runRequestTool({ query: 'q' }, deps(fetchImpl, auth));
    expect(result.envelope).toMatchObject({ status: 'failed' });
    expect(String((result.envelope as { reason: string }).reason)).toContain('may have settled');
    expect(auth.commit).toHaveBeenCalled();
  });

  it('routes on the packet the prompt hook wrote and on the query alone without one', async () => {
    const bodies: unknown[] = [];
    const record = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const headers = new Headers(init?.headers ?? {});
      if (!headers.has('payment-signature')) {
        return new Response('{}', {
          status: 402,
          headers: { 'content-type': 'application/json', 'PAYMENT-REQUIRED': challenge() },
        });
      }
      bodies.push(JSON.parse(String(init?.body ?? 'null')));
      return new Response(JSON.stringify(decision({ action: 'native', contract: undefined })), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    await runRequestTool({ query: 'q' }, deps(record));
    expect(bodies[0]).toMatchObject({ packet: { historyStatus: 'unavailable' } });
    // And the current message is the query, never the empty string the server
    // refuses after the fee has settled.
    expect((bodies[0] as { packet: { current: { text: string } } }).packet.current.text).toBe('q');

    const started = Date.now() - 1;
    await writeSessionPacket(
      dir,
      'sess-1',
      await buildPromptPacket(undefined, 'sess-1', 'BTC too'),
    );
    // `startedAtMs` is the proof the packet is this process's: written after it
    // began. Without it the tool routes on the query alone, whatever is there.
    await runRequestTool({ query: 'q' }, { ...deps(record), startedAtMs: started });
    expect(JSON.stringify(bodies[1])).toContain('BTC too');
  });

  it('needs a query at all, before anything is paid', async () => {
    const { fetchImpl, calls } = net([]);
    const result = await runRequestTool({ query: '   ' }, deps(fetchImpl));
    expect(result.envelope).toMatchObject({ status: 'needs_input' });
    expect(calls).toHaveLength(0);
  });
});

describe('the session 402 requirements cache', () => {
  it('sends the payment header first on the second lookup', async () => {
    const cache = new RequirementsCache();
    const auth = authorizer();
    const calls: { url: string; paid: boolean }[] = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const headers = new Headers(init?.headers ?? {});
      const paid = headers.has('payment-signature');
      calls.push({ url: String(input), paid });
      if (!paid) {
        return new Response('{}', {
          status: 402,
          headers: { 'content-type': 'application/json', 'PAYMENT-REQUIRED': challenge() },
        });
      }
      return new Response(JSON.stringify(decision({ action: 'native', contract: undefined })), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const shared = { ...deps(fetchImpl, auth), cache };
    await runRequestTool({ query: 'one' }, shared);
    await runRequestTool({ query: 'two' }, shared);
    expect(calls.map((c) => c.paid)).toEqual([false, true, true]);
  });

  it('re-probes once on a stale challenge and signs the new terms under the same request', async () => {
    const cache = new RequirementsCache();
    cache.set(
      `${ROUTER}/api/x402-router`,
      buildPaymentRequired({ amount: '1000' }).paymentRequired,
    );
    const bodies: unknown[] = [];
    let attempt = 0;
    const fetchImpl = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? 'null')));
      attempt++;
      if (attempt === 1) {
        return new Response('{}', {
          status: 402,
          headers: {
            'content-type': 'application/json',
            'PAYMENT-REQUIRED': encodePaymentRequiredHeader(
              buildPaymentRequired({ amount: '2000' }).paymentRequired,
            ),
          },
        });
      }
      return new Response(JSON.stringify(decision({ action: 'native', contract: undefined })), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const result = await runRequestTool({ query: 'q' }, { ...deps(fetchImpl), cache });
    expect(result.envelope).toMatchObject({ status: 'native' });
    expect(attempt).toBe(2);
    const ids = bodies.map((b) => (b as { requestId: string }).requestId);
    expect(ids[0]).toBe(ids[1]);
  });

  it('treats a settlement-failure 402 as a paid failure with no second signature', async () => {
    const cache = new RequirementsCache();
    cache.set(
      `${ROUTER}/api/x402-router`,
      buildPaymentRequired({ amount: '1000' }).paymentRequired,
    );
    let attempts = 0;
    const fetchImpl = (async () => {
      attempts++;
      return new Response('{}', {
        status: 402,
        headers: {
          'content-type': 'application/json',
          'PAYMENT-REQUIRED': challenge(),
          'PAYMENT-RESPONSE': 'eyJzdWNjZXNzIjpmYWxzZX0=',
        },
      });
    }) as typeof fetch;
    const result = await runRequestTool({ query: 'q' }, { ...deps(fetchImpl), cache });
    expect(result.envelope).toMatchObject({ status: 'failed' });
    expect(attempts).toBe(1);
  });

  it('fails on a 402 whose challenge is missing or malformed', async () => {
    const cases: Record<string, string>[] = [{}, { 'PAYMENT-REQUIRED': 'not-a-challenge' }];
    for (const headers of cases) {
      const { fetchImpl } = net([{ url: ROUTER, status: 402, body: {}, headers }]);
      const result = await runRequestTool({ query: 'q' }, deps(fetchImpl));
      expect(result.envelope).toMatchObject({ status: 'failed' });
    }
  });

  it('returns needs_approval, unchanged config, when the confirm policy asks', async () => {
    const { fetchImpl, calls } = net([
      { url: ROUTER, status: 402, body: {}, headers: { 'PAYMENT-REQUIRED': challenge() } },
    ]);
    const before = await import('node:fs/promises').then((fs) =>
      fs.readFile(join(dir, 'config.json'), 'utf8'),
    );
    const result = await runRequestTool({ query: 'q' }, deps(fetchImpl, authorizer('confirm')));
    expect(result.envelope).toMatchObject({ status: 'needs_approval' });
    expect(calls.every((c) => !c.paid)).toBe(true);
    expect(
      await import('node:fs/promises').then((fs) => fs.readFile(join(dir, 'config.json'), 'utf8')),
    ).toBe(before);
  });
});

// The install defaults are only useful if a lookup actually goes through under
// them, with the REAL authorizer and no confirm seam anywhere.
describe('a fresh install, end to end through the local spend policy', () => {
  it('pays without a prompt under the defaults, and refuses under an explicit confirm always', async () => {
    const { runRouterInstall } = await import('./install');
    const home = join(dir, 'home');
    await import('node:fs/promises').then((fs) =>
      fs.mkdir(join(home, '.claude'), { recursive: true }),
    );
    await import('node:fs/promises').then((fs) => fs.rm(join(dir, 'config.json'), { force: true }));
    await runRouterInstall({}, ctx(), { homeDir: home, env: {}, which: () => false });

    const legs = () =>
      net([
        { url: ROUTER, status: 402, body: {}, headers: { 'PAYMENT-REQUIRED': challenge() } },
        { url: ROUTER, status: 200, body: decision() },
        {
          url: PROVIDER,
          status: 402,
          body: {},
          headers: { 'PAYMENT-REQUIRED': challenge({ amount: '10000' }) },
        },
        { url: PROVIDER, status: 200, body: { data: { BTC: 1 } } },
      ]);
    const real = (fetchImpl: typeof fetch) => ({
      ctx: ctx(),
      signer,
      authorizer: resolveSpendAuthorizer(ctx(), {
        maxAutoSpendAtomic: 100_000n,
        sessionBudgetAtomic: 1_000_000n,
        confirm: { mode: 'above' as const, thresholdAtomic: 100_000n },
        allowlistCreators: [],
      }),
      cache: new RequirementsCache(),
      fetchImpl,
      payDeps: { fetchImpl, provider: testWalletProvider(), destination: PUBLIC },
    });
    const first = legs();
    const paid = await runRequestTool({ query: 'BTC and ETH' }, real(first.fetchImpl));
    expect(paid.envelope).toMatchObject({ status: 'fulfilled' });

    const before = await import('node:fs/promises').then((fs) =>
      fs.readFile(join(dir, 'config.json'), 'utf8'),
    );
    const strict = { ...real(legs().fetchImpl) };
    strict.authorizer = resolveSpendAuthorizer(ctx(), {
      maxAutoSpendAtomic: 100_000n,
      sessionBudgetAtomic: 1_000_000n,
      confirm: { mode: 'always' as const },
      allowlistCreators: [],
    });
    const refused = await runRequestTool({ query: 'BTC and ETH' }, strict);
    expect(refused.envelope).toMatchObject({ status: 'needs_approval' });
    expect(
      await import('node:fs/promises').then((fs) => fs.readFile(join(dir, 'config.json'), 'utf8')),
    ).toBe(before);
  });
});

describe('a contract this build cannot turn into a request', () => {
  it.each([
    ['a URL that will not parse', { request: { url: 'not a url' } }],
    ['a body on a GET', { request: { body: '{}' } }],
  ])('returns %s as a structured failure carrying the routing fee', async (_label, over) => {
    const { fetchImpl } = net([
      { url: ROUTER, status: 402, body: {}, headers: { 'PAYMENT-REQUIRED': challenge() } },
      { url: ROUTER, status: 200, body: decision({ contract: contract(over) }) },
    ]);
    const result = await runRequestTool({ query: 'q' }, deps(fetchImpl));
    expect(result.isError).toBe(true);
    expect(result.envelope).toMatchObject({
      status: 'failed',
      cost: ['router fee 0.001 USD', 'provider price 0 USD'],
    });
  });
});

describe('the routing fee a failure still owes', () => {
  it('reports the committed fee on a post-transmission failure', async () => {
    const { fetchImpl } = net([
      { url: ROUTER, status: 402, body: {}, headers: { 'PAYMENT-REQUIRED': challenge() } },
      { url: ROUTER, status: 500, body: { error: 'down' } },
    ]);
    const result = await runRequestTool({ query: 'q' }, deps(fetchImpl));
    expect(result.envelope).toMatchObject({
      status: 'failed',
      cost: ['router fee 0.001 USD', 'provider price 0 USD'],
    });
  });

  it('reports no fee when nothing was ever transmitted', async () => {
    const { fetchImpl } = net([{ url: ROUTER, status: 500, body: { error: 'down' } }]);
    const result = await runRequestTool({ query: 'q' }, deps(fetchImpl));
    expect(result.envelope).toMatchObject({
      status: 'failed',
      cost: ['router fee 0 USD', 'provider price 0 USD'],
    });
  });

  it('keeps BOTH transmitted authorizations counted when terms moved, and reports the pair', async () => {
    const cache = new RequirementsCache();
    cache.set(
      `${ROUTER}/api/x402-router`,
      buildPaymentRequired({ amount: '1000' }).paymentRequired,
    );
    const auth = authorizer();
    let attempt = 0;
    const fetchImpl = (async () => {
      attempt++;
      if (attempt === 1) {
        return new Response('{}', {
          status: 402,
          headers: {
            'content-type': 'application/json',
            'PAYMENT-REQUIRED': encodePaymentRequiredHeader(
              buildPaymentRequired({ amount: '2000' }).paymentRequired,
            ),
          },
        });
      }
      return new Response(JSON.stringify(decision({ action: 'native', contract: undefined })), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const result = await runRequestTool({ query: 'q' }, { ...deps(fetchImpl, auth), cache });
    // Both authorizations LEFT the process, so both stay counted: a 402 is the
    // counterparty saying it will not settle, never proof that it cannot. The
    // receipt names the pair rather than the attempt that answered.
    expect(auth.release).not.toHaveBeenCalled();
    expect(auth.commit).toHaveBeenCalledTimes(2);
    // The second attempt was waived (a `native` answer), so the reported FEE is
    // the stale attempt alone, while the EXPOSURE is both authorizations: a 402
    // is not a statement that the first one cannot settle.
    expect(result.envelope).toMatchObject({
      cost: ['router fee 0.001 USD', 'provider price 0 USD'],
      authorizationExposure: '0.003',
    });
  });

  it('hands the provider leg the wallet the decision already unlocked', async () => {
    const provider = testWalletProvider();
    const opened = vi.spyOn(provider, 'getSigner');
    const { fetchImpl } = net([
      { url: ROUTER, status: 402, body: {}, headers: { 'PAYMENT-REQUIRED': challenge() } },
      { url: ROUTER, status: 200, body: decision() },
      {
        url: PROVIDER,
        status: 402,
        body: {},
        headers: { 'PAYMENT-REQUIRED': challenge({ amount: '10000' }) },
      },
      { url: PROVIDER, status: 200, body: { data: { BTC: 1 } } },
    ]);
    const auth = authorizer();
    const result = await runRequestTool(
      { query: 'q' },
      {
        ctx: ctx(),
        signer,
        provider,
        authorizer: auth,
        cache: new RequirementsCache(),
        fetchImpl,
        payDeps: { fetchImpl, authorizer: auth, destination: PUBLIC },
      },
    );
    expect(result.envelope).toMatchObject({ status: 'fulfilled' });
    // The provider leg used the injected one; nothing opened a second wallet.
    expect(opened).toHaveBeenCalled();
  });
});

describe('a retry whose fresh terms fail the gate', () => {
  it('still reports the fee the first attempt transmitted', async () => {
    const cache = new RequirementsCache();
    cache.set(
      `${ROUTER}/api/x402-router`,
      buildPaymentRequired({ amount: '1000' }).paymentRequired,
    );
    // Allow the first authorization, refuse the re-priced one: the first has
    // already left, so the receipt owes its amount whatever the second does.
    let calls = 0;
    const auth: SpendAuthorizer = {
      policyEnforcement: 'client-only',
      authorize: vi.fn(async (req): Promise<SpendAuthorization> => {
        calls++;
        return {
          decision: calls === 1 ? 'allow' : 'deny',
          reason: calls === 1 ? 'within_policy' : 'session_budget_exceeded',
          message: 'over budget',
          amountAtomic: req.amountAtomic,
          sessionSpentAtomic: 0n,
          sessionBudgetAtomic: 0n,
          policyEnforcement: 'client-only',
          ...(calls === 1 ? { reservationId: 'rsv' } : {}),
        };
      }),
      commit: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
    };
    const fetchImpl = (async () =>
      new Response('{}', {
        status: 402,
        headers: {
          'content-type': 'application/json',
          'PAYMENT-REQUIRED': encodePaymentRequiredHeader(
            buildPaymentRequired({ amount: '2000' }).paymentRequired,
          ),
        },
      })) as typeof fetch;
    const result = await runRequestTool({ query: 'q' }, { ...deps(fetchImpl, auth), cache });
    expect(result.envelope).toMatchObject({
      status: 'needs_approval',
      cost: ['router fee 0.001 USD', 'provider price 0 USD'],
    });
    expect(auth.commit).toHaveBeenCalledTimes(1);
    expect(auth.release).not.toHaveBeenCalled();
  });
});

describe('a provider leg that cannot be read after the payment left', () => {
  it('reports the provider amount, not zero', async () => {
    let call = 0;
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const paid = new Headers(init?.headers ?? {}).has('payment-signature');
      const toRouter = String(input).startsWith(ROUTER);
      call += 1;
      if (!paid) {
        return new Response('{}', {
          status: 402,
          headers: {
            'content-type': 'application/json',
            'PAYMENT-REQUIRED': toRouter ? challenge() : challenge({ amount: '10000' }),
          },
        });
      }
      if (toRouter) {
        return new Response(JSON.stringify(decision()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw Object.assign(new TypeError('fetch failed'), {
        cause: new Error('Headers Overflow Error'),
      });
    }) as typeof fetch;
    const auth = authorizer();
    const result = await runRequestTool({ query: 'q' }, deps(fetchImpl, auth));
    expect(call).toBe(4);
    // Router fee AND the provider authorization that left, both on the receipt.
    expect(result.envelope).toMatchObject({
      status: 'failed',
      cost: ['router fee 0.001 USD', 'provider price 0.01 USD'],
      settlement: 'unknown',
    });
  });
});

describe('a paid 2xx that fails its result contract', () => {
  const RESULT = {
    type: 'object',
    properties: { success: { const: true } },
    required: ['success'],
  };

  function legsFor(body: string, contentType = 'application/json') {
    return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const paid = new Headers(init?.headers ?? {}).has('payment-signature');
      const toRouter = String(input).startsWith(ROUTER);
      if (!paid) {
        return new Response('{}', {
          status: 402,
          headers: {
            'content-type': 'application/json',
            'PAYMENT-REQUIRED': toRouter ? challenge() : challenge({ amount: '10000' }),
          },
        });
      }
      if (toRouter) {
        return new Response(
          JSON.stringify(decision({ contract: contract({ resultSchema: RESULT }) })),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(body, { status: 200, headers: { 'content-type': contentType } });
    }) as typeof fetch;
  }

  it('tells a rule miss apart from a body that was never JSON', async () => {
    const miss = await runRequestTool(
      { query: 'q' },
      deps(legsFor(JSON.stringify({ success: false, reason: 'no match' }))),
    );
    expect(miss.envelope).toMatchObject({ status: 'failed' });
    expect(miss.envelope.diagnosis).toMatchObject({ json: true });
    expect(String((miss.envelope.diagnosis as { failed: string }).failed)).toContain('/success');

    const html = await runRequestTool(
      { query: 'q' },
      deps(legsFor('<!doctype html><title>502 Bad Gateway</title>', 'text/html')),
    );
    expect(html.envelope.diagnosis).toMatchObject({ failed: 'not-json', json: false });
    expect(String((html.envelope.diagnosis as { preview: string }).preview)).toContain('502');
  });

  /**
   * The lookup was paid for twice over (the fee and the provider price) before
   * the body was measured, so the product still comes back whole. What it must
   * NOT come back as is `fulfilled`: a provider can pad a body that fails its
   * contract past the validation limit, and a caveat inside a success envelope
   * never reaches code that branches on the status.
   */
  it.each([
    ['one that would satisfy its schema', { success: true }],
    ['one that would FAIL its schema', { success: false, reason: 'no match' }],
  ])('reports a result too large to validate as unverified, %s', async (_label, shape) => {
    const oversized = JSON.stringify({ ...shape, blob: 'x'.repeat(200 * 1024) });
    const result = await runRequestTool({ query: 'q' }, deps(legsFor(oversized)));
    // Both are the same answer, because which one this is cannot be known.
    expect(result.envelope).toMatchObject({ status: 'unverified' });
    expect(result.isError).toBe(true);
    expect(result.summary).toContain('Unverified');
    // The body is still delivered, whole, with what was paid for it.
    expect(result.envelope.result).toBe(oversized);
    expect(result.envelope.cost).toEqual(['router fee 0.001 USD', 'provider price 0.01 USD']);
    expect(String(result.envelope.resultCaveat)).toContain('not checked');
    expect(String(result.envelope.resultCaveat)).toContain(String(Buffer.byteLength(oversized)));
  });

  it('still reports what the provider call cost on either', async () => {
    const result = await runRequestTool(
      { query: 'q' },
      deps(legsFor(JSON.stringify({ success: false }))),
    );
    expect(result.envelope).toMatchObject({
      cost: ['router fee 0.001 USD', 'provider price 0.01 USD'],
      settlement: 'reported',
    });
  });
});

/**
 * ONE LOOKUP, NOT THE WHOLE TURN. The instruction used to demand the user's
 * entire request, which sent strategy, opinions and repository context to the
 * router as one operation. The host may now narrow to the sub-request that
 * needs the outside world, and NOTHING IS LOST BY IT: the authoritative packet
 * the prompt hook wrote still travels beside the query, contextual URLs and
 * all, so the server sees what was not sent as the lookup.
 */
describe('a narrowed query with the whole packet behind it', () => {
  it('sends the sub-request as the query and the unchanged packet as the context', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (!new Headers(init?.headers ?? {}).has('payment-signature')) {
        return new Response('{}', {
          status: 402,
          headers: { 'content-type': 'application/json', 'PAYMENT-REQUIRED': challenge() },
        });
      }
      bodies.push(JSON.parse(String(init?.body ?? 'null')) as Record<string, unknown>);
      return new Response(JSON.stringify(decision({ action: 'native', contract: undefined })), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const mixed =
      'Here is my product strategy for the alpha, my opinion on the pricing page, and ' +
      'the PR https://github.com/BackTrackCo/tenjin-agent/pull/370 for context. Also find ' +
      'agent startups shipping x402 in the last month.';
    const started = Date.now() - 1;
    await writeSessionPacket(dir, 'sess-1', await buildPromptPacket(undefined, 'sess-1', mixed));

    const narrow = 'find agent startups shipping x402 in the last month';
    await runRequestTool({ query: narrow }, { ...deps(fetchImpl), startedAtMs: started });

    const sent = bodies[0] as {
      query: string;
      packet: { current: { text: string }; literalUrls: string[] };
    };
    // The lookup is the sub-request, copied as written.
    expect(sent.query).toBe(narrow);
    // The packet is the authoritative one, not a copy of the narrowed query:
    // the whole turn and its literal URL are still what the server binds from.
    expect(sent.packet.current.text).toBe(mixed);
    expect(sent.packet.literalUrls).toContain(
      'https://github.com/BackTrackCo/tenjin-agent/pull/370',
    );
  });
});

/**
 * THE PAID `native` DECISION HAS TO REACH THE HOOK. Without it the PreToolUse
 * hook asked the gate again about the very search the decision had just
 * permitted, and a gate answering `execute` denied it: the user sees a blocked
 * tool on a lookup they paid to be told they did not need to route.
 *
 * The bypass is deliberately narrow, so each boundary is pinned below.
 */
describe('an explicit native decision and the matching continuation', () => {
  const LOOKUP = 'agent startups shipping x402 in the last month';

  /** A gate that always redirects, and records whether it was asked at all. */
  function redirectingGate(): { fetchImpl: typeof fetch; calls: unknown[] } {
    const calls: unknown[] = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      calls.push(String(input));
      return new Response(
        JSON.stringify({
          schemaVersion: 1,
          routerVersion: 'v',
          action: 'execute',
          hint: 'A web research capability fits this request. Call request with the research question, alone, and wait for its result.',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    return { fetchImpl, calls };
  }

  /** The paid decision leg, answering `native` or `needs_input` for `query`. */
  function routerAnswering(action: 'native' | 'needs_input'): typeof fetch {
    return (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (!new Headers(init?.headers ?? {}).has('payment-signature')) {
        return new Response('{}', {
          status: 402,
          headers: { 'content-type': 'application/json', 'PAYMENT-REQUIRED': challenge() },
        });
      }
      return new Response(
        JSON.stringify(
          decision({ action, reason: 'Your own tools cover this.', contract: undefined }),
        ),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
  }

  function nativeEvent(subject: string, tool: 'WebSearch' | 'WebFetch' = 'WebSearch'): unknown {
    return {
      hook_event_name: 'PreToolUse',
      session_id: 'sess-1',
      tool_name: tool,
      tool_input: tool === 'WebSearch' ? { query: subject } : { url: subject },
    };
  }

  /** One turn: the prompt hook's packet, then the tool's paid decision. */
  async function turn(
    action: 'native' | 'needs_input',
    stamp = Date.now(),
    query = LOOKUP,
  ): Promise<void> {
    await writeSessionPacket(
      dir,
      'sess-1',
      await buildPromptPacket(undefined, 'sess-1', `please ${query}`),
      () => stamp,
    );
    await runRequestTool({ query }, { ...deps(routerAnswering(action)), startedAtMs: stamp - 1 });
  }

  it('allows the same lookup in the same turn without asking the gate again', async () => {
    const { runNativeHook } = await import('./hooks');
    await turn('native');
    const gate = redirectingGate();
    const out = await runNativeHook(nativeEvent(LOOKUP), {
      dataDir: dir,
      baseUrl: ROUTER,
      fetchImpl: gate.fetchImpl,
    });
    expect(out).toMatchObject({ decision: 'allow', gateAction: 'native', via: 'continuation' });
    // Not merely allowed: the gate was never asked, so it could not contradict
    // the decision this session already paid for.
    expect(gate.calls).toHaveLength(0);
  });

  it('matches through re-wrapped whitespace, and nothing else', async () => {
    const { runNativeHook } = await import('./hooks');
    await turn('native');
    const same = redirectingGate();
    const rewrapped = await runNativeHook(
      nativeEvent(`  agent startups   shipping x402\n in the last month `),
      { dataDir: dir, baseUrl: ROUTER, fetchImpl: same.fetchImpl },
    );
    expect(rewrapped).toMatchObject({ decision: 'allow', via: 'continuation' });
    expect(same.calls).toHaveLength(0);

    const other = redirectingGate();
    const different = await runNativeHook(nativeEvent('best pricing page examples'), {
      dataDir: dir,
      baseUrl: ROUTER,
      fetchImpl: other.fetchImpl,
    });
    // A different question is a different decision: asked, and redirected.
    expect(other.calls).toHaveLength(1);
    expect(different.decision).toBe('deny');
  });

  /**
   * THE KEY GRANTS A BYPASS, so it may only collapse what is the same lookup by
   * definition. A path is case-sensitive on most servers: lowercasing the whole
   * string gave `/Report` and `/report` one key, and a grant for one page would
   * have let the other skip the gate. Scheme and host are case-insensitive by
   * definition and still match.
   */
  it('does not let a different path case inherit the grant', async () => {
    const { runNativeHook } = await import('./hooks');
    await turn('native', Date.now(), 'https://example.com/Report');
    const gate = redirectingGate();
    const out = await runNativeHook(nativeEvent('https://example.com/report', 'WebFetch'), {
      dataDir: dir,
      baseUrl: ROUTER,
      fetchImpl: gate.fetchImpl,
    });
    expect(gate.calls).toHaveLength(1);
    expect(out.decision).toBe('deny');
    expect(out.via).toBeUndefined();
  });

  it('does not let a query that merely starts with a URL inherit the grant', async () => {
    const { runNativeHook } = await import('./hooks');
    // The host ends at the first whitespace: what follows is the lookup, and
    // its case is as much part of it as any other word's.
    await turn('native', Date.now(), 'https://example.com Report');
    const gate = redirectingGate();
    const out = await runNativeHook(nativeEvent('https://example.com report'), {
      dataDir: dir,
      baseUrl: ROUTER,
      fetchImpl: gate.fetchImpl,
    });
    expect(gate.calls).toHaveLength(1);
    expect(out.decision).toBe('deny');
    expect(out.via).toBeUndefined();
  });

  it('allows the same URL written with a different host case', async () => {
    const { runNativeHook } = await import('./hooks');
    await turn('native', Date.now(), 'https://example.com/Report');
    const gate = redirectingGate();
    const out = await runNativeHook(nativeEvent('HTTPS://ExAmPlE.COM/Report', 'WebFetch'), {
      dataDir: dir,
      baseUrl: ROUTER,
      fetchImpl: gate.fetchImpl,
    });
    expect(out).toMatchObject({ decision: 'allow', via: 'continuation' });
    expect(gate.calls).toHaveLength(0);
  });

  it('does not survive the next user turn', async () => {
    const { runNativeHook } = await import('./hooks');
    const first = Date.now();
    await turn('native', first);
    // The user says something else: the prompt hook rewrites the packet, and
    // the stamp the continuation was granted against is gone.
    await writeSessionPacket(
      dir,
      'sess-1',
      await buildPromptPacket(undefined, 'sess-1', 'actually, ignore that'),
      () => first + 5_000,
    );
    const gate = redirectingGate();
    const out = await runNativeHook(nativeEvent(LOOKUP), {
      dataDir: dir,
      baseUrl: ROUTER,
      fetchImpl: gate.fetchImpl,
    });
    expect(gate.calls).toHaveLength(1);
    expect(out.decision).toBe('deny');
  });

  it('is never granted by needs_input', async () => {
    const { runNativeHook } = await import('./hooks');
    await turn('needs_input');
    const gate = redirectingGate();
    const out = await runNativeHook(nativeEvent(LOOKUP), {
      dataDir: dir,
      baseUrl: ROUTER,
      fetchImpl: gate.fetchImpl,
    });
    // Unresolved scope is a question for the user, never standing permission.
    expect(gate.calls).toHaveLength(1);
    expect(out.decision).toBe('deny');
  });
});

/**
 * THE 2026-09-23 LOOKUP CONTRACT, from the client side. The router settles only
 * a decision it can execute and waives everything else BEFORE settlement, so
 * what this tool reports as a fee and what it counts as exposure stop being the
 * same number. The signed authorization still left the process either way.
 */
describe('billing: what settled, and what was merely authorized', () => {
  function answering(body: unknown, status = 200): typeof fetch {
    return (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (!new Headers(init?.headers ?? {}).has('payment-signature')) {
        return new Response('{}', {
          status: 402,
          headers: { 'content-type': 'application/json', 'PAYMENT-REQUIRED': challenge() },
        });
      }
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
  }

  it.each([
    ['needs_input', 'needs_input', 'waived_needs_input'],
    ['native', 'native', 'waived_native'],
  ])(
    'reports a waived %s as no fee, with the authorization still shown',
    async (_l, action, code) => {
      const auth = authorizer();
      const result = await runRequestTool(
        { query: 'q' },
        deps(
          answering(
            decision({
              action,
              contract: undefined,
              billing: {
                settled: false,
                amountAtomic: '0',
                asset: USDC,
                network: 'eip155:8453',
                reasonCode: code,
              },
            }),
          ),
          auth,
        ),
      );
      expect(result.envelope.cost).toEqual(['router fee 0 USD', 'provider price 0 USD']);
      expect(result.envelope.authorizationExposure).toBe('0.001');
      // The ledger keeps both: exposure against the budget, settled for the truth.
      expect(auth.commit).toHaveBeenCalledWith('rsv', 1000n, { settledAtomic: 0n });
    },
  );

  it('reports an executed decision at the fee the backend says it took', async () => {
    const auth = authorizer();
    const result = await runRequestTool(
      { query: 'q' },
      deps(
        answering(
          decision({
            billing: {
              settled: true,
              amountAtomic: '1000',
              asset: USDC,
              network: 'eip155:8453',
              reasonCode: 'executed',
            },
          }),
        ),
        auth,
      ),
    );
    // No exposure line: nothing diverged, so there is nothing extra to say.
    expect(result.envelope.authorizationExposure).toBeUndefined();
    expect(String(result.envelope.cost)).toContain('router fee 0.001 USD');
    expect(auth.commit).toHaveBeenCalledWith('rsv', 1000n, { settledAtomic: 1000n });
  });

  it('never lets a body claim MORE than the signature authorized', async () => {
    const auth = authorizer();
    await runRequestTool(
      { query: 'q' },
      deps(
        answering(
          decision({
            billing: {
              settled: true,
              amountAtomic: '999999999',
              asset: USDC,
              network: 'eip155:8453',
              reasonCode: 'executed',
            },
          }),
        ),
        auth,
      ),
    );
    // The signature is the ceiling on what can move, whatever the body says.
    expect(auth.commit).toHaveBeenCalledWith('rsv', 1000n, { settledAtomic: 1000n });
  });

  /**
   * NO OLD SERVERS EXIST (contract amendment 2026-09-23), so a 200 without
   * `billing` is a protocol error rather than a legacy path to be tolerated.
   * The exposure is still committed in full: nothing about an unreadable body
   * says the authorization it answered was not settled.
   */
  it('refuses a decision with no billing, and still counts the authorization', async () => {
    const auth = authorizer();
    const body = decision({ action: 'native', contract: undefined }) as Record<string, unknown>;
    delete body.billing;
    const result = await runRequestTool({ query: 'q' }, deps(answering(body), auth));
    expect(result.isError).toBe(true);
    expect(result.envelope).toMatchObject({ status: 'failed' });
    expect(String(result.envelope.reason)).toContain('cannot read');
    expect(auth.commit).toHaveBeenCalledWith('rsv', 1000n, { settledAtomic: 1000n });
  });

  it('surfaces a typed refusal by its own code and message, never as a bare status', async () => {
    const result = await runRequestTool(
      { query: 'q' },
      deps(
        answering(
          {
            error: {
              code: 'packet_too_large',
              message: 'The packet exceeds the 16 KiB bound; send the current turn only.',
            },
          },
          400,
        ),
      ),
    );
    expect(result.isError).toBe(true);
    expect(result.envelope.errorCode).toBe('packet_too_large');
    expect(String(result.envelope.reason)).toContain('16 KiB bound');
    expect(String(result.envelope.reason)).toContain('400');
  });

  it('falls back to the status line when a non-2xx body carries no code', async () => {
    const result = await runRequestTool({ query: 'q' }, deps(answering({ nope: true }, 500)));
    expect(result.envelope.errorCode).toBeUndefined();
    expect(String(result.envelope.reason)).toContain('answered 500');
  });
});

/**
 * DIAGNOSTICS ARE THE POINT OF A NON-EXECUTE OUTCOME. "Jev could not resolve
 * the requested information scope" told a host nothing and taught a model to
 * stop calling the tool; the reason code, the stage that stopped, the missing
 * field and one concrete next action are what make it actionable.
 */
describe('diagnostics on an outcome the router could not execute', () => {
  function withDiagnostics(over: Record<string, unknown>): typeof fetch {
    return (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (!new Headers(init?.headers ?? {}).has('payment-signature')) {
        return new Response('{}', {
          status: 402,
          headers: { 'content-type': 'application/json', 'PAYMENT-REQUIRED': challenge() },
        });
      }
      return new Response(
        JSON.stringify(
          decision({
            action: 'needs_input',
            reason: 'Name the company to enrich.',
            contract: undefined,
            diagnostics: over,
          }),
        ),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
  }

  it("carries the backend's reason, stage, missing field and next action", async () => {
    const result = await runRequestTool(
      { query: 'enrich them' },
      deps(
        withDiagnostics({
          reasonCode: 'unresolved_intent',
          stage: 'bind',
          missing: ['company_domain'],
          nextAction: 'Ask the user for the company domain, then call request again with it.',
        }),
      ),
    );
    expect(result.isError).toBe(false);
    expect(result.envelope).toMatchObject({
      status: 'needs_input',
      reasonCode: 'unresolved_intent',
      stage: 'bind',
      missing: ['company_domain'],
      nextStep: 'Ask the user for the company domain, then call request again with it.',
    });
  });

  it.each([
    ['page_target', 'the URL as the query'],
    ['contextual_url', 'the question as the query'],
    ['unresolved_intent', 'scope choice or field'],
    ['classifier_failure', 'charged nothing'],
  ])('knows the next step for %s when the backend sent none', async (reasonCode, phrase) => {
    const result = await runRequestTool(
      { query: 'q' },
      deps(withDiagnostics({ reasonCode, stage: 'target', missing: [], nextAction: '' })),
    );
    expect(String(result.envelope.nextStep)).toContain(phrase);
  });
});

/**
 * THE GATE'S CATEGORY, TRAVELLING AS EVIDENCE FOR ONE LOOKUP. The free prompt
 * gate classified this turn; sending that with the paid decision is what stops
 * the gate and the binder contradicting each other. It is never payment
 * authority, and it belongs to the lookup it was produced for: the second
 * lookup of a turn, and any parallel one, send none.
 */
describe('the gate hint that rides with the first lookup of a turn', () => {
  const HINT =
    'A crypto price quote fits this request. Call request with the coins and currency, alone, and wait for its result.';

  function recording(): { fetchImpl: typeof fetch; bodies: Record<string, unknown>[] } {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (!new Headers(init?.headers ?? {}).has('payment-signature')) {
        return new Response('{}', {
          status: 402,
          headers: { 'content-type': 'application/json', 'PAYMENT-REQUIRED': challenge() },
        });
      }
      bodies.push(JSON.parse(String(init?.body ?? 'null')) as Record<string, unknown>);
      return new Response(JSON.stringify(decision({ action: 'native', contract: undefined })), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    return { fetchImpl, bodies };
  }

  /** The prompt hook's own gate, answering `execute` with a well-formed hint. */
  function promptGate(): typeof fetch {
    return (async () =>
      new Response(
        JSON.stringify({
          schemaVersion: 1,
          routerVersion: '2026-09-23.1',
          action: 'execute',
          hint: HINT,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;
  }

  async function gatedTurn(prompt: string): Promise<number> {
    const { runPromptHook } = await import('./hooks');
    const started = Date.now() - 1;
    await runPromptHook(
      { hook_event_name: 'UserPromptSubmit', session_id: 'sess-1', prompt },
      { dataDir: dir, baseUrl: ROUTER, fetchImpl: promptGate() },
    );
    return started;
  }

  it('sends the category, the turn and the lookup it is evidence for', async () => {
    const started = await gatedTurn('check BTC and ETH prices');
    const { fetchImpl, bodies } = recording();
    await runRequestTool(
      { query: 'BTC and ETH price' },
      { ...deps(fetchImpl), startedAtMs: started },
    );

    const { lookupKeyOf } = await import('./session-file');
    expect(bodies[0]!.gateHint).toEqual({
      category: 'crypto price quote',
      turnId: expect.any(String) as unknown as string,
      lookupId: lookupKeyOf('BTC and ETH price'),
    });
  });

  it('never rides a second or parallel lookup in the same turn', async () => {
    const started = await gatedTurn('check BTC and ETH prices');
    const first = recording();
    await runRequestTool(
      { query: 'BTC price' },
      { ...deps(first.fetchImpl), startedAtMs: started },
    );
    expect(first.bodies[0]!.gateHint).toBeDefined();

    // Same turn, a different question: evidence about one lookup is not
    // evidence about the next, so the hint is gone after the first use.
    const second = recording();
    await runRequestTool(
      { query: 'ETH price' },
      { ...deps(second.fetchImpl), startedAtMs: started },
    );
    expect(second.bodies[0]!.gateHint).toBeUndefined();
  });

  it('sends none when the gate named no category for this turn', async () => {
    const { runPromptHook } = await import('./hooks');
    const started = Date.now() - 1;
    const silent = (async () =>
      new Response(JSON.stringify({ schemaVersion: 1, routerVersion: 'v', action: 'native' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    await runPromptHook(
      { hook_event_name: 'UserPromptSubmit', session_id: 'sess-1', prompt: 'hello there' },
      { dataDir: dir, baseUrl: ROUTER, fetchImpl: silent },
    );
    const { fetchImpl, bodies } = recording();
    await runRequestTool({ query: 'q' }, { ...deps(fetchImpl), startedAtMs: started });
    expect(bodies[0]!.gateHint).toBeUndefined();
  });
});
