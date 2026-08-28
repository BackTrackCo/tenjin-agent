import { z } from 'zod';
import { openStore, searchFingerprint, STORE_SQL, storeSession, type Store } from './state-store';

/**
 * A local ledger of recent searches so `outcome --last` can target the most
 * recent one and `buy <resourceId>` can resolve the payable read URL a candidate
 * carried (the read route is keyed by handle/slug, not id, so an id alone can't
 * build the URL). Best-effort: an unavailable store reads as empty rather than
 * blocking a command. NOT an entitlement record, that is the library receipt.
 *
 * BACKED BY `state.db` (tenjin-agent#209), not by `searches.json`. The file
 * version was the last piece of hook state living outside the store, and it cost
 * three things the table does not: an mkdir mutex the generated hooks had to
 * reimplement byte for byte (two writers of one file that disagree about the
 * mutex have no mutex), a 50-entry cap with a hand-rolled demand budget so a
 * subagent fan-out could not drain the slots `buy` and `outcome --last` depend
 * on, and a whole-file parse for every question anybody asked of it. A row is a
 * row, WAL serializes the writers, and every reader queries what it needs.
 */

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
 * pen recorded, and it stays in the union so a value written by an older build
 * parses rather than reading as an unclosed loop.
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
 * error or a file the agent touched, never chosen by the agent, so the Stop hook
 * never raises them. `dispatch-hook` is weaker still: DEMAND DATA about what an
 * agent was about to research, which the Stop hook never raises either.
 *
 * The distinction exists because the Stop hook must not treat them alike: an
 * unanswered deliberate search deserves being named on its own, while a batch of
 * hook searches deserves one line the agent can dismiss at a glance. Keeping them
 * in ONE table is what makes a hook's misses reachable by explicit
 * `outcome --search-id`, `buy <resourceId>`, and the open-loop reminder at all
 * (`--last` deliberately skips hook entries; see {@link latestSearch}).
 *
 * OPTIONAL, and absent means `cli`: a row written by an earlier version has no
 * source, and those entries were all explicit searches.
 */
export const SearchSourceSchema = z.enum(['cli', 'websearch-hook', 'dispatch-hook', 'push-hook']);
export type SearchSource = z.infer<typeof SearchSourceSchema>;

export interface StoredSearch {
  searchId: string;
  /** ISO 8601. Stored as epoch ms; rendered here in the shape callers print. */
  at: string;
  question: string;
  decision: string;
  candidates: StoredCandidate[];
  /** Absent until something closes the loop; see {@link markSearchResolved}. */
  resolved?: { by: SearchResolution; at: string };
  /** Absent on rows written before sources existed; see {@link SearchSourceSchema}. */
  source?: SearchSource;
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
   * Absent means `baseUrl` — what every row written before this field existed
   * meant, and what a single-shelf public-mode run still means. Stored as the URL
   * rather than as `team`/`public` so a re-pointed `baseUrl` cannot silently
   * re-label an old row's shelf.
   */
  shelfBaseUrl?: string;
  /**
   * The harness session this search was run in, when anything could attribute it.
   * This ledger is MACHINE-GLOBAL, so without it the Stop hook nags whichever
   * session happens to stop next about open loops belonging to a sibling session,
   * which that session cannot act on. The hook scopes on this when both the row
   * and the turn-end payload name a session, and stays global otherwise, so an
   * unstamped row is still raised everywhere rather than nowhere.
   */
  sessionId?: string;
  /**
   * The DRAFT this search's claim is parked on. A `publish --draft --search-id`
   * withholds the claim from the wire (a draft answers nobody) and records the
   * created post id here instead, so `edit --status published` can send the
   * claim when the draft actually goes public. Cleared never: once the loop is
   * resolved the link is inert. Stored as a machine-bucket `session_state` row
   * (`draft-search:<searchId>`), not a `searches` column; see
   * `STORE_SQL.listSearches`.
   */
  draftPostId?: string;
  /**
   * How many of the search's browse pointers cost money, and NOT the pointers
   * themselves: keeping them out of the store is what makes `buy <resourceId>`
   * unable to reach one (see the browse comment in agent-api.ts), and a count
   * cannot undo that. It exists so `outcome` can tell "this search offered
   * nothing to buy" from "this search offered a payable browse tail", which the
   * candidates array alone cannot say. Absent reads as unknown, never as zero.
   */
  paidBrowseCount?: number;
}

/**
 * How many rows a bare {@link loadSearches} returns, newest first.
 *
 * The table is unbounded (plan 03, owner decision 2: no retention, no pruning),
 * so the callers that want "the recent searches" get a bound here instead of one
 * baked into the storage. Every caller of this function is answering a question
 * about the last few days — the open loops, the ids a publish is closing — and
 * the ones that need a specific row ask for it by id.
 */
