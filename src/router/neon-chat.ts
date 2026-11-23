import { randomBytes } from 'node:crypto';
import { isRecord } from '../lib/guards';
import { CLAUDE_DEEPSEEK_MODEL } from './claude-model-policy';
import { NEON_ORIGIN } from './model-settings';

/**
 * THE NEON WORKER'S SELLER: BlockRun sells Gemini 4 Neon on an OpenAI-compatible endpoint, and
 * the worker's local bridge pays it directly from the person's wallet. The bridge takes the
 * worker's Anthropic Messages in and sends chat completions out; this file is that
 * translation, with no network and no payment in it.
 */
export const NEON_MODEL = 'google/gemini-4-neon' as const;
export const NEON_CHAT_URL = `${NEON_ORIGIN}/api/v1/chat/completions`;
/** BlockRun's list prices for Neon, in atomic USDC (millionths of a dollar) per token. */
/**
 * THE GEMINI 4 MODELS THE EVAL MAY NAME, with their list prices in thousandths of a dollar per
 * million tokens (1,500 is $1.50), as BlockRun's `/api/v1/models` lists them and as x402inference
 * lists them before its 5% (read 2026-11-23). Both sellers sell all four. Neon is the default.
 */
export const NEON_MODELS = {
  'google/gemini-4-neon': { label: 'Gemini 4 Neon', inMilli: 3_000n, outMilli: 15_000n },
  'google/gemini-4-carbon': { label: 'Gemini 4 Carbon', inMilli: 2_000n, outMilli: 10_000n },
  'google/gemini-4-argon': { label: 'Gemini 4 Argon', inMilli: 2_000n, outMilli: 10_000n },
  'google/gemini-4-hydrogen': { label: 'Gemini 4 Hydrogen', inMilli: 1_500n, outMilli: 7_500n },
} as const;
export type NeonModelId = keyof typeof NEON_MODELS;
/** EVAL ONLY: `TENJIN_NEON_MODEL` names one of the four; any other value is Neon. */
export const NEON_MODEL_ENV = 'TENJIN_NEON_MODEL';
export function neonModel(env: NodeJS.ProcessEnv = process.env): NeonModelId {
  const asked = env[NEON_MODEL_ENV] ?? '';
  return Object.hasOwn(NEON_MODELS, asked) ? (asked as NeonModelId) : NEON_MODEL;
}
/** The name shown for a model id (a job's `decision.model`, a call's `model`); Neon when unknown. */
export function neonLabel(model: unknown): string {
  return typeof model === 'string' && Object.hasOwn(NEON_MODELS, model)
    ? NEON_MODELS[model as NeonModelId].label
    : NEON_MODELS[NEON_MODEL].label;
}
/** BlockRun's platform fee, percent, and its least charge per call. */
const NEON_FEE_PERCENT = 105n;
const NEON_MINIMUM_CALL_ATOMIC = 2_000n;
/**
 * THE OUTPUT CAP OF ONE NEON TURN. BlockRun's `exact` quote is an upper-bound estimate of the
 * input plus the WHOLE `max_tokens` of output at list price, whatever the model writes: 16,384
 * output tokens would reserve about $0.25 a turn. 8,192 reserves about $0.13 and still holds a
 * long document written in one turn. A reply that reaches it ends as `max_tokens`.
 */
export const NEON_TURN_MAX_TOKENS = 8_192;
/**
 * EVAL ONLY: `TENJIN_NEON_MAX_TOKENS` replaces the per-turn cap, from 1 to 32,768. The quote still
 * has to fit the job's room, so a larger cap is stepped down as the cap already is.
 */
export const NEON_MAX_TOKENS_ENV = 'TENJIN_NEON_MAX_TOKENS';
export const NEON_MAX_TOKENS_LIMIT = 32_768;
export function neonMaxTokens(env: NodeJS.ProcessEnv = process.env): number {
  const asked = Number(env[NEON_MAX_TOKENS_ENV]);
  return Number.isInteger(asked) && asked >= 1 && asked <= NEON_MAX_TOKENS_LIMIT
    ? asked
    : NEON_TURN_MAX_TOKENS;
}
/** The least a turn is stepped down to when the job's ceiling cannot hold more. */
export const NEON_TURN_FLOOR_TOKENS = 1_024;
/** Bytes of request body counted as one input token in the estimate: an upper bound. */
const NEON_BYTES_PER_INPUT_TOKEN = 2;
/**
 * HOW MUCH GEMINI THINKS BEFORE IT WRITES, as the OpenAI-compatible `reasoning_effort`. Thought
 * tokens are output tokens: a turn capped at {@link NEON_TURN_MAX_TOKENS} that thinks at the
 * model's default can spend the whole cap and write nothing (two live turns did). A writing job
 * needs little thought, so the bridge asks for the least that still reasons.
 */
