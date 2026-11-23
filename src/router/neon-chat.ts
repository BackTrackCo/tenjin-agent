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
export const NEON_MODEL = 'google/gemini-4-neon';
export const NEON_CHAT_URL = `${NEON_ORIGIN}/api/v1/chat/completions`;
/** BlockRun's list prices for Neon, in atomic USDC (millionths of a dollar) per token. */
const NEON_INPUT_ATOMIC_PER_TOKEN = 3n;
const NEON_OUTPUT_ATOMIC_PER_TOKEN = 15n;
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
/** The least a turn is stepped down to when the job's ceiling cannot hold more. */
export const NEON_TURN_FLOOR_TOKENS = 1_024;
/** Bytes of request body counted as one input token in the estimate: an upper bound. */
const NEON_BYTES_PER_INPUT_TOKEN = 3;
/** How long one paid call waits: BlockRun's own `maxTimeoutSeconds`. */
export const NEON_CALL_TIMEOUT_MS = 300_000;

/**
 * What BlockRun quotes for a request body of `bytes` that asks for `outputTokens`, as its
 * `exact` scheme prices it: (input estimate at $3 + output cap at $15 per million) plus 5%,
 * at least $0.002. An estimate: the live 402 is the price, and is checked against the job's
 * ceiling before anything is signed.
 */
export function neonPeakQuoteAtomic(bytes: number, outputTokens: number): bigint {
  const input = BigInt(Math.ceil(bytes / NEON_BYTES_PER_INPUT_TOKEN));
  const raw =
    input * NEON_INPUT_ATOMIC_PER_TOKEN + BigInt(outputTokens) * NEON_OUTPUT_ATOMIC_PER_TOKEN;
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
  const capped = Math.max(1, Math.min(asked, NEON_TURN_MAX_TOKENS));
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

export type ChatBody = {
  model: string;
  max_tokens: number;
  /** Streamed: bytes flow while the model thinks and writes, so no gateway idle limit cuts a long turn. */
  stream: true;
  stream_options: { include_usage: true };
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
  body: Record<string, unknown>,
  carry: ThoughtCarry,
  maxTokens: number,
): ChatBody {
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
      const result = textOf(b.content);
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
    model: NEON_MODEL,
    max_tokens: maxTokens,
    stream: true,
    stream_options: { include_usage: true },
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
  };
}

export class NeonReplyInvalid extends Error {}

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
          ...(tool_calls.length > 0 ? { tool_calls } : {}),
          ...extras,
        },
      },
    ],
    ...(usage !== undefined ? { usage } : {}),
  };
}
