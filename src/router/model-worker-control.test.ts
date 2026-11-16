import { afterEach, expect, it, vi } from 'vitest';
import {
  ModelWorkerStopped,
  withWorkerDeadline,
  WorkerRepeatReminder,
  workerResultError,
  workerStartupMs,
  workerStop,
} from './model-worker-control';

it("gives the worker's Claude Code the start-up time native Claude Code gives an MCP server", () => {
  expect(workerStartupMs({})).toBe(30_000);
  expect(workerStartupMs({ MCP_TIMEOUT: '90000' })).toBe(90_000);
  for (const invalid of ['0', '-5', 'soon', '1.5'])
    expect(workerStartupMs({ MCP_TIMEOUT: invalid })).toBe(30_000);
  // Never past the job's own wall time: the window is part of it.
  expect(workerStartupMs({ MCP_TIMEOUT: String(10 ** 9) })).toBe(40 * 60 * 1000);
});

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
