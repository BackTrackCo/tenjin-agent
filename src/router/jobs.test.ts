import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPaymentRequired, testWalletProvider } from '../lib/read-test-utils';
import type { SpendAuthorization, SpendAuthorizer } from '../lib/wallet';
import type { CommandContext } from '../context';
import { ROUTER_PATH, type Job, type OfferSpec } from './decision';
import { pollTarget, pollUntil, type PollRequest, type PollTransport } from './jobs';
import { readTake, takePath, writeTake, type JobTake } from './job-store';
import type { MediaTransport } from './paid';
import { storeSpecs } from './specs';
import { runRequestTool } from './tool';

/**
 * A PAID CALL THE SELLER ANSWERS BEFORE ITS RESULT IS READY, against a fake
 * seller for each pattern the catalog carries: Treza answering inline or
 * cut off after naming its status URL, BlockRun's 202 polled with the same
 * payment header (and once re-signed when it refuses that), and AiSpace's
 * free queue answering PROCESSING and then the file itself. The submit goes
 * through the paying leg's fetch; every poll through the pinned-transport
 * seam, so no test opens a socket. The clock is the test's: a wait between
 * polls moves it, never the suite.
 */

const ROUTER = 'https://tenjin.sh';
const PAY_TO = '0xe9030014F5DAe217d0A152f02A043567b16c1aBf';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const ID = '0195f3a1-6c4d-7a2b-9e10-5f6a7b8c9d24';
const MP4 = new Uint8Array([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32,
]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const BLOCKRUN_JOB: Job = {
  pollUrl: { field: 'poll_url' },
  pollMethod: 'GET',
  pollAuth: 'x402',
  running: { httpStatus: [202] },
  failed: { field: 'status', values: ['failed'] },
  everyS: 3,
  maxWaitS: 540,
  keepH: 1,
};
const TREZA_JOB: Job = {
  pollUrl: { field: 'statusUrl', header: 'X-Status-Url' },
  pollMethod: 'GET',
  pollAuth: 'none',
  running: { field: 'status', values: ['running'] },
  everyS: 10,
  maxWaitS: 300,
  keepH: 24,
};
const AISPACE_JOB: Job = {
  pollUrl: { fixed: 'https://x402.aispace.bot/api/v1/video/retrieve' },
  completeUrl: { fixed: 'https://x402.aispace.bot/api/v1/video/complete' },
  pollMethod: 'POST',
  pollBody: { model: '$input.model', queue_id: '$result.queue_id' },
  pollAuth: 'none',
  running: { field: 'status', values: ['PROCESSING', 'QUEUED'] },
  everyS: 10,
  maxWaitS: 600,
  keepH: 24,
  always: true,
};

function spec(over: Partial<OfferSpec>): OfferSpec {
  return {
    id: ID,
    capabilityId: 'blockrun-image-gpt-image-2',
    provider: 'BlockRun (OpenAI GPT Image 2)',
    output: 'media',
    description: 'General-purpose images.',
    priceAtomic: '64000',
    priceVaries: false,
    maxAmountAtomic: '64000',
    payTo: PAY_TO,
    network: 'eip155:8453',
    asset: USDC,
    request: {
      method: 'POST',
      url: 'https://blockrun.ai/api/v1/images/generations',
      fields: {},
      location: 'body',
    },
    input: {
      type: 'object',
      required: ['prompt'],
      properties: { prompt: { type: 'string' }, model: { type: 'string' } },
    },
    pinned: { model: 'openai/gpt-image-2' },
    job: BLOCKRUN_JOB,
    ...over,
  };
}

const BLOCKRUN = spec({});
const TREZA = spec({
  capabilityId: 'treza-music',
  provider: 'Treza (Lyria)',
  priceAtomic: '60000',
  maxAmountAtomic: '60000',
  request: { method: 'POST', url: 'https://treza.example/api/music', fields: {}, location: 'body' },
  pinned: {},
  job: TREZA_JOB,
});
const AISPACE = spec({
  capabilityId: 'aispace-hailuo-3-max',
  provider: 'AiSpace (Venice)',
  priceAtomic: '145000',
  maxAmountAtomic: '145000',
  request: {
    method: 'POST',
    url: 'https://x402.aispace.bot/api/v1/video/queue',
    fields: {},
    location: 'body',
  },
  pinned: { model: 'minimax-h3-max-text-to-video' },
  job: AISPACE_JOB,
});
const INPUT = { prompt: 'a paper plane over a city skyline' };

let dir: string;
let clock: number;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'router-jobs-'));
  // Its own git root: `router.*` resolves from here, never from the suite's cwd.
  await mkdir(join(dir, '.git'));
  await writeFile(
    join(dir, 'config.json'),
    JSON.stringify({ maxAutoSpend: '250000', sessionBudget: '5000000' }),
  );
  clock = Date.now();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function ctx(timeout = 5000): CommandContext {
  const sink = () => ({ write: () => true }) as unknown as NodeJS.WritableStream;
  return {
    flags: { json: true, timeout, baseUrl: ROUTER },
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

/** The payment header a request carried, whatever case it was spelled in. */
function paymentOf(headers: Record<string, string>): string | undefined {
  const name = Object.keys(headers).find((key) =>
    ['payment-signature', 'x-payment'].includes(key.toLowerCase()),
  );
  return name !== undefined ? headers[name] : undefined;
}

/**
 * THE SELLER'S SUBMIT: a 402 at the spec's price, then the paid answer the
 * test scripts. Outcome reports to the router are recorded and answered 204.
 */
function submit(
  target: OfferSpec,
  paid: (init?: RequestInit) => Response,
  opts: { maxTimeoutSeconds?: number } = {},
) {
  const calls: { url: string; payment?: string; body?: string }[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? {}).forEach((value, key) => {
      headers[key] = value;
    });
    const payment = paymentOf(headers);
    calls.push({
      url,
      ...(payment !== undefined ? { payment } : {}),
      ...(typeof init?.body === 'string' ? { body: init.body } : {}),
    });
    if (url.startsWith(ROUTER)) return new Response(null, { status: 204 });
    if (payment === undefined) {
      const challenge = buildPaymentRequired({
        amount: target.priceAtomic,
        payTo: target.payTo,
        ...(opts.maxTimeoutSeconds !== undefined
          ? { maxTimeoutSeconds: opts.maxTimeoutSeconds }
          : {}),
      });
      return new Response('{}', {
        status: 402,
        headers: { 'content-type': 'application/json', 'PAYMENT-REQUIRED': challenge.header },
      });
    }
    return paid(init);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

/** One scripted poll answer. */
interface Answer {
  status: number;
  body?: unknown;
  bytes?: Uint8Array;
  headers?: Record<string, string>;
}

/** THE SELLER'S STATUS URL: answers in order, every request recorded. */
function polls(answers: Answer[]) {
  const seen: { url: string; request: PollRequest }[] = [];
  const queue = [...answers];
  const transport: PollTransport = async (target, request) => {
    seen.push({ url: target.url.toString(), request });
    const answer = queue.shift();
    if (answer === undefined) throw new Error(`unscripted poll to ${target.url.toString()}`);
    const bytes =
      answer.bytes ??
      new Uint8Array(Buffer.from(answer.body === undefined ? '' : JSON.stringify(answer.body)));
    const headers: Record<string, string> = {
      'content-type': answer.bytes !== undefined ? 'video/mp4' : 'application/json',
      ...answer.headers,
    };
    return {
      status: answer.status,
      header: (name) =>
        Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1],
      body: (async function* () {
        yield bytes;
      })(),
      discard: () => undefined,
    };
  };
  return { transport, seen };
}

/** A linked file the result names, served from here. */
const mediaTransport: MediaTransport = async () => ({
  status: 200,
  body: (async function* () {
    yield PNG;
  })(),
  discard: () => undefined,
});

function deps(
  fetchImpl: typeof fetch,
  pollTransport: PollTransport,
  over: { auth?: SpendAuthorizer; timeout?: number; sleep?: (ms: number) => Promise<void> } = {},
) {
  const auth = over.auth ?? authorizer();
  return {
    ctx: ctx(over.timeout),
    cwd: dir,
    authorizer: auth,
    fetchImpl,
    mediaTransport,
    pollTransport,
    now: () => clock,
    sleep:
      over.sleep ??
      (async (ms: number) => {
        clock += ms;
      }),
    payDeps: {
      readBalance: async () => 100_000_000n,
      fetchImpl,
      provider: testWalletProvider(),
      authorizer: auth,
      destination: { resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }] },
    },
  };
}

