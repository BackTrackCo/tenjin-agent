import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPaymentRequired, testWalletProvider } from '../lib/read-test-utils';
import { resolveContextSettings } from '../lib/settings';
import type { SpendAuthorization, SpendAuthorizer } from '../lib/wallet';
import { createLocalSpendAuthorizer } from '../lib/wallet/spend';
import type { CommandContext } from '../context';
import { ROUTER_PATH, type OfferSpec } from './decision';
import type { PollTransport } from './jobs';
import { storeSpecs } from './specs';
import { runRequestTool } from './tool';

/**
 * `request({id, input, count})`: several takes of one media call, each its own
 * claim, request key and payment, after one spend check for them all. The
 * seller here answers each paid take with the image's bytes.
 */

const ROUTER = 'https://tenjin.sh';
const ID = '0195f3a1-6c4d-7a2b-9e10-5f6a7b8c9d31';
const PAY_TO = '0xA7f3Ad0E69F61864092FAbBa6Cee00AF6e584689';
const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);

const SPEC: OfferSpec = {
  id: ID,
  capabilityId: 'aispace-muse-image',
  provider: 'AiSpace (Muse)',
  output: 'media',
  description: 'Images from a prompt.',
  priceAtomic: '50000',
  priceVaries: false,
  maxAmountAtomic: '50000',
  payTo: PAY_TO,
  network: 'eip155:8453',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  request: {
    method: 'POST',
    url: 'https://x402.aispace.bot/api/v1/images/generations',
    fields: {},
    location: 'body',
  },
  input: { type: 'object', required: ['prompt'], properties: { prompt: { type: 'string' } } },
  pinned: {},
  takes: { max: 5 },
};
const INPUT = { prompt: 'a lighthouse on a rocky coast at dusk' };

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'router-count-'));
  // Its own git root: `router.*` resolves from here, never from the suite's cwd.
  await mkdir(join(dir, '.git'));
  await policy({ maxAutoSpend: '250000', sessionBudget: '5000000' });
  await storeSpecs(dir, [SPEC]);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const policy = (config: Record<string, string>) =>
  writeFile(join(dir, 'config.json'), JSON.stringify(config));

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

/** The seller: a 402, then the image, except the paid takes `failing` names
 *  (by the order they arrive), which answer 500 after the payment left. A
 *  `slowMs` paid answer keeps every take's payment in flight at once, as a
 *  real render does. `quotes` prices each unpaid request in the order it
 *  arrives, the last one repeating; the spec's price otherwise. */
