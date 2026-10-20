import { decode } from '../adapters/codex-wire';
import type { HookEvent } from './hooks';

/**
 * A Codex hook event as the router's arms read it. Only the root session's
 * prompt and one complete, unfiltered `webrun` search map: a batch cannot be
 * partly denied, and a child's task is ciphertext. Everything else is null.
 * Codex has no PostToolUseFailure, so the after-call arm reads a failed search
 * from PostToolUse: an empty result is a shortfall, an unknown shape is not.
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
  if (tool?.kind !== 'web') return null;
  const call = {
    ...common,
    tool: 'WebSearch' as const,
    pending: { tool: 'WebSearch' as const, query: tool.query },
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
    search: text === undefined ? null : { raw: {}, results: [] },
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
