import { spawnSync } from 'node:child_process';
import { lstat, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader } from '@x402/core/http';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, expect, it, vi } from 'vitest';
import * as locks from '../lib/lock';
import { SIWX_HEADER } from '../lib/siwx';
import { readSpendSummary } from '../lib/spend-ledger';
import { FakeRouter, payerDeps, BASE, TEST_POLICY, testSigner } from './fee-test-utils';
import { modelChannelScope, modelInferenceRunScope } from './model-channel';
import { ModelRefundJournal, modelRefundRunLock, readModelRefundResult } from './model-refund';
import { ModelTransport } from './model-transport';
import { MODEL_PAID_CALL_TIMEOUT_MS, modelPeakQuoteAtomic } from './model-limits';
import { ModelPace } from './model-pace';
import { ModelCallFailed, ModelWorkerStopped, retryableModelCall } from './model-worker-control';
import type { ModelJob } from './model-job';

const made: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Whether a request carries a payment, read without using up the request's body. */
function signedRequest(input: Parameters<typeof fetch>[0], init?: RequestInit): boolean {
  return new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).has(
    'payment-signature',
  );
}

function watchPaymentLock() {
  const waiting = deferred();
  const withFileLock = locks.withFirstFileLock;
  const spy = vi.spyOn(locks, 'withFirstFileLock').mockImplementation((paths, run, opts) => {
    if (paths[0]!.endsWith('.payment.lock')) waiting.resolve();
    return withFileLock(paths, run, opts);
  });
  return { waiting: waiting.promise, restore: () => spy.mockRestore() };
}

async function fixture(
  options: {
    drop?: boolean;
    cap?: string;
    protocol?: 'messages' | 'responses';
    wire?: string;
    quote?: string;
    charge?: string;
    minDeposit?: string;
    maxAutoSpendAtomic?: bigint;
    refundCapability?: 'enabled' | 'legacy';
    onPaidSend?: () => Promise<void>;
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'model-transport-'));
  made.push(dir);
  const repo = join(dir, 'repo');
  await mkdir(repo);
  await mkdir(join(repo, '.git'));
  const config = {
    maxAutoSpend: (options.maxAutoSpendAtomic ?? 1000000n).toString(),
    router: {
      subagents: true,
      subagentConsent: {
        version: 2,
        instructions: 'applicable',
        reads: 'claude-home',
        recipients: ['Tenjin', 'DeepSeek', 'Exa'],
        repositories: [repo],
        maxJobAtomic: options.cap ?? '1000000',
        routerOrigin: BASE,
      },
    },
  };
  await writeFile(join(dir, 'config.json'), JSON.stringify(config));
  const job: ModelJob = {
    id: randomUUID(),
    sessionId: 'root',
    turnId: '1',
    callId: 'call',
    root: repo,
    task: 'Read the fixture',
    native: {},
    decision: { jobId: randomUUID(), routingFeeAtomic: '3000', routingAuthorizedAtomic: '3000' },
    capAtomic: '1000000',
    state: 'running',
    expiresAt: Date.now() + 60_000,
  };
  const router = new FakeRouter({
    path: `/api/model-proxy/${options.protocol ?? 'messages'}`,
    amount: options.quote ?? '500000',
    charge: options.charge ?? '1000',
    minDeposit: options.minDeposit ?? '50000',
  });
  router.abortAfterSettle = options.drop ?? false;
  let last: Record<string, unknown> | undefined;
  let result: unknown;
  let gets = 0;
  let signedGets = 0;
  let voucherState = 'accepted';
  let recoveryState = 'completed';
  let recoveryActual = options.charge ?? '1000';
  let recoveryStatus = 200;
  const paidSignals: AbortSignal[] = [];
  /** Every signed request in the order it reached the router: its channel, the total its
   *  voucher claims, and the status the router answered (0 when the answer was lost). */
  const vouchers: { channel: string; max: bigint; status: number }[] = [];
  const message = {
    id: 'msg',
    type: 'message',
    role: 'assistant',
    model: 'deepseek-flash',
    content: [{ type: 'text', text: 'Done' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 20, output_tokens: 5 },
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.method === 'GET') {
      if (options.refundCapability && !new URL(request.url).search) {
        if (options.refundCapability === 'legacy') return new Response(null, { status: 405 });
        return new Response(null, {
          status: 402,
          headers: {
            'tenjin-inference-refunds': 'worker-v1',
            'payment-required': encodePaymentRequiredHeader({
              x402Version: 2,
              resource: { url: request.url },
              accepts: [{ ...router.requirement, amount: '0' }],
            }),
          },
        });
      }
      gets++;
      if (request.headers.has(SIWX_HEADER)) signedGets++;
      if (recoveryStatus !== 200) return new Response(null, { status: recoveryStatus });
      return Response.json({
        invocationId: last?.invocationId,
        state: recoveryState,
        voucherState,
        actualAtomic: recoveryActual,
        result,
      });
    }
    if (request.headers.has('payment-signature')) {
      paidSignals.push(request.signal);
      await options.onPaidSend?.();
    }
    last = (await request.clone().json()) as Record<string, unknown>;
    result = {
      ...(options.protocol === 'responses'
        ? { wire: options.wire ?? 'event: response.completed\ndata: {"owned":"native wire"}\n\n' }
        : { message }),
      receipt: {
        invocationId: last.invocationId,
        quoteAtomic: options.quote ?? '500000',
        actualAtomic: options.charge ?? '1000',
      },
    };
    router.body = result;
    // Real concurrent responses belong to their request, rather than the
    // fake router's mutable default body (which another quote can replace).
    const ownResult = result;
    const signature = request.headers.get('payment-signature');
    const voucher = signature
      ? (
          decodePaymentSignatureHeader(signature).payload as {
            voucher: { channelId: string; maxClaimableAmount: string };
          }
        ).voucher
      : undefined;
    const seen = voucher
      ? { channel: voucher.channelId, max: BigInt(voucher.maxClaimableAmount), status: 0 }
      : undefined;
    if (seen) vouchers.push(seen);
    const response = await router.fetch(request);
    if (seen) seen.status = response.status;
    if (response.status !== 200) return response;
    await response.body?.cancel();
    return Response.json(ownResult, { headers: response.headers });
  };
  const deps = payerDeps(router, dir, privateKeyToAccount(generatePrivateKey()), {
    fetchImpl,
    policy: async () => ({
      ...TEST_POLICY,
      maxAutoSpendAtomic: options.maxAutoSpendAtomic ?? 1000000n,
    }),
  });
  const make = () =>
    new ModelTransport({
      dataDir: dir,
      baseUrl: BASE,
      payerDeps: deps,
    });
  return {
    dir,
    repo,
    job,
    router,
    make,
    deps,
    message,
    last: () => last,
    gets: () => gets,
    signedGets: () => signedGets,
    paidSignals,
    vouchers,
    setRecoveryState: (value: string) => {
      recoveryState = value;
    },
    setVoucher: (value: string) => {
      voucherState = value;
    },
    /** The charge the router's record of a call names, and the status of that read. */
    setRecoveryActual: (value: string) => {
      recoveryActual = value;
    },
    setRecoveryStatus: (value: number) => {
      recoveryStatus = value;
    },
  };
}

