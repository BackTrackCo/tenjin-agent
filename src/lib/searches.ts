import { z } from 'zod';
import { setFact } from '../hooks/facts';
import type { LoopDb } from '../hooks/store';
import { withLoopDb } from './loop-db';

/**
 * The CLI's own record of the searches it ran: one `searches` row per
 * `tenjin search`, on `loop.db`.
 *
 * It exists so `buy <resourceId>` can rebuild the payable read URL a candidate
 * carried (the read route is keyed by handle/slug, so an id alone cannot build
 * one), so `outcome --search-id` and a `--search-id` publish can echo the
 * question they are closing and route the close to the shelf that minted the id,
 * and so the turn-end ask can name a miss nothing has closed. NOT an entitlement
 * record — that is the library receipt.
 *
 * BEST-EFFORT, EVERY READ AND EVERY WRITE. This is bookkeeping behind a verb the
 * agent actually asked for: a store that will not open costs a stale reminder,
 * never the publish that already landed or the search that was already paid for.
 * So each function names the answer it gives when the file cannot be read, and
 * `markSearchResolved` reports which of those happened rather than claiming a
 * close it did not make.
 */

const StoredCandidateSchema = z.object({
  resourceId: z.string(),
  url: z.string(),
  title: z.string(),
  price: z.string(),
});
export type StoredCandidate = z.infer<typeof StoredCandidateSchema>;

/**
 * What closed an open loop: `outcome` (the loop was reported) or `publish` (the
 * answer went back to the marketplace). Either one stops the ask naming it.
 */
export const SearchResolutionSchema = z.enum(['outcome', 'publish']);
export type SearchResolution = z.infer<typeof SearchResolutionSchema>;

/**
 * Who ran the search. One writer, `tenjin search`, so one value: the agent
 * decided the question was worth looking up, which is what makes an unanswered
 * one worth naming back. The hooks' own lookups are the daemon's and live in
 * `fires`/`legs`, so they never reach this table.
 */
export const SearchSourceSchema = z.enum(['cli']);
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
  source?: SearchSource;
  /**
   * The WORKER inside the session: the subagent the search was run in, absent
   * for the main session. A session is not a worker — parallel subagents all
   * file under their parent's `session_id`, so a search attributed to the
   * session alone belongs to every agent in it at once.
   */
  agentId?: string;
  /**
   * WHICH SHELF ANSWERED, as a base URL. A team-mode search asks the team shelf
   * and falls through to `publicShelfUrl`, and the two shelves have separate
   * databases: a searchId minted by one means nothing to the other. Without this
   * field every close — `tenjin outcome`, and the `--search-id` publish sends
   * with the piece — goes to the configured `baseUrl`, so the ordinary team-miss
   * / public-hit reports the public marketplace's search to the team shelf,
   * where it inflates `outcomes_dropped_no_parent`, while the shelf that served
   * the search hears nothing and its demand loop stays open.
   *
   * Absent means `baseUrl`, which is what a single-shelf public-mode run means.
   * Stored as the URL rather than as `team`/`public` so a re-pointed `baseUrl`
   * cannot silently re-label an old row's shelf.
   */
  shelfBaseUrl?: string;
  /**
   * The harness session this search was run in, when anything could attribute
   * it. This ledger is MACHINE-GLOBAL, so without it a turn-end ask names open
   * loops belonging to a sibling session, which that session cannot act on. A
   * row nothing stamped stays reachable from every session rather than none.
   */
  sessionId?: string;
  /**
   * The DRAFT this search's claim is parked on. A `publish --draft --search-id`
   * withholds the claim from the wire (a draft answers nobody) and records the
   * created post id here instead, so `edit --status published` can send the
   * claim when the draft actually goes public. Stored as a `facts` row under
   * `draft-search:<searchId>`, not a `searches` column, so the link can be
   * written and read without touching the row the server's fields own.
   */
  draftPostId?: string;
  /**
   * How many of the search's browse pointers cost money, and NOT the pointers
   * themselves: keeping those out of the store is what makes `buy <resourceId>`
   * unable to reach one, and a count cannot undo that. It exists so `outcome`
   * can tell "this search offered nothing to buy" from "this search offered a
   * payable browse tail", which the candidates array alone cannot say. Absent
   * reads as unknown, never as zero.
   */
  paidBrowseCount?: number;
}