const reports = (calls: { url: string; body?: string }[]) =>
  calls
    .filter((call) => call.url === `${ROUTER}${ROUTER_PATH}`)
    .map((call) => JSON.parse(call.body!) as Record<string, unknown>);
const ledger = async () =>
  (await readFile(join(dir, 'paid', 'ledger.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);

describe('a seller that answers inline', () => {
  it('delivers a Treza answer that carries its result, with no poll', async () => {
    await storeSpecs(dir, [TREZA]);
    const { fetchImpl } = submit(TREZA, () =>
      json(200, { status: 'done', audio_url: 'https://treza.example/out/clip.mp3' }),
    );
    const { transport, seen } = polls([]);
    const result = await runRequestTool({ id: ID, input: INPUT }, deps(fetchImpl, transport));
    expect(result.envelope).toMatchObject({
      status: 'fulfilled',
      cost: ['provider price 0.06 USD'],
    });
    expect(seen).toEqual([]);
    expect(result.envelope.savedFiles).toHaveLength(1);
    expect(await readdir(join(dir, 'jobs')).catch(() => [])).toEqual([]);
  });
});

describe('a 202 from a service with a job', () => {
  /** A 202 IS NEVER A RESULT, even where the job's own rule reads a field:
   *  BlockRun's GPT Image 2 was once logged fulfilled with a 202. */
  it('is polled, not fulfilled, whatever its body says', async () => {
    await storeSpecs(dir, [TREZA]);
    const { fetchImpl, calls } = submit(TREZA, () =>
      json(202, { status: 'accepted', statusUrl: 'https://treza.example/jobs/7' }),
    );
    const { transport, seen } = polls([
      { status: 200, body: { status: 'done', audio_url: 'https://treza.example/out/clip.mp3' } },
    ]);
    const result = await runRequestTool({ id: ID, input: INPUT }, deps(fetchImpl, transport));
    expect(seen.map((poll) => poll.url)).toEqual(['https://treza.example/jobs/7']);
    expect(result.envelope).toMatchObject({ status: 'fulfilled', job: ID });
    await vi.waitFor(() => expect(reports(calls)).toHaveLength(1));
    expect(reports(calls)[0]).toMatchObject({ status: 'fulfilled', httpStatus: 200 });
  });

  it('keeps polling a poll that answers 202 with no status field', async () => {
    await storeSpecs(dir, [TREZA]);
    const { fetchImpl } = submit(TREZA, () =>
      json(202, { status: 'accepted', statusUrl: 'https://treza.example/jobs/7' }),
    );
    const { transport, seen } = polls([
      { status: 202, body: {} },
      { status: 200, body: { status: 'done', audio_url: 'https://treza.example/out/clip.mp3' } },
    ]);
    const result = await runRequestTool({ id: ID, input: INPUT }, deps(fetchImpl, transport));
    expect(seen).toHaveLength(2);
    expect(result.envelope).toMatchObject({ status: 'fulfilled', job: ID });
    expect(result.envelope.result).toContain('audio_url');
  });
});

describe("Treza's paid leg cut off after it named its status URL", () => {
  it('polls the status URL unsigned until the clip is done', async () => {
    await storeSpecs(dir, [TREZA]);
    const { fetchImpl, calls } = submit(
      TREZA,
      (init) => {
        // Headers now, the body never: the paid leg runs out of time reading it.
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener('abort', () =>
              controller.error(new DOMException('The operation was aborted', 'AbortError')),
            );
          },
        });
        return new Response(body, {
          status: 200,
          headers: { 'X-Status-Url': '/jobs/42', 'content-type': 'application/json' },
        });
      },
      { maxTimeoutSeconds: 1 },
    );
    const { transport, seen } = polls([
      { status: 200, body: { status: 'running' } },
      { status: 200, body: { status: 'done', audio_url: 'https://treza.example/out/clip.mp3' } },
    ]);
    const result = await runRequestTool(
      { id: ID, input: INPUT },
      deps(fetchImpl, transport, { timeout: 50 }),
    );
    expect(result.envelope).toMatchObject({
      status: 'fulfilled',
      job: ID,
      cost: ['provider price 0.06 USD'],
    });
    expect(seen.map((poll) => [poll.url, poll.request.method])).toEqual([
      ['https://treza.example/jobs/42', 'GET'],
      ['https://treza.example/jobs/42', 'GET'],
    ]);
    // Unsigned: Treza's status URL is free.
    for (const poll of seen) expect(paymentOf(poll.request.headers)).toBeUndefined();
    expect(result.envelope.savedFiles).toHaveLength(1);
    // One payment, one ledger row, finished with the file the job saved.
    expect(
      calls.filter((call) => call.payment !== undefined && !call.url.startsWith(ROUTER)),
    ).toHaveLength(1);
    const rows = await ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      amountAtomic: '60000',
      savedFiles: result.envelope.savedFiles,
    });
    const take = await readTake(dir, ID, 1);
    expect(take).toMatchObject({ state: 'done', statusUrl: 'https://treza.example/jobs/42' });
  });

  it('answers a finished take that missed its success rule unverified, resumed too', async () => {
    const ruled = { ...TREZA, resultSchema: { type: 'object', required: ['audio_url'] } };
    await storeSpecs(dir, [ruled]);
    const { fetchImpl } = submit(ruled, () =>
      json(202, { status: 'accepted', statusUrl: 'https://treza.example/jobs/7' }),
    );
    const { transport } = polls([{ status: 200, body: { status: 'done' } }]);
    const result = await runRequestTool({ id: ID, input: INPUT }, deps(fetchImpl, transport));
    expect(result.isError).toBe(true);
    expect(result.envelope).toMatchObject({ status: 'unverified', job: ID });
    const caveat = result.envelope.resultCaveat as string;
    expect(caveat).toContain('audio_url');

    const later = polls([]);
    const resumed = await runRequestTool({ job: ID }, deps(fetchImpl, later.transport));
    expect(resumed.isError).toBe(true);
    expect(resumed.envelope).toMatchObject({
      status: 'unverified',
      job: ID,
      result: result.envelope.result,
      resultCaveat: caveat,
    });
    expect(later.seen).toEqual([]);
  });
});