it('journals each accepted run before signing requests reach the router and closes after releasing its lock', async () => {
  const pendingAtSend: string[] = [];
  const closed: string[] = [];
  let activeRun: string;
  const f = await fixture({
    quote: '60000',
    maxAutoSpendAtomic: 500000n,
    refundCapability: 'enabled',
    onPaidSend: async () => {
      expect(await readModelRefundResult(f.dir, BASE, activeRun)).toEqual({ state: 'pending' });
      expect((await lstat(modelRefundRunLock(f.dir, BASE, activeRun))).isDirectory()).toBe(true);
      pendingAtSend.push(activeRun);
    },
  });
  const close = vi.spyOn(ModelRefundJournal.prototype, 'close').mockImplementation(async (id) => {
    await expect(lstat(modelRefundRunLock(f.dir, BASE, id))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    closed.push(id);
    return { state: 'pending' };
  });
  try {
    const signal = new AbortController().signal;
    for (const id of ['run-1', 'continuation']) {
      activeRun = id;
      await f
        .make()
        .withInferenceRun(id, signal, (transport) =>
          transport.messages(f.job, { messages: [{ role: 'user', content: id }] }, signal),
        );
    }
    expect(pendingAtSend).toEqual(['run-1', 'continuation']);
    expect(closed).toEqual(pendingAtSend);
    expect(f.router.channels.size).toBe(2);
    expect(await f.make().summary(f.job)).toMatchObject({ actualAtomic: '5000' });
    // Each run's deposit is counted under that run: the key its confirmed refund is
    // given back to the daily budget by.
    expect((await readSpendSummary(f.dir))?.exposures?.map((e) => e.nonce)).toEqual(
      pendingAtSend.map((id) =>
        expect.stringContaining(`routing-deposit:run:${modelInferenceRunScope(BASE, id).id}:`),
      ),
    );
  } finally {
    close.mockRestore();
  }
});

it('attempts a refund with its own signal when an accepted worker is cancelled', async () => {
  const f = await fixture({ refundCapability: 'enabled' });
  const controller = new AbortController();
  const close = vi
    .spyOn(ModelRefundJournal.prototype, 'close')
    .mockImplementation(async (id, signal) => {
      expect(id).toBe('cancelled');
      expect(signal?.aborted).toBe(false);
      return { state: 'pending' };
    });
  try {
    await expect(
      f.make().withInferenceRun('cancelled', controller.signal, async () => {
        controller.abort(new Error('Worker cancelled'));
        controller.signal.throwIfAborted();
      }),
    ).rejects.toThrow('Worker cancelled');
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    close.mockRestore();
  }
});

it('continues to use shared inference credit on a legacy router', async () => {
  const f = await fixture({ refundCapability: 'legacy' });
  const transport = f.make();
  await expect(
    transport.withInferenceRun('legacy', new AbortController().signal, async (shared) => shared),
  ).resolves.toBe(transport);
});

it('takes a refund-support answer asked ahead of the run, asks no second time, and does not wait for it past a cancel', async () => {
  // Operator item of 2026-11-18: the question was asked only when the run began, after
  // the accept's own checks; asked while they run, the run waits for the one answer.
  const f = await fixture({ refundCapability: 'legacy' });
  const real = f.deps.fetchImpl!;
  let asked = 0;
  let answer!: () => void;
  const held = new Promise<void>((resolve) => {
    answer = resolve;
  });
  f.deps.fetchImpl = async (input, init) => {
    if (new Request(input, init).method === 'GET') {
      asked++;
      await held;
    }
    return real(input, init);
  };
  const transport = f.make();
  const ahead = transport.askRefundSupport(new AbortController().signal);
  // A run cancelled while the answer is out ends at the cancel.
  const cancelled = new AbortController();
  const stopped = transport.withInferenceRun(
    'cancelled-ahead',
    cancelled.signal,
    async (shared) => shared,
    undefined,
    ahead,
  );
  cancelled.abort(new Error('cancelled'));
  await expect(stopped).rejects.toThrow('cancelled');
  const marks: string[] = [];
  const run = transport.withInferenceRun(
    'asked-ahead',
    new AbortController().signal,
    async (shared) => shared,
    (name) => marks.push(name),
    ahead,
  );
  answer();
  await expect(run).resolves.toBe(transport);
  expect(asked).toBe(1);
  expect(marks).toEqual(['refundProbed', 'workerReturned']);
});

// Live case (job 77f41059, 2026-11-18): of two workers accepted together, one got no answer
// to this question inside 3 s. Its job ended `unknown` after 3.0 s with no cause and no record.
it('asks again when the refund-support question gets no answer, then runs the worker', async () => {
  const f = await fixture({ refundCapability: 'legacy' });
  const real = f.deps.fetchImpl!;
  let asked = 0;
  f.deps.fetchImpl = async (input, init) => {
    if (new Request(input, init).method === 'GET' && ++asked === 1)
      throw new DOMException('The operation timed out.', 'TimeoutError');
    return real(input, init);
  };
  vi.useFakeTimers();
  const transport = f.make();
  const run = transport.withInferenceRun(
    'slow-answer',
    new AbortController().signal,
    async (shared) => shared,
  );
  await vi.advanceTimersByTimeAsync(1_000);
  await expect(run).resolves.toBe(transport);
  expect(asked).toBe(2);
});

// The probe signs nothing, so an answer that is neither a refund challenge nor a retryable
// status means no refunds. It used to end the job `unknown` after the routing fee was paid.
it.each([200, 400, 401, 403])(
  'runs the worker on the shared channels when the refund-support question is answered %i',
  async (status) => {
    const f = await fixture();
    let asked = 0;
    f.deps.fetchImpl = async () => {
      asked++;
      return new Response('{}', { status });
    };
    const transport = f.make();
    await expect(
      transport.withInferenceRun('odd-answer', new AbortController().signal, async (run) => run),
    ).resolves.toBe(transport);
    expect(asked).toBe(1);
  },
);

it('ends a run as not started, with the router as the cause, when that question is never answered', async () => {
  const f = await fixture();
  let asked = 0;
  f.deps.fetchImpl = async () => {
    asked++;
    return new Response('busy', { status: 503 });
  };
  const worker = vi.fn(async () => 'ran');
  vi.useFakeTimers();
  const run = f
    .make()
    .withInferenceRun('no-router', new AbortController().signal, worker)
    .catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(5_000);
  const stopped = await run;
  expect(stopped).toBeInstanceOf(ModelWorkerStopped);
  expect((stopped as ModelWorkerStopped).stop).toEqual({
    kind: 'not_started',
    reason: 'router_unreachable',
    status: 503,
  });
  expect(asked).toBe(3);
  expect(worker).not.toHaveBeenCalled();
});

// A job is one call to the person. The consent's $1 ceiling used to stand in for the
// per-call limit, so a $0.50 quote was funded under a $0.25 limit.
it('refuses a Messages quote above the per-call limit, whatever ceiling the consent names', async () => {
  const f = await fixture({ maxAutoSpendAtomic: 250000n, minDeposit: '500000' });
  await expect(
    f.make().messages(f.job, { messages: [] }, new AbortController().signal),
  ).rejects.toThrow('remaining job ceiling');
  expect(f.router.deposits).toBe(0);
  expect(f.router.paidRequests()).toBe(0);
});

// Greptile on 3e3837c4: a quote reserved under the cap as it stood could wait for its
// inference lane, and a per-call limit lowered meanwhile was held against that one quote
// only, so the job's total passed the new cap.
it("holds a job's reserved total against a cap lowered while a call waited for its lane, and releases that call unpaid", async () => {
  // The first deposit covers both quotes, so the second call needs no top-up: only the
  // job's cap can stop it.
  const f = await fixture({ quote: '300000', minDeposit: '900000' });
  const signal = new AbortController().signal;
  await f.make().messages(f.job, { messages: [{ role: 'user', content: 'first' }] }, signal);
  expect(f.router.paidRequests()).toBe(1);
  const budget = join(f.dir, 'model-jobs', `${f.job.id}.budget.json`);
  const spent = BigInt(JSON.parse(await readFile(budget, 'utf8')).charged);
  expect(spent > 0n).toBe(true);
  const lower = async () => {
    const path = join(f.dir, 'config.json');
    const config = JSON.parse(await readFile(path, 'utf8'));
    // Enough for this 300000 quote alone, one short of the job's total with it.
    await writeFile(
      path,
      JSON.stringify({ ...config, maxAutoSpend: (spent + 300000n - 1n).toString() }),
    );
  };
  // Lowered when the call, its quote already reserved, takes its turn at the lane.
  const withFirstFileLock = locks.withFirstFileLock;
  const lane = vi.spyOn(locks, 'withFirstFileLock').mockImplementation(async (paths, run, opts) => {
    if (paths[0]!.endsWith('.payment.lock')) {
      expect(BigInt(JSON.parse(await readFile(budget, 'utf8')).charged)).toBe(spent + 300000n);
      await lower();
    }
    return withFirstFileLock(paths, run, opts);
  });
  try {
    await expect(
      f.make().messages(f.job, { messages: [{ role: 'user', content: 'second' }] }, signal),
    ).rejects.toMatchObject({
      message: expect.stringContaining('remaining job ceiling'),
      detail: { cause: 'budget' },
    });
  } finally {
    lane.mockRestore();
  }
  expect(f.router.paidRequests()).toBe(1);
  expect(JSON.parse(await readFile(budget, 'utf8')).charged).toBe(spent.toString());
});

it('funds a Messages quote within the per-call limit, with no deposit above that limit', async () => {
  const f = await fixture({ quote: '200000', maxAutoSpendAtomic: 250000n, minDeposit: '250000' });
  await expect(
    f.make().messages(f.job, { messages: [] }, new AbortController().signal),
  ).resolves.toEqual(f.message);
  expect(f.router.deposits).toBe(1);
  expect((await readSpendSummary(f.dir))?.committedAtomic).toBe('250000');
});

it('can consume close to the job ceiling when Messages quotes follow the requested output', async () => {
  const f = await fixture({ quote: '60000', charge: '40000' });
  const transport = f.make();
  for (let turn = 0; turn < 24; turn++)
    await transport.messages(
      f.job,
      { messages: [{ role: 'user', content: `Turn ${turn}` }] },
      new AbortController().signal,
    );
  expect(await transport.summary(f.job)).toMatchObject({
    actualAtomic: '963000',
    reservedAtomic: '963000',
    uncertain: [],
  });
  await expect(
    transport.messages(
      f.job,
      { messages: [{ role: 'user', content: 'Next turn' }] },
      new AbortController().signal,
    ),
  ).rejects.toThrow('remaining job ceiling');
  expect(f.router.paidRequests()).toBe(24);
});

it.each(['daily', 'creator'] as const)(
  'retains the %s payment gate when using job consent for inference',
  async (gate) => {
    const f = await fixture({ minDeposit: '500000' });
    f.deps.policy = async () => ({
      ...TEST_POLICY,
      maxAutoSpendAtomic: 1000000n,
      ...(gate === 'daily'
        ? { sessionBudgetAtomic: 1000n }
        : { allowlistCreators: ['somebody-else'] }),
    });
    const transport = f.make();
    await expect(
      transport.messages(f.job, { messages: [] }, new AbortController().signal),
    ).rejects.toThrow();
    expect(f.router.paidRequests()).toBe(0);
    expect(await transport.summary(f.job)).toMatchObject({
      actualAtomic: '3000',
      reservedAtomic: '3000',
      uncertain: [],
    });
  },
);

it('uses the real SDK inference lane for multiple turns, reusing credit and replaying locally', async () => {
  const f = await fixture({ quote: '120000' });
  const transport = f.make();
  const first = { model: 'deepseek-flash', messages: [{ role: 'user', content: 'first' }] };
  expect(await transport.messages(f.job, first, new AbortController().signal)).toEqual(f.message);
  expect(await f.make().messages(f.job, first, new AbortController().signal)).toEqual(f.message);
  await transport.messages(f.job, { ...first, max_tokens: 200 }, new AbortController().signal);
  expect(f.router.paidRequests()).toBe(2);
  expect(f.router.deposits).toBe(1);
  expect(f.router.channels.size).toBe(1);
  expect(await transport.summary(f.job)).toEqual({
    actualAtomic: '5000',
    reservedAtomic: '5000',
    uncertain: [],
  });
});

it('tells where a model call spent its time, once, and nothing for a call replayed from its kept result', async () => {
  // Operator item of 2026-11-18: a 99 s job of four tool uses had no record of its waits.
  const f = await fixture({ quote: '120000' });
  const transport = f.make();
  const request = { model: 'deepseek-flash', messages: [{ role: 'user', content: 'timed' }] };
  const seen: Record<string, unknown>[] = [];
  await transport.messages(f.job, request, new AbortController().signal, undefined, (timing) =>
    seen.push({ ...timing }),
  );
  expect(seen).toHaveLength(1);
  const steps = [
    'budgetMs',
    'quoteMs',
    'reserveMs',
    'laneWaitMs',
    'gateMs',
    'signMs',
    'answerMs',
    'bodyMs',
    'drainMs',
    'settleMs',
  ];
  expect(Object.keys(seen[0]!)).toEqual(expect.arrayContaining(['slot', 'requestBytes', ...steps]));
  for (const name of steps) expect(seen[0]![name]).toBeGreaterThanOrEqual(0);
  expect(seen[0]!.slot).toBe(0);
  expect(f.router.paidRequests()).toBe(1);
  // The kept result answers the same request again: no quote, no lane, no payment.
  await f
    .make()
    .messages(f.job, request, new AbortController().signal, undefined, (timing) =>
      seen.push({ ...timing }),
    );
  expect(f.router.paidRequests()).toBe(1);
  expect(Object.keys(seen[1]!).sort()).toEqual(['budgetMs', 'slot']);
});

it('settles overlapping inference on two reusable channels with a $0.50 funding budget', async ({
  onTestFinished,
}) => {
  const f = await fixture({ quote: '120000' });
  f.deps.policy = async () => ({ ...TEST_POLICY, sessionBudgetAtomic: 500000n });
  const primary = f.make();
  const secondary = primary.forInferenceSlot(1);
  const stop = new AbortController();
  const message = (content: string) => ({ messages: [{ role: 'user', content }] });
  const anotherJob = () => ({
    ...f.job,
    id: randomUUID(),
    decision: { ...f.job.decision, jobId: randomUUID() },
  });
  await primary.messages(f.job, message('Fund the original channel'), stop.signal);
  const [originalChannel] = f.router.channels.keys();
  expect(f.router.deposits).toBe(1);

  const held = deferred();
  const firstEntered = deferred();
  const secondEntered = deferred();
  let entered = 0;
  f.router.hold = held.promise;
  f.router.onDelayArmed = () => {
    if (++entered === 1) firstEntered.resolve();
    else secondEntered.resolve();
  };
  onTestFinished(() => {
    held.resolve();
    stop.abort();
  });
  const first = primary.messages(f.job, message('First worker'), stop.signal);
  await Promise.race([firstEntered.promise, first]);
  const secondJob = anotherJob();
  const second = secondary.messages(secondJob, message('Second worker'), stop.signal);
  const results = Promise.allSettled([first, second]);
  try {
    // The fake provider keeps both requests pending until the test releases it.
    await Promise.race([secondEntered.promise, first, second]);
    expect([...f.router.channels.values()].filter((channel) => channel.pending)).toHaveLength(2);
    expect(f.router.settledFees).toBe(1);
    expect(f.router.paidRequests()).toBe(3);
  } finally {
    held.resolve();
  }
  expect(await results).toEqual([
    { status: 'fulfilled', value: f.message },
    { status: 'fulfilled', value: f.message },
  ]);
  expect(await primary.summary(f.job)).toMatchObject({
    actualAtomic: '5000',
    reservedAtomic: '5000',
    uncertain: [],
  });
  expect(await secondary.summary(secondJob)).toMatchObject({
    actualAtomic: '4000',
    reservedAtomic: '4000',
    uncertain: [],
  });
  expect(f.router.deposits).toBe(2);
  expect(f.router.settledFees).toBe(3);

  await expect(
    f.make().forInferenceSlot(1).messages(anotherJob(), message('Next batch'), stop.signal),
  ).resolves.toEqual(f.message);
  expect(f.router.channels.size).toBe(2);
  expect(f.router.channels.get(originalChannel!)?.charged).toBe(2000n);
  expect([...f.router.channels.values()].map((channel) => channel.balance)).toEqual([
    250000n,
    250000n,
  ]);
  expect((await readSpendSummary(f.dir))?.committedAtomic).toBe('500000');
  expect(f.router.deposits).toBe(2);
  expect(f.router.settledFees).toBe(4);
  expect(f.router.paidRequests()).toBe(4);
});

it('refills a worker channel in $0.25 deposits as inference consumes its credit', async () => {
  const f = await fixture({ quote: '120000', charge: '100000', refundCapability: 'enabled' });
  const signal = new AbortController().signal;
  const transport = f.make();
  await transport.withInferenceRun(f.job.id, signal, async (worker) => {
    for (const turn of [1, 2, 3]) {
      await worker.messages(
        f.job,
        { messages: [{ role: 'user', content: `Turn ${turn}` }] },
        signal,
      );
      expect(f.router.deposits).toBe(turn === 3 ? 2 : 1);
    }
  });
  expect([...f.router.channels.values()]).toMatchObject([{ balance: 500000n, charged: 300000n }]);
  expect((await readSpendSummary(f.dir))?.committedAtomic).toBe('500000');
  expect(await transport.summary(f.job)).toMatchObject({ actualAtomic: '303000' });
});

it('funds only the deficit for an inference quote that needs more than $0.25', async () => {
  const f = await fixture({ quote: '400000', charge: '1000' });
  await f.make().messages(f.job, { messages: [] }, new AbortController().signal);
  expect([...f.router.channels.values()]).toMatchObject([{ balance: 400000n, charged: 1000n }]);
  expect((await readSpendSummary(f.dir))?.committedAtomic).toBe('400000');
});

it('applies the same rolling deposit budget to both inference channels', async () => {
  const f = await fixture({ quote: '50000', minDeposit: '50000' });
  f.deps.policy = async () => ({ ...TEST_POLICY, sessionBudgetAtomic: 50000n });
  const transport = f.make();
  const signal = new AbortController().signal;
  await transport.messages(f.job, { messages: [] }, signal);
  expect((await readSpendSummary(f.dir))?.committedAtomic).toBe('50000');

  const secondJob = {
    ...f.job,
    id: randomUUID(),
    decision: { ...f.job.decision, jobId: randomUUID() },
  };
  const secondary = transport.forInferenceSlot(1);
  await expect(secondary.messages(secondJob, { messages: [] }, signal)).rejects.toMatchObject({
    detail: { cause: 'payment_refused' },
  });
  expect(await secondary.summary(secondJob)).toMatchObject({
    actualAtomic: '3000',
    reservedAtomic: '3000',
    uncertain: [],
  });
  expect(f.router.deposits).toBe(1);
  expect(f.router.paidRequests()).toBe(1);
});

const say = (content: string) => ({ messages: [{ role: 'user', content }] });
const jobLike = (job: ModelJob): ModelJob => ({
  ...job,
  id: randomUUID(),
  decision: { ...job.decision, jobId: randomUUID() },
});

// Live fault of 2026-11-18: a 4-call job took 97.8 s beside its batch sibling's 43.2 s.
// Each of three of its calls ended 2.0 to 2.6 s after a call of another session's job
// ended: both processes started at lane 0, whose payment lock one call holds for a whole
// model call, while lane 1 stood idle between the sibling's calls.
it("pays on the other shared lane when another process's call holds a worker's own, without waiting for it", async ({
  onTestFinished,
}) => {
  const f = await fixture({ quote: '120000' });
  const stop = new AbortController();
  const held = deferred();
  const entered = deferred();
  f.router.hold = held.promise;
  f.router.onDelayArmed = entered.resolve;
  onTestFinished(() => {
    held.resolve();
    stop.abort();
  });
  // Two transports that share only the data folder, as two `tenjin mcp` processes do.
  const first = f.make().messages(f.job, say('A long call of the first session'), stop.signal);
  await Promise.race([entered.promise, first]);
  f.router.hold = null;
  const timings: Record<string, unknown>[] = [];
  const other = jobLike(f.job);
  await expect(
    f
      .make()
      .messages(other, say('A call of the second session'), stop.signal, undefined, (timing) =>
        timings.push({ ...timing }),
      ),
  ).resolves.toEqual(f.message);
  // The first call is still in flight on lane 0: the second paid on lane 1 meanwhile.
  expect([...f.router.channels.values()].map((channel) => channel.pending)).toEqual([true, false]);
  expect(timings[0]).toMatchObject({ slot: 1, laneMoved: true });
  expect(timings[0]).not.toHaveProperty('waitedOn');
  held.resolve();
  await expect(first).resolves.toEqual(f.message);
  expect(f.vouchers.map((voucher) => voucher.status)).toEqual([200, 200]);
  expect(new Set(f.vouchers.map((voucher) => voucher.channel)).size).toBe(2);
});

it.each(['settles', 'cancels'] as const)(
  '%s an inference call queued while both shared lanes are held, and signs nothing for it meanwhile',
  async (outcome) => {
    const f = await fixture({ quote: '120000' });
    const signal = new AbortController().signal;
    const held = deferred();
    let armed = deferred();
    f.router.hold = held.promise;
    f.router.onDelayArmed = () => armed.resolve();
    const first = f.make().messages(f.job, say('Holds lane 0'), signal);
    await armed.promise;
    armed = deferred();
    const secondJob = jobLike(f.job);
    const second = f.make().messages(secondJob, say('Holds lane 1'), signal);
    await armed.promise;
    expect([...f.router.channels.values()].map((channel) => channel.pending)).toEqual([true, true]);

    const channel = watchPaymentLock();
    const thirdJob = jobLike(f.job);
    const third = f.make();
    const abort = new AbortController();
    const timings: Record<string, unknown>[] = [];
    const queued = third.messages(thirdJob, say('Queued'), abort.signal, undefined, (timing) =>
      timings.push({ ...timing }),
    );
    const pending = Promise.allSettled([first, second, queued]);
    const reason = new Error('Third worker stopped');
    try {
      await Promise.race([channel.waiting, queued]);
      // Both channels are held. The third call has only a local quote.
      expect(f.vouchers).toHaveLength(2);
      expect(await third.summary(thirdJob)).toMatchObject({ reservedAtomic: '123000' });
      if (outcome === 'cancels') {
        abort.abort(reason);
        await expect(queued).rejects.toBe(reason);
        expect(await third.summary(thirdJob)).toMatchObject({
          reservedAtomic: '3000',
          uncertain: [],
        });
      }
    } finally {
      held.resolve();
      channel.restore();
    }
    const [one, two, waited] = await pending;
    expect([one, two]).toEqual([
      { status: 'fulfilled', value: f.message },
      { status: 'fulfilled', value: f.message },
    ]);
    if (outcome === 'settles') {
      expect(waited).toEqual({ status: 'fulfilled', value: f.message });
      expect(await third.summary(thirdJob)).toMatchObject({
        reservedAtomic: '4000',
        uncertain: [],
      });
      // It waited on a holder in this process (the test's transports share one).
      expect(timings[0]).toMatchObject({ waitedOn: 'this_process' });
    } else expect(waited).toEqual({ status: 'rejected', reason });
    expect(f.vouchers.map((voucher) => voucher.status)).toEqual(
      outcome === 'settles' ? [200, 200, 200] : [200, 200],
    );
    expect(f.router.channels.size).toBe(2);
    expect(f.router.deposits).toBe(2);
  },
);

// Money rule: no amount is signed twice or skipped, and a channel's voucher never goes
// down. The fake router accepts a voucher only when it claims exactly the channel's
// charged total plus the quote, and refuses a second payment on a channel in flight.
it('signs each channel total once and in rising order for five jobs of three transports paying at once', async () => {
  const f = await fixture({ quote: '20000', charge: '7000', minDeposit: '900000' });
  const signal = new AbortController().signal;
  // Three processes' worth of transports: two prefer lane 0, one prefers lane 1.
  const transports = [f.make(), f.make(), f.make().forInferenceSlot(1)];
  const jobs = [f.job, jobLike(f.job), jobLike(f.job), jobLike(f.job), jobLike(f.job)];
  const turns = [0, 1, 2, 3];
  await Promise.all(
    jobs.map(async (job, index) => {
      // One job's calls follow one another, as a worker's turns do.
      for (const turn of turns)
        await transports[index % transports.length]!.messages(
          job,
          say(`Job ${index} turn ${turn}`),
          signal,
        );
    }),
  );
  const calls = jobs.length * turns.length;
  // Every signed request was accepted: none claimed a stale or a repeated total.
  expect(f.vouchers.map((voucher) => voucher.status)).toEqual(Array(calls).fill(200));
  const byChannel = new Map<string, bigint[]>();
  for (const voucher of f.vouchers)
    byChannel.set(voucher.channel, [...(byChannel.get(voucher.channel) ?? []), voucher.max]);
  expect(byChannel.size).toBe(2);
  for (const totals of byChannel.values())
    // Each claims what the calls before it on that channel were charged, plus its quote.
    expect(totals).toEqual(totals.map((_, n) => BigInt(n) * 7000n + 20000n));
  expect([...f.router.channels.values()].reduce((sum, channel) => sum + channel.charged, 0n)).toBe(
    BigInt(calls) * 7000n,
  );
  for (const [index, job] of jobs.entries())
    expect(await transports[index % transports.length]!.summary(job)).toEqual({
      actualAtomic: (3000 + turns.length * 7000).toString(),
      reservedAtomic: (3000 + turns.length * 7000).toString(),
      uncertain: [],
    });
});

it("runs two runs' calls at once on a router that refunds, each under its own channel's lock", async ({
  onTestFinished,
}) => {
  const f = await fixture({ quote: '120000', refundCapability: 'enabled' });
  const stop = new AbortController();
  const held = deferred();
  const both = deferred();
  let entered = 0;
  f.router.hold = held.promise;
  f.router.onDelayArmed = () => {
    if (++entered === 2) both.resolve();
  };
  onTestFinished(() => {
    held.resolve();
    stop.abort();
  });
  const secondJob = jobLike(f.job);
  // Both workers hold lane 0 in their own process. Each run pays on its own channel.
  const runs = [f.job, secondJob].map((job) =>
    f
      .make()
      .withInferenceRun(job.id, stop.signal, (worker) =>
        worker.messages(job, say('A call of its run'), stop.signal),
      ),
  );
  await Promise.race([both.promise, ...runs]);
  expect([...f.router.channels.values()].map((channel) => channel.pending)).toEqual([true, true]);
  held.resolve();
  await expect(Promise.all(runs)).resolves.toEqual([f.message, f.message]);
  expect(f.vouchers.map((voucher) => voucher.status)).toEqual([200, 200]);
});

it('waits for its own lane when the other lane cannot be funded within the daily budget, and pays there', async () => {
  // One deposit is all the budget allows: it funded lane 0 for several calls.
  const f = await fixture({ quote: '50000', minDeposit: '200000' });
  f.deps.policy = async () => ({ ...TEST_POLICY, sessionBudgetAtomic: 200000n });
  const signal = new AbortController().signal;
  await f.make().messages(f.job, say('Funds lane 0'), signal);
  const held = deferred();
  const entered = deferred();
  f.router.hold = held.promise;
  f.router.onDelayArmed = entered.resolve;
  const first = f.make().messages(f.job, say('Holds lane 0'), signal);
  await entered.promise;
  f.router.hold = null;
  const channel = watchPaymentLock();
  const other = jobLike(f.job);
  const timings: Record<string, unknown>[] = [];
  const second = f
    .make()
    .messages(other, say('Meets lane 0 held'), signal, undefined, (timing) =>
      timings.push({ ...timing }),
    );
  try {
    await Promise.race([channel.waiting, second]);
  } finally {
    held.resolve();
    channel.restore();
  }
  // Lane 1 needed a deposit the budget refuses. Nothing was signed for it: the call
  // waited for lane 0, as it did before lanes were shared out, and paid from its credit.
  await expect(Promise.all([first, second])).resolves.toEqual([f.message, f.message]);
  expect(timings[0]).toMatchObject({ slot: 0 });
  expect(timings[0]).not.toHaveProperty('laneMoved');
  expect(f.router.deposits).toBe(1);
  expect(f.router.channels.size).toBe(1);
  expect(f.vouchers.map((voucher) => voucher.status)).toEqual([200, 200, 200]);
  expect((await readSpendSummary(f.dir))?.committedAtomic).toBe('200000');
});

it("holds a job's total against a lowered cap when its call takes the other lane, and signs nothing", async () => {
  const f = await fixture({ quote: '300000', minDeposit: '900000' });
  const signal = new AbortController().signal;
  await f.make().messages(f.job, say('first'), signal);
  const budget = join(f.dir, 'model-jobs', `${f.job.id}.budget.json`);
  const spent = BigInt(JSON.parse(await readFile(budget, 'utf8')).charged);
  const held = deferred();
  const entered = deferred();
  f.router.hold = held.promise;
  f.router.onDelayArmed = entered.resolve;
  const blocker = f.make().messages(jobLike(f.job), say('Holds lane 0'), signal);
  await entered.promise;
  f.router.hold = null;
  // Lowered when the call, its quote already reserved, takes its turn to pay.
  const withFirstFileLock = locks.withFirstFileLock;
  const lane = vi.spyOn(locks, 'withFirstFileLock').mockImplementation(async (paths, run, opts) => {
    if (paths[0]!.endsWith('.payment.lock')) {
      const path = join(f.dir, 'config.json');
      const config = JSON.parse(await readFile(path, 'utf8'));
      await writeFile(
        path,
        JSON.stringify({ ...config, maxAutoSpend: (spent + 300000n - 1n).toString() }),
      );
    }
    return withFirstFileLock(paths, run, opts);
  });
  try {
    await expect(f.make().messages(f.job, say('second'), signal)).rejects.toMatchObject({
      message: expect.stringContaining('remaining job ceiling'),
      detail: { cause: 'budget' },
    });
  } finally {
    lane.mockRestore();
    held.resolve();
  }
  await blocker;
  // The job's first call and the blocker's: no voucher for the refused call, on any lane.
  expect(f.vouchers).toHaveLength(2);
  expect(JSON.parse(await readFile(budget, 'utf8')).charged).toBe(spent.toString());
});

it('never signs again for a call left uncertain on the other lane, on either lane', async () => {
  const f = await fixture({ quote: '120000' });
  const signal = new AbortController().signal;
  const held = deferred();
  const entered = deferred();
  f.router.hold = held.promise;
  f.router.onDelayArmed = entered.resolve;
  const blocker = f.make().messages(f.job, say('Holds lane 0'), signal);
  await entered.promise;
  f.router.hold = null;
  // The router settles the call on lane 1 and its answer is lost.
  f.router.abortAfterSettle = true;
  f.setRecoveryState('running');
  const other = jobLike(f.job);
  const transport = f.make();
  await expect(transport.messages(other, say('Lost answer'), signal)).rejects.toMatchObject({
    message: expect.stringContaining('uncertain'),
  });
  held.resolve();
  await blocker;
  expect(f.vouchers).toHaveLength(2);
  // Both lanes are free now. The same request is not bought again.
  await expect(f.make().messages(other, say('Lost answer'), signal)).rejects.toThrow(
    'no new authorization sent',
  );
  expect(f.vouchers).toHaveLength(2);
  expect(await transport.summary(other)).toMatchObject({ reservedAtomic: '123000' });
  expect((await transport.summary(other)).uncertain).toHaveLength(1);
});

it('recovers after a process that died between signing and sending: its lock is taken over, its call stays reserved and unsigned again, and the next voucher claims the same total once', async () => {
  const f = await fixture({ quote: '120000' });
  const signal = new AbortController().signal;
  await f.make().messages(f.job, say('Funds the channel'), signal);
  // The signed request never leaves: the process dies at the send.
  let die = true;
  const fetchImpl = f.deps.fetchImpl!;
  f.deps.fetchImpl = async (input, init) => {
    if (die && signedRequest(input, init)) throw new Error('process died before the send');
    return fetchImpl(input, init);
  };
  const lost = f.make();
  await expect(lost.messages(f.job, say('Signed, never sent'), signal)).rejects.toMatchObject({
    message: expect.stringContaining('uncertain'),
  });
  expect(f.vouchers).toHaveLength(1);
  die = false;
  // What a killed process leaves: the lane's lock, held by a pid that is gone.
  const gone = spawnSync(process.execPath, ['-e', '']).pid;
  const lock = join(
    f.dir,
    'model-jobs',
    `${modelChannelScope(BASE, 'model-inference', 0).id}.payment.lock`,
  );
  await mkdir(lock);
  await writeFile(join(lock, 'meta'), JSON.stringify({ pid: gone, acquiredAt: Date.now() }));
  // The next process: the same request is not signed again.
  f.setRecoveryState('unknown');
  f.setVoucher('none');
  const next = f.make();
  await expect(next.messages(f.job, say('Signed, never sent'), signal)).rejects.toThrow(
    'no new authorization sent',
  );
  expect(f.vouchers).toHaveLength(1);
  // Its next call takes over the dead lock on the same lane and claims the total the lost
  // voucher claimed. The router never saw that one, so the total is charged once.
  await expect(next.messages(f.job, say('The next call'), signal)).resolves.toEqual(f.message);
  expect(f.vouchers.map((voucher) => [voucher.max, voucher.status])).toEqual([
    [120000n, 200],
    [121000n, 200],
  ]);
  expect([...f.router.channels.values()].map((channel) => channel.charged)).toEqual([2000n]);
  expect(await next.summary(f.job)).toMatchObject({
    actualAtomic: '5000',
    reservedAtomic: '125000',
  });
  expect((await next.summary(f.job)).uncertain).toHaveLength(1);
});

it.each(['messages', 'responses'] as const)(
  'shares one live identical %s request instead of recovering an invocation still in flight',
  async (protocol) => {
    const f = await fixture({ protocol });
    const transport = f.make();
    const held = deferred();
    const entered = deferred();
    f.router.hold = held.promise;
    f.router.onDelayArmed = entered.resolve;
    const body = { model: 'deepseek-flash', messages: [{ role: 'user', content: 'same task' }] };
    const invoke = () => transport[protocol](f.job, body, new AbortController().signal);
    const first = invoke();
    await entered.promise;
    const second = invoke();
    const pending = Promise.all([first, second]);
    held.resolve();
    const results = await pending;
    expect(results).toEqual([
      protocol === 'responses'
        ? 'event: response.completed\ndata: {"owned":"native wire"}\n\n'
        : f.message,
      protocol === 'responses'
        ? 'event: response.completed\ndata: {"owned":"native wire"}\n\n'
        : f.message,
    ]);
    if (protocol === 'messages') {
      const [firstResult, secondResult] = results as [typeof f.message, typeof f.message];
      expect(firstResult).not.toBe(secondResult);
      firstResult.content[0]!.text = 'Only this caller changed its result';
      expect(secondResult).toEqual(f.message);
      await expect(transport.messages(f.job, body, new AbortController().signal)).resolves.toEqual(
        f.message,
      );
    }
    expect(f.router.paidRequests()).toBe(1);
    expect(f.router.settledFees).toBe(1);
    expect(f.gets()).toBe(0);
    expect(await transport.summary(f.job)).toEqual({
      actualAtomic: '4000',
      reservedAtomic: '4000',
      uncertain: [],
    });
  },
);

it('shares the first live uncertain failure and retains its reservation until owner recovery', async () => {
  const f = await fixture({ drop: true });
  const transport = f.make();
  const held = deferred();
  const entered = deferred();
  f.router.hold = held.promise;
  f.router.onDelayArmed = entered.resolve;
  const body = { messages: [{ role: 'user', content: 'same uncertain task' }] };
  const first = transport.messages(f.job, body, new AbortController().signal);
  await entered.promise;
  const second = transport.messages(f.job, body, new AbortController().signal);
  const pending = Promise.allSettled([first, second]);
  held.resolve();
  const results = await pending;
  expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
  for (const result of results)
    if (result.status === 'rejected') expect(result.reason.message).toMatch(/uncertain/);
  if (results[0]?.status === 'rejected' && results[1]?.status === 'rejected')
    expect(results[0].reason).toBe(results[1].reason);
  expect(f.router.paidRequests()).toBe(1);
  expect(f.gets()).toBe(0);
  expect(await transport.summary(f.job)).toMatchObject({
    reservedAtomic: '503000',
    uncertain: [expect.any(String)],
  });
  await expect(transport.messages(f.job, body, new AbortController().signal)).resolves.toEqual(
    f.message,
  );
  expect(f.gets()).toBe(1);
  expect(f.router.paidRequests()).toBe(1);
});

it.each(['first', 'second'] as const)(
  'cancels only the %s identical caller while its peer still owns the live request',
  async (cancelled) => {
    const f = await fixture();
    const transport = f.make();
    const held = deferred();
    const entered = deferred();
    f.router.hold = held.promise;
    f.router.onDelayArmed = entered.resolve;
    const body = { messages: [{ role: 'user', content: 'shared task' }] };
    const firstController = new AbortController(),
      secondController = new AbortController();
    const first = transport.messages(f.job, body, firstController.signal);
    await entered.promise;
    const second = transport.messages(f.job, body, secondController.signal);
    const pending = Promise.allSettled([first, second]);
    const reason = new Error('Only this caller cancelled');
    try {
      (cancelled === 'first' ? firstController : secondController).abort(reason);
      expect(f.paidSignals).toHaveLength(1);
      expect(f.paidSignals[0]!.aborted).toBe(false);
    } finally {
      held.resolve();
    }
    const results = await pending;
    const stopped = results[cancelled === 'first' ? 0 : 1]!;
    const remaining = results[cancelled === 'first' ? 1 : 0]!;
    expect(stopped).toEqual({ status: 'rejected', reason });
    expect(remaining).toEqual({ status: 'fulfilled', value: f.message });
    expect(f.router.paidRequests()).toBe(1);
    expect(f.gets()).toBe(0);
    expect(await transport.summary(f.job)).toMatchObject({ reservedAtomic: '4000', uncertain: [] });
  },
);

it('keeps another transport on authoritative owner recovery while the original request is pending', async () => {
  const f = await fixture();
  const held = deferred();
  const entered = deferred();
  f.router.hold = held.promise;
  f.router.onDelayArmed = entered.resolve;
  f.setRecoveryState('pending');
  const body = { messages: [{ role: 'user', content: 'same request in another process' }] };
  const first = f.make().messages(f.job, body, new AbortController().signal);
  await entered.promise;
  try {
    await expect(f.make().messages(f.job, body, new AbortController().signal)).rejects.toThrow(
      /no new authorization/,
    );
    expect(f.gets()).toBe(1);
    expect(f.router.paidRequests()).toBe(1);
    expect(await f.make().summary(f.job)).toMatchObject({
      reservedAtomic: '503000',
      uncertain: [expect.any(String)],
    });
  } finally {
    held.resolve();
  }
  await expect(first).resolves.toEqual(f.message);
});

it('aborts and drains the paid operation when its last identical caller cancels without erasing exposure', async () => {
  const f = await fixture({ drop: true });
  const transport = f.make();
  const held = deferred(),
    entered = deferred();
  f.router.hold = held.promise;
  f.router.onDelayArmed = entered.resolve;
  const body = { messages: [{ role: 'user', content: 'cancel the final waiter' }] };
  const firstController = new AbortController(),
    controller = new AbortController();
  const first = transport
    .messages(f.job, body, firstController.signal)
    .catch((error: unknown) => error);
  await entered.promise;
  let finished = false;
  const pending = transport.messages(f.job, body, controller.signal).catch((error: unknown) => {
    finished = true;
    return error;
  });
  const firstReason = new Error('First caller stopped');
  const reason = new Error('Owner stopped');
  try {
    firstController.abort(firstReason);
    expect(f.paidSignals[0]!.aborted).toBe(false);
    controller.abort(reason);
    expect(f.paidSignals[0]!.aborted).toBe(true);
    expect(await first).toBe(firstReason);
    expect(await transport.summary(f.job)).toMatchObject({
      reservedAtomic: '503000',
      uncertain: [expect.any(String)],
    });
    expect(finished).toBe(false);
  } finally {
    held.resolve();
  }
  expect(await pending).toBe(reason);
  expect(finished).toBe(true);
  expect(f.router.paidRequests()).toBe(1);
  expect(await transport.summary(f.job)).toMatchObject({
    reservedAtomic: '503000',
    uncertain: [expect.any(String)],
  });
  await expect(f.make().messages(f.job, body, new AbortController().signal)).resolves.toEqual(
    f.message,
  );
  expect(f.router.paidRequests()).toBe(1);
  expect(f.gets()).toBe(1);
});

it('continues with the original ledger and refuses to recreate a missing resume budget', async () => {
  const f = await fixture();
  const transport = f.make();
  const initial = { model: 'deepseek-flash', messages: [{ role: 'user', content: 'first' }] };
  await transport.messages(f.job, initial, new AbortController().signal);
  await transport.requireResumeBudget(f.job);
  const resumed = { ...f.job, decision: { ...f.job.decision, requireExistingBudget: true } };
  await transport.messages(resumed, { ...initial, max_tokens: 200 }, new AbortController().signal);
  expect(await transport.summary(resumed)).toMatchObject({ actualAtomic: '5000' });
  const path = join(f.dir, 'model-jobs', `${f.job.id}.budget.json`);
  const saved = await readFile(path, 'utf8');
  await rm(path);
  await expect(transport.requireResumeBudget(f.job)).rejects.toThrow(/Original model budget/);
  await expect(
    transport.messages(resumed, { ...initial, max_tokens: 300 }, new AbortController().signal),
  ).rejects.toThrow(/Original model budget/);
  expect(f.router.paidRequests()).toBe(2);
  await writeFile(path, saved);
  await transport.requireResumeBudget(f.job);
  expect(await transport.summary(resumed)).toMatchObject({ actualAtomic: '5000' });
});

it.each(['messages', 'responses'] as const)(
  'waits past the former 180-second paid %s deadline and settles once',
  async (protocol) => {
    const f = await fixture({ protocol });
    const transport = f.make();
    const request = { model: 'deepseek-flash', messages: [{ role: 'user', content: 'first' }] };
    const invoke = (body: Record<string, unknown>) =>
      protocol === 'responses'
        ? transport.responses(f.job, body, new AbortController().signal)
        : transport.messages(f.job, body, new AbortController().signal);
    await invoke(request); // Establish warm credit before the slow inference.
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.router.delayMs = 200_000;
    f.router.onDelayArmed = entered;
    vi.useFakeTimers();
    const pending = expect(invoke({ ...request, max_tokens: 200 })).resolves.toEqual(
      protocol === 'responses'
        ? 'event: response.completed\ndata: {"owned":"native wire"}\n\n'
        : f.message,
    );
    await started;
    await vi.advanceTimersByTimeAsync(200_000);
    await pending;
    expect(f.router.paidRequests()).toBe(2);
    expect((await transport.summary(f.job)).uncertain).toEqual([]);
  },
);

it('recovers a dropped paid response through signed owner lookup without another model authorization', async () => {
  const f = await fixture({ drop: true });
  const request = { model: 'deepseek-flash', messages: [{ role: 'user', content: 'once' }] };
  await expect(f.make().messages(f.job, request, new AbortController().signal)).rejects.toThrow(
    /uncertain/,
  );
  const transport = f.make();
  expect((await transport.summary(f.job)).reservedAtomic).toBe('503000');
  expect(await transport.messages(f.job, request, new AbortController().signal)).toEqual(f.message);
  expect(f.router.paidRequests()).toBe(1);
  expect(f.gets()).toBe(1);
  expect(f.signedGets()).toBe(1);
  expect(await transport.summary(f.job)).toEqual({
    actualAtomic: '4000',
    reservedAtomic: '4000',
    uncertain: [],
  });
});

it('retains uncertain exposure until voucher acceptance and refuses a lowered or corrupt ceiling before payment', async () => {
  const f = await fixture({ drop: true });
  const request = { model: 'deepseek-flash', messages: [{ role: 'user', content: 'once' }] };
  await expect(f.make().messages(f.job, request, new AbortController().signal)).rejects.toThrow();
  f.setVoucher('unknown');
  await expect(f.make().messages(f.job, request, new AbortController().signal)).rejects.toThrow(
    /no new authorization/,
  );
  expect(f.router.paidRequests()).toBe(1);
  expect((await f.make().summary(f.job)).reservedAtomic).toBe('503000');
  const budget = join(f.dir, 'model-jobs', `${f.job.id}.budget.json`);
  expect(JSON.parse(await readFile(budget, 'utf8')).charged).toBe('503000');
  await writeFile(budget, '{broken');
  await expect(f.make().messages(f.job, request, new AbortController().signal)).rejects.toThrow(
    /Unreadable model budget/,
  );
  expect(f.router.paidRequests()).toBe(1);
  const small = await fixture({ cap: '400000' });
  await expect(
    small.make().messages(small.job, request, new AbortController().signal),
  ).rejects.toThrow(/remaining job ceiling/);
  expect(small.router.paidRequests()).toBe(0);
});

it('does not transmit a routing authorization after cancellation while the signer is unlocking', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'model-route-abort-'));
  made.push(dir);
  const router = new FakeRouter({ path: '/api/model-router/route' });
  const wallet = privateKeyToAccount(generatePrivateKey());
  let entered!: () => void;
  const unlocking = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let resume!: () => void;
  const held = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const deps = payerDeps(router, dir, wallet, {
    getSigner: async () => {
      entered();
      await held;
      return testSigner(wallet);
    },
  });
  const transport = new ModelTransport({
    dataDir: dir,
    baseUrl: BASE,
    payerDeps: deps,
  });
  const abort = new AbortController();
  const pending = transport.route({ schemaVersion: 1 }, abort.signal);
  const rejected = expect(pending).rejects.toThrow();
  await unlocking;
  abort.abort();
  resume();
  await rejected;
  expect(router.paidRequests()).toBe(0);
  expect(router.settledFees).toBe(0);
  expect((await readSpendSummary(dir))?.committedAtomic ?? '0').toBe('0');
});

