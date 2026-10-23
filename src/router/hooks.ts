import { homedir } from 'node:os';
import { z } from 'zod';
import { loadRawConfig, resolveExperimentalBazaar, resolveSettings } from '../lib/config';
import type { PartialConfig } from '../lib/config';
import { parseUsdToAtomic, toMoney } from '../lib/money';
import { evaluateSpendPolicy } from '../lib/policy';
import { resolveContextSettings } from '../lib/settings';
import { readSpendSummary, spentOf } from '../lib/spend-ledger';
import { rememberingBalanceReader } from '../lib/usdc-balance';
import { readWalletFacts } from '../lib/wallet-facts';
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
import { storeAccountOffer, storeChoices, storeSpecs } from './specs';
import { accountLacks } from './accounts/presence';
import {
  isAccountSpec,
  parseHookDecision,
  requestDecision,
  ROUTER_PATH,
  type AnyOfferSpec,
  type HookDecision,
  type OfferSpec,
} from './decision';
import { keepDecided, takeDecided } from './decided';
import { canPayProvider, canSign, type SignVerdict } from './eligibility';
import { depositSentence, FEE_REQUIRED, isFeeRequired, unpaidSentence, type RouteFor } from './fee';
import { noticeCleared, noticeFor } from './notice-markers';
import { agentFixFor } from './wallet-reasons';
import { readsAsEmptyPage, savedPdfOf } from './fetch-result';
import { GATE_TIMEOUT_MS } from './gate';
import {
  clearRouterMemo,
  readRouterMemo,
  UNREACHABLE_BACKOFF_MS,
  writeRouterMemo,
} from './router-memo';
import { requestToolName, type Harness } from './names';
import { codexRouterEvent, codexSession } from './codex-event';
import { requestToolAccess, type AgentLookup } from './agent-tools';
import { finishAugment, startAugment, type PrefetchJob, type SearchResponse } from './augment';
import {
  bindDecision,
  claimRedirect,
  markHandedBack,
  markOffered,
  type OfferedTerms,
  newCallId,
  noteSession,
  pruneProgress,
  pruneSessions,
  redirectClaimed,
  sessionDir,
  wasOffered,
  writeProgress,
} from './progress';
import { routerSettings, type ReplacementSetting, type RouterSettings } from './settings';
import { admitRoutes, replacementFits } from './access';

/**
 * The six hook handlers. Between them they do exactly three things: build and
 * seal the packet, ask for one free decision, and say one thing back to the
 * harness. Before an `execute` is shown where nobody can approve it, they also
 * read what the wallet's files say (`readWalletFacts`) and its USDC balance
 * from the RPC (`spendShortfall`). A free offer on a search starts one free docs fetch in a
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
  /** A Codex `webrun` call's input without `pending`, when anything else is in it. */
  rest?: Record<string, unknown>;
  /** Every search and URL in the call, `pending` first; absent means `pending` alone. */
  targets?: PendingCall[];
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

export function toolNamed(
  hint: string,
  host: Harness = 'claude',
  env: NodeJS.ProcessEnv = process.env,
): string {
  return hint.replace(BARE_CALL_RE, `${requestToolName(host, env)}({`);
}

