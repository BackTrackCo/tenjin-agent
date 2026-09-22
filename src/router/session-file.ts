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

function packetPath(dataDir: string, sessionId: string): string {
  const key = createHash('sha256').update(sessionId).digest('hex').slice(0, 32);
  return join(routerStateDir(dataDir), `${key}.json`);
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
  const path = packetPath(dataDir, sessionId);
  try {
    const raw = await readFile(path, 'utf8');
    if (Buffer.byteLength(raw) > MAX_PACKET_BYTES * 4) return null;
    const parsed = FileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    if (now() - parsed.data.writtenAtMs > MAX_AGE_MS) return null;
    return parsed.data.packet;
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
    entries
      .filter((name) => name.endsWith('.json'))
      .map(async (name) => {
        const path = join(dir, name);
        try {
          const parsed = FileSchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
          if (parsed.success && now() - parsed.data.writtenAtMs <= MAX_AGE_MS) return;
        } catch {
          // Unreadable or malformed: nothing will ever route on it.
        }
        await rm(path, { force: true }).catch(() => undefined);
      }),
  );
}

export interface LatestPacket {
  /** The opaque per-session key this packet was filed under. */
  key: string;
  packet: Packet;
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
      live.push({ key, packet: parsed.data.packet });
    } catch {
      continue;
    }
  }
  return live.length === 1 ? live[0]! : null;
}
