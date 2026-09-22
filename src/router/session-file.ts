import { readFile, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { writeFileAtomic } from '../lib/atomic-json';
import { MAX_PACKET_BYTES, type Packet } from './context';

/**
 * Where the prompt hook leaves the session's packet for the native hook and the
 * MCP tool to read. A private local file (0600, under the data dir), keyed by a
 * hash of the harness's session id so a session id never becomes a path, and
 * expired on age so a machine does not accumulate conversation text. It is not
 * an isolation boundary against code running as the same OS user.
 */

const MAX_AGE_MS = 12 * 60 * 60 * 1000;

const PacketSchema = z.object({
  current: z.object({ role: z.enum(['user', 'assistant']), text: z.string() }),
  history: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string() })),
  literalUrls: z.array(z.string()),
  historyStatus: z.enum(['ok', 'unavailable']),
});

const FileSchema = z.object({
  schemaVersion: z.literal(1),
  writtenAtMs: z.number(),
  packet: PacketSchema,
});

export function routerStateDir(dataDir: string): string {
  return join(dataDir, 'router');
}

/** The opaque per-session name everything here is filed under. A session id
 *  never becomes a path, and the hooks and the MCP tool derive the same key. */
export function sessionKeyOf(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 32);
}

function packetPath(dataDir: string, sessionId: string): string {
  return join(routerStateDir(dataDir), `${sessionKeyOf(sessionId)}.json`);
}

export async function writeSessionPacket(
  dataDir: string,
  sessionId: string,
  packet: Packet,
  now: () => number = Date.now,
): Promise<void> {
  const body = JSON.stringify({ schemaVersion: 1, writtenAtMs: now(), packet });
  await writeFileAtomic(packetPath(dataDir, sessionId), `${body}\n`, {
    mode: 0o600,
    dirMode: 0o700,
  });
  await pruneExpired(dataDir, now);
}

/** `null` for absent, unreadable, malformed or expired; the caller then routes
 *  on the query alone with `historyStatus: 'unavailable'`. */
export async function readSessionPacket(
  dataDir: string,
  sessionId: string,
  now: () => number = Date.now,
): Promise<Packet | null> {
  return (await readSessionPacketFile(dataDir, sessionId, now))?.packet ?? null;
}

/**
 * The packet AND the instant the prompt hook stamped it. That stamp is this
 * module's identity for one user turn: the prompt hook rewrites the file on
 * every prompt, so a continuation recorded against one stamp is void the moment
 * the user says anything else.
 */
export async function readSessionPacketFile(
  dataDir: string,
  sessionId: string,
  now: () => number = Date.now,
): Promise<{ packet: Packet; writtenAtMs: number } | null> {
  const path = packetPath(dataDir, sessionId);
  try {
    const raw = await readFile(path, 'utf8');
    if (Buffer.byteLength(raw) > MAX_PACKET_BYTES * 4) return null;
    const parsed = FileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    if (now() - parsed.data.writtenAtMs > MAX_AGE_MS) return null;
    return { packet: parsed.data.packet, writtenAtMs: parsed.data.writtenAtMs };
  } catch {
    return null;
  }
}

/** Age by the STAMP the writer put in the file, the same value the reader
 *  judges by: an mtime moves when a file is copied or touched, and pruning on
 *  one clock while reading on another can delete a packet just written. */
async function pruneExpired(dataDir: string, now: () => number): Promise<void> {
  const dir = routerStateDir(dataDir);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  await Promise.all(
    entries.map(async (name) => {
      const continuation = name.endsWith(CONTINUATION_SUFFIX);
      if (!continuation && !name.endsWith('.json')) return;
      const path = join(dir, name);
      const maxAge = continuation ? CONTINUATION_MAX_AGE_MS : MAX_AGE_MS;
      const schema = continuation ? ContinuationSchema : FileSchema;
      try {
        const parsed = schema.safeParse(JSON.parse(await readFile(path, 'utf8')));
        if (parsed.success && now() - parsed.data.writtenAtMs <= maxAge) return;
      } catch {
        // Unreadable or malformed: nothing will ever route on it.
      }
      await rm(path, { force: true }).catch(() => undefined);
    }),
  );
}

/**
 * THE NATIVE CONTINUATION. A paid decision that answered `native` said, for
 * money, that the host's own tools cover this exact lookup. Without a record of
 * it the PreToolUse hook asked the gate again for the very same search and
 * could be told `execute`, which denied the call the paid decision had just
 * permitted: a contradiction the user sees as a blocked tool and the session
 * pays for twice.
 *
 * THE SCOPE IS DELIBERATELY NARROW, because this is a bypass of the redirect.
 * It holds only for the same session, the same user turn (the packet stamp the
 * prompt hook wrote, so any new prompt or correction voids it) and the exact
 * same lookup text. A different query, a later turn or an expired record all
 * fall back to asking the gate. It is never written for `needs_input`,
 * `needs_approval` or a failure: only an explicit `native` decision grants one,
 * and it is never session-wide.
 */
const CONTINUATION_SUFFIX = '.continuation';
/** Short by design: a continuation is for the call the model makes next. */
const CONTINUATION_MAX_AGE_MS = 15 * 60 * 1000;
const MAX_CONTINUATION_LOOKUPS = 8;

