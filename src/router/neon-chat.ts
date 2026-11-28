import { randomBytes } from 'node:crypto';
import { isRecord } from '../lib/guards';
import { CLAUDE_DEEPSEEK_MODEL } from './claude-model-policy';
import { tokenCostAtomic, type NeonTerms } from './neon-terms';

/**
 * THE NEON WORKER'S WIRE: the worker's local bridge takes Claude Code's Anthropic Messages in and
 * sends chat completions out, and this file is that translation, with no network and no payment
 * in it. The model, the price rule and the usage dialect are the terms of the provider row the
 * job was started under ({@link NeonTerms}); nothing here names a seller, a model or a price.
 */

/**
 * THE OUTPUT CAP OF ONE NEON TURN. Gemini 4 thinks before it writes, and its thought counts as
 * output: 8,192 tokens failed live, so a turn asks for 16,000. The cap is then fitted to what the
 * job, the daily budget and one channel deposit leave (see {@link fittingNeonTokens}).
 */
export const NEON_TURN_MAX_TOKENS = 16_000;
/** The least a turn is stepped down to when the room cannot hold more. */
export const NEON_TURN_FLOOR_TOKENS = 1_024;
/** Bytes of request body counted as one input token in the estimate: an upper bound. */
const NEON_BYTES_PER_INPUT_TOKEN = 2;
/**
 * HOW MUCH GEMINI THINKS BEFORE IT WRITES, as the chat route's `reasoning_effort`. The door's
 * `effort` field names it; with none given it is `low`. Live runs found `low` and `none` change
 * nothing on the seller, and `minimal`, `medium` and `high` are not checked.
 */
export const NEON_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high'] as const;
export type NeonEffort = (typeof NEON_EFFORTS)[number];
export const NEON_DEFAULT_EFFORT: NeonEffort = 'low';
/** How long one paid call waits. */
export const NEON_CALL_TIMEOUT_MS = 300_000;

/**
 * What a request body of `bytes` asking for `outputTokens` can cost at most, by the row's price
 * rule: the input estimate at the input price plus the whole output cap at the output price.
 * An estimate: the seller's own 402 is the price, and is checked against the room before
 * anything is signed.
 */
export function neonPeakQuoteAtomic(
  terms: Pick<NeonTerms, 'inputAtomicPerMillion' | 'outputAtomicPerMillion'>,
  bytes: number,
  outputTokens: number,
): bigint {
  const input = Math.ceil(bytes / NEON_BYTES_PER_INPUT_TOKEN);
  return (
    tokenCostAtomic(input, terms.inputAtomicPerMillion) +
    tokenCostAtomic(outputTokens, terms.outputAtomicPerMillion)
  );
}

/** The least job ceiling a Neon job runs under: one floor-sized turn with no body. */
export const neonMinimumJobAtomic = (terms: Parameters<typeof neonPeakQuoteAtomic>[0]) =>
  neonPeakQuoteAtomic(terms, 0, NEON_TURN_FLOOR_TOKENS);

/**
 * THE LARGEST OUTPUT CAP, FROM `asked` DOWN, WHOSE ESTIMATED QUOTE FITS `room`, never above
 * {@link NEON_TURN_MAX_TOKENS} and never below the floor. Null when even the floor does not fit:
 * the call is not sent.
 */
export function fittingNeonTokens(
  terms: Parameters<typeof neonPeakQuoteAtomic>[0],
  bytes: number,
  asked: number,
  room: bigint,
): number | null {
  const capped = Math.max(1, Math.min(asked, NEON_TURN_MAX_TOKENS));
  if (neonPeakQuoteAtomic(terms, bytes, capped) <= room) return capped;
  if (
    capped <= NEON_TURN_FLOOR_TOKENS ||
    neonPeakQuoteAtomic(terms, bytes, NEON_TURN_FLOOR_TOKENS) > room
  )
    return null;
  let fits = NEON_TURN_FLOOR_TOKENS;
  let over = capped;
  while (over - fits > 1) {
    const middle = Math.floor((fits + over) / 2);
    if (neonPeakQuoteAtomic(terms, bytes, middle) <= room) fits = middle;
    else over = middle;
  }
  return fits;
}

/**
 * THE GEMINI THOUGHT SIGNATURES A REPLY CARRIES ON ITS TOOL CALLS. Google requires them to
 * come back with the tool call in the next request. The chat completions format names them
 * `extra_content.google.thought_signature` on a tool call (Google's own OpenAI-compatible
 * endpoint); other sellers may name them differently, so whatever extra fields a
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

/** Set to 1 to keep each Neon call's raw reply and its request (sizes only for the prompt). */
export const NEON_CAPTURE_ENV = 'TENJIN_NEON_CAPTURE';

export type ChatBody = {
  model: string;
  max_tokens: number;
  /** Never streamed: the seller answers once, with the real charge on the reply's headers. */
  stream: false;
  reasoning_effort?: string;
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
  /** The row's model id, and how much it thinks first. */
  model: string,
  effort: NeonEffort = NEON_DEFAULT_EFFORT,
): ChatBody {
  // NO HOIST ON THIS ROUTE. Gemini 4 caches implicitly, by reusing the whole of the previous
  // request as a prefix. The system message opens the request, so anything moved into it changes
  // the start and loses the cache. It is the real system prompt only, the same bytes on every
  // call of a job; a system message that arrives mid-conversation, and text beside a tool
  // result, stay where they came, as `user` messages after the tool messages of their turn.
  const body = asked;
  const messages: Record<string, unknown>[] = [];
  const system = textOf(body.system);
  if (system) messages.push({ role: 'system', content: system });
  // Text that came between an assistant's tool calls and their results waits for the results.
  const waiting: string[] = [];
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    if (!isRecord(message)) continue;
    const blocks: unknown[] =
      typeof message.content === 'string'
        ? [{ type: 'text', text: message.content }]
        : Array.isArray(message.content)
          ? message.content
          : [];
    if (message.role === 'system' && messages.at(-1)?.tool_calls !== undefined) {
      const held = blocks
        .filter((b) => isRecord(b) && b.type === 'text' && typeof b.text === 'string')
        .map((b) => (b as { text: string }).text)
        .join('\n');
      if (held.length > 0) waiting.push(held);
      continue;
    }
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
    for (const held of waiting.splice(0)) messages.push({ role: 'user', content: held });
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
    model,
    max_tokens: maxTokens,
    stream: false,
    reasoning_effort: effort,
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

export function chatUsage(reply: unknown, dialect: NeonTerms['usage'] = 'standard'): NeonUsage {
  const usage = isRecord(reply) && isRecord(reply.usage) ? reply.usage : {};
  const details = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {};
  // The standard field wins when it says anything. The `nanogpt` dialect bills a cache hit at
  // the cached rate but reports it in a block of its own, with the standard fields left at 0.
  const own =
    dialect === 'nanogpt' &&
    isRecord(reply) &&
    isRecord(reply.x_nanogpt_cache) &&
    reply.x_nanogpt_cache.status === 'hit'
      ? count(reply.x_nanogpt_cache.readTokens)
      : 0;
  const standard = count(details.cached_tokens);
  const cached = Math.min(standard > 0 ? standard : own, count(usage.prompt_tokens));
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

/** The seller's reply body as the one reply it carries. */
export function replyOfBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new NeonReplyInvalid('The reply is not JSON');
  }
}
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
export function messageOf(
  reply: unknown,
  carry: ThoughtCarry,
  dialect: NeonTerms['usage'] = 'standard',
): Record<string, unknown> {
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
  const usage = chatUsage(reply, dialect);
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
