import { z } from 'zod';
import { loadRawConfig, resolveSettings } from '../lib/config';
import type { PartialConfig } from '../lib/config';
import { buildPromptPacket, fit, packetForText, type Packet, type PendingCall } from './context';
import { askGate, GATE_PATH, type GateDeps } from './gate';
import {
  nativeContinuationHolds,
  readSessionPacketFile,
  sessionKeyOf,
  writeGateHint,
  writeSessionPacket,
} from './session-file';

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
  /** Overrides the resolved base URL entirely; tests point it at a local stub. */
  baseUrl?: string;
  /** The environment the base URL precedence reads `TENJIN_BASE_URL` from. */
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /**
   * Where a silent gate says why. The harness keeps hook stderr in its log, so
   * one line there is the difference between "the feature is off" and "the
   * gate answered 401 at this URL". Never stdout: that is the harness's
   * protocol channel.
   */
  warn?: (line: string) => void;
}

/**
 * The CLI's ONE precedence, not a second copy of it: flag, then
 * `TENJIN_BASE_URL`, then the config file, then the production default. The
 * hook read the file alone, so a session pointed somewhere by the environment
 * had its prompts gated against whatever the file said instead; on a machine
 * whose file named a protected deployment that was a 401, and a 401 is a null
 * answer, and a null answer is silence. `resolveSettings` is the same function
 * `tenjin config` reports from, so the two can no longer disagree.
 */
async function resolveBaseUrl(deps: HookDeps): Promise<string> {
  if (deps.baseUrl !== undefined) return deps.baseUrl;
  const config: PartialConfig = await loadRawConfig(deps.dataDir).catch(() => ({}));
  return resolveSettings({ config, flags: {}, env: deps.env ?? process.env }).baseUrl.value;
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
  const turnStamp = await writeSessionPacket(
    deps.dataDir,
    event.session_id,
    packet,
    deps.now,
  ).catch(() => null);
  const written = turnStamp !== null;
  const skipped = promptSkipReason(event.prompt);
  if (skipped !== null) return { response: null, skipped, packetWritten: written };

  const baseUrl = await resolveBaseUrl(deps);
  const answer = await askGate(
    baseUrl,
    { source: 'prompt', packet },
    withDiagnostic(deps, baseUrl),
  );
  if (answer === null) return { response: null, packetWritten: written };
  if (answer.action !== 'execute' || answer.hint === undefined) {
    return { response: null, gateAction: answer.action, packetWritten: written };
  }
  // The category this gate just named, left for the FIRST paid decision of this
  // turn to send as evidence. Best effort and never on the critical path: a
  // hint that cannot be stored costs the decision a piece of evidence, never
  // the turn. See `consumeGateHint` for why it is one-shot.
  if (turnStamp !== null && answer.category !== undefined) {
    await writeGateHint(deps.dataDir, event.session_id, turnStamp, answer.category, deps.now).catch(
      () => undefined,
    );
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

/**
 * The gate's failures are silent by contract, and silence is indistinguishable
 * from "no capability fits". This puts the reason on stderr where the harness
 * logs it, and changes nothing a caller sees.
 */
function withDiagnostic(deps: HookDeps, baseUrl: string): HookDeps {
  const warn = deps.warn ?? ((line: string) => process.stderr.write(`${line}\n`));
  return {
    ...deps,
    onFailure: (detail) => warn(`tenjin hook: gate at ${baseUrl}${GATE_PATH} ${detail}`),
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
  /** `continuation` when a paid `native` decision for this exact lookup in this
   *  turn answered it, so the gate was not asked at all. */
  via?: 'continuation';
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
  const stored = await readSessionPacketFile(deps.dataDir, event.session_id, deps.now);
  const prior = stored?.packet ?? null;
  const subject = 'query' in pending ? pending.query : pending.url;
  // A PAID DECISION MAY HAVE ANSWERED THIS ALREADY. When the `request` tool
  // bought a `native` decision for this exact lookup in this exact turn, asking
  // the gate again can contradict it and deny the call that decision permitted,
  // which the user sees as a blocked tool on a lookup they paid to be told they
  // did not need to route. The record is scoped to the session, the turn stamp
  // and the lookup text: a different query, a later prompt, an expired record
  // or no packet at all all fall through to the gate as before.
  if (
    stored !== null &&
    (await nativeContinuationHolds(
      deps.dataDir,
      sessionKeyOf(event.session_id),
      stored.writtenAtMs,
      subject,
      deps.now,
    ))
  ) {
    return { response: null, decision: 'allow', gateAction: 'native', via: 'continuation' };
  }
  // `fit` AGAIN, on the packet this hook actually sends. The stored one was
  // measured without a pending call, so one that landed on the cap is over it
  // the moment this attaches the call, and an over-cap packet is a 400 that
  // `askGate` reads as null and this reads as allow: the redirect would die
  // with no trace, exactly as it did when the call travelled beside the packet.
  const packet: Packet = fit({
    ...(prior ?? packetForText(subject)),
    pendingCall: pending,
  });
  const baseUrl = await resolveBaseUrl(deps);
  const answer = await askGate(
    baseUrl,
    { source: 'native', packet },
    withDiagnostic(deps, baseUrl),
  );
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
