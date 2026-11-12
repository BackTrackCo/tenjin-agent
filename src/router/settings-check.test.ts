import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPaymentRequired, testWalletProvider } from '../lib/read-test-utils';
import type { SpendAuthorization, SpendAuthorizer } from '../lib/wallet';
import type { CommandContext } from '../context';
import { runRequestTool } from './tool';
import { readSpec, storeSpecs } from './specs';
import { personalSettingsAt } from './settings';
import { settingsRefusal } from './settings-check';
import type { OfferSpec } from './decision';

/**
 * THE CHECK BEFORE EVERY CALL (plan 36): an offer runs only under the rules it
 * was decided under. Its answer's `settingsHash` is kept with its spec and
 * compared with the hash of the rules saved now; a mismatch, or no hash while
 * a rule is saved, refuses before any provider request, signing or payment,
 * and the agent is told to ask again. With no rules and no hash, it runs as
 * it always did.
 */

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'settings-check-'));
  await mkdir(join(dir, '.git'));
  await save({});
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ROUTER = 'https://tenjin.sh';
const PROVIDER = 'https://pro-api.example.test/x402/v3/quotes';
const SPEC_ID = '0195f3a1-6c4d-7a2b-9e10-5f6a7b8c9d41';
const BLOCK_EXA = { version: 1, block: [{ kind: 'provider', id: 'exa' }] };

async function save(router: Record<string, unknown>): Promise<void> {
  await writeFile(
    join(dir, 'config.json'),
    JSON.stringify({ maxAutoSpend: '250000', sessionBudget: '5000000', router }),
  );
}

async function hashNow(): Promise<string> {
  const { wire } = await personalSettingsAt(dir);
  if (wire.status !== 'ok') throw new Error('unreadable');
  return wire.settings.hash;
}

function ctx(): CommandContext {
  const sink = () => ({ write: () => true }) as unknown as NodeJS.WritableStream;
  return {
    flags: { json: true, timeout: 5000, baseUrl: ROUTER },
    dataDir: dir,
    io: { stdout: sink(), stderr: sink(), isTTY: false },
  };
}

