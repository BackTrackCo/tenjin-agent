/**
 * THE TYPESAFE (JEV) CLIENT FOR THE AGENT LEG'S LOCAL DECIDER, mirroring the
 * server's (tenjin `lib/x402-router/jev.ts`): a pinned endpoint and model, one
 * bounded attempt, and a `weak` reason instead of a throw when the provider is
 * slow, unreachable or malformed. No retries: a retry is a second wait inside a
 * hook the spawn is already waiting on.
 *
 * Jev is a CLOSED-SET chooser: every question is a map of criteria and every
 * answer is one of their keys, or a yes/no probability. Anything else is
 * discarded, so no provider output can become a model name, an argument or an
 * instruction.
 *
 * THE KEY. Read by name from the environment once, held in memory, and sent
 * only in the Authorization header to {@link JEV_ENDPOINT}. It is never logged,
 * written, echoed or put in a weak reason: a failure is reported by its kind
 * and, for an HTTP error, its status code, never by the error's own message.
 */

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

/** Pinned, never an alias: an alias that moves silently re-decides every spawn. */
export const JEV_MODEL = 'jev-1.13.0';

/** Inside the agent leg's 5 s hook timeout, beside the paid route's own decision. */
export const JEV_TIMEOUT_MS = 1_500;

/** The names the key is read under, first set wins. `TYPESAFE_KEY` is the
 *  name the operator's local env file uses. */
export const JEV_KEY_NAMES = ['TYPESAFE_API_KEY', 'TYPESAFE_KEY'] as const;

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;

export interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string>;
}

/** A yes/no question, answered with the probability of yes. */
export interface NoulQuestion {
  type: 'noul';
  instructions: string;
  criteria?: { true: string; false: string };
}

export type Question = ChoiceQuestion | NoulQuestion;

export interface ChoiceAnswer {
  choice: string;
  confidence?: number;
  /** Each offered label's probability, when Jev sent them. */
  probabilities?: Record<string, number>;
}

export interface NoulAnswer {
  noul: number;
}

export type Answers<Q extends Record<string, Question>> = {
  [K in keyof Q]: Q[K] extends NoulQuestion ? NoulAnswer : ChoiceAnswer;
};

export type JevWeakReason =
  'not_configured' | 'timeout' | 'provider_error' | 'invalid_response' | 'request_too_large';

/** Which answer shape came back: the server's `{choice, confidence}`, or a
 *  probability for each option. Unverified on `jev-1.13.0`, so both are read. */
export type AnswerShape = 'confidence' | 'probabilities';

export interface JevCall<Q extends Record<string, Question>> {
  /** Every question answered, or null when the call went weak. */
  answers: Answers<Q> | null;
  weak?: JevWeakReason;
  /** The HTTP status of a `provider_error` that had one. */
  status?: number;
  shape?: AnswerShape;
  model: string;
  latencyMs: number;
  inputTokens: number;
}

export interface JevClient {
  ask<Q extends Record<string, Question>>(state: unknown, questions: Q): Promise<JevCall<Q>>;
}

export interface JevOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Aborts an in-flight call when the caller has stopped waiting. */
  signal?: AbortSignal;
}

/** Whether a key is set under one of {@link JEV_KEY_NAMES}; never its value. */
export function hasJevKey(env: NodeJS.ProcessEnv = process.env): boolean {
  return keyIn(env) !== undefined;
}