it('releases an unsent inference quote and inline deposit when workspace scope changes during signing', async () => {
  const f = await fixture();
  const transport = f.make();
  let currentScope = true;
  let committedAtRefusal: string | undefined;
  const getSigner = f.deps.getSigner;
  f.deps.getSigner = async () => {
    const signer = await getSigner();
    return {
      ...signer,
      signTypedData: async (input) => {
        const signature = await signer.signTypedData(input);
        currentScope = false;
        return signature;
      },
    };
  };
  await expect(
    transport.messages(f.job, { messages: [] }, new AbortController().signal, async () => {
      if (currentScope) return;
      committedAtRefusal = (await readSpendSummary(f.dir))?.committedAtomic;
      throw new Error('Workspace scope changed');
    }),
  ).rejects.toMatchObject({ detail: { cause: 'payment_refused' } });
  expect(currentScope).toBe(false);
  expect(BigInt(committedAtRefusal ?? '0')).toBeGreaterThan(0n);
  expect(f.router.paidRequests()).toBe(0);
  expect(f.router.deposits).toBe(0);
  expect(await readSpendSummary(f.dir)).toMatchObject({
    committedAtomic: '0',
    automaticCommittedAtomic: '0',
    settledAtomic: '0',
    reservations: [],
    exposures: [],
  });
  expect(await transport.summary(f.job)).toEqual({
    actualAtomic: '3000',
    reservedAtomic: '3000',
    uncertain: [],
  });
});