export const NEON_REASONING_EFFORT = 'low';
/**
 * EVAL ONLY: the value the bridge sends instead, from `TENJIN_NEON_REASONING_EFFORT`: `none`,
 * `minimal`, `low`, `medium`, `high`, or `omit` to send no field. Both routes and both sellers
 * read it: chat completions send it as `reasoning_effort`, the Messages route maps it to a
 * thinking budget (`none` disables thinking, `omit` sends no `thinking`).
 */
export const NEON_REASONING_EFFORT_ENV = 'TENJIN_NEON_REASONING_EFFORT';
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'omit'] as const;
export type NeonEffort = (typeof EFFORTS)[number];
export function neonEffort(env: NodeJS.ProcessEnv = process.env): NeonEffort {
  const asked = env[NEON_REASONING_EFFORT_ENV];
  return (EFFORTS as readonly string[]).includes(asked ?? '')
    ? (asked as NeonEffort)
    : NEON_REASONING_EFFORT;
}
/** How long one paid call waits: BlockRun's own `maxTimeoutSeconds`. */
export const NEON_CALL_TIMEOUT_MS = 300_000;

/**
 * What BlockRun quotes for a request body of `bytes` that asks for `outputTokens`, as its
 * `exact` scheme prices it: (input estimate at $3 + output cap at $15 per million) plus 5%,
 * at least $0.002. An estimate: the live 402 is the price, and is checked against the job's
 * ceiling before anything is signed.
 */
export function neonPeakQuoteAtomic(
  bytes: number,
  outputTokens: number,
  model: NeonModelId = neonModel(),
): bigint {
  const input = BigInt(Math.ceil(bytes / NEON_BYTES_PER_INPUT_TOKEN));
  const price = NEON_MODELS[model];
  // A model's list price per million tokens is its atomic USDC per token, in thousandths here.
  const raw = (input * price.inMilli + BigInt(outputTokens) * price.outMilli + 999n) / 1000n;
  const quoted = (raw * NEON_FEE_PERCENT + 99n) / 100n;
  return quoted < NEON_MINIMUM_CALL_ATOMIC ? NEON_MINIMUM_CALL_ATOMIC : quoted;
}

/** The least job ceiling a Neon job runs under: one floor-sized turn with no body. */
export const NEON_MINIMUM_JOB_ATOMIC = neonPeakQuoteAtomic(0, NEON_TURN_FLOOR_TOKENS);

/**
 * THE LARGEST OUTPUT CAP, FROM `asked` DOWN, WHOSE ESTIMATED QUOTE FITS `remaining` of the job's
 * ceiling, never above {@link NEON_TURN_MAX_TOKENS} and never below the floor. Null when even
 * the floor does not fit: the call is not sent.
 */
export function fittingNeonTokens(bytes: number, asked: number, remaining: bigint): number | null {
  const capped = Math.max(1, Math.min(asked, neonMaxTokens()));
  if (neonPeakQuoteAtomic(bytes, capped) <= remaining) return capped;
  if (
    capped <= NEON_TURN_FLOOR_TOKENS ||
    neonPeakQuoteAtomic(bytes, NEON_TURN_FLOOR_TOKENS) > remaining
  )
    return null;
  let fits = NEON_TURN_FLOOR_TOKENS;
  let over = capped;
  while (over - fits > 1) {
    const middle = Math.floor((fits + over) / 2);
    if (neonPeakQuoteAtomic(bytes, middle) <= remaining) fits = middle;
    else over = middle;
  }
  return fits;
}

/**
 * THE GEMINI THOUGHT SIGNATURES A REPLY CARRIES ON ITS TOOL CALLS. Google requires them to
 * come back with the tool call in the next request. The chat completions format names them
 * `extra_content.google.thought_signature` on a tool call (Google's own OpenAI-compatible
 * endpoint); BlockRun's documentation says nothing about its own, so whatever extra fields a
 * tool call (or its message) carries beyond the OpenAI ones are kept as they came, by the
 * tool call's id, and put back on that call unchanged. Claude Code does not return unknown
 * fields of a `tool_use` block, so the bridge keeps them here, for the job.
 */
export type ThoughtCarry = Record<string, Record<string, unknown>>;

