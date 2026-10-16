import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPaymentRequired, testWalletProvider } from '../lib/read-test-utils';
import { readQuote } from '../lib/spend-quotes';
import type { SpendAuthorization, SpendAuthorizer } from '../lib/wallet';
import type { CommandContext } from '../context';
import { storeChoices, storeSpecs } from './specs';
import { runApproveCommand } from './approve';
import type { Choices, OfferSpec } from './decision';
import { runApproveTool, runRequestTool, type HostApproval } from './tool';

/**
 * A CALL OVER THE AUTOMATIC LIMITS, PUT TO THE USER. `request` pays nothing
 * and keeps the call's exact plan as a quote; `approve({quote})` runs it only
 * on a person's yes: the host's own prompt, the host asking mid-call, or
 * `tenjin approve` at a terminal. The seller here answers each paid call with
 * an image's bytes.
 */

const ROUTER = 'https://tenjin.sh';
const ID = '0195f3a1-6c4d-7a2b-9e10-5f6a7b8c9d41';
const PAY_TO = '0xA7f3Ad0E69F61864092FAbBa6Cee00AF6e584689';
const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);

const SPEC: OfferSpec = {
  id: ID,
  capabilityId: 'aispace-hailuo-3-max',
  provider: 'AiSpace (Hailuo 3 Max)',
  output: 'media',
  description: 'Video from a prompt.',
  priceAtomic: '155000',
  priceVaries: false,
  maxAmountAtomic: '155000',
  payTo: PAY_TO,
  network: 'eip155:8453',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  request: {
    method: 'POST',
    url: 'https://x402.aispace.bot/api/v1/video/generate',
    fields: {},
    location: 'body',
  },
  input: { type: 'object', required: ['prompt'], properties: { prompt: { type: 'string' } } },
  pinned: {},
  takes: { max: 5 },
};
const INPUT = { prompt: 'a paper plane over a city skyline' };

let dir: string;
let clock: number;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'router-approve-'));
  // Its own git root: `router.*` resolves from here, never from the suite's cwd.
  await mkdir(join(dir, '.git'));
  await policy({ maxAutoSpend: '250000', sessionBudget: '5000000' });
  await storeSpecs(dir, [SPEC]);
  clock = Date.now();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const policy = (config: Record<string, string>) =>
  writeFile(join(dir, 'config.json'), JSON.stringify(config));

function ctx(isTTY = false): CommandContext {
  const sink = () => ({ write: () => true }) as unknown as NodeJS.WritableStream;
  return {
    flags: { json: true, timeout: 5000, baseUrl: ROUTER },
    dataDir: dir,
    io: { stdout: sink(), stderr: sink(), isTTY },
  };
}