it('keeps native Responses opaque fields intact and budgets worker plus Guardian in the same job', async () => {
  const wire = 'event: response.completed\ndata: {"response":{"opaque":"unchanged"}}\n\n';
  const f = await fixture({ protocol: 'responses', wire });
  const transport = f.make();
  const worker = {
    model: 'deepseek-flash',
    reasoning: { effort: 'high' },
    stream: true,
    input: [{ type: 'reasoning', encrypted_content: 'OPAQUE-native-signature-1234567890' }],
    tools: [{ type: 'namespace', name: 'fixture', tools: [{ type: 'function', name: 'read' }] }],
  };
  expect(await transport.responses(f.job, worker, new AbortController().signal)).toBe(wire);
  expect(f.last()).toMatchObject({
    protocol: 'responses',
    responses: worker,
    jobId: f.job.decision.jobId,
  });
  expect(await f.make().responses(f.job, worker, new AbortController().signal)).toBe(wire);
  await transport.responses(
    f.job,
    { ...worker, reasoning: { effort: 'low' } },
    new AbortController().signal,
  );
  expect(f.router.paidRequests()).toBe(2);
  expect(f.router.channels.size).toBe(1);
  expect(await transport.summary(f.job)).toEqual({
    actualAtomic: '5000',
    reservedAtomic: '5000',
    uncertain: [],
  });
});

