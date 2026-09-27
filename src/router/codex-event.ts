import { decode } from '../adapters/codex-wire';
import type { HookEvent } from './hooks';

/** Project the existing Codex adapter onto the current router's event contract.
 * Claude's decoder and policy stay unchanged; no additional native parser. */
export function codexRouterEvent(raw: unknown, webReady: boolean): HookEvent | null {
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
  if (!webReady || tool?.kind !== 'web') return null;
  const call = {
    ...common,
    tool: 'WebSearch' as const,
    pending: { tool: 'WebSearch' as const, query: tool.query },
    ...(tool.callId !== undefined ? { toolUseId: tool.callId } : {}),
  };
  if (input.event === 'tool.before') return { kind: 'native', ...call };
  if (input.event !== 'tool.after') return null;
  // An unknown result shape is not evidence of failure. Keep its native
  // result intact; a completed free-docs prefetch may add context beside it.
  const text = tool.result?.text;
  return {
    kind: 'shortfall',
    ...call,
    eventName: 'PostToolUse',
    nativeOutcome: text === '' ? { error: 'Web search returned no results' } : null,
    search: text === undefined ? null : { raw: {}, results: [] },
  };
}

/** Codex has no qualified updatedToolOutput envelope. Add only the fetched
 * docs as context; never replace or replay the host's web response. */
export function codexResponse(response: unknown): unknown {
  if (response === null || typeof response !== 'object') return null;
  const output = (response as { hookSpecificOutput?: Record<string, unknown> }).hookSpecificOutput;
  if (output === undefined) return null;
  if (output.updatedToolOutput !== undefined) {
    const results = (output.updatedToolOutput as { results?: unknown[] }).results;
    if (typeof results?.[0] !== 'string') return null;
    return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: results[0] } };
  }
  return response;
}
