import type { EngineInterface, HookStream, TurnStepChunk, TurnStepResult } from 'claude-code';
import { asRecord as record, subagentsEnabled as enabled, textOf } from './hook-data';
import { nativeRetryReference } from './native-retry-reference';
export { nativeRetryReference } from './native-retry-reference';

type Json = Record<string, unknown>;
type Dollar = EngineInterface;
type NativeTool = 'Agent' | 'Task';
type ToolChunk = Extract<TurnStepChunk, { kind: 'tool' }>;
type InputChunk = Extract<TurnStepChunk, { kind: 'input' }>;

const MAX_BUFFER_BYTES = 512 * 1024;
const MAX_BUFFER_CHUNKS = 4096;
// These are interception observations, not execution authority. Every replay still consumes
// a session/turn/input-bound ticket in the local backend before native dispatch.
const failed = new Map<string, Set<string>>();
const expanded = new Map<string, Set<string>>();
const isNative = (tool: string): tool is NativeTool => tool === 'Agent' || tool === 'Task';

function responseInput(value: unknown, id: string, tool: NativeTool): Json | undefined {
  const reply = record(value);
  const input = record(reply?.input);
  if (
    !reply ||
    Object.keys(reply).some((key) => !['action', 'offer_id', 'tool', 'input'].includes(key)) ||
    reply.action !== 'native_retry' ||
    reply.offer_id !== id ||
    reply.tool !== tool ||
    !input ||
    ['tool', 'tool_use_id', 'agentId', 'agent_id'].some((key) => Object.hasOwn(input, key)) ||
    typeof input.prompt !== 'string' ||
    !input.prompt.trim() ||
    nativeRetryReference(input, tool).owned ||
    input.resume !== undefined ||
    input.run_in_background ||
    input.isolation ||
    input.name ||
    input.team_name ||
    (input.subagent_type !== undefined &&
      (typeof input.subagent_type !== 'string' ||
        !['general-purpose', 'Explore'].includes(input.subagent_type)))
  )
    return undefined;
  return input;
}

function sizeOf(chunk: TurnStepChunk): number {
  if (chunk.kind === 'engine') return 8;
  return new TextEncoder().encode(JSON.stringify(chunk)).length;
}

export function rewriteNativeInputChunks(
  chunks: TurnStepChunk[],
  replacements: Map<number, string>,
) {
  const emitted = new Set<number>();
  return chunks.flatMap((chunk) => {
    const json = chunk.kind === 'input' ? replacements.get(chunk.index) : undefined;
    if (json === undefined || chunk.kind !== 'input') return [chunk];
    if (emitted.has(chunk.index)) return [];
    emitted.add(chunk.index);
    return [{ ...chunk, json }];
  });
}

async function contains($: Dollar, calls: Map<string, Set<string>>, id: unknown) {
  if (!calls.size || typeof id !== 'string') return false;
  try {
    return calls.get(await $.session.id())?.has(id) ?? false;
  } catch {
    // A failed session lookup must not make a known replay ID an ordinary native call.
    return [...calls.values()].some((ids) => ids.has(id));
  }
}

export async function blockedNativeRetry($: Dollar, id: unknown) {
  return contains($, failed, id);
}

export async function expandedNativeRetry($: Dollar, id: unknown) {
  return contains($, expanded, id);
}

async function remember($: Dollar, id: string) {
  const session = await $.session.id();
  const calls = failed.get(session) ?? new Set<string>();
  calls.add(id);
  failed.set(session, calls);
  return () => calls.delete(id);
}
const aliases = (chunks: TurnStepChunk[]) => {
  const tools = chunks.filter(
    (chunk): chunk is ToolChunk => chunk.kind === 'tool' && isNative(chunk.name),
  );
  return tools.map((tool) => {
    const inputs = chunks.filter(
      (chunk): chunk is InputChunk => chunk.kind === 'input' && chunk.index === tool.index,
    );
    let input: Json | undefined;
    try {
      input = record(JSON.parse(inputs.map((chunk) => chunk.json).join('')));
    } catch {
      // The native parser retains its normal malformed-JSON behavior.
    }
    return { tool, inputs, input, ref: input && nativeRetryReference(input, tool.name) };
  });
};
async function normalize($: Dollar, chunks: TurnStepChunk[], permit: boolean) {
  const replacements = new Map<number, string>();
  for (const { tool, input, ref } of aliases(chunks)) {
    if (!ref?.owned || !input) continue;
    let forget: (() => boolean) | undefined;
    try {
      forget = await remember($, tool.id);
      if (!permit || !ref.id || !isNative(tool.name)) continue;
      const response = await $.tool.call({
        tool: 'mcp__plugin_tenjin_router__subagent',
        capture: {
          session_id: await $.session.id(),
          tool_use_id: tool.id,
          input,
          tool: tool.name,
          native_replay: true,
        },
      });
      const text = textOf(response.result) ?? response.text;
      const original = responseInput(JSON.parse(text ?? ''), ref.id, tool.name);
      if (!original) continue;
      const session = await $.session.id();
      const calls = expanded.get(session) ?? new Set<string>();
      calls.add(tool.id);
      expanded.set(session, calls);
      replacements.set(tool.index, JSON.stringify(original));
      forget();
    } catch {
      // The call guard refuses an unresolved marker, even if another mod rewrites its prompt.
    }
  }
  return {
    chunks: rewriteNativeInputChunks(chunks, replacements),
    replacements,
  };
}

/** Normalize model-emitted shortcuts before the engine raises any tool.call guard. */
export async function* normalizeNativeRetry(
  $: Dollar,
  stream: HookStream<TurnStepChunk, TurnStepResult>,
  signal: AbortSignal,
): AsyncGenerator<TurnStepChunk, TurnStepResult> {
  try {
    if (!(await enabled($))) return yield* stream;
  } catch {
    return yield* stream;
  }
  let buffer: TurnStepChunk[] | undefined;
  let bytes = 0;
  let bypass = false;
  const tools: ToolChunk[] = [];
  while (true) {
    const item = await stream.next();
    if (item.done) {
      if (!buffer) return item.value;
      const normalized = await normalize($, buffer, !signal.aborted);
      for (const chunk of normalized.chunks) yield chunk;
      const result = item.value as TurnStepResult;
      // Keep completion observers consistent with the argument chunks the engine receives.
      if (
        result.toolUses.length === tools.length &&
        result.toolUses.every((use, index) => use.name === tools[index]?.name)
      )
        return {
          ...result,
          toolUses: result.toolUses.map((use, index) => {
            const json = normalized.replacements.get(tools[index]!.index);
            return json === undefined ? use : { ...use, input: JSON.parse(json) as unknown };
          }),
        };
      return result;
    }
    const chunk = item.value;
    if (chunk.kind === 'tool') tools.push(chunk);
    if (!buffer && !bypass && chunk.kind === 'tool' && isNative(chunk.name)) buffer = [];
    if (!buffer) {
      yield chunk;
      continue;
    }
    buffer.push(chunk);
    bytes += sizeOf(chunk);
    if (bytes > MAX_BUFFER_BYTES || buffer.length > MAX_BUFFER_CHUNKS) {
      // This is a buffering limit, never a limit on an ordinary native assignment.
      await normalize($, buffer, false);
      for (const original of buffer) yield original;
      buffer = undefined;
      bypass = true;
    }
  }
}

export async function clearNativeRetries($: Dollar) {
  const session = await $.session.id();
  failed.delete(session);
  expanded.delete(session);
}
