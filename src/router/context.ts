import { open } from 'node:fs/promises';
import { isIP } from 'node:net';
import { dirname, join } from 'node:path';
import { isPublicAddress } from '../lib/destination';
import { mask } from '../lib/redact';
import { parseCodexHistory } from './codex-history';
import type { Harness } from './names';

/**
 * The bounded conversation packet the router's gate and paid decision read.
 *
 * WHAT GOES IN IT: ordinary user and assistant text from the CURRENT session
 * only (and, for a subagent's own native call, that one subagent's rows), at
 * most {@link MAX_HISTORY} prior messages and at most {@link MAX_PACKET_BYTES}
 * in total, oldest dropped first. The builders below choose the text;
 * {@link seal} masks and bounds it, and is the only way a packet reaches the
 * wire. Tool results are excluded: a tool result is other people's content,
 * and a packet that carried it would be a channel from a fetched page into a
 * routing decision.
 *
 * WHAT NEVER HAPPENS: a transcript this reader cannot vouch for is reported
 * as `unavailable` rather than partially believed, and the user's turn is
 * never blocked by any of that. Another session's rows, a subagent sidechain,
 * malformed rows and everything before a compaction boundary are skipped row
 * by row. A file over {@link MAX_TRANSCRIPT_BYTES} is read from its tail
 * ({@link readTail}), where this turn's own words are. Adapted from the draft
 * auto-mode experiment (PR #369 `context.ts`), whose 48,000-character reader
 * this tightens.
 */

export const MAX_HISTORY = 6;
export const MAX_PACKET_BYTES = 16 * 1024;
/** Every bound here is the server's own (tenjin `lib/x402-router/wire.ts`). A
 *  packet this side lets through and that side refuses is a paid 400. */
export const MAX_MESSAGE_CHARS = 16_000;
/** How much of a transcript is read: all of a smaller one, the last this many
 *  bytes of a larger one. A long working session passes 4 MB in a day. */
const MAX_TRANSCRIPT_BYTES = 4_000_000;
const MAX_LITERAL_URLS = 8;
const MAX_LITERAL_URL_CHARS = 2_000;
/** The server's caps on `current.quoted`: blocks, each one a message's size. */
const MAX_QUOTED = 8;
const MAX_PENDING_CHARS = 4_000;
/** The server's cap on a native outcome's error text. */
const MAX_OUTCOME_ERROR_CHARS = 1_000;
/** Scanned past each bound: longer than any secret shape the mask knows. */
const MASK_MARGIN = 4_096;

export type PacketRole = 'user' | 'assistant';
export interface PacketMessage {
  role: PacketRole;
  text: string;
  /**
   * On `current` only: blocks the harness marked as pasted, moved out of
   * `text` so the text is the user's own words ({@link splitPasted}).
   */
  quoted?: string[];
}

export type HistoryStatus = 'ok' | 'unavailable';

export interface Packet {
  current: PacketMessage;
  history: PacketMessage[];
  /** Absolute http(s) URLs written literally in the current message. */
  literalUrls: string[];
  /**
   * The entries of `literalUrls` the host can open with its own tools: links
   * on the host of the current repository's git remote, and the harness's own
   * links ({@link SealOptions}). Absent when there are none.
   */
  ownUrls?: string[];
  historyStatus: HistoryStatus;
  pendingCall?: PendingCall;
  /** How the free tool already fared on `pendingCall`, sent only when it fell
   *  short. Never without `pendingCall`: the server refuses it alone. */
  nativeOutcome?: NativeOutcome;
}

/** What the harness reported about a native call that came back short: its
 *  status and size (WebFetch), or the error a failed call carried. At least one
 *  field, always; the server's schema is the same strict object. */
export interface NativeOutcome {
  code?: number;
  bytes?: number;
  error?: string;
  /** Why a call whose status and size look fine still came back short. */
  reason?: NativeShortfallReason;
}