it('recovers the exact Responses wire through owner lookup without buying a replacement request', async () => {
  const wire = 'event: response.completed\ndata: {"opaque":"native-result"}\n\n';
  const f = await fixture({ protocol: 'responses', wire, drop: true });
  const input = { model: 'deepseek-flash', reasoning: { effort: 'high' }, input: 'Once' };
  await expect(f.make().responses(f.job, input, new AbortController().signal)).rejects.toThrow(
    /uncertain/,
  );
  expect(await f.make().responses(f.job, input, new AbortController().signal)).toBe(wire);
  expect(f.router.paidRequests()).toBe(1);
  expect(f.gets()).toBe(1);
  expect(f.signedGets()).toBe(1);
  expect(await f.make().summary(f.job)).toEqual({
    actualAtomic: '4000',
    reservedAtomic: '4000',
    uncertain: [],
  });
});

it('accepts bounded native Responses receipts beyond the old Messages response size', async () => {
  const wire = 'event: response.completed\ndata: ' + 'x'.repeat(2_200_000) + '\n\n';
  const f = await fixture({ protocol: 'responses', wire });
  expect(
    await f
      .make()
      .responses(
        f.job,
        { model: 'deepseek-flash', input: 'Long native stream' },
        new AbortController().signal,
      ),
  ).toBe(wire);
  expect(f.router.paidRequests()).toBe(1);
});

it('preserves complete Responses wire near the hosted JSON receipt envelope ceiling', async () => {
  const wire = 'event: response.completed\ndata: ' + 'x'.repeat(4_300_000) + '\n\n';
  const f = await fixture({ protocol: 'responses', wire });
  await expect(
    f
      .make()
      .responses(
        f.job,
        { model: 'deepseek-flash', input: 'Exact wire' },
        new AbortController().signal,
      ),
  ).resolves.toBe(wire);
  expect(f.router.paidRequests()).toBe(1);
});

it('bounds escaped Responses envelopes on both paid results and owner recovery without releasing exposure', async () => {
  // The raw wire fits 4.5MB, but JSON escaping exceeds the actual hosted POST/GET limit.
  const f = await fixture({ protocol: 'responses', wire: '"'.repeat(2_300_000) });
  const body = { model: 'deepseek-flash', input: 'Oversized escaped wire' };
  const first = await f
    .make()
    .responses(f.job, body, new AbortController().signal)
    .then(
      () => 'unexpected success',
      (error: Error) => error.message,
    );
  expect(first).toMatch(/uncertain/);
  expect(await f.make().summary(f.job)).toMatchObject({
    reservedAtomic: '503000',
    uncertain: [expect.any(String)],
  });
  await expect(f.make().responses(f.job, body, new AbortController().signal)).rejects.toThrow(
    /size limit/,
  );
  expect(f.router.paidRequests()).toBe(1);
  expect(f.gets()).toBe(1);
  expect(await f.make().summary(f.job)).toMatchObject({
    reservedAtomic: '503000',
    uncertain: [expect.any(String)],
  });
});

// tenjin#1153 review: its server settled a reply through 4,000,000 bytes while this parser
// refused one above 2,000,000 on the paid reply and on recovery, after the charge. That
// server now settles only up to the size a call states, and refuses a larger reply unpaid.
it('states the result size it reads only to a router whose offer says it honours one, and then reads that much', async () => {
  const request = { model: 'deepseek-flash', messages: [{ role: 'user', content: 'long' }] };
  const signal = new AbortController().signal;
  // Production today: its strict schema refuses the field, so none is sent.
  const today = await fixture();
  await today.make().messages(today.job, request, signal);
  expect(today.last()).not.toHaveProperty('maxResultBytes');
  // A router whose offer names the size it honours: stated, up to what this CLI reads.
  const f = await fixture({ drop: true });
  f.job.decision.maxResultBytes = 8_000_000;
  f.message.content[0]!.text = 'x'.repeat(2_100_000);
  await expect(f.make().messages(f.job, request, signal)).rejects.toThrow(/uncertain/);
  expect(f.last()).toMatchObject({ maxResultBytes: 4_000_000, messages: request });
  // The same reply is read on receipt recovery, and on a paid reply that arrives.
  expect(await f.make().messages(f.job, request, signal)).toEqual(f.message);
  expect(f.router.paidRequests()).toBe(1);
  const paid = await fixture();
  paid.job.decision.maxResultBytes = 4_000_000;
  paid.message.content[0]!.text = 'x'.repeat(2_100_000);
  expect(await paid.make().messages(paid.job, request, signal)).toEqual(paid.message);
  // An offer that names less than a router delivers unasked is no statement at all.
  const odd = await fixture();
  odd.job.decision.maxResultBytes = 1_000;
  await odd.make().messages(odd.job, request, signal);
  expect(odd.last()).not.toHaveProperty('maxResultBytes');
  // Responses has no such field: its contract refuses it.
  const responses = await fixture({ protocol: 'responses' });
  responses.job.decision.maxResultBytes = 4_000_000;
  await responses.make().responses(responses.job, { model: 'deepseek-flash', input: [] }, signal);
  expect(responses.last()).not.toHaveProperty('maxResultBytes');
});

// The router serves one call up to 540 s (300 s in production), so the client's wait for
// the paid answer, 360 s before, ended a call the router was still serving.
it('waits for a paid answer longer than the router allows a call, 540 s with a margin', async () => {
  const timeouts: number[] = [];
  const real = globalThis.setTimeout;
  const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    ...args: Parameters<typeof setTimeout>
  ) => {
    if (typeof args[1] === 'number') timeouts.push(args[1]);
    return real(...args);
  }) as typeof setTimeout);
  try {
    const f = await fixture({});
    await f
      .make()
      .messages(
        f.job,
        { model: 'deepseek-flash', max_tokens: 1000, messages: [] },
        new AbortController().signal,
      );
  } finally {
    spy.mockRestore();
  }
  expect(MODEL_PAID_CALL_TIMEOUT_MS).toBeGreaterThanOrEqual(540_000 + 30_000);
  const paidWait = timeouts.filter((ms) => ms > 300_000 && ms <= MODEL_PAID_CALL_TIMEOUT_MS);
  expect(paidWait.length).toBeGreaterThan(0);
  expect(Math.max(...paidWait)).toBeGreaterThan(540_000);
});

