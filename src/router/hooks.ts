import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { z } from 'zod';
import { loadRawConfig, resolveExperimentalBazaar, resolveSettings } from '../lib/config';
import type { PartialConfig } from '../lib/config';
import { parseUsdToAtomic, toMoney } from '../lib/money';
import { walletPath } from '../lib/paths';
import { evaluateSpendPolicy } from '../lib/policy';
import { resolveContextSettings } from '../lib/settings';
import { readSpendSummary, spentOf } from '../lib/spend-ledger';
import { rememberingBalanceReader } from '../lib/usdc-balance';
import type { CommandContext } from '../context';
import {
  buildNativePacket,
  buildPromptPacket,
  isHandback,
  seal,
  type NativeOutcome,
  type Packet,
  type PendingCall,
  type Sealed,
} from './context';
import { storeSpecs } from './specs';
import { requestDecision, ROUTER_PATH, type HookDecision } from './decision';
import { isFeeRequired, routingFeeApproved, type RouteFor } from './fee';
import {
  firstNoticeFor,
  NO_SLOT_SENTENCE,
  noteFeeRequired,
  pausedReason,
  pausedSentence,
} from './fee-state';
import { readsAsEmptyPage, savedPdfOf } from './fetch-result';
import { GATE_TIMEOUT_MS } from './gate';
import { REQUEST_TOOL } from './names';
import { requestToolAccess, type AgentLookup } from './agent-tools';
import { finishAugment, startAugment, type PrefetchJob, type SearchResponse } from './augment';
import {
  bindDecision,
  claimRedirect,
  markOffered,
  newCallId,
  noteSession,
  pruneProgress,
  pruneSessions,
  redirectClaimed,
  sessionDir,
  wasOffered,
  writeProgress,
} from './progress';
import { routerSettings, type RouterSettings } from './settings';

/**
 * The six hook handlers. Between them they do exactly three things: build and
 * seal the packet, ask for one free decision, and say one thing back to the
 * harness. Before an `execute` is shown where nobody can approve it, they also
 * read the wallet's address from its file and its USDC balance from the RPC
 * (`spendShortfall`). A free offer on a search starts one free docs fetch in a
 * detached `node` (`augment.ts`); that is the only other thing they touch.
 *
 * NOTHING ELSE IS IN REACH FROM HERE. No wallet module, no signer, no payment
 * SDK, no viem, no MCP server: a dist test asserts the chunk graph, because the
 * hooks run on every prompt and after every native search, and their cost is
 * the product's floor.
 * On the free path the decision costs nothing. The paid path exists only when
 * these handlers run inside `tenjin mcp`, behind Claude Code's `mcp_tool` hook
 * entries: that process passes its payer as {@link HookDeps.route}, and the
 * payer, not this file, signs and pays (`routing-payer.ts`). Run as
 * `tenjin hook <kind>`, every call is free.
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

/** Before the host asks the user: its questions and their options. */
const AskEventSchema = z.object({
  hook_event_name: z.literal('PreToolUse').optional(),
  ...NativeCallFields,
  tool_name: z.literal('AskUserQuestion'),
});

/** After the user answered: `tool_response` is `{questions, answers,
 *  annotations}`, `answers` keyed by each question's text. */
const AnswerEventSchema = z.object({
  hook_event_name: z.literal('PostToolUse'),
  session_id: z.string().min(1).max(200),
  transcript_path: z.string().optional(),
  tool_name: z.literal('AskUserQuestion'),
  tool_input: z.record(z.string(), z.unknown()),
  tool_response: z.unknown().optional(),
  cwd: z.string().optional(),
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
      kind: 'ask';
      /** The questions and their options, joined; null when there are none. */
      pending: PendingCall | null;
    } & Omit<NativeCall, 'tool' | 'pending'>)
  | {
      kind: 'answer';
      sessionId: string;
      transcriptPath?: string;
      /** The user's answers, joined; null when there are none. */
      answers: string | null;
      cwd?: string;
    }
  | ({
      kind: 'shortfall';
      eventName: 'PostToolUse' | 'PostToolUseFailure';
      /** What the harness reported, when it was a shortfall; null means none. */
      nativeOutcome: NativeOutcome | null;
      /** A WebSearch's whole response after it ran, kept to be echoed back with
       *  free docs on top; null for anything else. */
      search: SearchResponse | null;
      /** Where a WebFetch saved the PDF it fetched ({@link savedPdfOf}); null
       *  for anything else. */
      savedPdf: string | null;
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
 * `prompt`, `tool_name`, `tool_input` (its `query`, `url`, `prompt`,
 * `subagent_type` and `questions`), `tool_use_id`, `agent_id`, `agent_type`,
 * `cwd`, `tool_response` (and its `answers`) and `error` are Claude Code's names; everything past this
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
      savedPdf: savedPdfIn(shortfall.data),
      ...nativeCallOf(shortfall.data),
    };
  }
  const native = NativeEventSchema.safeParse(raw);
  if (native.success) return { kind: 'native', ...nativeCallOf(native.data) };
  const answer = AnswerEventSchema.safeParse(raw);
  if (answer.success) {
    return {
      kind: 'answer',
      sessionId: answer.data.session_id,
      ...optional('transcriptPath', answer.data.transcript_path),
      answers: answersOf(answer.data.tool_response, answer.data.tool_input),
      ...optional('cwd', answer.data.cwd),
    };
  }
  const ask = AskEventSchema.safeParse(raw);
  if (ask.success) {
    const question = questionOf(ask.data.tool_input);
    return {
      kind: 'ask',
      ...callFieldsOf(ask.data),
      pending: question === null ? null : { tool: 'AskUserQuestion', question },
    };
  }
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
    ...callFieldsOf(event),
    tool: event.tool_name,
    pending: pendingCallOf(event.tool_name, event.tool_input),
  };
}

