import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { z } from 'zod';
import { loadRawConfig, resolveSettings } from '../lib/config';
import type { PartialConfig } from '../lib/config';
import { walletPath } from '../lib/paths';
import { evaluateSpendPolicy } from '../lib/policy';
import { resolveContextSettings } from '../lib/settings';
import { readSpendSummary, spentOf } from '../lib/spend-ledger';
import { readUsdcBalance } from '../lib/usdc-balance';
import type { CommandContext } from '../context';
import {
  buildNativePacket,
  buildPromptPacket,
  seal,
  type NativeOutcome,
  type Packet,
  type PendingCall,
  type Sealed,
} from './context';
import { requestDecision, ROUTER_PATH, type HookDecision } from './decision';
import { GATE_TIMEOUT_MS } from './gate';
import { REQUEST_TOOL } from './names';
import { codexRouterEvent } from './codex-event';
import { requestToolAccess, type AgentLookup } from './agent-tools';
import { finishAugment, startAugment, type PrefetchJob, type SearchResponse } from './augment';
import {
  bindDecision,
  markOffered,
  newCallId,
  noteRedirect,
  noteSession,
  pruneProgress,
  pruneSessions,
  sessionDir,
  takeUndelivered,
  wasOffered,
  writeProgress,
} from './progress';
import { routerSettings, type RouterSettings } from './settings';

/**
 * The four hook handlers. Between them they do exactly three things: build and
 * seal the packet, ask for one free decision, and say one thing back to the
 * harness. Before an `execute` is shown where nobody can approve it, they also
 * read the wallet's address from its file and its USDC balance from the RPC
 * (`withheldBecause`). A free offer on a search starts one free docs fetch in a
 * detached `node` (`augment.ts`); that is the only other thing they touch.
 *
 * NOTHING ELSE IS IN REACH FROM HERE. No wallet module, no signer, no payment
 * SDK, no viem, no MCP server: a dist test asserts the chunk graph, because the
 * hooks run on every prompt and after every native search, and their cost is
 * the product's floor.
 * The decision is free, so nothing on this path can spend anything either.
 *
 * EVERY FAILURE IS SILENT. A backend that is down, slow or answering nonsense
 * leaves the prompt and the native result unchanged; the cause goes to
 * stderr. The user's turn is never blocked by this.
 *
 * A DENY ONLY WHERE IT CAN BE ACTED ON. The pre-call arm redirects a native
 * call the router routes, as every release has, because a note beside the call
 * was followed 0 times in 11 where the redirect is followed. But a denied
 * WebFetch stranded every subagent that could not reach `request`
 * (tenjin-agent#377), so a subagent is denied only when it is known to have
 * the tool (`requestToolAccess`) and the spend would auto-execute from a wallet
 * that can cover it; anyone else's call runs free. No arm ever returns `allow`: that would skip the user's own permission
 * rules for the call.
 */

const PromptEventSchema = z.object({
  session_id: z.string().min(1).max(200),
  /** The directory the session works in; `router.*` resolves from it. */
  cwd: z.string().optional(),
  transcript_path: z.string().optional(),
  prompt: z.string(),
});

/** What both native arms read: the call, whose it is, and where it runs. */
const NativeCallFields = {
  session_id: z.string().min(1).max(200),
  /** The harness's own path for THIS session: the decision reads the same
   *  bounded history the prompt one does, so a restriction the user gave
   *  reaches both gates. */
  transcript_path: z.string().optional(),
  tool_name: z.enum(['WebSearch', 'WebFetch']),
  tool_input: z.record(z.string(), z.unknown()),
  /** The harness's id for this one call, shared by its Pre and Post events. */
  tool_use_id: z.string().min(1).max(200).optional(),
  /** Present only inside a subagent, which is the one caller that cannot reach
   *  the user to approve a spend. */
  agent_id: z.string().min(1).max(200).optional(),
  /** The subagent's type, which names its definition file. */
  agent_type: z.string().min(1).max(200).optional(),
  cwd: z.string().optional(),
};

const NativeEventSchema = z.object({
  hook_event_name: z.literal('PreToolUse').optional(),
  ...NativeCallFields,
});

const ShortfallEventSchema = z.object({
  hook_event_name: z.enum(['PostToolUse', 'PostToolUseFailure']),
  ...NativeCallFields,
  /** PostToolUse only: WebFetch's `{bytes, code, codeText, result, durationMs}`,
   *  or WebSearch's `{query, results, durationSeconds, searchCount}`. */
  tool_response: z.unknown().optional(),
  /** PostToolUseFailure only: the failed call's own error, such as
   *  `getaddrinfo ENOTFOUND x.test`. */
  error: z.unknown().optional(),
  is_interrupt: z.boolean().optional(),
});

const DelegationEventSchema = z.object({
  session_id: z.string().min(1).max(200),
  transcript_path: z.string().optional(),
  /** `Task` is the tool's older name; the matcher `install` writes takes both. */
  tool_name: z.enum(['Agent', 'Task']),
  tool_input: z.record(z.string(), z.unknown()),
  cwd: z.string().optional(),
});