function authorizer(): SpendAuthorizer {
  return {
    policyEnforcement: 'client-only',
    authorize: vi.fn(async (req): Promise<SpendAuthorization> => ({
      decision: 'allow',
      reason: 'within_policy',
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

interface Leg {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

function net(legs: Leg[]) {
  const calls: { url: string; body?: string }[] = [];
  const queue = [...legs];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({
      url: String(input),
      ...(typeof init?.body === 'string' ? { body: init.body } : {}),
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

function deps(fetchImpl: typeof fetch) {
  const auth = authorizer();
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
      destination: { resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }] },
    },
  };
}

const providerLegs = (): Leg[] => [
  {
    status: 402,
    body: {},
    headers: { 'PAYMENT-REQUIRED': buildPaymentRequired({ amount: '10000' }).header },
  },
  { status: 200, body: { data: { BTC: 1 } } },
];

function spec(): OfferSpec {
  return {
    id: SPEC_ID,
    capabilityId: 'cmc-quotes',
    provider: 'CoinMarketCap',
    description: 'latest market quotes for one or more cryptocurrencies',
    priceAtomic: '10000',
    priceVaries: false,
    maxAmountAtomic: '10000',
    payTo: '0x1111111111111111111111111111111111111111',
    network: 'eip155:8453',
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    request: { method: 'GET', url: PROVIDER, fields: { symbol: 'query' }, location: 'query' },
    input: {
      type: 'object',
      properties: { symbol: { type: 'string' } },
      required: ['symbol'],
      additionalProperties: false,
    },
    pinned: {},
  };
}

const run = (fetchImpl: typeof fetch) =>
  runRequestTool({ id: SPEC_ID, input: { symbol: 'BTC' } }, deps(fetchImpl));

describe('the check before every call', () => {
  it('keeps the hash its answer echoed with every spec', async () => {
    const hash = await hashNow();
    await storeSpecs(
      dir,
      [{ ...spec(), settingsHash: 'sha256:'.padEnd(71, '0') } as OfferSpec],
      hash,
    );
    expect((await readSpec(dir, SPEC_ID))?.settingsHash).toBe(hash);
    await storeSpecs(dir, [spec()]);
    expect((await readSpec(dir, SPEC_ID))?.settingsHash).toBeUndefined();
  });

  it('runs an offer decided under the rules saved now', async () => {
    await save({ policy: BLOCK_EXA });
    await storeSpecs(dir, [spec()], await hashNow());
    const { fetchImpl, calls } = net([...providerLegs(), { status: 204, body: {} }]);
    const result = await run(fetchImpl);
    expect(result.envelope).toMatchObject({ status: 'fulfilled' });
    expect(calls.filter((call) => call.url.startsWith(PROVIDER))).toHaveLength(2);
  });

  it('runs as it always did with no rules and no hash', async () => {
    await storeSpecs(dir, [spec()]);
    const { fetchImpl } = net([...providerLegs(), { status: 204, body: {} }]);
    expect((await run(fetchImpl)).envelope).toMatchObject({ status: 'fulfilled' });
  });

  it('refuses an offer decided before a rule was saved, before any provider request', async () => {
    await storeSpecs(dir, [spec()], await hashNow());
    await save({ policy: BLOCK_EXA });
    const { fetchImpl, calls } = net([]);
    const result = await run(fetchImpl);
    expect(result.isError).toBe(false);
    expect(result.envelope).toMatchObject({
      status: 'needs_input',
      reasonCode: 'settings_changed',
      cost: ['provider price 0 USD'],
    });
    expect(String(result.envelope.nextStep)).toContain('request({query})');
    expect(result.summary).not.toMatch(/hash|x402|USDC|wallet/i);
    // Nothing reached the provider, the router or the wallet.
    expect(calls).toEqual([]);
  });

  it('refuses an answer that echoed no hash while a rule is saved', async () => {
    await save({ policy: BLOCK_EXA });
    await storeSpecs(dir, [spec()]);
    const { fetchImpl, calls } = net([]);
    const result = await run(fetchImpl);
    expect(result.envelope).toMatchObject({ reasonCode: 'settings_unconfirmed' });
    expect(calls).toEqual([]);
  });

  it('refuses when automatic use changed after the decision', async () => {
    await storeSpecs(dir, [spec()], await hashNow());
    await save({ nativeReplacement: 'when-routed' });
    const { fetchImpl, calls } = net([]);
    expect((await run(fetchImpl)).envelope).toMatchObject({ reasonCode: 'settings_changed' });
    expect(calls).toEqual([]);
  });

  it('asks nothing and runs nothing while the rules cannot be read', async () => {
    await save({ policy: { version: 9 } });
    const { fetchImpl, calls } = net([]);
    const query = await runRequestTool({ query: 'BTC price' }, deps(fetchImpl));
    expect(query.envelope).toMatchObject({
      status: 'needs_input',
      reasonCode: 'settings_unreadable',
    });
    expect(String(query.envelope.nextStep)).toContain('tenjin config');
    expect(calls).toEqual([]);
  });

  it('refuses a whole group when one member was decided under other rules', async () => {
    const hash = await hashNow();
    expect(await settingsRefusal(dir, [hash, hash])).toBeNull();
    await save({ policy: BLOCK_EXA });
    const now = await hashNow();
    expect(await settingsRefusal(dir, [now, hash])).toMatchObject({ code: 'settings_changed' });
    expect(await settingsRefusal(dir, [now, undefined])).toMatchObject({
      code: 'settings_unconfirmed',
    });
    expect(await settingsRefusal(dir, [now, now])).toBeNull();
  });

  /** A change from another process needs no restart: each call reads it. */
  it('sends the rules saved now on every query, with the settings token', async () => {
    const native = {
      schemaVersion: 1,
      routerVersion: 'v',
      decision: {
        action: 'native',
        reason: 'r',
        diagnostics: {
          reasonCode: 'native_sufficient',
          stage: 'capability',
          missing: [],
          nextAction: '',
        },
      },
    };
    const first = net([{ status: 200, body: native }]);
    await runRequestTool({ query: 'BTC price' }, deps(first.fetchImpl));
    await save({ policy: BLOCK_EXA });
    const second = net([{ status: 200, body: native }]);
    await runRequestTool({ query: 'BTC price' }, deps(second.fetchImpl));
    const sent = [first, second].map(
      ({ calls }) =>
        JSON.parse(calls[0]!.body!) as {
          accepts: string[];
          settings: { policy: unknown; hash: string };
        },
    );
    expect(sent[0]!.settings.policy).toEqual({});
    expect(sent[1]!.settings.policy).toEqual({ block: [{ kind: 'provider', id: 'exa' }] });
    expect(sent[1]!.settings.hash).not.toBe(sent[0]!.settings.hash);
    expect(sent[1]!.accepts).toContain('settings');
  });

  it('refuses a server-built call whose answer did not apply the rules', async () => {
    await save({ policy: BLOCK_EXA });
    const { fetchImpl, calls } = net([
      {
        status: 200,
        body: {
          schemaVersion: 1,
          routerVersion: 'v',
          decision: {
            action: 'execute',
            capabilityId: 'context7-docs',
            category: 'library or API documentation',
            provider: 'Context7',
            capabilityDescription: 'library docs',
            providerPriceAtomic: '0',
            contract: {
              request: { url: `${PROVIDER}?q=zod`, method: 'GET', headers: {} },
            },
          },
        },
      },
    ]);
    const result = await runRequestTool({ query: 'zod docs', id: SPEC_ID }, deps(fetchImpl));
    expect(result.envelope).toMatchObject({ reasonCode: 'settings_unconfirmed' });
    // The routing call, and nothing to the provider.
    expect(calls).toHaveLength(1);
  });

  it('shows the rule a settings_blocked answer names, and pays nothing', async () => {
    await save({ policy: { version: 1, block: [{ kind: 'task', id: 'crypto price quote' }] } });
    const hash = await hashNow();
    const nextAction =
      'Your Tenjin settings block crypto price quote, so Tenjin did not offer a tool for this. The user can change that with `tenjin config`.';
    const { fetchImpl } = net([
      {
        status: 200,
        body: {
          schemaVersion: 1,
          routerVersion: 'v',
          honored: ['settings'],
          settingsHash: hash,
          decision: {
            action: 'native',
            reason: 'blocked by your settings',
            diagnostics: {
              reasonCode: 'settings_blocked',
              stage: 'capability',
              missing: [],
              nextAction,
            },
          },
        },
      },
    ]);
    const result = await runRequestTool({ query: 'BTC price' }, deps(fetchImpl));
    expect(result.summary).toContain(nextAction);
    expect(result.envelope).toMatchObject({
      status: 'native',
      reasonCode: 'settings_blocked',
      nextStep: nextAction,
    });
  });
});
