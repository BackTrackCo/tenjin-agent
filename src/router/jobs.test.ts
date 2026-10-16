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
 * cut off after naming its status URL, a 202 naming the URL to poll, and
 * AiSpace's free queue answering PROCESSING and then the file itself. No poll
 * ever carries a payment. The submit goes
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
  running: { httpStatus: [202] },
  failed: { field: 'status', values: ['failed'] },
  everyS: 3,
  maxWaitS: 540,
  keepH: 1,
};
const TREZA_JOB: Job = {
  pollUrl: { field: 'statusUrl', header: 'X-Status-Url' },
  pollMethod: 'GET',
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

describe('a 202 naming the URL to poll', () => {
  const accepted = () =>
    json(202, { id: 'img_1', poll_url: 'https://blockrun.ai/api/v1/images/generations/img_1' });

  it('polls with no payment header and reserves nothing new', async () => {
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
    expect(seen).toHaveLength(3);
    for (const poll of seen) {
      expect(poll.url).toBe('https://blockrun.ai/api/v1/images/generations/img_1');
      expect(paymentOf(poll.request.headers)).toBeUndefined();
    }
    expect(auth.authorize).toHaveBeenCalledTimes(1);
    expect(result.envelope.savedFiles).toHaveLength(1);
    // The 202 was never reported as a result.
    await vi.waitFor(() => expect(reports(calls)).toHaveLength(1));
    expect(reports(calls)[0]).toMatchObject({ id: ID, status: 'fulfilled', httpStatus: 200 });
    // No payment header was ever kept.
    const submitted = calls.find((call) => call.payment !== undefined)!.payment!;
    expect(await readFile(takePath(dir, ID, 1), 'utf8')).not.toContain(submitted);
  });

  /** A POLL THAT ASKS TO BE PAID AGAIN for a result already paid for is
   *  answered with nothing: the take fails, and its cost stays its one
   *  payment. */
  it('fails a take whose poll asks for another payment, and signs nothing for it', async () => {
    await storeSpecs(dir, [BLOCKRUN]);
    const auth = authorizer();
    const { fetchImpl, calls } = submit(BLOCKRUN, accepted);
    const challenge = buildPaymentRequired({ amount: '64000', payTo: PAY_TO }).header;
    const { transport, seen } = polls([
      { status: 402, body: {}, headers: { 'PAYMENT-REQUIRED': challenge } },
    ]);
    const result = await runRequestTool(
      { id: ID, input: INPUT },
      deps(fetchImpl, transport, { auth }),
    );
    expect(result.envelope).toMatchObject({
      status: 'failed',
      job: ID,
      providerStatus: 402,
      cost: ['provider price 0.064 USD'],
    });
    expect(String(result.envelope.reason)).toContain(
      'the seller asked for another payment to return the result; none was sent',
    );
    expect(seen).toHaveLength(1);
    expect(paymentOf(seen[0]!.request.headers)).toBeUndefined();
    expect(auth.authorize).toHaveBeenCalledTimes(1);
    expect(
      calls.filter((call) => call.payment !== undefined && !call.url.startsWith(ROUTER)),
    ).toHaveLength(1);
    expect(await ledger()).toHaveLength(1);
    expect(await readTake(dir, ID, 1)).toMatchObject({ state: 'failed' });
  });

  it("returns the seller's reason for a failed job", async () => {
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
    expect(await readTake(dir, ID, 1)).toMatchObject({ state: 'failed' });
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
      // A plain GET the agent may open itself.
      statusUrl: 'https://blockrun.ai/api/v1/images/generations/img_1',
    });
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
    expect(await readTake(dir, ID, 1)).toMatchObject({ state: 'running' });
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
    expect(paymentOf(second.seen[0]!.request.headers)).toBeUndefined();
    expect(await readTake(dir, ID, 1)).toMatchObject({ state: 'done' });

    // Resumed again, the finished job answers from its record.
    const third = polls([]);
    const again = await runRequestTool({ job: ID }, deps(fetchImpl, third.transport));
    expect(again.envelope).toMatchObject({
      status: 'fulfilled',
      savedFiles: resumed.envelope.savedFiles,
    });
    expect(third.seen).toEqual([]);
  });

  /** A HOST THAT WAITS FOR JOBS (Claude Code moves a long call into the
   *  background) is told of each poll, and the call waits out the job's own
   *  `maxWaitS` instead of handing back `running` at five minutes. */
  it("waits out the job's own wait where the host waits for jobs, telling it each poll", async () => {
    await storeSpecs(dir, [BLOCKRUN]);
    const { fetchImpl } = submit(BLOCKRUN, accepted);
    const busy = Array.from({ length: 20 }, () => ({ status: 202, body: {} }));
    const { transport, seen } = polls([
      ...busy,
      {
        status: 200,
        body: { status: 'completed', data: [{ url: 'https://cdn.blockrun.ai/out/img_1.png' }] },
      },
    ]);
    let told = 0;
    const startedAt = clock;
    const result = await runRequestTool(
      { id: ID, input: INPUT },
      {
        ...deps(fetchImpl, transport),
        waitsForJobs: true,
        onPoll: () => {
          told += 1;
        },
      },
    );
    expect(result.envelope).toMatchObject({ status: 'fulfilled', job: ID });
    expect(clock - startedAt).toBeGreaterThan(300_000);
    expect(clock - startedAt).toBeLessThanOrEqual(BLOCKRUN_JOB.maxWaitS * 1000);
    expect(told).toBe(seen.length);
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

  it("never writes past the call's download cap across takes side by side", async () => {
    const counted = { ...BLOCKRUN, takes: { max: 5 } };
    await storeSpecs(dir, [counted]);
    let submitted = 0;
    const { fetchImpl } = submit(counted, () => {
      submitted += 1;
      return json(202, {
        id: `img_${submitted}`,
        poll_url: `https://blockrun.ai/api/v1/images/generations/img_${submitted}`,
      });
    });
    const transport: PollTransport = async (target, request, signal) => {
      const key = target.url.toString().split('/').pop()!;
      return polls([
        {
          status: 200,
          body: { status: 'completed', data: [{ url: `https://cdn.blockrun.ai/out/${key}.png` }] },
        },
      ]).transport(target, request, signal);
    };
    // Each download waits for the other to start, or a moment: side by side,
    // each would otherwise see the whole allowance.
    let started = 0;
    let bothIn!: () => void;
    const gate = new Promise<void>((resolve) => {
      bothIn = resolve;
    });
    const gated: MediaTransport = async (target, signal) => {
      started += 1;
      if (started === 2) bothIn();
      await Promise.race([gate, new Promise((resolve) => setTimeout(resolve, 200))]);
      return mediaTransport(target, signal);
    };
    // Room for one image of the two.
    const result = await runRequestTool(
      { id: ID, input: INPUT, count: 2 },
      {
        ...deps(fetchImpl, transport),
        mediaTransport: gated,
        downloads: { leftBytes: PNG.byteLength + 2 },
      },
    );
    expect(await readdir(join(dir, 'downloads'))).toHaveLength(1);
    const results = result.envelope.results as Record<string, unknown>[];
    expect(results.map((take) => take.status).sort()).toEqual(['fulfilled', 'running']);
    const capped = results.find((take) => take.status === 'running')!;
    expect(String(capped.note)).toContain('its cap');

    // A resume has its own allowance, and pays nothing.
    const auth = authorizer();
    const resumed = await runRequestTool({ job: ID }, deps(fetchImpl, transport, { auth }));
    expect(resumed.envelope).toMatchObject({ status: 'fulfilled' });
    expect(await readdir(join(dir, 'downloads'))).toHaveLength(2);
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

  it('keeps a clip that could not be saved resumable, and fetches it again unpaid', async () => {
    await storeSpecs(dir, [AISPACE]);
    // The downloads directory cannot be made: every save fails.
    await writeFile(join(dir, 'downloads'), 'not a directory');
    const { fetchImpl } = submit(AISPACE, queued);
    const { transport, seen } = polls([{ status: 200, bytes: MP4 }]);
    const result = await runRequestTool({ id: ID, input: INPUT }, deps(fetchImpl, transport));
    expect(result.envelope).toMatchObject({
      status: 'running',
      job: ID,
      cost: ['provider price 0.145 USD'],
      nextStep: expect.stringContaining(`request({job: "${ID}"})`) as string,
    });
    expect(String(result.envelope.note)).toContain('the payment went through');
    // AiSpace's copy is the only one: never freed.
    expect(seen.map((poll) => poll.url)).toEqual([
      'https://x402.aispace.bot/api/v1/video/retrieve',
    ]);
    expect(await readTake(dir, ID, 1)).toMatchObject({ state: 'running' });

    await rm(join(dir, 'downloads'));
    const auth = authorizer();
    const again = polls([
      { status: 200, bytes: MP4 },
      { status: 200, body: { success: true } },
    ]);
    const resumed = await runRequestTool({ job: ID }, deps(fetchImpl, again.transport, { auth }));
    expect(resumed.envelope).toMatchObject({ status: 'fulfilled', job: ID });
    const saved = (resumed.envelope.savedFiles as string[])[0]!;
    expect(new Uint8Array(await readFile(saved))).toEqual(MP4);
    expect(again.seen.map((poll) => poll.url)).toEqual([
      'https://x402.aispace.bot/api/v1/video/retrieve',
      'https://x402.aispace.bot/api/v1/video/complete',
    ]);
    expect(auth.authorize).not.toHaveBeenCalled();
    expect(await readTake(dir, ID, 1)).toMatchObject({ state: 'done', savedFiles: [saved] });
  });

  /** TWO CALLS POLLING ONE TAKE: the host gave up on the call that started
   *  it, which kept polling, and the agent resumed it. The first ending stands. */
  it('keeps the first ending when a second call polling the take gets a 404', async () => {
    await storeSpecs(dir, [AISPACE]);
    const { fetchImpl } = submit(AISPACE, queued);
    const busy = Array.from({ length: 40 }, () => ({
      status: 200,
      body: { status: 'PROCESSING' },
    }));
    const started = await runRequestTool(
      { id: ID, input: INPUT },
      deps(fetchImpl, polls(busy).transport),
    );
    expect(started.envelope).toMatchObject({ status: 'running' });

    // The slower call is mid-poll when the other saves the clip and frees
    // AiSpace's copy; its retrieve then answers 404.
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const slow = polls([{ status: 404, body: {} }]);
    let waiting = false;
    const slowTransport: PollTransport = async (target, request, signal) => {
      waiting = true;
      await gate;
      return slow.transport(target, request, signal);
    };
    const late = runRequestTool({ job: ID }, deps(fetchImpl, slowTransport));
    await vi.waitFor(() => expect(waiting).toBe(true));

    const quick = polls([
      { status: 200, bytes: MP4 },
      { status: 200, body: { success: true } },
    ]);
    const won = await runRequestTool({ job: ID }, deps(fetchImpl, quick.transport));
    expect(won.envelope).toMatchObject({ status: 'fulfilled' });
    expect(quick.seen.map((poll) => poll.url)).toEqual([
      'https://x402.aispace.bot/api/v1/video/retrieve',
      'https://x402.aispace.bot/api/v1/video/complete',
    ]);
    open();
    const lost = await late;
    expect(lost.isError).toBe(false);
    expect(lost.envelope).toMatchObject({
      status: 'fulfilled',
      job: ID,
      savedFiles: won.envelope.savedFiles,
    });
    expect(slow.seen).toHaveLength(1);
    expect(await readTake(dir, ID, 1)).toMatchObject({
      state: 'done',
      savedFiles: won.envelope.savedFiles,
    });
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
  it("holds a poll to the submit's host over HTTPS", () => {
    const submitted = { url: 'https://blockrun.ai/api/v1/images/generations', json: {} };
    const at = (pollUrl: string, job: Job = BLOCKRUN_JOB) =>
      pollTarget(job, { ...submitted, json: { poll_url: pollUrl } }, {});
    expect(at('/api/v1/images/generations/1')).toEqual({
      url: 'https://blockrun.ai/api/v1/images/generations/1',
      method: 'GET',
    });
    expect(at('https://blockrun.ai:8443/poll')).toEqual({
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

  it('ends the call running after three failures in a row, and calls a 404 gone', async () => {
    const take = {
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
    poll: { url: 'https://blockrun.ai/poll/1', method: 'GET' },
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

  it('writes 0600 and reads nothing through a symlink', async () => {
    await writeTake(dir, take);
    expect((await lstat(takePath(dir, ID, 1))).mode & 0o777).toBe(0o600);
    expect(await readTake(dir, ID, 1)).toMatchObject({ state: 'running' });

    const planted = join(dir, 'planted.json');
    await writeFile(planted, JSON.stringify(take));
    await rm(takePath(dir, ID, 1));
    await symlink(planted, takePath(dir, ID, 1));
    expect(await readTake(dir, ID, 1)).toBeNull();
  });
});
