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

/**
 * The store's bounds, EXPORTED because lib/hook-scripts.ts bakes them into the
 * scripts it generates, which cannot import this module: one definition, no
 * drift. `DEMAND_MAX_ENTRIES` is the share the two DEMAND sources may hold
 * BETWEEN THEM — `dispatch-hook` and `push-hook`, one shared budget rather than
 * one each. Nothing ever closes an entry from either, so without the budget a
 * wide fan-out or a busy push session drains the slots `buy` and
 * `outcome --last` depend on.
 */
export const MAX_ENTRIES = 50;
export const DEMAND_MAX_ENTRIES = 15;

const StoredCandidateSchema = z.object({
  resourceId: z.string(),
  url: z.string(),
  title: z.string(),
  price: z.string(),
});
export type StoredCandidate = z.infer<typeof StoredCandidateSchema>;

/**
 * What closed an open loop. The Stop hook stays quiet once any of these is
 * recorded: `outcome` (the loop was reported) or `publish` (the answer went back
 * to the marketplace).
 *
 * `candidate` is RETAINED but never written. It is what the removed candidate
 * pen recorded, and an older `searches.json` still carries it; dropping the
 * member would make those entries fail to parse and read as an empty store,
 * which would resurrect loops their owner already closed.
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
 * `push-hook` is the push experiment's arms (docs/command-reference.md#push-experimental): lookups made on an
 * error or a file the agent touched, never chosen by the agent, so they share
 * the demand budget below and the Stop hook never raises them.
 * `dispatch-hook` is weaker still: DEMAND DATA about what an agent was about to
 * research, which the Stop hook never raises and which holds a bounded share of
 * the store, because nothing ever closes one.
 *
 * The distinction exists because the Stop hook must not treat them alike: an
 * unanswered deliberate search deserves being named on its own, while a batch of
 * hook searches deserves one line the agent can dismiss at a glance. Keeping them
 * all in ONE store is what makes a hook's misses reachable by explicit
 * `outcome --search-id`, `buy <resourceId>`, and the open-loop reminder at all
 * (`--last` deliberately skips hook entries; see {@link latestSearch}).
 *
 * OPTIONAL, and absent means `cli`: a store written by an earlier version has no
 * source field, and those entries were all explicit searches.
 */
export const SearchSourceSchema = z.enum(['cli', 'websearch-hook', 'dispatch-hook', 'push-hook']);
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
   * WHICH SHELF ANSWERED, as a base URL. A team-mode search asks the team shelf
   * and falls through to `publicShelfUrl`, and the two shelves have separate
   * databases: a searchId minted by one means nothing to the other. Without this
   * field every close — `tenjin outcome`, and the `--search-id` publish sends
   * with the piece — went to the configured `baseUrl`, so the ordinary team-miss
   * / public-hit reported the public marketplace's search to the team shelf,
   * where it inflates `outcomes_dropped_no_parent` or lands permanently on a post
   * row, while the shelf that actually served the search hears nothing and its
   * demand loop stays open.
   *
   * The push ledger already carries the same fact per row (`shelf` in
   * lib/push-scripts.ts); this is that fact where the close paths can read it.
   *
   * OPTIONAL, and absent means `baseUrl` — which is what every entry written
   * before this field existed meant, and what a single-shelf public-mode run
   * still means. Stored as the URL rather than as `team`/`public` so a re-pointed
   * `baseUrl` cannot silently re-label an old entry's shelf.
   */
  shelfBaseUrl: z.string().optional(),
  /**
   * The harness session this search was run in, when anything could attribute it.
   * This ledger is MACHINE-GLOBAL, so without it the Stop hook nags whichever
   * session happens to stop next about open loops belonging to a sibling session,
   * which that session cannot act on. The hook scopes on this when both the entry
   * and the turn-end payload name a session, and stays global otherwise, so an
   * unstamped entry is still raised everywhere rather than nowhere.
   *
   * OPTIONAL: the WebSearch hook is handed one by the harness (`session_id` on
   * its stdin payload), and a deliberate `tenjin search` reads the same value
   * from CLAUDE_CODE_SESSION_ID (or an operator's TENJIN_SESSION_ID). Absent on
   * entries written before this field existed, and on any harness that exports
   * neither.
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

/**
 * Demand entries held to their share, then the whole thing capped. Entries are
 * newest-first, so dropping once the budget is spent drops the OLDEST demand
 * entries and spares every deliberate one the plain cap would have taken.
 *
 * ⚠ MIRRORED, MUST UPDATE TOGETHER with `budgeted` in lib/hook-scripts.ts. It
 * lives in BOTH writers so the bound belongs to the store rather than to
 * whichever process wrote last.
 */