/**
 * The client's own reading of a native result, named where the code and the
 * size say nothing. `no_main_content`: WebFetch answered 2xx with a full body,
 * and its summary says the page was empty, only a title, navigation or a
 * footer, or needed JavaScript it did not run (a script-rendered app, a video
 * page) (`readsAsEmptyPage`). The server picks the reader from the URL.
 */
export type NativeShortfallReason = 'no_main_content';

/** The pending native call, INSIDE the packet: the gate request is a strict
 *  object with exactly `schemaVersion`, `source` and `packet`. An
 *  `AskUserQuestion` carries the host's own question and its options, joined. */
export type PendingCall =
  | { tool: 'WebSearch'; query: string }
  | { tool: 'WebFetch'; url: string }
  | { tool: 'AskUserQuestion'; question: string };

/** The one string a pending call is about: its search, its URL or its question. */
export function subjectOf(pending: PendingCall): string {
  return 'query' in pending ? pending.query : 'url' in pending ? pending.url : pending.question;
}

/** The same call about a different subject, of the same kind. */
function withSubject(pending: PendingCall, subject: string): PendingCall {
  if ('query' in pending) return { tool: pending.tool, query: subject };
  if ('url' in pending) return { tool: pending.tool, url: subject };
  return { tool: pending.tool, question: subject };
}

const URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]]+/gi;

export function literalUrlsIn(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(URL_RE)) {
    const candidate = match[0].replace(/[.,;:!?]+$/, '');
    try {
      const normalized = new URL(candidate).toString();
      if (normalized.length <= MAX_LITERAL_URL_CHARS) found.add(normalized);
    } catch {
      continue;
    }
    if (found.size >= MAX_LITERAL_URLS) break;
  }
  return [...found];
}

/**
 * Bring the packet inside the server's caps: oldest history first, then the
 * current message itself, measured on the WHOLE packet rather than on the two
 * message lists, because `literalUrls` and a pending call are bytes too.
 *
 * EXPORTED BECAUSE ATTACHING ANYTHING RE-OPENS THE QUESTION. A packet this
 * returned at exactly the cap is over it the moment a caller adds a field, and
 * the server refuses rather than truncates, so every caller that adds one runs
 * this again on what it is actually going to send.
 */
export function fit(packet: Packet): Packet {
  const size = (value: Packet): number => Buffer.byteLength(JSON.stringify(value));
  const next: Packet = { ...packet, history: packet.history.slice(-MAX_HISTORY) };
  // In order of what is cheapest to lose. History first: a prior turn is
  // context. Then the literal URLs, which are a convenience the server can
  // re-derive from the text. The current message LAST, because it is the task
  // itself, and only down to one character, so a packet is never empty.
  while (next.history.length > 0 && size(next) > MAX_PACKET_BYTES) {
    next.history = next.history.slice(1);
  }
  while (next.literalUrls.length > 0 && size(next) > MAX_PACKET_BYTES) {
    next.literalUrls = next.literalUrls.slice(0, -1);
    // `ownUrls` names entries of `literalUrls`, so it loses what that loses.
    const own = next.ownUrls?.filter((url) => next.literalUrls.includes(url)) ?? [];
    if (own.length > 0) next.ownUrls = own;
    else delete next.ownUrls;
  }
  // Then what the user pasted, last block first: it is context for the task,
  // and the task is the user's own words.
  while ((next.current.quoted?.length ?? 0) > 0 && size(next) > MAX_PACKET_BYTES) {
    const quoted = next.current.quoted!.slice(0, -1);
    const { role, text } = next.current;
    next.current = quoted.length > 0 ? { role, text, quoted } : { role, text };
  }
  while (size(next) > MAX_PACKET_BYTES && next.current.text.length > 1) {
    const over = size(next) - MAX_PACKET_BYTES;
    const keep = Math.max(1, next.current.text.length - Math.max(over, 1));
    next.current = { ...next.current, text: next.current.text.slice(0, keep) };
  }
  return next;
}