// The next server's offer names the router's own deadline for one call: the client waits that
// long plus the constant's minute, a bigger or a smaller figure alike, and the constant when
// the offer names none or names it badly.
it.each([
  ['absent', undefined, 600_000],
  ['present', 540_000, 600_000],
  ['larger than today', 900_000, 960_000],
  ['smaller than today', 300_000, 360_000],
  ['malformed (text)', '540000', 600_000],
  ['malformed (negative)', -1, 600_000],
  ['malformed (fraction)', 1.5, 600_000],
])('waits for a paid answer by the offer: %s', async (_name, offered, expected) => {
  const timeouts: number[] = [];
  const real = globalThis.setTimeout;
  const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    ...args: Parameters<typeof setTimeout>
  ) => {
    if (typeof args[1] === 'number') timeouts.push(args[1]);
    return real(...args);
  }) as typeof setTimeout);
  try {
    const f = await fixture({});
    if (offered !== undefined) f.job.decision.maxCallDurationMs = offered;
    await f
      .make()
      .messages(
        f.job,
        { model: 'deepseek-flash', max_tokens: 1000, messages: [] },
        new AbortController().signal,
      );
  } finally {
    spy.mockRestore();
  }
  expect(timeouts).toContain(expected);
});

// A running job's budget file never reads as a fresh budget: a missing one (swept, deleted)
// would hold the routing fee alone and let the job spend its cap again.
it('refuses the next call of a running job whose budget file went missing, and signs nothing', async () => {
  const f = await fixture({});
  const signal = new AbortController().signal;
  await f.make().messages(f.job, { messages: [{ role: 'user', content: 'first' }] }, signal);
  const paid = f.router.paidRequests();
  await rm(join(f.dir, 'model-jobs', `${f.job.id}.budget.json`));
  await expect(
    f.make().messages(f.job, { messages: [{ role: 'user', content: 'second' }] }, signal),
  ).rejects.toThrow(/budget is missing/i);
  expect(f.router.paidRequests()).toBe(paid);
});

// A 256,000-token call reserves about three times what a 65,536-token one does, so a job
// near its ceiling would stop on a call that a smaller output cap still fits.
it('asks for the largest output cap the rest of the job ceiling can reserve, never below 65,536, and says which', async () => {
  const request = { model: 'deepseek-flash', max_tokens: 256_000, messages: [] };
  const sent = async (cap: string, quote = '100000') => {
    // The fake router quotes a fixed amount, so only the client's own fit decides.
    const f = await fixture({ cap, quote });
    f.job.capAtomic = cap;
    const seen: { outputCap?: number; requestBytes?: number }[] = [];
    const transport = f.make();
    const signal = new AbortController().signal;
    await transport.messages(f.job, request, signal, undefined, (timing) => seen.push(timing));
    const asked = (f.last()?.messages as { max_tokens: number }).max_tokens;
    expect(seen).toMatchObject([{ outputCap: asked }]);
    // The same request again is the same call: answered from its kept result, unpaid.
    await transport.messages(f.job, request, signal);
    expect(f.router.paidRequests()).toBe(1);
    return { asked, bytes: seen[0]!.requestBytes! };
  };
  // Room for the whole cap.
  expect((await sent('1000000')).asked).toBe(256_000);
  // $0.20 less the routing fee: less than 256,000 reserves, more than 65,536 does.
  const stepped = await sent('200000');
  expect(stepped.asked).toBeGreaterThan(65_536);
  expect(stepped.asked).toBeLessThan(256_000);
  expect(modelPeakQuoteAtomic(stepped.bytes, stepped.asked)).toBeLessThanOrEqual(197_000n);
  expect(modelPeakQuoteAtomic(stepped.bytes, stepped.asked + 1_000)).toBeGreaterThan(197_000n);
  // Too little for more than the floor: 65,536, and the quote decides as it always did.
  expect((await sent('80000', '50000')).asked).toBe(65_536);
});

it('rejects a Messages result above the server message ceiling even when the receipt envelope fits', async () => {
  const f = await fixture();
  f.message.content[0]!.text = 'x'.repeat(2_000_000);
  const failure = await f
    .make()
    .messages(f.job, { messages: [] }, new AbortController().signal)
    .then(
      () => 'unexpected success',
      (error: Error) => error.message,
    );
  expect(failure).toMatch(/Invalid model receipt/);
  expect(f.router.paidRequests()).toBe(1);
  expect(await f.make().summary(f.job)).toMatchObject({
    reservedAtomic: '503000',
    uncertain: [expect.any(String)],
  });
});

it('sends known secret shapes in native instructions/text/tool outputs as written, with opaque pairings and schemas intact', async () => {
  const f = await fixture({ protocol: 'responses' });
  const secret = 'sk-proj-abc123DEF456ghi789JKL012_mno';
  const native = {
    model: 'deepseek-flash',
    instructions: `base ${secret}`,
    input: [
      { role: 'developer', content: [{ type: 'input_text', text: `context ${secret}` }] },
      { type: 'function_call', id: secret, call_id: secret, name: 'read', arguments: '{}' },
      { type: 'function_call_output', call_id: secret, output: `tool ${secret}` },
      { type: 'reasoning', encrypted_content: secret, signature: secret },
    ],
    tools: [
      {
        type: 'function',
        name: 'read',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string', pattern: '^sk-proj-abc123$' } },
        },
      },
    ],
  };
  await f.make().responses(f.job, native, new AbortController().signal);
  const sent = f.last()!.responses as typeof native;
  expect(sent.instructions).toContain(secret);
  expect((sent.input[0]!.content![0] as { text: string }).text).toContain(secret);
  expect(sent.input[2]!.output).toContain(secret);
  expect(sent.input[1]!.id).toBe(secret);
  expect(sent.input[2]!.call_id).toBe(secret);
  expect(sent.input[3]!.encrypted_content).toBe(secret);
  expect(sent.input[3]!.signature).toBe(secret);
  expect(sent.tools).toEqual(native.tools);
});

it('releases the job lock during inference and atomically refuses a concurrent over-cap call', async () => {
  const f = await fixture({ cap: '750000' });
  let release!: () => void;
  f.router.hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.router.onDelayArmed = entered;
  const first = f
    .make()
    .messages(
      f.job,
      { messages: [{ role: 'user', content: 'first' }] },
      new AbortController().signal,
    );
  try {
    await started;
    const path = join(f.dir, 'model-jobs', `${f.job.id}.budget.json`);
    expect(await lstat(`${path}.lock`).catch(() => null)).toBeNull();
    await expect(
      f
        .make()
        .messages(
          f.job,
          { messages: [{ role: 'user', content: 'second' }] },
          new AbortController().signal,
        ),
    ).rejects.toThrow(/remaining job ceiling/);
    expect(JSON.parse(await readFile(path, 'utf8')).charged).toBe('503000');
  } finally {
    release();
  }
  await expect(first).resolves.toEqual(f.message);
  expect(await f.make().summary(f.job)).toMatchObject({ reservedAtomic: '4000', uncertain: [] });
  expect(f.router.paidRequests()).toBe(1);
});

it('releases a verified pre-sign policy refusal and permits the same input after policy changes', async () => {
  const f = await fixture();
  const policy = f.deps.policy;
  f.deps.policy = async () => ({ ...TEST_POLICY, maxAutoSpendAtomic: 0n });
  const body = { messages: [{ role: 'user', content: 'once' }] };
  await expect(f.make().messages(f.job, body, new AbortController().signal)).rejects.toThrow(
    /refused before signing/,
  );
  expect(f.router.paidRequests()).toBe(0);
  expect(await f.make().summary(f.job)).toEqual({
    reservedAtomic: '3000',
    actualAtomic: '3000',
    uncertain: [],
  });
  f.deps.policy = policy;
  await expect(f.make().messages(f.job, body, new AbortController().signal)).resolves.toEqual(
    f.message,
  );
  expect(f.router.paidRequests()).toBe(1);
});

it.each(['0', '1', '999999999'])(
  'does not trust an offer routing fee of %s when seeding exposure',
  async (routingFeeAtomic) => {
    const f = await fixture({ cap: '502999' });
    f.job.decision.routingFeeAtomic = routingFeeAtomic;
    expect(await f.make().summary(f.job)).toMatchObject({
      reservedAtomic: '3000',
      actualAtomic: '3000',
    });
    await expect(
      f.make().messages(f.job, { messages: [] }, new AbortController().signal),
    ).rejects.toThrow(/remaining job ceiling/);
    expect(f.router.paidRequests()).toBe(0);
  },
);

it.each([
  ['8100', '8100'],
  ['250000', '250000'],
  ['0', '0'],
])('starts a job budget from the %s its routing call authorized', async (authorized, seeded) => {
  const f = await fixture({ cap: '1000000' });
  f.job.decision.routingAuthorizedAtomic = authorized;
  f.job.decision.routingFeeAtomic = '1';
  expect(await f.make().summary(f.job)).toMatchObject({
    reservedAtomic: seeded,
    actualAtomic: seeded,
  });
  await f.make().messages(f.job, { messages: [] }, new AbortController().signal);
  expect(
    JSON.parse(await readFile(join(f.dir, 'model-jobs', `${f.job.id}.budget.json`), 'utf8'))
      .charged,
  ).toBe((BigInt(seeded) + 1000n).toString());
});

it('holds a job that records no authorization at the most a routing call may pay', async () => {
  const f = await fixture({ cap: '1000000' });
  delete f.job.decision.routingAuthorizedAtomic;
  expect(await f.make().summary(f.job)).toMatchObject({ reservedAtomic: '250000' });
});

it('refuses a call that would pass the cap by the authorized fee, whatever the offer said', async () => {
  const f = await fixture({ cap: '508099' });
  f.job.decision.routingAuthorizedAtomic = '8100';
  f.job.decision.routingFeeAtomic = '3000';
  await expect(
    f.make().messages(f.job, { messages: [] }, new AbortController().signal),
  ).rejects.toThrow(/remaining job ceiling/);
  expect(f.router.paidRequests()).toBe(0);
});

it('settles concurrent owner recoveries once without subtracting the same reservation twice', async () => {
  const f = await fixture({ drop: true });
  const body = { messages: [{ role: 'user', content: 'lost receipt' }] };
  await expect(f.make().messages(f.job, body, new AbortController().signal)).rejects.toThrow(
    /uncertain/,
  );
  expect(
    await Promise.all([
      f.make().messages(f.job, body, new AbortController().signal),
      f.make().messages(f.job, body, new AbortController().signal),
    ]),
  ).toEqual([f.message, f.message]);
  expect(f.router.paidRequests()).toBe(1);
  expect(await f.make().summary(f.job)).toEqual({
    actualAtomic: '4000',
    reservedAtomic: '4000',
    uncertain: [],
  });
});

// Live case: a paid call answered with no result ended its job with nothing to say why.
it('says how a model call failed: the status of an answer that is not a result, a timeout, the ceiling', async () => {
  const f = await fixture();
  const real = f.deps.fetchImpl!;
  const failure = (transport = f.make()) =>
    transport.messages(f.job, { messages: [] }, new AbortController().signal).then(
      () => undefined,
      (error: unknown) => error as ModelCallFailed,
    );
  // No answer to the quote request: nothing is reserved, so nothing is uncertain.
  f.deps.fetchImpl = async () => {
    throw new DOMException('The operation timed out.', 'TimeoutError');
  };
  const timedOut = await failure();
  expect(timedOut).toBeInstanceOf(ModelCallFailed);
  expect(timedOut?.detail).toEqual({ cause: 'timeout', uncharged: true });
  // A quote request answered with an error carries its status.
  f.deps.fetchImpl = async () => new Response('busy', { status: 503 });
  expect((await failure())?.detail).toEqual({ cause: 'failed', status: 503, uncharged: true });
  // A rate limit's Retry-After is kept, for the retry to wait as asked.
  f.deps.fetchImpl = async () =>
    new Response('slow down', { status: 429, headers: { 'retry-after': '3' } });
  expect((await failure())?.detail).toEqual({
    cause: 'failed',
    status: 429,
    uncharged: true,
    retryAfterMs: 3000,
  });
  // A request the router refuses says so in its fixed code; its message is not carried.
  f.deps.fetchImpl = async () =>
    Response.json(
      { error: { code: 'invalid_model_request', message: 'Unsupported model request' } },
      { status: 400 },
    );
  expect((await failure())?.detail).toEqual({
    cause: 'failed',
    status: 400,
    uncharged: true,
    code: 'invalid_model_request',
  });
  expect(await f.make().summary(f.job)).toMatchObject({ uncertain: [] });
  // The paid request answered with an error: its reservation stays until its receipt is read.
  f.deps.fetchImpl = async (input, init) =>
    new Request(input, init).headers.has('payment-signature')
      ? Response.json({ error: { code: 'model_inference_failed' } }, { status: 500 })
      : real(input, init);
  const paid = await failure();
  expect(paid).toBeInstanceOf(ModelCallFailed);
  // The payer's code says the router answered the signed request with an error. The
  // router's record here says the call completed, so it stays reserved for reconciling.
  expect(paid?.detail).toEqual({
    cause: 'failed',
    payer: 'payment_failed',
    status: 500,
    code: 'model_inference_failed',
  });
  expect(paid?.message).toMatch(/uncertain/);
  expect(await f.make().summary(f.job)).toMatchObject({ uncertain: [expect.any(String)] });
  // A quote over what is left of the ceiling is the job's budget.
  const small = await fixture({ quote: '2000000' });
  const over = await small
    .make()
    .messages(small.job, { messages: [] }, new AbortController().signal)
    .catch((error: unknown) => error as ModelCallFailed);
  expect(over?.detail).toEqual({ cause: 'budget' });
});

