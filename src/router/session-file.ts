import { readFile, readdir, rm, stat } from 'node:fs/promises';
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
        const found = await stat(path).catch(() => null);
        if (found === null || now() - found.mtimeMs <= MAX_AGE_MS) return;
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
 * IT NEVER GUESSES BETWEEN SESSIONS. Exactly one unexpired packet is this
 * session's; two or more mean two Claude sessions share this data directory and
 * nothing here can tell them apart, so the reader gets `null` and routes on the
 * query alone rather than sending one session's conversation to a paid decision
 * made for another. `onlyKey` is the latch: once a call has bound to a session,
 * later calls read that one and are unaffected by a second session starting.
 */
export async function readLatestPacket(
  dataDir: string,
  opts: { now?: () => number; onlyKey?: string } = {},
): Promise<LatestPacket | null> {
  const now = opts.now ?? Date.now;
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
      live.push({ key, packet: parsed.data.packet });
    } catch {
      continue;
    }
  }
  return live.length === 1 ? live[0]! : null;
}