/** What {@link seal} is told beside the packet. */
export interface SealOptions {
  /**
   * The hosts whose links the host opens with its own tools: the current
   * repository's git remotes, and the harness's own (`own-urls.ts`). Each
   * sealed literal URL on one of them is also listed in `ownUrls`.
   */
  ownHosts?: readonly string[];
}

export interface Sealed {
  packet: Packet;
  /** The mask changed the pending call's search or URL. */
  subjectChanged: boolean;
  /** The pending WebFetch targets this machine or a private network. */
  localTarget: boolean;
  /** The mask changed the current message. */
  currentChanged: boolean;
  /** A literal URL in the packet targets this machine or a private network. */
  localUrl: boolean;
}

/**
 * THE ONE OUTBOUND CHOKEPOINT. Every string that leaves in a hook packet is
 * masked here, `current` and its `quoted` blocks, `history`, `literalUrls` and
 * the pending call alike,
 * and only then bounded ({@link maskWithin}): a secret cut in half by a bound
 * before the mask no longer matches its row, and its first half would leave. The server stores
 * the packet against the id, so a secret here is a secret in its database.
 *
 * It also says what the caller must not send at all. A masked subject would
 * become the query the server writes into its hint, and a local or private
 * target can only ever be answered natively; both run unrouted.
 */
export function seal(packet: Packet, opts: SealOptions = {}): Sealed {
  const pending = packet.pendingCall;
  const subject = pending === undefined ? '' : subjectOf(pending);
  const sealedSubject = maskWithin(subject, MAX_PENDING_CHARS);
  const bound = (text: string): string => maskWithin(text, MAX_MESSAGE_CHARS).text;
  const sealedCurrent = maskWithin(packet.current.text, MAX_MESSAGE_CHARS);
  const current = sealedCurrent.text;
  const quoted = (packet.current.quoted ?? [])
    .slice(0, MAX_QUOTED)
    .map(bound)
    .filter((block) => block.length > 0);
  const outcome = packet.nativeOutcome;
  const literalUrls = packet.literalUrls
    .filter((url) => !isLocalTarget(url))
    .map(mask)
    .filter((url) => url.length <= MAX_LITERAL_URL_CHARS);
  const ownHosts = new Set((opts.ownHosts ?? []).map((host) => host.toLowerCase()));
  const ownUrls = literalUrls
    .filter((url) => ownHosts.has(hostnameOf(url)))
    .slice(0, MAX_LITERAL_URLS);
  const sealed = fit({
    current: {
      role: packet.current.role,
      text: current.length > 0 ? current : '(no task text)',
      ...(quoted.length > 0 ? { quoted } : {}),
    },
    history: packet.history
      .slice(-MAX_HISTORY)
      .map((message) => ({ role: message.role, text: bound(message.text) }))
      .filter((message) => message.text.length > 0),
    literalUrls,
    ...(ownUrls.length > 0 ? { ownUrls } : {}),
    historyStatus: packet.historyStatus,
    ...(pending === undefined ? {} : { pendingCall: withSubject(pending, sealedSubject.text) }),
    ...(outcome === undefined
      ? {}
      : {
          nativeOutcome: {
            ...outcome,
            ...(outcome.error !== undefined
              ? { error: maskWithin(outcome.error, MAX_OUTCOME_ERROR_CHARS).text }
              : {}),
          },
        }),
  });
  return {
    packet: sealed,
    subjectChanged: sealedSubject.changed,
    localTarget: pending !== undefined && 'url' in pending && isLocalTarget(pending.url),
    currentChanged: sealedCurrent.changed,
    localUrl: packet.literalUrls.some(isLocalTarget),
  };
}

/**
 * MASKED, THEN BOUNDED, over a window: the mask scans what can be sent plus a
 * margin longer than any secret shape, so its cost is bounded however large
 * the input, and a secret crossing `max` is seen whole before the cut. A PEM
 * block that opens inside the window is masked to the window's end. When the
 * window itself cut the text, the last `MASK_MARGIN` characters of its masked
 * form are never sent either: a secret cut at the window's edge can sit there
 * after earlier masks shortened the text, and must not leave in part.
 */