/** The OpenAI fields of a tool call; any other field is kept as the provider sent it. */
const TOOL_CALL_FIELDS = new Set(['id', 'type', 'function', 'index']);
/** The OpenAI fields of an assistant message; others (the thought fields) are kept. */
const MESSAGE_FIELDS = new Set([
  'role',
  'content',
  'tool_calls',
  'refusal',
  'annotations',
  'audio',
  'function_call',
  'reasoning_content',
  'reasoning',
]);

/** Carry keys of a whole assistant message are stored under this prefix of its first call id. */
const MESSAGE_KEY = 'message:';

/** Set to 1 to keep each Neon call's raw stream and its request (sizes only for the prompt). */
export const NEON_CAPTURE_ENV = 'TENJIN_NEON_CAPTURE';

export type ChatBody = {
  model: string;
  max_tokens: number;
  /** Streamed: bytes flow while the model thinks and writes, so no gateway idle limit cuts a long turn. */
  stream: boolean;
  reasoning_effort?: string;
  stream_options?: { include_usage: true };
  messages: Record<string, unknown>[];
  tools?: Record<string, unknown>[];
  stop?: string[];
};

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (!isRecord(part)) return '';
      if (part.type === 'text' && typeof part.text === 'string') return part.text;
      // Anything else a result block holds (an image) was replaced with text before this.
      return '';
    })
    .filter((text) => text.length > 0)
    .join('\n');
}

/**
 * THE BRIDGE'S MESSAGES BODY AS A CHAT COMPLETIONS REQUEST. `body` is what the worker's own
 * normalizer produced (`workerMessages`): text, thinking, tool_use and tool_result blocks,
 * client tools, an optional system prompt. Thinking blocks are not sent back: the model's
 * own thought is not carried by the chat format, only the signatures kept in `carry`.
 */
export function chatBody(
  asked: Record<string, unknown>,
  carry: ThoughtCarry,
  maxTokens: number,
  /** A seller whose real charge comes on the response header asks for a plain reply. */
  stream = true,
): ChatBody {
  const body = hoistedForNeon(asked);
  const messages: Record<string, unknown>[] = [];
  const system = textOf(body.system);
  if (system) messages.push({ role: 'system', content: system });
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    if (!isRecord(message)) continue;
    const blocks: unknown[] =
      typeof message.content === 'string'
        ? [{ type: 'text', text: message.content }]
        : Array.isArray(message.content)
          ? message.content
          : [];
    if (message.role === 'assistant') {
      const text = blocks
        .filter((b) => isRecord(b) && b.type === 'text' && typeof b.text === 'string')
        .map((b) => (b as { text: string }).text)
        .join('');
      const calls = blocks.flatMap((b) => {
        if (!isRecord(b) || b.type !== 'tool_use' || typeof b.id !== 'string') return [];
        return [
          {
            id: b.id,
            type: 'function',
            function: { name: String(b.name ?? ''), arguments: JSON.stringify(b.input ?? {}) },
            ...(carry[b.id] ?? {}),
          },
        ];
      });
      const first = calls[0]?.id;
      messages.push({
        role: 'assistant',
        content: text.length > 0 ? text : calls.length > 0 ? null : '',
        ...(calls.length > 0 ? { tool_calls: calls } : {}),
        ...(first !== undefined ? (carry[`${MESSAGE_KEY}${first}`] ?? {}) : {}),
      });
      continue;
    }
    // A user message: its tool results come first, as one `tool` message each, then its text.
    for (const b of blocks) {
      if (!isRecord(b) || b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
      // Gemini takes plain text; a result with none is said to have none, not left empty.
      const result = textOf(b.content) || '(no output)';
      messages.push({
        role: 'tool',
        tool_call_id: b.tool_use_id,
        content: b.is_error === true ? `Error: ${result}` : result,
      });
    }
    const text = blocks
      .filter((b) => isRecord(b) && b.type === 'text' && typeof b.text === 'string')
      .map((b) => (b as { text: string }).text)
      .join('\n');
    if (text.length > 0) messages.push({ role: 'user', content: text });
  }
  const tools = Array.isArray(body.tools)
    ? body.tools.flatMap((t) =>
        isRecord(t) && typeof t.name === 'string'
          ? [
              {
                type: 'function',
                function: {
                  name: t.name,
                  ...(typeof t.description === 'string' ? { description: t.description } : {}),
                  parameters: isRecord(t.input_schema) ? t.input_schema : { type: 'object' },
                },
              },
            ]
          : [],
      )
    : [];
  const stop = Array.isArray(body.stop_sequences)
    ? body.stop_sequences.filter((s): s is string => typeof s === 'string').slice(0, 4)
    : [];
  return {
    model: neonModel(),
    max_tokens: maxTokens,
    stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
    ...(neonEffort() === 'omit' ? {} : { reasoning_effort: neonEffort() }),
    messages,
    ...(tools.length > 0 ? { tools } : {}),
    ...(stop.length > 0 ? { stop } : {}),
  };
}

