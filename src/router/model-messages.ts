import { z } from 'zod';
import { isRecord } from '../lib/guards';
import { MODEL_MESSAGES_MAX_TOOLS, MODEL_OUTPUT_TOKENS } from './model-limits';
/** The proxy's blocks, and the two of Tenjin's own answer to a worker's web search. */
const block = z.object({
  type: z.enum(['text', 'thinking', 'tool_use', 'server_tool_use', 'web_search_tool_result']),
  text: z.string().optional(),
  thinking: z.string().optional(),
  signature: z.string().optional(),
  id: z.string().optional(),
  name: z.string().optional(),
  input: z.record(z.string(), z.unknown()).optional(),
  tool_use_id: z.string().optional(),
  content: z.unknown().optional(),
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
    } else if (b.type === 'web_search_tool_result') {
      // The API sends a search's results whole, in the block's start.
      events.push({
        type: 'content_block_start',
        index,
        content_block: { type: b.type, tool_use_id: b.tool_use_id, content: b.content },
      });
    } else {
      events.push(
        {
          type: 'content_block_start',
          index,
          content_block: { type: b.type, id: b.id, name: b.name, input: {} },
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

type Reference = { type: 'tool_reference'; tool_name?: unknown };
const clientTool = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    input_schema: z.record(z.string(), z.unknown()),
    type: z.literal('custom').optional(),
    defer_loading: z.boolean().optional(),
  })
  .passthrough();
/** Claude Code's mid-conversation tool changes: a tool by reference, or defined in the block. */
const toolChange = z.object({
  type: z.enum(['tool_addition', 'tool_removal']),
  tool: z.union([
    z.object({ type: z.literal('tool_reference'), name: z.string() }),
    z.object({ type: z.literal('tool_definition'), definition: clientTool }),
  ]),
});

/** A request that offers more tools than the router takes: every model call would fail. */
export class TooManyTools extends Error {
  constructor(readonly count: number) {
    super(`The request offers ${count} tools; the router takes ${MODEL_MESSAGES_MAX_TOOLS}`);
  }
}

/** Only protocol fields supported by our fixed proxy. No URLs, auth or billable server tools. */
export function workerMessages(raw: Record<string, unknown>) {
  if (raw.model !== 'deepseek-flash') throw new Error('Worker attempted another model');
  // THINKING IS ON FOR EVERY TURN OF THE WORKER, as the DeepSeek harness has it, whatever
  // the request asks: Claude Code sends a turn with no `thinking` field when the person's
  // own settings or env turn thinking off (`MAX_THINKING_TOKENS=0`,
  // `alwaysThinkingEnabled: false`, `CLAUDE_CODE_DISABLE_THINKING`), and the worker's
  // settings cannot outrank a managed policy that does. A worker's turn is streamed or
  // offers tools. A SIDE REQUEST does neither, such as the auto-mode classifier's two
  // (2,112 output tokens with the `</block>` stop sequence, then 10,240): it stays as it
  // asks, without thinking unless it asks for it, so a small review budget is not spent
  // on hidden thinking instead of the classifier's verdict.
  const asked =
    raw.thinking === undefined
      ? 'disabled'
      : z.object({ type: z.enum(['enabled', 'adaptive', 'disabled']) }).parse(raw.thinking).type;
  const mode = raw.stream === true || raw.tools !== undefined ? 'enabled' : asked;
  const stopSequences =
    raw.stop_sequences === undefined
      ? undefined
      : z.array(z.string().min(1).max(256)).max(16).parse(raw.stop_sequences);
  const declared = raw.tools === undefined ? undefined : z.array(clientTool).parse(raw.tools);
  // Tool search, as the Messages API serves it: a deferred tool is left out until a
  // ToolSearch result names it in a `tool_reference`, then it can be called, and the
  // result reads as the tool's definition in Claude Code's own text form of it. Neither
  // the proxy nor DeepSeek takes deferred tools or `tool_reference` blocks.
  const loaded = new Set<string>();
  const isReference = (b: unknown) => isRecord(b) && b.type === 'tool_reference';
  const loadTools = (blocks: unknown[]): unknown[] => {
    const names = blocks.filter(isReference).map((b) => String((b as Reference).tool_name));
    if (!names.length) return blocks;
    const functions = names.map((name) => {
      loaded.add(name);
      const tool = declared?.find((t) => t.name === name);
      return tool
        ? `\n<function>${JSON.stringify({ description: tool.description, name, parameters: tool.input_schema })}</function>`
        : '';
    });
    return [
      ...blocks.filter((b) => !isReference(b)),
      { type: 'text', text: `<functions>${functions.join('')}\n</functions>` },
    ];
  };
  // TOOL CHANGES IN A MESSAGE, as Claude Code 2.1.327 announces a tool whose MCP server
  // connected after the first request: a `tool_addition` or `tool_removal` block in a
  // system message, with the tool declared as deferred or defined in the block. Neither
  // the proxy nor DeepSeek takes those blocks: the router refused the whole request with
  // `invalid_model_request` (400) and the job ended. The change is applied to the tools
  // this request offers, in message order, and the block is left out.
  const removed = new Set<string>();
  const defined: z.infer<typeof clientTool>[] = [];
  const isToolChange = (b: unknown) =>
    isRecord(b) && (b.type === 'tool_addition' || b.type === 'tool_removal');
  const applyToolChanges = (blocks: unknown[]) => {
    for (const block of blocks.filter(isToolChange)) {
      const change = toolChange.parse(block);
      const name =
        change.tool.type === 'tool_reference' ? change.tool.name : change.tool.definition.name;
      if (change.type === 'tool_removal') {
        loaded.delete(name);
        removed.add(name);
        continue;
      }
      removed.delete(name);
      loaded.add(name);
      if (change.tool.type === 'tool_definition' && !declared?.some((t) => t.name === name)) {
        const at = defined.findIndex((t) => t.name === name);
        if (at >= 0) defined.splice(at, 1);
        defined.push(change.tool.definition);
      }
    }
  };
  const clearBlocks = (value: unknown): unknown => {
    if (!Array.isArray(value)) return value;
    applyToolChanges(value);
    return value
      .filter((b) => !isToolChange(b))
      .map((b) => {
        if (
          !b ||
          typeof b !== 'object' ||
          !['text', 'thinking', 'tool_use', 'tool_result'].includes(String(b.type))
        )
          return b;
        const kept = { ...b };
        delete kept.cache_control;
        if (kept.type !== 'tool_result') return kept;
        const content = clearBlocks(kept.content);
        return { ...kept, content: Array.isArray(content) ? loadTools(content) : content };
      });
  };
  const messages = Array.isArray(raw.messages)
    ? raw.messages
        .map((m) => ({ ...m, content: clearBlocks(m.content) }))
        // A message that held only tool changes has nothing left to say.
        .filter((m, index) => {
          const before = (raw.messages as { content?: unknown }[])[index]?.content;
          return !(Array.isArray(before) && before.length > 0 && m.content.length === 0);
        })
    : raw.messages;
  const offered = declared || defined.length ? [...(declared ?? []), ...defined] : undefined;
  const tools = offered
    ?.filter((t) => (t.defer_loading !== true || loaded.has(t.name)) && !removed.has(t.name))
    .map((t) => ({
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      input_schema: t.input_schema,
    }));
  // Counted as sent: a deferred tool not yet loaded is not offered.
  if (tools && tools.length > MODEL_MESSAGES_MAX_TOOLS) throw new TooManyTools(tools.length);
  return {
    model: 'deepseek-flash',
    max_tokens:
      raw.max_tokens === undefined
        ? 16384
        : z.number().int().min(1).max(MODEL_OUTPUT_TOKENS).parse(raw.max_tokens),
    thinking: { type: mode === 'adaptive' ? 'enabled' : mode },
    ...(stopSequences ? { stop_sequences: stopSequences } : {}),
    messages,
    ...(raw.system !== undefined ? { system: clearBlocks(raw.system) } : {}),
    ...(tools ? { tools } : {}),
  };
}
