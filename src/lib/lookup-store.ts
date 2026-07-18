import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { writeFileAtomic } from './atomic-json';
import { withFileLock } from './lock';

/**
 * A small local ledger of recent lookups so `outcome --last` can target the most
 * recent one and `buy <resourceId>` can resolve the payable read URL a candidate
 * carried (the read route is keyed by handle/slug, not id, so an id alone can't
 * build the URL). Bounded and best-effort: a corrupt file reads as empty rather
 * than blocking a command. NOT an entitlement record, that is the library receipt.
 */

const MAX_ENTRIES = 50;

const StoredCandidateSchema = z.object({
  resourceId: z.string(),
  url: z.string(),
  title: z.string(),
  price: z.string(),
});
export type StoredCandidate = z.infer<typeof StoredCandidateSchema>;

const StoredLookupSchema = z.object({
  lookupId: z.string(),
  at: z.string(),
  question: z.string(),
  decision: z.string(),
  candidates: z.array(StoredCandidateSchema),
});
export type StoredLookup = z.infer<typeof StoredLookupSchema>;

const StoreSchema = z.object({
  schemaVersion: z.literal(1),
  lookups: z.array(StoredLookupSchema),
});

function storePath(dataDir: string): string {
  return join(dataDir, 'lookups.json');
}

export async function loadLookups(dataDir: string): Promise<StoredLookup[]> {
  let raw: string;
  try {
    raw = await readFile(storePath(dataDir), 'utf8');
  } catch {
    return [];
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return [];
  }
  const parsed = StoreSchema.safeParse(json);
  return parsed.success ? parsed.data.lookups : [];
}

/** Prepend a lookup (newest first), cap to MAX_ENTRIES, persist under a lock so
 *  concurrent lookups don't drop each other's entry. */
export async function recordLookup(dataDir: string, entry: StoredLookup): Promise<void> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const lockPath = `${storePath(dataDir)}.lock`;
  await withFileLock(lockPath, async () => {
    const existing = await loadLookups(dataDir);
    const lookups = [entry, ...existing.filter((l) => l.lookupId !== entry.lookupId)].slice(
      0,
      MAX_ENTRIES,
    );
    await writeFileAtomic(
      storePath(dataDir),
      `${JSON.stringify({ schemaVersion: 1, lookups }, null, 2)}\n`,
      { mode: 0o644, dirMode: 0o700 },
    );
  });
}

export async function latestLookup(dataDir: string): Promise<StoredLookup | null> {
  const lookups = await loadLookups(dataDir);
  return lookups[0] ?? null;
}

/** The stored candidate for a resourceId across recent lookups (newest first). */
export async function findStoredCandidate(
  dataDir: string,
  resourceId: string,
): Promise<StoredCandidate | null> {
  for (const lookup of await loadLookups(dataDir)) {
    const hit = lookup.candidates.find((c) => c.resourceId === resourceId);
    if (hit) return hit;
  }
  return null;
}

/** The most recent lookupId that surfaced this resource (by id or url), for
 *  purchase attribution (`X-Tenjin-Lookup-Id`). Null when no local lookup did. */
export async function findLookupForResource(
  dataDir: string,
  match: { resourceId?: string; url?: string },
): Promise<string | null> {
  for (const lookup of await loadLookups(dataDir)) {
    const hit = lookup.candidates.some(
      (c) =>
        (match.resourceId !== undefined && c.resourceId === match.resourceId) ||
        (match.url !== undefined && c.url === match.url),
    );
    if (hit) return lookup.lookupId;
  }
  return null;
}