function maskWithin(text: string, max: number): { text: string; changed: boolean } {
  const window = text.slice(0, max + MASK_MARGIN);
  const masked = mask(window);
  const limit = window.length < text.length ? Math.min(max, masked.length - MASK_MARGIN) : max;
  return { text: masked.slice(0, Math.max(0, limit)), changed: masked !== window };
}

/** A URL's host as `URL` names it, lowercase; empty for one that does not parse. */
function hostnameOf(raw: string): string {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return '';
  }
}

const LOCAL_NAME = /(?:^|\.)(?:localhost|local)$/i;

/**
 * A URL no public service can fetch: another scheme, a `localhost` or `.local`
 * name, or a literal address that is not public (loopback, private,
 * link-local, IPv6 ULA and the other reserved ranges `isPublicAddress` knows).
 * A string that does not parse as a URL is not a public target either.
 */
function isLocalTarget(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return true;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return true;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (LOCAL_NAME.test(host)) return true;
  return isIP(host) !== 0 && !isPublicAddress(host);
}

/**
 * A packet for a caller that has no conversation to send: the query itself is
 * the current message, because the server's message text is `min(1)` and an
 * empty one is a 400 after the routing fee has already settled.
 */
export function packetForText(text: string): Packet {
  const bounded = text.trim().slice(0, MAX_MESSAGE_CHARS);
  return fit({
    current: { role: 'user', text: bounded.length > 0 ? bounded : '(no task text)' },
    history: [],
    literalUrls: literalUrlsIn(bounded),
    historyStatus: 'unavailable',
  });
}

/**
 * Build the packet for one user prompt. `transcriptPath` is the harness's own
 * path for this session; an absent or unusable one yields `unavailable`. The
 * result is neither masked nor bounded: {@link seal} does both.
 */
export async function buildPromptPacket(
  transcriptPath: string | undefined,
  sessionId: string,
  prompt: string,
  harness: Harness = 'claude',
  opts: { delegated?: boolean } = {},
): Promise<Packet> {
  const trimmed = prompt.trim();
  const text = trimmed.length > 0 ? trimmed : '(empty prompt)';
  const read = await readHistory(transcriptPath, { sessionId, harness });
  // A delegated task is the agent's words, so no harness mark is read in it.
  const current: PacketMessage = { role: 'user', text };
  return {
    current: opts.delegated === true ? current : withPasted(current, harness),
    history: read ?? [],
    literalUrls: literalUrlsIn(text),
    historyStatus: read === null ? 'unavailable' : 'ok',
  };
}

/**
 * WHAT THE USER PASTED IS NOT WHAT THEY ASKED. A block the harness itself
 * marks as pasted goes to `quoted`, apart from the user's own words. Only a
 * harness's own mark counts: nothing is guessed from what the text looks
 * like, and a message the move would leave empty, or that carries a mark this
 * reader cannot account for, stays as it was.
 *
 * WHICH HARNESS MARKS A PASTE (read 2026-11-01). Claude Code, in the terminal
 * and the desktop app's Code tab, wraps each paste in the prompt in
 * `<pasted_content id="<4 hex>">` and `</pasted_content id="<the same id>">`,
 * each tag on its own line, with any tag text inside the paste escaped
 * (`<\pasted_content`): {@link splitClaudePastes}. Not every paste is wrapped
 * (Claude Code decides), and an unwrapped one stays in the text. Codex's
 * terminal expands its `[Pasted Content N chars]` placeholder inline with no
 * mark. The Codex desktop app (0.162 to 0.164) saves a long paste as a file
 * and writes the message as its own sections: `# Files pasted by the user:`,
 * one `## "<the paste's opening…>": <file>` line per paste, and the user's
 * words after `## My request:`. Those opening lines are the blocks moved here,
 * without the local path.
 */