/**
 * How many rows the unkeyed reads look at, newest first: what a bare
 * {@link loadSearches} returns, and how deep {@link SQL.searchForResource} scans
 * for the search a resource came out of.
 *
 * The table never prunes, so the callers that want "the recent searches" get a
 * bound here instead of one baked into the storage. Every one of them is
 * answering a question about the last few days; the ones that need a specific
 * row ask for it by id.
 */
const RECENT_LIMIT = 500;

/** Where a draft link lives: a `facts` row keyed `draft-search:<searchId>`.
 *  ⚠ MIRRORED as a literal inside {@link SQL.listSearches} and
 *  {@link SQL.searchesForDraft}, which match it in SQL. */
const DRAFT_LINK_PREFIX = 'draft-search:';

const SQL = {
  record: `INSERT INTO searches (
       search_id, at, session, agent_id, question, fingerprint, decision, candidates,
       source, shelf_base_url, paid_browse_count
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(search_id) DO UPDATE SET
       at = excluded.at, session = excluded.session, question = excluded.question,
       fingerprint = excluded.fingerprint, decision = excluded.decision,
       candidates = excluded.candidates, source = excluded.source,
       shelf_base_url = excluded.shelf_base_url,
       agent_id = COALESCE(excluded.agent_id, searches.agent_id),
       paid_browse_count = COALESCE(excluded.paid_browse_count, searches.paid_browse_count)`,
  /** Newest first. `rowid` breaks a tie so two rows stamped the same millisecond
   *  come back write-order-newest-first. The LEFT JOIN carries the draft a
   *  parked claim rides on, matched as SQL text so the value is the raw post id
   *  and never a JSON-quoted one. */
  listSearches: `SELECT s.*, f.value AS draft_post_id FROM searches s
     LEFT JOIN facts f ON f.key = 'draft-search:' || s.search_id
     ORDER BY s.at DESC, s.rowid DESC LIMIT ?`,
  /** The searches whose claims are parked on this draft, newest first. */
  searchesForDraft: `SELECT s.* FROM searches s
     JOIN facts f ON f.key = 'draft-search:' || s.search_id
     WHERE f.value = ? ORDER BY s.at DESC, s.rowid DESC`,
  /** COLLATE NOCASE because a caller case-folds every id before looking one up
   *  while the row carries whatever spelling the server sent. Ids are uuids, so
   *  nothing else can collide under it. */
  getSearch: 'SELECT * FROM searches WHERE search_id = ? COLLATE NOCASE',
  /** The SAME predicate {@link SQL.getSearch} carries, and it has to be: a
   *  lookup that finds the row followed by an update that matches nothing
   *  reports a close that never happened. */
  resolveSearch: `UPDATE searches SET resolved_by = ?, resolved_at = ?
     WHERE search_id = ? COLLATE NOCASE`,
  /**
   * The newest search that surfaced one resource, by id or by url.
   *
   * The candidate blob is JSON, so `json_each` asks the question in SQL rather
   * than pulling 500 rows into JS and scanning their arrays.
   *
   * BOUNDED BY ROW COUNT, NOT BY AGE, because `json_each` is a scan and the
   * table never prunes. A hit stops at the first row; a MISS — a resource no
   * local search surfaced, which is every `buy <id>` typed from outside a search
   * — expands every row the subquery hands over, and the `LIMIT` inside it is
   * what keeps that proportional to recent activity rather than to the machine's
   * whole history. A date floor would be wrong: `buy <resourceId>` resolves the
   * payable URL out of whichever search surfaced the piece, and an agent may buy
   * weeks after reading that search.
   */
  searchForResource: `SELECT s.search_id, c.value AS candidate
     FROM (SELECT rowid, search_id, at, candidates FROM searches
             ORDER BY at DESC, rowid DESC LIMIT ?) s, json_each(s.candidates) c
     WHERE json_extract(c.value, '$.resourceId') = ? OR json_extract(c.value, '$.url') = ?
     ORDER BY s.at DESC, s.rowid DESC LIMIT 1`,
  /** Every unresolved row a session may still close, newest first. '' scopes to
   *  every session; a named one keeps the unstamped rows, which belong nowhere
   *  and so stay reachable everywhere. Bounded like {@link SQL.listSearches}. */
  openSearches: `SELECT * FROM searches
     WHERE resolved_by IS NULL AND (? = '' OR session = ? OR session = '')
     ORDER BY at DESC, rowid DESC LIMIT ?`,
} as const;

type Row = Record<string, unknown>;

