import { canonicalHash } from '../lib/request-schema';

/** Resource bounds, not a model-fit decision or an ordinary task turn budget. */
export const WORKER_WALL_MS = 40 * 60 * 1000;

export type WorkerStop = {
  kind: 'harness_limit' | 'provider_limit' | 'execution_failure' | 'not_started';
  reason:
    | 'startup_timeout'
    | 'router_unreachable'
    | 'turn_guard'
    | 'wall_time'
    | 'budget_guard'
    | 'structured_output_guard'
    | 'output_limit'
    | 'context_limit'
    | 'env_file_unscanned'
    | 'model_call_failed'
    | 'model_call_timeout'
    | 'payment_refused'
    | 'provider_failed'
    | 'worker_execution';
  turns?: number;
  /** The router's HTTP status, when a model call got an answer that was not a result. */
  status?: number;
  /** The payer's own code for a paid call it could not complete, such as `payment_failed`. */
  payer?: string;
  /** The router's fixed error code for that answer, such as `invalid_model_request`. */
  code?: string;
};

/**
 * A MODEL CALL THROUGH THE ROUTER THAT RETURNED NO RESULT, with what can be told about
 * why: it timed out, the router answered with another status, the job's ceiling or the
 * payer refused it, or it failed otherwise. The message stays the transport's own; the
 * detail is fixed codes only, so it can reach the parent and the stored handback.
 */
export class ModelCallFailed extends Error {
  constructor(
    message: string,
    readonly detail: {
      cause: 'failed' | 'timeout' | 'budget' | 'payment_refused' | 'provider';
      status?: number;
      payer?: string;
      /** The router confirms nothing was charged: no payment was sent, or its record
       *  says the failed call cost nothing and its reservation was released. */
      uncharged?: true;
      /** The router's `Retry-After`, in milliseconds, when it sent one. */
      retryAfterMs?: number;
      /** The router's fixed error code (`{error: {code}}`), never its message. */
      code?: string;
    },
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ModelCallFailed';
  }
}

/**
 * A MODEL CALL TRIED AGAIN, as the DeepSeek harness tries one: up to 5 tries, 500 ms
 * doubling to 10 s with 0.1 jitter, or the router's `Retry-After`. Only a call the router
 * confirms cost nothing, and only for a rate limit, a server or provider error, a timeout
 * or a call that never reached it. Never an uncertain or a charged call, never a request
 * the bridge or the router refused as malformed.
 */
