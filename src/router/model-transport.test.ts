import { lstat, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, expect, it, vi } from 'vitest';
import * as locks from '../lib/lock';
import { SIWX_HEADER } from '../lib/siwx';
import { readSpendSummary } from '../lib/spend-ledger';
import { FakeRouter, payerDeps, BASE, TEST_POLICY, testSigner } from './fee-test-utils';
import { ModelRefundJournal, modelRefundRunLock, readModelRefundResult } from './model-refund';
import { ModelTransport } from './model-transport';
import { ModelCallFailed } from './model-worker-control';
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
    decision: { jobId: randomUUID(), routingFeeAtomic: '3000' },
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
  const paidSignals: AbortSignal[] = [];
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
      return Response.json({
        invocationId: last?.invocationId,
        state: recoveryState,
        voucherState,
        actualAtomic: options.charge ?? '1000',
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
    const response = await router.fetch(request);
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
    setRecoveryState: (value: string) => {
      recoveryState = value;
    },
    setVoucher: (value: string) => {
      voucherState = value;
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

it('funds a Messages quote from saved job consent while preserving an explicit smaller tool limit', async () => {
  const f = await fixture({ maxAutoSpendAtomic: 250000n, minDeposit: '500000' });
  await expect(
    f.make().messages(f.job, { messages: [] }, new AbortController().signal),
  ).resolves.toEqual(f.message);
  expect(f.router.deposits).toBe(1);
  expect(f.router.paidRequests()).toBe(1);
  expect((await f.deps.policy()).maxAutoSpendAtomic).toBe(250000n);
});

it('can consume close to the job ceiling when Messages quotes follow the requested output', async () => {
  const f = await fixture({ quote: '60000', charge: '40000', maxAutoSpendAtomic: 250000n });
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
    const f = await fixture({ maxAutoSpendAtomic: 250000n, minDeposit: '500000' });
    f.deps.policy = async () => ({
      ...TEST_POLICY,
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

it.each(['settles', 'cancels'] as const)(
  '%s a second inference job queued on the same funded channel',
  async (outcome) => {
    const f = await fixture({ quote: '120000' });
    const firstTransport = f.make();
    const otherTransport = f.make();
    const signal = new AbortController().signal;
    const message = (content: string) => ({ messages: [{ role: 'user', content }] });
    await firstTransport.messages(f.job, message('Fund the inference channel'), signal);

    const held = deferred();
    const entered = deferred();
    f.router.hold = held.promise;
    f.router.onDelayArmed = entered.resolve;
    const first = firstTransport.messages(f.job, message('First held call'), signal);
    await entered.promise;

    const channel = watchPaymentLock();
    const secondJob = {
      ...f.job,
      id: randomUUID(),
      decision: { ...f.job.decision, jobId: randomUUID() },
    };
    const abort = new AbortController();
    const second = otherTransport.messages(secondJob, message('Second held call'), abort.signal);
    const pending = Promise.allSettled([first, second]);
    const reason = new Error('Second worker stopped');
    try {
      await Promise.race([channel.waiting, second]);
      // The first paid call still holds the channel. The second has only a local quote.
      expect(f.router.paidRequests()).toBe(2);
      expect(await otherTransport.summary(secondJob)).toMatchObject({ reservedAtomic: '123000' });
      if (outcome === 'cancels') {
        abort.abort(reason);
        await expect(second).rejects.toBe(reason);
        expect(await otherTransport.summary(secondJob)).toMatchObject({
          reservedAtomic: '3000',
          uncertain: [],
        });
      }
    } finally {
      held.resolve();
      channel.restore();
    }
    const [completed, waiting] = await pending;
    expect(completed).toEqual({ status: 'fulfilled', value: f.message });
    if (outcome === 'settles') {
      expect(waiting).toEqual({ status: 'fulfilled', value: f.message });
      expect(await otherTransport.summary(secondJob)).toMatchObject({
        reservedAtomic: '4000',
        uncertain: [],
      });
    } else expect(waiting).toEqual({ status: 'rejected', reason });
    expect(f.router.paidRequests()).toBe(outcome === 'settles' ? 3 : 2);
    expect(f.router.channels.size).toBe(1);
    expect(f.router.deposits).toBe(1);
  },
);

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

it('masks known secrets in native instructions/text/tool outputs while preserving opaque pairings and schemas', async () => {
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
  expect(sent.instructions).not.toContain(secret);
  expect((sent.input[0]!.content![0] as { text: string }).text).not.toContain(secret);
  expect(sent.input[2]!.output).not.toContain(secret);
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
  expect(paid?.detail).toEqual({ cause: 'failed', payer: 'payment_failed', status: 500 });
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
it('releases at once a call the provider failed when the router record says it cost nothing', async () => {
  const f = await fixture();
  const real = f.deps.fetchImpl!;
  f.setRecoveryState('unknown');
  f.setVoucher('cancelled');
  f.deps.fetchImpl = async (input, init) =>
    new Request(input, init).headers.has('payment-signature')
      ? Response.json(
          { error: { code: 'model_inference_failed', message: 'Model invocation failed' } },
          { status: 500 },
        )
      : real(input, init);
  const failed = await f
    .make()
    .messages(f.job, { messages: [] }, new AbortController().signal)
    .catch((error: unknown) => error as ModelCallFailed);
  expect(failed).toBeInstanceOf(ModelCallFailed);
  expect(failed?.detail).toEqual({ cause: 'provider', status: 500, uncharged: true });
  // One free read of the router's record, nothing bought again, and the quote released.
  expect(f.signedGets()).toBe(1);
  expect(await f.make().summary(f.job)).toMatchObject({ reservedAtomic: '3000', uncertain: [] });
});

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
  const f = await fixture({ cap: '1100000' });
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
