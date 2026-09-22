import { z } from 'zod';
import { CONFIG_DEFAULTS, loadRawConfig } from '../lib/config';
import type { PartialConfig } from '../lib/config';
import { buildPromptPacket, packetForText, type Packet, type PendingCall } from './context';
import { askGate, type GateDeps } from './gate';
import { readSessionPacket, writeSessionPacket } from './session-file';

/**
 * The two hook handlers. Between them they do exactly three things: build the
 * bounded packet, ask the free gate, and say one thing back to the harness.
 *
 * NOTHING ELSE IS IN REACH FROM HERE. No wallet, no signer, no payment SDK, no
 * MCP server: a dist test asserts the chunk graph, because the hooks run on
 * every prompt and every native search, and their cost is the product's floor.
 *
 * EVERY FAILURE IS SILENT. A gate that is down, slow or answering nonsense
 * leaves the prompt un-annotated and the native call allowed. The user's turn
 * is never blocked by this feature being unavailable.
 */

const PromptEventSchema = z.object({
  session_id: z.string().min(1).max(200),
  transcript_path: z.string().optional(),
  prompt: z.string(),
});

const NativeEventSchema = z.object({
  session_id: z.string().min(1).max(200),
  tool_name: z.enum(['WebSearch', 'WebFetch']),
  tool_input: z.record(z.string(), z.unknown()),
});

/** Acknowledgements that cannot be a lookup; `install` never gates them. */
const ACKNOWLEDGEMENTS = new Set(['y', 'yes', 'ok', 'okay', 'continue', 'go', 'sure', 'thanks']);

export type PromptSkip = 'slash' | 'acknowledgement';

/**
 * Prompts that cannot need a lookup, decided locally with no network call. Any
 * OTHER short prompt still goes to the gate: `2^1000`, a bare URL and a task
 * typed without spaces can all need one, and a computation has no later
 * WebSearch or WebFetch hook to recover a skipped classification.
 */
export function promptSkipReason(prompt: string): PromptSkip | null {
  const trimmed = prompt.trim();
  if (trimmed.startsWith('/')) return 'slash';
  const normalized = trimmed.toLowerCase().replace(/[.!,]+$/, '');
  return ACKNOWLEDGEMENTS.has(normalized) ? 'acknowledgement' : null;
}

export interface HookDeps extends GateDeps {
  dataDir: string;
  /** Overrides the configured base URL; tests point it at a local stub. */
  baseUrl?: string;
  now?: () => number;
}

async function resolveBaseUrl(deps: HookDeps): Promise<string> {
  if (deps.baseUrl !== undefined) return deps.baseUrl;
  const config: PartialConfig = await loadRawConfig(deps.dataDir).catch(() => ({}));
  return config.baseUrl ?? CONFIG_DEFAULTS.baseUrl;
}

export interface PromptHookOutcome {
  /** What the harness is told, or null for "nothing to say". */
  response: unknown | null;
  skipped?: PromptSkip;
  gateAction?: string;
  packetWritten: boolean;
}

/**
 * `tenjin hook prompt` (UserPromptSubmit). Writes the session packet whatever
 * happens, so the next tool call binds from current history, and emits one
 * `additionalContext` line only on `execute` with a well-formed hint.
 */
export async function runPromptHook(raw: unknown, deps: HookDeps): Promise<PromptHookOutcome> {
  const parsed = PromptEventSchema.safeParse(raw);
  if (!parsed.success) return { response: null, packetWritten: false };
  const event = parsed.data;
  const packet = await buildPromptPacket(event.transcript_path, event.session_id, event.prompt);
  const written = await writeSessionPacket(deps.dataDir, event.session_id, packet, deps.now).then(
    () => true,
    () => false,
  );
  const skipped = promptSkipReason(event.prompt);
  if (skipped !== null) return { response: null, skipped, packetWritten: written };

  const answer = await askGate(await resolveBaseUrl(deps), { source: 'prompt', packet }, deps);
  if (answer === null) return { response: null, packetWritten: written };
  if (answer.action !== 'execute' || answer.hint === undefined) {
    return { response: null, gateAction: answer.action, packetWritten: written };
  }
  return {
    response: {
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: answer.hint,
      },
    },
    gateAction: answer.action,
    packetWritten: written,
  };
}

export const REDIRECT_REASON =
  'A paid capability fits this better. Call request with this query, alone, and wait for its result.';

/** What the harness shows in place of the denied call: the gate's own line when
 *  it sent one, and the subject either way, since a WebFetch carries no query
 *  and a bare "call request" leaves the model nothing to carry across. */
export function redirectReason(pending: PendingCall, hint: string | undefined): string {
  const subject = 'query' in pending ? pending.query : pending.url;
  return `${hint ?? REDIRECT_REASON}\nQuery: ${subject.slice(0, 500)}`;
}

export interface NativeHookOutcome {
  response: unknown | null;
  decision: 'allow' | 'deny';
  gateAction?: string;
}

/**
 * `tenjin hook native` (PreToolUse on `WebSearch|WebFetch`). `native` allows the
 * call; `execute` denies it and names the tool to call instead. Nothing goes
 * into `permissions.deny`, so a localhost or intranet page stays reachable by
 * WebFetch whenever the gate says native, and a silent gate allows.
 */
export async function runNativeHook(raw: unknown, deps: HookDeps): Promise<NativeHookOutcome> {
  const parsed = NativeEventSchema.safeParse(raw);
  if (!parsed.success) return { response: null, decision: 'allow' };
  const event = parsed.data;
  const pending = pendingCallOf(event.tool_name, event.tool_input);
  if (pending === null) return { response: null, decision: 'allow' };

  // No packet is the subagent and restarted-session path: the call's own query
  // or URL becomes the current message, because an empty one is refused.
  const prior = await readSessionPacket(deps.dataDir, event.session_id, deps.now);
  const packet: Packet = {
    ...(prior ?? packetForText('query' in pending ? pending.query : pending.url)),
    pendingCall: pending,
  };
  const answer = await askGate(await resolveBaseUrl(deps), { source: 'native', packet }, deps);
  if (answer === null || answer.action !== 'execute') {
    return {
      response: null,
      decision: 'allow',
      ...(answer !== null ? { gateAction: answer.action } : {}),
    };
  }
  return {
    response: {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: redirectReason(pending, answer.hint),
      },
    },
    decision: 'deny',
    gateAction: answer.action,
  };
}

function pendingCallOf(
  tool: 'WebSearch' | 'WebFetch',
  input: Record<string, unknown>,
): PendingCall | null {
  const value = tool === 'WebSearch' ? input.query : input.url;
  if (typeof value !== 'string') return null;
  const bounded = value.trim().slice(0, 4_000);
  if (bounded.length === 0) return null;
  return tool === 'WebSearch' ? { tool, query: bounded } : { tool, url: bounded };
}