// Live case: the provider's account was empty, so the router failed every paid call; the
// worker's job ended `unknown` and each call stayed reserved as uncertain.
// Also an empty reply, which the router fails as 502 `incomplete_model_response` before it
// meters anything: zero charge, voucher cancelled, and so tried again.
it.each([
  ['model_inference_failed', 500],
  ['incomplete_model_response', 502],
] as const)(
  'releases at once a call the router failed with %s when its record says it cost nothing, so it can be tried again',
  async (code, status) => {
    const f = await fixture();
    const real = f.deps.fetchImpl!;
    f.setRecoveryState('unknown');
    f.setVoucher('cancelled');
    f.setRecoveryActual('0');
    f.deps.fetchImpl = async (input, init) =>
      new Request(input, init).headers.has('payment-signature')
        ? Response.json({ error: { code, message: 'Model invocation failed' } }, { status })
        : real(input, init);
    const failed = await f
      .make()
      .messages(f.job, { messages: [] }, new AbortController().signal)
      .catch((error: unknown) => error as ModelCallFailed);
    expect(failed).toBeInstanceOf(ModelCallFailed);
    expect(failed?.detail).toEqual({ cause: 'provider', status, uncharged: true, code });
    expect(retryableModelCall(failed)).toBe(true);
    // One free read of the router's record, nothing bought again, and the quote released.
    expect(f.signedGets()).toBe(1);
    expect(await f.make().summary(f.job)).toMatchObject({
      reservedAtomic: '3000',
      uncertain: [],
    });
  },
);

// A model reply that stops with `refusal` is 502 `model_refused` on a server that names it: the
// same request would be refused again, so it is released at no charge and never tried again,
// and the job ends with a reason a person can read. `incomplete_model_response` stays tried.
it('releases a refused reply at no charge, never retries it, and says so plainly', async () => {
  const f = await fixture();
  const real = f.deps.fetchImpl!;
  f.setRecoveryState('unknown');
  f.setVoucher('cancelled');
  f.setRecoveryActual('0');
  f.deps.fetchImpl = async (input, init) =>
    new Request(input, init).headers.has('payment-signature')
      ? Response.json({ error: { code: 'model_refused' } }, { status: 502 })
      : real(input, init);
  const failed = await f
    .make()
    .messages(f.job, { messages: [] }, new AbortController().signal)
    .catch((error: unknown) => error as ModelCallFailed);
  expect(failed).toBeInstanceOf(ModelCallFailed);
  expect(failed?.detail).toEqual({
    cause: 'provider',
    status: 502,
    uncharged: true,
    code: 'model_refused',
  });
  expect(failed?.message).toBe(
    'DeepSeek refused to answer this request, so the job ends here; nothing was charged for it',
  );
  expect(retryableModelCall(failed)).toBe(false);
  expect(await f.make().summary(f.job)).toMatchObject({ reservedAtomic: '3000', uncertain: [] });
});

// A reply of thinking alone is a legal end of a turn: the router delivers and charges it.
// A client that took it for an empty reply would buy the same request again.
it('takes a reply of thinking alone as a completed, charged call', async () => {
  const f = await fixture();
  f.message.content = [
    { type: 'thinking', thinking: 'Nothing more to say.', signature: 's' },
  ] as never;
  const transport = f.make();
  const reply = await transport.messages(f.job, { messages: [] }, new AbortController().signal);
  expect(reply.content).toEqual([
    { type: 'thinking', thinking: 'Nothing more to say.', signature: 's' },
  ]);
  expect(f.router.paidRequests()).toBe(1);
  expect(await transport.summary(f.job)).toEqual({
    actualAtomic: '4000',
    reservedAtomic: '4000',
    uncertain: [],
  });
});

// A REPLY THE ROUTER CUT (504 `model_stream_idle`, `model_deadline_exceeded`). Its record
// reads `state: "unknown"` for every cut, so the proof of no charge is the cancelled
// voucher together with a zero charge. A cut so proven was released but never tried again,
// and one whose record held only `unknown` was released as if it were proven.
const cutReply = async (
  code: string,
  record: { state?: string; voucher?: string; actual?: string; status?: number },
) => {
  const f = await fixture();
  const real = f.deps.fetchImpl!;
  f.setRecoveryState(record.state ?? 'unknown');
  f.setVoucher(record.voucher ?? 'cancelled');
  f.setRecoveryActual(record.actual ?? '0');
  f.setRecoveryStatus(record.status ?? 200);
  let signed = 0;
  f.deps.fetchImpl = async (input, init) => {
    if (!new Request(input, init).headers.has('payment-signature')) return real(input, init);
    signed++;
    return Response.json({ error: { code, message: 'Provider stream stalled' } }, { status: 504 });
  };
  const failed = await f
    .make()
    .messages(f.job, { messages: [] }, new AbortController().signal)
    .catch((error: unknown) => error as ModelCallFailed);
  expect(failed).toBeInstanceOf(ModelCallFailed);
  // Whatever the record says, this call signed once and bought nothing again.
  expect(signed).toBe(1);
  return { f, failed: failed as ModelCallFailed };
};

it.each(['model_stream_idle', 'model_deadline_exceeded'])(
  'releases a reply cut with %s, and lets it be tried again, on a cancelled voucher with a zero charge',
  async (code) => {
    const { f, failed } = await cutReply(code, {});
    expect(failed.detail).toEqual({ cause: 'provider', status: 504, uncharged: true, code });
    expect(retryableModelCall(failed)).toBe(true);
    expect(f.signedGets()).toBe(1);
    expect(await f.make().summary(f.job)).toMatchObject({ reservedAtomic: '3000', uncertain: [] });
  },
);

it.each([
  ['a failed state alone, its voucher still pending', { voucher: 'pending' }],
  ['a record still running', { state: 'running', voucher: 'pending' }],
  ['a cancelled voucher beside a charge', { actual: '1000' }],
  ['an accepted voucher', { state: 'completed', voucher: 'accepted', actual: '1000' }],
  ['a record that cannot be read', { status: 500 }],
] as const)(
  'keeps a cut reply uncertain, reserved and never tried again on %s',
  async (_name, record) => {
    for (const code of ['model_stream_idle', 'model_deadline_exceeded']) {
      const { f, failed } = await cutReply(code, record);
      expect(failed.detail).toMatchObject({ cause: 'failed', status: 504, code });
      expect(failed.detail.uncharged).toBeUndefined();
      expect(retryableModelCall(failed)).toBe(false);
      expect(await f.make().summary(f.job)).toMatchObject({ uncertain: [expect.any(String)] });
    }
  },
);

it('retains exposure when signing starts but fails before a paid request is sent', async () => {
  const f = await fixture();
  const signer = await f.deps.getSigner();
  f.deps.getSigner = async () => ({
    ...signer,
    signTypedData: async () => {
      throw new Error('signing result unknown');
    },
  });
  await expect(
    f.make().messages(f.job, { messages: [] }, new AbortController().signal),
  ).rejects.toThrow(/uncertain/);
  expect(f.router.paidRequests()).toBe(0);
  expect(await f.make().summary(f.job)).toMatchObject({
    reservedAtomic: '503000',
    uncertain: [expect.any(String)],
  });
});

it('preserves a second queued reservation when the first call settles', async () => {
  const f = await fixture({ cap: '1100000', maxAutoSpendAtomic: 1100000n });
  f.job.capAtomic = '1100000';
  let finishFirst!: () => void;
  f.router.hold = new Promise<void>((resolve) => {
    finishFirst = resolve;
  });
  let firstEntered!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    firstEntered = resolve;
  });
  f.router.onDelayArmed = firstEntered;
  let releaseSecond!: () => void;
  const heldSigner = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  let secondEntered!: () => void;
  const secondReserved = new Promise<void>((resolve) => {
    secondEntered = resolve;
  });
  const getSigner = f.deps.getSigner;
  let signers = 0;
  f.deps.getSigner = async () => {
    if (++signers === 2) {
      secondEntered();
      await heldSigner;
    }
    return getSigner();
  };
  const first = f
    .make()
    .messages(
      f.job,
      { messages: [{ role: 'user', content: 'first' }] },
      new AbortController().signal,
    );
  await firstStarted;
  const channel = watchPaymentLock();
  const second = f
    .make()
    .messages(
      f.job,
      { messages: [{ role: 'user', content: 'second' }] },
      new AbortController().signal,
    );
  try {
    await Promise.race([channel.waiting, second]);
    expect(await f.make().summary(f.job)).toMatchObject({ reservedAtomic: '1003000' });
    finishFirst();
    await expect(first).resolves.toEqual(f.message);
    await secondReserved;
    expect(await f.make().summary(f.job)).toMatchObject({ reservedAtomic: '504000' });
  } finally {
    finishFirst();
    releaseSecond();
    channel.restore();
  }
  await expect(second).resolves.toEqual(f.message);
  expect(await f.make().summary(f.job)).toEqual({
    actualAtomic: '5000',
    reservedAtomic: '5000',
    uncertain: [],
  });
  expect(f.router.paidRequests()).toBe(2);
});

async function reconcileFixture(
  server: Record<string, { state: string; voucherState: string; actualAtomic?: string }>,
) {
  const f = await fixture();
  const job = { ...f.job, decision: { ...f.job.decision, routerOrigin: BASE } };
  const ids = Object.fromEntries(Object.keys(server).map((name) => [name, randomUUID()]));
  const settled = randomUUID();
  const budget = join(f.dir, 'model-jobs', `${job.id}.budget.json`);
  await mkdir(join(f.dir, 'model-jobs'));
  await writeFile(
    budget,
    JSON.stringify({
      charged: String(3000 + 2000 + 500000 * Object.keys(server).length),
      calls: {
        settled: { invocationId: settled, quote: '500000', completed: true, actual: '2000' },
        ...Object.fromEntries(
          Object.entries(ids).map(([name, invocationId]) => [
            name,
            { invocationId, quote: '500000' },
          ]),
        ),
      },
    }),
  );
  const requests: Request[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    const id = new URL(request.url).pathname.split('/').at(-1)!;
    const name = Object.keys(ids).find((key) => ids[key] === id);
    const row = name ? server[name] : undefined;
    return row && row.state !== 'absent'
      ? Response.json({ invocationId: id, actualAtomic: '0', result: null, ...row })
      : Response.json({ error: 'not_found' }, { status: 404 });
  };
  const transport = new ModelTransport({
    dataDir: f.dir,
    baseUrl: BASE,
    payerDeps: { ...f.deps, fetchImpl },
  });
  const read = async () =>
    JSON.parse(await readFile(budget, 'utf8')) as {
      charged: string;
      calls: Record<string, { completed?: boolean; actual?: string }>;
    };
  return { f, job, ids, settled, transport, requests, read };
}