function keyIn(env: NodeJS.ProcessEnv): string | undefined {
  for (const name of JEV_KEY_NAMES) {
    const value = env[name]?.trim();
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
}

/** The client, or null without a key: the decider then runs keyless. */
export function createJevClient(options: JevOptions = {}): JevClient | null {
  const key = keyIn(options.env ?? process.env);
  if (key === undefined) return null;
  const now = options.now ?? Date.now;
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? JEV_TIMEOUT_MS;

  const ask = async <Q extends Record<string, Question>>(
    state: unknown,
    questions: Q,
  ): Promise<JevCall<Q>> => {
    const startedAt = now();
    const result = (fields: Partial<JevCall<Q>>): JevCall<Q> => ({
      answers: null,
      model: JEV_MODEL,
      latencyMs: Math.max(0, now() - startedAt),
      inputTokens: 0,
      ...fields,
    });
    const body = JSON.stringify({ model: JEV_MODEL, state, questions });
    if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES) {
      return { ...result({ weak: 'request_too_large' }), latencyMs: 0 };
    }
    let response: Response;
    try {
      response = await doFetch(JEV_ENDPOINT, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body,
        signal: options.signal
          ? AbortSignal.any([AbortSignal.timeout(timeoutMs), options.signal])
          : AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
    } catch (err) {
      const timedOut = err instanceof Error && /timeout|abort/i.test(err.name);
      return result({ weak: timedOut ? 'timeout' : 'provider_error' });
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return result({ weak: 'provider_error', status: response.status });
    }
    let value: unknown;
    try {
      value = JSON.parse(await readBounded(response));
    } catch (err) {
      const timedOut = err instanceof Error && /timeout|abort/i.test(err.name);
      return result({ weak: timedOut ? 'timeout' : 'invalid_response' });
    }
    const read = readAnswers(value, questions);
    if (read === null) return result({ weak: 'invalid_response' });
    return result({ answers: read.answers, shape: read.shape, inputTokens: usageTokens(value) });
  };

  return { ask };
}

async function readBounded(response: Response): Promise<string> {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error('response exceeds limit');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('empty response');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error('response exceeds limit');
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const isProbability = (value: unknown): value is number =>
  typeof value === 'number' && value >= 0 && value <= 1;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function usageTokens(value: unknown): number {
  const usage = isObject(value) && isObject(value.usage) ? value.usage : {};
  const raw = usage.inputTokens ?? usage.input_tokens;
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 ? raw : 0;
}

/**
 * Every question's answer, or null when any is missing or unoffered. A choice
 * is read from `choice`, or from the highest of `probabilities` when only those
 * came; probabilities are kept for offered labels only, and dropped whole when
 * any offered one is not a probability.
 */
function readAnswers<Q extends Record<string, Question>>(
  value: unknown,
  questions: Q,
): { answers: Answers<Q>; shape: AnswerShape } | null {
  const answers = isObject(value) && isObject(value.answers) ? value.answers : null;
  if (answers === null) return null;
  const out: Record<string, ChoiceAnswer | NoulAnswer> = {};
  let everyChoiceHasProbabilities = true;
  for (const [key, question] of Object.entries<Question>(questions)) {
    const answer = Object.hasOwn(answers, key) ? answers[key] : undefined;
    if (!isObject(answer)) return null;
    if (question.type === 'noul') {
      if (!isProbability(answer.noul)) return null;
      out[key] = { noul: answer.noul };
      continue;
    }
    const probabilities = probabilitiesOf(answer.probabilities, question.criteria);
    const choice =
      typeof answer.choice === 'string' ? answer.choice : probabilities && argmax(probabilities);
    if (typeof choice !== 'string' || !Object.hasOwn(question.criteria, choice)) return null;
    if (probabilities === undefined) everyChoiceHasProbabilities = false;
    out[key] = {
      choice,
      ...(isProbability(answer.confidence) ? { confidence: answer.confidence } : {}),
      ...(probabilities !== undefined ? { probabilities } : {}),
    };
  }
  return {
    answers: out as Answers<Q>,
    shape: everyChoiceHasProbabilities ? 'probabilities' : 'confidence',
  };
}

function probabilitiesOf(
  raw: unknown,
  criteria: Record<string, string>,
): Record<string, number> | undefined {
  if (!isObject(raw)) return undefined;
  const out: Record<string, number> = {};
  for (const label of Object.keys(criteria)) {
    if (!Object.hasOwn(raw, label)) continue;
    const p = raw[label];
    if (!isProbability(p)) return undefined;
    out[label] = p;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function argmax(probabilities: Record<string, number>): string | undefined {
  let best: string | undefined;
  for (const [label, p] of Object.entries(probabilities)) {
    if (best === undefined || p > probabilities[best]!) best = label;
  }
  return best;
}