export function splitPasted(
  text: string,
  harness: Harness,
): { text: string; quoted: string[] } | null {
  if (harness === 'claude') return splitClaudePastes(text);
  const lines = text.split('\n');
  const start = lines.indexOf(PASTED_HEADER);
  const request = lines.indexOf(REQUEST_HEADER, start + 1);
  if (start === -1 || request === -1) return null;
  // The section runs to the next of the app's top-level headers, or the request.
  const after = lines.slice(start + 1, request).findIndex((line) => line.startsWith('# '));
  const end = after === -1 ? request : start + 1 + after;
  const quoted: string[] = [];
  for (const line of lines.slice(start + 1, end)) {
    if (line.trim().length === 0) continue;
    const entry = PASTED_ENTRY.exec(line);
    // A line the app's own shape does not explain: nothing is moved.
    if (entry === null) return null;
    quoted.push(entry[1]!);
  }
  const words = lines
    .slice(request + 1)
    .join('\n')
    .trim();
  if (quoted.length === 0 || words.length === 0) return null;
  // With no other section of the app's beside it, the text is the words alone.
  const others = [...lines.slice(0, start), ...lines.slice(end, request)].join('\n').trim();
  const rest = [lines.slice(0, start).join('\n').trim(), lines.slice(end).join('\n').trim()]
    .filter((part) => part.length > 0)
    .join('\n\n');
  return { text: others.length === 0 ? words : rest, quoted };
}

/** Claude Code's paste tags, as its own reader takes them: the id is 4 hex. */
const CLAUDE_OPEN = /<pasted_content id="([0-9a-f]{4})">\n/g;
const CLAUDE_TAG = /<\/?pasted_content\b/g;

/**
 * Claude Code's wrapped pastes, read the way Claude Code reads them back: each
 * block runs from its opening line to the closing tag with the same id, and
 * up to two newlines on either side belong to the block. Any tag the pairs do
 * not account for (an unclosed block, a closing tag alone, an id that is not
 * one, the tag text typed in the user's own words) leaves the message as it is.
 */
function splitClaudePastes(text: string): { text: string; quoted: string[] } | null {
  const words: string[] = [];
  const quoted: string[] = [];
  const tags: number[] = [];
  let from = 0;
  for (const open of text.matchAll(CLAUDE_OPEN)) {
    if (open.index < from) return null;
    const close = `\n</pasted_content id="${open[1]!}">`;
    const bodyAt = open.index + open[0].length;
    const closeAt = text.indexOf(close, bodyAt - 1);
    if (closeAt === -1) return null;
    let start = open.index;
    for (let n = 0; n < 2 && start > from && text[start - 1] === '\n'; n++) start--;
    let end = closeAt + close.length;
    tags.push(open.index, closeAt + 1);
    for (let n = 0; n < 2 && text[end] === '\n'; n++) end++;
    words.push(text.slice(from, start));
    quoted.push(text.slice(bodyAt, Math.max(bodyAt, closeAt)));
    from = end;
  }
  words.push(text.slice(from));
  // Every tag in the text is one of the pairs just read, or nothing is moved.
  const every = [...text.matchAll(CLAUDE_TAG)].map((tag) => tag.index);
  if (quoted.length === 0 || every.length !== tags.length) return null;
  if (!every.every((at, i) => at === tags[i])) return null;
  const rest = words
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join('\n');
  if (rest.length === 0 || quoted.every((block) => block.trim().length === 0)) return null;
  return { text: rest, quoted };
}

const PASTED_HEADER = '# Files pasted by the user:';
const REQUEST_HEADER = '## My request:';
/** `## "<the paste's opening>": <the file it was saved to>`. */
const PASTED_ENTRY = /^## "(.+)": \S.*$/;

/**
 * The message, with any harness-marked paste moved to `quoted`; unchanged
 * when it holds more blocks than the server takes, so none is dropped. Only
 * `current` has a `quoted`: a history message keeps its paste in its text.
 */
function withPasted(message: PacketMessage, harness: Harness): PacketMessage {
  const pasted = splitPasted(message.text, harness);
  if (pasted === null || pasted.quoted.length > MAX_QUOTED) return message;
  return { role: message.role, ...pasted };
}

