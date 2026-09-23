import { z } from 'zod';
import { loadRawConfig, resolveSettings } from '../lib/config';
import type { PartialConfig } from '../lib/config';
import {
  buildNativePacket,
  buildPromptPacket,
  MAX_PENDING_CHARS,
  type Packet,
  type PendingCall,
} from './context';
import { requestDecision, ROUTER_PATH, type HookDecision } from './decision';
import { GATE_TIMEOUT_MS } from './gate';

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
 * EVERY FAILURE IS SILENT, or at worst one fallback line. A backend that is
 * down, slow or answering nonsense leaves the native call allowed and the
 * prompt carrying `call request({query}) for lookups`, which is the same thing
 * the model would do on its own. The user's turn is never blocked by this.
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

/**
 * THE ONE FALLBACK. A decision that did not arrive inside the hook's budget is
 * not a dead turn: the model is told to call `request` with its own query, and
 * the tool makes the decision instead. There is no second path here.
 */
export const FALLBACK_LINE = 'call request({query}) for lookups';

/**
 * THE HINT NAMES THE TURN, NOT A LOOKUP. The hook has only run the gate: it
 * knows a paid capability fits this turn and it has stored the packet, and it
 * has decided nothing about WHAT to look up. So the line says exactly that, and
 * asks for the model's own lookup.
 *
 * The prepared-decision shortcut that used to live here is gone. It answered
 * from the gate's reading of the whole turn, which measures 53 of 56 against 55
 * of 56 for the model's query plus this packet, and on a mixed turn it paid for
 * the wrong lookup: the client could only reject it when the two named
 * different URLs, which the failing case did not.
 */
export function hintLine(id: string | undefined): string {
  // JSON-encoded even though the schema already pins the alphabet: this string
  // is server text landing in the model's context, and one layer that cannot be
  // skipped by a future schema change is worth its two characters.
  const carry = id !== undefined ? `, id:${JSON.stringify(id)}` : '';
  return `A paid lookup is available for this turn: call request({query:"<your exact lookup>"${carry}})`;
}

/** What a `needs_input` decision leaves the host to do, in one line. */
export function clarificationLine(decision: HookDecision): string {
  if (decision.action === 'execute') return FALLBACK_LINE;
  const next = decision.diagnostics.nextAction.trim();
  if (next.length > 0) return next;
  const { missing } = decision.diagnostics;
  if (missing.length > 0) {
    return `Ask the user for ${missing.slice(0, 3).join(', ')}, then call request({query}).`;
  }
  return `Ask the user what to look up, then ${FALLBACK_LINE}.`;
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
 * own words. `native` is silence: no line, no row, nothing to decline. Only an
 * `execute` gets the prepared line, and only a `needs_input` gets the question.
 */
export async function runPromptHook(raw: unknown, deps: HookDeps): Promise<PromptHookOutcome> {
  const parsed = PromptEventSchema.safeParse(raw);
  if (!parsed.success) return { response: null };
  const event = parsed.data;
  const skipped = promptSkipReason(event.prompt);
  if (skipped !== null) return { response: null, skipped };

  const packet = await buildPromptPacket(event.transcript_path, event.session_id, event.prompt);
  const outcome = await decide(packet, deps);
  if (outcome === null) return injection(FALLBACK_LINE);
  const decision = outcome;
  if (decision.action === 'native') return { response: null, action: 'native' };
  if (decision.action === 'needs_input') {
    return { action: 'needs_input', ...injection(clarificationLine(decision)) };
  }
  return { action: 'execute', id: decision.id, ...injection(hintLine(decision.id)) };
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
  const call = pendingCallOf(event.tool_name, event.tool_input);
  if (call.kind === 'none') return { response: null, decision: 'allow' };
  if (call.kind === 'long') {
    // Too long to hand back whole, so there is nothing honest to redirect to:
    // the call runs as the user's assistant wrote it.
    warnOf(deps)(
      `tenjin hook: this ${event.tool_name} argument is over ${String(MAX_PENDING_CHARS)} characters, so the call runs unrouted`,
    );
    return { response: null, decision: 'allow' };
  }
  const pending = call.pending;
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
  const outcome = await decide(packet, deps);
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
        permissionDecisionReason: redirectReason(pending, outcome),
      },
    },
    decision: 'deny',
    action: 'execute',
    id: outcome.id,
  };
}

/**
 * WHAT THE HARNESS SHOWS IN PLACE OF THE DENIED CALL, and it has one job: be
 * copyable. The live smoke followed the redirect by id once in seven: the line
 * carried a `<your exact lookup>` placeholder, so the model retyped the search
 * in its own words four times and abandoned two redirects outright. It now
 * carries the exact argument that was denied and the id that holds this turn's
 * context, both JSON-encoded, on one line.
 *
 * Encoded, not interpolated: the query is the user's text and may hold quotes
 * or newlines, and this line lands in the model's context. `JSON.stringify`
 * escapes both, which also keeps the line one line.
 */
export function redirectReason(pending: PendingCall, decision: HookDecision): string {
  // WHOLE, NEVER TRIMMED. A shortened query is a different lookup, and the
  // model would have paid for that one instead; the argument is already inside
  // the bound the route accepts, because a longer one never reaches here.
  const subject = 'query' in pending ? pending.query : pending.url;
  const what = 'query' in pending ? 'search' : 'page';
  const id = decision.action === 'execute' ? decision.id : undefined;
  const carry = id !== undefined ? `, id: ${JSON.stringify(id)}` : '';
  return (
    `Paid lookup available for this ${what}. ` +
    `Call request({query: ${JSON.stringify(subject)}${carry}}) instead; ` +
    'native tools stay allowed for anything else.'
  );
}

/** Where a silent hook says why: the harness keeps stderr in its log. */
function warnOf(deps: HookDeps): (line: string) => void {
  return deps.warn ?? ((line: string) => process.stderr.write(`${line}\n`));
}

/** One free decision, with the hook's own deadline and its own silence. */
async function decide(packet: Packet, deps: HookDeps): Promise<HookDecision | null> {
  const baseUrl = await resolveBaseUrl(deps);
  const warn = warnOf(deps);
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

/** A native call this hook can act on, `null` for one it cannot read, and
 *  `too-long` for an argument past the bound the route accepts. */
type PendingOutcome = { kind: 'call'; pending: PendingCall } | { kind: 'none' } | { kind: 'long' };

function pendingCallOf(
  tool: 'WebSearch' | 'WebFetch',
  input: Record<string, unknown>,
): PendingOutcome {
  const value = tool === 'WebSearch' ? input.query : input.url;
  if (typeof value !== 'string') return { kind: 'none' };
  const trimmed = value.trim();
  if (trimmed.length === 0) return { kind: 'none' };
  // MEASURED BEFORE ANYTHING IS CUT. Slicing here would route, and then
  // redirect, on a lookup the user never asked for.
  if (trimmed.length > MAX_PENDING_CHARS) return { kind: 'long' };
  return {
    kind: 'call',
    pending: tool === 'WebSearch' ? { tool, query: trimmed } : { tool, url: trimmed },
  };
}
