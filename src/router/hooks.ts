import { z } from 'zod';
import { loadRawConfig, resolveSettings } from '../lib/config';
import type { PartialConfig } from '../lib/config';
import { evaluateSpendPolicy } from '../lib/policy';
import { resolveContextSettings } from '../lib/settings';
import { readSpendSummary, spentOf } from '../lib/spend-ledger';
import type { CommandContext } from '../context';
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
 * The three hook handlers. Between them they do exactly three things: build the
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
 *
 * AND NOTHING IS EVER DENIED, OR ALLOWED. A paid lookup is an OFFER beside the
 * free tool, never a replacement for it: a denied WebFetch stranded every
 * subagent that could not reach `request` (tenjin-agent#377) and painted the
 * main agent's transcript red. No arm returns a `permissionDecision` either:
 * an `allow` would skip the user's own permission rules for the call, so the
 * harness's normal flow decides whether it runs, and the agent picks.
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
  /** Present only inside a subagent, which is the one caller that cannot reach
   *  the user to approve a spend. */
  agent_id: z.string().min(1).max(200).optional(),
});

const DelegationEventSchema = z.object({
  session_id: z.string().min(1).max(200),
  transcript_path: z.string().optional(),
  /** `Task` is the tool's older name; the matcher `install` writes takes both. */
  tool_name: z.enum(['Agent', 'Task']),
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

/** Where the offer sits beside the free tool. The hint itself is the server's
 *  line, verbatim: this client names no provider and no price of its own, and
 *  no condition either, because the server's line already says when to call. */
function nativeOffer(tool: 'WebSearch' | 'WebFetch', hint: string): string {
  return `Your ${tool} call is running as usual; a paid alternative is optional. ${hint}`;
}

function delegationOffer(hint: string): string {
  return `Optional, if your own tools fall short: ${hint} Your own tools are fine when they are enough.`;
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
 * A SUBAGENT IS OFFERED ONLY WHAT IT CAN PAY FOR ALONE. It cannot reach the
 * user, so an offer that would stop on `needs_approval` is a dead end; the
 * parent can still make that lookup itself. This asks the question `request`
 * will: the same settings, the same session ledger and the same policy
 * evaluation, with the provider's host as the creator the way `pay` names it.
 * Only `allow`, a spend that would auto-execute, is worth the line. It
 * reserves nothing, and the amount actually signed is still `gateSpend`'s to
 * cap. Anything that cannot be read shows no offer.
 */
async function wouldAutoExecute(
  decision: { providerPriceAtomic: string; endpoint: string },
  deps: HookDeps,
): Promise<boolean> {
  try {
    const { policy } = await resolveContextSettings(hookContext(deps));
    const ledger = await readSpendSummary(deps.dataDir, {
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    });
    const evaluation = evaluateSpendPolicy(policy, {
      amountAtomic: BigInt(decision.providerPriceAtomic),
      creator: new URL(decision.endpoint).host,
      sessionSpentAtomic: ledger === null ? 0n : spentOf(ledger),
    });
    return evaluation.decision === 'allow';
  } catch {
    return false;
  }
}

/** The context the hook's own library calls run in: JSON, silent, no TTY. */
function hookContext(deps: HookDeps): CommandContext {
  return {
    flags: { json: true, timeout: deps.timeoutMs ?? GATE_TIMEOUT_MS },
    dataDir: deps.dataDir,
    io: { stdout: nullStream(), stderr: nullStream(), isTTY: false },
  };
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
  action?: HookDecision['action'];
  id?: string;
  /** An `execute` whose offer was not shown: a subagent spend that would need approval. */
  withheld?: true;
}

/**
 * `tenjin hook native` (PreToolUse on `WebSearch|WebFetch`). THE CALL IS NEVER
 * STOPPED. On a clear `execute` it runs with the server's offer beside it, carrying
 * the id so a lookup the agent then chooses runs the decision just made rather
 * than paying for a second one. Anything else, including silence, a slow
 * backend and a `needs_input`, is no output at all.
 */
export async function runNativeHook(raw: unknown, deps: HookDeps): Promise<NativeHookOutcome> {
  const parsed = NativeEventSchema.safeParse(raw);
  if (!parsed.success) return { response: null };
  const event = parsed.data;
  const pending = pendingCallOf(event.tool_name, event.tool_input);
  if (pending === null) return { response: null };
  // THE USER'S WORDS COME WITH IT. Building this from the tool argument alone
  // made the search string the whole conversation, so "native tools only, no
  // paid services" never reached this gate. Inside a subagent, its own task
  // comes first: see `buildNativePacket`.
  const packet = await buildNativePacket(
    event.transcript_path,
    event.session_id,
    pending,
    event.agent_id,
  );
  // AND WHEN THEY CANNOT BE READ, NOTHING IS OFFERED. An offer routed on the
  // tool argument alone is how an instruction the user gave this turn gets
  // overruled by a decision that never saw it.
  if (packet.historyStatus !== 'ok') {
    (deps.warn ?? ((line: string) => process.stderr.write(`${line}\n`)))(
      "tenjin hook: this session's transcript could not be read, so the native call runs unrouted",
    );
    return { response: null };
  }
  const footer = await openFooter(deps, event.session_id, 'search');
  const outcome = await decide(packet, deps);
  if (outcome === null || outcome.action !== 'execute') {
    await footer.close(outcome);
    return { response: null, ...(outcome !== null ? { action: outcome.action } : {}) };
  }
  if (event.agent_id !== undefined && !(await wouldAutoExecute(outcome, deps))) {
    await footer.close(outcome, { withheld: true });
    return { response: null, action: 'execute', withheld: true };
  }
  await footer.close(outcome);
  return {
    response: {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        // THE SERVER'S LINE, VERBATIM, framed as the option it is. It already
        // carries the id and the exact search or URL this call is making.
        additionalContext: nativeOffer(event.tool_name, outcome.hint),
      },
    },
    action: 'execute',
    id: outcome.id,
  };
}

export interface DelegationHookOutcome {
  response: unknown | null;
  action?: HookDecision['action'];
  id?: string;
  withheld?: true;
}

/**
 * `tenjin hook agent` (PreToolUse on `Agent|Task`). The one moment a subagent's
 * whole assignment is visible: its task prompt IS the current message, and the
 * parent's own turn is the history, so the router decides on exactly what the
 * subagent will do. On a clear `execute` the offer is appended to that task as
 * one optional line, which reaches the subagent as part of its instructions
 * from its parent, before it starts. Anything else is no output at all.
 *
 * The subagent will be the payer, so the same auto-execute rule applies here.
 */
export async function runDelegationHook(
  raw: unknown,
  deps: HookDeps,
): Promise<DelegationHookOutcome> {
  const parsed = DelegationEventSchema.safeParse(raw);
  if (!parsed.success) return { response: null };
  const event = parsed.data;
  const task = event.tool_input.prompt;
  if (typeof task !== 'string' || task.trim().length === 0) return { response: null };
  const packet = await buildPromptPacket(event.transcript_path, event.session_id, task);
  // The native hook's rule, for the same reason: a delegation routed without
  // the user's words could offer what they just ruled out.
  if (packet.historyStatus !== 'ok') return { response: null };
  const footer = await openFooter(deps, event.session_id, 'delegate');
  const outcome = await decide(packet, deps);
  if (outcome === null || outcome.action !== 'execute') {
    await footer.close(outcome);
    return { response: null, ...(outcome !== null ? { action: outcome.action } : {}) };
  }
  if (!(await wouldAutoExecute(outcome, deps))) {
    await footer.close(outcome, { withheld: true });
    return { response: null, action: 'execute', withheld: true };
  }
  await footer.close(outcome);
  return {
    response: {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        // The whole input, with one line appended: `updatedInput` replaces it.
        updatedInput: {
          ...event.tool_input,
          prompt: `${task}\n\n${delegationOffer(outcome.hint)}`,
        },
      },
    },
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
  operation: 'prompt' | 'search' | 'delegate',
): Promise<{
  close: (decision: HookDecision | null, opts?: { withheld?: boolean }) => Promise<void>;
}> {
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
    close: async (decision, opts) => {
      const withheld = opts?.withheld === true;
      await writeProgress(
        directory,
        callId,
        {
          phase: 'done',
          operation,
          outcome: withheld ? 'native tools (offer needs approval)' : hookOutcome(decision),
        },
        now(),
      );
      if (!withheld && decision !== null && decision.action === 'execute') {
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
      ctx: hookContext(deps),
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