const RECENT_LIMIT = 500;

/** Where a draft link lives: the machine ('') `session_state` bucket, keyed
 *  `draft-search:<searchId>`. ⚠ MIRRORED as a literal inside
 *  `STORE_SQL.listSearches` and `STORE_SQL.searchesForDraft`. */
const DRAFT_LINK_PREFIX = 'draft-search:';
const MACHINE_SESSION = '';

/**
 * ONE SPELLING for the draft link's value, on the way in and on the way out.
 * The link is matched as SQL text under SQLite's BINARY collation while the
 * command edge's `UUID_RE` takes a post id in either case, so an uppercase
 * `edit 0197AAAA-… --status published` would find no parked claim and drop the
 * attribution behind a successful receipt. Folded like the sibling id
 * (`normalizeSearchIds`); Postgres stores `uuid` lowercased anyway.
 */
function foldPostId(postId: string): string {
  return postId.toLowerCase();
}

function rowToSearch(row: Record<string, unknown>): StoredSearch | null {
  const searchId = typeof row.search_id === 'string' ? row.search_id : '';
  if (searchId.length === 0) return null;
  let candidates: StoredCandidate[] = [];
  if (typeof row.candidates === 'string') {
    try {
      const parsed = StoredCandidateSchema.array().safeParse(JSON.parse(row.candidates));
      if (parsed.success) candidates = parsed.data;
    } catch {
      // A row whose candidate blob will not parse still has a usable searchId,
      // question and decision — which is what the open-loop reminder needs.
    }
  }
  const source = SearchSourceSchema.safeParse(row.source);
  const resolvedBy = SearchResolutionSchema.safeParse(row.resolved_by);
  return {
    searchId,
    at: new Date(typeof row.at === 'number' ? row.at : 0).toISOString(),
    question: typeof row.question === 'string' ? row.question : '',
    decision: typeof row.decision === 'string' ? row.decision : '',
    candidates,
    ...(resolvedBy.success
      ? {
          resolved: {
            by: resolvedBy.data,
            at: typeof row.resolved_at === 'string' ? row.resolved_at : '',
          },
        }
      : {}),
    ...(source.success ? { source: source.data } : {}),
    ...(typeof row.shelf_base_url === 'string' && row.shelf_base_url.length > 0
      ? { shelfBaseUrl: row.shelf_base_url }
      : {}),
    ...(typeof row.session === 'string' && row.session.length > 0
      ? { sessionId: row.session }
      : {}),
    ...(typeof row.draft_post_id === 'string' && row.draft_post_id.length > 0
      ? { draftPostId: row.draft_post_id }
      : {}),
    ...(typeof row.paid_browse_count === 'number'
      ? { paidBrowseCount: row.paid_browse_count }
      : {}),
  };
}

/** Open, run `fn`, close. A null store yields `fallback` — the same posture the
 *  file version had for an unreadable searches.json. */
async function withStore<T>(dataDir: string, fallback: T, fn: (store: Store) => T): Promise<T> {
  const store = await openStore(dataDir);
  if (store === null) return fallback;
  try {
    return fn(store);
  } catch {
    return fallback;
  } finally {
    store.close();
  }
}

/** The most recent searches, newest first. */
export async function loadSearches(dataDir: string): Promise<StoredSearch[]> {
  return await withStore(dataDir, [] as StoredSearch[], (store) => {
    const rows = store.all(STORE_SQL.listSearches, [RECENT_LIMIT]);
    const out: StoredSearch[] = [];
    for (const row of rows) {
      const entry = rowToSearch(row);
      if (entry !== null) out.push(entry);
    }
    return out;
  });
}

/** Record a search, replacing any row already under that id. */
export async function recordSearch(dataDir: string, entry: StoredSearch): Promise<void> {
  await withStore(dataDir, undefined, (store) => {
    const at = Date.parse(entry.at);
    store.run(STORE_SQL.recordSearch, [
      entry.searchId,
      Number.isFinite(at) ? at : Date.now(),
      storeSession(entry.sessionId),
      entry.question,
      searchFingerprint(entry.question),
      entry.decision,
      JSON.stringify(entry.candidates),
      entry.source ?? null,
      entry.shelfBaseUrl ?? null,
      entry.paidBrowseCount ?? null,
    ]);
    // A caller that already knows who closed the loop (a re-record, a fixture)
    // says so here rather than needing a second call: the upsert above leaves
    // `resolved_by` alone precisely so an ordinary re-record cannot reopen a
    // loop something already closed.
    if (entry.resolved !== undefined) {
      store.run(STORE_SQL.resolveSearch, [entry.resolved.by, entry.resolved.at, entry.searchId]);
    }
    // Same posture as `resolved`: a caller that already knows the draft this
    // claim is parked on (a re-record, a fixture) writes the link in one call.
    if (entry.draftPostId !== undefined) {
      store.run(STORE_SQL.setState, [
        MACHINE_SESSION,
        DRAFT_LINK_PREFIX + entry.searchId,
        foldPostId(entry.draftPostId),
        Date.now(),
      ]);
    }
  });
}

