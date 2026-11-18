import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ModelCallFailed,
  modelCallStop,
  ModelWorkerStopped,
  timedOut,
  withWorkerDeadline,
  WorkerRepeatReminder,
  withModelRetry,
  WORKER_ENDS,
  workerEnd,
  workerResultError,
  workerStop,
} from './model-worker-control';

afterEach(() => vi.useRealTimers());

it('warns softly at three, five and eight identical calls, independent of argument key order', () => {
  const repeats = new WorkerRepeatReminder();
  const warned: number[] = [];
  for (let call = 1; call <= 10; call++) {
    const reminder = repeats.observe(
      'Read',
      call % 2 ? { path: 'a', offset: 1 } : { offset: 1, path: 'a' },
    );
    if (reminder) {
      warned.push(call);
      expect(reminder).toContain('permission denials');
      expect(reminder).not.toContain('path');
    }
  }
  expect(warned).toEqual([3, 5, 8]);
  expect(repeats.observe('Read', { path: 'b', offset: 1 })).toBeUndefined();
  expect(repeats.observe('Read', { path: 'a', offset: 1 })).toBeUndefined();
  expect(repeats.observe('Write', { path: 'a', offset: 1 })).toBeUndefined();
});

// As in the DeepSeek harness: a to-do list update neither counts nor breaks a streak.
it('lets a to-do list update between repeats neither count nor reset them', () => {
  const repeats = new WorkerRepeatReminder();
  repeats.observe('Bash', { command: 'pnpm test' });
  repeats.observe('TodoWrite', { todos: [] });
  repeats.observe('Bash', { command: 'pnpm test' });
  expect(repeats.observe('TodoWrite', { todos: [] })).toBeUndefined();
  expect(repeats.observe('Bash', { command: 'pnpm test' })).toContain('repeated 3 times');
});

it('does not fail execution or keep a repeat streak for an unhashable input', () => {
  const repeats = new WorkerRepeatReminder();
  const cycle: unknown[] = [];
  cycle.push(cycle);
  repeats.observe('Read', { path: 'a' });
  repeats.observe('Read', { path: 'a' });
  expect(repeats.observe('Read', cycle)).toBeUndefined();
  expect(repeats.observe('Read', { path: 'a' })).toBeUndefined();
});

