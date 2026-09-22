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

function decision(over: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: 1,
    routerVersion: '2026-09-22.1',
    requestId: 'r-1',
    decision: { action: 'execute', capabilityId: 'cmc-quotes', contract: contract(), ...over },
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

  it.each([
    ['native', { action: 'native', reason: 'Your own tools cover this.' }],
    ['needs_input', { action: 'needs_input', reason: 'Name the coins.' }],
  ])('returns %s as a tool error without paying a provider', async (status, over) => {
    const { fetchImpl, calls } = net([
      { url: ROUTER, status: 402, body: {}, headers: { 'PAYMENT-REQUIRED': challenge() } },
      { url: ROUTER, status: 200, body: decision({ ...over, contract: undefined }) },
    ]);
    const result = await runRequestTool({ query: 'something' }, deps(fetchImpl));
    expect(result.isError).toBe(true);
    expect(result.envelope).toMatchObject({ status, reason: over.reason });
    expect(calls).toHaveLength(2);
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
    expect(result.envelope).toMatchObject({
      cost: ['router fee 0.003 USD', 'provider price 0 USD'],
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
