import { z } from 'zod';
import { loadRawConfig, resolveSettings } from '../lib/config';
import type { PartialConfig } from '../lib/config';
import { buildPromptPacket, fit, packetForText, type Packet, type PendingCall } from './context';
import { requestDecision, ROUTER_PATH, type Decision } from './decision';
import { GATE_TIMEOUT_MS } from './gate';
import { recordIssuedId } from './issued-ids';
import { toMoney } from '../lib/money';

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
 * OFF BY DEFAULT, AND HERE SO THE SMOKE CAN FLIP IT WITHOUT A DESIGN ROUND.
 * The worry is a mixed turn: the hook prepares one lookup, and the model takes
 * the id for a different part of the request. The tool already declines an id
 * whose prepared page the query does not name, and the smoke counts every
 * mismatched id that was taken anyway. If that count is above zero on the
 * release run, set this and ids stop being offered on turns that ask for more
 * than one thing.
 */
export const SINGLE_INTENT_ONLY_ENV = 'TENJIN_ROUTER_ID_SINGLE_INTENT_ONLY';

function idsAreOffered(prompt: string, env: NodeJS.ProcessEnv): boolean {
  const flag = env[SINGLE_INTENT_ONLY_ENV];
  if (flag === undefined || flag === '' || flag === '0' || flag === 'false') return true;
  return looksSingleIntent(prompt);
}

/**
 * One ask, by the two marks that actually separate them: a second sentence,
 * and a clause joined onto the first. Crude on purpose. It decides nothing
 * while the flag is off, and when the flag is on the cost of being wrong is
 * one lookup that carries no shortcut.
 */
export function looksSingleIntent(prompt: string): boolean {
  const trimmed = prompt.trim();
  const sentences = trimmed.split(/[.?!]+\s+/).filter((part) => part.trim().length > 0);
  if (sentences.length > 1) return false;
  return !/[;]|\band\b|\balso\b|\bplus\b|\bthen\b/i.test(trimmed);
}

/**
 * A PREPARED DECISION HAS TO BE EASY TO DECLINE. The line names exactly what
 * was prepared, who would be paid and what they charge, then gives both moves:
 * take it with the id, or ignore it and send your own lookup. Claude always
 * sends its own query either way, so a mismatched id is visible to the tool and
 * to the smoke rather than hidden inside a fast path.
 */
export function preparedLine(decision: Decision, offerId = true): string {
  const what = (decision.description ?? 'a paid lookup').trim();
  const via = decision.provider !== undefined ? ` via ${decision.provider}` : '';
  const price =
    decision.providerPriceAtomic !== undefined
      ? ` ($${toMoney(decision.providerPriceAtomic).usd})`
      : '';
  const take =
    decision.id !== undefined && offerId
      ? `If that is what you need, call request({query, id:'${decision.id}'})`
      : 'If that is what you need, call request({query})';
  return `Prepared: ${what}${via}${price}. ${take}; otherwise call request({query}) with your own lookup.`;
}

/** What a `needs_input` decision leaves the host to do, in one line. */
export function clarificationLine(decision: Decision): string {
  const next = decision.diagnostics?.nextAction.trim() ?? '';
  if (next.length > 0) return next;
  const missing = decision.diagnostics?.missing ?? [];
  if (missing.length > 0) {
    return `Ask the user for ${missing.slice(0, 3).join(', ')}, then call request({query}).`;
  }
  return `Ask the user what to look up, then ${FALLBACK_LINE}.`;
}

export interface PromptHookOutcome {
  /** What the harness is told, or null for "nothing to say". */
  response: unknown | null;
  skipped?: PromptSkip;
  action?: Decision['action'];
  /** The prepared decision id, for the smoke to correlate against. */
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
  const outcome = await decide({ packet }, deps);
  if (outcome === null) return injection(FALLBACK_LINE);
  const decision = outcome;
  if (decision.action === 'native') return { response: null, action: 'native' };
  const offerId = idsAreOffered(event.prompt, deps.env ?? process.env);
  if (offerId) await remember(decision, deps);
  const line =
    decision.action === 'execute' ? preparedLine(decision, offerId) : clarificationLine(decision);
  return {
    action: decision.action,
    ...(decision.id !== undefined && offerId ? { id: decision.id } : {}),
    ...injection(line),
  };
}

/**
 * WHAT THIS MACHINE OFFERED, written down before it is offered. The tool runs a
 * prepared decision only for an id on that list, so an id arriving from a
 * fetched page or somebody else's message is not a shortcut into this wallet.
 * Best effort: a write that fails costs the next call its shortcut, never the
 * lookup.
 */
async function remember(decision: Decision, deps: HookDeps): Promise<void> {
  if (decision.id === undefined || decision.action !== 'execute') return;
  const target = firstUrl(decision.description ?? '');
  await recordIssuedId(
    deps.dataDir,
    { id: decision.id, ...(target !== null ? { target } : {}) },
    deps.now ?? Date.now,
  ).catch(() => undefined);
}

/** The first http(s) URL in a string, or null. */
function firstUrl(text: string): string | null {
  const match = /https?:\/\/[^\s"'<>)\]]+/i.exec(text);
  return match === null ? null : match[0];
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
  action?: Decision['action'];
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
  const subject = 'query' in pending ? pending.query : pending.url;

  // The call's own text IS the query here: a native call states its lookup, so
  // there is nothing to guess and no stored packet to find.
  const packet: Packet = fit({ ...packetForText(subject), pendingCall: pending });
  const outcome = await decide({ query: subject, packet }, deps);
  if (outcome === null || outcome.action !== 'execute') {
    return {
      response: null,
      decision: 'allow',
      ...(outcome !== null ? { action: outcome.action } : {}),
    };
  }
  await remember(outcome, deps);
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
    ...(outcome.id !== undefined ? { id: outcome.id } : {}),
  };
}

/** What the harness shows in place of the denied call: what was prepared, the
 *  id that runs it, and the subject either way, since a WebFetch carries no
 *  query and a bare "call request" leaves the model nothing to carry across. */
export function redirectReason(pending: PendingCall, decision: Decision): string {
  const subject = 'query' in pending ? pending.query : pending.url;
  return `${preparedLine(decision)}\nQuery: ${subject.slice(0, 500)}`;
}

/** One free decision, with the hook's own deadline and its own silence. */
async function decide(
  request: { query?: string; packet: Packet },
  deps: HookDeps,
): Promise<Decision | null> {
  const baseUrl = await resolveBaseUrl(deps);
  const warn = deps.warn ?? ((line: string) => process.stderr.write(`${line}\n`));
  const outcome = await requestDecision(request, {
    ctx: {
      flags: { json: true, timeout: deps.timeoutMs ?? GATE_TIMEOUT_MS },
      dataDir: deps.dataDir,
      io: { stdout: nullStream(), stderr: nullStream(), isTTY: false },
    },
    baseUrl,
    timeoutMs: deps.timeoutMs ?? GATE_TIMEOUT_MS,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  });
  if (outcome.status === 'failed') {
    warn(`tenjin hook: ${baseUrl}${ROUTER_PATH} ${outcome.reason}`);
    return null;
  }
  return outcome.decision;
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