/** The server's line as the prompt hint and the redirect both carry it. */
function attributed(hint: string, host: Harness): string {
  return `${HINT_SOURCE}: ${toolNamed(hint, host)}`;
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
function shortfallOffer(tool: 'WebSearch' | 'WebFetch', hint: string, host: Harness): string {
  return `${HINT_SOURCE}: your ${tool} call came back short. Optional: ${toolNamed(hint, host)}`;
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
  /** The host whose event this is, Claude Code when absent. */
  harness?: Harness;
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
  /** The paid path, passed by `tenjin mcp`. Absent (`tenjin hook <kind>`),
   *  every call takes the free path. */
  route?: RouteFor;
  /** A line for the user beside this leg's answer (`runHookKind` puts it in
   *  the hook's `systemMessage`). */
  notice?: (line: string) => void;
  /**
   * Inside `tenjin mcp`: the payer's in-memory sign verdict (what its last
   * unlock said, no I/O). Absent (`tenjin hook <kind>`, which cannot unlock),
   * it is decided from the wallet's files alone ({@link spendShortfall}).
   */
  signer?: () => SignVerdict;
  /**
   * Inside `tenjin mcp`, called only for an event with a valid session_id:
   * marks the session served (B2) and returns this leg's one-time wallet
   * lines. `ack()` runs once the response carrying them is built; only then
   * are they marked delivered (and awaiting_confirmation cleared).
   */
  walletNews?: (sessionId: string) => Promise<WalletNews>;
}

/**
 * One leg's one-time wallet lines, CLAIMED for that leg: a leg running at the
 * same time is not handed them. `ack()` marks them delivered once the response
 * carrying them is built; `release()` hands them back for the next leg when
 * the leg failed before answering.
 */
export interface WalletNews {
  lines: string[];
  /**
   * The reason a still-locked line in `lines` names, if any. The leg marks it
   * told for the session, so the fee notice for the same reason stays quiet
   * (once per session and reason).
   */
  told?: string;
  ack: () => Promise<void>;
  release: () => void;
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
 * to the free tools that would have answered. Three things stop that call:
 *
 * - THE SPEND POLICY, asked the way `request` will ask it: the same settings,
 *   the same session ledger and the same evaluation, with the provider's host
 *   as the creator the way `pay` names it. Only `allow` runs alone. Nothing is
 *   reserved, and the amount actually signed is still `gateSpend`'s to cap.
 * - A WALLET THAT CANNOT SIGN. Inside `tenjin mcp` that is the payer's own
 *   verdict ({@link HookDeps.signer}); as `tenjin hook <kind>`, which cannot
 *   unlock, it is `canSign` over the wallet's files alone (`readWalletFacts`):
 *   no wallet and no key, a malformed TENJIN_WALLET_KEY, a wallet.json nobody
 *   can read, or the saved passphrase file gone while TENJIN_WALLET_PASSPHRASE
 *   is unset. Approval cannot unlock a wallet mid-session, so this one
 *   withholds discovered offers too ({@link vetOffer}, Q3), and it wins over
 *   the policy's `needs_approval` for any price above zero. Its note rides
 *   in `additionalContext`, so it carries the model's `agentFix` (B1).
 * - THE BALANCE. A fresh install's wallet holds no USDC, and the authorization
 *   it signs is refused after the free call was already denied: the user got
 *   neither. One `balanceOf`, read only once the policy said yes and the
 *   signer is not definitely blocked.
 *
 * ONLY A DEFINITE BLOCK OR A BALANCE READ BELOW THE PRICE WITHHOLDS. An
 * unknown signer (a keychain that did not answer, an unlock not tried yet,
 * every command-mode leg with a readable wallet) still offers: only `blocked`
 * gates (`eligibility.ts`). A balance that cannot be read (an RPC that fails,
 * rate-limits or runs past the gate's budget) leaves the policy to decide
 * alone, as before this check. Base's public RPC refused the sixth `eth_call`
 * in a second, and parallel fetches are an ordinary turn, so withholding on a
 * failed read would drop the redirect on funded wallets exactly when the
 * router is used most, and a dead `rpcUrl` would switch it off for good. The
 * cost of the other direction needs an empty wallet AND a failed read, and
 * lasts one call. A valid `TENJIN_WALLET_KEY` wallet is left to the policy
 * too: its address takes a curve this chunk does not load, and the file
 * beside it is not the wallet that pays.
 *
 * Exported for its tests: a sign-blocked note is never shown in an offer
 * ({@link vetOffer} withholds it), so they read it here.
 */
export async function spendShortfall(
  decision: { providerPriceAtomic: string; endpoint: string },
  deps: HookDeps,
  deadline: number,
): Promise<Shortfall | null> {
  const price = `$${toMoney(decision.providerPriceAtomic).usd}`;
  const approval = (detail: string): Shortfall => ({
    withheld: 'offer needs approval',
    note: `Note: ${price} ${detail}; request will pay nothing and return needs_approval with what it costs.`,
  });
  // The policy's answer: today's approval Shortfall, or the RPC to read the
  // balance from once it said yes.
  let policy: Shortfall | { rpcUrl: string };
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
    policy =
      evaluation.decision !== 'allow'
        ? approval(
            evaluation.reason === 'above_auto_spend'
              ? `is above this machine's automatic per-call limit ($${toMoney(settings.policy.maxAutoSpendAtomic.toString()).usd})`
              : "needs approval under this machine's spend limits",
          )
        : { rpcUrl: settings.rpcUrl };
  } catch {
    policy = approval("needs approval under this machine's spend limits");
  }
  // A free call pays nothing, so it needs nothing from the wallet: one that
  // cannot sign, or no wallet at all (`--no-wallet`), never withholds it.
  if (BigInt(decision.providerPriceAtomic) === 0n) return 'rpcUrl' in policy ? null : policy;
  const facts = await readWalletFacts(deps.dataDir, deps.env ?? process.env);
  const sign = deps.signer?.() ?? canSign(facts);
  // A wallet that definitely cannot sign is said before the policy's
  // `needs_approval` (Q3): approving an over-cap call cannot unlock it
  // mid-session, so even a discovered offer is withheld.
  if (sign.status === 'blocked') return cannotSign(sign);
  if (!('rpcUrl' in policy)) return policy;
  const { rpcUrl } = policy;
  let balance: bigint | null = null;
  if (facts.address !== null && facts.envKey !== 'valid') {
    // A balance read in the last minute stands: a burst of parallel lookups
    // otherwise asks the public RPC once each, past its rate limit.
    const readBalance = rememberingBalanceReader(deps.dataDir, {
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    });
    balance = await readBalance(facts.address, rpcUrl, {
      timeoutMs: Math.min(BALANCE_TIMEOUT_MS, deadline - (deps.now?.() ?? Date.now())),
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    });
    if (balance === null) {
      (deps.warn ?? ((line: string) => process.stderr.write(`${line}\n`)))(
        `tenjin hook: the wallet's USDC balance could not be read from ${new URL(rpcUrl).host}, so the spend policy alone decides`,
      );
    }
  }
  const v = canPayProvider(
    { policy: { decision: 'allow' }, sign, balanceAtomic: balance },
    BigInt(decision.providerPriceAtomic),
  );
  if (v.status !== 'blocked' || v.reason === 'needs_approval') return null;
  if (v.reason === 'wallet_short') {
    if (balance === null) return null;
    const short = BigInt(decision.providerPriceAtomic) - balance;
    return {
      withheld: 'wallet needs USDC',
      note: `Note: the wallet holds $${toMoney(balance.toString()).usd}, $${toMoney(short.toString()).usd} short of its ${price}; fund it with \`tenjin wallet fund\`.`,
    };
  }
  return cannotSign(v);
}

/** The Shortfall of a wallet that definitely cannot sign; {@link vetOffer} always withholds it. */
function cannotSign(v: { reason: string; detail: string; fix: string }): Shortfall {
  return {
    withheld: 'wallet cannot sign',
    note: `Note: Tenjin's wallet cannot pay for this (${v.detail}); ${agentFixFor(v.reason, v.fix)}`,
    signBlocked: true,
  };
}

/** Why a paid call would not run on its own: the footer's words, and the
 *  sentence a discovered offer carries instead of being withheld.
 *  `signBlocked` marks a wallet that definitely cannot sign, which no
 *  approval fixes mid-session. */
export interface Shortfall {
  withheld: string;
  note: string;
  signBlocked?: true;
}

/**
 * AN OFFER, OR WHY IT IS NOT SHOWN. A curated offer the paid call could not
 * make good on alone is withheld, as it always was. A DISCOVERED one is not
 * withheld where someone can ask the user: it is the only line naming a
 * service that can do the step, so it is shown with one sentence saying the
 * call needs approval or funds; its `needs_approval` result names the
 * `approve` call, which is the asking, so the host never asks first. Where
 * nobody can ask (a subagent's call, a delegated task) it is withheld like
 * any other. A wallet that definitely cannot sign withholds every offer,
 * discovered ones included (Q3): asking the user cannot unlock it mid-session.
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
  // THE USER'S OWN PLAN PAYS an account's call: nothing for the spend
  // policy or the wallet to check, and it is offered alone. One whose service
  // this account was found to lack when it was connected is left out, rather
  // than leading its task and failing when called: by now it has no fallback
  // to stand in for it ({@link servableHere}).
  if (isAccountOffer(offer)) {
    const lead = offer.specs.find(({ id }) => id === offer.id);
    if (lead === undefined || !isAccountSpec(lead)) return { withheld: 'account lead unreadable' };
    if (await accountLacks(deps.dataDir, lead.identity))
      return { withheld: 'account lacks this job' };
    return { offer };
  }
  const terms = termsOf(offer);
  const shortfall =
    terms.endpoint === undefined
      ? null
      : await spendShortfall({ ...terms, endpoint: terms.endpoint }, deps, deadline);
  if (shortfall === null) {
    const note = await overCapNote(offer, deps, canAskUser);
    return { offer: note === null ? offer : { ...offer, hint: `${offer.hint} ${note}` } };
  }
  if (offer.action === 'discovered' && canAskUser && shortfall.signBlocked !== true) {
    return { offer: { ...offer, hint: `${offer.hint} ${shortfall.note}` } };
  }
  return { withheld: shortfall.withheld };
}

/**
 * AN ACCOUNT LEAD THIS MACHINE CANNOT RUN, SERVED BY TENJIN'S OWN ROUTE. The
 * connect-time check found the account lacks the lead's tool (a higher plan,
 * say), or there is no sign-in here to read, but the router never learns
 * that: the account-wide preference keeps putting the account first for the
 * task. So the fallback the server sends beside every account lead becomes
 * the offer, as `offerAccountLead` does for a query: a paid `execute` on
 * Tenjin's route, which the settings check, the spend check and the footer
 * then treat like any other, and never `bound`, so it never runs in place of
 * a native call. With no fallback (the settings allow no Tenjin route for
 * the task) the lead is kept, and {@link vetOffer} withholds it.
 *
 * The line is this client's, since the server writes none for the fallback.
 * A decision that would not parse as an answer keeps the lead too, so what
 * is returned (and what the swap keeps for the pre-call arm) always does.
 */
async function servableHere(
  decision: HookDecision | null,
  dataDir: string,
): Promise<HookDecision | null> {
  if (!isAccountOffer(decision) || decision.fallback === undefined) return decision;
  const lead = decision.specs.find(({ id }) => id === decision.id);
  if (lead === undefined || !isAccountSpec(lead)) return decision;
  if (!(await accountLacks(dataDir, lead.identity))) return decision;
  return parseHookDecision(fallbackOffer(decision, decision.fallback)) ?? decision;
}

/** Tenjin's own route for an account lead's task, as an offer of its own. */
function fallbackOffer(lead: AccountExecute, fallback: OfferSpec): ExecuteDecision {
  const id = JSON.stringify(fallback.id);
  const name = fallback.label ?? fallback.provider;
  const price = fallback.priceVaries
    ? `About $${toMoney(fallback.priceAtomic).usd} a call (up to $${toMoney(fallback.maxAmountAtomic).usd})`
    : `$${toMoney(fallback.priceAtomic).usd} a call`;
  const what = fallback.description.replace(/[\s.]+$/, '');
  return {
    action: 'execute',
    id: fallback.id,
    capabilityId: fallback.capabilityId,
    category: lead.category,
    provider: fallback.provider,
    ...(fallback.label !== undefined ? { label: fallback.label } : {}),
    capabilityDescription: fallback.description,
    providerPriceAtomic: fallback.priceAtomic,
    endpoint: fallback.request.url,
    ...(fallback.identity !== undefined ? { identity: fallback.identity } : {}),
    usage: lead.usage,
    hint:
      `${name} fits this, Tenjin's own tool: ${what}. ${price}, paid from the Tenjin balance. ` +
      `Call request({id: ${id}}) for its inputs, then request({id: ${id}, input: {...}}) alone ` +
      'and wait for its result; native tools stay allowed for anything else.',
    specs: [fallback],
    delivery: 'offer',
  };
}

/** Where the server (`lib/x402-router/policy.ts`) writes a price, and only
 *  there: "about $0.28 per call" in a list entry, "about $0.03: request(" or
 *  "about $0.03 (price can vary" in an alternative, "$0.30): request(" closing
 *  a curated alternative, and "$0.30 via https://" for a curated offer's own
 *  (already checked as a field, so it fits). A dollar amount anywhere else is
 *  a description's words ("seats from $500/month"), never a price. Read only
 *  for an offer that carries no specs: every other one names each service's
 *  price as a field. */
const LISTED_PRICE_RE =
  /about \$(\d+(?:\.\d+)?)(?= per call|: request\(| \(price can vary)|\$(\d+(?:\.\d+)?)(?=\): request\(| via https?:\/\/)/g;

/** A JSON string in the hint: the user's query, an id, or a seller's own words.
 *  A dollar amount there is data ("a laptop under $1000"), never a price. */
const QUOTED_RE = /"(?:[^"\\]|\\.)*"/g;

/**
 * The other services an offer names, by price in atomic USDC: every spec
 * beside the offer's own (its line and its specs name the same ids), or, for
 * an offer with no specs, each price the line quotes.
 */
function listedPrices(offer: OfferDecision): bigint[] {
  if (offer.specs !== undefined) {
    return offer.specs
      .filter((spec) => spec.id !== offer.id)
      .flatMap((spec) => (isAccountSpec(spec) ? [] : [BigInt(spec.priceAtomic)]));
  }
  return [...offer.hint.replace(QUOTED_RE, '""').matchAll(LISTED_PRICE_RE)].flatMap((match) => {
    try {
      return [BigInt(parseUsdToAtomic((match[1] ?? match[2]) as string))];
    } catch {
      return [];
    }
  });
}

/** A listed price as a line quotes one: dollars with at least two decimals. */
function listedUsd(atomic: bigint): string {
  const [whole, fraction = ''] = toMoney(atomic.toString()).usd.split('.');
  return `${whole}.${fraction.padEnd(2, '0')}`;
}

/**
 * ONE SENTENCE FOR A LISTED SERVICE OVER THE AUTO-SPEND CAP, or null. The offer
 * itself already fits (it passed {@link spendShortfall}), so a price over the
 * cap here is another entry: People Data Labs at $0.28 beside a $0.005 email
 * finder, under a $0.25 cap, was picked and refused. Quiet when the offer
 * names no such price or the settings cannot be read.
 */
async function overCapNote(
  offer: OfferDecision,
  deps: HookDeps,
  canAskUser: boolean,
): Promise<string | null> {
  const listed = listedPrices(offer);
  if (listed.length === 0) return null;
  let cap: bigint;
  try {
    cap = (await resolveContextSettings(hookContext(deps))).policy.maxAutoSpendAtomic;
  } catch {
    return null;
  }
  const over = [...new Set(listed.filter((atomic) => atomic > cap).map(listedUsd))];
  if (over.length === 0) return null;
  const prices = over.map((usd) => `$${usd}`).join(' and ');
  const which = over.length > 1 ? 'those services' : 'that service';
  return (
    `Note: ${prices} ${over.length > 1 ? 'are' : 'is'} above this machine's automatic per-call limit ` +
    `($${toMoney(cap.toString()).usd}), so request returns needs_approval for ${which}; ` +
    (canAskUser ? 'prefer one within the limit.' : 'use one within the limit.')
  );
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
  const event = eventOf(raw, deps);
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
  const event = eventOf(raw, deps);
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
    scoped(
      await buildPromptPacket(event.transcriptPath, event.sessionId, text, hostOf(deps)),
      router.settings,
    ),
  );
  const footer = await openFooter(deps, event.sessionId, 'prompt');
  const deadline = gateDeadline(deps);
  const outcome = await decide(sealed, deps, router, event.sessionId, deadline);
  if (!isOffer(outcome)) {
    await footer.close(outcome);
    return { response: null, ...(outcome !== null ? { action: outcome.action } : {}) };
  }
  const ruledOut = withheldBySettings(outcome, router.settings);
  if (ruledOut !== null) {
    await footer.close(outcome, { withheld: ruledOut });
    return { response: null, action: outcome.action, withheld: true };
  }
  const vetted = await vetOffer(outcome, deps, deadline, true);
  if (vetted.withheld !== undefined) {
    await footer.close(outcome, { withheld: vetted.withheld });
    return { response: null, action: outcome.action, withheld: true };
  }
  await footer.close(outcome);
  return {
    action: outcome.action,
    id: outcome.id,
    ...injection(hookEventName, attributed(vetted.offer.hint, hostOf(deps))),
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

/** An `execute` the balance pays: it names its URL, and every spec on it is
 *  a paid one. The schema holds every `execute` that does not lead with an
 *  account service to exactly this. */
type ExecuteDecision = Extract<HookDecision, { action: 'execute' }> & {
  endpoint: string;
  specs?: OfferSpec[];
};

/**
 * AN OFFER LED BY A SERVICE ON THE USER'S CONNECTED ACCOUNT (#37): no URL,
 * nothing the balance pays, and Tenjin's own route for the job beside it,
 * which a refusal offers. The server sends one only for an account this
 * machine says is connected, alone and checked, with `bound` when it can run
 * in place of the native call it holds.
 */
type AccountExecute = Extract<HookDecision, { action: 'execute' }> & {
  endpoint?: undefined;
  specs: AnyOfferSpec[];
};

/**
 * AN ANSWER THAT OFFERS SOMETHING: a curated capability (`execute`), a service
 * on the user's own account, or a pay-per-call service the server found for a
 * step nothing curated serves (`discovered`). Each carries an id and a
 * finished line, and every hook shows them in the same place, under the same
 * rules; only one the balance pays meets the spend check.
 */
type OfferDecision =
  ExecuteDecision | AccountExecute | Extract<HookDecision, { action: 'discovered' }>;

function isAccountOffer(decision: HookDecision | null): decision is AccountExecute {
  return decision?.action === 'execute' && (decision.specs ?? []).some(isAccountSpec);
}

function isOffer(decision: HookDecision | null): decision is OfferDecision {
  if (decision?.action === 'discovered') return true;
  return (
    decision?.action === 'execute' && (decision.endpoint !== undefined || isAccountOffer(decision))
  );
}

/** What the spend check and the footer read, for any kind of offer. An
 *  account's has no URL, and costs the balance nothing. */
function termsOf(offer: OfferDecision): {
  provider: string;
  providerPriceAtomic: string;
  endpoint?: string;
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
 *  the wallet. A discovered service is never one: it is always a sale. Nor is
 *  one on the user's account, which their own plan pays. */
function isFree(offer: OfferDecision): offer is ExecuteDecision {
  return offer.action === 'execute' && offer.providerPriceAtomic === '0' && !isAccountOffer(offer);
}

/**
 * THE PACKET FOR A NATIVE CALL, sealed, or null when nothing may be asked
 * about it. Shared by both native arms and the swap ({@link decideSwap}).
 */
async function sealNative(
  event: Omit<NativeCall, 'tool' | 'pending'>,
  pending: PendingCall,
  settings: RouterSettings,
  deps: HookDeps,
  nativeOutcome?: NativeOutcome,
): Promise<Sealed | null> {
  const warn = deps.warn ?? ((line: string) => process.stderr.write(`${line}\n`));
  // THE USER'S WORDS COME WITH IT. Building this from the tool argument alone
  // made the search string the whole conversation, so "native tools only, no
  // paid services" never reached this gate. Inside a subagent, its own task
  // comes first: see `buildNativePacket`.
  const sealed = seal(
    scoped(
      await buildNativePacket(event.transcriptPath, event.sessionId, pending, {
        ...(event.agentId !== undefined ? { agentId: event.agentId } : {}),
        ...(nativeOutcome !== undefined ? { nativeOutcome } : {}),
        harness: hostOf(deps),
      }),
      settings,
    ),
  );
  // A LOCAL TARGET ONLY EVER HAS A NATIVE ANSWER, so asking costs a round trip
  // and sends the conversation for nothing.
  if (sealed.localTarget) return null;
  // A CREDENTIAL IN THE SEARCH OR URL NEVER LEAVES. Sending it masked would put
  // the mask into the hint the server writes from it, and the model would call
  // the provider with the mask. The call stays native.
  if (sealed.subjectChanged) {
    warn('tenjin hook: the native call carries a credential-shaped value, so it is not routed');
    return null;
  }
  // AND WHEN THEY CANNOT BE READ, NOTHING IS OFFERED. An offer routed on the
  // tool argument alone is how an instruction the user gave this turn gets
  // overruled by a decision that never saw it.
  if (sealed.packet.historyStatus !== 'ok') {
    warn("tenjin hook: this session's transcript could not be read, so no paid lookup is offered");
    return null;
  }
  return sealed;
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
    /** The decision the swap already made for this very call ({@link
     *  decideSwap}): used as the router's answer, so one search is never
     *  decided, or charged a routing fee, twice. */
    recorded?: { decision: HookDecision | null };
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
  const { recorded } = opts;
  const sealed =
    recorded === undefined
      ? await sealNative(event, pending, router.settings, deps, nativeOutcome)
      : undefined;
  if (sealed === null) return { offer: null, outcome: { response: null } };
  const footer = await openFooter(deps, event.sessionId, opts.operation ?? 'search');
  const deadline = gateDeadline(deps);
  const outcome =
    sealed === undefined
      ? (recorded?.decision ?? null)
      : await decide(sealed, deps, router, event.sessionId, deadline);
  if (!isOffer(outcome)) {
    await footer.close(outcome);
    return {
      offer: null,
      outcome: { response: null, ...(outcome !== null ? { action: outcome.action } : {}) },
    };
  }
  // BEFORE THE FREE PASS TOO: the free docs lookup is still a call to a
  // provider, and its prefetch starts the moment it passes, so an offer the
  // user's rules refuse neither redirects nor fetches anything.
  const ruledOut = withheldBySettings(outcome, router.settings);
  if (ruledOut !== null) {
    await footer.close(outcome, { withheld: ruledOut });
    return { offer: null, outcome: { response: null, action: outcome.action, withheld: true } };
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
  const event = eventOf(raw, deps);
  if (event?.kind !== 'native' || event.pending === null) return { response: null };
  const target = redirectTarget(event.pending);
  // A batch is blocked at most once: the redirect claims every search and URL
  // in it, and a call naming any claimed one runs.
  const targets = [...new Set((event.targets ?? [event.pending]).map(redirectTarget))];
  const session = localSession(event.sessionId, deps);
  const claim = (t: string) => claimRedirect(deps.dataDir, session, event.agentId, t, deps.now?.());
  // THE SWAP HANDED THIS CALL BACK: its decision stands, and is not asked for again.
  const recorded =
    event.toolUseId !== undefined && event.agentId === undefined
      ? await takeDecided(deps.dataDir, session, event.toolUseId, target, deps.now?.())
      : undefined;
  const routed = await routeNativeCall(event, event.pending, deps, {
    ...(recorded !== undefined ? { recorded } : {}),
    passFree: true,
    repeated: async () => {
      if (!(await claim(target))) return true;
      await Promise.all(targets.filter((t) => t !== target).map(claim));
      return false;
    },
    redirected: async () => {
      for (const t of targets) {
        if (await redirectClaimed(deps.dataDir, session, event.agentId, t, deps.now?.())) {
          return true;
        }
      }
      return false;
    },
  });
  if (routed.offer === null) return routed.outcome;
  if (routed.free === true) {
    const { pending } = event;
    const augmenting =
      pending.tool === 'WebSearch' &&
      (await startAugment(
        {
          sessionId: session,
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
      session,
      event.toolUseId,
      offeredTerms(routed.offer),
      deps.now?.(),
    );
  }
  return redirect(
    routed.offer,
    hostOf(deps),
    event.rest === undefined ? ONE_BLOCK : `${ONE_BLOCK} ${restSentence(event.rest)}`,
  );
}

/** What the swap's decision came to: the call to run in the native call's
 *  place, or why the call goes back to the host's own flow. */
export type SwapDecision =
  | { handback: string }
  | {
      offer: OfferDecision;
      /** The lead's spec, which `bound` fills: a paid one, or a service on
       *  the user's connected account. */
      spec: AnyOfferSpec;
      bound: Record<string, unknown>;
      /** The native call it runs in place of, for the receipt. */
      tool: 'WebSearch' | 'WebFetch';
      /**
       * Claims every search or URL of the call for the main agent, as a
       * redirect does, and marks the call answered in place. False when a
       * claim is already held: the call then goes back, and runs natively.
       */
      claim: () => Promise<boolean>;
      /**
       * After a claim, the call goes back after all: its mark no longer says
       * it was answered in place, or names the pick, so the mod draws the
       * native call that runs. The claim and the one routing answer stay.
       */
      unmark: () => Promise<void>;
    };

/**
 * WHY THE AUTOMATIC SWITCH AND ITS SCOPE KEEP A PICK FROM RUNNING IN PLACE,
 * or null when they let it: the switch off, or a narrowed provider scope the
 * route does not fit, which a route with no known provider never does. After
 * selection, never instead of it: a pick outside is an ordinary offer.
 */
export function outsideAutomaticUse(
  replacement: ReplacementSetting,
  identity: OfferSpec['identity'],
): string | null {
  if (replacement.mode !== 'when-routed') return 'automatic use is off';
  const { providers } = replacement;
  if (
    providers !== undefined &&
    (identity === undefined || !replacementFits(identity, providers))
  ) {
    return 'outside automatic use';
  }
  return null;
}

/**
 * THE SWAP'S DECISION, for a host that can answer a WebSearch or WebFetch in
 * place (`router.nativeReplacement: when-routed`, the Claude Code mod). The
 * same route the pre-call hook takes: the switch, the transcript, the hook
 * body (so the gate's confidence floor applies), the user's rules and the
 * spend check. On top of it, only a decision that names a spec and carries
 * `bound` (the complete input the router built from this call's own search
 * or URL) for a provider inside the automatic scope can run in place. The
 * input is never built, parsed or edited here.
 *
 * Anything else HANDS THE CALL BACK, and the decision is kept for it
 * ({@link keepDecided}): the pre-call hook then offers from it, as it would
 * have, without asking again. The main agent only: a subagent's call takes
 * the ordinary route.
 */
export async function decideSwap(raw: unknown, deps: HookDeps): Promise<SwapDecision> {
  if (hostOf(deps) !== 'claude') return { handback: 'this host cannot run a pick in place' };
  const event = decodeEvent(raw);
  if (
    event?.kind !== 'native' ||
    event.pending === null ||
    event.pending.tool === 'AskUserQuestion' ||
    event.toolUseId === undefined
  ) {
    return { handback: 'not a search or fetch Tenjin routes' };
  }
  if (event.agentId !== undefined) return { handback: 'a subagent call' };
  // THE SWITCH, READ NOW from the global file alone: a project file cannot
  // turn it on, and turning it off applies to the very next call.
  const router = await routerFor(event.cwd, deps);
  if (router === null) return { handback: 'Tenjin is off here' };
  const { nativeReplacement } = router.settings;
  if (nativeReplacement.mode !== 'when-routed') return { handback: 'automatic use is off' };
  const { pending, toolUseId } = event;
  const session = localSession(event.sessionId, deps);
  const target = redirectTarget(pending);
  const targets = [...new Set((event.targets ?? [pending]).map(redirectTarget))];
  // A RETRY OF A CALL ALREADY ROUTED runs natively, as after a redirect.
  for (const t of targets) {
    if (await redirectClaimed(deps.dataDir, session, undefined, t, deps.now?.())) {
      return { handback: 'already routed once' };
    }
  }
  const sealed = await sealNative(event, pending, router.settings, deps);
  if (sealed === null) return { handback: 'not routed' };
  const footer = await openFooter(deps, event.sessionId, 'search');
  const deadline = gateDeadline(deps);
  const outcome = await decide(sealed, deps, router, event.sessionId, deadline);
  await keepDecided(deps.dataDir, session, toolUseId, target, outcome, deps.now?.());
  const back = async (why: string): Promise<SwapDecision> => {
    await footer.close(outcome, isOffer(outcome) ? { withheld: why } : undefined);
    return { handback: why };
  };
  if (!isOffer(outcome)) return back('no paid lookup fits');
  const spec = outcome.specs?.find(({ id }) => id === outcome.id);
  // NOTHING TO RUN AS IT STANDS: no `bound` (an older router, a free docs
  // lookup, a choice to make, a map Tenjin has not checked) or no spec for it
  // to fill. A checked map on the user's own account runs in place like any
  // pick, and its own plan pays.
  if (
    outcome.bound === undefined ||
    spec === undefined ||
    isFree(outcome) ||
    (outcome.action === 'discovered' && outcome.choices !== undefined)
  ) {
    return back('no input to run in place');
  }
  if (withheldBySettings(outcome, router.settings) !== null) return back('settings rule it out');
  // THE AUTOMATIC SCOPE, after selection and never instead of it. `runSwap`
  // reads it again before anything runs.
  const outside = outsideAutomaticUse(nativeReplacement, spec.identity);
  if (outside !== null) return back(outside);
  // ONLY A CALL THAT WOULD RUN ON ITS OWN: over a limit, or a wallet that
  // cannot pay, goes back to the offer, whose request asks for approval. An
  // account's call meets no limit, and only needs the job on this account.
  const vetted = await vetOffer(outcome, deps, deadline, false);
  if (vetted.withheld !== undefined) return back(vetted.withheld);
  // Kept like a shown offer's: the spec `request({id, input})` runs.
  await footer.close(outcome);
  const now = () => deps.now?.() ?? Date.now();
  const terms = { ...offeredTerms(outcome), swap: true as const };
  return {
    offer: outcome,
    spec,
    bound: outcome.bound,
    tool: pending.tool,
    claim: async () => {
      if (!(await claimRedirect(deps.dataDir, session, undefined, target, now()))) return false;
      await Promise.all(
        targets
          .filter((t) => t !== target)
          .map((t) => claimRedirect(deps.dataDir, session, undefined, t, now())),
      );
      await markOffered(deps.dataDir, session, toolUseId, terms, now());
      return true;
    },
    unmark: () => markHandedBack(deps.dataDir, session, toolUseId, now()),
  };
}

/**
 * The deny blocked the whole Codex call: the rest of it, exactly as written,
 * to run again natively.
 */
function restSentence(rest: Record<string, unknown>): string {
  return `Nothing else in this web.run call ran either; to run the rest as written, call web.run again with exactly ${JSON.stringify(rest)}`;
}

/** What the offer record keeps of a redirect: the offer's id, its label, from
 *  its decision or else its own spec, and its price. */
function offeredTerms(offer: OfferDecision): OfferedTerms {
  const label =
    (offer.action === 'execute' ? offer.label : undefined) ??
    offer.specs?.find((spec) => spec.id === offer.id)?.label;
  return {
    offerId: offer.id,
    ...(label !== undefined ? { label } : {}),
    // An account's call costs the balance nothing: no price to show.
    ...(isAccountOffer(offer) ? {} : { priceAtomic: termsOf(offer).providerPriceAtomic }),
  };
}

/**
 * Deny the call once with the server's line: the redirect both pre-call arms
 * make, after `routeNativeCall` has claimed its target ({@link claimRedirect}).
 */
function redirect(offer: OfferDecision, host: Harness, oneBlock = ONE_BLOCK): NativeHookOutcome {
  return {
    response: {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        // THE SERVER'S LINE, attributed and tool-named, then this client's one
        // sentence. The line already carries the id and the exact search, URL
        // or question that was denied.
        permissionDecisionReason: `${attributed(offer.hint, host)} ${oneBlock}`,
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
 * with a note that the call needs approval or funds; here the question IS
 * the asking, so denying it for a call that cannot run alone strands the
 * turn. Any shortfall, curated or discovered, withholds the offer and the
 * question runs.
 */
export async function runAskHook(raw: unknown, deps: HookDeps): Promise<NativeHookOutcome> {
  const event = eventOf(raw, deps);
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
  if (event.toolUseId !== undefined) {
    await markOffered(
      deps.dataDir,
      localSession(event.sessionId, deps),
      event.toolUseId,
      offeredTerms(routed.offer),
      deps.now?.(),
    );
  }
  return redirect(routed.offer, hostOf(deps), ONE_BLOCK_QUESTION);
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
  const event = eventOf(raw, deps);
  if (event?.kind !== 'shortfall') return { response: null };
  const augment = await finishAugment(
    {
      sessionId: localSession(event.sessionId, deps),
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
    (await wasOffered(
      deps.dataDir,
      localSession(event.sessionId, deps),
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
  if (docsJustMissed && isFree(routed.offer))
    return { response: null, nativeOutcome, action: 'execute' };
  return {
    response: {
      hookSpecificOutput: {
        hookEventName: eventName,
        // THE SERVER'S LINE, attributed and framed as the option it is. It
        // already carries the id and the exact search or URL that came back short.
        additionalContext: shortfallOffer(event.tool, routed.offer.hint, hostOf(deps)),
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
  const event = eventOf(raw, deps);
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
  const outcome = await decide(sealed, deps, router, event.sessionId, deadline);
  if (!isOffer(outcome)) {
    await footer.close(outcome);
    return { response: null, ...(outcome !== null ? { action: outcome.action } : {}) };
  }
  const ruledOut = withheldBySettings(outcome, router.settings);
  if (ruledOut !== null) {
    await footer.close(outcome, { withheld: ruledOut });
    return { response: null, action: outcome.action, withheld: true };
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
  sessionId = localSession(sessionId, deps);
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
        // `request({id, input})` runs and `request({id})` shows, and its
        // choice set is what `request({id, choice})` picks from. An account's
        // lead is kept with Tenjin's own route for its job.
        if (isAccountOffer(decision)) {
          const lead = decision.specs.find((spec) => spec.id === decision.id);
          if (lead !== undefined && isAccountSpec(lead))
            await storeAccountOffer(deps.dataDir, lead, decision.fallback);
        } else {
          await storeSpecs(deps.dataDir, decision.specs);
        }
        if (decision.action === 'discovered' && decision.choices !== undefined) {
          await storeChoices(deps.dataDir, decision.id, {
            choices: decision.choices,
            hint: decision.hint,
          });
        }
      }
    },
  };
}

/** What the gate decided, in the footer's own words. A silent backend is not a
 *  blank line: the turn runs on native tools and the footer says which. */
function hookOutcome(decision: HookDecision | null): string {
  if (decision === null) return 'native tools (router unavailable)';
  if (isAccountOffer(decision)) return `account lookup offered (${decision.provider})`;
  if (isOffer(decision)) return `paid lookup offered (${termsOf(decision).provider})`;
  if (decision.action === 'native') return 'native tools (no x402 payment)';
  return 'needs input';
}

/** The one routing call, its packet SEALED (masked and bounded): a path that
 *  skips the mask does not typecheck. Inside `tenjin mcp` it takes the paid
 *  path; a call that path cannot pay takes the free path, and the first such
 *  call in a session tells the user why and what fixes it.
 *
 *  BACKOFF: a call that could not reach the router starts the machine's
 *  `unreachable` memo, and for its minute every leg skips the call and the
 *  native tool runs at once, rather than each one waiting out the gate. It
 *  ends after its minute, or when `tenjin doctor` reaches the router. */
async function decide(
  { packet }: Sealed,
  deps: HookDeps,
  router: { settings: RouterSettings; config: PartialConfig },
  sessionId: string,
  deadline: number,
): Promise<HookDecision | null> {
  const { config } = router;
  // THE SAVED RULES RIDE BESIDE THE PACKET, never in it: the packet is what
  // the server's model reads. Absent with no rules, so the body is unchanged.
  const policy = router.settings.policy.status === 'ok' ? router.settings.policy.wire : undefined;
  const baseUrl = resolveBaseUrl(deps, config);
  const warn = deps.warn ?? ((line: string) => process.stderr.write(`${line}\n`));
  const now = deps.now?.() ?? Date.now();
  const backoff = await readRouterMemo(deps.dataDir, 'unreachable', baseUrl, now);
  if (backoff !== null) {
    const left = Math.ceil((backoff.until - now) / 1000);
    warn(`tenjin hook: ${baseUrl} did not answer a moment ago, so the native tool runs (${left}s)`);
    return null;
  }
  const route = (await deps.route?.(baseUrl)) ?? null;
  const outcome = await requestDecision(
    'hook',
    { packet, sessionId },
    {
      ctx: hookContext(deps),
      baseUrl,
      acceptsBazaar: resolveExperimentalBazaar(config).value === 'on',
      harness: hostOf(deps),
      timeoutMs: Math.max(0, deadline - now),
      ...(policy !== undefined ? { policy } : {}),
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
      ...(route !== null ? { route } : {}),
    },
  );
  // A DEPOSIT IS NEWS ONCE, when it is taken: it moved money into routing
  // credit, and the user would otherwise see it only as spend.
  const deposited = route?.deposited?.() ?? 0n;
  if (deposited > 0n) deps.notice?.(depositSentence(deposited));
  const why =
    outcome.status === 'skipped'
      ? outcome.why
      : (outcome.freePath ??
        (outcome.status === 'decided' && isFeeRequired(outcome.decision)
          ? FEE_REQUIRED
          : undefined));
  // A `fee_required` on a call the machine's "no paid path" memo sent to the
  // free path is stale news, not a fault: the memo is cleared below and the
  // next call pays. It does not use up the session's one notice.
  const memoed = deps.route !== undefined && route === null;
  if (why !== undefined && !(memoed && why === FEE_REQUIRED)) {
    await tellOnce(deps, sessionId, why, now);
  }
  // A PAID CALL WENT THROUGH: a wallet reason told earlier in this session is
  // over, and the session hears so once ("Tenjin wallet unlocked." or
  // "... funded."). Only a decided call that did not fall back to the free path.
  if (route !== null && outcome.status === 'decided' && outcome.freePath === undefined) {
    const cleared = await noticeCleared(deps.dataDir, sessionId, now).catch(() => null);
    if (cleared !== null) deps.notice?.(cleared);
  }
  // The fee is on: a "no paid path" remembered from before stops holding the
  // machine's calls on the free path.
  if (outcome.status === 'decided' && isFeeRequired(outcome.decision)) {
    await clearRouterMemo(deps.dataDir, 'paid-path-absent', baseUrl);
  }
  if (outcome.status === 'skipped') {
    warn(`tenjin hook: the routing fee was not paid (${outcome.why}), so the native tool runs`);
    return null;
  }
  if (outcome.freePath !== undefined) {
    warn(`tenjin hook: the routing fee was not paid (${outcome.freePath}), so the free path ran`);
  }
  if (outcome.status === 'failed' && outcome.unreachable === true) {
    await writeRouterMemo(deps.dataDir, 'unreachable', baseUrl, {
      now: deps.now?.() ?? Date.now(),
      ttlMs: UNREACHABLE_BACKOFF_MS,
      detail: outcome.reason,
    });
  } else if (
    outcome.status === 'decided' ||
    (outcome.status === 'failed' && outcome.noAnswer !== true)
  ) {
    // Only an answer ends it: a concurrent call that timed out, or got no
    // answer for any other reason, leaves another call's backoff in place.
    await clearRouterMemo(deps.dataDir, 'unreachable', baseUrl);
  }
  if (outcome.status === 'failed') {
    warn(`tenjin hook: ${baseUrl}${route?.path ?? ROUTER_PATH} ${outcome.reason}`);
    return null;
  }
  return servableHere(outcome.decision.decision, deps.dataDir);
}

/**
 * ONE LINE FOR THE USER, ONCE PER SESSION AND REASON, when a call could not
 * pay the routing fee for a reason the user can fix: the reason and the fix,
 * in the hook's `systemMessage`. Never on every call, and never in place of
 * routing. A different reason later in the session is news again (a missing
 * passphrase repaired into a wrong one), the same one is not.
 */
async function tellOnce(deps: HookDeps, sessionId: string, why: string, now: number) {
  const sentence = unpaidSentence(why);
  if (sentence === null || deps.notice === undefined) return;
  const told = await noticeFor(deps.dataDir, sessionId, why, now).catch(() => 'quiet' as const);
  if (told === 'tell') deps.notice(sentence);
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
    if (!settings.enabled.value) return null;
    // RULES THIS BUILD CANNOT READ OFFER NOTHING: no rule is guessed, and no
    // turn is routed without them. `tenjin config` shows the problem.
    if (settings.policy.status === 'invalid') {
      warn(
        `tenjin hook: your Tenjin settings can't be read (${settings.policy.problem}), so no lookup is offered`,
      );
      return null;
    }
    return { settings, config };
  } catch (err) {
    warn(`tenjin hook: ${err instanceof Error ? err.message : String(err)}, so the router is off`);
    return null;
  }
}

/**
 * AN OFFER THE USER'S RULES REFUSE IS NEVER SHOWN, in the footer's words why,
 * or null when it may be. Every service the line names is held to the rules
 * read for this event: the offer's own identity, and each spec's. Under a
 * rule that reads identity, an offer with none (a router from before it) is
 * withheld too. Local only: no directory call fits a hook's budget, and the
 * request tool checks again before anything runs. The server applied the
 * same rules first; this is the same check on this side of the wire.
 */
function withheldBySettings(offer: OfferDecision, settings: RouterSettings): string | null {
  const policy = settings.policy.status === 'ok' ? settings.policy.wire : undefined;
  const specs = offer.specs?.map((spec) => spec.identity) ?? [];
  const identities =
    offer.action === 'execute'
      ? [offer.identity, ...specs]
      : specs.length > 0
        ? specs
        : [undefined];
  const verdict = admitRoutes(identities, policy);
  if (verdict.ok) return null;
  return 'unverified' in verdict ? "can't check settings" : 'settings rule it out';
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

function hostOf(deps: HookDeps): Harness {
  return deps.harness ?? 'claude';
}

/** The harness's event in the arms' shape, from that harness's own decoder. */
function eventOf(raw: unknown, deps: HookDeps): HookEvent | null {
  return hostOf(deps) === 'codex' ? codexRouterEvent(raw) : decodeEvent(raw);
}

/** Where this session's local state lives; a Codex session never shares Claude's. */
function localSession(sessionId: string, deps: HookDeps): string {
  return hostOf(deps) === 'codex' ? codexSession(sessionId) : sessionId;
}
