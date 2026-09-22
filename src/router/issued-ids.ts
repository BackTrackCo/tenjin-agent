import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { writeFileAtomic } from '../lib/atomic-json';

/**
 * THE IDS THIS MACHINE'S HOOKS HANDED OUT, and nothing else.
 *
 * An id is a shortcut to a prepared contract, so accepting one from anywhere
 * means a page this session fetched, or a message somebody else wrote, can name
 * an id and have this wallet pay for a lookup nobody here asked for. The
 * defence is the smallest one that works: the hook writes down what it offered,
 * and the tool runs a prepared decision ONLY for an id on that list. An id that
 * is not there is not an error, it is just not a shortcut: the query path runs
 * and the lookup still happens.
 *
 * SCOPE, STATED PLAINLY. This is per machine and per data dir, not per session:
 * the MCP server is started by the harness and never told which session it
 * serves, so a per-session check would need the timestamp latch the re-cut
 * deleted. Two windows of the same user could therefore trade ids. That costs
 * one wrong lookup, bounded by `maxAutoSpend`, where the thing being closed is
 * an id arriving from outside the machine entirely.
 *
 * It holds ids and one target each, never conversation text, and everything
 * ages out with the backend row it points at.
 */

/** As long as the backend keeps a prepared row: after that the id is refused
 *  there anyway, so remembering it here would only grow the file. */
const MAX_AGE_MS = 15 * 60 * 1000;
/** A turn can offer one; a busy session, a handful. Oldest out first. */
const MAX_IDS = 32;

const FileSchema = z.object({
  schemaVersion: z.literal(1),
  ids: z
    .array(
      z.object({
        id: z.string().min(1).max(200),
        atMs: z.number(),
        /** The page the prepared line named, when it named one. */
        target: z.string().max(2_048).optional(),
      }),
    )
    .max(MAX_IDS),
});

export interface IssuedId {
  id: string;
  atMs: number;
  target?: string;
}

function issuedPath(dataDir: string): string {
  return join(dataDir, 'router', 'issued.json');
}

async function readIssued(dataDir: string, now: () => number): Promise<IssuedId[]> {
  try {
    const parsed = FileSchema.safeParse(JSON.parse(await readFile(issuedPath(dataDir), 'utf8')));
    if (!parsed.success) return [];
    return parsed.data.ids.filter((entry) => now() - entry.atMs <= MAX_AGE_MS);
  } catch {
    return [];
  }
}

/** Remember an id this machine's hook just offered. Best effort: a write that
 *  fails costs the next call its shortcut, never the lookup. */
export async function recordIssuedId(
  dataDir: string,
  entry: { id: string; target?: string },
  now: () => number = Date.now,
): Promise<void> {
  const live = (await readIssued(dataDir, now)).filter((held) => held.id !== entry.id);
  const ids = [
    ...live,
    { id: entry.id, atMs: now(), ...(entry.target !== undefined ? { target: entry.target } : {}) },
  ].slice(-MAX_IDS);
  await writeFileAtomic(issuedPath(dataDir), `${JSON.stringify({ schemaVersion: 1, ids })}\n`, {
    mode: 0o600,
    dirMode: 0o700,
  });
}

/**
 * The entry for an id this machine offered, or null for one it did not, one
 * that aged out, and one from a file this build cannot read. Null always means
 * the same thing to the caller: take the query path.
 */
export async function issuedHere(
  dataDir: string,
  id: string,
  now: () => number = Date.now,
): Promise<IssuedId | null> {
  return (await readIssued(dataDir, now)).find((entry) => entry.id === id) ?? null;
}
