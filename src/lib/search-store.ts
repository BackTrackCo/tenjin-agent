import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { writeFileAtomic } from './atomic-json';
import { withFileLock } from './lock';

/**
 * A small local ledger of recent searches so `outcome --last` can target the most
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

const StoredSearchSchema = z.object({
  searchId: z.string(),
  at: z.string(),
  question: z.string(),
  decision: z.string(),
  candidates: z.array(StoredCandidateSchema),
});
export type StoredSearch = z.infer<typeof StoredSearchSchema>;

const StoreSchema = z.object({
  schemaVersion: z.literal(1),
  searches: z.array(StoredSearchSchema),
});

function storePath(dataDir: string): string {
  return join(dataDir, 'searches.json');
}

export async function loadSearches(dataDir: string): Promise<StoredSearch[]> {
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
  return parsed.success ? parsed.data.searches : [];
}

/** Prepend a search (newest first), cap to MAX_ENTRIES, persist under a lock so
 *  concurrent searches don't drop each other's entry. */
export async function recordSearch(dataDir: string, entry: StoredSearch): Promise<void> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const lockPath = `${storePath(dataDir)}.lock`;
  await withFileLock(lockPath, async () => {
    const existing = await loadSearches(dataDir);
    const searches = [entry, ...existing.filter((l) => l.searchId !== entry.searchId)].slice(
      0,
      MAX_ENTRIES,
    );
    await writeFileAtomic(
      storePath(dataDir),
      `${JSON.stringify({ schemaVersion: 1, searches }, null, 2)}\n`,
      { mode: 0o644, dirMode: 0o700 },
    );
  });
}

export async function latestSearch(dataDir: string): Promise<StoredSearch | null> {
  const searches = await loadSearches(dataDir);
  return searches[0] ?? null;
}

/** The stored candidate for a resourceId across recent searches (newest first). */
export async function findStoredCandidate(
  dataDir: string,
  resourceId: string,
): Promise<StoredCandidate | null> {
  for (const search of await loadSearches(dataDir)) {
    const hit = search.candidates.find((c) => c.resourceId === resourceId);
    if (hit) return hit;
  }
  return null;
}

/** The most recent searchId that surfaced this resource (by id or url), for
 *  purchase attribution (`X-Tenjin-Search-Id`). Null when no local search did. */
export async function findSearchForResource(
  dataDir: string,
  match: { resourceId?: string; url?: string },
): Promise<string | null> {
  for (const search of await loadSearches(dataDir)) {
    const hit = search.candidates.some(
      (c) =>
        (match.resourceId !== undefined && c.resourceId === match.resourceId) ||
        (match.url !== undefined && c.url === match.url),
    );
    if (hit) return search.searchId;
  }
  return null;
}
