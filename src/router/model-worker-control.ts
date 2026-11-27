import { stable } from '../lib/request-schema';

export type WorkerStop = {
  kind: 'harness_limit' | 'provider_limit' | 'execution_failure' | 'not_started';
  reason:
    | 'startup_timeout'
    | 'turn_guard'
    | 'budget_guard'
    | 'structured_output_guard'
    | 'output_limit'
    | 'context_limit'
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
      /** Provider events of a streamed reply had already reached the worker's child: the
       *  call is never tried again as if nothing happened. */
      relayed?: true;
    },
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ModelCallFailed';
  }
}

/**
 * A MODEL CALL TRIED AGAIN, as the DeepSeek harness tries one: up to 5 retries after the
 * first try (6 tries), 500 ms doubling to 10 s with 0.1 jitter, or the router's
 * `Retry-After`. Only a call the router confirms cost nothing, and only for a rate limit,
 * a server or provider error, a timeout or a call that never reached it. Never an
 * uncertain or a charged call, never a request the bridge or the router refused as
 * malformed, never a reply the provider refused to give.
 */
export const MODEL_RETRY = { tries: 6, baseMs: 500, maxMs: 10_000, jitter: 0.1, hintMs: 60_000 };
/**
 * The router's code for a reply the provider refused to give (a `refusal` stop). The
 * DeepSeek harness fails such a turn at once (`CONTENT_REFUSED`, outside its retried
 * codes): the same request would be refused again. A router that names no refusal answers
 * one as `incomplete_model_response`, which cannot be told from an empty reply and is
 * tried again with it.
 */
export const MODEL_REFUSED_CODE = 'model_refused';
/**
 * The router's codes for a reply it cut: no byte from the provider for its idle limit, or
 * the call's total deadline. Its record of such a call always reads `state: "unknown"`,
 * the name of its failed state, so that alone says nothing of a charge: the transport
 * calls a cut reply uncharged only on a cancelled voucher together with a zero charge
 * (`cutCostNothing`). So proven, it is tried again as the DeepSeek harness tries a
 * timeout; any other record, or none, leaves it uncertain and never tried again.
 */
export const MODEL_CUT_REPLY_CODES: ReadonlySet<string> = new Set([
  'model_stream_idle',
  'model_deadline_exceeded',
]);
export function retryableModelCall(error: unknown): error is ModelCallFailed {
  if (!(error instanceof ModelCallFailed) || error.detail.uncharged !== true) return false;
  // Events already reached the child: a new try would repeat what it has seen.
  if (error.detail.relayed === true) return false;
  const { cause, status, code } = error.detail;
  if (code === MODEL_REFUSED_CODE) return false;
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
  turn_limit: "It reached the job's turn limit.",
  budget: 'It reached its spending limit.',
  output_limit: "It reached the model's output limit.",
  context_limit: "It reached the model's context limit.",
  not_started: 'Its Claude Code did not start.',
  model_call_failed:
    'Its model call through Tenjin returned no result; that call stays reserved until its receipt is read.',
  model_call_timeout:
    'Its model call through Tenjin timed out; that call stays reserved until its receipt is read.',
  payment_refused: 'Tenjin refused to pay for its next model call, and sent nothing for it.',
  provider: 'DeepSeek could not take its next request, and nothing was charged for that call.',
  refused: 'DeepSeek refused to answer this request, and nothing was charged for that call.',
  worker_error: 'The worker or the provider failed.',
} as const;
export type WorkerEnd = keyof typeof WORKER_ENDS;