describe("BlockRun's 202, polled with the paying wallet's header", () => {
  const accepted = () =>
    json(202, { id: 'img_1', poll_url: 'https://blockrun.ai/api/v1/images/generations/img_1' });

  it('re-sends the submit header on every poll and reserves nothing new', async () => {
    await storeSpecs(dir, [BLOCKRUN]);
    const auth = authorizer();
    const { fetchImpl, calls } = submit(BLOCKRUN, accepted);
    const { transport, seen } = polls([
      { status: 202, body: { status: 'processing' } },
      { status: 202, body: { status: 'processing' } },
      {
        status: 200,
        body: { status: 'completed', data: [{ url: 'https://cdn.blockrun.ai/out/img_1.png' }] },
      },
    ]);
    const result = await runRequestTool(
      { id: ID, input: INPUT },
      deps(fetchImpl, transport, { auth }),
    );
    expect(result.envelope).toMatchObject({ status: 'fulfilled', job: ID });
    const submitted = calls.find((call) => call.payment !== undefined)!.payment!;
    expect(seen).toHaveLength(3);
    for (const poll of seen) {
      expect(poll.url).toBe('https://blockrun.ai/api/v1/images/generations/img_1');
      expect(paymentOf(poll.request.headers)).toBe(submitted);
    }
    expect(auth.authorize).toHaveBeenCalledTimes(1);
    expect(result.envelope.savedFiles).toHaveLength(1);
    // The 202 was never reported as a result.
    await vi.waitFor(() => expect(reports(calls)).toHaveLength(1));
    expect(reports(calls)[0]).toMatchObject({ id: ID, status: 'fulfilled', httpStatus: 200 });
    // The header is gone from the record once the job ended.
    expect(await readTake(dir, ID, 1)).not.toHaveProperty('auth');
    expect(await readFile(takePath(dir, ID, 1), 'utf8')).not.toContain(submitted);
  });

  it('signs one fresh authorization when a poll refuses the submit header, and reuses it', async () => {
    await storeSpecs(dir, [BLOCKRUN]);
    const auth = authorizer();
    const { fetchImpl, calls } = submit(BLOCKRUN, accepted);
    const challenge = buildPaymentRequired({ amount: '64000', payTo: PAY_TO }).header;
    const { transport, seen } = polls([
      { status: 402, body: {}, headers: { 'PAYMENT-REQUIRED': challenge } },
      { status: 202, body: { status: 'processing' } },
      {
        status: 200,
        body: { status: 'completed', data: [{ url: 'https://cdn.blockrun.ai/out/img_1.png' }] },
      },
    ]);
    const result = await runRequestTool(
      { id: ID, input: INPUT },
      deps(fetchImpl, transport, { auth }),
    );
    expect(result.envelope).toMatchObject({ status: 'fulfilled' });
    const submitted = calls.find((call) => call.payment !== undefined)!.payment!;
    const [first, second, third] = seen.map((poll) => paymentOf(poll.request.headers));
    expect(first).toBe(submitted);
    expect(second).toBeDefined();
    expect(second).not.toBe(submitted);
    expect(third).toBe(second);
    // Two gated authorizations: the submit, and the job's own.
    expect(auth.authorize).toHaveBeenCalledTimes(2);
    expect(vi.mocked(auth.authorize).mock.calls[1]![0]).toMatchObject({
      requestKey: `job:${ID}#1`,
      amountAtomic: 64_000n,
      creator: 'blockrun.ai',
    });
    // Each authorization has its own row; the files go on the one that settled.
    const rows = await ledger();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ savedFiles: [] });
    expect(rows[1]).toMatchObject({ savedFiles: result.envelope.savedFiles });
  });

  it('fails on a second refusal, with no third authorization', async () => {
    await storeSpecs(dir, [BLOCKRUN]);
    const auth = authorizer();
    const { fetchImpl } = submit(BLOCKRUN, accepted);
    const challenge = buildPaymentRequired({ amount: '64000', payTo: PAY_TO }).header;
    const refused = { status: 402, body: {}, headers: { 'PAYMENT-REQUIRED': challenge } };
    const { transport } = polls([refused, refused]);
    const result = await runRequestTool(
      { id: ID, input: INPUT },
      deps(fetchImpl, transport, { auth }),
    );
    expect(result.envelope).toMatchObject({ status: 'failed', providerStatus: 402 });
    expect(String(result.envelope.reason)).toContain('refused the fresh payment');
    expect(auth.authorize).toHaveBeenCalledTimes(2);
  });

  it("returns the seller's reason for a failed job, and drops the header", async () => {
    await storeSpecs(dir, [BLOCKRUN]);
    const { fetchImpl, calls } = submit(BLOCKRUN, accepted);
    const { transport } = polls([
      { status: 202, body: {} },
      { status: 200, body: { status: 'failed', error: 'content policy violation' } },
    ]);
    const result = await runRequestTool({ id: ID, input: INPUT }, deps(fetchImpl, transport));
    expect(result.isError).toBe(true);
    expect(result.envelope).toMatchObject({
      status: 'failed',
      job: ID,
      cost: ['provider price 0.064 USD'],
      settlement: 'unknown',
    });
    expect(String(result.envelope.reason)).toContain('the seller says the job failed');
    expect(String(result.envelope.reason)).toContain('nothing came back');
    // The seller's words ride beside the reason, as untrusted text.
    expect(result.envelope.providerError).toBe('content policy violation');
    const take = await readTake(dir, ID, 1);
    expect(take).toMatchObject({ state: 'failed' });
    expect(take).not.toHaveProperty('auth');
    await vi.waitFor(() => expect(reports(calls)).toHaveLength(1));
    expect(reports(calls)[0]).toMatchObject({ status: 'failed', httpStatus: 200 });
  });

  it('never polls a status URL on another host, and shows it as untrusted', async () => {
    await storeSpecs(dir, [BLOCKRUN]);
    const { fetchImpl } = submit(BLOCKRUN, () =>
      json(202, { id: 'img_1', poll_url: 'https://collector.example/steal?id=img_1' }),
    );
    const { transport, seen } = polls([]);
    const result = await runRequestTool({ id: ID, input: INPUT }, deps(fetchImpl, transport));
    expect(seen).toEqual([]);
    expect(result.envelope).toMatchObject({
      status: 'failed',
      statusUrl: 'https://collector.example/steal?id=img_1',
      providerContentUntrusted: true,
      cost: ['provider price 0.064 USD'],
    });
    expect(String(result.envelope.reason)).toContain('collector.example, not blockrun.ai');
    // No record, so no payment header kept anywhere.
    expect(await readdir(join(dir, 'jobs')).catch(() => [])).toEqual([]);
  });

  it('answers running at the wait, and a resume finishes it', async () => {
    await storeSpecs(dir, [BLOCKRUN]);
    const { fetchImpl, calls } = submit(BLOCKRUN, accepted);
    const busy = Array.from({ length: 40 }, () => ({ status: 202, body: {} }));
    const first = polls(busy);
    const startedAt = clock;
    const result = await runRequestTool({ id: ID, input: INPUT }, deps(fetchImpl, first.transport));
    expect(result.isError).toBe(false);
    expect(result.envelope).toMatchObject({
      status: 'running',
      job: ID,
      cost: ['provider price 0.064 USD'],
      nextStep: `Call request({job: "${ID}"}) in a minute or two; nothing more is paid.`,
    });
    // A signed poll's URL is not one the agent can open: it is not shown.
    expect(result.envelope).not.toHaveProperty('statusUrl');
    expect(clock - startedAt).toBeGreaterThanOrEqual(300_000);
    expect(clock - startedAt).toBeLessThan(301_000);
    await vi.waitFor(() => expect(reports(calls)).toHaveLength(1));
    expect(reports(calls)[0]).toEqual({
      schemaVersion: 1,
      id: ID,
      status: 'running',
      httpStatus: 202,
      ms: expect.any(Number) as number,
    });
    expect(await readTake(dir, ID, 1)).toMatchObject({
      state: 'running',
      auth: expect.any(Object),
    });
    const mode = (await lstat(takePath(dir, ID, 1))).mode & 0o777;
    expect(mode).toBe(0o600);

    // A RETRY OF THE SAME CALL PAYS NOTHING, and points at the job.
    const auth = authorizer();
    const retry = await runRequestTool(
      { id: ID, input: INPUT },
      deps(fetchImpl, polls([]).transport, { auth }),
    );
    expect(retry.envelope).toMatchObject({
      status: 'needs_input',
      nextStep: `Call request({job: "${ID}"}) for its result; nothing more is paid.`,
    });
    expect(auth.authorize).not.toHaveBeenCalled();

    const second = polls([
      {
        status: 200,
        body: { status: 'completed', data: [{ url: 'https://cdn.blockrun.ai/out/img_1.png' }] },
      },
    ]);
    const resumed = await runRequestTool({ job: ID }, deps(fetchImpl, second.transport, { auth }));
    expect(resumed.envelope).toMatchObject({ status: 'fulfilled', job: ID });
    expect(resumed.envelope.savedFiles).toHaveLength(1);
    expect(auth.authorize).not.toHaveBeenCalled();
    expect(second.seen).toHaveLength(1);
    expect(paymentOf(second.seen[0]!.request.headers)).toBe(
      calls.find((call) => call.payment !== undefined)!.payment,
    );
    expect(await readTake(dir, ID, 1)).toMatchObject({ state: 'done' });
    expect(await readTake(dir, ID, 1)).not.toHaveProperty('auth');

    // Resumed again, the finished job answers from its record.
    const third = polls([]);
    const again = await runRequestTool({ job: ID }, deps(fetchImpl, third.transport));
    expect(again.envelope).toMatchObject({
      status: 'fulfilled',
      savedFiles: resumed.envelope.savedFiles,
    });
    expect(third.seen).toEqual([]);
  });

  it('resumes after the process died mid-poll', async () => {
    await storeSpecs(dir, [BLOCKRUN]);
    const { fetchImpl } = submit(BLOCKRUN, accepted);
    // The first process polls once, then never wakes again: killed.
    let slept = 0;
    const killed = polls([{ status: 202, body: {} }]);
    void runRequestTool(
      { id: ID, input: INPUT },
      deps(fetchImpl, killed.transport, {
        sleep: async (ms) => {
          slept += 1;
          if (slept > 1) await new Promise(() => undefined);
          clock += ms;
        },
      }),
    );
    await vi.waitFor(() => expect(killed.seen).toHaveLength(1));
    expect(await readTake(dir, ID, 1)).toMatchObject({ state: 'running' });

    const later = polls([
      {
        status: 200,
        body: { status: 'completed', data: [{ url: 'https://cdn.blockrun.ai/out/img_1.png' }] },
      },
    ]);
    const auth = authorizer();
    const resumed = await runRequestTool({ job: ID }, deps(fetchImpl, later.transport, { auth }));
    expect(resumed.envelope).toMatchObject({ status: 'fulfilled' });
    expect(auth.authorize).not.toHaveBeenCalled();
  });

  it('answers a job it never kept with nothing polled or paid', async () => {
    const { fetchImpl, calls } = submit(BLOCKRUN, accepted);
    const result = await runRequestTool({ job: ID }, deps(fetchImpl, polls([]).transport));
    expect(result.envelope).toMatchObject({ status: 'needs_input' });
    expect(calls).toEqual([]);
  });
});