/** A native call as every arm past {@link decodeEvent} reads it. */
export interface NativeCall {
  sessionId: string;
  transcriptPath?: string;
  tool: 'WebSearch' | 'WebFetch';
  /** The search or URL, or null when the call carries none. */
  pending: PendingCall | null;
  toolUseId?: string;
  /** Present only inside a subagent. */
  agentId?: string;
  agentType?: string;
  cwd?: string;
}

/** One hook event, as this file uses it. */
export type HookEvent =
  | { kind: 'prompt'; sessionId: string; transcriptPath?: string; prompt: string; cwd?: string }
  | ({ kind: 'native' } & NativeCall)
  | ({
      kind: 'shortfall';
      eventName: 'PostToolUse' | 'PostToolUseFailure';
      /** What the harness reported, when it was a shortfall; null means none. */
      nativeOutcome: NativeOutcome | null;
      /** A WebSearch's whole response after it ran, kept to be echoed back with
       *  free docs on top; null for anything else. */
      search: SearchResponse | null;
    } & NativeCall)
  | {
      kind: 'delegation';
      sessionId: string;
      transcriptPath?: string;
      /** `tool_input.prompt`: the subagent's whole task. */
      task: string | null;
      subagentType: string;
      /** The whole tool input, echoed back with the task changed. */
      toolInput: Record<string, unknown>;
      cwd?: string;
    };

/**
 * THE ONLY READER OF A HARNESS FIELD. `session_id`, `transcript_path`,
 * `prompt`, `tool_name`, `tool_input` (its `query`, `url`, `prompt` and
 * `subagent_type`), `tool_use_id`, `agent_id`, `agent_type`, `cwd`,
 * `tool_response` and `error` are Claude Code's names; everything past this
 * function reads {@link HookEvent}, so a second harness is a second decoder
 * rather than a change to each arm. `null` is an event no arm handles.
 */
export function decodeEvent(raw: unknown): HookEvent | null {
  const shortfall = ShortfallEventSchema.safeParse(raw);
  if (shortfall.success) {
    return {
      kind: 'shortfall',
      eventName: shortfall.data.hook_event_name,
      nativeOutcome: shortfallOf(shortfall.data),
      search: searchOf(shortfall.data),
      ...nativeCallOf(shortfall.data),
    };
  }
  const native = NativeEventSchema.safeParse(raw);
  if (native.success) return { kind: 'native', ...nativeCallOf(native.data) };
  const delegation = DelegationEventSchema.safeParse(raw);
  if (delegation.success) {
    const input = delegation.data.tool_input;
    return {
      kind: 'delegation',
      sessionId: delegation.data.session_id,
      ...optional('transcriptPath', delegation.data.transcript_path),
      task: typeof input.prompt === 'string' ? input.prompt : null,
      // With no type the harness runs its general-purpose agent.
      subagentType:
        typeof input.subagent_type === 'string' ? input.subagent_type : 'general-purpose',
      toolInput: input,
      ...optional('cwd', delegation.data.cwd),
    };
  }
  const prompt = PromptEventSchema.safeParse(raw);
  if (!prompt.success) return null;
  return {
    kind: 'prompt',
    sessionId: prompt.data.session_id,
    ...optional('transcriptPath', prompt.data.transcript_path),
    prompt: prompt.data.prompt,
    ...optional('cwd', prompt.data.cwd),
  };
}

function nativeCallOf(
  event: Omit<z.infer<typeof NativeEventSchema>, 'hook_event_name'>,
): NativeCall {
  return {
    sessionId: event.session_id,
    ...optional('transcriptPath', event.transcript_path),
    tool: event.tool_name,
    pending: pendingCallOf(event.tool_name, event.tool_input),
    ...optional('toolUseId', event.tool_use_id),
    ...optional('agentId', event.agent_id),
    ...optional('agentType', event.agent_type),
    ...optional('cwd', event.cwd),
  };
}

/** WebSearch's `{query, results, durationSeconds, searchCount}` after it ran. */
function searchOf(event: z.infer<typeof ShortfallEventSchema>): SearchResponse | null {
  if (event.hook_event_name !== 'PostToolUse' || event.tool_name !== 'WebSearch') return null;
  const response = event.tool_response;
  if (response === null || typeof response !== 'object' || Array.isArray(response)) return null;
  const raw = response as Record<string, unknown>;
  return Array.isArray(raw.results) ? { raw, results: raw.results } : null;
}

function optional<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, string>);
}

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

/**
 * EVERY LINE SAYS WHERE IT CAME FROM AND NAMES THE REAL TOOL. An unattributed
 * line asking for a call the model cannot find by that name reads like an
 * injection, and a subagent looking for `request` in its tool list finds
 * nothing. So each line opens with its source, and the server's `request({`
 * becomes the name the harness actually exposes, from the one place `install`
 * registers it. The server's words are otherwise untouched: this client names
 * no provider and no price of its own.
 */
export const HINT_SOURCE = 'Tenjin router (installed by the user)';