function all(db: LoopDb, sql: string, params: Array<string | number | null>): Row[] {
  return db.prepare(sql).all(...params) as unknown as Row[];
}

function get(db: LoopDb, sql: string, params: Array<string | number | null>): Row | null {
  return (db.prepare(sql).get(...params) as Row | undefined) ?? null;
}

/** The '' bucket a row naming no session falls into, so the scoped read can
 *  compare it in SQL rather than reason about NULL. */
function searchSession(sessionId: string | null | undefined): string {
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : '';
}

/** NULL is the main session and never '': the opposite rule from the session
 *  column, because a subagent id is absent rather than empty. */
function searchAgent(agentId: string | null | undefined): string | null {
  return typeof agentId === 'string' && agentId.length > 0 ? agentId : null;
}

/** The question reduced to what makes two asks the same one. */
export function searchFingerprint(question: string): string {
  return question.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 512);
}

/**
 * ONE SPELLING for the draft link's post id, on the way in and on the way out.
 * The link is matched as SQL text under SQLite's BINARY collation while the
 * command edge takes a post id in either case, so an uppercase
 * `edit 0197AAAA-… --status published` would find no parked claim and drop the
 * attribution behind a successful receipt. Postgres stores `uuid` lowercased
 * anyway.
 */
function foldPostId(postId: string): string {
  return postId.toLowerCase();
}