describe('several takes, each its own job', () => {
  it('waits for every take within one deadline, and a resume finishes the rest', async () => {
    const counted = { ...BLOCKRUN, takes: { max: 5 } };
    await storeSpecs(dir, [counted]);
    let submitted = 0;
    const { fetchImpl, calls } = submit(counted, () => {
      submitted += 1;
      return json(202, {
        id: `img_${submitted}`,
        poll_url: `https://blockrun.ai/api/v1/images/generations/img_${submitted}`,
      });
    });
    const done = (n: string) => ({
      status: 200,
      body: { status: 'completed', data: [{ url: `https://cdn.blockrun.ai/out/${n}.png` }] },
    });
    // By URL, since the takes poll side by side: one finishes, one never does.
    const byUrl = (answers: Record<string, Answer[]>) => {
      const seen: string[] = [];
      const transport: PollTransport = async (target, request) => {
        const url = target.url.toString();
        seen.push(url);
        const key = url.split('/').pop()!;
        const answer = answers[key]!.length > 1 ? answers[key]!.shift()! : answers[key]![0]!;
        return polls([answer]).transport(target, request, AbortSignal.timeout(1_000));
      };
      return { transport, seen };
    };
    const first = byUrl({ img_1: [done('img_1')], img_2: [{ status: 202, body: {} }] });
    const startedAt = clock;
    const result = await runRequestTool(
      { id: ID, input: INPUT, count: 2 },
      deps(fetchImpl, first.transport),
    );
    expect(clock - startedAt).toBeLessThan(301_000);
    expect(result.envelope).toMatchObject({
      status: 'running',
      job: ID,
      count: 2,
      cost: ['provider price 0.128 USD'],
      nextStep: `Call request({job: "${ID}"}) in a minute or two for what is still running; nothing more is paid.`,
    });
    // The takes submit side by side, so which one drew the quick render is
    // the race's: one of each, in take order.
    const results = result.envelope.results as Record<string, unknown>[];
    expect(results.map((take) => take.take)).toEqual([1, 2]);
    expect(results.map((take) => take.status).sort()).toEqual(['fulfilled', 'running']);
    expect(
      calls.filter((call) => call.payment !== undefined && !call.url.startsWith(ROUTER)),
    ).toHaveLength(2);
    await vi.waitFor(() => expect(reports(calls)).toHaveLength(1));
    expect(reports(calls)[0]).toMatchObject({ id: ID, status: 'running' });

    const auth = authorizer();
    const later = byUrl({ img_2: [done('img_2')] });
    const resumed = await runRequestTool({ job: ID }, deps(fetchImpl, later.transport, { auth }));
    expect(later.seen).toEqual(['https://blockrun.ai/api/v1/images/generations/img_2']);
    expect(resumed.envelope).toMatchObject({ status: 'fulfilled' });
    expect(
      (resumed.envelope.results as Record<string, unknown>[]).map((take) => [
        take.take,
        take.status,
      ]),
    ).toEqual([
      [1, 'fulfilled'],
      [2, 'fulfilled'],
    ]);
    expect(auth.authorize).not.toHaveBeenCalled();
  });
});