const BARE_CALL_RE = /(?<![\w$])request\(\{/g;

export function toolNamed(hint: string): string {
  return hint.replace(BARE_CALL_RE, `${REQUEST_TOOL}({`);
}

/** The server's line as the prompt hint and the redirect both carry it. */
function attributed(hint: string): string {
  return `${HINT_SOURCE}: ${toolNamed(hint)}`;
}

/** This client's one sentence on a redirect: the promise {@link runNativeHook} keeps. */
const ONE_BLOCK =
  'If this does not cover it, make your own call again: you will not be redirected twice in a row.';

/** Where the offer sits after the free tool came back short. */
function shortfallOffer(tool: 'WebSearch' | 'WebFetch', hint: string): string {
  return `${HINT_SOURCE}: your ${tool} call came back short. Optional: ${toolNamed(hint)}`;
}

/**
 * A WebFetch body smaller than this is empty for any purpose a reader has. The
 * smallest real page measured, example.com (a heading and two sentences),
 * reports 559 bytes; a 404 and x.com's blocked read both report 0. Sixty-four
 * bytes has no room for one sentence of content, so nothing a person would
 * call a page falls under it.
 */
export const NEAR_EMPTY_BYTES = 64;

/**
 * DID THE FREE TOOL FALL SHORT, decided from the harness's own report and
 * nothing else: no model, no network call. Only clear signals count, and
 * everything else is `null`, which means the router is never asked:
 *
 * - a failed call (PostToolUseFailure), unless the user interrupted it;
 * - WebFetch refused or failing upstream: 401, 402, 403, 429 or any 5xx. A
 *   404 or 410 is not one: a page that is missing is missing for a paid
 *   reader too;
 * - WebFetch answering 2xx, or no code, with under {@link NEAR_EMPTY_BYTES};
 * - WebSearch answering with no result links at all.
 *
 * A search that returned unrelated links is NOT one: it looks exactly like a
 * good search from here, and guessing would put the router on every call.
 */
export function shortfallOf(event: {
  hook_event_name: 'PostToolUse' | 'PostToolUseFailure';
  tool_name: 'WebSearch' | 'WebFetch';
  tool_response?: unknown;
  error?: unknown;
  is_interrupt?: boolean;
}): NativeOutcome | null {
  if (event.hook_event_name === 'PostToolUseFailure') {
    if (event.is_interrupt === true) return null;
    // Neither masked nor cut here: seal() does both, in that order.
    const error = typeof event.error === 'string' ? event.error.trim() : '';
    return error.length > 0 ? { error } : null;
  }
  const response = event.tool_response;
  if (response === null || typeof response !== 'object' || Array.isArray(response)) return null;
  const fields = response as Record<string, unknown>;
  if (event.tool_name === 'WebFetch') {
    const code = wholeNumber(fields.code, 999);
    const bytes = wholeNumber(fields.bytes, Number.MAX_SAFE_INTEGER);
    const outcome = {
      ...(code !== undefined ? { code } : {}),
      ...(bytes !== undefined ? { bytes } : {}),
    };
    if (code !== undefined && isShortStatus(code)) return outcome;
    const success = code === undefined || (code >= 200 && code < 300);
    return success && bytes !== undefined && bytes < NEAR_EMPTY_BYTES ? outcome : null;
  }
  const results = fields.results;
  if (!Array.isArray(results)) return null;
  const linked = results.some(
    (entry) =>
      entry !== null &&
      typeof entry === 'object' &&
      Array.isArray((entry as { content?: unknown }).content) &&
      (entry as { content: unknown[] }).content.length > 0,
  );
  return linked ? null : { error: 'Web search returned no results' };
}

/** The statuses a paid reader can get past: auth walls, paywalls, bot blocks,
 *  rate limits and upstream failures. Every other 4xx is the page's answer. */
const SHORT_STATUSES = new Set([401, 402, 403, 429]);

function isShortStatus(code: number): boolean {
  return SHORT_STATUSES.has(code) || (code >= 500 && code <= 599);
}

function wholeNumber(value: unknown, max: number): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max
    ? value
    : undefined;
}

function delegationOffer(hint: string): string {
  return `${HINT_SOURCE}, optional if your own tools fall short: ${toolNamed(hint)} Your own tools are fine when they are enough.`;
}

export interface HookDeps {
  dataDir: string;
  harness?: 'claude' | 'codex';
  /** Verified installed-host web and request-tool readiness for this invocation. */
  codexWebReady?: boolean;
  /** Overrides the resolved base URL entirely; tests point it at a local stub. */
  baseUrl?: string;
  /** The environment the base URL precedence reads `TENJIN_BASE_URL` from. */
  env?: NodeJS.ProcessEnv;
  /** Every request a hook makes: the decision, and the balance read before an
   *  offer. Tests answer both from one stub. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
  /** Where `~/.claude` is, for the user's agent definitions; tests point it
   *  at a scratch directory. */
  homeDir?: string;
  /**
   * Where a silent failure says why. The harness keeps hook stderr in its log,
   * so one line there is the difference between "the feature is off" and "the
   * router answered 401 at this URL". Never stdout: that is the harness's
   * protocol channel.
   */
  warn?: (line: string) => void;
  /** Starts the free docs fetch beside a search; tests replace the detached
   *  process it spawns. */
  prefetch?: (job: PrefetchJob) => void;
  /** How long the after-call hook waits for that fetch; tests shorten it. */
  augmentWaitMs?: number;
}

/**
 * The CLI's ONE precedence, not a second copy of it: flag, then
 * `TENJIN_BASE_URL`, then the config file, then the production default. The
 * hook read the file alone, so a session pointed somewhere by the environment
 * had its prompts routed against whatever the file said instead; on a machine
 * whose file named a protected deployment that was a 401, and a 401 is silence.
 */
function resolveBaseUrl(deps: HookDeps, config: PartialConfig): string {
  if (deps.baseUrl !== undefined) return deps.baseUrl;
  return resolveSettings({ config, flags: {}, env: deps.env ?? process.env }).baseUrl.value;
}

/** The balance read's own ceiling, inside what the decision left of the gate's
 *  budget. Base's public RPC answered `balanceOf` in 0.16 to 0.26 s. */
const BALANCE_TIMEOUT_MS = 1_000;

/** When the gate's budget runs out. The decision and the balance read share it,
 *  so the pair still fits the hook timeout `wire.test.ts` pins. */
function gateDeadline(deps: HookDeps): number {
  return (deps.now?.() ?? Date.now()) + (deps.timeoutMs ?? GATE_TIMEOUT_MS);
}

/**
 * WHY THE PAID CALL WOULD NOT RUN ON ITS OWN, in the footer's words, or null
 * when it would. Every line that points at `request` where nobody can approve
 * asks this first: a subagent cannot reach the user, and the main agent's
 * pre-call deny and prompt hint send it to a call that has to run rather than
 * to the free tools that would have answered. Two things stop that call:
 *
 * - THE SPEND POLICY, asked the way `request` will ask it: the same settings,
 *   the same session ledger and the same evaluation, with the provider's host
 *   as the creator the way `pay` names it. Only `allow` runs alone. Nothing is
 *   reserved, and the amount actually signed is still `gateSpend`'s to cap.
 * - THE WALLET. A fresh install's wallet holds no USDC, and the authorization
 *   it signs is refused after the free call was already denied: the user got
 *   neither. One `balanceOf`, read only once the policy said yes.
 *
 * ONLY A BALANCE READ BELOW THE PRICE WITHHOLDS. One that cannot be read (no
 * wallet file, an RPC that fails, rate-limits or runs past the gate's budget)
 * leaves the policy to decide alone, as before this check. Base's public RPC
 * refused the sixth `eth_call` in a second, and parallel fetches are an
 * ordinary turn, so withholding on a failed read would drop the redirect on
 * funded wallets exactly when the router is used most, and a dead `rpcUrl`
 * would switch it off for good. The cost of the other direction needs an
 * empty wallet AND a failed read, and lasts one call. A `TENJIN_WALLET_KEY`
 * wallet is left to the policy too: its address takes a curve this chunk
 * does not load, and the file beside it is not the wallet that pays.
 */
async function withheldBecause(
  decision: { providerPriceAtomic: string; endpoint: string },
  deps: HookDeps,
  deadline: number,
): Promise<string | null> {
  let rpcUrl: string;
  try {
    const settings = await resolveContextSettings(hookContext(deps));
    const ledger = await readSpendSummary(deps.dataDir, {
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    });
    const evaluation = evaluateSpendPolicy(settings.policy, {
      amountAtomic: BigInt(decision.providerPriceAtomic),
      creator: new URL(decision.endpoint).host,
      sessionSpentAtomic: ledger === null ? 0n : spentOf(ledger),
    });
    if (evaluation.decision !== 'allow') return 'offer needs approval';
    rpcUrl = settings.rpcUrl;
  } catch {
    return 'offer needs approval';
  }
  if ((deps.env ?? process.env).TENJIN_WALLET_KEY?.trim()) return null;
  const address = await walletAddress(deps.dataDir);
  if (address === null) return null;
  const balance = await readUsdcBalance(address, rpcUrl, {
    timeoutMs: Math.min(BALANCE_TIMEOUT_MS, deadline - (deps.now?.() ?? Date.now())),
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  });
  if (balance === null) {
    (deps.warn ?? ((line: string) => process.stderr.write(`${line}\n`)))(
      `tenjin hook: the wallet's USDC balance could not be read from ${new URL(rpcUrl).host}, so the spend policy alone decides`,
    );
    return null;
  }
  return balance < BigInt(decision.providerPriceAtomic) ? 'wallet needs USDC' : null;
}

/**
 * The wallet file's address, which `lib/wallet/store.ts` keeps top-level in
 * cleartext so it reads without a passphrase; null when there is none to read.
 * Read here rather than through the wallet module, which stays out of this
 * chunk graph.
 */
async function walletAddress(dataDir: string): Promise<string | null> {
  try {
    const record: unknown = JSON.parse(await readFile(walletPath(dataDir), 'utf8'));
    const address = (record as { address?: unknown } | null)?.address;
    return typeof address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(address) ? address : null;
  } catch {
    return null;
  }
}

function agentLookup(cwd: string | undefined, deps: HookDeps): AgentLookup {
  return { ...(cwd !== undefined ? { cwd } : {}), homeDir: deps.homeDir ?? homedir() };
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
  /** An `execute` whose hint was not shown: the paid call would not run on its
   *  own, for want of approval or of funds. */
  withheld?: true;
}

/**
 * `tenjin hook prompt` (UserPromptSubmit). One free decision from the user's
 * own words. Only an `execute` gets a line: the server's hint, attributed.
 * `native`, `needs_input` and a decision that failed or timed out are silence:
 * a turn with no lookup carries nothing extra, and `decide` has already written
 * any failure cause to stderr.
 *
 * THE HINT ASKS FOR A CALL THAT HAS TO RUN. Over the cap or past the budget,
 * `request` answers `needs_approval`, and a model sent there stops to ask the
 * user where its free tools would have done: so the line is shown only when
 * the paid call would auto-execute, the same rule the pre-call deny follows.
 */
export async function runPromptHook(raw: unknown, deps: HookDeps): Promise<PromptHookOutcome> {
  const event =
    deps.harness === 'codex'
      ? codexRouterEvent(raw, deps.codexWebReady === true)
      : decodeEvent(raw);
  if (event?.kind !== 'prompt') return { response: null };
  const skipped = promptSkipReason(event.prompt);
  if (skipped !== null) return { response: null, skipped };
  const router = await routerFor(event.cwd, deps);
  if (router === null) return { response: null };

  const sealed = seal(
    scoped(
      await buildPromptPacket(event.transcriptPath, event.sessionId, event.prompt, deps.harness),
      router.settings,
    ),
  );
  const footer = await openFooter(deps, event.sessionId, 'prompt');
  const deadline = gateDeadline(deps);
  const outcome = await decide(sealed, deps, router.config);
  if (outcome === null || outcome.action !== 'execute') {
    await footer.close(outcome);
    return { response: null, ...(outcome !== null ? { action: outcome.action } : {}) };
  }
  const withheld = await withheldBecause(outcome, deps, deadline);
  if (withheld !== null) {
    await footer.close(outcome, { withheld });
    return { response: null, action: 'execute', withheld: true };
  }
  await footer.close(outcome);
  return { action: 'execute', id: outcome.id, ...injection(attributed(outcome.hint)) };
}

function injection(line: string): { response: unknown } {
  return {
    response: {
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: line },
    },
  };
}