/**
 * Build the packet for a native call, before it runs or after it came back
 * short. The same reader as a prompt packet, with tool results excluded, and
 * the same {@link seal} before it is sent.
 *
 * THE USER'S WORDS ARE WHAT CARRY THEIR AUTHORITY. Building this packet from
 * the tool argument alone made the search string the entire conversation, so a
 * turn that said "native tools only, no paid services" reached the prompt gate
 * and never reached this one: the same session could then be redirected to a
 * paid provider on a bare URL. Reading the transcript at the hook event is not
 * session guessing; the harness hands this hook the path to its own session.
 *
 * The call rides INSIDE the packet as `pendingCall`, with how it fared beside
 * it as `nativeOutcome`: the shape the route takes, pinned by
 * `wire-hook-request-native-shortfall.json`.
 */
export async function buildNativePacket(
  transcriptPath: string | undefined,
  sessionId: string,
  pending: PendingCall,
  opts: { agentId?: string; nativeOutcome?: NativeOutcome; harness?: Harness } = {},
): Promise<Packet> {
  const { agentId, nativeOutcome, harness = 'claude' } = opts;
  const subject = subjectOf(pending);
  const read = await readHistory(transcriptPath, { sessionId, harness });
  // A SUBAGENT'S CALL BELONGS TO ITS OWN TASK. The harness hands every
  // subagent hook the PARENT's transcript, whose latest user message is not
  // what this subagent was asked to do, so two subagents with different
  // assignments sent the same packet (tenjin-agent#377). Its own transcript
  // opens with the delegated task; the parent's messages stay in front of it
  // as history, which is how a restriction the user gave the parent still
  // reaches this call. A subagent file that cannot be read is today's
  // behaviour, not a refusal.
  const own =
    agentId === undefined || harness === 'codex'
      ? null
      : await readHistory(subagentTranscriptPath(transcriptPath, sessionId, agentId), {
          sessionId,
          agentId,
        });
  const messages = own === null ? (read ?? []) : [...(read ?? []), ...own];
  // The most recent user message is the turn this call belongs to; everything
  // before it is context. With no transcript the call speaks for itself, which
  // is what this hook did before it could read one.
  const lastUser = messages
    .map((message, index) => ({ message, index }))
    .filter((entry) => entry.message.role === 'user');
  const current = lastUser.at(-1);
  return {
    current:
      current === undefined
        ? { role: 'user', text: subject }
        : withPasted(current.message, harness),
    history: current === undefined ? messages : messages.slice(0, current.index),
    literalUrls: literalUrlsIn(`${current?.message.text ?? ''}\n${subject}`),
    historyStatus: read === null && own === null ? 'unavailable' : 'ok',
    pendingCall: pending,
    ...(nativeOutcome !== undefined ? { nativeOutcome } : {}),
  };
}

/** Both ids become path segments, so anything but an opaque token is refused. */
const PATH_SEGMENT_RE = /^[A-Za-z0-9_-]{1,200}$/;

/**
 * Where the harness keeps one subagent's transcript: beside the parent's
 * `<session>.jsonl`, under `<session>/subagents/agent-<agent_id>.jsonl`
 * (Claude Code 2.1.x). `undefined` when either id could not be a path segment.
 */
export function subagentTranscriptPath(
  transcriptPath: string | undefined,
  sessionId: string,
  agentId: string,
): string | undefined {
  if (transcriptPath === undefined || transcriptPath.length === 0) return undefined;
  if (!PATH_SEGMENT_RE.test(sessionId) || !PATH_SEGMENT_RE.test(agentId)) return undefined;
  return join(dirname(transcriptPath), sessionId, 'subagents', `agent-${agentId}.jsonl`);
}

/**
 * Whose rows a transcript read admits: the session's own, or with `agentId`,
 * exactly one subagent's sidechain and no other.
 */
interface RowScope {
  sessionId: string;
  agentId?: string;
  /** Codex's rollout file has its own rows and its own ownership check. */
  harness?: Harness;
}

