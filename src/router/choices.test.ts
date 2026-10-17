import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPaymentRequired, testWalletProvider } from '../lib/read-test-utils';
import type { SpendAuthorization, SpendAuthorizer } from '../lib/wallet';
import type { CommandContext } from '../context';
import { ROUTER_PATH, type Choices, type OfferSpec } from './decision';
import type { MediaTransport } from './paid';
import { storeChoices, storeSpecs } from './specs';
import { runRequestTool } from './tool';

/**
 * `request({id, choice: "all"})`: every option of a line's choice set, each
 * its own offer with its own id, claim, payment, ledger line and outcome
 * report, run side by side once the whole set's plan, each option at its live
 * quote, fits the spend policy. The set here is the shared choices fixture:
 * one model that answers JSON linking its image and one that answers raw
 * image bytes, $0.085 together.
 */

const fixture = JSON.parse(
  await readFile(
    fileURLToPath(new URL('./fixtures/wire-hook-discovered-choices.json', import.meta.url)),
    'utf8',
  ),
) as { decision: { id: string; hint: string; specs: OfferSpec[]; choices: Choices } };
const { id: ID, hint: HINT, specs: SPECS, choices: CHOICES } = fixture.decision;
const [GPT, BANANA] = SPECS as [OfferSpec, OfferSpec];
const ROUTER = 'https://tenjin.sh';
const IMAGE_URL = 'https://cdn.example.test/out/gpt.png';
const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const TX = `0x${'ab'.repeat(32)}`;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'router-choices-'));
  // Its own git root: `router.*` resolves from here, never from the suite's cwd.
  await mkdir(join(dir, '.git'));
  await policy({ maxAutoSpend: '500000', sessionBudget: '5000000' });
  await storeSpecs(dir, SPECS);
  await storeChoices(dir, ID, { choices: CHOICES, hint: HINT });
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

/** How one model answers its paid call. */
type Answer = 'image' | 'unsettled' | 'refused';

/**
 * THE THREE SELLERS, ANSWERING SIDE BY SIDE. The calls arrive interleaved, so
 * each answer is picked by the model the request names, not by its order: a
 * 402 at the spec's own price and payee, then the paid answer. Every request
 * is recorded, the outcome reports included.
 */