it('settles what an ended run left uncertain from the server record: spent at its cost, released when nothing was charged, kept otherwise', async () => {
  const r = await reconcileFixture({
    finished: { state: 'completed', voucherState: 'accepted', actualAtomic: '1000' },
    failed: { state: 'unknown', voucherState: 'unknown' },
    disconnected: { state: 'running', voucherState: 'cancelled' },
    // Each of these may still cost its full quote, so each keeps its reservation.
    going: { state: 'running', voucherState: 'unknown' },
    failedAfterVoucher: { state: 'unknown', voucherState: 'accepted' },
    overQuote: { state: 'completed', voucherState: 'accepted', actualAtomic: '500001' },
    neverSeen: { state: 'absent', voucherState: '' },
  });
  await r.transport.reconcile(r.job, new AbortController().signal);
  const budget = await r.read();
  expect(budget.calls.finished).toMatchObject({ completed: true, actual: '1000' });
  expect(Object.keys(budget.calls).sort()).toEqual(
    ['failedAfterVoucher', 'finished', 'going', 'neverSeen', 'overQuote', 'settled'].sort(),
  );
  // Routing fee, the settled call, the finished one, and four full quotes still reserved.
  expect(budget.charged).toBe(String(3000 + 2000 + 1000 + 4 * 500000));
  expect((await r.transport.summary(r.job)).uncertain.sort()).toEqual(
    [r.ids.going, r.ids.failedAfterVoucher, r.ids.overQuote, r.ids.neverSeen].sort(),
  );
  // One signed owner read per uncertain call: nothing is bought and no payment is signed.
  expect(r.requests).toHaveLength(7);
  expect(r.requests.every((request) => request.method === 'GET')).toBe(true);
  expect(r.requests.every((request) => request.headers.has(SIWX_HEADER))).toBe(true);
  expect(r.requests.some((request) => request.url.endsWith(r.settled))).toBe(false);
  expect((await lstat(join(r.f.dir, 'model-jobs', `${r.job.id}.budget.json`))).mode & 0o777).toBe(
    0o600,
  );
  // Settled once: a second pass asks only about what is still uncertain and changes nothing.
  await r.transport.reconcile(r.job, new AbortController().signal);
  expect(r.requests).toHaveLength(11);
  expect((await r.read()).charged).toBe(budget.charged);
});

it.each(['revoked', 'other router'] as const)(
  'asks the server nothing about a job whose consent is %s, and keeps every reservation',
  async (kind) => {
    const r = await reconcileFixture({ failed: { state: 'unknown', voucherState: 'unknown' } });
    if (kind === 'revoked')
      await writeFile(join(r.f.dir, 'config.json'), JSON.stringify({ router: {} }));
    const job =
      kind === 'revoked'
        ? r.job
        : { ...r.job, decision: { ...r.job.decision, routerOrigin: 'https://other.example' } };
    await r.transport.reconcile(job, new AbortController().signal);
    expect(r.requests).toHaveLength(0);
    expect((await r.read()).charged).toBe(String(3000 + 2000 + 500000));
  },
);

/** A clock a test drives: a wait records what had been sent when it began, then passes. */
function pacedBy(sentSoFar: () => number, start = 1_000_000) {
  const state = { now: start, waits: [] as { ms: number; sent: number }[] };
  return {
    state,
    paceClock: {
      now: () => state.now,
      wait: async (ms: number) => {
        state.waits.push({ ms, sent: sentSoFar() });
        state.now += ms;
      },
    },
  };
}

// Production allows a wallet 30 signed model calls per 60 s, and a signed call it refuses
// for rate ends the job as uncertain. With lanes shared out, two sessions reach that rate.
it('holds a signed call back until the unadvertised rate has room, counting every transport of the wallet', async () => {
  const f = await fixture({ quote: '2000', charge: '1000', minDeposit: '900000' });
  const signal = new AbortController().signal;
  const paced = pacedBy(() => f.vouchers.length);
  const sentAt: number[] = [];
  const real = f.deps.fetchImpl!;
  f.deps.fetchImpl = async (input, init) => {
    if (signedRequest(input, init)) sentAt.push(paced.state.now);
    return real(input, init);
  };
  // Two processes' worth of transports for one wallet.
  const transports = [0, 1].map(
    () =>
      new ModelTransport({
        dataDir: f.dir,
        baseUrl: BASE,
        payerDeps: f.deps,
        paceClock: paced.paceClock,
      }),
  );
  const timings: Record<string, unknown>[] = [];
  for (let n = 0; n < 34; n++)
    await transports[n % 2]!.messages(f.job, say(`Call ${n}`), signal, undefined, (timing) =>
      timings.push({ ...timing }),
    );
  // The 30th call waited, signed and unsent, and nothing left during its wait.
  expect(paced.state.waits[0]).toMatchObject({ sent: 29 });
  expect(timings.slice(0, 29).every((timing) => timing.paceWaitMs === undefined)).toBe(true);
  expect(timings[29]!.paceWaitMs).toBeGreaterThan(50_000);
  expect(f.vouchers.map((voucher) => voucher.status)).toEqual(Array(34).fill(200));
  // The router's own estimate (the current window plus a share of the one before) would
  // have let every send through, wherever its windows start against this clock.
  for (const [index, at] of sentAt.entries())
    for (let offset = 0; offset < 60_000; offset += 1_000) {
      const window = (time: number) => Math.floor((time + offset) / 60_000);
      const before = sentAt.slice(0, index);
      const current = before.filter((time) => window(time) === window(at)).length;
      const previous = before.filter((time) => window(time) === window(at) - 1).length;
      const share = ((at + offset) % 60_000) / 60_000;
      expect(Math.floor((1 - share) * previous) + current).toBeLessThan(30);
    }
});

it('waits before the unpaid quote at the rate an offer advertises, and never between signature and send', async () => {
  const f = await fixture({ quote: '2000', charge: '1000', minDeposit: '900000' });
  const job: ModelJob = {
    ...f.job,
    decision: { ...f.job.decision, callLimit: { max: 6, windowSeconds: 60 } },
  };
  const unpaid = () => f.router.log.filter((line) => line.endsWith(' unpaid')).length;
  const paced = pacedBy(() => unpaid() * 100 + f.vouchers.length);
  const transport = new ModelTransport({
    dataDir: f.dir,
    baseUrl: BASE,
    payerDeps: f.deps,
    paceClock: paced.paceClock,
  });
  const timings: Record<string, unknown>[] = [];
  for (let n = 0; n < 7; n++)
    await transport.messages(
      job,
      say(`Call ${n}`),
      new AbortController().signal,
      undefined,
      (timing) => timings.push({ ...timing }),
    );
  // Five calls fit. The sixth waited with five quotes asked and five calls signed: its
  // own quote had not been asked. No wait began with a quote asked and its call unsigned.
  expect(paced.state.waits[0]).toMatchObject({ sent: 505 });
  expect(paced.state.waits.every((wait) => Math.floor(wait.sent / 100) === wait.sent % 100)).toBe(
    true,
  );
  expect(timings[5]!.paceWaitMs).toBeGreaterThan(0);
  expect(f.vouchers.map((voucher) => voucher.status)).toEqual(Array(7).fill(200));
});

it("counts a signed routing request in the unadvertised rate's window", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'model-route-pace-'));
  made.push(dir);
  const router = new FakeRouter({ path: '/api/model-router/route' });
  const signal = new AbortController().signal;
  // One clock for the transport's count and the count the test reads.
  const paced = pacedBy(() => router.paidRequests());
  const transport = new ModelTransport({
    dataDir: dir,
    baseUrl: BASE,
    payerDeps: payerDeps(router, dir, privateKeyToAccount(generatePrivateKey())),
    paceClock: paced.paceClock,
  });
  const pace = () =>
    new ModelPace(dir, BASE, paced.paceClock).take(
      'paid',
      ['paid', 'route'],
      { max: 3, windowMs: 60_000 },
      signal,
    );
  expect(await pace()).toBe(0);
  await transport.route({ schemaVersion: 1 }, signal);
  expect(router.paidRequests()).toBe(1);
  // One model call and the routing request: the window of three has no room for a third.
  expect(await pace()).toBeGreaterThan(0);
});

it('keeps a signed call the router refuses for rate as uncertain, and never tries or signs it again', async () => {
  const f = await fixture();
  const real = f.deps.fetchImpl!;
  let signed = 0;
  f.deps.fetchImpl = async (input, init) => {
    if (!signedRequest(input, init)) return real(input, init);
    signed++;
    return Response.json(
      { error: { code: 'rate_limited', message: 'too many requests' } },
      { status: 429, headers: { 'retry-after': '7' } },
    );
  };
  f.setRecoveryState('unknown');
  f.setVoucher('none');
  const signal = new AbortController().signal;
  const error = await f
    .make()
    .messages(f.job, say('Refused after signing'), signal)
    .then(
      () => undefined,
      (failure: unknown) => failure as ModelCallFailed,
    );
  expect(error?.message).toMatch(/uncertain/);
  expect(error?.detail).toEqual({ cause: 'failed', status: 429 });
  // Not a call the retry rule takes: nothing says it cost nothing.
  expect(retryableModelCall(error)).toBe(false);
  expect(signed).toBe(1);
  await expect(f.make().messages(f.job, say('Refused after signing'), signal)).rejects.toThrow(
    'no new authorization sent',
  );
  expect(signed).toBe(1);
  expect((await f.make().summary(f.job)).uncertain).toHaveLength(1);
});

// A router that counts a call at its quote keeps that quote's place for 120 s. A call that
// waits longer for its channel would be counted again after its signature.
it.each(['advertised', 'unadvertised', 'changed'] as const)(
  'asks for the quote again before signing when a call waited past 100 s for its channel (%s rate)',
  async (rate) => {
    const f = await fixture({ quote: '120000', refundCapability: 'enabled' });
    const job: ModelJob =
      rate === 'unadvertised'
        ? f.job
        : { ...f.job, decision: { ...f.job.decision, callLimit: { max: 120, windowSeconds: 60 } } };
    const paced = pacedBy(() => f.vouchers.length);
    const asked: unknown[] = [];
    const real = f.deps.fetchImpl!;
    f.deps.fetchImpl = async (input, init) => {
      const request = new Request(input, init);
      if (request.method === 'POST')
        asked.push([
          ((await request.clone().json()) as { invocationId: string }).invocationId,
          request.headers.has('payment-signature') ? 'paid' : 'quote',
        ]);
      return real(request);
    };
    const signal = new AbortController().signal;
    const held = deferred();
    const entered = deferred();
    f.router.hold = held.promise;
    f.router.onDelayArmed = entered.resolve;
    const timings: Record<string, unknown>[] = [];
    const failure = (error: unknown) => error as ModelCallFailed;
    const outcome = await new ModelTransport({
      dataDir: f.dir,
      baseUrl: BASE,
      payerDeps: f.deps,
      paceClock: paced.paceClock,
    }).withInferenceRun(job.id, signal, async (worker) => {
      // Two calls of one run: the second waits for the run's channel behind the first.
      const first = worker.messages(job, say('A long call'), signal);
      await entered.promise;
      f.router.hold = null;
      const channel = watchPaymentLock();
      const second = worker
        .messages(job, say('Waits for the channel'), signal, undefined, (timing) =>
          timings.push({ ...timing }),
        )
        .catch(failure);
      await channel.waiting;
      channel.restore();
      // It has its quote. The first call then runs on for 101 s.
      paced.state.now += 101_000;
      if (rate === 'changed') f.router.requirement.amount = '130000';
      held.resolve();
      return [await first, await second] as const;
    });
    const [one, two] = [asked[0], asked[2]].map((entry) => (entry as string[])[0]);
    expect(two).not.toBe(one);
    expect(outcome[0]).toEqual(f.message);
    if (rate === 'advertised') {
      // The same invocation is quoted again, then signed once.
      expect(asked).toEqual([
        [one, 'quote'],
        [one, 'paid'],
        [two, 'quote'],
        [two, 'quote'],
        [two, 'paid'],
      ]);
      expect(outcome[1]).toEqual(f.message);
      expect(timings[0]!.requoteMs).toBeGreaterThanOrEqual(0);
    } else if (rate === 'unadvertised') {
      // That router counts after the signature: an older quote is no different to it.
      expect(asked).toHaveLength(4);
      expect(outcome[1]).toEqual(f.message);
      expect(timings[0]).not.toHaveProperty('requoteMs');
    } else {
      // The fresh quote names another amount than the one reserved: nothing is signed,
      // the reservation is released, and the retry rule may take the call up again.
      expect(asked.filter((entry) => (entry as string[])[1] === 'paid')).toHaveLength(1);
      expect(failure(outcome[1]).detail).toEqual({ cause: 'failed', uncharged: true });
      expect(retryableModelCall(outcome[1])).toBe(true);
      expect(await f.make().summary(job)).toEqual({
        actualAtomic: '4000',
        reservedAtomic: '4000',
        uncertain: [],
      });
    }
  },
);