describe("AiSpace's queue, polled free with the queue id", () => {
  /** The submit settles at once, as AiSpace's real queue does. */
  const TX = `0x${'cd'.repeat(32)}`;
  const queued = () =>
    json(
      200,
      { model: 'minimax-h3-max-text-to-video', queue_id: 'q-77' },
      {
        'PAYMENT-RESPONSE': Buffer.from(
          JSON.stringify({ success: true, transaction: TX }),
        ).toString('base64'),
      },
    );

  it('posts the retrieve with the input and the queue id until the clip comes back', async () => {
    await storeSpecs(dir, [AISPACE]);
    const { fetchImpl } = submit(AISPACE, queued);
    const { transport, seen } = polls([
      {
        status: 200,
        body: { status: 'PROCESSING', average_execution_time: 37831, execution_duration: 5254 },
      },
      { status: 200, bytes: MP4 },
      { status: 200, body: { success: true } },
    ]);
    const result = await runRequestTool({ id: ID, input: INPUT }, deps(fetchImpl, transport));
    expect(result.envelope).toMatchObject({
      status: 'fulfilled',
      cost: ['provider price 0.145 USD'],
      result: { contentType: 'video/mp4', bytes: MP4.byteLength },
    });
    // Two retrieves, then, with the clip saved, one complete that frees
    // AiSpace's copy, sent like a poll: the same method, body and no payment.
    expect(seen.map((poll) => poll.url)).toEqual([
      'https://x402.aispace.bot/api/v1/video/retrieve',
      'https://x402.aispace.bot/api/v1/video/retrieve',
      'https://x402.aispace.bot/api/v1/video/complete',
    ]);
    for (const poll of seen) {
      expect(poll.request.method).toBe('POST');
      // `$input.model` is the pinned model the submit sent.
      expect(JSON.parse(poll.request.body!)).toEqual({
        model: 'minimax-h3-max-text-to-video',
        queue_id: 'q-77',
      });
      expect(paymentOf(poll.request.headers)).toBeUndefined();
    }
    const saved = (result.envelope.savedFiles as string[])[0]!;
    expect(saved).toMatch(/\.mp4$/);
    expect(new Uint8Array(await readFile(saved))).toEqual(MP4);
    // Settled at submit: one row, settled, with the clip on it.
    expect(await ledger()).toEqual([
      expect.objectContaining({ txHash: TX, settlement: 'settled', savedFiles: [saved] }),
    ]);
  });

  it("never frees the seller's copy when the clip could not be saved", async () => {
    await storeSpecs(dir, [AISPACE]);
    // The downloads directory cannot be made: every save fails.
    await writeFile(join(dir, 'downloads'), 'not a directory');
    const { fetchImpl } = submit(AISPACE, queued);
    const { transport, seen } = polls([{ status: 200, bytes: MP4 }]);
    const result = await runRequestTool({ id: ID, input: INPUT }, deps(fetchImpl, transport));
    expect(result.envelope).toMatchObject({
      status: 'fulfilled',
      result: { saveError: expect.any(String) as string },
    });
    expect(seen.map((poll) => poll.url)).toEqual([
      'https://x402.aispace.bot/api/v1/video/retrieve',
    ]);
  });

  /** A REFUSED PROMPT IS A 422 ON THE RETRIEVE, after some PROCESSING, and
   *  every retrieve after it says the same: the take fails at once, paid, in
   *  the seller's words, and nothing is polled again. */
  it("fails a take the seller refused with a 422, paid, in the seller's words", async () => {
    await storeSpecs(dir, [AISPACE]);
    const { fetchImpl, calls } = submit(AISPACE, queued);
    const refused = 'Your prompt violates the content policy of Venice.ai or the model provider';
    const { transport, seen } = polls([
      { status: 200, body: { status: 'PROCESSING' } },
      { status: 200, body: { status: 'PROCESSING' } },
      { status: 200, body: { status: 'PROCESSING' } },
      { status: 422, body: { error: refused } },
    ]);
    const result = await runRequestTool({ id: ID, input: INPUT }, deps(fetchImpl, transport));
    expect(seen).toHaveLength(4);
    expect(result.isError).toBe(true);
    expect(result.envelope).toMatchObject({
      status: 'failed',
      job: ID,
      providerStatus: 422,
      providerError: refused,
      settlement: 'settled',
      cost: ['provider price 0.145 USD'],
      providerContentUntrusted: true,
    });
    expect(String(result.envelope.reason)).toBe(
      `AiSpace (Venice): the seller ended the job with HTTP 422. It was paid ($0.145, settled in tx ${TX}) and nothing came back.`,
    );
    expect(String(result.envelope.nextStep)).toContain('paid and nothing came back');
    await vi.waitFor(() => expect(reports(calls)).toHaveLength(1));
    expect(reports(calls)[0]).toMatchObject({ status: 'failed', httpStatus: 422 });

    // Resumed, it answers from its record: no poll, nothing paid.
    const again = polls([]);
    const resumed = await runRequestTool({ job: ID }, deps(fetchImpl, again.transport));
    expect(again.seen).toEqual([]);
    expect(resumed.envelope).toMatchObject({
      status: 'failed',
      providerError: refused,
      settlement: 'settled',
    });
  });
});

