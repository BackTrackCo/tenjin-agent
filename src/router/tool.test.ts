import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import type { PaymentRequired } from '@x402/core/types';
import { buildPaymentRequired, testWalletProvider } from '../lib/read-test-utils';
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
    ['a method this build does not execute', { contract: contract({ method: 'DELETE' }) }],
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

    await writeSessionPacket(
      dir,
      'sess-1',
      await buildPromptPacket(undefined, 'sess-1', 'BTC too'),
    );
    await runRequestTool({ query: 'q' }, deps(record));
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