/** Whose call it is and where it runs, the same for every tool. */
function callFieldsOf(event: {
  session_id: string;
  transcript_path?: string | undefined;
  tool_use_id?: string | undefined;
  agent_id?: string | undefined;
  agent_type?: string | undefined;
  cwd?: string | undefined;
}): Omit<NativeCall, 'tool' | 'pending'> {
  return {
    sessionId: event.session_id,
    ...optional('transcriptPath', event.transcript_path),
    ...optional('toolUseId', event.tool_use_id),
    ...optional('agentId', event.agent_id),
    ...optional('agentType', event.agent_type),
    ...optional('cwd', event.cwd),
  };
}

/**
 * THE HOST'S OWN WORDS BEFORE IT ASKS: each question, then each option's label
 * and description, in the order the host wrote them. Not cut here: seal()
 * masks it first and bounds it after, as it does a search.
 */
function questionOf(input: Record<string, unknown>): string | null {
  const questions = Array.isArray(input.questions) ? input.questions : [];
  const parts: string[] = [];
  for (const entry of questions) {
    if (entry === null || typeof entry !== 'object') continue;
    const { question, options } = entry as { question?: unknown; options?: unknown };
    if (typeof question === 'string' && question.trim().length > 0) parts.push(question.trim());
    for (const option of Array.isArray(options) ? options : []) {
      if (option === null || typeof option !== 'object') continue;
      const { label, description } = option as { label?: unknown; description?: unknown };
      if (typeof label !== 'string' || label.trim().length === 0) continue;
      parts.push(
        typeof description === 'string' && description.trim().length > 0
          ? `${label.trim()}: ${description.trim()}`
          : label.trim(),
      );
    }
  }
  const joined = parts.join(' ');
  return joined.length > 0 ? joined : null;
}

/** The user's answers, one per line, from the tool's response, or from its
 *  input where a harness puts them there instead. */
function answersOf(response: unknown, input: Record<string, unknown>): string | null {
  for (const holder of [response, input]) {
    if (holder === null || typeof holder !== 'object' || Array.isArray(holder)) continue;
    const answers = (holder as { answers?: unknown }).answers;
    if (answers === null || typeof answers !== 'object' || Array.isArray(answers)) continue;
    const texts = Object.values(answers as Record<string, unknown>)
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    if (texts.length > 0) return texts.join('\n');
  }
  return null;
}

/** WebSearch's `{query, results, durationSeconds, searchCount}` after it ran. */
function searchOf(event: z.infer<typeof ShortfallEventSchema>): SearchResponse | null {
  if (event.hook_event_name !== 'PostToolUse' || event.tool_name !== 'WebSearch') return null;
  const response = event.tool_response;
  if (response === null || typeof response !== 'object' || Array.isArray(response)) return null;
  const raw = response as Record<string, unknown>;
  return Array.isArray(raw.results) ? { raw, results: raw.results } : null;
}

/** WebFetch's `result`, when it names the PDF it saved whole. */
function savedPdfIn(event: z.infer<typeof ShortfallEventSchema>): string | null {
  if (event.hook_event_name !== 'PostToolUse' || event.tool_name !== 'WebFetch') return null;
  const response = event.tool_response;
  if (response === null || typeof response !== 'object' || Array.isArray(response)) return null;
  const result = (response as { result?: unknown }).result;
  return typeof result === 'string' ? savedPdfOf(result, event.session_id) : null;
}

function optional<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, string>);
}

/** Acknowledgements that cannot be a lookup; `install` never gates them. */
const ACKNOWLEDGEMENTS = new Set(['y', 'yes', 'ok', 'okay', 'continue', 'go', 'sure', 'thanks']);

export type PromptSkip = 'slash' | 'acknowledgement' | 'handback';

/**
 * Prompts that cannot need a lookup, decided locally with no network call. Any
 * OTHER short prompt still goes to the backend: `2^1000`, a bare URL and a task
 * typed without spaces can all need one, and a computation has no later
 * WebSearch or WebFetch hook to recover a skipped classification.
 */
