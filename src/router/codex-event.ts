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
    savedPdf: null,
  };
}

/** Where a Codex session's local state lives, never shared with Claude's. */
export function codexSession(sessionId: string): string {
  return `codex:${sessionId}`;
}

/**
 * A Claude-shaped answer as Codex takes it: `hookSpecificOutput` as it is (a
 * deny, or a line after the call in `additionalContext`, such as a free
 * lookup noted on a search), and `systemMessage`, the line for the user (an
 * unpaid routing fee, a deposit): Codex takes it on every event and shows it
 * as a warning (openai/codex `hooks/src/events/*.rs`, CLI 0.157.1). Nothing
 * else survives, because Codex refuses an answer carrying a field it does not
 * know.
 */
export function codexResponse(response: unknown): unknown {
  if (response === null || typeof response !== 'object') return null;
  const { hookSpecificOutput: output, systemMessage } = response as {
    hookSpecificOutput?: Record<string, unknown>;
    systemMessage?: unknown;
  };
  const message = typeof systemMessage === 'string' ? { systemMessage } : {};
  if (output === undefined) return Object.keys(message).length > 0 ? message : null;
  return { hookSpecificOutput: output, ...message };
}