/** `null` means "cannot be vouched for"; an empty array is a genuinely fresh session. */
async function readHistory(
  path: string | undefined,
  scope: RowScope,
): Promise<PacketMessage[] | null> {
  if (path === undefined || path.length === 0) return null;
  let raw: string;
  let tail: boolean;
  let file;
  try {
    file = await open(path, 'r');
  } catch {
    return null;
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile()) return null;
    tail = stat.size > MAX_TRANSCRIPT_BYTES;
    const read = tail ? await readTail(file, stat.size) : await readHead(file);
    if (read === null) return null;
    raw = read;
  } catch {
    return null;
  } finally {
    await file.close();
  }
  try {
    // A Codex tail has lost the rollout's ownership header, so it is unavailable.
    if (scope.harness === 'codex') return tail ? null : parseCodexHistory(raw, scope.sessionId);
    const messages = parseRows(raw, scope);
    // A TAIL MUST HOLD THE TURN. The latest user message is the newest of
    // them, so a tail with any user message holds this turn's; one with none
    // is a single turn longer than the window, whose instruction was cut off.
    if (tail && !messages.some((message) => message.role === 'user')) {
      // Except a subagent's: its one turn is the delegated task, the first
      // user row at the head of its file. Dropping the file instead put the
      // parent's latest message in that task's place.
      if (scope.agentId === undefined) return null;
      const task = await firstUserRow(path, scope);
      return task === null ? null : [task, ...messages];
    }
    return messages;
  } catch {
    return null;
  }
}

/** The first user message in a transcript's leading {@link MAX_TRANSCRIPT_BYTES}. */
async function firstUserRow(path: string, scope: RowScope): Promise<PacketMessage | null> {
  const file = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(MAX_TRANSCRIPT_BYTES);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const window = buffer.subarray(0, bytesRead);
    // Whole lines only: a row cut at the window's end is not read.
    const end = window.lastIndexOf(0x0a);
    if (end === -1) return null;
    const rows = parseRows(window.subarray(0, end).toString('utf8'), scope);
    return rows.find((message) => message.role === 'user') ?? null;
  } finally {
    await file.close();
  }
}

type TranscriptFile = Awaited<ReturnType<typeof open>>;

/** All of a transcript within the bound; null if it grew past it meanwhile. */
async function readHead(file: TranscriptFile): Promise<string | null> {
  const buffer = Buffer.alloc(MAX_TRANSCRIPT_BYTES + 1);
  const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
  if (bytesRead > MAX_TRANSCRIPT_BYTES) return null;
  return buffer.subarray(0, bytesRead).toString('utf8');
}

/**
 * THE LAST {@link MAX_TRANSCRIPT_BYTES} OF A LONGER TRANSCRIPT, from the first
 * line that starts inside them: the one byte before the window is read too,
 * so a window that opens on a line boundary keeps its first line, and one
 * that opens mid-line drops the fragment. Cutting after a newline never
 * splits a UTF-8 character. Null when the window holds no line start at all.
 */
async function readTail(file: TranscriptFile, size: number): Promise<string | null> {
  const buffer = Buffer.alloc(MAX_TRANSCRIPT_BYTES + 1);
  const { bytesRead } = await file.read(buffer, 0, buffer.length, size - buffer.length);
  const window = buffer.subarray(0, bytesRead);
  const newline = window.indexOf(0x0a);
  return newline === -1 ? null : window.subarray(newline + 1).toString('utf8');
}

/**
 * TOLERANT BY ROW, STRICT BY CONTENT. Every rule below still holds about what
 * may enter a packet: no other session's text, no subagent's, no tool results.
 * What changed is the blast radius of one bad row. Rejecting the whole
 * transcript over a compaction boundary or a sidechain line meant the native
 * hook routed on the tool argument alone, which is exactly how a current-turn
 * "native tools only" instruction went missing from the decision it was about.
 *
 * A compaction boundary is not a reason to read nothing: the rows after it are
 * the live context, so the collected messages start again there.
 */
