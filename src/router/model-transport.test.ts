import { spawnSync } from 'node:child_process';
import { lstat, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodePaymentSignatureHeader } from '@x402/core/http';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, expect, it, vi } from 'vitest';
import * as locks from '../lib/lock';
import { SIWX_HEADER } from '../lib/siwx';
import { readSpendSummary } from '../lib/spend-ledger';
import { FakeRouter, payerDeps, BASE, TEST_POLICY, testSigner } from './fee-test-utils';
import { modelInferenceRunScope } from './model-channel';
import { ModelRefundJournal, modelRefundRunLock, readModelRefundResult } from './model-refund';
import { ModelTransport } from './model-transport';
import { modelPeakQuoteAtomic } from './model-limits';
import { workerSearchMessages } from './model-messages';
import { ModelCallFailed, retryableModelCall } from './model-worker-control';
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
  const withFileLock = locks.withFileLock;
  const spy = vi.spyOn(locks, 'withFileLock').mockImplementation((path, run, opts) => {
    if (path.endsWith('.payment.lock')) waiting.resolve();
    return withFileLock(path, run, opts);
  });
  return { waiting: waiting.promise, restore: () => spy.mockRestore() };
}

async function fixture(
  options: {
    drop?: boolean;
    cap?: string;
    quote?: string;
    /** The quote the fake router names for a request, in place of the fixed one. */
    quoteFor?: (request: Record<string, unknown>) => bigint;
    charge?: string;
    minDeposit?: string;
    maxAutoSpendAtomic?: bigint;
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
    decision: {
      jobId: randomUUID(),
      routingFeeAtomic: '3000',
      routingAuthorizedAtomic: '3000',
      maxResultBytes: 4_000_000,
      maxOutputTokens: 256_000,
      maxCallDurationMs: 540_000,
      callIdleLimitMs: 300_000,
      callLimit: { max: 120, windowSeconds: 60 },
    },
    capAtomic: '1000000',
    state: 'running',
    expiresAt: Date.now() + 60_000,
  };
  const router = new FakeRouter({
    path: '/api/model-proxy/messages',
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
    if (options.quoteFor) router.requirement.amount = options.quoteFor(last).toString();
    result = {
      message,
      receipt: {
        invocationId: last.invocationId,
        quoteAtomic: options.quoteFor ? router.requirement.amount : (options.quote ?? '500000'),
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
      // The fixture's own run channel: every model call runs inside one in production.
      inferenceRun: 'test-run',
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
  const f = await fixture();
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
it("holds a job's reserved total against a cap lowered while a call waited for its channel, and releases that call unpaid", async () => {
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
  // Lowered when the call, its quote already reserved, takes its turn at the channel.
  const withFileLock = locks.withFileLock;
  const lane = vi.spyOn(locks, 'withFileLock').mockImplementation(async (path, run, opts) => {
    if (path.endsWith('.payment.lock')) {
      expect(BigInt(JSON.parse(await readFile(budget, 'utf8')).charged)).toBe(spent + 300000n);
      await lower();
    }
    return withFileLock(path, run, opts);
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

it('sends a web search as one Messages call with the server tool, inside the same quote and settlement', async () => {
  const f = await fixture();
  const body = workerSearchMessages({ query: 'x402 receipts', maxUses: 5, refused: null });
  await expect(f.make().messages(f.job, body, new AbortController().signal)).resolves.toEqual(
    f.message,
  );
  // One unpaid quote, one signed request, and the answer the router's message carries.
  expect(f.last()).toMatchObject({ messages: body });
  expect(f.router.paidRequests()).toBe(1);
  // The call is reserved at its quote and settled at what it charged, beside the fee.
  expect(await f.make().summary(f.job)).toEqual({
    reservedAtomic: '4000',
    actualAtomic: '4000',
    uncertain: [],
  });
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
    'gateMs',
    'signMs',
    'answerMs',
    'bodyMs',
    'drainMs',
    'settleMs',
  ];
  expect(Object.keys(seen[0]!)).toEqual(expect.arrayContaining(['requestBytes', ...steps]));
  for (const name of steps) expect(seen[0]![name]).toBeGreaterThanOrEqual(0);
  expect(f.router.paidRequests()).toBe(1);
  // The kept result answers the same request again: no quote, no payment.
  await f
    .make()
    .messages(f.job, request, new AbortController().signal, undefined, (timing) =>
      seen.push({ ...timing }),
    );
  expect(f.router.paidRequests()).toBe(1);
  expect(Object.keys(seen[1]!).sort()).toEqual(['budgetMs']);
});

it('refills a worker channel in $0.25 deposits as inference consumes its credit', async () => {
  const f = await fixture({ quote: '120000', charge: '100000' });
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

const say = (content: string) => ({ messages: [{ role: 'user', content }] });
const jobLike = (job: ModelJob): ModelJob => ({
  ...job,
  id: randomUUID(),
  decision: { ...job.decision, jobId: randomUUID() },
});

it("runs two runs' calls at once on a router that refunds, each under its own channel's lock", async ({
  onTestFinished,
}) => {
  const f = await fixture({ quote: '120000' });
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
  // Each run pays on its own channel, under that channel's lock.
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
  // What a killed process leaves: the run channel's lock, held by a pid that is gone.
  const gone = spawnSync(process.execPath, ['-e', '']).pid;
  const lock = join(
    f.dir,
    'model-jobs',
    `${modelInferenceRunScope(BASE, 'test-run').id}.payment.lock`,
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
  // Its next call takes over the dead lock on the run's channel and claims the total the
  // lost voucher claimed. The router never saw that one, so the total is charged once.
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

it('shares one live identical request instead of recovering an invocation still in flight', async () => {
  const f = await fixture();
  const transport = f.make();
  const held = deferred();
  const entered = deferred();
  f.router.hold = held.promise;
  f.router.onDelayArmed = entered.resolve;
  const body = { model: 'deepseek-flash', messages: [{ role: 'user', content: 'same task' }] };
  const invoke = () => transport.messages(f.job, body, new AbortController().signal);
  const first = invoke();
  await entered.promise;
  const second = invoke();
  const pending = Promise.all([first, second]);
  held.resolve();
  const results = await pending;
  expect(results).toEqual([f.message, f.message]);
  const [firstResult, secondResult] = results as [typeof f.message, typeof f.message];
  expect(firstResult).not.toBe(secondResult);
  firstResult.content[0]!.text = 'Only this caller changed its result';
  expect(secondResult).toEqual(f.message);
  await expect(transport.messages(f.job, body, new AbortController().signal)).resolves.toEqual(
    f.message,
  );
  expect(f.router.paidRequests()).toBe(1);
  expect(f.router.settledFees).toBe(1);
  expect(f.gets()).toBe(0);
  expect(await transport.summary(f.job)).toEqual({
    actualAtomic: '4000',
    reservedAtomic: '4000',
    uncertain: [],
  });
});

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

it('waits past the former 180-second paid deadline and settles once', async () => {
  const f = await fixture();
  const transport = f.make();
  const request = { model: 'deepseek-flash', messages: [{ role: 'user', content: 'first' }] };
  const invoke = (body: Record<string, unknown>) =>
    transport.messages(f.job, body, new AbortController().signal);
  await invoke(request); // Establish warm credit before the slow inference.
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.router.delayMs = 200_000;
  f.router.onDelayArmed = entered;
  vi.useFakeTimers();
  const pending = expect(invoke({ ...request, max_tokens: 200 })).resolves.toEqual(f.message);
  await started;
  await vi.advanceTimersByTimeAsync(200_000);
  await pending;
  expect(f.router.paidRequests()).toBe(2);
  expect((await transport.summary(f.job)).uncertain).toEqual([]);
});

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

// tenjin#1153 review: its server settled a reply through 4,000,000 bytes while this parser
// refused one above 2,000,000 on the paid reply and on recovery, after the charge. That
// server now settles only up to the size a call states, and refuses a larger reply unpaid.
it('states the result size its offer names, up to what this CLI reads, and reads that much', async () => {
  const request = { model: 'deepseek-flash', messages: [{ role: 'user', content: 'long' }] };
  const signal = new AbortController().signal;
  // The offer names 8,000,000: stated, up to what this CLI reads, and read that far.
  const f = await fixture({ drop: true });
  f.job.decision.maxResultBytes = 8_000_000;
  f.message.content[0]!.text = 'x'.repeat(2_100_000);
  await expect(f.make().messages(f.job, request, signal)).rejects.toThrow(/uncertain/);
  expect(f.last()).toMatchObject({ maxResultBytes: 4_000_000, messages: request });
  // The same reply is read on receipt recovery, and on a paid reply that arrives.
  expect(await f.make().messages(f.job, request, signal)).toEqual(f.message);
  expect(f.router.paidRequests()).toBe(1);
  const paid = await fixture();
  paid.message.content[0]!.text = 'x'.repeat(2_100_000);
  expect(await paid.make().messages(paid.job, request, signal)).toEqual(paid.message);
  // A size below the router's own floor is an invalid offer: the call fails closed.
  const odd = await fixture();
  odd.job.decision.maxResultBytes = 1_000;
  await expect(odd.make().messages(odd.job, request, signal)).rejects.toThrow(
    /names no result size/,
  );
  expect(odd.last()).toBeUndefined();
});

// The router serves one call up to 540 s, so the client's wait for the paid answer, 360 s
// before, ended a call the router was still serving.
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
  const paidWait = timeouts.filter((ms) => ms > 300_000 && ms <= 600_000);
  expect(paidWait.length).toBeGreaterThan(0);
  expect(Math.max(...paidWait)).toBeGreaterThan(540_000);
});

// The offer names the router's own deadline for one call: the client waits that long plus
// the constant's minute, a bigger or a smaller figure alike.
it.each([
  ['present', 540_000, 600_000],
  ['larger', 900_000, 960_000],
  ['smaller', 300_000, 360_000],
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
  // The payer's timer is its deadline minus the clock read after it was set, so it can lose a
  // millisecond or more under load (359999 for 360000): the offer's own deadline, never above it.
  expect(timeouts.some((ms) => ms <= expected && ms > expected - 5_000)).toBe(true);
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
it('asks for the largest output cap the rest of the job ceiling can reserve, never below 8,192, and says which', async () => {
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
  // Less than 65,536 reserves: the call asks for what fits and the job goes on.
  const small = await sent('80000', '50000');
  expect(small.asked).toBeLessThan(65_536);
  expect(small.asked).toBeGreaterThanOrEqual(8_192);
  expect(modelPeakQuoteAtomic(small.bytes, small.asked)).toBeLessThanOrEqual(77_000n);
});

// The client's estimate of a quote is a first guess: the router's quote is the truth. A job near
// its cap whose router counts a body byte as a whole input token, while the client guesses one
// token for 3 bytes, used to be stopped for budget in place of asking for less output.
const byteQuote = (bytes: number, out: number, bytesPerToken: number) => {
  const tokens = Math.min(1_048_576, Math.ceil(bytes / bytesPerToken) + 4096);
  const usage = (BigInt(tokens) * 300n + BigInt(out) * 1200n + 999n) / 1000n;
  return usage + (usage * 5n + 99n) / 100n;
};
const bigRequest = {
  model: 'deepseek-flash',
  max_tokens: 256_000,
  messages: [{ role: 'user', content: 'x'.repeat(130 * 1024) }],
};
const ruledFixture = (bytesPerToken: number) =>
  fixture({
    cap: '200000',
    quoteFor: (sent) =>
      byteQuote(
        Buffer.byteLength(JSON.stringify(sent)),
        (sent.messages as { max_tokens: number }).max_tokens,
        bytesPerToken,
      ),
  });

it("asks again with less output when the router's quote is above what the job has left, and reserves once", async () => {
  const f = await ruledFixture(1);
  const seen: { outputCap?: number }[] = [];
  await f
    .make()
    .messages(f.job, bigRequest, new AbortController().signal, undefined, (t) => seen.push(t));
  const sent = (f.last()?.messages as { max_tokens: number }).max_tokens;
  expect(sent).toBeLessThan(256_000);
  expect(sent).toBeGreaterThanOrEqual(8_192);
  expect(seen).toMatchObject([{ outputCap: sent }]);
  // More than one unpaid quote, one signed request, and a single reservation at the last quote.
  expect(f.router.log.filter((line) => line.endsWith('unpaid')).length).toBeGreaterThan(1);
  expect(f.router.log.filter((line) => line.endsWith(' paid')).length).toBe(1);
  // The routing fee and the one call at its real charge: the earlier quotes reserved nothing.
  expect((await f.make().summary(f.job)).reservedAtomic).toBe('4000');
});

it('sends no second quote request once the sharing consent changed after the first', async () => {
  const f = await ruledFixture(1);
  let sends = 0;
  const failure = await f
    .make()
    .messages(f.job, bigRequest, new AbortController().signal, async () => {
      if (++sends > 1) throw new Error('Sharing consent changed');
    })
    .catch((error: unknown) => error as Error);
  expect(failure.message).toBe('Sharing consent changed');
  // The first quote was asked; the one for a lower limit never left, and nothing was reserved.
  expect(f.router.log.filter((line) => line.endsWith('unpaid')).length).toBe(1);
  expect(f.router.log.filter((line) => line.endsWith(' paid')).length).toBe(0);
  expect((await f.make().summary(f.job)).reservedAtomic).toBe('3000');
});

it("sends the client's own guess at once when the router counts fewer bytes than the client does", async () => {
  const f = await ruledFixture(3);
  await f.make().messages(f.job, bigRequest, new AbortController().signal);
  expect(f.router.log.filter((line) => line.endsWith('unpaid')).length).toBe(1);
  expect(f.router.log.filter((line) => line.endsWith(' paid')).length).toBe(1);
});

it("ends a job for budget only when the router's quote at the output floor does not fit", async () => {
  const f = await fixture({ cap: '200000', quote: '500000' });
  await expect(
    f.make().messages(f.job, bigRequest, new AbortController().signal),
  ).rejects.toMatchObject({ detail: { cause: 'budget' } });
  expect((f.last()?.messages as { max_tokens: number }).max_tokens).toBe(8_192);
  expect(f.router.log.filter((line) => line.endsWith(' paid')).length).toBe(0);
  // Only the routing fee is held: the refused call reserved nothing.
  expect((await f.make().summary(f.job)).reservedAtomic).toBe('3000');
});

it('rejects a Messages result above the size the call states even when the receipt envelope fits', async () => {
  const f = await fixture();
  f.message.content[0]!.text = 'x'.repeat(4_100_000);
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

it('sends known secret shapes in system text, messages and tool outputs as written, with tool schemas intact', async () => {
  const f = await fixture();
  const secret = 'sk-proj-abc123DEF456ghi789JKL012_mno';
  const request = {
    model: 'deepseek-flash',
    system: `base ${secret}`,
    messages: [
      { role: 'user', content: [{ type: 'text', text: `context ${secret}` }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: secret, name: 'read', input: {} }] },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: secret, content: `tool ${secret}` }],
      },
    ],
    tools: [
      {
        name: 'read',
        input_schema: {
          type: 'object',
          properties: { id: { type: 'string', pattern: '^sk-proj-abc123$' } },
        },
      },
    ],
  };
  await f.make().messages(f.job, request, new AbortController().signal);
  expect(f.last()!.messages).toEqual(request);
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

it('refuses a job that records no routing authorization, and signs nothing', async () => {
  const f = await fixture({ cap: '1000000' });
  delete f.job.decision.routingAuthorizedAtomic;
  await expect(f.make().summary(f.job)).rejects.toThrow(/no routing authorization/);
  expect(f.router.paidRequests()).toBe(0);
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
    // The second call has its quote reserved while the first holds the run's channel.
    expect(await f.make().summary(f.job)).toMatchObject({ reservedAtomic: '1003000' });
    finishFirst();
    await expect(first).resolves.toEqual(f.message);
  } finally {
    finishFirst();
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

// Failure caught (live run on the new server): a run cancelled with a call in flight closed its
// channel at once, was left pending, and was tried again only by a recovery pass; the reconcile
// that settled the call never tried it, so the unused deposit stayed in the channel.
it('tries the refund of a run again when its reconcile settles the last uncertain call, and not while one is left', async () => {
  const closed: string[] = [];
  const spy = vi
    .spyOn(ModelRefundJournal.prototype, 'close')
    .mockImplementation(async (runId: string) => {
      closed.push(runId);
      return { state: 'pending' };
    });
  try {
    const settled = await reconcileFixture({
      finished: { state: 'completed', voucherState: 'accepted', actualAtomic: '1000' },
    });
    await settled.transport.reconcile(settled.job, new AbortController().signal);
    expect((await settled.transport.summary(settled.job)).uncertain).toEqual([]);
    expect(closed).toEqual([settled.job.id]);
    closed.length = 0;
    const open = await reconcileFixture({
      finished: { state: 'completed', voucherState: 'accepted', actualAtomic: '1000' },
      going: { state: 'running', voucherState: 'unknown' },
    });
    await open.transport.reconcile(open.job, new AbortController().signal);
    expect((await open.transport.summary(open.job)).uncertain).toHaveLength(1);
    expect(closed).toEqual([]);
  } finally {
    spy.mockRestore();
  }
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
    inferenceRun: 'paced-run',
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
it.each(['advertised', 'changed'] as const)(
  'asks for the quote again before signing when a call waited past 100 s for its channel (%s rate)',
  async (rate) => {
    const f = await fixture({ quote: '120000' });
    const job: ModelJob = {
      ...f.job,
      decision: { ...f.job.decision, callLimit: { max: 120, windowSeconds: 60 } },
    };
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