describe('where a poll may go', () => {
  it('holds a signed poll to the submit origin and an unsigned one to its host', () => {
    const submitted = { url: 'https://blockrun.ai/api/v1/images/generations', json: {} };
    const at = (pollUrl: string, job: Job = BLOCKRUN_JOB) =>
      pollTarget(job, { ...submitted, json: { poll_url: pollUrl } }, {});
    expect(at('/api/v1/images/generations/1')).toEqual({
      url: 'https://blockrun.ai/api/v1/images/generations/1',
      method: 'GET',
    });
    expect(at('https://blockrun.ai:8443/poll')).toMatchObject({
      problem: expect.stringContaining('only origin a signed poll goes to') as string,
    });
    expect(at('https://blockrun.ai:8443/poll', { ...BLOCKRUN_JOB, pollAuth: 'none' })).toEqual({
      url: 'https://blockrun.ai:8443/poll',
      method: 'GET',
    });
    expect(at('http://blockrun.ai/poll')).toMatchObject({ problem: expect.any(String) as string });
    expect(at('https://api.blockrun.ai/poll')).toMatchObject({
      problem: expect.stringContaining('api.blockrun.ai') as string,
    });
    expect(at('https://user:pw@blockrun.ai/poll')).toMatchObject({
      problem: expect.any(String) as string,
    });
    expect(
      pollTarget(AISPACE_JOB, { url: AISPACE.request.url, json: {} }, { model: 'm' }),
    ).toMatchObject({ problem: expect.stringContaining('$result.queue_id') as string });
  });

  it('never sends a kept payment header to another origin, even from a record', async () => {
    const { transport, seen } = polls([{ status: 200, body: {} }]);
    const answer = await pollUntil(
      {
        origin: 'https://blockrun.ai',
        poll: { url: 'https://elsewhere.example/poll', method: 'GET' },
        job: BLOCKRUN_JOB,
        auth: { 'PAYMENT-SIGNATURE': 'signed' },
      },
      { deadline: clock + 60_000, firstWaitMs: 0 },
      { transport, now: () => clock },
    );
    expect(answer).toMatchObject({ state: 'failed' });
    expect(seen).toEqual([]);
  });

  it('ends the call running after three failures in a row, and calls a 404 gone', async () => {
    const take = {
      origin: 'https://treza.example',
      poll: { url: 'https://treza.example/jobs/1', method: 'GET' as const },
      job: TREZA_JOB,
    };
    const opts = {
      now: () => clock,
      sleep: async (ms: number) => {
        clock += ms;
      },
      destination: { resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }] },
    };
    const flaky = polls([{ status: 502 }, { status: 503 }, { status: 500 }]);
    expect(
      await pollUntil(
        take,
        { deadline: clock + 300_000, firstWaitMs: 0 },
        {
          ...opts,
          transport: flaky.transport,
        },
      ),
    ).toMatchObject({ state: 'running', status: 500 });
    const gone = polls([{ status: 404, body: { error: 'unknown job' } }]);
    expect(
      await pollUntil(
        take,
        { deadline: clock + 300_000, firstWaitMs: 0 },
        {
          ...opts,
          transport: gone.transport,
        },
      ),
    ).toEqual({ state: 'expired', status: 404 });
  });

  it('backs off by half again each poll, up to thirty seconds', async () => {
    const waits: number[] = [];
    const busy = polls(
      Array.from({ length: 12 }, () => ({ status: 200, body: { status: 'running' } })),
    );
    await pollUntil(
      {
        origin: 'https://treza.example',
        poll: { url: 'https://treza.example/jobs/1', method: 'GET' },
        job: TREZA_JOB,
      },
      { deadline: clock + 200_000, firstWaitMs: 10_000 },
      {
        transport: busy.transport,
        now: () => clock,
        sleep: async (ms) => {
          waits.push(ms);
          clock += ms;
        },
        destination: { resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }] },
      },
    );
    expect(waits.slice(0, 5)).toEqual([10_000, 10_000, 15_000, 22_500, 30_000]);
    expect(Math.max(...waits)).toBe(30_000);
  });
});

