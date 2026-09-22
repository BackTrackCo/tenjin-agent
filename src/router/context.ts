import { open } from 'node:fs/promises';
import { mask } from '../lib/redact';

/**
 * The bounded conversation packet the router's gate and paid decision read.
 *
 * WHAT GOES IN IT: ordinary user and assistant text from the CURRENT session
 * only, redacted, at most {@link MAX_HISTORY} prior messages and at most
 * {@link MAX_PACKET_BYTES} in total, oldest dropped first. Tool results are
 * excluded: a tool result is other people's content, and a packet that carried
 * it would be a channel from a fetched page into a routing decision.
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
const MAX_TRANSCRIPT_BYTES = 4_000_000;
const MAX_PROMPT_CHARS = 48_000;
const MAX_LITERAL_URLS = 8;

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
}

/** The pending native call a `tenjin hook native` packet describes. */
export type PendingCall = { tool: string; query: string } | { tool: string; url: string };

const URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]]+/gi;

export function literalUrlsIn(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(URL_RE)) {
    const candidate = match[0].replace(/[.,;:!?]+$/, '');
    try {
      found.add(new URL(candidate).toString());
    } catch {
      continue;
    }
    if (found.size >= MAX_LITERAL_URLS) break;
  }
  return [...found];
}

/** Drop the oldest messages until the whole packet fits its byte cap. */
function fit(current: PacketMessage, history: PacketMessage[]): PacketMessage[] {
  const kept = history.slice(-MAX_HISTORY);
  while (
    kept.length > 0 &&
    Buffer.byteLength(JSON.stringify({ current, kept })) > MAX_PACKET_BYTES
  ) {
    kept.shift();
  }
  return kept;
}

/**
 * Build the packet for one user prompt. `transcriptPath` is the harness's own
 * path for this session; an absent or unusable one yields `unavailable`.
 */
export async function buildPromptPacket(
  transcriptPath: string | undefined,
  sessionId: string,
  prompt: string,
): Promise<Packet> {
  const text = mask(prompt.slice(0, MAX_PROMPT_CHARS));
  const current: PacketMessage = { role: 'user', text };
  const read = await readHistory(transcriptPath, sessionId);
  return {
    current,
    history: read === null ? [] : fit(current, read),
    literalUrls: literalUrlsIn(text),
    historyStatus: read === null ? 'unavailable' : 'ok',
  };
}

/**
 * Re-derive a packet for a native tool call from a packet the prompt hook
 * already wrote. The pending call is the caller's, not this module's: the hook
 * sends it beside the packet.
 */
export function packetForNativeCall(prior: Packet | null): Packet {
  if (prior === null) {
    return {
      current: { role: 'user', text: '' },
      history: [],
      literalUrls: [],
      historyStatus: 'unavailable',
    };
  }
  return prior;
}

/** `null` means "cannot be vouched for"; an empty array is a genuinely fresh session. */
async function readHistory(
  path: string | undefined,
  sessionId: string,
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
    return parseRows(raw, sessionId);
  } catch {
    return null;
  }
}

function parseRows(raw: string, sessionId: string): PacketMessage[] {
  const messages: PacketMessage[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    const row = JSON.parse(line) as Record<string, unknown>;
    if (row === null || typeof row !== 'object' || Array.isArray(row)) throw new Error('malformed');
    if (typeof row.sessionId === 'string' && row.sessionId !== sessionId) {
      throw new Error('another session');
    }
    if (row.isSidechain === true) throw new Error('sidechain');
    if (row.type === 'system' && row.subtype === 'compact_boundary') throw new Error('compacted');
    if (row.type !== 'user' && row.type !== 'assistant') continue;
    if (row.sessionId !== sessionId) throw new Error('unidentified conversation row');
    const text = textOf(row.message);
    if (text.length > 0) messages.push({ role: row.type, text: mask(text) });
  }
  return messages;
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