/**
 * What a {@link markSearchResolved} call actually did. Returned rather than
 * swallowed because a caller may REPORT the close to its own user, and "I tried"
 * is not "it happened": an unwritable store still leaves the loop open and the
 * reminder due, so a receipt claiming otherwise would be a confident lie.
 * `already-resolved` is a success for anyone asking about the LOOP (something
 * closed it), and a no-op for anyone asking about this call. `relinked` is the
 * one that CHANGED a resolution that was already there.
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
 * raising it. Best-effort and it NEVER throws: an unknown id (a search from
 * another machine) writes nothing, and a failure to persist costs one stale nag
 * rather than the command the caller actually ran. The FIRST resolution wins
 * unless the caller asks to {@link MarkResolvedOptions.relink}, so an ordinary
 * `outcome` after a publish still does not rewrite who closed it.
 */
export async function markSearchResolved(
  dataDir: string,
  searchId: string,
  by: SearchResolution,
  at: string = new Date().toISOString(),
  options: MarkResolvedOptions = {},
): Promise<ResolutionOutcome> {
  return await withStore(dataDir, 'failed' as ResolutionOutcome, (store) => {
    const row = store.get(STORE_SQL.getSearch, [searchId]);
    if (row === null) return 'not-found';
    const existing = SearchResolutionSchema.safeParse(row.resolved_by);
    let outcome: ResolutionOutcome = 'resolved';
    if (existing.success) {
      // Nothing to relink when the recorded closer is already this one: the loop
      // is where it should be, and rewriting the timestamp would report a change
      // nobody made.
      if (options.relink !== true || existing.data === by) return 'already-resolved';
      outcome = 'relinked';
    }
    // REPORTED, not assumed: a swallowed write must not come back as a close.
    if (!store.run(STORE_SQL.resolveSearch, [by, at, searchId])) return 'failed';
    return outcome;
  });
}

/**
 * Park each named search's claim on the draft that will answer it, so a later
 * promotion can carry it to the server. Best-effort exactly like
 * {@link markSearchResolved}: an unknown id writes nothing, and a failure to
 * persist costs the claim rather than the publish that already succeeded.
 */
export async function linkSearchesToDraft(
  dataDir: string,
  searchIds: string[],
  draftPostId: string,
): Promise<void> {
  if (searchIds.length === 0) return;
  const parkedOn = foldPostId(draftPostId);
  await withStore(dataDir, undefined, (store) => {
    const at = Date.now();
    for (const searchId of new Set(searchIds)) {
      // A link to a row this ledger never recorded would never be read back:
      // `searchesForDraft` joins on the searches table.
      if (store.get(STORE_SQL.getSearch, [searchId]) === null) continue;
      store.run(STORE_SQL.setState, [MACHINE_SESSION, DRAFT_LINK_PREFIX + searchId, parkedOn, at]);
    }
  });
}

/**
 * The searches whose claims are parked on `draftPostId`. Resolved entries are
 * INCLUDED on purpose: publish sends the id even on a relink (an `outcome`
 * closing the loop first does not change who ended up answering it), and the
 * promotion is that publish arriving late.
 */
export async function searchesForDraft(
  dataDir: string,
  draftPostId: string,
): Promise<StoredSearch[]> {
  const parkedOn = foldPostId(draftPostId);
  return await withStore(dataDir, [] as StoredSearch[], (store) => {
    const out: StoredSearch[] = [];
    for (const row of store.all(STORE_SQL.searchesForDraft, [parkedOn])) {
      const entry = rowToSearch(row);
      // The join proved the link, so the row carries it even though the SELECT
      // does not: `s.*` has no draft_post_id column to alias.
      if (entry !== null) out.push({ ...entry, draftPostId: parkedOn });
    }
    return out;
  });
}

/**
 * The most recent DELIBERATE search: `--last` means "the search I just ran", and
 * in auto mode the hooks record a ridealong entry on every web search and every
 * subagent dispatch, so an unfiltered head would routinely re-target `outcome
 * --last` at a query the agent never chose to make (found in dogfooding). Hook
 * entries stay reachable by explicit `--search-id`, which is what the Stop hook's
 * reminder names.
 */
export async function latestSearch(dataDir: string): Promise<StoredSearch | null> {
  return await withStore(dataDir, null as StoredSearch | null, (store) => {
    const row = store.get(STORE_SQL.latestDeliberate, []);
    return row === null ? null : rowToSearch(row);
  });
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