it('waits for the owned runner to drain after the forty-minute wall guard', async () => {
  vi.useFakeTimers();
  const parent = new AbortController();
  let observed: AbortSignal | undefined;
  let drained!: () => void;
  const cleanup = new Promise<void>((resolve) => {
    drained = resolve;
  });
  const run = withWorkerDeadline(parent.signal, async (signal) => {
    observed = signal;
    await new Promise<void>((resolve) =>
      signal.addEventListener('abort', () => resolve(), { once: true }),
    );
    await cleanup;
    throw new Error('native runner interrupted');
  });
  let settled = false;
  const outcome = run.then(
    () => {
      settled = true;
      return undefined;
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  await vi.advanceTimersByTimeAsync(39 * 60 * 1000);
  expect(observed?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(60 * 1000);
  expect(observed?.aborted).toBe(true);
  expect(parent.signal.aborted).toBe(false);
  expect(settled).toBe(false);
  drained();
  expect(workerStop(await outcome)).toEqual({ kind: 'harness_limit', reason: 'wall_time' });
  expect(vi.getTimerCount()).toBe(0);
});

it('reports a worker the wall guard found still starting as not started, never as a wall stop', async () => {
  vi.useFakeTimers();
  const run = withWorkerDeadline(new AbortController().signal, async (signal) => {
    await new Promise<void>((resolve) =>
      signal.addEventListener('abort', () => resolve(), { once: true }),
    );
    throw new ModelWorkerStopped({ kind: 'not_started', reason: 'startup_timeout' });
  });
  const outcome = run.catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(40 * 60 * 1000);
  expect(workerStop(await outcome)).toEqual({ kind: 'not_started', reason: 'startup_timeout' });
});

it('preserves caller interruption, drains it and clears its wall timer', async () => {
  vi.useFakeTimers();
  const parent = new AbortController();
  const interrupted = new Error('owned interrupt');
  const run = withWorkerDeadline(parent.signal, async (signal) => {
    await new Promise<void>((resolve) =>
      signal.addEventListener('abort', () => resolve(), { once: true }),
    );
    throw signal.reason;
  });
  const outcome = run.catch((error: unknown) => error);
  parent.abort(interrupted);
  expect(await outcome).toBe(interrupted);
  expect(workerStop(interrupted)).toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
});

it('clears the wall timer after a completed run', async () => {
  vi.useFakeTimers();
  expect(await withWorkerDeadline(new AbortController().signal, async () => 'done')).toBe('done');
  expect(vi.getTimerCount()).toBe(0);
});

it.each([
  ['error_max_turns', 'harness_limit', 'turn_guard'],
  ['error_max_budget_usd', 'harness_limit', 'budget_guard'],
  ['error_max_structured_output_retries', 'harness_limit', 'structured_output_guard'],
  ['error_during_execution', 'execution_failure', 'worker_execution'],
])('retains a bounded %s diagnostic without copying raw SDK errors', (subtype, kind, reason) => {
  const result = { subtype, num_turns: 500, errors: ['secret-key=must-not-leave-worker'] };
  const error = workerResultError(result);
  expect(error).toBeInstanceOf(ModelWorkerStopped);
  expect(workerStop(error)).toEqual({ kind, reason, turns: 500 });
  expect(JSON.stringify(error)).not.toContain('secret-key');
});

it('reports known provider output/context limits and omits invalid turn counts', () => {
  expect(
    workerStop(
      workerResultError({
        subtype: 'error_during_execution',
        stop_reason: 'max_tokens',
        num_turns: NaN,
      }),
    ),
  ).toEqual({ kind: 'provider_limit', reason: 'output_limit' });
  expect(
    workerStop(
      workerResultError({
        subtype: 'error_during_execution',
        stop_reason: 'prompt_too_long',
        num_turns: -1,
      }),
    ),
  ).toEqual({ kind: 'provider_limit', reason: 'context_limit' });
  expect(workerStop(new Error('secret-key=private'))).toBeUndefined();
});

it.each([
  ['wall_time', 'time_limit'],
  ['turn_guard', 'turn_limit'],
  ['budget_guard', 'budget'],
  ['output_limit', 'output_limit'],
  ['context_limit', 'context_limit'],
  ['env_file_unscanned', 'env_file_unscanned'],
  ['startup_timeout', 'not_started'],
  ['model_call_failed', 'model_call_failed'],
  ['model_call_timeout', 'model_call_timeout'],
  ['payment_refused', 'payment_refused'],
  ['provider_failed', 'provider'],
  ['structured_output_guard', 'worker_error'],
  ['worker_execution', 'worker_error'],
] as const)('names a %s stop as %s, with words for the parent', (reason, end) => {
  expect(workerEnd({ kind: 'harness_limit', reason })).toBe(end);
  expect(WORKER_ENDS[end]).toMatch(/^[A-Z].*\.$/);
});

it('names a stop with no known reason as a worker error', () => {
  expect(workerEnd(undefined)).toBe('worker_error');
});

it('turns a failed model call into a stop of fixed codes, and leaves every other error as it was', () => {
  const failed = new ModelCallFailed('Model call uncertain (secret-id)', {
    cause: 'failed',
    status: 502,
    payer: 'payment_failed',
  });
  expect(workerStop(modelCallStop(failed))).toEqual({
    kind: 'execution_failure',
    reason: 'model_call_failed',
    status: 502,
    payer: 'payment_failed',
  });
  // The router's fixed code for a request it refused reaches the stop reason.
  expect(
    workerStop(
      modelCallStop(
        new ModelCallFailed('refused', {
          cause: 'failed',
          status: 400,
          uncharged: true,
          code: 'invalid_model_request',
        }),
      ),
    ),
  ).toEqual({
    kind: 'execution_failure',
    reason: 'model_call_failed',
    status: 400,
    code: 'invalid_model_request',
  });
  // What is not an HTTP status or a code is left out; no message text is carried.
  const odd = modelCallStop(
    new ModelCallFailed('x', {
      cause: 'failed',
      status: 7,
      payer: 'Not a code: secret',
      code: 'Not a code: secret',
    }),
  );
  expect(workerStop(odd)).toEqual({ kind: 'execution_failure', reason: 'model_call_failed' });
  expect(workerStop(modelCallStop(failed))).not.toHaveProperty('message');
  const other = new Error('Model consent revoked or origin changed');
  expect(modelCallStop(other)).toBe(other);
});

it("tells a timer's abort from another failure, also as a cause", () => {
  const timeout = new DOMException('The operation timed out.', 'TimeoutError');
  expect(timedOut(timeout)).toBe(true);
  expect(timedOut(new Error('fetch failed', { cause: timeout }))).toBe(true);
  expect(timedOut(new DOMException('aborted', 'AbortError'))).toBe(false);
  expect(timedOut(new TypeError('fetch failed'))).toBe(false);
});

// The DeepSeek harness tries a transient failure again; in the payment path only a call the
// router confirms cost nothing may be, never an uncertain or charged one.
describe('a model call tried again', () => {
  const failing = (failures: unknown[], answer = 'ok') => {
    let calls = 0;
    const call = async () => {
      const failure = failures[calls++];
      if (failure) throw failure;
      return answer;
    };
    return { call, calls: () => calls };
  };
  const waits: number[] = [];
  const wait = async (ms: number) => void waits.push(ms);
  const signal = new AbortController().signal;

  it('tries a call that cost nothing again, with doubling backoff, and counts each try', async () => {
    waits.length = 0;
    const tries: number[] = [];
    const uncharged = (cause: 'provider' | 'timeout' | 'failed', status?: number) =>
      new ModelCallFailed('x', { cause, ...(status ? { status } : {}), uncharged: true });
    const f = failing([uncharged('provider', 500), uncharged('timeout'), uncharged('failed', 503)]);
    await expect(
      withModelRetry(
        f.call,
        signal,
        (n) => tries.push(n),
        wait,
        () => 0.5,
      ),
    ).resolves.toBe('ok');
    expect(f.calls()).toBe(4);
    expect(tries).toEqual([1, 2, 3]);
    expect(waits).toEqual([500, 1000, 2000]);
  });

  it('stops after five tries', async () => {
    const failure = new ModelCallFailed('x', { cause: 'provider', uncharged: true });
    const f = failing([failure, failure, failure, failure, failure, failure]);
    await expect(withModelRetry(f.call, signal, () => undefined, wait)).rejects.toBe(failure);
    expect(f.calls()).toBe(5);
  });

  it('never tries an uncertain or charged call again, nor a malformed request', async () => {
    for (const failure of [
      // Signed and sent, no receipt that clears it: uncertain.
      new ModelCallFailed('uncertain', { cause: 'failed', payer: 'payment_failed', status: 500 }),
      // Sent and answered; the router's record holds a charge.
      new ModelCallFailed('charged', { cause: 'failed', status: 502 }),
      // Refused as malformed: trying again cannot help.
      new ModelCallFailed('bad', { cause: 'failed', status: 400, uncharged: true }),
      // A reply the router cut after its idle limit or its deadline: released at no
      // charge, and the same request would run for minutes again.
      ...['model_stream_idle', 'model_deadline_exceeded'].map(
        (code) =>
          new ModelCallFailed('cut', { cause: 'provider', status: 504, uncharged: true, code }),
      ),
      new ModelCallFailed('ceiling', { cause: 'budget' }),
      new Error('Unsupported request'),
    ]) {
      const f = failing([failure]);
      await expect(withModelRetry(f.call, signal, () => undefined, wait)).rejects.toBe(failure);
      expect(f.calls()).toBe(1);
    }
  });

  it('waits as the router asks with Retry-After', async () => {
    waits.length = 0;
    const f = failing([
      new ModelCallFailed('x', {
        cause: 'failed',
        status: 429,
        uncharged: true,
        retryAfterMs: 3000,
      }),
    ]);
    await expect(withModelRetry(f.call, signal, () => undefined, wait)).resolves.toBe('ok');
    expect(waits).toEqual([3000]);
  });
});
