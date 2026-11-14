import { canonicalHash } from '../lib/request-schema';

/** Resource bounds, not a model-fit decision or an ordinary task turn budget. */
export const WORKER_WALL_MS = 40 * 60 * 1000;
export const WORKER_EMERGENCY_TURNS = 500;

export type WorkerStop = {
  kind: 'harness_limit' | 'provider_limit' | 'execution_failure';
  reason:
    | 'turn_guard'
    | 'wall_time'
    | 'budget_guard'
    | 'structured_output_guard'
    | 'output_limit'
    | 'context_limit'
    | 'worker_execution';
  turns?: number;
};

/** Only bounded machine-readable diagnostics cross the worker boundary. */
export class ModelWorkerStopped extends Error {
  constructor(readonly stop: WorkerStop) {
    super(`Worker stopped: ${stop.reason}`);
    this.name = 'ModelWorkerStopped';
  }
}

export function workerStop(error: unknown): WorkerStop | undefined {
  return error instanceof ModelWorkerStopped ? error.stop : undefined;
}

export function workerResultError(result: {
  subtype: string;
  num_turns?: number;
  stop_reason?: string | null;
}): ModelWorkerStopped {
  const turns =
    Number.isSafeInteger(result.num_turns) &&
    result.num_turns! >= 0 &&
    result.num_turns! <= 1_000_000
      ? result.num_turns
      : undefined;
  let stop: WorkerStop;
  switch (result.subtype) {
    case 'error_max_turns':
      stop = { kind: 'harness_limit', reason: 'turn_guard' };
      break;
    case 'error_max_budget_usd':
      stop = { kind: 'harness_limit', reason: 'budget_guard' };
      break;
    case 'error_max_structured_output_retries':
      stop = { kind: 'harness_limit', reason: 'structured_output_guard' };
      break;
    default:
      stop =
        result.stop_reason === 'max_tokens' || result.stop_reason === 'max_output_tokens'
          ? { kind: 'provider_limit', reason: 'output_limit' }
          : result.stop_reason === 'prompt_too_long'
            ? { kind: 'provider_limit', reason: 'context_limit' }
            : { kind: 'execution_failure', reason: 'worker_execution' };
  }
  return new ModelWorkerStopped({ ...stop, ...(turns === undefined ? {} : { turns }) });
}

/** Abort at the wall bound, then await the native runner's accounting/process drain. */
export async function withWorkerDeadline<T>(
  signal: AbortSignal,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  const timer = setTimeout(
    () => controller.abort(new ModelWorkerStopped({ kind: 'harness_limit', reason: 'wall_time' })),
    WORKER_WALL_MS,
  );
  timer.unref();
  try {
    const result = await run(controller.signal);
    controller.signal.throwIfAborted();
    return result;
  } catch (error) {
    if (controller.signal.reason instanceof ModelWorkerStopped) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
  }
}

/** Evaluated 3/5/8 reminder cadence; native tools still execute normally. */
export class WorkerRepeatReminder {
  private previous: string | undefined;
  private count = 0;

  observe(tool: string, input: unknown): string | undefined {
    let identity: string;
    try {
      identity = canonicalHash({ tool, input });
    } catch {
      this.previous = undefined;
      this.count = 0;
      return;
    }
    this.count = identity === this.previous ? this.count + 1 : 1;
    this.previous = identity;
    if (![3, 5, 8].includes(this.count)) return;
    return `Local worker reminder: the same tool and arguments have repeated ${this.count} times consecutively. Review the previous results and change approach if they are not making progress. Respect the assignment and all permission denials. This is progress feedback; permissions and tool results are unchanged.`;
  }
}