describe('the job store', () => {
  const take: JobTake = {
    version: 1,
    offerId: ID,
    take: 1,
    origin: 'https://blockrun.ai',
    poll: { url: 'https://blockrun.ai/poll/1', method: 'GET' },
    auth: { 'PAYMENT-SIGNATURE': 'signed' },
    job: BLOCKRUN_JOB,
    call: {
      capabilityId: 'blockrun-image-gpt-image-2',
      provider: 'BlockRun',
      url: 'https://blockrun.ai/api/v1/images/generations',
      media: true,
      sent: '{}',
      terms: { maxAmountAtomic: '64000' },
    },
    submittedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    amountAtomic: '64000',
    state: 'running',
    savedFiles: [],
  };

  it('writes 0600, reads nothing through a symlink, and keeps no header once ended', async () => {
    await writeTake(dir, take);
    expect((await lstat(takePath(dir, ID, 1))).mode & 0o777).toBe(0o600);
    expect(await readTake(dir, ID, 1)).toMatchObject({ auth: { 'PAYMENT-SIGNATURE': 'signed' } });
    await writeTake(dir, { ...take, state: 'done' });
    expect(await readFile(takePath(dir, ID, 1), 'utf8')).not.toContain('signed');

    const planted = join(dir, 'planted.json');
    await writeFile(planted, JSON.stringify(take));
    await rm(takePath(dir, ID, 1));
    await symlink(planted, takePath(dir, ID, 1));
    expect(await readTake(dir, ID, 1)).toBeNull();
  });
});
