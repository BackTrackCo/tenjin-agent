import { z } from 'zod';
import { loadRawConfig, resolveSettings } from '../lib/config';
import type { PartialConfig } from '../lib/config';
import { buildNativePacket, buildPromptPacket, type Packet, type PendingCall } from './context';
import { requestDecision, ROUTER_PATH, type HookDecision } from './decision';
import { GATE_TIMEOUT_MS } from './gate';
import {
  bindDecision,
  newCallId,
  noteSession,
  pruneProgress,
  pruneSessions,
  sessionDir,
  writeProgress,
} from './progress';

/**
 * The two hook handlers. Between them they do exactly three things: build the
 * bounded packet, ask for one free decision, and say one thing back to the
 * harness.
 *
 * NOTHING ELSE IS IN REACH FROM HERE. No wallet, no signer, no payment SDK, no
 * MCP server: a dist test asserts the chunk graph, because the hooks run on
 * every prompt and every native search, and their cost is the product's floor.
 * The decision is free, so nothing on this path can spend anything either.
 *
 * EVERY FAILURE IS SILENT. A backend that is down, slow or answering nonsense
 * leaves the native call allowed and the prompt unchanged; the cause goes to
 * stderr. The user's turn is never blocked by this.
 */

const PromptEventSchema = z.object({
  session_id: z.string().min(1).max(200),
  transcript_path: z.string().optional(),
  prompt: z.string(),
});

const NativeEventSchema = z.object({
  session_id: z.string().min(1).max(200),
  /** The harness's own path for THIS session: the native decision reads the
   *  same bounded history the prompt one does, so a restriction the user gave
   *  reaches both gates. */
  transcript_path: z.string().optional(),
  tool_name: z.enum(['WebSearch', 'WebFetch']),
  tool_input: z.record(z.string(), z.unknown()),
});

/** Acknowledgements that cannot be a lookup; `install` never gates them. */
const ACKNOWLEDGEMENTS = new Set(['y', 'yes', 'ok', 'okay', 'continue', 'go', 'sure', 'thanks']);

export type PromptSkip = 'slash' | 'acknowledgement';

/**
 * Prompts that cannot need a lookup, decided locally with no network call. Any
 * OTHER short prompt still goes to the backend: `2^1000`, a bare URL and a task
 * typed without spaces can all need one, and a computation has no later
 * WebSearch or WebFetch hook to recover a skipped classification.
 */
export function promptSkipReason(prompt: string): PromptSkip | null {
  const trimmed = prompt.trim();
  if (trimmed.startsWith('/')) return 'slash';
  const normalized = trimmed.toLowerCase().replace(/[.!,]+$/, '');
  return ACKNOWLEDGEMENTS.has(normalized) ? 'acknowledgement' : null;
}

export interface HookDeps {
  dataDir: string;
  /** Overrides the resolved base URL entirely; tests point it at a local stub. */
  baseUrl?: string;
  /** The environment the base URL precedence reads `TENJIN_BASE_URL` from. */
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
  /**
   * Where a silent failure says why. The harness keeps hook stderr in its log,
   * so one line there is the difference between "the feature is off" and "the
   * router answered 401 at this URL". Never stdout: that is the harness's
   * protocol channel.
   */
  warn?: (line: string) => void;
}

/**
 * The CLI's ONE precedence, not a second copy of it: flag, then
 * `TENJIN_BASE_URL`, then the config file, then the production default. The
 * hook read the file alone, so a session pointed somewhere by the environment
 * had its prompts routed against whatever the file said instead; on a machine
 * whose file named a protected deployment that was a 401, and a 401 is silence.
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
  action?: HookDecision['action'];
  /** The turn id, for the smoke to correlate against. */
  id?: string;
}

/**
 * `tenjin hook prompt` (UserPromptSubmit). One free decision from the user's
 * own words. Only an `execute` gets a line, the server's hint verbatim.
 * `native`, `needs_input` and a decision that failed or timed out are silence:
 * a turn with no lookup carries nothing extra, and `decide` has already written
 * any failure cause to stderr.
 */
export async function runPromptHook(raw: unknown, deps: HookDeps): Promise<PromptHookOutcome> {
  const parsed = PromptEventSchema.safeParse(raw);
  if (!parsed.success) return { response: null };
  const event = parsed.data;
  const skipped = promptSkipReason(event.prompt);
  if (skipped !== null) return { response: null, skipped };

  const packet = await buildPromptPacket(event.transcript_path, event.session_id, event.prompt);
  const footer = await openFooter(deps, event.session_id, 'prompt');
  const outcome = await decide(packet, deps);
  await footer.close(outcome);
  if (outcome === null) return { response: null };
  if (outcome.action !== 'execute') return { response: null, action: outcome.action };
  return { action: 'execute', id: outcome.id, ...injection(outcome.hint) };
}

function injection(line: string): { response: unknown } {
  return {
    response: {
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: line },
    },
  };
}

export interface NativeHookOutcome {
  response: unknown | null;
  decision: 'allow' | 'deny';
  action?: HookDecision['action'];
  id?: string;
}