/** What a chat reply's usage says, for the call's record and the Messages usage. */
export type NeonUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  /** Thought tokens inside the output count, where the reply says so. */
  reasoningTokens: number;
};

const count = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;

export function chatUsage(reply: unknown): NeonUsage {
  const usage = isRecord(reply) && isRecord(reply.usage) ? reply.usage : {};
  const details = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {};
  const cached = Math.min(count(details.cached_tokens), count(usage.prompt_tokens));
  return {
    inputTokens: count(usage.prompt_tokens),
    cachedInputTokens: cached,
    outputTokens: count(usage.completion_tokens),
    reasoningTokens: count(
      isRecord(usage.completion_tokens_details)
        ? usage.completion_tokens_details.reasoning_tokens
        : 0,
    ),
  };
}

export class NeonReplyInvalid extends Error {}
/**
 * A reply that ended at the output cap with no text and no tool call: the turn's output went on
 * thought, and nothing can be handed to the worker. Sent again, the same turn would spend the
 * same again, so the job ends here.
 */
export class NeonNoText extends Error {}

const STOP_REASONS: Record<string, string> = {
  stop: 'end_turn',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  length: 'max_tokens',
  content_filter: 'refusal',
};

/**
 * A CHAT COMPLETIONS REPLY AS THE ANTHROPIC MESSAGE THE WORKER'S CHILD READS: its text, its
 * tool calls as `tool_use` blocks, the stop reason and the usage. The thought fields of the
 * reply are put in `carry` (see {@link ThoughtCarry}). A reply with no choice, or with a tool
 * call whose arguments are not a JSON object, is invalid: the call was paid and is not
 * repeated.
 */
export function messageOf(reply: unknown, carry: ThoughtCarry): Record<string, unknown> {
  const choice =
    isRecord(reply) && Array.isArray(reply.choices) && isRecord(reply.choices[0])
      ? reply.choices[0]
      : undefined;
  const message = choice && isRecord(choice.message) ? choice.message : undefined;
  if (!choice || !message) throw new NeonReplyInvalid('The reply has no message');
  const content: Record<string, unknown>[] = [];
  const text = textOf(message.content);
  if (text.length > 0) content.push({ type: 'text', text });
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  let first: string | undefined;
  for (const call of calls) {
    if (!isRecord(call) || !isRecord(call.function) || typeof call.function.name !== 'string')
      throw new NeonReplyInvalid('A tool call has no function name');
    const id =
      typeof call.id === 'string' && call.id.length > 0
        ? call.id
        : `call_${randomBytes(12).toString('hex')}`;
    let input: unknown = {};
    const raw = call.function.arguments;
    if (typeof raw === 'string' && raw.trim().length > 0) {
      try {
        input = JSON.parse(raw);
      } catch {
        throw new NeonReplyInvalid('A tool call has arguments that are not JSON');
      }
    } else if (isRecord(raw)) input = raw;
    if (!isRecord(input))
      throw new NeonReplyInvalid('A tool call has arguments that are not an object');
    const extras = Object.fromEntries(
      Object.entries(call).filter(([key]) => !TOOL_CALL_FIELDS.has(key)),
    );
    if (Object.keys(extras).length > 0) carry[id] = extras;
    first ??= id;
    content.push({ type: 'tool_use', id, name: call.function.name, input });
  }
  if (first !== undefined) {
    const extras = Object.fromEntries(
      Object.entries(message).filter(([key]) => !MESSAGE_FIELDS.has(key)),
    );
    if (Object.keys(extras).length > 0) carry[`${MESSAGE_KEY}${first}`] = extras;
  }
  const usage = chatUsage(reply);
  const finish = typeof choice.finish_reason === 'string' ? choice.finish_reason : 'stop';
  if (content.length === 0 && finish === 'length')
    throw new NeonNoText('The turn reached the output cap with no text');
  const stopReason = content.some((b) => b.type === 'tool_use')
    ? 'tool_use'
    : (STOP_REASONS[finish] ?? 'end_turn');
  return {
    id: `msg_neon_${randomBytes(12).toString('hex')}`,
    type: 'message',
    role: 'assistant',
    model: CLAUDE_DEEPSEEK_MODEL,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: usage.inputTokens - usage.cachedInputTokens,
      output_tokens: usage.outputTokens,
      cache_read_input_tokens: usage.cachedInputTokens,
    },
  };
}