function budgeted(entries: StoredSearch[]): StoredSearch[] {
  const kept: StoredSearch[] = [];
  let demand = 0;
  for (const entry of entries) {
    if (entry.source === 'dispatch-hook' || entry.source === 'push-hook') {
      if (demand >= DEMAND_MAX_ENTRIES) continue;
      demand += 1;
    }
    kept.push(entry);
  }
  return kept.slice(0, MAX_ENTRIES);
}

/** Prepend a search (newest first), budget and cap it, persist under a lock so
 *  concurrent searches don't drop each other's entry. */
export async function recordSearch(dataDir: string, entry: StoredSearch): Promise<void> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const lockPath = `${storePath(dataDir)}.lock`;
  await withFileLock(lockPath, async () => {
    const existing = await loadSearches(dataDir);
    const searches = budgeted([entry, ...existing.filter((l) => l.searchId !== entry.searchId)]);
    await writeFileAtomic(
      storePath(dataDir),
      `${JSON.stringify({ schemaVersion: 1, searches }, null, 2)}\n`,
      { mode: 0o644, dirMode: 0o700 },
    );
  });
}

/**
 * What a {@link markSearchResolved} call actually did. Returned rather than
 * swallowed because a caller may REPORT the close to its own user, and "I tried"
 * is not "it happened": a lock timeout or an unwritable store still leaves the
 * loop open and the reminder due, so a receipt claiming otherwise would be a
 * confident lie. `already-resolved` is a success for anyone asking about the
 * LOOP (something closed it), and a no-op for anyone asking about this call.
 * `relinked` is the one that CHANGED a resolution that was already there.
 */
export type ResolutionOutcome =
  'resolved' | 'relinked' | 'already-resolved' | 'not-found' | 'failed';

export interface MarkResolvedOptions {
  /**
   * Overwrite a resolution recorded by something else, rather than leaving the
   * first closer in place. Only `publish` passes it, and the reason is the loop
   * this whole ledger exists for: an agent mid-research closes a MISS as
   * `regenerated` because the answer is not written yet, finishes it minutes
   * later, and then has no way to say the piece it just published is what
   * answered that question (tenjin-agent #161). A close is a report of intent at
   * a moment; a publish is the answer arriving, and the answer wins.
   */
  relink?: boolean;
}

/**
 * Record that something closed the loop on `searchId`, so the Stop hook stops
 * raising it. Best-effort and it NEVER throws: an unknown id (the search aged
 * past MAX_ENTRIES, or came from another machine) writes nothing, and a failure
 * to persist costs one stale nag rather than the command the caller actually
 * ran. The FIRST resolution wins unless the caller asks to {@link
 * MarkResolvedOptions.relink}, so an ordinary `outcome` after a publish still
 * does not rewrite who closed it.
 */
export async function markSearchResolved(
  dataDir: string,
  searchId: string,
  by: SearchResolution,
  at: string = new Date().toISOString(),
  options: MarkResolvedOptions = {},
): Promise<ResolutionOutcome> {
  try {
    const lockPath = `${storePath(dataDir)}.lock`;
    let outcome: ResolutionOutcome = 'not-found';
    await withFileLock(lockPath, async () => {
      const existing = await loadSearches(dataDir);
      const target = existing.find((s) => s.searchId === searchId);
      if (target === undefined) return;
      if (target.resolved !== undefined) {
        // Nothing to relink when the recorded closer is already this one: the
        // loop is where it should be, and rewriting the timestamp would report
        // a change nobody made.
        if (options.relink !== true || target.resolved.by === by) {
          outcome = 'already-resolved';
          return;
        }
        outcome = 'relinked';
      }
      const searches = existing.map((s) =>
        s.searchId === searchId ? { ...s, resolved: { by, at } } : s,
      );
      await writeFileAtomic(
        storePath(dataDir),
        `${JSON.stringify({ schemaVersion: 1, searches }, null, 2)}\n`,
        { mode: 0o644, dirMode: 0o700 },
      );
      // 'relinked' was decided above and survives the write; anything else that
      // reached here closed a loop nothing had closed.
      if (outcome !== 'relinked') outcome = 'resolved';
    });
    return outcome;
  } catch {
    // Bookkeeping for a hook nudge. It must never fail the verb that ran — but
    // the caller is told, so nothing reports a close that did not happen.
    return 'failed';
  }
}

/**
 * The most recent DELIBERATE search: `--last` means "the search I just ran", and
 * in auto mode the hooks prepend a ridealong entry on every web search and every
 * subagent dispatch, so an unfiltered head would routinely re-target `outcome
 * --last` at a query the agent never chose to make (found in dogfooding). Hook
 * entries stay reachable by explicit `--search-id`, which is what the Stop hook's
 * reminder names.
 */
export async function latestSearch(dataDir: string): Promise<StoredSearch | null> {
  const searches = await loadSearches(dataDir);
  return searches.find((s) => s.source === undefined || s.source === 'cli') ?? null;
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