function sellers(answers: Partial<Record<string, Answer>> = {}) {
  const calls: { url: string; model?: string; paid: boolean; body?: string }[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? init.body : undefined;
    const paid = new Headers(init?.headers ?? {}).get('payment-signature') !== null;
    const spec = SPECS.find(
      (each) =>
        each.request.url === url &&
        body !== undefined &&
        (JSON.parse(body) as { model?: string }).model === each.pinned.model,
    );
    calls.push({
      url,
      paid,
      ...(spec !== undefined ? { model: String(spec.pinned.model) } : {}),
      ...(body !== undefined ? { body } : {}),
    });
    if (spec === undefined) return new Response('{}', { status: 200 });
    const answer = answers[String(spec.pinned.model)] ?? 'image';
    if (answer === 'refused') {
      return new Response(JSON.stringify({ error: 'prompt refused' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (!paid) {
      const challenge = buildPaymentRequired({ amount: spec.priceAtomic, payTo: spec.payTo });
      return new Response('{}', {
        status: 402,
        headers: { 'content-type': 'application/json', 'PAYMENT-REQUIRED': challenge.header },
      });
    }
    const settled: Record<string, string> =
      answer === 'unsettled'
        ? {}
        : {
            'PAYMENT-RESPONSE': Buffer.from(
              JSON.stringify({ success: true, transaction: TX }),
            ).toString('base64'),
          };
    if (spec === GPT) {
      return new Response(JSON.stringify({ id: 'img_1', data: [{ url: IMAGE_URL }] }), {
        status: 200,
        headers: { 'content-type': 'application/json', ...settled },
      });
    }
    return new Response(WEBP, {
      status: 200,
      headers: { 'content-type': 'image/webp', ...settled },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const mediaTransport: MediaTransport = async () => ({
  status: 200,
  body: (async function* () {
    yield PNG;
  })(),
  discard: () => undefined,
});

function deps(fetchImpl: typeof fetch, auth = authorizer()) {
  return {
    ctx: ctx(),
    cwd: dir,
    authorizer: auth,
    fetchImpl,
    mediaTransport,
    payDeps: {
      readBalance: async () => 100_000_000n,
      fetchImpl,
      provider: testWalletProvider(),
      authorizer: auth,
      destination: { resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }] },
    },
  };
}

const INPUT = { prompt: 'a lighthouse on a rocky coast at dusk' };
const reports = (calls: { url: string; body?: string }[]) =>
  calls
    .filter((call) => call.url === `${ROUTER}${ROUTER_PATH}`)
    .map((call) => JSON.parse(call.body!) as { id: string; status: string });
/** A set stopped before payment: no seller paid, and one report per choice. */
const stoppedSet = async (
  calls: { url: string; paid?: boolean; body?: string }[],
  outcome: { status: string; reason?: string },
) => {
  expect(calls.filter((call) => call.paid === true)).toEqual([]);
  await vi.waitFor(() => expect(reports(calls)).toHaveLength(SPECS.length));
  for (const report of reports(calls)) expect(report).toMatchObject(outcome);
  expect(
    reports(calls)
      .map((report) => report.id)
      .sort(),
  ).toEqual(SPECS.map((spec) => spec.id).sort());
};
const ledger = async () =>
  (await readFile(join(dir, 'paid', 'ledger.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
const claims = async () =>
  (await readdir(join(dir, 'progress', 'specs'))).filter((name) => name.endsWith('.paid.json'));

describe('running every choice', () => {
  it('pays each model once under its own id, saves every image, and returns one result', async () => {
    const auth = authorizer();
    const { fetchImpl, calls } = sellers({ 'gpt-image-2-5-sunburst': 'unsettled' });
    const result = await runRequestTool(
      { id: ID, choice: 'all', input: INPUT },
      deps(fetchImpl, auth),
    );

    expect(result.isError).toBe(false);
    expect(result.envelope).toMatchObject({
      status: 'fulfilled',
      choice: 'all',
      cost: ['provider price 0.085 USD'],
      nextStep:
        'Open each saved image, say which fits the request best and why, and let the user pick.',
      providerContentUntrusted: true,
    });
    const results = result.envelope.results as Record<string, unknown>[];
    expect(results.map((step) => [step.key, step.id, step.status])).toEqual([
      ['gpt-image-2.5', GPT.id, 'fulfilled'],
      ['nano-banana-2.1', BANANA.id, 'fulfilled'],
    ]);
    expect(results[0]).toMatchObject({
      label: 'GPT Image 2.5 Sunburst',
      supplier: 'api.gondola-ai.com',
      cost: ['provider price 0.035 USD'],
    });
    expect(results[0]).not.toHaveProperty('settlementTxHash');
    expect(results[1]).toMatchObject({
      label: 'Nano Banana 2.1',
      supplier: 'x402.aispace.bot',
      cost: ['provider price 0.05 USD'],
      settlementTxHash: TX,
      result: { contentType: 'image/webp', bytes: WEBP.byteLength },
    });
    for (const step of results) expect(step).not.toHaveProperty('providerContentUntrusted');

    // A linked image and a binary body, each saved where its entry says.
    const saved = results.map((step) => (step.savedFiles as string[])[0]!);
    expect(saved[0]).toMatch(/\.png$/);
    expect(new Uint8Array(await readFile(saved[0]!))).toEqual(PNG);
    expect(new Uint8Array(await readFile(saved[1]!))).toEqual(WEBP);
    for (const path of saved) expect(result.summary).toContain(path);

    // One pinned request and one payment per model, each with its own pins.
    expect(calls.filter((call) => call.paid).map((call) => call.model)).toEqual(
      expect.arrayContaining(['gpt-image-2-5-sunburst', 'nano-banana-2-1']),
    );
    expect(calls.filter((call) => call.paid)).toHaveLength(2);
    expect(JSON.parse(calls.find((call) => call.model === 'nano-banana-2-1')!.body!)).toEqual({
      prompt: INPUT.prompt,
      model: 'nano-banana-2-1',
      resolution: '1K',
      return_binary: true,
    });
    expect(auth.authorize).toHaveBeenCalledTimes(2);

    // Two ledger lines, the unsettled one recorded as unknown.
    const rows = await ledger();
    expect(rows.map((row) => [row.amountAtomic, row.settlement]).sort()).toEqual([
      ['35000', 'unknown'],
      ['50000', 'settled'],
    ]);
    // Two claims kept as paid, and two outcome reports, one per id.
    expect(await claims()).toHaveLength(2);
    await vi.waitFor(() => expect(reports(calls)).toHaveLength(2));
    expect(
      reports(calls)
        .map((report) => report.id)
        .sort(),
    ).toEqual([GPT.id, BANANA.id].sort());
  });

  it('pays nothing the second time: every choice already ran under its own id', async () => {
    const first = sellers();
    await runRequestTool({ id: ID, choice: 'all', input: INPUT }, deps(first.fetchImpl));
    const auth = authorizer();
    const again = sellers();
    const result = await runRequestTool(
      { id: ID, choice: 'all', input: INPUT },
      deps(again.fetchImpl, auth),
    );
    expect(result.isError).toBe(false);
    expect(result.envelope).toMatchObject({
      status: 'needs_input',
      cost: ['provider price 0 USD'],
    });
    expect(String(result.envelope.reason)).toContain('already ran');
    expect(again.calls.filter((call) => call.model !== undefined)).toEqual([]);
    expect(auth.authorize).not.toHaveBeenCalled();
  });

  /** ONE MODEL REFUSING THE PROMPT before any payment costs the set that one
   *  image: the others are paid and saved, and the refused one is free to run
   *  again, alone, while the paid ones are not paid twice. */
  it('returns a partial result when one model refuses, and reruns only that one', async () => {
    const { fetchImpl, calls } = sellers({ 'nano-banana-2-1': 'refused' });
    const result = await runRequestTool({ id: ID, choice: 'all', input: INPUT }, deps(fetchImpl));
    expect(result.isError).toBe(false);
    expect(result.envelope).toMatchObject({
      status: 'partial',
      cost: ['provider price 0.035 USD'],
    });
    const results = result.envelope.results as Record<string, unknown>[];
    expect(results[1]).toMatchObject({
      key: 'nano-banana-2.1',
      status: 'failed',
      providerStatus: 400,
      cost: ['provider price 0 USD'],
    });
    expect(calls.filter((call) => call.paid)).toHaveLength(1);
    expect(await claims()).toHaveLength(1);

    const retry = sellers();
    const rerun = await runRequestTool(
      { id: ID, choice: 'all', input: INPUT },
      deps(retry.fetchImpl),
    );
    expect(
      (rerun.envelope.results as Record<string, unknown>[]).map((step) => step.status),
    ).toEqual(['already_paid', 'fulfilled']);
    expect(rerun.envelope).toMatchObject({
      status: 'fulfilled',
      cost: ['provider price 0.05 USD'],
    });
    expect(retry.calls.filter((call) => call.paid).map((call) => call.model)).toEqual([
      'nano-banana-2-1',
    ]);
  });

  /** THE SET IS ONE CALL: its total meets the per-call limit, however small
   *  each image is. Over it, the set is quoted for the user's yes. */
  it('quotes a set whose total is over the per-call limit, and signs nothing', async () => {
    // Each image fits $0.06 alone; the set does not.
    await policy({ maxAutoSpend: '60000', sessionBudget: '5000000' });
    const auth = authorizer();
    const { fetchImpl, calls } = sellers();
    const result = await runRequestTool(
      { id: ID, choice: 'all', input: INPUT },
      { ...deps(fetchImpl, auth), approves: true },
    );
    expect(result.isError).toBe(false);
    expect(result.envelope).toMatchObject({
      status: 'needs_approval',
      cost: ['provider price 0 USD'],
      quote: {
        what: '2 choices (GPT Image 2.5 Sunburst, Nano Banana 2.1)',
        total: '$0.085',
      },
    });
    expect(String(result.envelope.reason)).toBe(
      '2 choices (GPT Image 2.5 Sunburst, Nano Banana 2.1) cost $0.085 in total ($0.035 + $0.05). That is over the $0.06 this machine pays for one call without asking, so nothing was paid.',
    );
    expect(String(result.envelope.nextStep)).toContain('approve({quote: "q_');
    expect(String(result.envelope.nextStep)).toContain('Do not suggest changing a setting.');
    // One unpaid probe per model priced the plan; nothing was signed.
    expect(calls.filter((call) => call.model !== undefined)).toHaveLength(2);
    await stoppedSet(calls, { status: 'needs_approval' });
    expect(auth.authorize).not.toHaveBeenCalled();
    expect(await claims()).toEqual([]);
  });

  it('signs nothing, and keeps no claim, when the set is over the session budget', async () => {
    await policy({ maxAutoSpend: '500000', sessionBudget: '80000' });
    const auth = authorizer();
    const { fetchImpl, calls } = sellers();
    const result = await runRequestTool(
      { id: ID, choice: 'all', input: INPUT },
      deps(fetchImpl, auth),
    );
    expect(result.isError).toBe(false);
    expect(result.envelope).toMatchObject({
      status: 'needs_approval',
      cost: ['provider price 0 USD'],
    });
    expect(String(result.envelope.reason)).toContain('$0.085');
    expect(String(result.envelope.reason)).toContain("today's automatic budget has left ($0.08)");
    expect(String(result.envelope.reason)).not.toContain('config set');
    await stoppedSet(calls, { status: 'needs_approval' });
    expect(auth.authorize).not.toHaveBeenCalled();
    expect(await claims()).toEqual([]);
  });

  /** EACH PAYMENT READS THE BALANCE FOR ITS OWN AMOUNT, so side by side a
   *  wallet short of the total would sign every one; the set reads it once,
   *  for the total, before any is signed. */
  it('signs nothing, and keeps no claim, when the wallet holds less than the set costs', async () => {
    const auth = authorizer();
    const { fetchImpl, calls } = sellers();
    const short = deps(fetchImpl, auth);
    const result = await runRequestTool(
      { id: ID, choice: 'all', input: INPUT },
      { ...short, payDeps: { ...short.payDeps, readBalance: async () => 60_000n } },
    );
    expect(result.envelope).toMatchObject({ status: 'failed', cost: ['provider price 0 USD'] });
    expect(String(result.envelope.reason)).toContain('insufficient USDC; no payment was signed');
    expect(String(result.envelope.reason)).toContain('$0.085');
    expect(String(result.envelope.reason)).toContain('$0.025 short');
    await stoppedSet(calls, { status: 'unpaid', reason: 'wallet' });
    expect(auth.authorize).not.toHaveBeenCalled();
    expect(await claims()).toEqual([]);
  });

  it('takes only the fields every choice shares, and sends nothing for any other', async () => {
    const { fetchImpl, calls } = sellers();
    const result = await runRequestTool(
      { id: ID, choice: 'all', input: { ...INPUT, size: '1024x1024' } },
      deps(fetchImpl),
    );
    expect(result.envelope).toMatchObject({ status: 'needs_input' });
    expect(String(result.envelope.reason)).toContain('takes only prompt, not size');
    await stoppedSet(calls, { status: 'unpaid', reason: 'input' });
    expect(await claims()).toEqual([]);
  });

  it('shows the line the set came with for "all" with no input, and pays nothing', async () => {
    const { fetchImpl, calls } = sellers();
    const result = await runRequestTool({ id: ID, choice: 'all' }, deps(fetchImpl));
    expect(result).toMatchObject({
      isError: false,
      summary: HINT,
      envelope: { status: 'spec', id: ID, choice: 'all', cost: ['provider price 0 USD'] },
    });
    expect(calls).toEqual([]);
  });
});