function parseRows(raw: string, scope: RowScope): PacketMessage[] {
  const { sessionId, agentId } = scope;
  let messages: PacketMessage[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // One unreadable line is one line, not the conversation.
    }
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue;
    // Everything before the boundary belongs to a context that was summarized
    // away; what follows is the turn in play.
    if (row.type === 'system' && row.subtype === 'compact_boundary') {
      messages = [];
      continue;
    }
    // Never ours to read: another window's rows and a subagent's are skipped
    // rather than allowed to void the file.
    if (typeof row.sessionId === 'string' && row.sessionId !== sessionId) continue;
    // Harness meta rows (a skill body, a command caveat) are not the user's words.
    if (row.isMeta === true) continue;
    // A subagent read admits that one sidechain and nothing else; the harness's
    // own reminders in it are not the task. Every other read admits none.
    if (agentId === undefined ? row.isSidechain === true : !ownSidechainRow(row, agentId)) {
      continue;
    }
    if (row.type !== 'user' && row.type !== 'assistant') continue;
    if (row.sessionId !== sessionId) continue;
    let text: string;
    try {
      text = textOf(row.message);
    } catch {
      continue; // A row this build cannot read contributes nothing, and no more.
    }
    // Nor is what the harness writes back into the user's turn (tenjin-agent#401).
    if (row.type === 'user' && harnessUserRow(row, text)) continue;
    if (text.length > 0) messages.push({ role: row.type, text });
  }
  return messages;
}

/** Output of a local command, as the harness wraps it into a user row. */
const LOCAL_COMMAND_OUTPUT = /^\s*<local-command-(?:stdout|stderr)>/;

/**
 * A turn the harness or another agent wrote, not the user: a background task
 * finishing, a subagent's hand-back or a teammate's message, a message from
 * another session. It hands work back; it asks for none, and routing it offers
 * a lookup nobody requested. The prompt hook skips these and the transcript
 * reader drops them, from this one list.
 */
const HANDBACK_PREFIXES = [
  '<task-notification>',
  '<agent-message',
  '<teammate-message',
  '<cross-session-message',
  'Another Claude session sent a message',
];

export function isHandback(text: string): boolean {
  const trimmed = text.trimStart();
  return HANDBACK_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

/** The `origin.kind` of a user row another agent or the harness wrote. */
const HARNESS_ORIGINS = new Set(['task-notification', 'peer']);

/**
 * A `type: "user"` row the user never typed. The harness writes these without
 * `isMeta`: a background task finishing (`origin.kind: "task-notification"`),
 * a subagent's hand-back or another session's message (`origin.kind: "peer"`,
 * text `Another Claude session sent a message:` then `<agent-message …>`), and
 * a local command's output (`<local-command-stdout>`). None is the user's
 * words, and none can become `current`: a hand-back read as this turn put a
 * subagent's report in place of the user's own instruction. A
 * `<command-name>` row stays: that is the command the user did type.
 */
function harnessUserRow(row: Record<string, unknown>, text: string): boolean {
  const origin = row.origin;
  if (
    origin !== null &&
    typeof origin === 'object' &&
    HARNESS_ORIGINS.has((origin as { kind?: unknown }).kind as string)
  ) {
    return true;
  }
  return isHandback(text) || LOCAL_COMMAND_OUTPUT.test(text);
}

function ownSidechainRow(row: Record<string, unknown>, agentId: string): boolean {
  return row.isSidechain === true && row.agentId === agentId && row.isMeta !== true;
}

/** Ordinary text blocks only; a tool result contributes nothing. */
function textOf(message: unknown): string {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    throw new Error('malformed message');
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) throw new Error('malformed content');
  const parts: string[] = [];
  for (const part of content) {
    if (
      part === null ||
      typeof part !== 'object' ||
      typeof (part as { type?: unknown }).type !== 'string'
    ) {
      throw new Error('malformed block');
    }
    const block = part as { type: string; text?: unknown };
    if (block.type !== 'text') continue;
    if (typeof block.text !== 'string') throw new Error('malformed text block');
    parts.push(block.text);
  }
  return parts.join('\n');
}
