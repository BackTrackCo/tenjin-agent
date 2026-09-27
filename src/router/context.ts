import { open } from 'node:fs/promises';
import { isIP } from 'node:net';
import { dirname, join } from 'node:path';
import { isPublicAddress } from '../lib/destination';
import { mask } from '../lib/redact';
import { parseCodexHistory } from './codex-history';

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
 * WHAT NEVER HAPPENS: a transcript this reader cannot vouch for (another
 * session, a subagent sidechain, a compaction boundary, malformed rows, an
 * oversized file) is reported as `unavailable` rather than partially believed,
 * and the user's turn is never blocked by any of that. Adapted from the draft
 * auto-mode experiment (PR #369 `context.ts`), whose 48,000-character reader
 * this tightens.
 */

export const MAX_HISTORY = 6;
export const MAX_PACKET_BYTES = 16 * 1024;
/** Every bound here is the server's own (tenjin `lib/x402-router/wire.ts`). A
 *  packet this side lets through and that side refuses is a paid 400. */
export const MAX_MESSAGE_CHARS = 16_000;
const MAX_TRANSCRIPT_BYTES = 4_000_000;
const MAX_LITERAL_URLS = 8;
const MAX_LITERAL_URL_CHARS = 2_000;
const MAX_PENDING_CHARS = 4_000;
/** The server's cap on a native outcome's error text. */
const MAX_OUTCOME_ERROR_CHARS = 1_000;
/** Scanned past each bound: longer than any secret shape the mask knows. */
const MASK_MARGIN = 4_096;

export type PacketRole = 'user' | 'assistant';
export interface PacketMessage {
  role: PacketRole;
  text: string;
}

export type HistoryStatus = 'ok' | 'unavailable';

export interface Packet {
  current: PacketMessage;
  history: PacketMessage[];
  /** Absolute http(s) URLs written literally in the current message. */
  literalUrls: string[];
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
}

/** The pending native call, INSIDE the packet: the gate request is a strict
 *  object with exactly `schemaVersion`, `source` and `packet`. */
export type PendingCall = { tool: 'WebSearch'; query: string } | { tool: 'WebFetch'; url: string };

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
  }
  while (size(next) > MAX_PACKET_BYTES && next.current.text.length > 1) {
    const over = size(next) - MAX_PACKET_BYTES;
    const keep = Math.max(1, next.current.text.length - Math.max(over, 1));
    next.current = { ...next.current, text: next.current.text.slice(0, keep) };
  }
  return next;
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
 * masked here, `current`, `history`, `literalUrls` and the pending call alike,
 * and only then bounded ({@link maskWithin}): a secret cut in half by a bound
 * before the mask no longer matches its row, and its first half would leave. The server stores
 * the packet against the id, so a secret here is a secret in its database.
 *
 * It also says what the caller must not send at all. A masked subject would
 * become the query the server writes into its hint, and a local or private
 * target can only ever be answered natively; both run unrouted.
 */
export function seal(packet: Packet): Sealed {
  const pending = packet.pendingCall;
  const subject = pending === undefined ? '' : 'query' in pending ? pending.query : pending.url;
  const sealedSubject = maskWithin(subject, MAX_PENDING_CHARS);
  const bound = (text: string): string => maskWithin(text, MAX_MESSAGE_CHARS).text;
  const sealedCurrent = maskWithin(packet.current.text, MAX_MESSAGE_CHARS);
  const current = sealedCurrent.text;
  const outcome = packet.nativeOutcome;
  const sealed = fit({
    current: { role: packet.current.role, text: current.length > 0 ? current : '(no task text)' },
    history: packet.history
      .slice(-MAX_HISTORY)
      .map((message) => ({ role: message.role, text: bound(message.text) }))
      .filter((message) => message.text.length > 0),
    literalUrls: packet.literalUrls
      .filter((url) => !isLocalTarget(url))
      .map(mask)
      .filter((url) => url.length <= MAX_LITERAL_URL_CHARS),
    historyStatus: packet.historyStatus,
    ...(pending === undefined
      ? {}
      : {
          pendingCall:
            'query' in pending
              ? { tool: pending.tool, query: sealedSubject.text }
              : { tool: pending.tool, url: sealedSubject.text },
        }),
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
  harness: 'claude' | 'codex' = 'claude',
): Promise<Packet> {
  const trimmed = prompt.trim();
  const text = trimmed.length > 0 ? trimmed : '(empty prompt)';
  const read = await readHistory(transcriptPath, { sessionId }, harness);
  return {
    current: { role: 'user', text },
    history: read ?? [],
    literalUrls: literalUrlsIn(text),
    historyStatus: read === null ? 'unavailable' : 'ok',
  };
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
  opts: { agentId?: string; nativeOutcome?: NativeOutcome; harness?: 'claude' | 'codex' } = {},
): Promise<Packet> {
  const { agentId, nativeOutcome } = opts;
  const subject = 'query' in pending ? pending.query : pending.url;
  const read = await readHistory(transcriptPath, { sessionId }, opts.harness);
  // A SUBAGENT'S CALL BELONGS TO ITS OWN TASK. The harness hands every
  // subagent hook the PARENT's transcript, whose latest user message is not
  // what this subagent was asked to do, so two subagents with different
  // assignments sent the same packet (tenjin-agent#377). Its own transcript
  // opens with the delegated task; the parent's messages stay in front of it
  // as history, which is how a restriction the user gave the parent still
  // reaches this call. A subagent file that cannot be read is today's
  // behaviour, not a refusal.
  const own =
    agentId === undefined || opts.harness === 'codex'
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
    current: current?.message ?? { role: 'user', text: subject },
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
}

/** `null` means "cannot be vouched for"; an empty array is a genuinely fresh session. */
async function readHistory(
  path: string | undefined,
  scope: RowScope,
  harness: 'claude' | 'codex' = 'claude',
): Promise<PacketMessage[] | null> {
  if (path === undefined || path.length === 0) return null;
  let raw: string;
  let file;
  try {
    file = await open(path, 'r');
  } catch {
    return null;
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_TRANSCRIPT_BYTES) return null;
    const buffer = Buffer.alloc(MAX_TRANSCRIPT_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_TRANSCRIPT_BYTES) return null;
    raw = buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    return null;
  } finally {
    await file.close();
  }
  try {
    return harness === 'codex' ? parseCodexHistory(raw, scope.sessionId) : parseRows(raw, scope);
  } catch {
    return null;
  }
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
 * A `type: "user"` row the user never typed. The harness writes two kinds
 * without `isMeta`: a background task or subagent finishing
 * (`origin.kind: "task-notification"`, text `<task-notification>…`) and a
 * local command's output (`<local-command-stdout>`). Both carry tool output,
 * so neither can be the user's words, and neither can become `current`. A
 * `<command-name>` row stays: that is the command the user did type.
 */
function harnessUserRow(row: Record<string, unknown>, text: string): boolean {
  const origin = row.origin;
  if (
    origin !== null &&
    typeof origin === 'object' &&
    (origin as { kind?: unknown }).kind === 'task-notification'
  ) {
    return true;
  }
  return text.trimStart().startsWith('<task-notification>') || LOCAL_COMMAND_OUTPUT.test(text);
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