/** The end code of a worker that stopped without an abort, from its stop reason. */
export function workerEnd(stop: WorkerStop | undefined): WorkerEnd {
  switch (stop?.reason) {
    case 'turn_guard':
      return 'turn_limit';
    case 'budget_guard':
      return 'budget';
    case 'output_limit':
    case 'context_limit':
    case 'model_call_failed':
    case 'model_call_timeout':
    case 'payment_refused':
      return stop.reason;
    case 'provider_failed':
      // A refusal is its own end: the parent and the person read why, not a bare
      // provider failure. It is still never tried again (`retryableModelCall`).
      return stop.code === MODEL_REFUSED_CODE ? 'refused' : 'provider';
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

/**
 * THE REPEAT REMINDER OF THE DEEPSEEK HARNESS (its `repeat-tool-reminder` guard, as
 * shipped): the same tool with the same arguments, key order aside, 3, 5 and 8 times in a
 * row. Advisory only: no call is blocked, delayed or changed. Every call the model makes
 * counts, also one that is then denied, and no tool is left out: the harness ships with
 * an empty exclude list, so a to-do list update counts and breaks a run of repeats as any
 * other call does. Past 8 a run is silent. The two texts are the harness's own: the
 * gentle one at the first count, then the detailed one with the tool, the run's length
 * and the first 500 characters of the arguments.
 */
const REPEAT_COUNTS = [3, 5, 8];
const REPEAT_ARGUMENT_CHARS = 500;
const GENTLE_REPEAT_REMINDER =
  'You are repeating the exact same tool call with identical arguments. ' +
  'Carefully analyze the previous result before calling again: if the task is ' +
  'not complete, try a different approach or different arguments instead of ' +
  'repeating the call.';
function detailedRepeatReminder(tool: string, count: number, canonical: string): string {
  const shown =
    canonical.length <= REPEAT_ARGUMENT_CHARS
      ? canonical
      : `${canonical.slice(0, REPEAT_ARGUMENT_CHARS)}… (+${canonical.length - REPEAT_ARGUMENT_CHARS} more chars)`;
  return (
    'Repeated tool call detected:\n' +
    `- tool: ${tool}\n` +
    `- consecutive_calls: ${count}\n` +
    `- arguments: ${shown}\n` +
    'The repeated calls are not making progress. Do not call this tool with ' +
    'these exact arguments again. Inspect the latest result and choose a ' +
    'different action, different arguments, or finish the task if enough ' +
    'evidence has been gathered.'
  );
}
export class WorkerRepeatReminder {
  private previous: string | undefined;
  private count = 0;

  /** One call the model made: the reminder to hand it at a count of 3, 5 or 8. */
  observe(tool: string, input: unknown): { count: number; text: string } | undefined {
    let canonical: string;
    try {
      canonical = stable(input);
    } catch {
      this.previous = undefined;
      this.count = 0;
      return;
    }
    const identity = JSON.stringify([tool, canonical]);
    this.count = identity === this.previous ? this.count + 1 : 1;
    this.previous = identity;
    if (!REPEAT_COUNTS.includes(this.count)) return;
    return {
      count: this.count,
      text:
        this.count === REPEAT_COUNTS[0]
          ? GENTLE_REPEAT_REMINDER
          : detailedRepeatReminder(tool, this.count, canonical),
    };
  }
}

/**
 * WORKER_ENDS in the words of the job's provider. The Neon worker's model calls go to
 * the provider of its row and are paid by this machine, not sent through Tenjin: "through
 * Tenjin" and DeepSeek's name would say what did not happen.
 */
export function workerEndText(code: WorkerEnd, provider: 'deepseek' | 'neon'): string {
  const text: string = WORKER_ENDS[code];
  if (provider !== 'neon') return text;
  return (
    text
      .replace('through Tenjin', 'to its provider')
      .replace(
        'Tenjin refused to pay for its next model call, and sent nothing for it.',
        'Tenjin did not pay for its next model call, and sent nothing for it.',
      )
      .replace('DeepSeek could not take', 'The provider could not take')
      .replace('DeepSeek refused', 'The model refused')
      // A call that spent its whole output on thought is charged and has no answer: it is said so.
      .replace(
        "It reached the model's output limit.",
        'A model call spent its whole output limit on thought and wrote no answer. It was charged, it counts in the daily budget, and it is not sent again.',
      )
  );
}