/** What either native arm reports about itself; `response` is all the harness sees. */
export interface NativeHookOutcome {
  response: unknown | null;
  action?: HookDecision['action'];
  id?: string;
  /** An `execute` whose offer was not shown: the paid call would not run on
   *  its own, for want of approval or of funds. */
  withheld?: true;
  /** No router call at all: the subagent is not known to have the request tool. */
  noRequestTool?: true;
  /** An `execute` whose redirect was not sent: this agent's last one, in the
   *  same category, has not delivered. */
  redirectUndelivered?: true;
  /** A free offer, which the pre-call arm never redirects: the call runs. */
  free?: true;
  /** And its docs are being fetched, to ride above the search's results. */
  augmenting?: true;
}

export interface ShortfallHookOutcome extends NativeHookOutcome {
  /** What the harness reported, when it was a shortfall; absent means the
   *  router was never asked. */
  nativeOutcome?: NativeOutcome;
  /** The pre-call arm already redirected this very call, so nothing more is said. */
  alreadyOffered?: true;
  /** The pre-call arm fetched free docs for this call: they were added to its
   *  results, or there were none to add. Never an offer as well. */
  augmented?: 'added' | 'nothing';
}

type ExecuteDecision = Extract<HookDecision, { action: 'execute' }>;

/** A free offer: nothing to pay, so nothing for the spend policy or the wallet. */
function isFree(offer: ExecuteDecision): boolean {
  return offer.providerPriceAtomic === '0';
}

