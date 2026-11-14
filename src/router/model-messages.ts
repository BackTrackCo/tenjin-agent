import { z } from 'zod';
const block = z.object({
  type: z.enum(['text', 'thinking', 'tool_use']),
  text: z.string().optional(),
  thinking: z.string().optional(),
  signature: z.string().optional(),
  id: z.string().optional(),
  name: z.string().optional(),
  input: z.record(z.string(), z.unknown()).optional(),
});
const messageSchema = z
  .object({
    id: z.string(),
    type: z.literal('message'),
    role: z.literal('assistant'),
    model: z.string(),
    content: z.array(block),
    stop_reason: z.string().nullable(),
    stop_sequence: z.string().nullable(),
    usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).passthrough(),
  })
  .passthrough();

/** The worker asked for SSE but the paid proxy returns completed JSON. Encode
 * that completed message for its SDK parser; never pretend tokens arrived live. */
export function completedMessageSse(raw: unknown): string {
  const m = messageSchema.parse(raw);
  const events: Record<string, unknown>[] = [
    {
      type: 'message_start',
      message: {
        ...m,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { ...m.usage, output_tokens: 0 },
      },
    },
  ];
  m.content.forEach((b, index) => {
    if (b.type === 'text') {
      events.push(
        { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text ?? '' } },
      );
    } else if (b.type === 'thinking') {
      events.push(
        {
          type: 'content_block_start',
          index,
          content_block: { type: 'thinking', thinking: '', signature: '' },
        },
        {
          type: 'content_block_delta',
          index,
          delta: { type: 'thinking_delta', thinking: b.thinking ?? '' },
        },
        {
          type: 'content_block_delta',
          index,
          delta: { type: 'signature_delta', signature: b.signature ?? '' },
        },
      );
    } else {
      events.push(
        {
          type: 'content_block_start',
          index,
          content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} },
        },
        {
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input ?? {}) },
        },
      );
    }
    events.push({ type: 'content_block_stop', index });
  });
  events.push(
    {
      type: 'message_delta',
      delta: { stop_reason: m.stop_reason, stop_sequence: m.stop_sequence },
      usage: m.usage,
    },
    { type: 'message_stop' },
  );
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

/** Only protocol fields supported by our fixed proxy. No URLs, auth or billable server tools. */
export function workerMessages(raw: Record<string, unknown>) {
  if (raw.model !== 'deepseek-flash') throw new Error('Worker attempted another model');
  // Native worker turns request adaptive thinking; auto-mode classifier turns
  // omit it. Preserve that distinction so a small review budget is not spent
  // on hidden thinking instead of the native classifier's verdict.
  const mode =
    raw.thinking === undefined
      ? 'disabled'
      : z.object({ type: z.enum(['enabled', 'adaptive', 'disabled']) }).parse(raw.thinking).type;
  const stopSequences =
    raw.stop_sequences === undefined
      ? undefined
      : z.array(z.string().min(1).max(256)).max(16).parse(raw.stop_sequences);
  const clearBlocks = (value: unknown): unknown => {
    if (!Array.isArray(value)) return value;
    return value.map((b) => {
      if (
        !b ||
        typeof b !== 'object' ||
        !['text', 'thinking', 'tool_use', 'tool_result'].includes(String(b.type))
      )
        return b;
      const kept = { ...b };
      delete kept.cache_control;
      return kept.type === 'tool_result' ? { ...kept, content: clearBlocks(kept.content) } : kept;
    });
  };
  const messages = Array.isArray(raw.messages)
    ? raw.messages.map((m) => ({ ...m, content: clearBlocks(m.content) }))
    : raw.messages;
  const tools =
    raw.tools === undefined
      ? undefined
      : z
          .array(
            z
              .object({
                name: z.string(),
                description: z.string().optional(),
                input_schema: z.record(z.string(), z.unknown()),
                type: z.literal('custom').optional(),
              })
              .passthrough(),
          )
          .parse(raw.tools)
          .map((t) => ({
            name: t.name,
            ...(t.description ? { description: t.description } : {}),
            input_schema: t.input_schema,
          }));
  return {
    model: 'deepseek-flash',
    max_tokens:
      raw.max_tokens === undefined
        ? 16384
        : z.number().int().min(1).max(65536).parse(raw.max_tokens),
    thinking: { type: mode === 'adaptive' ? 'enabled' : mode },
    ...(stopSequences ? { stop_sequences: stopSequences } : {}),
    messages,
    ...(raw.system !== undefined ? { system: clearBlocks(raw.system) } : {}),
    ...(tools ? { tools } : {}),
  };
}
