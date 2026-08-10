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

/**
 * What closed an open loop. A MISS the agent acted on ends in exactly one of
 * these three, and the Stop hook stays quiet once any of them is recorded:
 * `outcome` (the loop was reported), `publish` (the answer went back to the
 * marketplace), `candidate` (the draft was parked to publish later).
 */
export const SearchResolutionSchema = z.enum(['outcome', 'publish', 'candidate']);
export type SearchResolution = z.infer<typeof SearchResolutionSchema>;

/**
 * Who ran the search. `cli` is a deliberate `tenjin search`: the agent decided
 * the question was worth looking up, so an unanswered one is a strong signal.
 * `websearch-hook` is the PreToolUse hook riding along with a WebSearch the agent
 * was going to run anyway, which is a much weaker signal, because nobody judged
 * the question suitable for the marketplace before it was sent.
 *
 * The distinction exists because the Stop hook must not treat them alike: an
 * unanswered deliberate search deserves being named on its own, while a batch of
 * hook searches deserves one line the agent can dismiss at a glance. Keeping both
 * in ONE store is what makes the hook's misses reachable by explicit
 * `outcome --search-id`, `buy <resourceId>`, and the open-loop reminder at all
 * (`--last` deliberately skips hook entries; see {@link latestSearch}).
 *
 * OPTIONAL, and absent means `cli`: a store written by an earlier version has no
 * source field, and those entries were all explicit searches.
 */
export const SearchSourceSchema = z.enum(['cli', 'websearch-hook']);
export type SearchSource = z.infer<typeof SearchSourceSchema>;

const StoredSearchSchema = z.object({
  searchId: z.string(),
  at: z.string(),
  question: z.string(),
  decision: z.string(),
  candidates: z.array(StoredCandidateSchema),
  /** Absent until something closes the loop; see {@link markSearchResolved}. */
  resolved: z.object({ by: SearchResolutionSchema, at: z.string() }).optional(),
  /** Absent on entries written before sources existed; see {@link SearchSourceSchema}. */
  source: SearchSourceSchema.optional(),
  /**
   * The harness session this search was run in, when anything could attribute it.
   * This ledger is MACHINE-GLOBAL, so without it the Stop hook nags whichever
   * session happens to stop next about open loops belonging to a sibling session,
   * which that session cannot act on. The hook scopes on this when both the entry
   * and the turn-end payload name a session, and stays global otherwise, so an
   * unstamped entry is still raised everywhere rather than nowhere.
   *
   * OPTIONAL and often absent: only the WebSearch hook is handed a session id by
   * the harness (`session_id` on its stdin payload). A deliberate `tenjin search`
   * is a Bash subprocess, and the harness exports no session id to those, so it
   * stamps only when the operator sets TENJIN_SESSION_ID.
   */
  sessionId: z.string().optional(),
  // How many of the search's browse pointers cost money, and NOT the pointers
  // themselves: keeping them out of the store is what makes `buy <resourceId>`
  // unable to reach one (see the browse comment in agent-api.ts), and a count
  // cannot undo that. It exists so `outcome` can tell "this search offered
  // nothing to buy" from "this search offered a payable browse tail", which the
  // candidates array alone cannot say. Counts only PAID pointers because a
  // zero-priced piece is delivered by `read` with no purchase to decline.
  // Optional because entries written before this field existed have no answer,
  // and `undefined` must read as unknown rather than as zero.
  paidBrowseCount: z.number().int().nonnegative().optional(),
});
export type StoredSearch = z.infer<typeof StoredSearchSchema>;

const StoreSchema = z.object({
  schemaVersion: z.literal(1),
  searches: z.array(StoredSearchSchema),
});

/**
 * The store and its lock. Both paths are EXPORTED because the installed hook
 * scripts write this same file from outside the CLI process: they cannot import
 * this module, so they reimplement the lock protocol against this exact path.
 * Two writers of one file must at least agree on where the mutex lives, and a
 * test pins the script's protocol against this one.
 */
export function searchStorePath(dataDir: string): string {
  return join(dataDir, 'searches.json');
}

export function searchStoreLockPath(dataDir: string): string {
  return `${searchStorePath(dataDir)}.lock`;
}

function storePath(dataDir: string): string {
  return searchStorePath(dataDir);
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

/**
 * Record that something closed the loop on `searchId`, so the Stop hook stops
 * raising it. Best-effort in both directions and it NEVER throws: an unknown id
 * (the search aged past MAX_ENTRIES, or came from another machine) writes
 * nothing, and a failure to persist costs one stale nag rather than the command
 * the caller actually ran. The FIRST resolution wins, so a publish after an
 * outcome report does not rewrite who closed it.
 */
export async function markSearchResolved(
  dataDir: string,
  searchId: string,
  by: SearchResolution,
  at: string = new Date().toISOString(),
): Promise<void> {
  try {
    const lockPath = `${storePath(dataDir)}.lock`;
    await withFileLock(lockPath, async () => {
      const existing = await loadSearches(dataDir);
      const target = existing.find((s) => s.searchId === searchId);
      if (target === undefined || target.resolved !== undefined) return;
      const searches = existing.map((s) =>
        s.searchId === searchId ? { ...s, resolved: { by, at } } : s,
      );
      await writeFileAtomic(
        storePath(dataDir),
        `${JSON.stringify({ schemaVersion: 1, searches }, null, 2)}\n`,
        { mode: 0o644, dirMode: 0o700 },
      );
    });
  } catch {
    // Bookkeeping for a hook nudge. It must never fail the verb that ran.
  }
}

/**
 * The most recent DELIBERATE search: `--last` means "the search I just ran", and
 * in auto mode the WebSearch hook prepends a ridealong entry on every web search,
 * so an unfiltered head would routinely re-target `outcome --last` at a query the
 * agent never chose to make (found in dogfooding). Hook entries stay reachable by
 * explicit `--search-id`, which is what the Stop hook's reminder names.
 */
export async function latestSearch(dataDir: string): Promise<StoredSearch | null> {
  const searches = await loadSearches(dataDir);
  return searches.find((s) => s.source !== 'websearch-hook') ?? null;
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