/**
 * A STREAMED CHAT REPLY AS THE WHOLE REPLY. BlockRun answers a `stream: true` call as server-sent
 * `data:` chunks and charges the `exact` quote when output starts. The chunks are folded into
 * the one message a non-streamed reply carries: text, tool calls by index (their arguments
 * come in pieces) with any extra fields kept as they came, the finish reason and the usage.
 * A body that is plain JSON is read as one reply, and a chunk that carries an error is invalid.
 */
export function replyOfBody(text: string): unknown {
  if (!/^\s*(data:|:|event:)/.test(text)) {
    try {
      return JSON.parse(text);
    } catch {
      throw new NeonReplyInvalid('The reply is neither JSON nor a stream');
    }
  }
  let content = '';
  let reasoning = '';
  let finish: string | undefined;
  let usage: unknown;
  const calls = new Map<number, Record<string, unknown>>();
  const extras: Record<string, unknown> = {};
  const merge = (into: Record<string, unknown>, from: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(from)) {
      const old = into[key];
      into[key] = isRecord(old) && isRecord(value) ? merge({ ...old }, value) : (value ?? old);
    }
    return into;
  };
  for (const line of text.split('\n')) {
    const payload = /^data:\s?(.*)$/.exec(line.replace(/\r$/, ''))?.[1];
    if (payload === undefined || payload.trim() === '' || payload.trim() === '[DONE]') continue;
    let chunk: unknown;
    try {
      chunk = JSON.parse(payload);
    } catch {
      continue;
    }
    if (!isRecord(chunk)) continue;
    if (chunk.error !== undefined) throw new NeonReplyInvalid('The stream carried an error');
    if (chunk.usage !== undefined && chunk.usage !== null) usage = chunk.usage;
    const choice =
      Array.isArray(chunk.choices) && isRecord(chunk.choices[0]) ? chunk.choices[0] : undefined;
    if (!choice) continue;
    if (typeof choice.finish_reason === 'string') finish = choice.finish_reason;
    const delta = isRecord(choice.delta) ? choice.delta : {};
    if (typeof delta.content === 'string') content += delta.content;
    // Some chat endpoints send content as an array of parts.
    else if (Array.isArray(delta.content))
      for (const part of delta.content)
        if (isRecord(part) && typeof part.text === 'string' && part.thought !== true)
          content += part.text;
    for (const key of ['reasoning_content', 'reasoning'] as const)
      if (typeof delta[key] === 'string') reasoning += delta[key];
    for (const [key, value] of Object.entries(delta))
      if (!MESSAGE_FIELDS.has(key))
        extras[key] =
          isRecord(extras[key]) && isRecord(value)
            ? merge({ ...(extras[key] as Record<string, unknown>) }, value)
            : value;
    for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      if (!isRecord(call)) continue;
      const index = typeof call.index === 'number' ? call.index : calls.size;
      const held = calls.get(index) ?? { type: 'function', function: { name: '', arguments: '' } };
      const fn = held.function as { name: string; arguments: string };
      if (typeof call.id === 'string' && call.id.length > 0) held.id = call.id;
      if (isRecord(call.function)) {
        if (typeof call.function.name === 'string') fn.name += call.function.name;
        if (typeof call.function.arguments === 'string') fn.arguments += call.function.arguments;
      }
      for (const [key, value] of Object.entries(call))
        if (!TOOL_CALL_FIELDS.has(key))
          held[key] =
            isRecord(held[key]) && isRecord(value)
              ? merge({ ...(held[key] as Record<string, unknown>) }, value)
              : value;
      calls.set(index, held);
    }
  }
  const tool_calls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
  return {
    choices: [
      {
        finish_reason: finish ?? 'stop',
        message: {
          role: 'assistant',
          content: content.length > 0 ? content : null,
          // Kept for the capture and the count: never handed to the worker.
          ...(reasoning.length > 0 ? { reasoning_content: reasoning } : {}),
          ...(tool_calls.length > 0 ? { tool_calls } : {}),
          ...extras,
        },
      },
    ],
    ...(usage !== undefined ? { usage } : {}),
  };
}

