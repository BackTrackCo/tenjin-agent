import { decode, splitWebrun } from '../adapters/codex-wire';
import type { HookEvent } from './hooks';

/**
 * A Codex hook event as the router's arms read it: the root session's prompt,
 * and any `webrun` call holding a plain search or a URL open, read as that one
 * entry ({@link splitWebrun}) with the rest of the call beside it. A child's
 * task is ciphertext. Everything else is null. Codex has no
 * PostToolUseFailure and returns one text for the whole call, so the
 * after-call arm reads a shortfall only from an empty result.
 */
export function codexRouterEvent(raw: unknown): HookEvent | null {
  const input = decode(raw);
  if (input === null || input.agent !== undefined || input.session.length > 200) return null;
  const common = {
    sessionId: input.session,
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.transcript?.path !== undefined ? { transcriptPath: input.transcript.path } : {}),
  };
  if (input.event === 'prompt' && input.prompt !== undefined)
    return { kind: 'prompt', ...common, prompt: input.prompt };
  const tool = input.tool;
  const toolInput = (raw as { tool_input?: unknown }).tool_input;
  if (tool?.name !== 'webrun' || toolInput === null || typeof toolInput !== 'object') return null;
  const split = splitWebrun(toolInput as Record<string, unknown>);
  if (split === null) return null;
  const call = {
    ...common,
    tool: split.entry.tool,
    pending: split.entry,
    ...(split.rest !== null ? { rest: split.rest } : {}),
    targets: split.targets,
    ...(tool.callId !== undefined ? { toolUseId: tool.callId } : {}),
  };
  if (input.event === 'tool.before') return { kind: 'native', ...call };
  if (input.event !== 'tool.after') return null;
  const text = tool.result?.text;
  return {
    kind: 'shortfall',
    ...call,
    eventName: 'PostToolUse',
    nativeOutcome: text === '' ? { error: 'Web search returned no results' } : null,
    search:
      text === undefined || split.entry.tool !== 'WebSearch' ? null : { raw: {}, results: [] },
    savedPdf: null,
  };
}

/** Where a Codex session's local state lives, never shared with Claude's. */
export function codexSession(sessionId: string): string {
  return `codex:${sessionId}`;
}

/**
 * Codex cannot replace a tool's output, so free docs ride beside the result as
 * `additionalContext`, and nothing else in a Claude-shaped answer survives.
 */
export function codexResponse(response: unknown): unknown {
  if (response === null || typeof response !== 'object') return null;
  const output = (response as { hookSpecificOutput?: Record<string, unknown> }).hookSpecificOutput;
  if (output === undefined) return null;
  if (output.updatedToolOutput !== undefined) {
    const results = (output.updatedToolOutput as { results?: unknown[] }).results;
    if (typeof results?.[0] !== 'string') return null;
    return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: results[0] } };
  }
  return { hookSpecificOutput: output };
}