function rowToSearch(row: Row): StoredSearch | null {
  const searchId = typeof row.search_id === 'string' ? row.search_id : '';
  if (searchId.length === 0) return null;
  let candidates: StoredCandidate[] = [];
  if (typeof row.candidates === 'string') {
    try {
      const parsed = StoredCandidateSchema.array().safeParse(JSON.parse(row.candidates));
      if (parsed.success) candidates = parsed.data;
    } catch {
      // A row whose candidate blob will not parse still has a usable searchId,
      // question and decision — which is what the turn-end reminder needs.
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
    // SURFACED so a round trip cannot blank it: `recordSearch` re-records a row
    // it was handed, and a caller that read this one back has to be able to hand
    // the stamp straight back.
    ...(typeof row.agent_id === 'string' && row.agent_id.length > 0
      ? { agentId: row.agent_id }
      : {}),
    ...(typeof row.draft_post_id === 'string' && row.draft_post_id.length > 0
      ? { draftPostId: row.draft_post_id }
      : {}),
    ...(typeof row.paid_browse_count === 'number'
      ? { paidBrowseCount: row.paid_browse_count }
      : {}),
  };
}

/** Open, run `fn`, close, and answer `fallback` when any of that fails: the
 *  best-effort posture the file comment describes, in one place. */
function withSearches<T>(dataDir: string, fallback: T, fn: (db: LoopDb) => T): T {
  try {
    return withLoopDb(dataDir, fn);
  } catch {
    return fallback;
  }
}

function collect(rows: Row[]): StoredSearch[] {
  const out: StoredSearch[] = [];
  for (const row of rows) {
    const entry = rowToSearch(row);
    if (entry !== null) out.push(entry);
  }
  return out;
}

/** The most recent searches, newest first. */
export async function loadSearches(dataDir: string): Promise<StoredSearch[]> {
  return withSearches(dataDir, [] as StoredSearch[], (db) =>
    collect(all(db, SQL.listSearches, [RECENT_LIMIT])),
  );
}

/** One search by id, case-insensitively (see {@link SQL.getSearch}). */
export async function getStoredSearch(
  dataDir: string,
  searchId: string,
): Promise<StoredSearch | null> {
  return withSearches(dataDir, null as StoredSearch | null, (db) => {
    const row = get(db, SQL.getSearch, [searchId]);
    return row === null ? null : rowToSearch(row);
  });
}

/**
 * Unresolved searches a session may still close, newest first. SCOPED WHEN
 * KNOWN, GLOBAL WHEN NOT: an empty or absent `sessionId` means every session,
 * and a named one still keeps the rows nothing stamped, because those belong to
 * no session — scoping must never make a loop unreachable everywhere at once.
 */
export async function openSearches(dataDir: string, sessionId?: string): Promise<StoredSearch[]> {
  const scope = searchSession(sessionId);
  return withSearches(dataDir, [] as StoredSearch[], (db) =>
    collect(all(db, SQL.openSearches, [scope, scope, RECENT_LIMIT])),
  );
}

/** Record a search, replacing any row already under that id. */
export async function recordSearch(dataDir: string, entry: StoredSearch): Promise<void> {
  withSearches(dataDir, undefined, (db) => {
    const at = Date.parse(entry.at);
    db.prepare(SQL.record).run(
      entry.searchId,
      Number.isFinite(at) ? at : Date.now(),
      searchSession(entry.sessionId),
      searchAgent(entry.agentId),
      entry.question,
      searchFingerprint(entry.question),
      entry.decision,
      JSON.stringify(entry.candidates),
      entry.source ?? null,
      entry.shelfBaseUrl ?? null,
      entry.paidBrowseCount ?? null,
    );
    // A caller that already knows who closed the loop (a re-record, a fixture)
    // says so here rather than needing a second call: the upsert above leaves
    // `resolved_by` alone precisely so an ordinary re-record cannot reopen a
    // loop something already closed.
    if (entry.resolved !== undefined) {
      db.prepare(SQL.resolveSearch).run(entry.resolved.by, entry.resolved.at, entry.searchId);
    }
    // Same posture as `resolved`: a caller that already knows the draft this
    // claim is parked on writes the link in one call.
    if (entry.draftPostId !== undefined) {
      setFact(db, DRAFT_LINK_PREFIX + entry.searchId, foldPostId(entry.draftPostId), Date.now());
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
   * answered that question (tenjin-agent#161). A close is a report of intent at
   * a moment; a publish is the answer arriving, and the answer wins.
   */
  relink?: boolean;
}

/**
 * Record that something closed the loop on `searchId`. Best-effort and it NEVER
 * throws: an unknown id (a search from another machine) writes nothing, and a
 * failure to persist costs one stale reminder rather than the command the caller
 * actually ran. The FIRST resolution wins unless the caller asks to
 * {@link MarkResolvedOptions.relink}, so an ordinary `outcome` after a publish
 * still does not rewrite who closed it.
 */
export async function markSearchResolved(
  dataDir: string,
  searchId: string,
  by: SearchResolution,
  at: string = new Date().toISOString(),
  options: MarkResolvedOptions = {},
): Promise<ResolutionOutcome> {
  return withSearches(dataDir, 'failed' as ResolutionOutcome, (db) => {
    const row = get(db, SQL.getSearch, [searchId]);
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
    db.prepare(SQL.resolveSearch).run(by, at, searchId);
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
  withSearches(dataDir, undefined, (db) => {
    const at = Date.now();
    for (const searchId of new Set(searchIds)) {
      // A link to a row this ledger never recorded would never be read back:
      // `searchesForDraft` joins on the searches table.
      const row = get(db, SQL.getSearch, [searchId]);
      if (row === null) continue;
      // Keyed on the STORED spelling, not the caller's: the lookup above is
      // case-insensitive while the join that reads the link back concatenates
      // `s.search_id` under BINARY collation, so a caller's differently-cased id
      // would park the claim on a key nothing joins to.
      const stored = typeof row.search_id === 'string' ? row.search_id : searchId;
      setFact(db, DRAFT_LINK_PREFIX + stored, parkedOn, at);
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
  return withSearches(dataDir, [] as StoredSearch[], (db) =>
    // The join proved the link, so the row carries it even though the SELECT
    // does not: `s.*` has no draft_post_id column to alias.
    collect(all(db, SQL.searchesForDraft, [parkedOn])).map((entry) => ({
      ...entry,
      draftPostId: parkedOn,
    })),
  );
}

/** The stored candidate for a resourceId across recent searches (newest first). */
export async function findStoredCandidate(
  dataDir: string,
  resourceId: string,
): Promise<StoredCandidate | null> {
  return withSearches(dataDir, null as StoredCandidate | null, (db) => {
    const row = get(db, SQL.searchForResource, [RECENT_LIMIT, resourceId, '']);
    if (row === null || typeof row.candidate !== 'string') return null;
    try {
      const parsed = StoredCandidateSchema.safeParse(JSON.parse(row.candidate));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  });
}

/** The most recent searchId that surfaced this resource (by id or url), for
 *  purchase attribution (`X-Tenjin-Search-Id`). Null when no local search did. */
export async function findSearchForResource(
  dataDir: string,
  match: { resourceId?: string; url?: string },
): Promise<string | null> {
  return withSearches(dataDir, null as string | null, (db) => {
    const row = get(db, SQL.searchForResource, [
      RECENT_LIMIT,
      match.resourceId ?? '',
      match.url ?? '',
    ]);
    return row !== null && typeof row.search_id === 'string' ? row.search_id : null;
  });
}