const ContinuationSchema = z.object({
  schemaVersion: z.literal(1),
  writtenAtMs: z.number(),
  /** The packet stamp identifying the user turn this was granted in. */
  turnStamp: z.number(),
  /** Only ever `native`; spelled so a future action cannot be read as one. */
  action: z.literal('native'),
  lookups: z.array(z.string().max(64)).max(MAX_CONTINUATION_LOOKUPS),
});

function continuationPath(dataDir: string, sessionKey: string): string {
  return join(routerStateDir(dataDir), `${sessionKey}${CONTINUATION_SUFFIX}`);
}

/**
 * The identity of one lookup, for matching a tool query against a later native
 * call. Whitespace and case are normalized because a harness may re-wrap the
 * same search; nothing else is, so two different questions never collide.
 */
export function lookupKeyOf(text: string): string {
  const normalized = text.trim().replace(/\s+/g, ' ').toLowerCase();
  return createHash('sha256').update(normalized).digest('hex').slice(0, 32);
}

/** Record that THIS lookup was explicitly answered `native` in THIS turn. */
export async function recordNativeContinuation(
  dataDir: string,
  sessionKey: string,
  turnStamp: number,
  lookup: string,
  now: () => number = Date.now,
): Promise<void> {
  const path = continuationPath(dataDir, sessionKey);
  const key = lookupKeyOf(lookup);
  let lookups: string[] = [key];
  try {
    const parsed = ContinuationSchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
    // Same turn: add to what this turn already permitted. A different turn
    // starts over, so nothing from the previous one can be honoured.
    if (parsed.success && parsed.data.turnStamp === turnStamp) {
      lookups = [...new Set([...parsed.data.lookups, key])].slice(-MAX_CONTINUATION_LOOKUPS);
    }
  } catch {
    // No record, or one this build cannot read: write a fresh one.
  }
  const body = JSON.stringify({
    schemaVersion: 1,
    writtenAtMs: now(),
    turnStamp,
    action: 'native',
    lookups,
  });
  await writeFileAtomic(path, `${body}\n`, { mode: 0o600, dirMode: 0o700 });
}

/**
 * Whether the paid decision for this exact lookup, in this turn, already said
 * `native`. False for anything unreadable, expired, from another turn or about
 * another query, so the gate is asked whenever this is not certain.
 */
export async function nativeContinuationHolds(
  dataDir: string,
  sessionKey: string,
  turnStamp: number,
  lookup: string,
  now: () => number = Date.now,
): Promise<boolean> {
  try {
    const raw = await readFile(continuationPath(dataDir, sessionKey), 'utf8');
    const parsed = ContinuationSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return false;
    if (parsed.data.turnStamp !== turnStamp) return false;
    if (now() - parsed.data.writtenAtMs > CONTINUATION_MAX_AGE_MS) return false;
    return parsed.data.lookups.includes(lookupKeyOf(lookup));
  } catch {
    return false;
  }
}

export interface LatestPacket {
  /** The opaque per-session key this packet was filed under. */
  key: string;
  packet: Packet;
  /** When the prompt hook stamped it: this module's identity for one turn. */
  writtenAtMs: number;
}

/**
 * The packet for a reader that has no session id of its own: the MCP server is
 * started per session by the harness and never told which one it serves.
 *
 * OWNERSHIP IS PROVED, NEVER INFERRED. A caller with no latch must supply
 * `sinceMs`, the instant its own process began, and only a packet written after
 * that can be its session's: one file being the only file proves nothing, since
 * the sole packet on the machine may be another window's and a subagent has no
 * packet at all. With no `sinceMs` and no latch the answer is `null`, and the
 * caller routes on its query alone. `onlyKey` is the latch: once a call has
 * bound to a session, later calls read that one and a second window starting
 * changes nothing.
 */
export async function readLatestPacket(
  dataDir: string,
  opts: { now?: () => number; onlyKey?: string; sinceMs?: number } = {},
): Promise<LatestPacket | null> {
  const now = opts.now ?? Date.now;
  // No latch and no process boundary: nothing here could prove a packet is the
  // caller's, so it gets none rather than somebody else's conversation.
  if (opts.onlyKey === undefined && opts.sinceMs === undefined) return null;
  const dir = routerStateDir(dataDir);
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith('.json'));
  } catch {
    return null;
  }
  // Age is read from the packet the writer stamped, not from the file's mtime:
  // a copy or a `touch` moves the one and not the other, and this decides
  // whether a conversation is current enough to pay a decision over.
  const live: LatestPacket[] = [];
  for (const name of names) {
    const key = name.slice(0, -'.json'.length);
    if (opts.onlyKey !== undefined && key !== opts.onlyKey) continue;
    try {
      const raw = await readFile(join(dir, name), 'utf8');
      if (Buffer.byteLength(raw) > MAX_PACKET_BYTES * 4) continue;
      const parsed = FileSchema.safeParse(JSON.parse(raw));
      if (!parsed.success || now() - parsed.data.writtenAtMs > MAX_AGE_MS) continue;
      // `sinceMs` is how an unlatched process proves a packet is ITS OWN: a
      // session it serves wrote a prompt after it started, and one that was
      // already there when it started belongs to somebody else's window.
      if (opts.sinceMs !== undefined && parsed.data.writtenAtMs < opts.sinceMs) continue;
      live.push({ key, packet: parsed.data.packet, writtenAtMs: parsed.data.writtenAtMs });
    } catch {
      continue;
    }
  }
  return live.length === 1 ? live[0]! : null;
}