/**
 * THE ONE ROUTE BOTH NATIVE ARMS TAKE, before the call and after it: the
 * agent's tool list, the packet from the right transcript, one free decision,
 * and the subagent spend rule. An `execute` that survives all of it comes back
 * as `offer`; everything else is the reason there is none. `repeated` is the
 * pre-call arm's one-block rule, asked only of an offer that would be shown.
 * `passFree` is the pre-call arm's too: a free offer comes back marked `free`,
 * with the base URL it was decided on, before the spend policy, the wallet or
 * `repeated` is asked, since it is never a redirect.
 */
async function routeNativeCall(
  event: NativeCall,
  pending: PendingCall,
  deps: HookDeps,
  opts: {
    nativeOutcome?: NativeOutcome;
    repeated?: (offer: ExecuteDecision) => Promise<boolean>;
    passFree?: boolean;
  } = {},
): Promise<
  | { offer: ExecuteDecision; free?: undefined }
  | { offer: ExecuteDecision; free: true; baseUrl: string }
  | { offer: null; outcome: NativeHookOutcome }
> {
  const { nativeOutcome, repeated } = opts;
  // OFF MEANS NOTHING ABOUT THE TURN IS READ: the switch comes before the
  // agent lookup and the transcript, for both native arms.
  const router = await routerFor(event.cwd, deps);
  if (router === null) return { offer: null, outcome: { response: null } };
  // A SUBAGENT IS ROUTED ONLY WHEN IT IS KNOWN TO HAVE THE TOOL: redirecting
  // or offering to one that cannot make the call strands it (#377). Decided
  // before the router is asked, so an unknown one costs nothing.
  if (
    event.agentId !== undefined &&
    (await requestToolAccess(event.agentType, agentLookup(event.cwd, deps))) !== 'allowed'
  ) {
    return { offer: null, outcome: { response: null, noRequestTool: true } };
  }
  // THE USER'S WORDS COME WITH IT. Building this from the tool argument alone
  // made the search string the whole conversation, so "native tools only, no
  // paid services" never reached this gate. Inside a subagent, its own task
  // comes first: see `buildNativePacket`.
  const sealed = seal(
    scoped(
      await buildNativePacket(event.transcriptPath, event.sessionId, pending, {
        ...(event.agentId !== undefined ? { agentId: event.agentId } : {}),
        ...(nativeOutcome !== undefined ? { nativeOutcome } : {}),
        ...(deps.harness !== undefined ? { harness: deps.harness } : {}),
      }),
      router.settings,
    ),
  );
  const { packet } = sealed;
  // A LOCAL TARGET ONLY EVER HAS A NATIVE ANSWER, so asking costs a round trip
  // and sends the conversation for nothing.
  if (sealed.localTarget) return { offer: null, outcome: { response: null } };
  // A CREDENTIAL IN THE SEARCH OR URL NEVER LEAVES. Sending it masked would put
  // the mask into the hint the server writes from it, and the model would call
  // the provider with the mask. The call stays native.
  if (sealed.subjectChanged) {
    (deps.warn ?? ((line: string) => process.stderr.write(`${line}\n`)))(
      'tenjin hook: the native call carries a credential-shaped value, so it is not routed',
    );
    return { offer: null, outcome: { response: null } };
  }
  // AND WHEN THEY CANNOT BE READ, NOTHING IS OFFERED. An offer routed on the
  // tool argument alone is how an instruction the user gave this turn gets
  // overruled by a decision that never saw it.
  if (packet.historyStatus !== 'ok') {
    (deps.warn ?? ((line: string) => process.stderr.write(`${line}\n`)))(
      "tenjin hook: this session's transcript could not be read, so no paid lookup is offered",
    );
    return { offer: null, outcome: { response: null } };
  }
  const footer = await openFooter(deps, event.sessionId, 'search');
  const deadline = gateDeadline(deps);
  const outcome = await decide(sealed, deps, router.config);
  if (outcome === null || outcome.action !== 'execute') {
    await footer.close(outcome);
    return {
      offer: null,
      outcome: { response: null, ...(outcome !== null ? { action: outcome.action } : {}) },
    };
  }
  if (opts.passFree === true && isFree(outcome)) {
    await footer.close(outcome, { withheld: 'free lookup, call runs' });
    return { offer: outcome, free: true, baseUrl: resolveBaseUrl(deps, router.config) };
  }
  const withheld = await withheldBecause(outcome, deps, deadline);
  if (withheld !== null) {
    await footer.close(outcome, { withheld });
    return { offer: null, outcome: { response: null, action: 'execute', withheld: true } };
  }
  if (repeated !== undefined && (await repeated(outcome))) {
    await footer.close(outcome, { withheld: 'already redirected once' });
    return {
      offer: null,
      outcome: { response: null, action: 'execute', redirectUndelivered: true },
    };
  }
  await footer.close(outcome);
  return { offer: outcome };
}