function authorizer(): SpendAuthorizer {
  return {
    policyEnforcement: 'client-only',
    authorize: vi.fn(async (req): Promise<SpendAuthorization> => ({
      decision: req.mode === 'manual' ? 'confirm' : 'allow',
      reason: req.mode === 'manual' ? 'confirm_always' : 'within_policy',
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

/** The seller: a 402 at the spec's price, then the bytes; every call kept. */
function seller(price = SPEC.priceAtomic) {
  const calls: { url: string; paid: boolean; body?: string }[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    const paid = new Headers(init?.headers ?? {}).get('payment-signature') !== null;
    calls.push({ url, paid, ...(typeof init?.body === 'string' ? { body: init.body } : {}) });
    if (url.startsWith(ROUTER)) return new Response(null, { status: 204 });
    if (!paid) {
      const challenge = buildPaymentRequired({ amount: price, payTo: PAY_TO });
      return new Response('{}', {
        status: 402,
        headers: { 'content-type': 'application/json', 'PAYMENT-REQUIRED': challenge.header },
      });
    }
    return new Response(WEBP, { status: 200, headers: { 'content-type': 'image/webp' } });
  }) as typeof fetch;
  const paidCalls = () => calls.filter((call) => call.paid);
  return { fetchImpl, calls, paidCalls };
}

function deps(fetchImpl: typeof fetch, auth = authorizer(), balance = 100_000_000n) {
  return {
    ctx: ctx(),
    cwd: dir,
    authorizer: auth,
    fetchImpl,
    now: () => clock,
    pollTransport: async () => {
      throw new Error('no poll expected');
    },
    mediaTransport: async () => {
      throw new Error('no media download expected');
    },
    payDeps: {
      readBalance: async () => balance,
      fetchImpl,
      provider: testWalletProvider(),
      authorizer: auth,
      destination: { resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }] },
    },
  };
}

const prompted: HostApproval = { kind: 'prompted' };
const none: HostApproval = { kind: 'none' };

/** A call over the limits, quoted: the quote as the agent is handed it. */
async function quoted(
  args: Parameters<typeof runRequestTool>[0],
  fetchImpl: typeof fetch,
): Promise<{ id: string; total: string; what: string }> {
  const result = await runRequestTool(args, deps(fetchImpl));
  expect(result.envelope).toMatchObject({
    status: 'needs_approval',
    cost: ['provider price 0 USD'],
  });
  return result.envelope.quote as { id: string; total: string; what: string };
}

describe('a call over the automatic limits', () => {
  it('pays nothing, keeps the exact plan as a quote, and names the one call that asks', async () => {
    await policy({ maxAutoSpend: '100000', sessionBudget: '5000000' });
    const { fetchImpl, paidCalls } = seller();
    const result = await runRequestTool({ id: ID, input: INPUT }, deps(fetchImpl));
    expect(result.isError).toBe(false);
    expect(result.envelope).toMatchObject({
      status: 'needs_approval',
      cost: ['provider price 0 USD'],
      quote: { what: 'one call to AiSpace (Hailuo 3 Max)', total: '$0.155' },
    });
    expect(result.envelope.reason).toBe(
      'One call to AiSpace (Hailuo 3 Max) costs $0.155. That is over the $0.1 this machine pays for one call without asking, so nothing was paid.',
    );
    const { id } = result.envelope.quote as { id: string };
    expect(result.envelope.nextStep).toBe(
      `Call approve({quote: "${id}", total: "$0.155", what: "one call to AiSpace (Hailuo 3 Max)"}): it asks the user and runs only on their yes. Do not suggest changing a setting.`,
    );
    expect(JSON.stringify(result)).not.toContain('config set');
    expect(paidCalls()).toEqual([]);
    const kept = await readQuote(dir, id);
    expect(kept).toMatchObject({
      totalAtomic: '155000',
      payments: [{ amountAtomic: '155000', creator: 'x402.aispace.bot' }],
      call: { kind: 'spec', id: ID, input: INPUT },
    });
    expect(kept!.usedAt).toBeUndefined();
  });

  it('runs under the limits with no question at all', async () => {
    const { fetchImpl, paidCalls } = seller();
    const result = await runRequestTool({ id: ID, input: INPUT }, deps(fetchImpl));
    expect(result.envelope).toMatchObject({ status: 'fulfilled' });
    expect(paidCalls()).toHaveLength(1);
    expect(await readdir(join(dir, 'quotes')).catch(() => [])).toEqual([]);
  });
});

describe('approve, on a host that prompts before every call', () => {
  it("runs exactly the quoted call once, as the user's own payment", async () => {
    await policy({ maxAutoSpend: '100000', sessionBudget: '100000' });
    const { fetchImpl, paidCalls } = seller();
    const quote = await quoted({ id: ID, input: INPUT }, fetchImpl);
    const auth = authorizer();
    const result = await runApproveTool(
      { quote: quote.id, total: quote.total, what: quote.what },
      { ...deps(fetchImpl, auth), host: prompted },
    );
    expect(result.envelope).toMatchObject({
      status: 'fulfilled',
      cost: ['provider price 0.155 USD'],
    });
    expect(paidCalls()).toHaveLength(1);
    expect(JSON.parse(paidCalls()[0]!.body!)).toEqual(INPUT);
    // Over both limits, and paid: a person agreed to it.
    expect(auth.authorize).toHaveBeenCalledWith(expect.objectContaining({ mode: 'manual' }));
    expect(await readQuote(dir, quote.id)).toMatchObject({ usedAt: expect.any(String) as string });

    // A quote pays once.
    const again = await runApproveTool(
      { quote: quote.id, total: quote.total, what: quote.what },
      { ...deps(fetchImpl), host: prompted },
    );
    expect(again.envelope).toMatchObject({ status: 'needs_input' });
    expect(String(again.envelope.reason)).toContain('already ran');
    expect(paidCalls()).toHaveLength(1);
  });

  it('refuses a total or a what that is not the quote, naming the true ones', async () => {
    await policy({ maxAutoSpend: '100000', sessionBudget: '5000000' });
    const { fetchImpl, paidCalls } = seller();
    const quote = await quoted({ id: ID, input: INPUT }, fetchImpl);
    for (const echoed of [
      { total: '$0.01', what: quote.what },
      { total: quote.total, what: 'one cheap call' },
    ]) {
      const result = await runApproveTool(
        { quote: quote.id, ...echoed },
        { ...deps(fetchImpl), host: prompted },
      );
      expect(result.envelope).toMatchObject({ status: 'needs_input', quote: { total: '$0.155' } });
      expect(String(result.envelope.reason)).toContain(
        'That quote is for one call to AiSpace (Hailuo 3 Max), $0.155 in total',
      );
    }
    // The prompt showed only the id: nobody saw what they said yes to.
    const bare = await runApproveTool({ quote: quote.id }, { ...deps(fetchImpl), host: prompted });
    expect(bare.envelope).toMatchObject({ status: 'needs_input' });
    expect(paidCalls()).toEqual([]);
    expect((await readQuote(dir, quote.id))!.usedAt).toBeUndefined();
    // `0.155` is the same total as `$0.155`.
    const plain = await runApproveTool(
      { quote: quote.id, total: '0.155', what: quote.what },
      { ...deps(fetchImpl), host: prompted },
    );
    expect(plain.envelope).toMatchObject({ status: 'fulfilled' });
  });

  it('refuses a quote past its ten minutes, and one it never kept', async () => {
    await policy({ maxAutoSpend: '100000', sessionBudget: '5000000' });
    const { fetchImpl, paidCalls } = seller();
    const quote = await quoted({ id: ID, input: INPUT }, fetchImpl);
    clock += 10 * 60_000 + 1;
    const late = await runApproveTool(
      { quote: quote.id, total: quote.total, what: quote.what },
      { ...deps(fetchImpl), host: prompted },
    );
    expect(late.envelope).toMatchObject({ status: 'needs_input' });
    expect(String(late.envelope.reason)).toContain('expired');
    const unknown = await runApproveTool(
      { quote: 'q_AAAAAAAAAAAA', total: '$1', what: 'x' },
      { ...deps(fetchImpl), host: prompted },
    );
    expect(String(unknown.envelope.reason)).toContain('No quote is kept');
    expect(paidCalls()).toEqual([]);
  });

  it('never runs past the balance, and leaves the quote for a funded wallet', async () => {
    await policy({ maxAutoSpend: '100000', sessionBudget: '5000000' });
    const { fetchImpl, paidCalls } = seller();
    const quote = await quoted({ id: ID, input: INPUT }, fetchImpl);
    const short = await runApproveTool(
      { quote: quote.id, total: quote.total, what: quote.what },
      { ...deps(fetchImpl, authorizer(), 100_000n), host: prompted },
    );
    // The wallet emptied after the quote: the fund command, nothing paid.
    expect(short.envelope).toMatchObject({ status: 'failed', cost: ['provider price 0 USD'] });
    expect(String(short.envelope.reason)).toContain('`tenjin wallet fund`');
    expect(paidCalls()).toEqual([]);
    expect((await readQuote(dir, quote.id))!.usedAt).toBeUndefined();
  });
});

describe('approve, on a host that asks mid-call', () => {
  it("asks with the quote's own sentence, and runs only on accept", async () => {
    await policy({ maxAutoSpend: '100000', sessionBudget: '5000000' });
    const { fetchImpl, paidCalls } = seller();
    const quote = await quoted({ id: ID, input: INPUT }, fetchImpl);
    const asked: string[] = [];
    const declined = await runApproveTool(
      { quote: quote.id },
      {
        ...deps(fetchImpl),
        host: {
          kind: 'asks',
          ask: async (message) => {
            asked.push(message);
            return 'decline';
          },
        },
      },
    );
    expect(asked).toEqual(['One call to AiSpace (Hailuo 3 Max) costs $0.155. Go ahead?']);
    expect(declined.isError).toBe(false);
    expect(declined.envelope).toMatchObject({ status: 'declined', cost: ['provider price 0 USD'] });
    expect(paidCalls()).toEqual([]);
    expect((await readQuote(dir, quote.id))!.usedAt).toBeUndefined();

    const accepted = await runApproveTool(
      { quote: quote.id },
      { ...deps(fetchImpl), host: { kind: 'asks', ask: async () => 'accept' } },
    );
    expect(accepted.envelope).toMatchObject({ status: 'fulfilled' });
    expect(paidCalls()).toHaveLength(1);
  });
});

describe('approve, on a host that can do neither', () => {
  it('pays nothing and names the terminal command, which a person answers', async () => {
    await policy({ maxAutoSpend: '100000', sessionBudget: '5000000' });
    const { fetchImpl, paidCalls } = seller();
    const quote = await quoted({ id: ID, input: INPUT }, fetchImpl);
    const first = await runApproveTool({ quote: quote.id }, { ...deps(fetchImpl), host: none });
    expect(first.envelope).toMatchObject({ status: 'needs_approval' });
    expect(String(first.envelope.nextStep)).toContain(`\`tenjin approve ${quote.id}\``);
    expect(paidCalls()).toEqual([]);

    // An agent's shell is no terminal: it cannot approve its own quote.
    await expect(runApproveCommand({ quote: quote.id }, ctx(false))).rejects.toMatchObject({
      code: 'REFUSED',
    });
    const asked: string[] = [];
    const said = await runApproveCommand({ quote: quote.id }, ctx(true), {
      ask: async (prompt) => {
        asked.push(prompt);
        return true;
      },
      now: () => clock,
    });
    expect(asked).toEqual(['One call to AiSpace (Hailuo 3 Max) costs $0.155. Go ahead? [y/N] ']);
    expect(said.data).toMatchObject({ approved: true });

    const ran = await runApproveTool({ quote: quote.id }, { ...deps(fetchImpl), host: none });
    expect(ran.envelope).toMatchObject({ status: 'fulfilled' });
    expect(paidCalls()).toHaveLength(1);
  });
});

describe('approve runs every kind of plan', () => {
  it('runs a count whose total was over the per-call limit, take by take', async () => {
    await policy({ maxAutoSpend: '250000', sessionBudget: '5000000' });
    const { fetchImpl, paidCalls } = seller();
    const quote = await quoted({ id: ID, input: INPUT, count: 5 }, fetchImpl);
    expect(quote).toMatchObject({ what: '5 takes of AiSpace (Hailuo 3 Max)', total: '$0.775' });
    const kept = await readQuote(dir, quote.id);
    expect(kept!.sentence).toBe(
      '5 takes of AiSpace (Hailuo 3 Max) cost $0.775 in total ($0.155 each).',
    );
    const result = await runApproveTool(
      { quote: quote.id, total: quote.total, what: quote.what },
      { ...deps(fetchImpl), host: prompted },
    );
    expect(result.envelope).toMatchObject({
      status: 'fulfilled',
      count: 5,
      cost: ['provider price 0.775 USD'],
    });
    expect(paidCalls()).toHaveLength(5);
  });

  it('runs a choice set quoted over the limit, each option at its quote', async () => {
    const other: OfferSpec = {
      ...SPEC,
      id: '0195f3a1-6c4d-7a2b-9e10-5f6a7b8c9d42',
      capabilityId: 'aispace-other-video',
      provider: 'AiSpace (Other)',
    };
    const choices: Choices = {
      group: 'video',
      default: 'hailuo',
      input: ['prompt'],
      options: [
        { key: 'hailuo', label: 'Hailuo 3 Max', strength: 'Cinematic.', id: SPEC.id },
        { key: 'other', label: 'Other', strength: 'Cheap.', id: other.id },
      ],
      all: { totalAtomic: '310000' },
    };
    await storeSpecs(dir, [SPEC, other]);
    await storeChoices(dir, SPEC.id, { choices, hint: 'Pick one, or all.' });
    const { fetchImpl, paidCalls } = seller();
    const quote = await quoted({ id: SPEC.id, choice: 'all', input: INPUT }, fetchImpl);
    expect(quote).toMatchObject({ what: '2 choices (Hailuo 3 Max, Other)', total: '$0.31' });
    const result = await runApproveTool(
      { quote: quote.id, total: quote.total, what: quote.what },
      { ...deps(fetchImpl), host: prompted },
    );
    expect(result.envelope).toMatchObject({
      status: 'fulfilled',
      choice: 'all',
      cost: ['provider price 0.31 USD'],
    });
    expect(paidCalls()).toHaveLength(2);
  });
});
