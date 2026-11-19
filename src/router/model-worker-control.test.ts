import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ModelCallFailed,
  modelCallStop,
  ModelWorkerStopped,
  timedOut,
  WorkerRepeatReminder,
  withModelRetry,
  WORKER_ENDS,
  workerEnd,
  workerResultError,
  workerStop,
} from './model-worker-control';

afterEach(() => vi.useRealTimers());

// The DeepSeek harness's own two texts: one weak text at every count named no tool, no
// arguments and no way out ("finish the task").
it('reminds gently at three identical calls, then in detail at five and eight, whatever the argument key order', () => {
  const repeats = new WorkerRepeatReminder();
  const reminded = new Map<number, string>();
  for (let call = 1; call <= 10; call++) {
    const reminder = repeats.observe(
      'Read',
      call % 2 ? { path: 'a', offset: 1 } : { offset: 1, path: 'a' },
    );
    if (reminder) {
      expect(reminder.count).toBe(call);
      reminded.set(call, reminder.text);
    }
  }
  expect([...reminded.keys()]).toEqual([3, 5, 8]);
  expect(reminded.get(3)).toBe(
    'You are repeating the exact same tool call with identical arguments. Carefully analyze the previous result before calling again: if the task is not complete, try a different approach or different arguments instead of repeating the call.',
  );
  expect(reminded.get(5)).toBe(
    'Repeated tool call detected:\n- tool: Read\n- consecutive_calls: 5\n- arguments: {"offset":1,"path":"a"}\nThe repeated calls are not making progress. Do not call this tool with these exact arguments again. Inspect the latest result and choose a different action, different arguments, or finish the task if enough evidence has been gathered.',
  );
  expect(reminded.get(8)).toContain('- consecutive_calls: 8\n');
  expect(repeats.observe('Read', { path: 'b', offset: 1 })).toBeUndefined();
  expect(repeats.observe('Read', { path: 'a', offset: 1 })).toBeUndefined();
  expect(repeats.observe('Write', { path: 'a', offset: 1 })).toBeUndefined();
});

it('quotes at most 500 characters of the arguments, and still tells long calls apart in full', () => {
  const repeats = new WorkerRepeatReminder();
  const long = (tail: string) => ({ command: 'x'.repeat(600) + tail });
  for (let call = 1; call <= 4; call++) repeats.observe('Bash', long('a'));
  const detailed = repeats.observe('Bash', long('a'))?.text;
  expect(detailed).toContain(`- arguments: {"command":"${'x'.repeat(488)}… (+115 more chars)\n`);
  // Another ending past the quoted part is another call.
  expect(repeats.observe('Bash', long('b'))).toBeUndefined();
});

// The DeepSeek harness ships with no tool excluded: a to-do list update counts, and it
// breaks a run of repeats. It once did neither here.
it('counts a to-do list update as any other call', () => {
  const repeats = new WorkerRepeatReminder();
  repeats.observe('Bash', { command: 'pnpm test' });
  repeats.observe('TodoWrite', { todos: [] });
  repeats.observe('Bash', { command: 'pnpm test' });
  expect(repeats.observe('Bash', { command: 'pnpm test' })).toBeUndefined();
  const updates = new WorkerRepeatReminder();
  updates.observe('TodoWrite', { todos: [] });
  updates.observe('TodoWrite', { todos: [] });
  expect(updates.observe('TodoWrite', { todos: [] })?.count).toBe(3);
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

// A refusal used to reach the parent and the person as a bare provider failure, which
// does not say why the job ended. It has its own end now, and it is still never retried.
it('names a request DeepSeek refused as its own end, with the plain reason and no charge', () => {
  expect(
    workerEnd({ kind: 'execution_failure', reason: 'provider_failed', code: 'model_refused' }),
  ).toBe('refused');
  expect(WORKER_ENDS.refused).toBe(
    'DeepSeek refused to answer this request, and nothing was charged for that call.',
  );
  // The same stop without that router code stays a provider failure.
  expect(
    workerEnd({
      kind: 'execution_failure',
      reason: 'provider_failed',
      code: 'model_inference_failed',
    }),
  ).toBe('provider');
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

  // The DeepSeek harness makes 5 retries after the first request; this made 5 tries.
  it('stops after five retries, six tries in all', async () => {
    waits.length = 0;
    const failure = new ModelCallFailed('x', { cause: 'provider', uncharged: true });
    const f = failing(Array.from({ length: 8 }, () => failure));
    await expect(
      withModelRetry(
        f.call,
        signal,
        () => undefined,
        wait,
        () => 0.5,
      ),
    ).rejects.toBe(failure);
    expect(f.calls()).toBe(6);
    expect(waits).toEqual([500, 1000, 2000, 4000, 8000]);
  });

  it('never tries an uncertain or charged call again, nor a malformed request', async () => {
    for (const failure of [
      // Signed and sent, no receipt that clears it: uncertain.
      new ModelCallFailed('uncertain', { cause: 'failed', payer: 'payment_failed', status: 500 }),
      // Sent and answered; the router's record holds a charge.
      new ModelCallFailed('charged', { cause: 'failed', status: 502 }),
      // Refused as malformed: trying again cannot help.
      new ModelCallFailed('bad', { cause: 'failed', status: 400, uncharged: true }),
      // A reply the router cut whose record did not prove it cost nothing: uncertain.
      ...['model_stream_idle', 'model_deadline_exceeded'].map(
        (code) => new ModelCallFailed('cut', { cause: 'failed', status: 504, code }),
      ),
      // A reply the provider refused to give, released at no charge: it would be refused
      // again, and the DeepSeek harness does not try a refusal again either.
      new ModelCallFailed('refused', {
        cause: 'provider',
        status: 502,
        uncharged: true,
        code: 'model_refused',
      }),
      new ModelCallFailed('ceiling', { cause: 'budget' }),
      new Error('Unsupported request'),
    ]) {
      const f = failing([failure]);
      await expect(withModelRetry(f.call, signal, () => undefined, wait)).rejects.toBe(failure);
      expect(f.calls()).toBe(1);
    }
  });

  // A provider stall ended the job: the DeepSeek harness tries a timeout again.
  it.each(['model_stream_idle', 'model_deadline_exceeded'])(
    'tries a reply the router cut with %s again once its record proved it cost nothing',
    async (code) => {
      const cut = new ModelCallFailed('cut', {
        cause: 'provider',
        status: 504,
        uncharged: true,
        code,
      });
      const f = failing([cut]);
      await expect(withModelRetry(f.call, signal, () => undefined, wait)).resolves.toBe('ok');
      expect(f.calls()).toBe(2);
    },
  );

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