/**
 * `tenjin hook native` (PreToolUse on `WebSearch|WebFetch`). ALLOW IS THE
 * DEFAULT and a redirect is the exception: it fires only on a clear `execute`,
 * and it carries the id so the redirected call runs the decision that was just
 * made rather than paying for a second one. Anything else, including silence,
 * a slow backend and a `needs_input`, lets the native call run.
 */
export async function runNativeHook(raw: unknown, deps: HookDeps): Promise<NativeHookOutcome> {
  const parsed = NativeEventSchema.safeParse(raw);
  if (!parsed.success) return { response: null, decision: 'allow' };
  const event = parsed.data;
  const pending = pendingCallOf(event.tool_name, event.tool_input);
  if (pending === null) return { response: null, decision: 'allow' };
  // THE USER'S WORDS COME WITH IT. Building this from the tool argument alone
  // made the search string the whole conversation, so "native tools only, no
  // paid services" never reached this gate.
  const packet = await buildNativePacket(event.transcript_path, event.session_id, pending);
  // AND WHEN THEY CANNOT BE READ, THE CALL RUNS. Routing a redirect on the tool
  // argument alone is how an instruction the user gave this turn gets
  // overruled by a decision that never saw it. A native call the user's own
  // assistant chose is the safe default; the only cost is a lookup this turn
  // does not route.
  if (packet.historyStatus !== 'ok') {
    (deps.warn ?? ((line: string) => process.stderr.write(`${line}\n`)))(
      "tenjin hook: this session's transcript could not be read, so the native call runs unrouted",
    );
    return { response: null, decision: 'allow' };
  }
  const footer = await openFooter(deps, event.session_id, 'search');
  const outcome = await decide(packet, deps);
  await footer.close(outcome);
  if (outcome === null || outcome.action !== 'execute') {
    return {
      response: null,
      decision: 'allow',
      ...(outcome !== null ? { action: outcome.action } : {}),
    };
  }
  return {
    response: {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        // THE SERVER'S LINE, VERBATIM. It already carries the id and, on a
        // native call, the exact search or URL that was denied, so there is
        // nothing left here to compose and nothing to trim.
        permissionDecisionReason: outcome.hint,
      },
    },
    decision: 'deny',
    action: 'execute',
    id: outcome.id,
  };
}

/**
 * THE HOOK STAGE, WHICH IS THE ONE THE DEMO OPENS WITH. The decision is in
 * flight for about a second, and at a one-second refresh a state that is
 * written and then erased inside that second is a state nobody ever sees. So
 * the record is not cleared: `selecting service` is REPLACED by what the
 * decision turned out to be, and that outcome holds the line until the next
 * state arrives or its hold runs out.
 *
 * Display only. Every write inside swallows its own failure, and an `execute`
 * also leaves the id-to-session binding the tool resolves its progress through.
 */
async function openFooter(
  deps: HookDeps,
  sessionId: string,
  operation: 'prompt' | 'search',
): Promise<{ close: (decision: HookDecision | null) => Promise<void> }> {
  const now = (): number => deps.now?.() ?? Date.now();
  const directory = sessionDir(deps.dataDir, sessionId);
  const callId = newCallId();
  await noteSession(deps.dataDir, sessionId, now());
  await writeProgress(
    directory,
    callId,
    { phase: 'routing', operation, outcome: 'selecting service' },
    now(),
  );
  await pruneProgress(directory, now());
  // The root, not just this session: a directory per session ever opened would
  // eventually be more than the resolver can scan.
  await pruneSessions(deps.dataDir, now());
  return {
    close: async (decision) => {
      await writeProgress(
        directory,
        callId,
        { phase: 'done', operation, outcome: hookOutcome(decision) },
        now(),
      );
      if (decision !== null && decision.action === 'execute') {
        await bindDecision(deps.dataDir, sessionId, decision.id, now());
      }
    },
  };
}

/** What the gate decided, in the footer's own words. A silent backend is not a
 *  blank line: the turn runs on native tools and the footer says which. */
function hookOutcome(decision: HookDecision | null): string {
  if (decision === null) return 'native tools (router unavailable)';
  if (decision.action === 'execute') return `paid lookup offered (${decision.provider})`;
  if (decision.action === 'native') return 'native tools (no x402 payment)';
  return 'needs input';
}

/** One free decision, with the hook's own deadline and its own silence. */
async function decide(packet: Packet, deps: HookDeps): Promise<HookDecision | null> {
  const baseUrl = await resolveBaseUrl(deps);
  const warn = deps.warn ?? ((line: string) => process.stderr.write(`${line}\n`));
  const outcome = await requestDecision(
    'hook',
    { packet },
    {
      ctx: {
        flags: { json: true, timeout: deps.timeoutMs ?? GATE_TIMEOUT_MS },
        dataDir: deps.dataDir,
        io: { stdout: nullStream(), stderr: nullStream(), isTTY: false },
      },
      baseUrl,
      timeoutMs: deps.timeoutMs ?? GATE_TIMEOUT_MS,
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    },
  );
  if (outcome.status === 'failed') {
    warn(`tenjin hook: ${baseUrl}${ROUTER_PATH} ${outcome.reason}`);
    return null;
  }
  return outcome.decision.decision;
}

/** The hooks write their own protocol answer on stdout and nothing else. */
function nullStream(): NodeJS.WritableStream {
  return { write: () => true } as unknown as NodeJS.WritableStream;
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