/**
 * THE REQUEST AS A CAPTURE KEEPS IT: the system prompt and the tools, which are large and the
 * same each turn, as their sizes; the messages, the tool results among them, as sent.
 */
export function capturedRequest(body: ChatBody): Record<string, unknown> {
  const size = (value: unknown) => {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    return { bytes, approxTokens: Math.ceil(bytes / 4) };
  };
  return {
    ...body,
    messages: body.messages.map((m) =>
      m.role === 'system' ? { role: 'system', content: size(m.content) } : m,
    ),
    ...(body.tools ? { tools: { count: body.tools.length, ...size(body.tools) } } : {}),
  };
}

/**
 * THE MESSAGES ROUTE: BlockRun's Anthropic-compatible `POST /api/v1/messages`. The worker already
 * speaks Messages, so its request passes through nearly as it is and BlockRun's reply is read back
 * as the Messages message the worker expects. It is the default; the chat completions route above
 * stays selectable with `TENJIN_NEON_ROUTE=chat` for the evaluation only.
 */
export const NEON_MESSAGES_URL = `${NEON_ORIGIN}/api/v1/messages`;
export const NEON_ROUTE_ENV = 'TENJIN_NEON_ROUTE';
export function neonRoute(env: NodeJS.ProcessEnv = process.env): 'messages' | 'chat' {
  return env[NEON_ROUTE_ENV] === 'chat' ? 'chat' : 'messages';
}
/**
 * THE THINKING BUDGET OF ONE TURN, well under the output cap so visible text keeps room: thought
 * tokens count as output, and turns capped at 8,192 spent all of it thinking. BlockRun's schema
 * for the route does not list `thinking`, so whether it is honoured is checked by the first run.
 */
export const NEON_THINKING_BUDGET_TOKENS = 2_048;
/** Anthropic's least budget; a turn whose cap leaves less than this above it asks for no thinking. */
const NEON_THINKING_BUDGET_FLOOR = 1_024;

export function messagesRequest(
  asked: Record<string, unknown>,
  maxTokens: number,
): Record<string, unknown> {
  const body = hoistedForNeon(asked);
  // The worker's own `thinking` is replaced by the budget below.
  const rest = Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'thinking'));
  // The budget stays below the cap by at least the floor, so a stepped-down turn still writes.
  const effort = neonEffort();
  const wanted = {
    minimal: NEON_THINKING_BUDGET_FLOOR,
    low: NEON_THINKING_BUDGET_TOKENS,
    medium: 4_096,
    high: 8_192,
    none: 0,
    omit: 0,
  }[effort];
  const budget = Math.min(wanted, maxTokens - NEON_THINKING_BUDGET_FLOOR);
  return {
    ...rest,
    model: neonModel(),
    max_tokens: maxTokens,
    stream: true,
    ...(effort === 'none'
      ? { thinking: { type: 'disabled' } }
      : effort !== 'omit' && budget >= NEON_THINKING_BUDGET_FLOOR
        ? { thinking: { type: 'enabled', budget_tokens: budget } }
        : {}),
  };
}

/** The request as a capture keeps it: the system prompt and tools as sizes. */
export function capturedMessagesRequest(body: Record<string, unknown>): Record<string, unknown> {
  const size = (value: unknown) => {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    return { bytes, approxTokens: Math.ceil(bytes / 4) };
  };
  return {
    ...body,
    ...(body.system !== undefined ? { system: size(body.system) } : {}),
    ...(Array.isArray(body.tools)
      ? { tools: { count: body.tools.length, ...size(body.tools) } }
      : {}),
  };
}

const tokens = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;

/**
 * BLOCKRUN'S ANTHROPIC EVENT STREAM AS THE ONE MESSAGE THE WORKER EXPECTS: text, `tool_use`
 * (its input arrives as JSON pieces), thinking blocks with their `signature` as BlockRun sent
 * them, the stop reason and the usage. A body that is already a message is taken as it is. An
 * `error` event, or a stream that never began a message, is invalid.
 */