/**
 * `tenjin hook native` (PreToolUse on `WebSearch|WebFetch`). PER-LOOKUP
 * ROUTING BEFORE THE CALL, exactly as main: a clear `execute` denies the native
 * call with the server's hint as the reason, carrying the id so the redirected
 * call runs the decision just made. Anything else, including silence, a slow
 * backend and a `needs_input`, lets the call run with no output at all.
 *
 * WHAT IS NEW is who can be denied. A subagent not known to have the request
 * tool, or whose spend would need an approval it cannot ask for, is never
 * redirected: `routeNativeCall` answers without an offer, and its
 * call runs free. Neither is the main agent when the paid call would stop on
 * `needs_approval` or its wallet cannot cover the price: its free call runs,
 * and the after-call arm can still offer.
 *
 * A redirect leaves a mark under the call's `tool_use_id`, so the after-call
 * arm never offers on that same call, and becomes this agent's last redirect.
 *
 * NEVER BLOCKED TWICE IN A ROW FOR ONE KIND OF LOOKUP. Every call is routed as
 * usual. While the agent's last redirect is undelivered (its lookup failed,
 * stopped short of `fulfilled`, or was never called), an offer in that same
 * category is withheld once and the call runs; the call after that is routed
 * as usual. An offer in another category is a redirect like any other.
 *
 * A FREE OFFER IS NEVER A REDIRECT. Denying a search for the free docs lookup
 * sent the agent on a detour, and round a loop when the docs missed. The call
 * runs with no output and nothing is recorded against it; on a WebSearch the
 * docs are fetched meanwhile and the after-call arm adds them above the
 * search's results (`augment.ts`). A WebFetch just runs.
 */