export const MODEL_RETRY = { tries: 5, baseMs: 500, maxMs: 10_000, jitter: 0.1, hintMs: 60_000 };
export function retryableModelCall(error: unknown): error is ModelCallFailed {
  if (!(error instanceof ModelCallFailed) || error.detail.uncharged !== true) return false;
  const { cause, status } = error.detail;
  if (cause === 'provider' || cause === 'timeout') return true;
  return cause === 'failed' && (status === undefined || status === 429 || status >= 500);
}
export async function withModelRetry<T>(
  call: () => Promise<T>,
  signal: AbortSignal,
  onRetry: (attempt: number, error: ModelCallFailed) => void,
  wait: (ms: number, signal: AbortSignal) => Promise<void> = sleepFor,
  random: () => number = Math.random,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (attempt >= MODEL_RETRY.tries || signal.aborted || !retryableModelCall(error)) throw error;
      const hint = error.detail.retryAfterMs;
      const backoff = Math.min(MODEL_RETRY.maxMs, MODEL_RETRY.baseMs * 2 ** (attempt - 1));
      const ms =
        hint !== undefined
          ? Math.min(hint, MODEL_RETRY.hintMs)
          : Math.round(backoff * (1 + MODEL_RETRY.jitter * (2 * random() - 1)));
      onRetry(attempt, error);
      await wait(ms, signal);
    }
  }
}
export function sleepFor(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
/** A `Retry-After` header in milliseconds: seconds or an HTTP date; undefined otherwise. */
export function retryAfterMs(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** Whether a failure, or one of its causes, is a timer's abort (`AbortSignal.timeout`). */
export function timedOut(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth++) {
    const value = current as { name?: unknown; cause?: unknown };
    if (value.name === 'TimeoutError') return true;
    current = value.cause;
  }
  return false;
}

/** The worker's stop for a model call that failed, else the error as it was. */
export function modelCallStop(error: unknown): unknown {
  if (!(error instanceof ModelCallFailed)) return error;
  const { cause, status, payer, code } = error.detail;
  return new ModelWorkerStopped({
    kind: cause === 'budget' ? 'harness_limit' : 'execution_failure',
    reason:
      cause === 'budget'
        ? 'budget_guard'
        : cause === 'timeout'
          ? 'model_call_timeout'
          : cause === 'payment_refused'
            ? 'payment_refused'
            : cause === 'provider'
              ? 'provider_failed'
              : 'model_call_failed',
    ...(status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599
      ? { status }
      : {}),
    ...(payer !== undefined && /^[a-z][a-z_]{0,47}$/.test(payer) ? { payer } : {}),
    ...(code !== undefined && /^[a-z][a-z0-9_]{0,63}$/.test(code) ? { code } : {}),
  });
}

/** Only bounded machine-readable diagnostics cross the worker boundary. */
export class ModelWorkerStopped extends Error {
  constructor(
    readonly stop: WorkerStop,
    options?: ErrorOptions,
  ) {
    super(`Worker stopped: ${stop.reason}`, options);
    this.name = 'ModelWorkerStopped';
  }
}

/**
 * Who or what ended a worker that did not end by itself, as one fixed code and
 * the plain words the parent reads beside it. A native subagent's result says
 * why it stopped too; a job once read `cancelled` with nothing to tell by what.
 */
export const WORKER_ENDS = {
  parent_cancel: 'The parent cancelled it with subagent({cancel}).',
  agent_stopped: "The person stopped the worker's agent.",
  host_aborted: 'The host ended the call that was running it.',
  session_ended: 'Its session or its Tenjin process ended.',
  time_limit: "It reached the job's time limit.",
  turn_limit: "It reached the job's turn limit.",
  budget: 'It reached its spending limit.',
  output_limit: "It reached the model's output limit.",
  context_limit: "It reached the model's context limit.",
  not_started: 'Its Claude Code did not start.',
  router_unreachable:
    'The Tenjin router did not answer when the job started, so no worker ran and no inference was bought.',
  env_file_unscanned:
    'An env file appeared that could not be read in full, so nothing more could be forwarded.',
  model_call_failed:
    'Its model call through Tenjin returned no result; that call stays reserved until its receipt is read.',
  model_call_timeout:
    'Its model call through Tenjin timed out; that call stays reserved until its receipt is read.',
  payment_refused: 'Tenjin refused to pay for its next model call, and sent nothing for it.',
  provider: 'DeepSeek could not take its next request, and nothing was charged for that call.',
  worker_error: 'The worker or the provider failed.',
} as const;
export type WorkerEnd = keyof typeof WORKER_ENDS;

/** The end code of a worker that stopped without an abort, from its stop reason. */
export function workerEnd(stop: WorkerStop | undefined): WorkerEnd {
  switch (stop?.reason) {
    case 'wall_time':
      return 'time_limit';
    case 'turn_guard':
      return 'turn_limit';
    case 'budget_guard':
      return 'budget';
    case 'output_limit':
    case 'context_limit':
    case 'env_file_unscanned':
    case 'model_call_failed':
    case 'model_call_timeout':
    case 'payment_refused':
    case 'router_unreachable':
      return stop.reason;
    case 'provider_failed':
      return 'provider';
    case 'startup_timeout':
      return 'not_started';
    default:
      return 'worker_error';
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
  /** A worker started before its accept: its wall time runs from the accept, not the start. */
  from?: Promise<unknown>,
): Promise<T> {
  signal.throwIfAborted();
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ended = false;
  const arm = () => {
    if (ended || controller.signal.aborted) return;
    timer = setTimeout(
      () =>
        controller.abort(new ModelWorkerStopped({ kind: 'harness_limit', reason: 'wall_time' })),
      WORKER_WALL_MS,
    );
    timer.unref();
  };
  if (from) from.then(arm, () => undefined);
  else arm();
  try {
    const result = await run(controller.signal);
    controller.signal.throwIfAborted();
    return result;
  } catch (error) {
    // A worker the wall bound found still starting ran nothing: it reports that.
    if (workerStop(error)?.kind === 'not_started') throw error;
    if (controller.signal.reason instanceof ModelWorkerStopped) throw controller.signal.reason;
    throw error;
  } finally {
    ended = true;
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
  }
}

/**
 * Evaluated 3/5/8 reminder cadence; native tools still execute normally. A to-do list
 * update neither counts nor breaks a run of repeats, as in the DeepSeek harness.
 */
export class WorkerRepeatReminder {
  private previous: string | undefined;
  private count = 0;

  observe(tool: string, input: unknown): string | undefined {
    if (tool === 'TodoWrite') return;
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