export function messageOfStream(text: string): {
  message: Record<string, unknown>;
  usage: NeonUsage;
} {
  let start: Record<string, unknown> | undefined;
  const blocks = new Map<number, Record<string, unknown>>();
  const pieces = new Map<number, string>();
  let stop: Record<string, unknown> = {};
  let usage: Record<string, unknown> = {};
  const events: Record<string, unknown>[] = [];
  if (!/^\s*(data:|event:|:)/.test(text)) {
    let whole: unknown;
    try {
      whole = JSON.parse(text);
    } catch {
      throw new NeonReplyInvalid('The reply is neither JSON nor a stream');
    }
    if (!isRecord(whole) || whole.type !== 'message')
      throw new NeonReplyInvalid('The reply is not a message');
    events.push({ type: 'whole', whole });
  } else {
    for (const line of text.split('\n')) {
      const payload = /^data:\s?(.*)$/.exec(line.replace(/\r$/, ''))?.[1];
      if (payload === undefined || payload.trim() === '' || payload.trim() === '[DONE]') continue;
      try {
        const event: unknown = JSON.parse(payload);
        if (isRecord(event)) events.push(event);
      } catch {
        // A line that is not an event is ignored.
      }
    }
  }
  for (const event of events) {
    const index = typeof event.index === 'number' ? event.index : 0;
    switch (event.type) {
      case 'error':
        throw new NeonReplyInvalid('The stream carried an error');
      case 'whole': {
        const whole = event.whole as Record<string, unknown>;
        start = whole;
        (Array.isArray(whole.content) ? whole.content : []).forEach((block, i) => {
          if (isRecord(block)) blocks.set(i, { ...block });
        });
        stop = whole;
        usage = isRecord(whole.usage) ? whole.usage : {};
        break;
      }
      case 'message_start':
        if (isRecord(event.message)) {
          start = event.message;
          if (isRecord(event.message.usage)) usage = { ...event.message.usage };
        }
        break;
      case 'content_block_start':
        if (isRecord(event.content_block)) blocks.set(index, { ...event.content_block });
        break;
      case 'content_block_delta': {
        const block = blocks.get(index);
        const delta = isRecord(event.delta) ? event.delta : {};
        if (!block) break;
        const join = (key: string, add: unknown) => {
          if (typeof add === 'string')
            block[key] = `${typeof block[key] === 'string' ? block[key] : ''}${add}`;
        };
        if (delta.type === 'text_delta') join('text', delta.text);
        else if (delta.type === 'thinking_delta') join('thinking', delta.thinking);
        else if (delta.type === 'signature_delta') join('signature', delta.signature);
        else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string')
          pieces.set(index, `${pieces.get(index) ?? ''}${delta.partial_json}`);
        break;
      }
      case 'message_delta':
        if (isRecord(event.delta)) stop = event.delta;
        if (isRecord(event.usage)) usage = { ...usage, ...event.usage };
        break;
      default:
    }
  }
  if (!start) throw new NeonReplyInvalid('The stream never began a message');
  const content = [...blocks.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, block]) => {
      if (block.type !== 'tool_use') return block;
      const raw = pieces.get(index);
      let input: unknown = isRecord(block.input) ? block.input : {};
      if (raw !== undefined && raw.trim() !== '') {
        try {
          input = JSON.parse(raw);
        } catch {
          throw new NeonReplyInvalid('A tool call has arguments that are not JSON');
        }
      }
      if (!isRecord(input))
        throw new NeonReplyInvalid('A tool call has arguments that are not an object');
      return { ...block, input };
    });
  const cached = tokens(usage.cache_read_input_tokens);
  const written = tokens(usage.cache_creation_input_tokens);
  return {
    message: {
      id: typeof start.id === 'string' ? start.id : `msg_neon_${randomBytes(12).toString('hex')}`,
      type: 'message',
      role: 'assistant',
      model: CLAUDE_DEEPSEEK_MODEL,
      content,
      stop_reason: typeof stop.stop_reason === 'string' ? stop.stop_reason : 'end_turn',
      stop_sequence: typeof stop.stop_sequence === 'string' ? stop.stop_sequence : null,
      usage: {
        input_tokens: tokens(usage.input_tokens),
        output_tokens: tokens(usage.output_tokens),
        ...(cached > 0 ? { cache_read_input_tokens: cached } : {}),
        ...(written > 0 ? { cache_creation_input_tokens: written } : {}),
      },
    },
    usage: {
      inputTokens: tokens(usage.input_tokens) + cached + written,
      cachedInputTokens: cached,
      outputTokens: tokens(usage.output_tokens),
      reasoningTokens: tokens(usage.thinking_tokens ?? usage.reasoning_tokens),
    },
  };
}

/** A turn that ended at the cap with no text and no tool call: its output went on thought. */
export function messageHasNoText(message: Record<string, unknown>): boolean {
  const content = Array.isArray(message.content) ? message.content : [];
  const wrote = content.some(
    (b) =>
      isRecord(b) &&
      ((b.type === 'text' && typeof b.text === 'string' && b.text.length > 0) ||
        b.type === 'tool_use'),
  );
  return !wrote && message.stop_reason === 'max_tokens';
}