function seller(failing: number[] = [], slowMs = 0, quotes: string[] = [SPEC.priceAtomic]) {
  const calls: { url: string; paid: boolean; body?: string }[] = [];
  let paidSeen = 0;
  let quotesSeen = 0;
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    const paid = new Headers(init?.headers ?? {}).get('payment-signature') !== null;
    calls.push({ url, paid, ...(typeof init?.body === 'string' ? { body: init.body } : {}) });
    if (url.startsWith(ROUTER)) return new Response(null, { status: 204 });
    if (!paid) {
      const amount = quotes[Math.min(quotesSeen, quotes.length - 1)]!;
      quotesSeen += 1;
      const challenge = buildPaymentRequired({ amount, payTo: PAY_TO });
      return new Response('{}', {
        status: 402,
        headers: { 'content-type': 'application/json', 'PAYMENT-REQUIRED': challenge.header },
      });
    }
    paidSeen += 1;
    const seen = paidSeen;
    if (slowMs > 0) await new Promise((resolve) => setTimeout(resolve, slowMs));
    if (failing.includes(seen)) {
      return new Response(JSON.stringify({ error: 'render failed' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(WEBP, { status: 200, headers: { 'content-type': 'image/webp' } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const noPolls: PollTransport = async (target) => {
  throw new Error(`no poll expected: ${target.url.toString()}`);
};

function deps(fetchImpl: typeof fetch, auth: SpendAuthorizer = authorizer()) {
  return {
    ctx: ctx(),
    cwd: dir,
    authorizer: auth,
    fetchImpl,
    pollTransport: noPolls,
    mediaTransport: async () => {
      throw new Error('no media download expected');
    },
    payDeps: {
      readBalance: async () => 100_000_000n,
      fetchImpl,
      provider: testWalletProvider(),
      authorizer: auth,
      destination: { resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }] },
    },
  };
}

const claims = async () =>
  (await readdir(join(dir, 'progress', 'specs'))).filter((name) => name.endsWith('.paid.json'));
const reports = (calls: { url: string; body?: string }[]) =>
  calls
    .filter((call) => call.url === `${ROUTER}${ROUTER_PATH}`)
    .map((call) => JSON.parse(call.body!) as Record<string, unknown>);

describe('several takes of one call', () => {
  it('pays each take under its own claim and request key, and passes the real duplicate guard', async () => {
    const settings = await resolveContextSettings(ctx());
    const auth = createLocalSpendAuthorizer({ dir, policy: settings.policy });
    const { fetchImpl, calls } = seller([], 100);
    const result = await runRequestTool({ id: ID, input: INPUT, count: 3 }, deps(fetchImpl, auth));
    expect(result.envelope).toMatchObject({
      status: 'fulfilled',
      count: 3,
      cost: ['provider price 0.15 USD'],
    });
    const results = result.envelope.results as Record<string, unknown>[];
    expect(results.map((take) => [take.take, take.status])).toEqual([
      [1, 'fulfilled'],
      [2, 'fulfilled'],
      [3, 'fulfilled'],
    ]);
    const files = results.map((take) => (take.savedFiles as string[])[0]);
    expect(new Set(files).size).toBe(3);
    expect(calls.filter((call) => call.paid)).toHaveLength(3);
    expect(await claims()).toHaveLength(3);
    // ONE REPORT FOR THE OFFER, not one per take.
    await vi.waitFor(() => expect(reports(calls)).toHaveLength(1));
    expect(reports(calls)[0]).toMatchObject({ id: ID, status: 'fulfilled' });
  });

  it('returns partial when one take fails, with every take keyed apart', async () => {
    const auth = authorizer();
    const { fetchImpl, calls } = seller([2]);
    const result = await runRequestTool({ id: ID, input: INPUT, count: 3 }, deps(fetchImpl, auth));
    expect(result.isError).toBe(false);
    expect(result.envelope).toMatchObject({ status: 'partial', cost: ['provider price 0.15 USD'] });
    const statuses = (result.envelope.results as Record<string, unknown>[]).map(
      (take) => take.status,
    );
    expect(statuses.filter((status) => status === 'fulfilled')).toHaveLength(2);
    expect(statuses.filter((status) => status === 'failed')).toHaveLength(1);
    const keys = vi.mocked(auth.authorize).mock.calls.map(([req]) => req.requestKey!);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(3);
    expect(keys.map((key) => key.slice(-2)).sort()).toEqual(['#1', '#2', '#3']);
    expect(calls.filter((call) => call.paid)).toHaveLength(3);

    // A repeat pays only for takes no earlier call claimed: here, none.
    const again = seller();
    const repeat = await runRequestTool({ id: ID, input: INPUT, count: 3 }, deps(again.fetchImpl));
    expect(repeat.envelope).toMatchObject({ status: 'needs_input' });
    expect(again.calls.filter((call) => call.paid)).toEqual([]);
  });

  it('signs nothing, and keeps no claim, when the takes together are over the budget', async () => {
    await policy({ maxAutoSpend: '250000', sessionBudget: '120000' });
    const auth = authorizer();
    const { fetchImpl, calls } = seller();
    const result = await runRequestTool({ id: ID, input: INPUT, count: 3 }, deps(fetchImpl, auth));
    expect(result.envelope).toMatchObject({
      status: 'needs_approval',
      cost: ['provider price 0 USD'],
    });
    expect(String(result.envelope.reason)).toContain(
      '3 takes of AiSpace (Muse) costs $0.15 at its live price',
    );
    expect(String(result.envelope.reason)).toContain('tenjin config set sessionBudget');
    expect(auth.authorize).not.toHaveBeenCalled();
    // One unpaid probe for the price, and nothing else.
    expect(calls.filter((call) => !call.url.startsWith(ROUTER))).toEqual([
      expect.objectContaining({ paid: false }),
    ]);
    expect(await claims()).toEqual([]);
  });

  it('refuses a take over the per-call cap before anything is signed', async () => {
    await policy({ maxAutoSpend: '40000', sessionBudget: '5000000' });
    const auth = authorizer();
    const { fetchImpl, calls } = seller();
    const result = await runRequestTool({ id: ID, input: INPUT, count: 2 }, deps(fetchImpl, auth));
    expect(result.envelope).toMatchObject({ status: 'needs_approval' });
    expect(auth.authorize).not.toHaveBeenCalled();
    expect(calls.filter((call) => call.paid)).toEqual([]);
  });

  /** A PRICE THAT VARIES BY INPUT IS CHECKED AT WHAT THIS INPUT COSTS: GPT
   *  Image 2 is quoted 6.4¢ against a $1 ceiling, and three takes fit a
   *  $0.25 per-call cap, as one call does. */
  const GPT_IMAGE_2: OfferSpec = {
    ...SPEC,
    capabilityId: 'blockrun-image-gpt-image-2',
    provider: 'BlockRun (OpenAI GPT Image 2)',
    priceAtomic: '64000',
    priceVaries: true,
    maxAmountAtomic: '1000000',
  };

  it('checks the takes at the live quote, not the ceiling, so GPT Image 2 runs three', async () => {
    await storeSpecs(dir, [GPT_IMAGE_2]);
    const auth = authorizer();
    const { fetchImpl, calls } = seller([], 0, ['64000']);
    const result = await runRequestTool({ id: ID, input: INPUT, count: 3 }, deps(fetchImpl, auth));
    expect(result.envelope).toMatchObject({
      status: 'fulfilled',
      count: 3,
      cost: ['provider price 0.192 USD'],
    });
    expect(calls.filter((call) => call.paid)).toHaveLength(3);
    expect(auth.authorize).toHaveBeenCalledTimes(3);
  });

  it('checks the session budget at the live quote too', async () => {
    await storeSpecs(dir, [GPT_IMAGE_2]);
    await policy({ maxAutoSpend: '250000', sessionBudget: '150000' });
    const auth = authorizer();
    const { fetchImpl, calls } = seller([], 0, ['64000']);
    const result = await runRequestTool({ id: ID, input: INPUT, count: 3 }, deps(fetchImpl, auth));
    expect(result.envelope).toMatchObject({ status: 'needs_approval' });
    expect(String(result.envelope.reason)).toContain('costs $0.192 at its live price');
    expect(auth.authorize).not.toHaveBeenCalled();
    expect(calls.filter((call) => call.paid)).toEqual([]);
    expect(await claims()).toEqual([]);
  });

  it("refuses the count when the live quote is over the spec's ceiling, with nothing claimed", async () => {
    await storeSpecs(dir, [GPT_IMAGE_2]);
    const auth = authorizer();
    const { fetchImpl, calls } = seller([], 0, ['1500000']);
    const result = await runRequestTool({ id: ID, input: INPUT, count: 2 }, deps(fetchImpl, auth));
    expect(result.envelope).toMatchObject({ status: 'failed', cost: ['provider price 0 USD'] });
    expect(String(result.envelope.reason)).toContain("over this spec's $1 ceiling");
    expect(auth.authorize).not.toHaveBeenCalled();
    expect(calls.filter((call) => call.paid)).toEqual([]);
    expect(await claims()).toEqual([]);
    await vi.waitFor(() => expect(reports(calls)).toHaveLength(1));
    expect(reports(calls)[0]).toMatchObject({ id: ID, status: 'unpaid', reason: 'terms' });
  });

  /** A TAKE QUOTED HIGHER THAN THE FIRST meets the spend gate again on its
   *  own when it is signed, and is refused there with nothing signed. */
  it('re-checks a take quoted higher on its own, and signs nothing for it', async () => {
    await storeSpecs(dir, [GPT_IMAGE_2]);
    const settings = await resolveContextSettings(ctx());
    const auth = createLocalSpendAuthorizer({ dir, policy: settings.policy });
    // The set's quote and two takes at 6.4¢, then one take at 30¢: over the cap.
    const { fetchImpl, calls } = seller([], 0, ['64000', '64000', '64000', '300000']);
    const result = await runRequestTool({ id: ID, input: INPUT, count: 3 }, deps(fetchImpl, auth));
    expect(result.envelope).toMatchObject({
      status: 'partial',
      cost: ['provider price 0.128 USD'],
    });
    const statuses = (result.envelope.results as Record<string, unknown>[]).map(
      (take) => take.status,
    );
    expect(statuses.sort()).toEqual(['fulfilled', 'fulfilled', 'needs_approval']);
    expect(calls.filter((call) => call.paid)).toHaveLength(2);
  });

  it('runs takes only where the spec allows them, and never beside a choice', async () => {
    await storeSpecs(dir, [{ ...SPEC, takes: undefined }]);
    const { fetchImpl, calls } = seller();
    const none = await runRequestTool({ id: ID, input: INPUT, count: 2 }, deps(fetchImpl));
    expect(none.envelope).toMatchObject({ status: 'needs_input' });
    expect(String(none.envelope.reason)).toContain('does not run several takes');
    await storeSpecs(dir, [{ ...SPEC, takes: { max: 2 } }]);
    const over = await runRequestTool({ id: ID, input: INPUT, count: 3 }, deps(fetchImpl));
    expect(String(over.envelope.reason)).toContain('at most 2 takes');
    const chosen = await runRequestTool(
      { id: ID, input: INPUT, count: 2, choice: 'all' },
      deps(fetchImpl),
    );
    expect(String(chosen.envelope.reason)).toContain('does not go with a choice');
    const odd = await runRequestTool({ id: ID, input: INPUT, count: 7 }, deps(fetchImpl));
    expect(String(odd.envelope.reason)).toContain('from 2 to 5');
    expect(calls).toEqual([]);
  });
});