export async function runNativeHook(raw: unknown, deps: HookDeps): Promise<NativeHookOutcome> {
  const event =
    deps.harness === 'codex'
      ? codexRouterEvent(raw, deps.codexWebReady === true)
      : decodeEvent(raw);
  if (event?.kind !== 'native' || event.pending === null) return { response: null };
  const routed = await routeNativeCall(event, event.pending, deps, {
    passFree: true,
    repeated: (offer) =>
      takeUndelivered(
        deps.dataDir,
        progressSession(event.sessionId, deps),
        event.agentId,
        offer.category,
        deps.now?.(),
      ),
  });
  if (routed.offer === null) return routed.outcome;
  if (routed.free === true) {
    const { pending } = event;
    const augmenting =
      pending.tool === 'WebSearch' &&
      (await startAugment(
        {
          sessionId: progressSession(event.sessionId, deps),
          query: pending.query,
          ...(event.agentId !== undefined ? { agentId: event.agentId } : {}),
          ...(event.toolUseId !== undefined ? { toolUseId: event.toolUseId } : {}),
        },
        routed.offer,
        routed.baseUrl,
        deps,
      ));
    return {
      response: null,
      action: 'execute',
      id: routed.offer.id,
      free: true,
      ...(augmenting ? { augmenting: true as const } : {}),
    };
  }
  if (event.toolUseId !== undefined) {
    await markOffered(
      deps.dataDir,
      progressSession(event.sessionId, deps),
      event.toolUseId,
      deps.now?.(),
    );
  }
  await noteRedirect(
    deps.dataDir,
    progressSession(event.sessionId, deps),
    event.agentId,
    routed.offer,
    deps.now?.(),
  );
  return {
    response: {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        // THE SERVER'S LINE, attributed and tool-named, then this client's one
        // sentence. The line already carries the id and the exact search or URL
        // that was denied.
        permissionDecisionReason: `${attributed(routed.offer.hint)} ${ONE_BLOCK}`,
      },
    },
    action: 'execute',
    id: routed.offer.id,
  };
}

/**
 * `tenjin hook shortfall` (PostToolUse and PostToolUseFailure on
 * `WebSearch|WebFetch`). THE FREE TOOL HAS ALREADY RUN, and a result that is
 * fine ends here: no router call, no footer, no added latency. Only a clear
 * shortfall ({@link shortfallOf}) asks for one free decision, with what the
 * harness reported riding in the packet as `nativeOutcome`, and only an
 * `execute` says anything. A call the pre-call arm already redirected is not
 * offered on again.
 *
 * A SEARCH THE PRE-CALL ARM IS FETCHING FREE DOCS FOR waits for them first,
 * the one wait in the hook, bounded by `AUGMENT_WAIT_MS`. When docs came back
 * they go on top of its results (`updatedToolOutput`, the response the harness
 * reported with one string prepended to `results`), and that call is not
 * offered on as well. When none were added (no match, a refusal, a timeout, or
 * a call that failed outright) it is an ordinary call from there: a search that
 * came back fine says nothing, and one that came back short takes the shortfall
 * route like any other, so a failed docs lookup never costs it the paid offer.
 * The wait and that decision can follow one another, which is why this entry's
 * timeout is longer than the others' (`wire.test.ts` pins the sum).
 *
 * A server that does not know `nativeOutcome` yet refuses the packet; that is
 * a failed decision like any other, so the hook stays silent.
 */
export async function runShortfallHook(
  raw: unknown,
  deps: HookDeps,
): Promise<ShortfallHookOutcome> {
  const event =
    deps.harness === 'codex'
      ? codexRouterEvent(raw, deps.codexWebReady === true)
      : decodeEvent(raw);
  if (event?.kind !== 'shortfall') return { response: null };
  const augment = await finishAugment(
    {
      sessionId: progressSession(event.sessionId, deps),
      search: event.search,
      ...(event.toolUseId !== undefined ? { toolUseId: event.toolUseId } : {}),
    },
    deps,
  );
  if (augment !== null && augment.updatedToolOutput !== null) {
    return {
      response: {
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          updatedToolOutput: augment.updatedToolOutput,
        },
      },
      augmented: 'added',
    };
  }
  const outcome = await offerOnShortfall(event, deps, augment !== null);
  return augment === null ? outcome : { ...outcome, augmented: 'nothing' };
}

/** The shortfall route itself: ask about a call that came back short, once. */
async function offerOnShortfall(
  event: Extract<HookEvent, { kind: 'shortfall' }>,
  deps: HookDeps,
  docsJustMissed = false,
): Promise<ShortfallHookOutcome> {
  const { nativeOutcome, pending, eventName } = event;
  if (nativeOutcome === null) return { response: null };
  if (pending === null) return { response: null };
  if (
    event.toolUseId !== undefined &&
    (await wasOffered(
      deps.dataDir,
      progressSession(event.sessionId, deps),
      event.toolUseId,
      deps.now?.(),
    ))
  ) {
    return { response: null, nativeOutcome, alreadyOffered: true };
  }
  const routed = await routeNativeCall(event, pending, deps, { nativeOutcome });
  if (routed.offer === null) return { ...routed.outcome, nativeOutcome };
  // The free docs lookup for this very search just came back empty: offering
  // it again would send the agent to the same miss. Only a paid offer stands.
  if (docsJustMissed && routed.offer.providerPriceAtomic === '0')
    return { response: null, nativeOutcome, action: 'execute' };
  return {
    response: {
      hookSpecificOutput: {
        hookEventName: eventName,
        // THE SERVER'S LINE, attributed and framed as the option it is. It
        // already carries the id and the exact search or URL that came back short.
        additionalContext: shortfallOffer(event.tool, routed.offer.hint),
      },
    },
    nativeOutcome,
    action: 'execute',
    id: routed.offer.id,
  };
}

