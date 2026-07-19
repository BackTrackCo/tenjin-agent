import { readFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { writeFileAtomic } from './atomic-json';
import { withFileLock } from './lock';

/**
 * Local lookup history: what powers `outcome --last` and the automatic
 * X-Tenjin-Lookup-Id attribution on a buy that follows a lookup. Deliberately
 * minimal: the question text is never stored (the privacy default is that raw
 * queries live nowhere but the lookup request itself), only ids and the
 * candidate identities needed to resolve a later `buy <resourceId>`.
 */
export const StoredCandidateSchema = z.object({
  resourceId: z.string(),
  url: z.string(),
  title: z.string(),
  price: z.string(),
});
export type StoredCandidate = z.infer<typeof StoredCandidateSchema>;

export const StoredLookupSchema = z.object({
  lookupId: z.string(),
  decision: z.enum(['CANDIDATES', 'MISS']),
  at: z.string(),
  candidates: z.array(StoredCandidateSchema),
});
export type StoredLookup = z.infer<typeof StoredLookupSchema>;

const LookupHistorySchema = z.object({ lookups: z.array(StoredLookupSchema) });

const HISTORY_CAP = 20;

export function lookupHistoryPath(dir: string): string {
  return join(dir, 'lookups.json');
}

/** Corrupt or missing history degrades to empty: history is a convenience, never load-bearing. */
export async function readLookupHistory(dir: string): Promise<StoredLookup[]> {
  let raw: string;
  try {
    raw = await readFile(lookupHistoryPath(dir), 'utf8');
  } catch {
    return [];
  }
  try {
    return LookupHistorySchema.parse(JSON.parse(raw)).lookups;
  } catch {
    return [];
  }
}

export async function recordLookup(dir: string, entry: StoredLookup): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = lookupHistoryPath(dir);
  await withFileLock(`${path}.lock`, async () => {
    const existing = await readLookupHistory(dir);
    const lookups = [entry, ...existing].slice(0, HISTORY_CAP);
    await writeFileAtomic(path, `${JSON.stringify({ lookups }, null, 2)}\n`, {
      mode: 0o644,
      dirMode: 0o700,
    });
  });
}

export async function lastLookup(dir: string): Promise<StoredLookup | null> {
  const lookups = await readLookupHistory(dir);
  return lookups[0] ?? null;
}

/**
 * Most recent lookup that surfaced this resource (by id or read URL), for
 * candidate-scoped outcome reporting and buy attribution. Server-side, an
 * outcome resourceId that was not a candidate of the named lookup stores as
 * null, so resolving through history keeps reports meaningful.
 */
export async function findCandidate(
  dir: string,
  ref: string,
): Promise<{ lookup: StoredLookup; candidate: StoredCandidate } | null> {
  for (const lookup of await readLookupHistory(dir)) {
    const candidate = lookup.candidates.find((c) => c.resourceId === ref || c.url === ref);
    if (candidate !== undefined) return { lookup, candidate };
  }
  return null;
}

/**
 * The local library: purchased bodies at `library/<resourceId>/<slug>.md` with a
 * meta sidecar carrying identity, price paid, settlement hash, and the content
 * hash outcomes use to identify mutable-post content pre-versioning.
 */
export const LibraryMetaSchema = z.object({
  resourceId: z.string(),
  slug: z.string(),
  title: z.string(),
  url: z.string(),
  priceAtomic: z.string(),
  paidAtomic: z.string(),
  txHash: z.string().nullable(),
  contentHash: z.string(),
  entitlement: z.enum(['paid', 'already-entitled', 'free']),
  creatorHandle: z.string().nullable(),
  savedAt: z.string(),
});
export type LibraryMeta = z.infer<typeof LibraryMetaSchema>;

export function libraryDir(dir: string): string {
  return join(dir, 'library');
}

export function libraryItemPaths(
  dir: string,
  resourceId: string,
  slug: string,
): { md: string; meta: string } {
  const itemDir = join(libraryDir(dir), resourceId);
  return { md: join(itemDir, `${slug}.md`), meta: join(itemDir, `${slug}.meta.json`) };
}

/** sha256 over the exact bodyMd string the read API returned (outcome contentHash form). */
export function contentHashOf(bodyMd: string): string {
  return `sha256:${createHash('sha256').update(bodyMd, 'utf8').digest('hex')}`;
}

export async function saveLibraryItem(
  dir: string,
  meta: Omit<LibraryMeta, 'contentHash' | 'savedAt'>,
  bodyMd: string,
): Promise<LibraryMeta> {
  const paths = libraryItemPaths(dir, meta.resourceId, meta.slug);
  const full: LibraryMeta = {
    ...meta,
    contentHash: contentHashOf(bodyMd),
    savedAt: new Date().toISOString(),
  };
  await writeFileAtomic(paths.md, bodyMd, { mode: 0o644, dirMode: 0o700 });
  await writeFileAtomic(paths.meta, `${JSON.stringify(full, null, 2)}\n`, {
    mode: 0o644,
    dirMode: 0o700,
  });
  return full;
}

export async function readLibraryMeta(
  dir: string,
  resourceId: string,
  slug: string,
): Promise<LibraryMeta | null> {
  try {
    const raw = await readFile(libraryItemPaths(dir, resourceId, slug).meta, 'utf8');
    return LibraryMetaSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** First meta found for a resource id, slug unknown (readdir over the item dir). */
export async function findLibraryByResource(
  dir: string,
  resourceId: string,
): Promise<LibraryMeta | null> {
  const { readdir } = await import('node:fs/promises');
  let entries: string[];
  try {
    entries = await readdir(join(libraryDir(dir), resourceId));
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.meta.json')) continue;
    const meta = await readLibraryMeta(dir, resourceId, entry.slice(0, -'.meta.json'.length));
    if (meta !== null) return meta;
  }
  return null;
}