export function promptSkipReason(prompt: string): PromptSkip | null {
  const trimmed = prompt.trim();
  // A hand-back from the harness or another agent ({@link isHandback}).
  if (isHandback(trimmed)) return 'handback';
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
  'If this does not cover it, make your own call again: you will not be redirected twice in a row for the same search or URL.';

/** The same promise, for a question the ask arm redirected. */
const ONE_BLOCK_QUESTION =
  'If this does not cover it, ask your question again: you will not be redirected twice in a row for the same question.';

/** The free line after WebFetch saved a PDF its summary could not read. */
function savedPdfHint(path: string): string {
  return `${HINT_SOURCE}: WebFetch's summary cannot read a PDF, but it saved this one whole to ${path}. Read that file for its text, free (pass pages, such as "1-10", for a long one).`;
}

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
 * - WebFetch answering 2xx, or no code, whose summary says the page had no
 *   main content (`reason: 'no_main_content'`, {@link readsAsEmptyPage}): a
 *   JavaScript app's title, a video page's footer. Both are 200s with tens of
 *   kilobytes, so the size never caught them;
 * - WebSearch answering with no result links at all.
 *
 * A search that returned unrelated links is NOT one: it looks exactly like a
 * good search from here, and guessing would put the router on every call.
 * Nor is a PDF WebFetch saved whole: its summary fails, but `Read` opens the
 * file for free ({@link savedPdfOf}).
 */
export function shortfallOf(event: {
  hook_event_name: 'PostToolUse' | 'PostToolUseFailure';
  session_id: string;
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
    if (!success) return null;
    if (bytes !== undefined && bytes < NEAR_EMPTY_BYTES) return outcome;
    const result = typeof fields.result === 'string' ? fields.result : '';
    // A PDF it saved is read for free (`runShortfallHook`), never paid for.
    if (savedPdfOf(result, event.session_id) !== null) return null;
    return readsAsEmptyPage(result) ? { ...outcome, reason: 'no_main_content' } : null;
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
  /** The paid path, passed by `tenjin mcp` once the routing fee is approved.
   *  Absent (`tenjin hook <kind>`), every call takes the free path. */
  route?: RouteFor;
  /** A line for the user beside this leg's answer (`runHookKind` puts it in
   *  the hook's `systemMessage`). */
  notice?: (line: string) => void;
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
async function spendShortfall(
  decision: { providerPriceAtomic: string; endpoint: string },
  deps: HookDeps,
  deadline: number,
): Promise<Shortfall | null> {
  const price = `$${toMoney(decision.providerPriceAtomic).usd}`;
  const approval = (detail: string): Shortfall => ({
    withheld: 'offer needs approval',
    note: `Note: ${price} ${detail}; request will return needs_approval with the command the user runs to approve it — ask the user first.`,
  });
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
    if (evaluation.decision !== 'allow') {
      return approval(
        evaluation.reason === 'above_auto_spend'
          ? `is above this machine's automatic per-call limit ($${toMoney(settings.policy.maxAutoSpendAtomic.toString()).usd})`
          : "needs approval under this machine's spend limits",
      );
    }
    rpcUrl = settings.rpcUrl;
  } catch {
    return approval("needs approval under this machine's spend limits");
  }
  if ((deps.env ?? process.env).TENJIN_WALLET_KEY?.trim()) return null;
  const address = await walletAddress(deps.dataDir);
  if (address === null) return null;
  // A balance read in the last minute stands: a burst of parallel lookups
  // otherwise asks the public RPC once each, past its rate limit.
  const readBalance = rememberingBalanceReader(deps.dataDir, {
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });
  const balance = await readBalance(address, rpcUrl, {
    timeoutMs: Math.min(BALANCE_TIMEOUT_MS, deadline - (deps.now?.() ?? Date.now())),
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  });
  if (balance === null) {
    (deps.warn ?? ((line: string) => process.stderr.write(`${line}\n`)))(
      `tenjin hook: the wallet's USDC balance could not be read from ${new URL(rpcUrl).host}, so the spend policy alone decides`,
    );
    return null;
  }
  return balance < BigInt(decision.providerPriceAtomic)
    ? {
        withheld: 'wallet needs USDC',
        note: `Note: the wallet holds $${toMoney(balance.toString()).usd}; fund it with \`tenjin wallet fund\`.`,
      }
    : null;
}

/** Why a paid call would not run on its own: the footer's words, and the
 *  sentence a discovered offer carries instead of being withheld. */
interface Shortfall {
  withheld: string;
  note: string;
}

/**
 * AN OFFER, OR WHY IT IS NOT SHOWN. A curated offer the paid call could not
 * make good on alone is withheld, as it always was. A DISCOVERED one is never
 * withheld where someone can ask the user: it is the only line naming a
 * service that can do the step, so it is shown with one sentence saying the
 * call needs approval or funds, and the host asks first. Where nobody can ask
 * (a subagent's call, a delegated task) it is withheld like any other.
 *
 * An offer that is shown can still list OTHER services beside its own: a Tenjin
 * list menu, or an alternative after a curated line. One priced over the cap
 * gets a sentence saying so ({@link overCapNote}), so the host picks one that
 * runs rather than one that stops on `needs_approval`.
 */
async function vetOffer<T extends OfferDecision>(
  offer: T,
  deps: HookDeps,
  deadline: number,
  canAskUser: boolean,
): Promise<{ offer: T; withheld?: undefined } | { withheld: string }> {
  const shortfall = await spendShortfall(termsOf(offer), deps, deadline);
  if (shortfall === null) {
    const note = await overCapNote(offer.hint, deps, canAskUser);
    return { offer: note === null ? offer : { ...offer, hint: `${offer.hint} ${note}` } };
  }
  if (offer.action === 'discovered' && canAskUser) {
    return { offer: { ...offer, hint: `${offer.hint} ${shortfall.note}` } };
  }
  return { withheld: shortfall.withheld };
}

/** Where the server (`lib/x402-router/policy.ts`) writes a price, and only
 *  there: "about $0.28 per call" in a list entry, "about $0.03: request(" or
 *  "about $0.03 (price can vary" in an alternative, "$0.30): request(" closing
 *  a curated alternative, and "$0.30 via https://" for a curated offer's own
 *  (already checked as a field, so it fits). A dollar amount anywhere else is
 *  a description's words ("seats from $500/month"), never a price. */
const LISTED_PRICE_RE =
  /about \$(\d+(?:\.\d+)?)(?= per call|: request\(| \(price can vary)|\$(\d+(?:\.\d+)?)(?=\): request\(| via https?:\/\/)/g;

/** A JSON string in the hint: the user's query, an id, or a seller's own words.
 *  A dollar amount there is data ("a laptop under $1000"), never a price. */
const QUOTED_RE = /"(?:[^"\\]|\\.)*"/g;

/**
 * ONE SENTENCE FOR A LISTED SERVICE OVER THE AUTO-SPEND CAP, or null. The offer
 * itself already fits (it passed {@link spendShortfall}), so a price over the
 * cap here is another entry: People Data Labs at $0.28 beside a $0.005 email
 * finder, under a $0.25 cap, was picked and refused. Quiet when the hint
 * quotes no such price or the settings cannot be read.
 */
async function overCapNote(
  hint: string,
  deps: HookDeps,
  canAskUser: boolean,
): Promise<string | null> {
  const listed = [...hint.replace(QUOTED_RE, '""').matchAll(LISTED_PRICE_RE)].map(
    (match) => (match[1] ?? match[2]) as string,
  );
  if (listed.length === 0) return null;
  let cap: bigint;
  try {
    cap = (await resolveContextSettings(hookContext(deps))).policy.maxAutoSpendAtomic;
  } catch {
    return null;
  }
  const over = [
    ...new Set(
      listed.filter((usd) => {
        try {
          return BigInt(parseUsdToAtomic(usd)) > cap;
        } catch {
          return false;
        }
      }),
    ),
  ];
  if (over.length === 0) return null;
  const prices = over.map((usd) => `$${usd}`).join(' and ');
  const which = over.length > 1 ? 'those services' : 'that service';
  return (
    `Note: ${prices} ${over.length > 1 ? 'are' : 'is'} above this machine's automatic per-call limit ` +
    `($${toMoney(cap.toString()).usd}), so request returns needs_approval for ${which}; ` +
    (canAskUser
      ? 'prefer one within the limit, or ask the user first.'
      : 'use one within the limit.')
  );
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
 * own words. Only an offer (`execute`, or a `discovered` service) gets a line:
 * the server's hint, attributed. `native`, `needs_input` and a decision that
 * failed or timed out are silence:
 * a turn with no lookup carries nothing extra, and `decide` has already written
 * any failure cause to stderr.
 *
 * THE HINT ASKS FOR A CALL THAT HAS TO RUN. Over the cap or past the budget,
 * `request` answers `needs_approval`, and a model sent there stops to ask the
 * user where its free tools would have done: so a curated line is shown only
 * when the paid call would auto-execute, the same rule the pre-call deny
 * follows. A discovered line is shown anyway, with a sentence saying it needs
 * approval or funds ({@link vetOffer}): it may be the only service for the step.
 */
export async function runPromptHook(raw: unknown, deps: HookDeps): Promise<PromptHookOutcome> {
  const event = decodeEvent(raw);
  if (event?.kind !== 'prompt') return { response: null };
  return offerOnUserText(event, event.prompt, 'UserPromptSubmit', deps);
}

/**
 * `tenjin hook answer` (PostToolUse on `AskUserQuestion`). THE USER JUST
 * ANSWERED, which is a user turn in all but name: an answer like "I can get an
 * API key" is exactly when a pay-per-call service would do instead. So it is
 * routed the way a prompt is, with the answers as the current message and the
 * session's history before them, and an offer is added beside the answers the
 * host reads next. Anything else is no output at all.
 */
export async function runAnswerHook(raw: unknown, deps: HookDeps): Promise<PromptHookOutcome> {
  const event = decodeEvent(raw);
  if (event?.kind !== 'answer' || event.answers === null) return { response: null };
  return offerOnUserText(event, event.answers, 'PostToolUse', deps);
}

/** The prompt route, for any text that is the user's own words this turn. */
async function offerOnUserText(
  event: { sessionId: string; transcriptPath?: string; cwd?: string },
  text: string,
  hookEventName: 'UserPromptSubmit' | 'PostToolUse',
  deps: HookDeps,
): Promise<PromptHookOutcome> {
  const skipped = promptSkipReason(text);
  if (skipped !== null) return { response: null, skipped };
  const router = await routerFor(event.cwd, deps);
  if (router === null) return { response: null };

  const sealed = seal(
    scoped(await buildPromptPacket(event.transcriptPath, event.sessionId, text), router.settings),
  );
  const footer = await openFooter(deps, event.sessionId, 'prompt');
  const deadline = gateDeadline(deps);
  const outcome = await decide(sealed, deps, router.config, event.sessionId, deadline);
  // The paused-routing line rides the prompt hook only: the router installs no
  // SessionStart arm, and the fee adds no hook arm of its own. It is read after
  // the call, so the first `fee_required` answer is already noted.
  const notice =
    hookEventName === 'UserPromptSubmit'
      ? await pausedNotice(deps, event.sessionId, router.config)
      : null;
  const quiet = (): { response: unknown } | { response: null } =>
    notice === null ? { response: null } : injection(hookEventName, notice);
  if (!isOffer(outcome)) {
    await footer.close(outcome);
    return { ...quiet(), ...(outcome !== null ? { action: outcome.action } : {}) };
  }
  const vetted = await vetOffer(outcome, deps, deadline, true);
  if (vetted.withheld !== undefined) {
    await footer.close(outcome, { withheld: vetted.withheld });
    return { ...quiet(), action: outcome.action, withheld: true };
  }
  await footer.close(outcome);
  const line = attributed(vetted.offer.hint);
  return {
    action: outcome.action,
    id: outcome.id,
    ...injection(hookEventName, notice === null ? line : `${notice}\n${line}`),
  };
}

function injection(
  hookEventName: 'UserPromptSubmit' | 'PostToolUse',
  line: string,
): { response: unknown } {
  return { response: { hookSpecificOutput: { hookEventName, additionalContext: line } } };
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
  /** No redirect: this agent was already redirected on this same search or
   *  URL. Found before the router was asked there is no `action`; only a
   *  parallel copy that lost the claim after its decision carries one. */
  alreadyRedirected?: true;
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
  /** WebFetch saved a PDF whole, and the agent was pointed at it, free. */
  savedPdf?: true;
}

type ExecuteDecision = Extract<HookDecision, { action: 'execute' }>;

/**
 * AN ANSWER THAT OFFERS SOMETHING: a curated capability (`execute`), or a
 * pay-per-call service the server found for a step nothing curated serves
 * (`discovered`). Both carry an id and a finished line, and every hook shows
 * them in the same place, under the same spend and one-block rules.
 */
type OfferDecision = Extract<HookDecision, { action: 'execute' | 'discovered' }>;

function isOffer(decision: HookDecision | null): decision is OfferDecision {
  return decision?.action === 'execute' || decision?.action === 'discovered';
}

/** What the spend check and the footer read, for either kind of offer. */
function termsOf(offer: OfferDecision): {
  provider: string;
  providerPriceAtomic: string;
  endpoint: string;
} {
  if (offer.action === 'execute') return offer;
  const { candidate } = offer;
  return {
    provider: candidate.provider,
    providerPriceAtomic: candidate.providerPriceAtomic,
    endpoint: candidate.url,
  };
}

/** A free curated offer: nothing to pay, so nothing for the spend policy or
 *  the wallet. A discovered service is never one: it is always a sale. */
function isFree(offer: OfferDecision): offer is ExecuteDecision {
  return offer.action === 'execute' && offer.providerPriceAtomic === '0';
}

/**
 * THE ONE ROUTE BOTH NATIVE ARMS TAKE, before the call and after it: the
 * agent's tool list, the packet from the right transcript, one free decision,
 * and the subagent spend rule. An `execute` that survives all of it comes back
 * as `offer`; everything else is the reason there is none. `repeated` is the
 * pre-call arm's one-block rule, asked only of an offer that would be shown;
 * `redirected` is its read half, asked before the router is, so a retry the
 * arm would only withhold costs no decision and writes no offer row.
 * `passFree` is the pre-call arm's too: a free offer comes back marked `free`,
 * with the base URL it was decided on, before the spend policy, the wallet or
 * `repeated` is asked, since it is never a redirect.
 */
async function routeNativeCall(
  event: Omit<NativeCall, 'tool' | 'pending'>,
  pending: PendingCall,
  deps: HookDeps,
  opts: {
    nativeOutcome?: NativeOutcome;
    repeated?: () => Promise<boolean>;
    redirected?: () => Promise<boolean>;
    passFree?: boolean;
    operation?: 'prompt' | 'search';
    /** False where a discovered offer must be affordable as it stands: the
     *  call it would replace is the one way to reach the user. */
    canAskUser?: boolean;
  } = {},
): Promise<
  | { offer: OfferDecision; free?: undefined }
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
  // ALREADY REDIRECTED HERE: the retry the one-block rule lets run. Asking the
  // router first cost a gate decision and wrote an offer row nobody saw, about
  // 45% of an active session's rows. The claim after the decision still
  // settles two parallel copies of one call.
  if (opts.redirected !== undefined && (await opts.redirected())) {
    const footer = await openFooter(deps, event.sessionId, opts.operation ?? 'search');
    await footer.close(null, { withheld: 'already redirected once' });
    return { offer: null, outcome: { response: null, alreadyRedirected: true } };
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
  const footer = await openFooter(deps, event.sessionId, opts.operation ?? 'search');
  const deadline = gateDeadline(deps);
  const outcome = await decide(sealed, deps, router.config, event.sessionId, deadline);
  if (!isOffer(outcome)) {
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
  const vetted = await vetOffer(
    outcome,
    deps,
    deadline,
    event.agentId === undefined && opts.canAskUser !== false,
  );
  if (vetted.withheld !== undefined) {
    await footer.close(outcome, { withheld: vetted.withheld });
    return { offer: null, outcome: { response: null, action: outcome.action, withheld: true } };
  }
  if (repeated !== undefined && (await repeated())) {
    await footer.close(outcome, { withheld: 'already redirected once' });
    return {
      offer: null,
      outcome: { response: null, action: outcome.action, alreadyRedirected: true },
    };
  }
  await footer.close(outcome);
  return { offer: vetted.offer };
}

/**
 * `tenjin hook native` (PreToolUse on `WebSearch|WebFetch`). PER-LOOKUP
 * ROUTING BEFORE THE CALL, exactly as main: a clear offer denies the native
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
 * arm never offers on that same call.
 *
 * NEVER REDIRECTED TWICE FOR ONE TARGET. A redirect claims its exact search or
 * URL for this agent first ({@link claimRedirect}). A call on a target this
 * agent was already redirected on runs without asking the router at all
 * ({@link redirectClaimed}), however its lookup went and whatever other calls
 * ran in between; a parallel copy that got past that check loses the claim
 * after its decision and runs too. Parallel calls each hold their own claim,
 * so none can spend another's. Any other target gets its own redirect.
 *
 * A FREE OFFER IS NEVER A REDIRECT. Denying a search for the free docs lookup
 * sent the agent on a detour, and round a loop when the docs missed. The call
 * runs with no output and nothing is recorded against it; on a WebSearch the
 * docs are fetched meanwhile and the after-call arm adds them above the
 * search's results (`augment.ts`). A WebFetch just runs.
 */
export async function runNativeHook(raw: unknown, deps: HookDeps): Promise<NativeHookOutcome> {
  const event = decodeEvent(raw);
  if (event?.kind !== 'native' || event.pending === null) return { response: null };
  const target = redirectTarget(event.pending);
  const routed = await routeNativeCall(event, event.pending, deps, {
    passFree: true,
    repeated: async () =>
      !(await claimRedirect(deps.dataDir, event.sessionId, event.agentId, target, deps.now?.())),
    redirected: () =>
      redirectClaimed(deps.dataDir, event.sessionId, event.agentId, target, deps.now?.()),
  });
  if (routed.offer === null) return routed.outcome;
  if (routed.free === true) {
    const { pending } = event;
    const augmenting =
      pending.tool === 'WebSearch' &&
      (await startAugment(
        {
          sessionId: event.sessionId,
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
    await markOffered(deps.dataDir, event.sessionId, event.toolUseId, deps.now?.());
  }
  return redirect(routed.offer);
}

/**
 * Deny the call once with the server's line: the redirect both pre-call arms
 * make, after `routeNativeCall` has claimed its target ({@link claimRedirect}).
 */
function redirect(offer: OfferDecision, oneBlock = ONE_BLOCK): NativeHookOutcome {
  return {
    response: {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        // THE SERVER'S LINE, attributed and tool-named, then this client's one
        // sentence. The line already carries the id and the exact search, URL
        // or question that was denied.
        permissionDecisionReason: `${attributed(offer.hint)} ${oneBlock}`,
      },
    },
    action: offer.action,
    id: offer.id,
  };
}

/**
 * `tenjin hook ask` (PreToolUse on `AskUserQuestion`). THE HOST IS ABOUT TO
 * ASK THE USER FOR SOMETHING, often an API key or an account for a one-off
 * step, which is the moment a pay-per-call service could answer instead. The
 * questions and their options ride as the pending call, and an offer denies
 * the question once with the server's line: never twice for the same
 * question, and a free offer never denies anything. The host can ask again,
 * and that question runs.
 *
 * AN OFFER THE CALL COULD NOT MAKE GOOD ON ALONE NEVER TAKES THE QUESTION'S
 * PLACE. Elsewhere a discovered offer over the cap or the balance is shown
 * with a note telling the host to ask the user first; here the question IS
 * the asking, so denying it to say "ask the user" strands the turn. Any
 * shortfall, curated or discovered, withholds the offer and the question runs.
 */
export async function runAskHook(raw: unknown, deps: HookDeps): Promise<NativeHookOutcome> {
  const event = decodeEvent(raw);
  if (event?.kind !== 'ask' || event.pending === null) return { response: null };
  // The question itself is the target, claimed exactly as a search or a URL is.
  const target = redirectTarget(event.pending);
  const routed = await routeNativeCall(event, event.pending, deps, {
    passFree: true,
    operation: 'prompt',
    canAskUser: false,
    repeated: async () =>
      !(await claimRedirect(deps.dataDir, event.sessionId, event.agentId, target, deps.now?.())),
    redirected: () =>
      redirectClaimed(deps.dataDir, event.sessionId, event.agentId, target, deps.now?.()),
  });
  if (routed.offer === null) return routed.outcome;
  if (routed.free === true) {
    return { response: null, action: routed.offer.action, id: routed.offer.id, free: true };
  }
  return redirect(routed.offer, ONE_BLOCK_QUESTION);
}

/**
 * `tenjin hook shortfall` (PostToolUse and PostToolUseFailure on
 * `WebSearch|WebFetch`). THE FREE TOOL HAS ALREADY RUN, and a result that is
 * fine ends here: no router call, no footer, no added latency. Only a clear
 * shortfall ({@link shortfallOf}) asks for one free decision, with what the
 * harness reported riding in the packet as `nativeOutcome`, and only an offer
 * (`execute` or `discovered`) says anything. A call the pre-call arm already redirected is not
 * offered on again. The one free line is a PDF WebFetch saved whole: the agent
 * is pointed at the file, and the router is not asked.
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
  const event = decodeEvent(raw);
  if (event?.kind !== 'shortfall') return { response: null };
  const augment = await finishAugment(
    {
      sessionId: event.sessionId,
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
  if (event.savedPdf !== null) return await pointAtSavedPdf(event, event.savedPdf, deps);
  const outcome = await offerOnShortfall(event, deps, augment !== null);
  return augment === null ? outcome : { ...outcome, augmented: 'nothing' };
}

/**
 * A PDF WEBFETCH SAVED IS READ FOR FREE. Its summary was handed the compressed
 * bytes and says it cannot parse them, but the harness saved the file whole,
 * and `Read` returns every page. So the line says that, and the router is
 * never asked: a paid reader would only fetch the same file again. Silent when
 * `router.enabled` is off, like every other line this hook writes.
 */
async function pointAtSavedPdf(
  event: Extract<HookEvent, { kind: 'shortfall' }>,
  path: string,
  deps: HookDeps,
): Promise<ShortfallHookOutcome> {
  if ((await routerFor(event.cwd, deps)) === null) return { response: null };
  return {
    response: {
      hookSpecificOutput: {
        hookEventName: event.eventName,
        additionalContext: savedPdfHint(path),
      },
    },
    savedPdf: true,
  };
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
    (await wasOffered(deps.dataDir, event.sessionId, event.toolUseId, deps.now?.()))
  ) {
    return { response: null, nativeOutcome, alreadyOffered: true };
  }
  const routed = await routeNativeCall(event, pending, deps, { nativeOutcome });
  if (routed.offer === null) return { ...routed.outcome, nativeOutcome };
  // The free docs lookup for this very search just came back empty: offering
  // it again would send the agent to the same miss. Only a paid offer stands.
  if (docsJustMissed && isFree(routed.offer))
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
    action: routed.offer.action,
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
 * subagent will do. On a clear offer, it is appended to that task as
 * one optional line, which reaches the subagent as part of its instructions
 * from its parent, before it starts. Anything else is no output at all.
 *
 * The subagent will be the payer, so the same auto-execute rule applies here.
 */
export async function runDelegationHook(
  raw: unknown,
  deps: HookDeps,
): Promise<DelegationHookOutcome> {
  const event = decodeEvent(raw);
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
  const outcome = await decide(sealed, deps, router.config, event.sessionId, deadline);
  if (!isOffer(outcome)) {
    await footer.close(outcome);
    return { response: null, ...(outcome !== null ? { action: outcome.action } : {}) };
  }
  // The subagent will make the call and cannot ask the user, so nothing it
  // could not pay for alone is offered to it.
  const vetted = await vetOffer(outcome, deps, deadline, false);
  if (vetted.withheld !== undefined) {
    await footer.close(outcome, { withheld: vetted.withheld });
    return { response: null, action: outcome.action, withheld: true };
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
    action: outcome.action,
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
 * Display only. Every write inside swallows its own failure, and a shown offer
 * also leaves the id-to-session binding the tool resolves its progress through,
 * and the request specs the line names, which the tool reads by id.
 */
async function openFooter(
  deps: HookDeps,
  sessionId: string,
  operation: 'prompt' | 'search' | 'delegate',
): Promise<{
  /** `withheld` is why an `execute` was not shown, in the footer's words. */
  close: (decision: HookDecision | null, opts?: { withheld?: string }) => Promise<void>;
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
      if (withheld === undefined && isOffer(decision)) {
        await bindDecision(deps.dataDir, sessionId, decision.id, now());
        // The line is shown, so the specs of the services it names are what
        // `request({id, input})` runs and `request({id})` shows.
        await storeSpecs(deps.dataDir, decision.specs);
      }
    },
  };
}

/** What the gate decided, in the footer's own words. A silent backend is not a
 *  blank line: the turn runs on native tools and the footer says which. */
function hookOutcome(decision: HookDecision | null): string {
  if (decision === null) return 'native tools (router unavailable)';
  if (isOffer(decision)) return `paid lookup offered (${termsOf(decision).provider})`;
  if (decision.action === 'native') return 'native tools (no x402 payment)';
  return 'needs input';
}

/** The one routing call, its packet SEALED (masked and bounded): a path that
 *  skips the mask does not typecheck. Inside `tenjin mcp` with the routing fee
 *  approved it takes the paid path, which the payer may skip (the allowance
 *  spent, the wallet locked): then nothing is sent and the native tool runs.
 *  With no slot free the call takes the free path, and the user is told. */
async function decide(
  { packet }: Sealed,
  deps: HookDeps,
  config: PartialConfig,
  sessionId: string,
  deadline: number,
): Promise<HookDecision | null> {
  const baseUrl = resolveBaseUrl(deps, config);
  const warn = deps.warn ?? ((line: string) => process.stderr.write(`${line}\n`));
  const route = (await deps.route?.(config, baseUrl)) ?? null;
  const now = deps.now?.() ?? Date.now();
  const outcome = await requestDecision(
    'hook',
    { packet, sessionId },
    {
      ctx: hookContext(deps),
      baseUrl,
      acceptsBazaar: resolveExperimentalBazaar(config).value === 'on',
      timeoutMs: Math.max(0, deadline - now),
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
      ...(route !== null ? { route } : {}),
    },
  );
  // A `fee_required` answer is how a machine without approval learns the
  // server takes the fee: doctor, the prompt notice and the tool then name the
  // approval command. Any other free answer clears it.
  if (route === null && outcome.status === 'decided') {
    await noteFeeRequired(deps.dataDir, isFeeRequired(outcome.decision), now).catch(
      () => undefined,
    );
  }
  if (outcome.status === 'skipped') {
    warn(`tenjin hook: the routing fee was not paid (${outcome.why}), so the native tool runs`);
    return null;
  }
  if (outcome.freePath !== undefined) {
    warn(`tenjin hook: the routing fee was not paid (${outcome.freePath}), so the free path ran`);
    deps.notice?.(NO_SLOT_SENTENCE);
  }
  if (outcome.status === 'failed') {
    warn(`tenjin hook: ${baseUrl}${route?.path ?? ROUTER_PATH} ${outcome.reason}`);
    return null;
  }
  return outcome.decision.decision;
}

/**
 * ONE LINE, ONCE PER SESSION, when routing on the paid path is paused: the
 * reason and the command that turns it back on, for the agent to pass to the
 * user. Null when nothing is paused or this session was already told.
 */
async function pausedNotice(
  deps: HookDeps,
  sessionId: string,
  config: PartialConfig,
): Promise<string | null> {
  try {
    const paused = await pausedReason(deps.dataDir, routingFeeApproved(config));
    if (paused === null) return null;
    if (!(await firstNoticeFor(deps.dataDir, sessionId, deps.now?.() ?? Date.now()))) return null;
    return `${HINT_SOURCE}: ${pausedSentence(paused)} Tell the user this once.`;
  } catch {
    return null;
  }
}

/** The hooks write their own protocol answer on stdout and nothing else. */
function nullStream(): NodeJS.WritableStream {
  return { write: () => true } as unknown as NodeJS.WritableStream;
}

/**
 * What one redirect is for: the search as the agent wrote it, or the URL as
 * `URL` parses it, so a retry that differs only in how the URL is spelled is
 * still the same call.
 */
function redirectTarget(pending: PendingCall): string {
  if (pending.tool === 'WebSearch') return `WebSearch ${pending.query}`;
  if (pending.tool === 'AskUserQuestion') return `AskUserQuestion ${pending.question}`;
  let url = pending.url;
  try {
    url = new URL(url).toString();
  } catch {
    // Not a URL the parser takes: the agent's own spelling is the target.
  }
  return `WebFetch ${url}`;
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