export interface DelegationHookOutcome {
  response: unknown | null;
  action?: HookDecision['action'];
  id?: string;
  withheld?: true;
  noRequestTool?: true;
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
  const event =
    deps.harness === 'codex'
      ? codexRouterEvent(raw, deps.codexWebReady === true)
      : decodeEvent(raw);
  if (event?.kind !== 'delegation') return { response: null };
  const { task } = event;
  if (task === null || task.trim().length === 0) return { response: null };
  const router = await routerFor(event.cwd, deps);
  if (router === null) return { response: null };
  // The subagent this task goes to is the one that would have to make the
  // call, so the same rule: only a type known to have the tool is offered. With
  // no type the harness runs its general-purpose agent, which inherits it.
  if ((await requestToolAccess(event.subagentType, agentLookup(event.cwd, deps))) !== 'allowed') {
    return { response: null, noRequestTool: true };
  }
  const sealed = seal(
    scoped(await buildPromptPacket(event.transcriptPath, event.sessionId, task), router.settings),
  );
  // The native hook's two rules, with the task as the subject: a task the mask
  // would change is not sent, since the offer is written back into it, and a
  // task naming a local target only ever has a native answer.
  if (sealed.localUrl) return { response: null };
  if (sealed.currentChanged) {
    (deps.warn ?? ((line: string) => process.stderr.write(`${line}\n`)))(
      'tenjin hook: the delegated task carries a credential-shaped value, so it is not routed',
    );
    return { response: null };
  }
  // The native hook's rule, for the same reason: a delegation routed without
  // the user's words could offer what they just ruled out.
  if (sealed.packet.historyStatus !== 'ok') return { response: null };
  const footer = await openFooter(deps, event.sessionId, 'delegate');
  const deadline = gateDeadline(deps);
  const outcome = await decide(sealed, deps, router.config);
  if (outcome === null || outcome.action !== 'execute') {
    await footer.close(outcome);
    return { response: null, ...(outcome !== null ? { action: outcome.action } : {}) };
  }
  const withheld = await withheldBecause(outcome, deps, deadline);
  if (withheld !== null) {
    await footer.close(outcome, { withheld });
    return { response: null, action: 'execute', withheld: true };
  }
  await footer.close(outcome);
  return {
    response: {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        // The whole input, with one line appended: `updatedInput` replaces it.
        updatedInput: {
          ...event.toolInput,
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
  /** `withheld` is why an `execute` was not shown, in the footer's words. */
  close: (decision: HookDecision | null, opts?: { withheld?: string }) => Promise<void>;
}> {
  sessionId = progressSession(sessionId, deps);
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
      const withheld = opts?.withheld;
      await writeProgress(
        directory,
        callId,
        {
          phase: 'done',
          operation,
          outcome: withheld !== undefined ? `native tools (${withheld})` : hookOutcome(decision),
        },
        now(),
      );
      if (withheld === undefined && decision !== null && decision.action === 'execute') {
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

/** One free decision, with the hook's own deadline and its own silence. It
 *  takes what {@link seal} returns rather than a bare packet, so a call site
 *  that skips the mask does not typecheck. */
async function decide(
  { packet }: Sealed,
  deps: HookDeps,
  config: PartialConfig,
): Promise<HookDecision | null> {
  const baseUrl = resolveBaseUrl(deps, config);
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
  // Not cut here: seal() masks the subject first and bounds it after, so a
  // token crossing the bound is seen whole by the mask.
  const subject = value.trim();
  if (subject.length === 0) return null;
  return tool === 'WebSearch' ? { tool, query: subject } : { tool, url: subject };
}

/**
 * `router.*` for the event's directory with the global config it came from,
 * which is read ONCE per event and also names the base URL; null when the
 * router is off there. FIRST, before any packet is built: `router.enabled
 * false` means nothing about this turn is read for the router or leaves the
 * machine. A config that cannot be read is off too, since a switch the user
 * set must not fail open.
 */
async function routerFor(
  cwd: string | undefined,
  deps: HookDeps,
): Promise<{ settings: RouterSettings; config: PartialConfig } | null> {
  const warn = deps.warn ?? ((line: string) => process.stderr.write(`${line}\n`));
  try {
    const config = await loadRawConfig(deps.dataDir);
    const settings = await routerSettings(
      { cwd: cwd ?? process.cwd(), dataDir: deps.dataDir, config },
      { warn: (line) => warn(`tenjin hook: ${line}`) },
    );
    return settings.enabled.value ? { settings, config } : null;
  } catch (err) {
    warn(`tenjin hook: ${err instanceof Error ? err.message : String(err)}, so the router is off`);
    return null;
  }
}

/**
 * `router.context turn`: the current turn and nothing before it. `current` is
 * kept (the prompt, the latest user message on a native call, the task on a
 * delegation) so an instruction given this turn still reaches the gate;
 * `historyStatus` is left as read, so a call whose turn could not be found is
 * still offered nothing.
 */
function scoped(packet: Packet, router: RouterSettings): Packet {
  return router.context.value === 'turn' ? { ...packet, history: [] } : packet;
}

function progressSession(session: string, deps: HookDeps): string {
  return deps.harness === 'codex' ? `codex:${session}` : session;
}