/** How the text that came beside a tool result is introduced once it is moved to the system prompt. */
export const NEON_BESIDE_RESULT_LABEL =
  'Text that arrived in the same message as a tool result (not part of the result):';

/**
 * THE REQUEST SHAPE BLOCKRUN'S GEMINI TAKES. Two shapes in Claude Code's own requests made Neon
 * produce nothing (live replays, 2026-11-23):
 *
 * - A `role: "system"` message inside `messages`, which Claude Code adds mid-conversation and
 *   after tool results: Gemini then spent its whole output cap on hidden thought and wrote no
 *   text. Every such message moves, in order, to the top-level `system`, after the real one.
 * - Text in the same user message as a `tool_result` block: the tool result was lost. The text
 *   moves to `system` too, after the hoisted system text and under a label, and the tool
 *   results stay alone in their message.
 *
 * A user message with no tool result keeps its text. Turns still alternate: messages left side
 * by side with one role are joined, and text that would land beside a tool result is hoisted
 * instead. Thinking blocks, tool calls and any cache control on the system blocks are kept.
 */
export function hoistedForNeon(body: Record<string, unknown>): Record<string, unknown> {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const asBlocks = (content: unknown): Record<string, unknown>[] =>
    typeof content === 'string'
      ? [{ type: 'text', text: content }]
      : Array.isArray(content)
        ? content.filter(isRecord)
        : [];
  const isResult = (b: Record<string, unknown>) => b.type === 'tool_result';
  const system: Record<string, unknown>[] = asBlocks(body.system);
  const labelled: Record<string, unknown>[] = [];
  const out: { role: unknown; content: Record<string, unknown>[] }[] = [];
  const hoistedSystem: Record<string, unknown>[] = [];
  let moved = false;
  for (const message of messages) {
    if (!isRecord(message)) continue;
    const blocks = asBlocks(message.content);
    const last = out.at(-1);
    if (message.role === 'system') {
      hoistedSystem.push(...blocks);
      moved = true;
      continue;
    }
    if (message.role === 'user') {
      const results = blocks.filter(isResult);
      const rest = blocks.filter((b) => !isResult(b));
      const afterResult = last?.role === 'user' && last.content.some(isResult);
      if (results.length > 0 || afterResult) {
        if (rest.length > 0) {
          labelled.push(...rest);
          moved = true;
        }
        if (results.length > 0 && last?.role === 'user') last.content.push(...results);
        else if (results.length > 0) out.push({ role: 'user', content: results });
        continue;
      }
    }
    if (last && last.role === message.role) last.content.push(...blocks);
    else out.push({ role: message.role, content: [...blocks] });
  }
  if (!moved) return body;
  const extra = [
    ...hoistedSystem,
    ...(labelled.length > 0 ? [{ type: 'text', text: NEON_BESIDE_RESULT_LABEL }, ...labelled] : []),
  ];
  return {
    ...body,
    system: [...system, ...extra],
    messages: out.filter((m) => m.content.length > 0),
  };
}

/**
 * WHERE A CALL'S INPUT TOKENS WENT: its system part, its tools and its messages. The seller
 * reports one input total, so the total is shared by the bytes of each part (the system text,
 * the tools as JSON, the rest). Where no total was reported, a byte count over four stands in.
 */
export function inputSplit(
  wire: Record<string, unknown>,
  totalTokens: number,
): { systemTokens: number; toolsTokens: number; messageTokens: number } {
  const size = (value: unknown) =>
    value === undefined || (Array.isArray(value) && value.length === 0)
      ? 0
      : Buffer.byteLength(JSON.stringify(value));
  const messages = Array.isArray(wire.messages) ? wire.messages : [];
  const isSystem = (m: unknown) => isRecord(m) && m.role === 'system';
  const systemBytes = size(wire.system) + size(messages.filter(isSystem));
  const toolsBytes = size(wire.tools);
  const messageBytes = size(messages.filter((m) => !isSystem(m)));
  const all = systemBytes + toolsBytes + messageBytes;
  const total = totalTokens > 0 ? totalTokens : Math.ceil(all / 4);
  const share = (bytes: number) => (all === 0 ? 0 : Math.round((total * bytes) / all));
  return {
    systemTokens: share(systemBytes),
    toolsTokens: share(toolsBytes),
    messageTokens: share(messageBytes),
  };
}
