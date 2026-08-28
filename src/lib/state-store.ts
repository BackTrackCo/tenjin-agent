import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * The sidecar's local state: one SQLite file under the data dir, opened by the
 * CLI and by every generated hook script (tenjin-agent#209, plan
 * `tenjin-notes/plans/sidecar/03-state-store-plan.md`).
 *
 * WHY A DATABASE AND NOT MORE FILES. The hooks have no daemon: each event spawns
 * a node process that reads config, maybe asks a shelf, writes state and exits.
 * Shared state used to be nine files, each script doing its own
 * read-modify-write, and the three things that cost real noise all came from
 * that split — no "already shown" set spanning the push arms and the hint path
 * (one note injected six times in one session), no row that can be UPDATED (the
 * judge in #210 writes an outcome onto an injection), and no query that reaches
 * past a 256 KB tail (`tenjin push status` reported a floor).
 *
 * WHAT LIVES HERE: session working state and hook telemetry the server cannot
 * see — `events` (every fire), `injections` (what was shown, or would have
 * been), `sessions`, `session_state`, `searches`, and the unpublished error→fix
 * `pairings` the failure hook opens and closes locally. Knowledge itself lives
 * on a shelf; this file holds keys and telemetry only
 * (`04-knowledge-architecture.md`, "Three shelves").
 *
 * FAIL-OPEN IS THE WHOLE CONTRACT. {@link openStore} is called inside `main()`,
 * never at module scope, and it returns `null` for every failure there is: an
 * old Node whose `node:sqlite` import throws, an unwritable data dir, a corrupt
 * file, a busy database. Every helper no-ops on a null store, so a hook without
 * one behaves exactly like a hook whose lookup missed: exit 0, nothing on
 * stdout, one line on stderr.
 *
 * ONE SOURCE OF TRUTH FOR THE SQL. The generated `.mjs` hooks import nothing but
 * node builtins, so they cannot import this module — they get {@link
 * storeSource}, which bakes {@link STORE_DDL} and {@link STORE_SQL} into a
 * dependency-free copy of the same helpers. The schema and every statement are
 * interpolated from the constants below rather than restated, and
 * `state-store.test.ts` asserts the generated source carries them verbatim, so a
 * column renamed here cannot leave a hook reading a column that no longer
 * exists.
 */

/** The database, and the two files SQLite keeps beside it in WAL mode. */
export const STATE_DB_FILE = 'state.db';
export const STATE_DB_SIDECAR_FILES = [`${STATE_DB_FILE}-wal`, `${STATE_DB_FILE}-shm`] as const;

export function stateDbPath(dir: string): string {
  return join(dir, STATE_DB_FILE);
}

/**
 * The schema version this build creates and expects. The schema step runs
 * exactly once, inside one `BEGIN IMMEDIATE`, gated on `PRAGMA user_version`: a
 * second process racing the first blocks on the transaction, then reads the new
 * version and skips.
 *
 * VERSION 2 ADDS `agent` TO `searches` AND `pairing_closes`. Parallel subagents
 * share their parent's `session_id`, so a close or a search stamped with the
 * session alone belongs to every worker in it at once — which let a sibling's
 * close complete another agent's `error-edit-resolved` in the importance-score
 * report. See {@link STORE_MIGRATIONS} for the step, and note that a fresh file
 * is CREATED at this shape by {@link STORE_DDL} rather than migrated up to it.
 */
export const STORE_USER_VERSION = 2;

/**
 * How long a colliding writer waits before giving up, in ms.
 *
 * SET FIRST, BEFORE `journal_mode`. Probed 2026-08-25: eight processes writing a
 * fresh database with `journal_mode=wal` set first killed one of them at that
 * pragma with `ERR_SQLITE_ERROR: database is locked` — exit 1 and a stack trace
 * on stderr, which is exactly what Claude Code shows the operator. With
 * `busy_timeout` first, 3/3 runs completed with zero BUSY. The `timeout`
 * constructor option would do the same job but is 22.16+, so it is the pragma.
 *
 * FIRST, BUT IT DOES NOT COVER THE PRAGMA IT PRECEDES. Ordering fixed the
 * common case; #246 was the rest of it. `PRAGMA journal_mode = wal` against a
 * connection that holds a pending WRITE lock throws `database is locked` after
 * 0 ms — the busy handler is not consulted for that lock at all — so no value
 * here, raised or not, protects the WAL switch. That statement gets a retry
 * instead of a wait; see `setWal`.
 */
export const STORE_BUSY_TIMEOUT_MS = 250;

/**
 * The wait for the ONE-TIME schema transaction, and how many times it is tried.
 *
 * The tier is a property of the STATEMENT, not of the caller: this is what
 * `BEGIN IMMEDIATE` and the DDL it wraps run under, and nothing else. The other
 * cold-start statement, the WAL switch, cannot use a timeout at all and is
 * handled its own way (`setWal`).
 *
 * 250 ms is sized for a steady-state write: sub-millisecond inserts queueing
 * behind each other, inside every arm's budget. The cold start is a different
 * shape — a burst of hooks meeting an empty database all take `BEGIN IMMEDIATE`
 * at once, and the winner holds the write lock for the whole DDL while the rest
 * queue. Measured on this machine, the plan's own 8-process case tripped that
 * ceiling about one run in six: the loser printed
 * `tenjin: state store unavailable (database is locked)` to stderr, which Claude
 * Code shows the operator, and lost its state for that fire.
 *
 * So the bootstrap gets its own, longer wait, and it is put back immediately
 * afterwards so no ordinary fire ever inherits it. This is a once-per-machine
 * cost (the gate is `user_version < 1`).
 *
 * WHAT THE WAL SWITCH ADDS TO THE BUDGET, AND WHEN. In the case that matters —
 * another opener holding the write lock through its DDL — both of its attempts
 * are decided instantly: a 0 ms throw before the bootstrap and a 1 ms no-op
 * after it, which is the whole reason the retry sits after rather than before.
 * A long-lived READER is the only thing that makes it wait, and then it waits
 * the steady-state 250 ms, at most twice. So the arithmetic ceiling for the
 * cold start is 250 + 500 x 2 + 250 = 1500 ms, which is the watchdog exactly;
 * it needs a reader to hold on across both attempts AND the bootstrap to lose
 * both of its own. Raise any of the three and that stops being an argument.
 *
 * THE BUDGET IS THE PRODUCT, NOT THE TIMEOUT, and the ceiling is 1500 ms, not
 * 2700. `DatabaseSync` is synchronous, so a `busy_timeout` wait blocks the
 * event loop and the watchdog timer — which "fires only when the loop is free"
 * (lib/hook-scripts.ts) — cannot preempt it. The real limit is therefore the
 * tightest watchdog among the scripts that embed the store, and both the Stop
 * hook and the SessionStart primer run on 1500 ms. 500 × 2 = 1000 ms worst
 * case leaves room for the rest of the fire; the first cut said 1000 × 3 and
 * claimed it fit under 2700, which was wrong twice over.
 */
export const STORE_BOOTSTRAP_TIMEOUT_MS = 500;
export const STORE_BOOTSTRAP_TRIES = 2;

/**
 * The whole schema, run once at `user_version = 0`.
 *
 * Rules that keep it cheap to extend: JSON `data`/`value` columns carry
 * arm-specific extras, only indexed or filtered columns are typed, and
 * `uid`/`machine`/`synced_at` exist now and stay unused — retrofitting ids onto
 * rows a team sync has to key on is the migration that hurts, so they are here
 * from the start. `project` is a hash of the cwd and `machine` a hash of
 * hostname + user, both stamped at fire time.
 *
 * `session` is `NOT NULL` and a payload that names no session writes `''`: a
 * null session is a BUCKET, not an exemption, and treating it as "no rows"
 * zeroed every per-session bound at once.
 */
export const STORE_DDL = `
CREATE TABLE IF NOT EXISTS sessions (
  session TEXT PRIMARY KEY,
  project TEXT,
  cwd TEXT,
  started_at INTEGER,
  ended_at INTEGER,
  machine TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  uid TEXT NOT NULL UNIQUE,
  at INTEGER NOT NULL,
  session TEXT NOT NULL,
  project TEXT,
  machine TEXT NOT NULL,
  hook TEXT NOT NULL,
  tool TEXT,
  error_hash TEXT,
  files TEXT,
  data TEXT
);
CREATE INDEX IF NOT EXISTS events_session_at ON events(session, at);
CREATE INDEX IF NOT EXISTS events_error ON events(error_hash) WHERE error_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS injections (
  id INTEGER PRIMARY KEY,
  uid TEXT NOT NULL UNIQUE,
  event_uid TEXT,
  at INTEGER NOT NULL,
  session TEXT NOT NULL,
  project TEXT,
  machine TEXT NOT NULL,
  hook TEXT NOT NULL,
  shelf TEXT NOT NULL,
  resource_id TEXT,
  title TEXT,
  url TEXT,
  price TEXT,
  search_id TEXT,
  score REAL,
  second REAL,
  strength TEXT,
  confidence TEXT,
  corroborated INTEGER,
  action TEXT NOT NULL,
  reason TEXT,
  form TEXT,
  deny INTEGER DEFAULT 0,
  tokens INTEGER,
  outcome TEXT,
  outcome_at INTEGER,
  outcome_by TEXT,
  synced_at INTEGER
);
-- ONCE PER SESSION, ENFORCED BY THE DATABASE. The already-shown check used to be
-- a bare SELECT and the injected row a bare INSERT, with a body fetch in
-- between, so two concurrent fires for one session could both read "not shown"
-- and both inject: the bound was advisory. This index is what makes it a bound.
-- The second INSERT is refused, and the arm records the skip instead of
-- emitting. It serves the already-shown lookup too: same columns, same filter.
CREATE UNIQUE INDEX IF NOT EXISTS injections_shown_once
  ON injections(session, resource_id)
  WHERE action = 'injected' AND resource_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS injections_hook_at ON injections(hook, at);
-- The other two hot reads. failStreak runs on EVERY push fire before every
-- lookup and injectedCount on every injection decision, and both filter by
-- session; the only other index on this table is partial on resource_id, so
-- both fell back to a full SCAN that grew with a table nothing prunes
-- (measured ~7 ms at 200k rows, synchronous, inside a 1500 ms budget, with up
-- to 8 concurrent processes).
CREATE INDEX IF NOT EXISTS injections_session_at ON injections(session, at);
CREATE INDEX IF NOT EXISTS injections_session_action ON injections(session, action);
-- The push status tally reads a 7-day window. Not a hook path, so a scan there
-- costs a human a moment rather than a tool call its budget, but the table is
-- the one that never shrinks and this is one index.
CREATE INDEX IF NOT EXISTS injections_at ON injections(at);
CREATE INDEX IF NOT EXISTS injections_outcome ON injections(outcome) WHERE outcome IS NOT NULL;

CREATE TABLE IF NOT EXISTS session_state (
  session TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT,
  at INTEGER NOT NULL,
  PRIMARY KEY (session, key)
);

CREATE TABLE IF NOT EXISTS searches (
  search_id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  session TEXT NOT NULL,
  -- WHICH WORKER RAN IT, '' for the lead's own turn. A session is a
  -- conversation and an agent is a worker: parallel subagents all file under
  -- their parent's session id, so without this the importance-score report let
  -- one child's search complete a sibling's research-then-edit. '' is a BUCKET
  -- and not an exemption, exactly as it is for session; readers map it back to
  -- the null agent that events.data.agentId uses.
  agent TEXT NOT NULL DEFAULT '',
  question TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  decision TEXT NOT NULL,
  candidates TEXT NOT NULL,
  source TEXT,
  shelf_base_url TEXT,
  paid_browse_count INTEGER,
  resolved_by TEXT,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS searches_at ON searches(at);
CREATE INDEX IF NOT EXISTS searches_session_at ON searches(session, at);

CREATE TABLE IF NOT EXISTS pairings (
  id INTEGER PRIMARY KEY,
  uid TEXT NOT NULL UNIQUE,
  at INTEGER NOT NULL,
  session TEXT NOT NULL,
  project TEXT,
  machine TEXT NOT NULL,
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  coarse_key TEXT,
  cmd_head TEXT,
  cmd TEXT,
  error_line TEXT,
  error_files TEXT,
  fix_cmd TEXT,
  fix_files TEXT,
  pkg_versions TEXT,
  scope TEXT NOT NULL,
  status TEXT NOT NULL,
  closes INTEGER NOT NULL DEFAULT 0,
  closed_at INTEGER,
  synced_at INTEGER
);
-- WHO CLOSED A PAIRING, one row per closer. 04's rule is "two INDEPENDENT
-- closes -> verified", and independence has to be enforced rather than trusted:
-- with a bare counter the same session could close twice and self-promote. The
-- primary key is the enforcement, so a repeat close from the same session is an
-- INSERT OR IGNORE that changes nothing, and pairings.closes is recomputed from
-- a COUNT rather than incremented.
--
-- THE AGENT IS RECORDED, AND IT IS NOT PART OF THE KEY. Which worker closed a
-- pairing is what the importance-score report needs, so it is stored; but the
-- independence the primary key enforces is about MACHINES AND SESSIONS, not
-- about workers. Two subagents of one conversation are one laptop running one
-- checkout, so letting them be two closers would hand a pairing the promotion
-- to 'verified' that 04 reserves for two independent observations.
CREATE TABLE IF NOT EXISTS pairing_closes (
  pairing_id INTEGER NOT NULL,
  session TEXT NOT NULL,
  agent TEXT NOT NULL DEFAULT '',
  at INTEGER NOT NULL,
  fix_cmd TEXT,
  fix_files TEXT,
  scope TEXT,
  PRIMARY KEY (pairing_id, session)
);

CREATE INDEX IF NOT EXISTS pairings_key_status ON pairings(key, status);
CREATE INDEX IF NOT EXISTS pairings_coarse_status ON pairings(coarse_key, status);
CREATE INDEX IF NOT EXISTS pairings_open_head ON pairings(cmd_head, at) WHERE status = 'open';
`;

/**
 * The steps that bring an EXISTING file up to {@link STORE_USER_VERSION}.
 *
 * INDEXED BY THE VERSION THEY LEAVE BEHIND: `STORE_MIGRATIONS[n]` is what a
 * database sitting at exactly version `n` runs to reach `n + 1`. Slot 0 is
 * empty and never executed — version 0 is not migrated, it is CREATED, and
 * {@link STORE_DDL} creates it at the CURRENT shape rather than at v1, so a
 * fresh file skips every step here.
 *
 * ⚠ `ALTER TABLE ... ADD COLUMN` IS NOT IDEMPOTENT. `STORE_DDL` is all
 * `IF NOT EXISTS`, so running it twice was harmless and the bootstrap could
 * afford to be sloppy about it; a second run of one of these throws
 * `duplicate column name`. That is why the version is re-read INSIDE the
 * transaction and the branch is exclusive: exactly one of "create" and
 * "migrate" runs, and only when the version says so.
 */
export const STORE_MIGRATIONS: readonly string[] = [
  '',
  // 1 -> 2: who ran the search, and who closed the pairing. Backfilled to '',
  // the lead's own bucket, which is where every row written before this landed.
  `ALTER TABLE searches ADD COLUMN agent TEXT NOT NULL DEFAULT '';
ALTER TABLE pairing_closes ADD COLUMN agent TEXT NOT NULL DEFAULT '';`,
];

/**
 * Every statement either side runs, by name.
 *
 * ⚠ THE ONE COPY. The TS helpers below and the generated hook source both read
 * these strings — the hooks because {@link storeSource} interpolates the whole
 * object as a JSON literal. Add a statement here, not in either consumer.
 */
export const STORE_SQL = {
  userVersion: 'PRAGMA user_version',
  setUserVersion: `PRAGMA user_version = ${STORE_USER_VERSION}`,

  touchSession: `INSERT INTO sessions (session, project, cwd, started_at, machine)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(session) DO UPDATE SET
       project = COALESCE(excluded.project, sessions.project),
       cwd = COALESCE(excluded.cwd, sessions.cwd)`,
  endSession: `INSERT INTO sessions (session, project, cwd, started_at, ended_at, machine)
     VALUES (?, NULL, NULL, ?, ?, ?)
     ON CONFLICT(session) DO UPDATE SET ended_at = excluded.ended_at`,

  insertEvent: `INSERT INTO events (uid, at, session, project, machine, hook, tool, error_hash, files, data)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,

  insertInjection: `INSERT INTO injections (
       uid, event_uid, at, session, project, machine, hook, shelf,
       resource_id, title, url, price,
       search_id, score, second, strength, confidence, corroborated,
       action, reason, form, deny, tokens
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,

  /**
   * The 6× fix: one already-shown set for every hook, keyed by session and by
   * whatever identifies the piece — `candidate.resourceId` for a marketplace
   * piece, `candidate.id` for a note. Not filtered by hook on purpose; that is
   * the point of it.
   */
  alreadyShown: `SELECT 1 FROM injections
     WHERE session = ? AND resource_id = ? AND action = 'injected' LIMIT 1`,
  injectedCount: `SELECT COUNT(*) AS n FROM injections WHERE session = ? AND action = 'injected'`,

  /**
   * This arm's machine-wide lookup count for the current window.
   *
   * A LOOKUP IS AN ATTEMPT, NOT AN ANSWER: counting only rows that carry a
   * search_id made a FAILING lookup free, so during an outage the counter stayed
   * at zero while every attempt burned the full fetch timeout in front of a tool
   * call. `no-answer` rows count too.
   */
  bucketCount: `SELECT COUNT(*) AS n FROM injections
     WHERE hook = ? AND at >= ? AND (search_id IS NOT NULL OR reason = 'no-answer')`,
  /** The trailing run of unanswered lookups for one session, newest first. */
  recentReasons: `SELECT reason, at FROM injections
     WHERE session = ? ORDER BY at DESC LIMIT ?`,

  getState: 'SELECT value FROM session_state WHERE session = ? AND key = ?',
  /** Per key, so two arms touching different keys of one session never clobber
   *  each other — which the whole-file JSON write did. */
  setState: `INSERT INTO session_state (session, key, value, at) VALUES (?, ?, ?, ?)
     ON CONFLICT(session, key) DO UPDATE SET value = excluded.value, at = excluded.at`,
  deleteState: 'DELETE FROM session_state WHERE session = ? AND key = ?',
  /**
   * Claim one key for this session, atomically. `DO NOTHING` plus
   * `changes()` is the whole point: the read-modify-write these replaced
   * ("is this signature already seen? then add it to the list") had a window
   * two concurrent hook processes both passed, so one failure opened two
   * pairings and spent two lookups.
   */
  claimState: `INSERT INTO session_state (session, key, value, at) VALUES (?, ?, ?, ?)
     ON CONFLICT(session, key) DO NOTHING`,
  /** Rows under one key prefix, newest first. Used for the per-agent, per-path
   *  `edited:<agent>:<path>` rows the close rule reads. */
  statePrefixSince: `SELECT key, value, at FROM session_state
     WHERE session = ? AND key >= ? AND key < ? AND at >= ? ORDER BY at DESC LIMIT ?`,
  countStatePrefix: `SELECT COUNT(*) AS n FROM session_state
     WHERE session = ? AND key >= ? AND key < ?`,
  /**
   * Bump a counter key and hand back the new value, in one statement. The churn
   * arm's "Nth edit to this file" was a whole-map read-modify-write, so two
   * concurrent edit hooks could both read N and both write N+1.
   */
  bumpState: `INSERT INTO session_state (session, key, value, at) VALUES (?, ?, '1', ?)
     ON CONFLICT(session, key)
     DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT), at = excluded.at
     RETURNING value`,

  /**
   * THE ONE THING `openStore` RECORDS ABOUT ITSELF.
   *
   * `PRAGMA journal_mode = wal` is the single statement in this module the busy
   * timeout does not cover (see the probe in `setWal`), so a machine where BOTH
   * attempts fail runs on for good against a rollback journal: correct, but
   * serialised, and until this row completely silent — no error, no stderr, no
   * field anywhere. A store that has quietly stopped being concurrent looks
   * from the outside exactly like one that was never contended, which is the
   * same argument that put the `node:sqlite` probe in `doctor` (#219).
   *
   * MACHINE BUCKET, RAW VALUE. Session '', key `store_journal`, value the bare
   * word `rollback` or `wal` — NOT JSON, like the `draft-search:` link and
   * unlike everything written through `setState`, because `openStore` writes it
   * before the store handle those helpers need exists, and `doctor` reads it
   * back as SQL text.
   */
  setStoreJournal: `INSERT INTO session_state (session, key, value, at)
     VALUES ('', 'store_journal', ?, ?)
     ON CONFLICT(session, key) DO UPDATE SET value = excluded.value, at = excluded.at`,
  /** The point lookup that keeps the healthy path free of writes; see
   *  `setStoreJournal` and `recordJournal`. Primary key, so it is one probe. */
  getStoreJournal: `SELECT value, at FROM session_state
     WHERE session = '' AND key = 'store_journal'`,

  recordSearch: `INSERT INTO searches (
       search_id, at, session, agent, question, fingerprint, decision, candidates,
       source, shelf_base_url, paid_browse_count
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(search_id) DO UPDATE SET
       at = excluded.at, session = excluded.session, agent = excluded.agent,
       question = excluded.question,
       fingerprint = excluded.fingerprint, decision = excluded.decision,
       candidates = excluded.candidates, source = excluded.source,
       shelf_base_url = excluded.shelf_base_url,
       paid_browse_count = COALESCE(excluded.paid_browse_count, searches.paid_browse_count)`,
  /** Newest first. `rowid` breaks a tie so two rows stamped the same
   *  millisecond come back write-order-newest-first, which is what "prepend"
   *  meant when this was a JSON array.
   *
   *  The LEFT JOIN carries the draft a parked claim rides on: a `session_state`
   *  row in the machine bucket under `draft-search:<searchId>`, value the RAW
   *  post id (matched by SQL, so never JSON-quoted). A key-value fact beside the
   *  `published:` records, not a `searches` column, because adding a column to a
   *  created table needs the versioned migration #212 introduces. */
  listSearches: `SELECT s.*, st.value AS draft_post_id FROM searches s
     LEFT JOIN session_state st
       ON st.session = '' AND st.key = 'draft-search:' || s.search_id
     ORDER BY s.at DESC, s.rowid DESC LIMIT ?`,
  /** The searches whose claims are parked on this draft (see `listSearches` on
   *  where the links live), newest first. */
  searchesForDraft: `SELECT s.* FROM searches s
     JOIN session_state st
       ON st.session = '' AND st.key = 'draft-search:' || s.search_id
     WHERE st.value = ? ORDER BY s.at DESC, s.rowid DESC`,
  /** COLLATE NOCASE because the ids that look a row up are case-folded first
   *  (`normalizeSearchIds`), while the row was written in whatever spelling the
   *  server sent. Ids are uuids, so nothing else can collide under it. */
  getSearch: 'SELECT * FROM searches WHERE search_id = ? COLLATE NOCASE',
  latestDeliberate: `SELECT * FROM searches
     WHERE source IS NULL OR source = 'cli' ORDER BY at DESC, rowid DESC LIMIT 1`,
  /** COLLATE NOCASE for the same reason {@link STORE_SQL.getSearch} carries it,
   *  and it has to be the SAME predicate: a lookup that finds the row followed
   *  by an update that matches nothing reports a close that never happened. */
  resolveSearch: `UPDATE searches SET resolved_by = ?, resolved_at = ?
     WHERE search_id = ? COLLATE NOCASE`,
  askedFingerprint: `SELECT 1 FROM searches
     WHERE session = ? AND fingerprint = ? LIMIT 1`,
  countBySource: `SELECT COUNT(*) AS n FROM searches
     WHERE session = ? AND source = ? AND at >= ?`,
  /**
   * MISSes nothing has closed, newest first, inside the window.
   *
   * FILTERED BEFORE THE LIMIT, not after. The Stop hook takes 25 rows and then
   * discards the sources it never nags about (`push-hook`, `dispatch-hook`) and
   * the sessions that are not its own — so with the push arms on, a machine that
   * writes a MISS row for every unanswered lookup pushed a deliberate
   * `tenjin search` MISS out of the 25 newest within the hour, and the loop it
   * exists to raise was never raised again. The file version was protected by
   * the demand budget that capped those sources at 15 of 50; the predicate here
   * is what replaces it.
   */
  openLoops: `SELECT * FROM searches
     WHERE decision = 'MISS' AND resolved_by IS NULL AND at >= ?
       AND (source IS NULL OR source IN ('cli', 'websearch-hook'))
       AND (? = '' OR session = ? OR session = '')
     ORDER BY at DESC, rowid DESC LIMIT ?`,
  /** Did this session ask for a search ITSELF? The push arms search on their own
   *  initiative, so their rows are not evidence the session researched anything
   *  — see the Stop hook's \`didResearch\`. */
  researchedBySession: `SELECT 1 FROM searches
     WHERE session = ? AND (source IS NULL OR source <> 'push-hook') LIMIT 1`,
  /**
   * The newest search that surfaced one resource, by id or by url.
   *
   * The candidate blob is JSON, so `json_each` asks the question in SQL rather
   * than pulling 500 rows into JS and scanning their arrays — which is what
   * \`buy <resourceId>\` and read attribution used to do on every call.
   *
   * BOUNDED BY ROW COUNT, not by age, because `json_each` is a scan and the
   * table never prunes. A hit stops at the first row; a MISS — a resource no
   * local search surfaced, which is every `buy <id>` typed from outside a
   * search — expands the candidate array of every row the subquery hands over.
   * The `LIMIT` inside it is what keeps that proportional to recent activity
   * rather than to the machine's whole history: the same {@link RECENT_LIMIT}
   * window {@link STORE_SQL.listSearches} reads, and the same window the
   * file-backed ledger this replaced kept on disk.
   *
   * A DATE FLOOR WOULD BE WRONG HERE. `tenjin buy <resourceId>` resolves the
   * payable URL out of whichever search surfaced the piece, and an agent may
   * buy weeks after reading the search that named it; a `s.at >= ?` cutoff
   * turned that into "No local search knows resource …" purely by the calendar.
   */
  searchForResource: `SELECT s.search_id, c.value AS candidate
     FROM (SELECT rowid, search_id, at, candidates FROM searches
             ORDER BY at DESC, rowid DESC LIMIT ?) s, json_each(s.candidates) c
     WHERE json_extract(c.value, '$.resourceId') = ? OR json_extract(c.value, '$.url') = ?
     ORDER BY s.at DESC, s.rowid DESC LIMIT 1`,
  /** Every unresolved row a session may still close, newest first. '' scopes to
   *  every session; a named one keeps the unstamped rows, which belong nowhere
   *  and so stay reachable everywhere. Bounded like {@link listSearches}: the
   *  table never prunes, and the caller renders a reminder, not a report. */
  openSearches: `SELECT * FROM searches
     WHERE resolved_by IS NULL AND (? = '' OR session = ? OR session = '')
     ORDER BY at DESC, rowid DESC LIMIT ?`,

  insertPairing: `INSERT INTO pairings (
       uid, at, session, project, machine, kind, key, coarse_key,
       cmd_head, cmd, error_line, error_files, pkg_versions, scope, status
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
  /**
   * A local match, best first: verified outranks unverified, then most recent.
   *
   * SCOPED TO THE PROJECT. 04's whole close rule is about a fix that changed a
   * file in the repo the failure happened in, so a pairing from a different
   * checkout on the same laptop is not an answer — it names files that do not
   * exist here. `IS` rather than `=` so a payload with no cwd matches the rows
   * written without one and nothing else.
   */
  findPairing: `SELECT * FROM pairings
     WHERE project IS ?
       AND (key = ? OR (coarse_key IS NOT NULL AND coarse_key = ?))
       AND status IN ('unverified', 'verified')
     ORDER BY CASE status WHEN 'verified' THEN 0 ELSE 1 END, closes DESC, at DESC
     LIMIT 1`,
  /** Pairings this success could be closing: same project, same command head,
   *  still open. Without the project predicate a passing `pnpm test` in one repo
   *  closed another repo's pairing and stamped it with a file that repo has
   *  never had. */
  openForHead: `SELECT * FROM pairings
     WHERE status = 'open' AND project IS ? AND cmd_head = ? AND at <= ?
     ORDER BY at DESC LIMIT ?`,
  /**
   * One replayed pairing, by id, so the session that was SHOWN it can close it
   * too — the second independent close 04 promotes to `verified`.
   *
   * PROJECT-SCOPED like every other pairing read. It was not, and that was the
   * worse half of the cross-project bug: this is the branch that reaches
   * `verified`, the status that injects as a fix rather than as a maybe, so a
   * session shown a pairing in one repo and succeeding in another did not just
   * add a weak row — it manufactured the confident one, stamped with a filename
   * the first repo has never had.
   */
  pairingById: 'SELECT * FROM pairings WHERE id = ? AND project IS ?',
  /** The same row without the project predicate, for reading back a pairing this
   *  process has just written by id. Never used to FIND one. */
  pairingByIdUnscoped: 'SELECT status FROM pairings WHERE id = ?',
  /** Claim a close for this session. OR IGNORE, so a session that closes the
   *  same pairing twice changes nothing: independence is the primary key's job,
   *  not the caller's — and the agent is recorded WITHOUT joining that key, so
   *  two subagents of one session still count as the one closer they are (see
   *  the DDL note on `pairing_closes`). */
  claimClose: `INSERT OR IGNORE INTO pairing_closes
       (pairing_id, session, agent, at, fix_cmd, fix_files, scope)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  /** Every closer, oldest first. The first one owns the pairing's scope, and
   *  the rest are only corroboration if their fix agrees with it. PER SESSION,
   *  deliberately: the agent column is report metadata, and reading it here
   *  would turn one session's two workers into two independent closers. */
  closersOf: `SELECT session, at, fix_cmd, fix_files, scope FROM pairing_closes
     WHERE pairing_id = ? ORDER BY at, session`,
  /**
   * Write back what the closers actually agree on.
   *
   * COMPUTED FROM THEM, NOT FROM THE LATEST ONE. The first cut counted rows and
   * kept the first closer's files with `COALESCE` while overwriting `scope`
   * from whoever closed last, so "Fixed here 2 time(s) by changing: <first
   * closer's files>" asserted a corroboration nobody had checked — the second
   * closer may have touched something else entirely. `closes` is now the number
   * of closers whose fix AGREES with the first, `fix_files` is what they have
   * in common, and `scope` belongs to the first closer.
   */
  syncPairing: `UPDATE pairings SET
       closes = ?,
       status = CASE WHEN ? >= 2 THEN 'verified' ELSE 'unverified' END,
       closed_at = ?,
       fix_cmd = ?,
       fix_files = ?,
       scope = ?
     WHERE id = ?`,

  /** `tenjin push status`, one pass over the window. */
  statusRows: `SELECT hook, shelf, action, reason, resource_id, deny, tokens
     FROM injections WHERE at >= ?`,
  /** `tenjin push status`, the pairings opened in the window, grouped the
   *  way the line reports them. `scope` is the FIRST closer's and stays
   *  `ambiguous` on an open row, so the scope counts are read off closed rows
   *  only. A scan of a table that grows by one row per distinct failure. */
  pairingsStatus: `SELECT status, scope, cmd_head, COUNT(*) AS n
     FROM pairings WHERE at >= ? GROUP BY status, scope, cmd_head`,

  /**
   * The closed, CODE-scoped pairings of one project that the team shelf has
   * not seen in their current state: never synced, or promoted to `verified`
   * by a close that landed AFTER the last sync (`closed_at` moves on every
   * close, `synced_at` on every sync, so the comparison is the whole test).
   * `user` and `ambiguous` rows never match: a fix that was somebody's laptop
   * does not travel. The Stop hook counts these to decide whether to spawn
   * `tenjin sync`; the command reads them. A scan of a table that grows by one
   * row per distinct failure, on the one hook whose budget is silent.
   */
  unsyncedPairings: `SELECT * FROM pairings
     WHERE project IS ? AND scope = 'code' AND status IN ('unverified', 'verified')
       AND (synced_at IS NULL OR (status = 'verified' AND closed_at > synced_at))
     ORDER BY at`,
  countUnsyncedPairings: `SELECT COUNT(*) AS n FROM pairings
     WHERE project IS ? AND scope = 'code' AND status IN ('unverified', 'verified')
       AND (synced_at IS NULL OR (status = 'verified' AND closed_at > synced_at))`,
  /** Stamp a pairing as synced (or as re-synced after a promotion). */
  markPairingSynced: 'UPDATE pairings SET synced_at = ? WHERE id = ?',
  /** What the last `tenjin sync` run reported, for the Stop hook's fallback line. */
  lastSyncEvent: `SELECT data FROM events WHERE hook = 'sync' ORDER BY at DESC, id DESC LIMIT 1`,
  /**
   * `tenjin push status --sessions`, the importance-score report (#212,
   * CommonTrace `detection.py`): every event row in the window in session
   * order, the closes the machine's sessions made, the searches they ran, the
   * sessions' own bounds, and the session_state families the score is compared
   * against — `capture_asked` (per session) and the publish marks
   * `published:<hash>` and `agent_published:<...>` (both machine-wide,
   * attributed to a session by time; the second is a CHILD's own publish, and
   * `LIKE 'published:%'` is anchored, so it needs naming separately). Report
   * queries: a window scan over tables that never prune, run by a human, never
   * by a hook.
   */
  scoreEvents: `SELECT session, at, hook, tool, error_hash, files, data
     FROM events WHERE at >= ? ORDER BY session, at, id`,
  /** The closes and the searches the report partitions BY WORKER, not by
   *  session: `agent` is '' for the lead's own turn and the child's id for a
   *  subagent's, which is the same partition `events.data.agentId` gives after
   *  the reader maps '' back to null. */
  scoreCloses: `SELECT session, agent, at FROM pairing_closes WHERE at >= ?`,
  scoreSearches: `SELECT session, agent, at FROM searches WHERE at >= ?`,
  scoreSessions: `SELECT session, started_at, ended_at FROM sessions
     WHERE started_at >= ? OR ended_at >= ?`,
  scoreState: `SELECT session, key, at FROM session_state
     WHERE (key = 'capture_asked' OR key LIKE 'published:%'
            OR key LIKE 'agent_published:%') AND at >= ?`,

  /** `tenjin push grade`: what was shown and never judged. */
  ungradedInjections: `SELECT uid, at, session, hook, shelf, resource_id, title, url, search_id, form
     FROM injections
     WHERE action = 'injected' AND outcome IS NULL AND at >= ? AND (? = '' OR session = ?)
     ORDER BY at, id`,
  /**
   * One INJECTED row by uid, for the hand verdict `--label` writes.
   *
   * `action = 'injected'` is the whole point of the predicate. Every decision an
   * arm makes writes a row — `skipped`, `capped`, `none` — and only the injected
   * ones were ever put in front of the agent. Without it, `--label <uid> used`
   * on a row the arm decided NOT to show would stamp an outcome on it and post
   * "the agent used this" to the shelf about a piece nobody ever saw.
   */
  injectionByUid: `SELECT uid, at, session, hook, shelf, resource_id, search_id, outcome, outcome_by, outcome_at
     FROM injections WHERE uid = ? AND action = 'injected'`,
  /** A verdict, and the posted stamp cleared with it: a re-labelled row is owed
   *  to the shelf again. */
  setOutcome: 'UPDATE injections SET outcome = ?, outcome_by = ?, outcome_at = NULL WHERE uid = ?',
  /**
   * Graded, never posted. `outcome_at` IS the posted stamp, so this is both the
   * queue and the idempotence: a post that failed keeps a NULL and is retried
   * next run, a post that landed is never sent twice. A `local` shelf row is a
   * pairing this machine replayed to itself and has no shelf to tell.
   *
   * `action = 'injected'` for the reason {@link injectionByUid} carries it: an
   * outcome is a report about a piece the agent was SHOWN, and a row the arm
   * decided against is not one. `url` comes along because it is what the post is
   * routed by — the shelf that minted the search id, not whatever this machine
   * is configured for today.
   */
  /** Bounded to the grading window (`at >= ?`): a row the shelf keeps refusing
   *  (rotated key, retired shelf) ages out of the queue with the window instead
   *  of being re-sent on every run forever.
   *  A hand label is exempt: the operator named that row by uid, so its verdict
   *  is owed to the shelf whatever its age.
   *  The LEFT JOIN carries the base URL of the shelf that minted the search id,
   *  which the injection row itself does not hold. It is CONFIG-DERIVED — the
   *  base the arm asked — where `injections.url` is a candidate url the shelf
   *  chose, so it is the only origin here a credential may be authorized at. */
  unpostedOutcomes: `SELECT i.uid, i.session, i.hook, i.shelf, i.url, i.resource_id, i.search_id,
       i.outcome, i.outcome_by, s.shelf_base_url
     FROM injections i
     LEFT JOIN searches s ON s.search_id = i.search_id
     WHERE i.action = 'injected' AND i.outcome IN ('used', 'rejected') AND i.outcome_at IS NULL
       AND i.search_id IS NOT NULL AND i.resource_id IS NOT NULL AND i.shelf <> 'local'
       AND (i.at >= ? OR i.outcome_by = 'hand')
     ORDER BY i.at, i.id`,
  markPosted: 'UPDATE injections SET outcome_at = ? WHERE uid = ?',
  sessionEnded: 'SELECT ended_at FROM sessions WHERE session = ?',
  /** `tenjin push status`, the graded rollup per hook x shelf. */
  gradeRows: `SELECT hook, shelf, outcome, outcome_at FROM injections
     WHERE action = 'injected' AND at >= ?`,
} as const;

export type StoreSqlKey = keyof typeof STORE_SQL;

/**
 * The store core as dependency-free JavaScript, for {@link storeSource} and for
 * the `state-store.test.ts` drift check.
 *
 * Written as plain JS in a `String.raw` block, in the style of `pushSource()`:
 * the generated hooks are `.mjs` files that import only node builtins, so this
 * is the only way the same helpers reach them. `__DDL__`, `__SQL__` and the
 * constants are substituted from the exports above, which is what keeps the
 * schema single-sourced even though the glue is written on both sides.
 *
 * It assumes the prelude's `DATA_DIR`, `join`, `mkdirSync`, `chmodSync` and
 * `isRecord`, and nothing else.
 */
const STORE_CORE_JS = String.raw`
// ---- state store (shared by every hook) ----
const STATE_DB_PATH = join(DATA_DIR, __DB_FILE__);
const STORE_SQL = __SQL__;
const STORE_DDL = __DDL__;
const STORE_MIGRATIONS = __MIGRATIONS__;
const STORE_USER_VERSION = __USER_VERSION__;
const STORE_BUSY_TIMEOUT_MS = __BUSY_TIMEOUT_MS__;
const STORE_BOOTSTRAP_TIMEOUT_MS = __BOOTSTRAP_TIMEOUT_MS__;
const STORE_BOOTSTRAP_TRIES = __BOOTSTRAP_TRIES__;

/**
 * The \`session_state\` keys, named once so a typo is a missing constant rather
 * than a silently empty read. They replace what used to be \`push/<session>.json\`
 * plus two families of marker file:
 *
 *  - \`edits\`/\`edited\`/\`packages\`/\`signatures\`/\`dispatch_cache\` were the
 *    per-session JSON blob, whose whole-file rewrite let two concurrent arms
 *    drop each other's unrelated keys.
 *  - \`capture_asked\` was \`push/capture-asked-<session>\`.
 *  - \`published:<hash>\` was \`push/published-<hash>\`, and is machine-wide, so it
 *    is stored under the '' session — the same bucket a payload naming no
 *    session falls into.
 */
const STATE_CACHE = 'dispatch_cache';
/**
 * PREFIXES, NOT KEYS. Each of these was one JSON blob under a single key that
 * every writer read, mutated and wrote back whole — so two hook processes in
 * one session dropped each other's entries, and the bounded ones evicted by
 * insertion order rather than by time. One row per member makes each write a
 * single statement, which is what the per-key upsert claim in the arms' comment
 * was always supposed to mean.
 */
const STATE_EDITS_PREFIX = 'edits:';
const STATE_EDITED_PREFIX = 'edited:';
const STATE_PACKAGES_PREFIX = 'package:';
const STATE_SIGNATURES_PREFIX = 'sig:';
/** Which pairings ONE AGENT was SHOWN behind a given command head — the key is
 *  \`replayed:<agent>:<head>\` and the value a JSON array of pairing ids. It is
 *  what lets the agent that was replayed a pairing be its second independent
 *  closer, which is the only route to \`verified\` through the hooks. Scoped by
 *  agent because parallel subagents share their parent's session id, and a list
 *  because one head answers for a whole build step. */
const STATE_REPLAYED_PREFIX = 'replayed:';
/**
 * A shelf whose \`POST /api/keys/resolve\` answered 404 (\`KNOWLEDGE_KEYS\`
 * off, or a deployment too old to have the route), keyed by origin under the
 * machine session and held for KEYS_OFF_TTL_MS. Machine-wide because the fact
 * is about the shelf, not the session: an always-on loop session lasts a day,
 * and a fresh session per prompt would otherwise pay one request each before
 * learning it (tenjin-agent#212).
 */
const STATE_KEYS_OFF_PREFIX = 'keys_off:';
const KEYS_OFF_TTL_MS = 6 * 60 * 60 * 1000;
/**
 * The team-shelf post a LOCAL pairing corresponds to, keyed by the pairing's
 * row id under the machine session. ONE SHAPE, shared with \`tenjin sync\`
 * (commands/sync.ts, which imports the mirrored STATE_PAIRING_POST_PREFIX):
 * \`{ postId, origin, at, own?, held?, closedAt?, status?, fixFiles? }\`.
 * The failure arm's team leg writes \`{ postId, origin, at }\` when it replays
 * a post and opens a pairing beside it, and stamps \`closedAt\`, \`status\`
 * and \`fixFiles\` when this machine's later pass closes that pairing — which
 * is the second, independent close the shelf has no endpoint for, so
 * \`tenjin sync\` reads it and PUTs the post \`verified\` instead of
 * publishing a duplicate. Sync itself adds \`own: true\` on a post it
 * published and \`held: true\` on a holder it lost to. No column: the
 * pairings table is not versioned for this, and the fact is a join key, not
 * a row attribute.
 */
const STATE_PAIRING_POST_PREFIX = 'pairing_post:';
const STATE_CAPTURE_ASKED = 'capture_asked';
const STATE_PUBLISHED_PREFIX = 'published:';
/** The shelf's per-trigger use rates, fetched by the SessionStart primer once
 *  per session for the adaptive cooldown (PUSH_COOLDOWN_* in
 *  lib/push-scripts.ts), and the per-trigger count of fires the cooled cap
 *  suppressed. */
const STATE_TRIGGER_RATES = 'trigger_rates';
const STATE_COOLDOWN_PREFIX = 'cooldown:';
const MACHINE_SESSION = '';

/** The open database, or null once we know we cannot have one. */
let STORE = null;
let STORE_OPENED = false;

/**
 * ULID-shaped, time-sortable, local. Ids are local and uids sync, so a uid has
 * to be unique across machines without a coordinator: 48 bits of time in
 * Crockford base32, then 80 bits from the CSPRNG.
 */
function uid() {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let time = '';
  let ms = Date.now();
  for (let i = 0; i < 10; i += 1) {
    time = alphabet[ms % 32] + time;
    ms = Math.floor(ms / 32);
  }
  let rand = '';
  for (const byte of randomBytes(16)) rand += alphabet[byte % 32];
  return time + rand;
}

/** A stable, non-reversible key for a cwd or a machine. Short on purpose: it is
 *  a join key for a future team sync, never a value anybody reads. */
function shortHash(text) {
  return createHash('sha256').update(String(text)).digest('hex').slice(0, 16);
}

/**
 * A stable id for this machine, computed ONCE AND LAZILY.
 *
 * NEVER AT MODULE SCOPE. \`os.userInfo()\` throws ERR_SYSTEM_ERROR when the
 * process uid has no passwd entry — the ordinary state in a devcontainer or a
 * CI image started with \`--user 1001\`, or on Kubernetes with an arbitrary
 * uid. At module scope that throw sits outside every try/catch and before
 * \`main()\`, so on such a host EVERY hook would exit 1 with a stack trace —
 * with push off, and before config.json is even read. This file's whole
 * contract is fail-open, and a machine id is not worth breaking it for, so both
 * halves are guarded and the fallback is the uid, or nothing.
 */
let MACHINE_ID = null;
function machineId() {
  if (MACHINE_ID !== null) return MACHINE_ID;
  let host = '';
  let user = '';
  try {
    host = hostname();
  } catch {
    // No hostname is a machine id of '', not a dead hook.
  }
  try {
    user = userInfo().username || '';
  } catch {
    // getpwuid failed: an arbitrary container uid. The uid is a stable enough
    // discriminator on its own, and '' is fine when even that is unavailable.
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    user = uid === null ? '' : 'uid:' + uid;
  }
  MACHINE_ID = shortHash(host + ' ' + user);
  return MACHINE_ID;
}

function projectId(cwd) {
  return typeof cwd === 'string' && cwd.length > 0 ? shortHash(cwd) : null;
}

/** A session id for the store: '' is the machine-global bucket a payload that
 *  names no session falls into, never an exemption from the bounds. */
function storeSession(sessionId) {
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : '';
}

/** The worker inside a session: Claude Code's \`agent_id\`, or '' for the lead's
 *  own turn. Bounded exactly like \`storeSession\` and for the same reason —
 *  '' is the bucket the parent's rows fall into, never an exemption from
 *  anything. Readers map it back to the null agent \`events.data.agentId\`
 *  uses (see \`eventAgent\`), so the two partitions line up. */
function storeAgent(agentId) {
  return typeof agentId === 'string' && agentId.length > 0 ? agentId : '';
}

/**
 * Switch the file to WAL. Returns whether it is now in WAL; NEVER throws.
 *
 * THE ONE STATEMENT IN THIS FILE THE BUSY TIMEOUT DOES NOT PROTECT. Probed
 * 2026-08-27 on node 24.19 (\`node:sqlite\`), fresh file, \`busy_timeout = 500\`:
 *
 *  - another connection holding a write lock -> this pragma throws
 *    \`database is locked\` after 0 ms. The busy handler is never called. An
 *    ordinary INSERT in the same state waited the full 554 ms and then threw.
 *  - another connection holding only a READ lock -> the busy handler IS called
 *    and the pragma waits out the timeout.
 *  - the file ALREADY in WAL, another connection mid-write -> succeeds in 1 ms.
 *    A no-op switch needs no exclusive lock at all.
 *
 * So the cold-start stampede (#246) killed the loser here, one line before the
 * transaction \`bootstrap()\` protects, and no timeout could have saved it: the
 * winner holds the write lock for its DDL and this statement will not wait.
 * The answer is the third bullet. Fail, let the caller run the version check —
 * which blocks on the winner properly, because the busy handler DOES cover it —
 * and come back afterwards, by which time the file is in WAL and the retry is a
 * no-op.
 *
 * AND IT IS NEVER FATAL EITHER WAY. WAL is a concurrency optimisation, not a
 * correctness requirement; a rollback journal under busy_timeout runs every
 * statement in this module correctly. Losing it is worth strictly less than the
 * hook's whole state for that fire, which is what throwing here costs.
 */
function setWal(db) {
  try {
    db.exec('PRAGMA journal_mode = wal');
    return true;
  } catch {
    return false;
  }
}

/**
 * Leave a mark when the WAL switch gave up, and take it back off when a later
 * open gets WAL. See \`STORE_SQL.setStoreJournal\` for what the row is and why
 * \`doctor\` reads it.
 *
 * CHEAP ON THE PATH THAT IS ALWAYS TAKEN. A degraded open costs one upsert. A
 * healthy open costs ONE PRIMARY-KEY LOOKUP AND NO WRITE — the row is absent on
 * a machine that has never lost WAL, and once a healed machine has been stamped
 * \`wal\` the lookup finds it and returns. This runs inside \`openStore\`, on
 * every fire, so a write here would put a lock acquisition in front of eight
 * concurrent hooks to record a fact that changes about once in a machine's life.
 *
 * MUST STAY AFTER \`bootstrap()\`: there is no \`session_state\` to write to
 * before it.
 */
function recordJournal(db, wal) {
  try {
    if (wal) {
      const row = db.prepare(STORE_SQL.getStoreJournal).get();
      if (!isRecord(row) || row.value === 'wal') return;
      db.prepare(STORE_SQL.setStoreJournal).run('wal', Date.now());
      return;
    }
    db.prepare(STORE_SQL.setStoreJournal).run('rollback', Date.now());
  } catch {
    // Bookkeeping about the bookkeeping. A store too contended to accept this
    // row is precisely the store the row describes, and losing it costs one
    // doctor line — never the fire.
  }
}

/**
 * Open the store, once per process. NEVER AT MODULE SCOPE: a module-scope
 * \`await import\` that throws exits 1 with a stack trace, which is what the
 * operator sees as a hook error. Called inside main(), and every failure —
 * an old Node, an unwritable dir, a corrupt file, a busy database — returns
 * null and leaves the arm behaving exactly as a missed lookup does.
 */
async function openStore() {
  if (STORE_OPENED) return STORE;
  STORE_OPENED = true;
  let db = null;
  try {
    const sqlite = await import('node:sqlite');
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    db = new sqlite.DatabaseSync(STATE_DB_PATH);
    // ORDER MATTERS: busy_timeout FIRST. With journal_mode set first, a fresh
    // database under eight concurrent openers kills one of them outright at
    // that pragma (probed 2026-08-25).
    db.exec('PRAGMA busy_timeout = ' + STORE_BUSY_TIMEOUT_MS);
    // ...but busy_timeout DOES NOT COVER THIS ONE. See setWal.
    let wal = setWal(db);
    db.exec('PRAGMA synchronous = normal');
    // LESS THAN, NEVER NOT-EQUAL. Hook scripts are regenerated only by
    // \`tenjin install\`, so a machine can run v1 hooks against a database a
    // newer CLI already migrated. On \`!==\` the stale hook stamps the version
    // back down, the newer side migrates again, and the two ping-pong forever —
    // and any non-idempotent statement in that later migration (#212 adds one
    // under version 2) then throws and costs the newer build its store. A
    // higher version is left exactly as it is.
    if (storeVersion(db) < STORE_USER_VERSION) bootstrap(db);
    // Second and last attempt, now that the cold start this lost to has
    // committed: on a file another opener has already switched, this is a 1 ms
    // read of the header. If it fails again the store is still open and
    // correct, just on a rollback journal.
    if (!wal) wal = setWal(db);
    // ...and the answer is now READ, not thrown away: a machine stuck on a
    // rollback journal says so in one row that \`tenjin doctor\` surfaces.
    recordJournal(db, wal);
    try {
      chmodSync(STATE_DB_PATH, 0o600);
    } catch {
      // The mode is defence in depth under a 0700 directory, not the guard.
    }
    STORE = db;
  } catch (err) {
    if (db !== null) {
      try {
        db.close();
      } catch {
        // Nothing to salvage.
      }
    }
    STORE = null;
    storeUnavailable(err);
  }
  return STORE;
}

/**
 * Create the schema, once, under a longer wait than an ordinary write gets.
 *
 * ONE transaction for the whole thing, gated on the version INSIDE it, so a
 * racer blocks on BEGIN IMMEDIATE and then reads the new version and skips. The
 * retry is for the cold-start stampede: with a burst of hooks meeting an empty
 * database, the last waiter can still exceed even the raised timeout, and one
 * more look costs nothing once the winner has committed — by then the version
 * check short-circuits and there is no second DDL run.
 *
 * The busy timeout is restored in the \`finally\`, so nothing after this point
 * inherits the bootstrap's patience.
 */
function bootstrap(db) {
  try {
    db.exec('PRAGMA busy_timeout = ' + STORE_BOOTSTRAP_TIMEOUT_MS);
    for (let attempt = 0; attempt < STORE_BOOTSTRAP_TRIES; attempt += 1) {
      if (storeVersion(db) >= STORE_USER_VERSION) return;
      try {
        db.exec('BEGIN IMMEDIATE');
      } catch (err) {
        // Someone else holds the write lock. Look again; they are almost
        // certainly committing the very schema this call wanted.
        if (attempt === STORE_BOOTSTRAP_TRIES - 1) throw err;
        continue;
      }
      try {
        stepSchema(db);
        db.exec('COMMIT');
        return;
      } catch (err) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // Already rolled back by the failure itself.
        }
        if (attempt === STORE_BOOTSTRAP_TRIES - 1) throw err;
      }
    }
  } finally {
    try {
      db.exec('PRAGMA busy_timeout = ' + STORE_BUSY_TIMEOUT_MS);
    } catch {
      // The open is about to fail anyway; the pragma is not what to report.
    }
  }
}

/**
 * Bring the schema to \`STORE_USER_VERSION\`. CALLED INSIDE THE TRANSACTION, and
 * it re-reads the version there rather than trusting the one the caller read
 * outside it: the racer that blocked on \`BEGIN IMMEDIATE\` is looking at a
 * database the winner has just changed.
 *
 * ⚠ EXCLUSIVE BRANCHES, because \`ALTER TABLE ADD COLUMN\` is not idempotent.
 * \`STORE_DDL\` is all IF NOT EXISTS and creates the CURRENT shape, so a fresh
 * file (or one whose pragma is unreadable, which reads as -1 and sorts below
 * every version) takes that branch and needs no step at all; only a file at
 * exactly v1 runs the ALTERs, and running them twice would throw
 * \`duplicate column name\` and cost the store.
 */
function stepSchema(db) {
  const version = storeVersion(db);
  if (version >= STORE_USER_VERSION) return;
  if (version < 1) db.exec(STORE_DDL);
  else if (version < 2) db.exec(STORE_MIGRATIONS[1]);
  db.exec(STORE_SQL.setUserVersion);
}

/** The stored schema version, or -1 when it cannot be read — which sorts BELOW
 *  every real version, so an unreadable pragma still takes the idempotent
 *  create branch rather than being mistaken for a newer database and skipped. */
function storeVersion(db) {
  const row = db.prepare(STORE_SQL.userVersion).get();
  return isRecord(row) && typeof row.user_version === 'number' ? row.user_version : -1;
}

/** One line, once. The arm still exits 0 with nothing on stdout. */
function storeUnavailable(err) {
  try {
    const reason = err && err.message ? String(err.message).slice(0, 200) : 'unknown';
    process.stderr.write('tenjin: state store unavailable (' + reason + ')\n');
  } catch {
    // A closed stderr is not this hook's problem to report.
  }
}

/**
 * Run one statement, swallowing everything. A store write is bookkeeping: a
 * BUSY past the timeout, a disk full, a schema from a newer build — none of
 * them are the tool call's problem.
 */
/** Run one statement. Returns the driver's result (which carries \`changes\`,
 *  the row count an \`ON CONFLICT DO NOTHING\` claim turns on) or null when
 *  nothing ran. */
function storeRun(sql, params) {
  if (STORE === null) return null;
  try {
    return STORE.prepare(sql).run(...params);
  } catch {
    return null;
  }
}

/**
 * Run one INSERT and say what it did.
 *
 * \`storeRun\` cannot answer the question the once-per-session unique index
 * asks: a refused duplicate and a broken database both come back as "nothing
 * was written", and the caller has to treat them oppositely — a duplicate means
 * another fire in this session claimed the piece first (record the skip, stay
 * silent), while a missing store means fail open (emit anyway).
 */
function storeInsert(sql, params) {
  if (STORE === null) return 'no-store';
  try {
    STORE.prepare(sql).run(...params);
    return 'ok';
  } catch (err) {
    const message = err && err.message ? String(err.message) : '';
    return /UNIQUE constraint failed/i.test(message) ? 'duplicate' : 'error';
  }
}

function storeGet(sql, params) {
  if (STORE === null) return null;
  try {
    const row = STORE.prepare(sql).get(...params);
    // node:sqlite returns null-prototype objects, so an isRecord that compares
    // against Object.prototype would reject every row it ever reads.
    return isRecord(row) ? row : null;
  } catch {
    return null;
  }
}

function storeAll(sql, params) {
  if (STORE === null) return [];
  try {
    return STORE.prepare(sql).all(...params).filter(isRecord);
  } catch {
    return [];
  }
}

/**
 * A count query's answer.
 *
 * UNREADABLE IS NOT ZERO. Every caller of this is a BOUND — the per-arm lookup
 * cap, the per-session injection cap, the outage brake — and answering 0 for a
 * database that could not be read turned each of them off at exactly the moment
 * there was no other bookkeeping either. Fail-open is the right contract for
 * SILENCE; it is a different decision for bounds, and it fell out of this
 * helper's default rather than being chosen. An unknown count reads as
 * Infinity, so a bound built on it engages rather than disappears.
 */
function storeCount(sql, params) {
  if (STORE === null) return Infinity;
  const row = storeGet(sql, params);
  return row !== null && typeof row.n === 'number' ? row.n : Infinity;
}

/**
 * May a row that was meant to be INJECTED actually be shown?
 *
 * Only on a clean write. A \`duplicate\` is the once-per-session index doing its
 * job, and an \`error\` — a BUSY past the timeout is the realistic one, under
 * exactly the contention the guarantee was added for — means the row is not
 * there either, so showing the piece would be the second injection the index
 * exists to prevent. The arms return before this point when there is no store
 * at all, so \`no-store\` is not a case that reaches here.
 */
function mayShow(outcome) {
  return outcome === 'ok';
}

/** JSON for a text column, or null. Never throws: a value with a cycle in it is
 *  a bug in the caller, not a reason to fail a tool call. */
function storeJson(value) {
  if (value === undefined || value === null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function storeParse(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** One row per hook fire, including the log-only arms. Returns the uid so the
 *  injection rows it produced can point back at it. */
function recordEvent(row) {
  const id = uid();
  storeRun(STORE_SQL.insertEvent, [
    id,
    Date.now(),
    storeSession(row.session),
    projectId(row.cwd),
    machineId(),
    String(row.hook),
    row.tool === undefined ? null : String(row.tool),
    row.errorHash === undefined ? null : String(row.errorHash),
    storeJson(row.files),
    storeJson(row.data),
  ]);
  return id;
}

/**
 * One row per decision: what the agent was shown, would have been shown
 * (\`logged\`), or was deliberately not shown (\`skipped\`, with a reason). This
 * is what \`tenjin push status\` tallies and what the judge (#210) later writes
 * an outcome onto.
 *
 * RETURNS WHAT THE WRITE DID, because on the \`injected\` path the write IS the
 * decision: 'ok', 'duplicate' (the once-per-session index refused it — another
 * fire in this session got there first, so this one records a skip and stays
 * silent), 'no-store' (fail open: the caller emits anyway) or 'error'. Callers
 * that are only logging an outcome ignore it.
 */
function recordInjection(row) {
  const id = uid();
  const candidate = isRecord(row.candidate) ? row.candidate : null;
  // A marketplace piece is keyed by resourceId and a note by id; both arrive in
  // \`candidate\`, and the already-shown set has to treat them alike.
  const resourceId =
    candidate === null
      ? null
      : typeof candidate.resourceId === 'string'
        ? candidate.resourceId
        : typeof candidate.id === 'string'
          ? candidate.id
          : null;
  return storeInsert(STORE_SQL.insertInjection, [
    id,
    row.eventUid === undefined ? null : String(row.eventUid),
    Date.now(),
    storeSession(row.session),
    projectId(row.cwd),
    machineId(),
    String(row.hook),
    String(row.shelf === undefined ? 'public' : row.shelf),
    resourceId,
    candidate === null || typeof candidate.title !== 'string' ? null : candidate.title,
    candidate === null || typeof candidate.url !== 'string' ? null : candidate.url,
    candidate === null || typeof candidate.price !== 'string' ? null : candidate.price,
    typeof row.searchId === 'string' ? row.searchId : null,
    typeof row.score === 'number' ? row.score : null,
    typeof row.second === 'number' ? row.second : null,
    typeof row.strength === 'string' ? row.strength : null,
    typeof row.confidence === 'string' ? row.confidence : null,
    typeof row.corroborated === 'boolean' ? (row.corroborated ? 1 : 0)
      : typeof row.corroborated === 'number' ? row.corroborated : null,
    String(row.action),
    typeof row.reason === 'string' ? row.reason : null,
    typeof row.form === 'string' ? row.form : null,
    row.deny === true ? 1 : 0,
    typeof row.tokens === 'number' ? row.tokens : null,
  ]);
}

/** Has this session already been shown this piece, by ANY hook? A cheap
 *  pre-check that saves a wasted body fetch; the unique index is the bound. */
function alreadyShown(sessionId, resourceId) {
  if (typeof resourceId !== 'string' || resourceId.length === 0) return false;
  return storeGet(STORE_SQL.alreadyShown, [storeSession(sessionId), resourceId]) !== null;
}

/** How many full-form injections this session has had. */
function injectedCount(sessionId) {
  return storeCount(STORE_SQL.injectedCount, [storeSession(sessionId)]);
}

/** This arm's machine-wide lookups since \`sinceMs\`. */
function bucketCount(hook, sinceMs) {
  return storeCount(STORE_SQL.bucketCount, [String(hook), sinceMs]);
}

/**
 * The trailing run of unanswered lookups for this session, newest first, with
 * when it started. A 'quiet' row is the stop itself, so it neither breaks the
 * run nor extends it.
 */
function failStreak(sessionId) {
  const rows = storeAll(STORE_SQL.recentReasons, [storeSession(sessionId), 40]);
  let streak = 0;
  let lastAt = 0;
  for (const row of rows) {
    if (row.reason === 'quiet') continue;
    if (row.reason !== 'no-answer') break;
    if (streak === 0 && typeof row.at === 'number') lastAt = row.at;
    streak += 1;
  }
  return { streak, lastAt };
}

/** One session_state value, parsed, or null. */
function getState(sessionId, key) {
  const row = getStateRaw(sessionId, key);
  return row === null ? null : storeParse(row);
}

function getStateRaw(sessionId, key) {
  const row = storeGet(STORE_SQL.getState, [storeSession(sessionId), key]);
  return row === null || typeof row.value !== 'string' ? null : row.value;
}

/** Upsert one key. Per key, so concurrent arms cannot clobber each other. */
function setState(sessionId, key, value) {
  storeRun(STORE_SQL.setState, [storeSession(sessionId), key, storeJson(value), Date.now()]);
}

function clearState(sessionId, key) {
  storeRun(STORE_SQL.deleteState, [storeSession(sessionId), key]);
}

/**
 * A key that HOLDS until \`untilMs\` and then simply reads as absent. The
 * expiry is the value, so a reader needs no clock column and no pruner: a
 * stale row is one more row in a table nothing scans, overwritten the next
 * time the fact is learned again.
 */
function setStateUntil(sessionId, key, untilMs) {
  setState(sessionId, key, untilMs);
}

/** Whether \`key\` was set with setStateUntil and has not expired. A value
 *  that is not a future timestamp reads as not held. */
function stateHolds(sessionId, key) {
  const until = getState(sessionId, key);
  return typeof until === 'number' && until > Date.now();
}

/**
 * Claim \`key\` for this session: true the FIRST time, false ever after.
 *
 * ONE STATEMENT, because the pattern it replaces was a read-modify-write of a
 * JSON list under a single key ("is this signature in the array? then append
 * it"), and two hook processes for one session both passed the check before
 * either wrote. One failure then opened two pairings and spent two lookups.
 * \`DO NOTHING\` plus the row count is the whole guard.
 */
function claimState(sessionId, key, value) {
  // No store is no dedup, and no dedup is not a licence: the arms return before
  // they reach here, and a caller that somehow did must not be told it holds a
  // claim nothing recorded.
  if (STORE === null) return false;
  const result = storeRun(STORE_SQL.claimState, [
    storeSession(sessionId),
    key,
    storeJson(value === undefined ? true : value),
    Date.now(),
  ]);
  // A store that refused the write for any OTHER reason must not silence the
  // arm: the claim is a dedupe aid, and failing open costs a duplicate lookup.
  if (result === null) return true;
  return typeof result.changes === 'number' ? result.changes > 0 : true;
}

/**
 * Bump a counter key and hand back the new value. One statement, so two
 * concurrent edit hooks cannot both read N and both write N+1 — which is how
 * the churn arm's "Nth edit to this file" trigger could be missed entirely.
 */
function bumpState(sessionId, key) {
  const row = storeGet(STORE_SQL.bumpState, [storeSession(sessionId), key, Date.now()]);
  if (row === null) return 0;
  const n = Number(row.value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * The keys under \`prefix\` touched since \`sinceMs\`, newest first.
 *
 * ONE ROW PER PATH, which is what makes the close rule's evidence survive.
 * \`edited\` used to be a single JSON map, so a concurrent write could drop an
 * entry, and its 200-key eviction ran on Object.keys ORDER — insertion order,
 * which a re-edit does not change — so re-editing the oldest-inserted file
 * (very often exactly the config file the failing command named) evicted the
 * freshest timestamp in the map and the pairing never closed.
 */
function statePrefixSince(sessionId, prefix, sinceMs, limit) {
  const rows = storeAll(STORE_SQL.statePrefixSince, [
    storeSession(sessionId),
    prefix,
    prefix + String.fromCharCode(0xffff),
    sinceMs,
    limit,
  ]);
  return rows.map((row) => ({
    key: typeof row.key === 'string' ? row.key.slice(prefix.length) : '',
    at: typeof row.at === 'number' ? row.at : 0,
  }));
}

function countStatePrefix(sessionId, prefix) {
  return storeCount(STORE_SQL.countStatePrefix, [
    storeSession(sessionId),
    prefix,
    prefix + String.fromCharCode(0xffff),
  ]);
}

/** SessionStart: one INSERT OR IGNORE-shaped upsert. */
function touchSession(sessionId, cwd) {
  storeRun(STORE_SQL.touchSession, [
    storeSession(sessionId),
    projectId(cwd),
    typeof cwd === 'string' ? cwd : null,
    Date.now(),
    machineId(),
  ]);
}

/** Stop: stamp ended_at, creating the row if this machine never saw the start. */
function endSession(sessionId) {
  const now = Date.now();
  storeRun(STORE_SQL.endSession, [storeSession(sessionId), now, now, machineId()]);
}

// ---- searches ----

/** A fan-out re-dispatches near-identical prompts; case and spacing carry no
 *  meaning here. Mirrored by the exported searchFingerprint below. */
function searchFingerprint(question) {
  return String(question).toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 512);
}

function recordSearchRow(entry) {
  storeRun(STORE_SQL.recordSearch, [
    String(entry.searchId),
    typeof entry.at === 'number' ? entry.at : Date.now(),
    storeSession(entry.sessionId),
    storeAgent(entry.agentId),
    String(entry.question),
    searchFingerprint(entry.question),
    String(entry.decision),
    storeJson(Array.isArray(entry.candidates) ? entry.candidates : []),
    typeof entry.source === 'string' ? entry.source : null,
    typeof entry.shelfBaseUrl === 'string' && entry.shelfBaseUrl.length > 0
      ? entry.shelfBaseUrl
      : null,
    typeof entry.paidBrowseCount === 'number' ? entry.paidBrowseCount : null,
  ]);
}

/** Has this session already asked this exact question? */
function alreadyAskedStore(question, sessionId) {
  return (
    storeGet(STORE_SQL.askedFingerprint, [
      storeSession(sessionId),
      searchFingerprint(question),
    ]) !== null
  );
}

/** How many searches this session has spent on \`source\` since \`sinceMs\`.
 *  WINDOWED, not lifetime: the ceiling exists to rate-limit a BURST, and the
 *  bounded file it used to be counted from expired old entries by scrolling
 *  them out. */
function spentSince(sessionId, source, sinceMs) {
  return storeCount(STORE_SQL.countBySource, [storeSession(sessionId), source, sinceMs]);
}

/**
 * MISSes nothing has closed, newest first, inside \`sinceMs\`.
 *
 * The source and session predicates are IN THE QUERY, not applied afterwards:
 * the Stop hook takes a bounded number of rows and then discards the sources it
 * never nags about, so filtering after the LIMIT let a machine with the push
 * arms on bury a deliberate \`tenjin search\` MISS under its own telemetry
 * within the hour. An empty \`sessionId\` means "every session", which is
 * what an unscoped turn end wants.
 */
function openLoops(sessionId, sinceMs, limit) {
  const scope = typeof sessionId === 'string' ? sessionId : '';
  return storeAll(STORE_SQL.openLoops, [sinceMs, scope, scope, limit]).map(searchRow);
}

/** A stored row in the shape the hooks read. */
function searchRow(row) {
  const candidates = storeParse(row.candidates);
  return {
    searchId: typeof row.search_id === 'string' ? row.search_id : '',
    at: typeof row.at === 'number' ? row.at : 0,
    sessionId: typeof row.session === 'string' && row.session.length > 0 ? row.session : null,
    question: typeof row.question === 'string' ? row.question : '',
    decision: typeof row.decision === 'string' ? row.decision : '',
    candidates: Array.isArray(candidates) ? candidates : [],
    source: typeof row.source === 'string' ? row.source : null,
    shelfBaseUrl: typeof row.shelf_base_url === 'string' ? row.shelf_base_url : null,
    resolvedBy: typeof row.resolved_by === 'string' ? row.resolved_by : null,
  };
}

// ---- pairings (local error -> fix replay, 04 "Mechanical") ----

/**
 * Open a pairing on an allowlisted failure. Mechanical, no model: the key is the
 * failure's signature and the row is what a later success closes. Returns the
 * new row's id, or null when the store refused the write.
 */
function openPairing(row) {
  const result = storeRun(STORE_SQL.insertPairing, [
    uid(),
    Date.now(),
    storeSession(row.session),
    projectId(row.cwd),
    machineId(),
    'sig_v1',
    String(row.key),
    typeof row.coarseKey === 'string' ? row.coarseKey : null,
    typeof row.cmdHead === 'string' ? row.cmdHead : null,
    typeof row.cmd === 'string' ? row.cmd : null,
    typeof row.errorLine === 'string' ? row.errorLine : null,
    storeJson(row.errorFiles),
    storeJson(row.pkgVersions),
    String(row.scope),
  ]);
  // The ROW ID, which is what \`replayed:<agent>:<head>\` and
  // \`pairing_post:<id>\`
  // key on and \`pairingById\` reads back; null when nothing was written.
  const rowid = result === null ? null : Number(result.lastInsertRowid);
  return Number.isSafeInteger(rowid) ? rowid : null;
}

/** The best local match for a signature: verified first, then most closed, then
 *  most recent. Fine key, then coarse — one indexed query does both. */
function findPairing(cwd, key, coarseKey) {
  const coarse = typeof coarseKey === 'string' && coarseKey.length > 0 ? coarseKey : '';
  const row = storeGet(STORE_SQL.findPairing, [projectId(cwd), String(key), coarse]);
  return row === null ? null : pairingRow(row);
}

function openPairingsForHead(cwd, cmdHead, beforeMs, limit) {
  return storeAll(STORE_SQL.openForHead, [
    projectId(cwd),
    String(cmdHead),
    beforeMs,
    limit,
  ]).map(pairingRow);
}

/** One pairing by id AND project, for the session that was SHOWN it and later
 *  fixed it. The project is not optional: see the note on the statement. */
function pairingById(cwd, id) {
  const row = storeGet(STORE_SQL.pairingById, [id, projectId(cwd)]);
  return row === null ? null : pairingRow(row);
}

/**
 * Record that \`sessionId\` closed this pairing, then recompute it from all
 * of its closers.
 *
 * TWO CLOSES ARE ONLY CORROBORATION IF THEY AGREE. 04 asks for "two INDEPENDENT
 * closes"; independence alone turned out to be too weak, because the second
 * closer is RECRUITED by the suggestion itself — a session shown "someone once
 * fixed this by touching foo.ts" re-runs the failing command by definition, so
 * it satisfied the same-command branch of the close rule while editing anything
 * at all, and the suggestion became a material cause of its own promotion to
 * \`verified\`. So a closer counts toward the promotion only if its fix
 * OVERLAPS the first closer's: the same file was touched both times. An
 * incompatible close is still RECORDED — it is real evidence about the pairing,
 * and #212 will want it — it simply does not corroborate.
 *
 * \`fix_files\` ends up as what the corroborating closers have in common, so
 * "Fixed here N time(s) by changing X" names only files every one of them
 * touched. \`scope\` belongs to the FIRST closer and is never overwritten:
 * it describes the pairing, and the first close is the one whose files are kept.
 *
 * \`agentId\` IS RECORDED AND COUNTS FOR NOTHING HERE. It is what the
 * importance-score report partitions on, so the row carries it; the promotion
 * still counts SESSIONS, because two subagents of one conversation are one
 * machine in one checkout and not the two independent observations 04 asks for.
 *
 * Returns the resulting status, so the caller can say what it did.
 */
function closePairing(id, sessionId, agentId, fixCmd, fixFiles, scope) {
  const now = Date.now();
  const files = Array.isArray(fixFiles) ? fixFiles : [];
  storeRun(STORE_SQL.claimClose, [
    id,
    storeSession(sessionId),
    storeAgent(agentId),
    now,
    typeof fixCmd === 'string' ? fixCmd : null,
    storeJson(files),
    String(scope),
  ]);

  const closers = storeAll(STORE_SQL.closersOf, [id]).map((row) => ({
    at: typeof row.at === 'number' ? row.at : 0,
    fixCmd: typeof row.fix_cmd === 'string' ? row.fix_cmd : null,
    fixFiles: storeParse(row.fix_files) || [],
    scope: typeof row.scope === 'string' ? row.scope : 'ambiguous',
  }));
  if (closers.length === 0) return 'open';

  const first = closers[0];
  const agreeing = [first];
  for (const closer of closers.slice(1)) {
    if (closer.fixFiles.some((f) => first.fixFiles.includes(f))) agreeing.push(closer);
  }
  // What they ALL touched. With one closer that is simply its own files.
  const common = first.fixFiles.filter((f) => agreeing.every((c) => c.fixFiles.includes(f)));

  storeRun(STORE_SQL.syncPairing, [
    agreeing.length,
    agreeing.length,
    now,
    first.fixCmd,
    storeJson(common.length > 0 ? common : first.fixFiles),
    first.scope,
    id,
  ]);
  const after = storeGet(STORE_SQL.pairingByIdUnscoped, [id]);
  return after !== null && typeof after.status === 'string' ? after.status : 'open';
}

function pairingRow(row) {
  return {
    id: typeof row.id === 'number' ? row.id : 0,
    at: typeof row.at === 'number' ? row.at : 0,
    session: typeof row.session === 'string' ? row.session : '',
    project: typeof row.project === 'string' ? row.project : null,
    key: typeof row.key === 'string' ? row.key : '',
    coarseKey: typeof row.coarse_key === 'string' ? row.coarse_key : null,
    cmdHead: typeof row.cmd_head === 'string' ? row.cmd_head : null,
    cmd: typeof row.cmd === 'string' ? row.cmd : null,
    errorLine: typeof row.error_line === 'string' ? row.error_line : null,
    errorFiles: storeParse(row.error_files) || [],
    fixCmd: typeof row.fix_cmd === 'string' ? row.fix_cmd : null,
    fixFiles: storeParse(row.fix_files) || [],
    pkgVersions: storeParse(row.pkg_versions) || {},
    scope: typeof row.scope === 'string' ? row.scope : 'ambiguous',
    status: typeof row.status === 'string' ? row.status : 'open',
    closes: typeof row.closes === 'number' ? row.closes : 0,
  };
}
`;

/**
 * The store core with the schema and the statements baked in — the same shape
 * `pushSource()` has, and for the same reason: a helper written once here lands
 * in every one of the eight generated scripts.
 */
export function storeSource(): string {
  return STORE_CORE_JS.replaceAll('__DB_FILE__', JSON.stringify(STATE_DB_FILE))
    .replaceAll('__BOOTSTRAP_TIMEOUT_MS__', String(STORE_BOOTSTRAP_TIMEOUT_MS))
    .replaceAll('__BOOTSTRAP_TRIES__', String(STORE_BOOTSTRAP_TRIES))
    .replaceAll('__SQL__', JSON.stringify(STORE_SQL, null, 2))
    .replaceAll('__DDL__', JSON.stringify(STORE_DDL))
    .replaceAll('__MIGRATIONS__', JSON.stringify(STORE_MIGRATIONS))
    .replaceAll('__USER_VERSION__', String(STORE_USER_VERSION))
    .replaceAll('__BUSY_TIMEOUT_MS__', String(STORE_BUSY_TIMEOUT_MS));
}

// ---------------------------------------------------------------------------
// The CLI's own handle on the same file.
// ---------------------------------------------------------------------------

/** The narrow slice of `node:sqlite`'s DatabaseSync this module uses. */
interface SqliteStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

export interface Store {
  /**
   * Run one statement. Returns whether it actually ran: a caller that REPORTS
   * what it did — `markSearchResolved`, whose receipt an agent acts on — must
   * be able to tell a write that landed from one that was swallowed, or it
   * claims a close that never happened.
   */
  run(sql: string, params?: unknown[]): boolean;
  get(sql: string, params?: unknown[]): Record<string, unknown> | null;
  all(sql: string, params?: unknown[]): Record<string, unknown>[];
  close(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function storeVersionOf(db: SqliteDatabase): number {
  const row = db.prepare(STORE_SQL.userVersion).get();
  return isRecord(row) && typeof row.user_version === 'number' ? row.user_version : -1;
}

/** ⚠ MIRRORED with `stepSchema` in the hook template above, which carries the
 *  reasoning: the version is re-read INSIDE the transaction, the create and
 *  migrate branches are exclusive because `ALTER TABLE ADD COLUMN` throws on a
 *  second run, and an unreadable pragma (-1) takes the idempotent create. */
function stepSchemaOn(db: SqliteDatabase): void {
  const version = storeVersionOf(db);
  if (version >= STORE_USER_VERSION) return;
  if (version < 1) db.exec(STORE_DDL);
  else if (version < 2) db.exec(STORE_MIGRATIONS[1]!);
  db.exec(STORE_SQL.setUserVersion);
}

/** Switch the file to WAL. Returns whether it is now in WAL; never throws. See
 *  the probe in `setWal`'s comment in the hook template above for why this is
 *  best-effort and why one retry after the bootstrap is what fixes it. */
function setWalOn(db: SqliteDatabase): boolean {
  try {
    db.exec('PRAGMA journal_mode = wal');
    return true;
  } catch {
    return false;
  }
}

/** ⚠ MIRRORED with `recordJournal` in the hook template above, which carries the
 *  reasoning: one upsert on the degraded path, one primary-key lookup and no
 *  write on the healthy one, and never after anything but `bootstrap()`. */
function recordJournalOn(db: SqliteDatabase, wal: boolean): void {
  try {
    if (wal) {
      const row = db.prepare(STORE_SQL.getStoreJournal).get();
      if (!isRecord(row) || row.value === 'wal') return;
      db.prepare(STORE_SQL.setStoreJournal).run('wal', Date.now());
      return;
    }
    db.prepare(STORE_SQL.setStoreJournal).run('rollback', Date.now());
  } catch {
    // A store too contended to take this row is the store the row is about.
  }
}

/** What `openStore` last recorded about the WAL switch on this machine. */
export interface StoreJournalState {
  /** `rollback` means the store is open, correct and serialised — never absent. */
  mode: 'rollback' | 'wal';
  /** When the open that recorded it ran (ms since epoch). */
  at: number;
}

/**
 * Read the degraded-store marker for `doctor`, WITHOUT CREATING ANYTHING.
 *
 * `doctor` is the command reached for when something is already broken, so it
 * may not be the thing that first materialises the state database: a missing
 * file reads as "nothing to report", not as a store to bootstrap. When the file
 * IS there this goes through the ordinary {@link openStore}, which means the
 * answer reflects a real open attempt made now — including its own retry, so a
 * machine whose loss of WAL was one transient cold start heals itself the moment
 * an operator asks.
 */
export async function readStoreJournal(dataDir: string): Promise<StoreJournalState | null> {
  try {
    const { existsSync } = await import('node:fs');
    if (!existsSync(stateDbPath(dataDir))) return null;
    const store = await openStore(dataDir);
    if (store === null) return null;
    try {
      const row = store.get(STORE_SQL.getStoreJournal);
      if (row === null || (row.value !== 'rollback' && row.value !== 'wal')) return null;
      return { mode: row.value, at: typeof row.at === 'number' ? row.at : 0 };
    } finally {
      store.close();
    }
  } catch {
    // Same posture as every other reader here: unreadable is silent, never a
    // doctor that throws on the machine it was run to diagnose.
    return null;
  }
}

/**
 * Open (and create) the store for the CLI.
 *
 * Same contract as the hooks' copy: `null` for every failure, so a `push
 * status` on a machine with an unreadable database prints zeros rather than a
 * stack trace, and `tenjin search` records nothing rather than failing the
 * search it just paid for. The import is dynamic for the same reason it is in a
 * hook — an `engines` floor is a promise, not an enforcement, and a static
 * import would take the whole CLI down on a Node that lacks the module.
 */
export async function openStore(dataDir: string): Promise<Store | null> {
  let db: SqliteDatabase | null = null;
  try {
    const { mkdirSync, chmodSync } = await import('node:fs');
    const sqlite = (await import('node:sqlite')) as unknown as {
      DatabaseSync: new (path: string) => SqliteDatabase;
    };
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const path = stateDbPath(dataDir);
    db = new sqlite.DatabaseSync(path);
    db.exec(`PRAGMA busy_timeout = ${STORE_BUSY_TIMEOUT_MS}`);
    // Best effort, never fatal, and retried after the version check: the same
    // two-attempt shape and the same probe as `setWal` in the hook template
    // above. A CLI command can be the one that meets a fresh file beside a
    // burst of hooks, and this pragma is the one statement the busy timeout
    // does not cover.
    let wal = setWalOn(db);
    db.exec('PRAGMA synchronous = normal');
    // `<`, never `!==`: see the note in the hook template above. A database a
    // newer build has already migrated is left alone rather than downgraded.
    // Same raised wait and same retry as the hooks get, for the same reason: a
    // CLI command can be the one that meets an empty database beside a burst of
    // them.
    if (storeVersionOf(db) < STORE_USER_VERSION) {
      try {
        db.exec(`PRAGMA busy_timeout = ${STORE_BOOTSTRAP_TIMEOUT_MS}`);
        for (let attempt = 0; attempt < STORE_BOOTSTRAP_TRIES; attempt += 1) {
          if (storeVersionOf(db) >= STORE_USER_VERSION) break;
          try {
            db.exec('BEGIN IMMEDIATE');
          } catch (err) {
            if (attempt === STORE_BOOTSTRAP_TRIES - 1) throw err;
            continue;
          }
          try {
            stepSchemaOn(db);
            db.exec('COMMIT');
            break;
          } catch (err) {
            try {
              db.exec('ROLLBACK');
            } catch {
              // Already rolled back by the failure itself.
            }
            if (attempt === STORE_BOOTSTRAP_TRIES - 1) throw err;
          }
        }
      } finally {
        try {
          db.exec(`PRAGMA busy_timeout = ${STORE_BUSY_TIMEOUT_MS}`);
        } catch {
          // The open is about to fail anyway; the pragma is not what to report.
        }
      }
    }
    // Second and last attempt, now that whatever cold start this lost to has
    // committed.
    if (!wal) wal = setWalOn(db);
    // ...and the answer is recorded rather than discarded; see `recordJournal`.
    recordJournalOn(db, wal);
    try {
      chmodSync(path, 0o600);
    } catch {
      // Defence in depth under a 0700 directory, not the guard.
    }
    const handle = db;
    return {
      run(sql, params = []) {
        try {
          handle.prepare(sql).run(...params);
          return true;
        } catch {
          // Bookkeeping: never the command's problem — but the caller is told.
          return false;
        }
      },
      get(sql, params = []) {
        try {
          const row = handle.prepare(sql).get(...params);
          return isRecord(row) ? row : null;
        } catch {
          return null;
        }
      },
      all(sql, params = []) {
        try {
          return handle
            .prepare(sql)
            .all(...params)
            .filter(isRecord);
        } catch {
          return [];
        }
      },
      close() {
        try {
          handle.close();
        } catch {
          // Already gone.
        }
      },
    };
  } catch {
    if (db !== null) {
      try {
        db.close();
      } catch {
        // Nothing to salvage.
      }
    }
    return null;
  }
}

/**
 * What the store replaced, deleted by `tenjin install` (plan 03, owner decision
 * 3: no legacy path).
 *
 * NOT IMPORTED, DELETED. The plan's first draft read `push-ledger.jsonl` into
 * `injections` on first open, renamed it `.imported`, and kept a `push export`
 * for anyone who scripted against it. The owner's call was that none of that is
 * worth carrying: nothing scripts against the file, the team is two people, and
 * a one-time importer is code that lives forever to serve a week. So the sidecar
 * starts clean, and `install` — the command that rewrites the hook scripts
 * anyway — is where the retired files go.
 *
 * `searches.json.lock` is in the list because the file version took an mkdir
 * mutex: a lock directory left behind by a crashed writer is never stale-stolen
 * (that is the protocol's whole safety property), so nothing would ever remove
 * it once its owner is gone.
 */
export const RETIRED_STATE_ENTRIES = [
  'push-ledger.jsonl',
  'searches.json',
  'searches.json.lock',
  'push',
  'candidates',
] as const;

/**
 * Delete the retired files. Best-effort and named-only: the data dir holds the
 * wallet, so this removes exactly the entries above and never sweeps a
 * directory it did not name. Returns what it actually removed, so `install` can
 * say so rather than deleting the operator's state silently.
 */
export async function removeRetiredState(dataDir: string): Promise<string[]> {
  const removed: string[] = [];
  try {
    const { lstatSync } = await import('node:fs');
    const { rm } = await import('node:fs/promises');
    for (const name of RETIRED_STATE_ENTRIES) {
      const path = join(dataDir, name);
      const stat = lstatSync(path, { throwIfNoEntry: false });
      // A symlink parked at one of these names is not ours to follow, and a
      // socket or device is not ours to delete.
      if (stat === undefined || (!stat.isFile() && !stat.isDirectory())) continue;
      await rm(path, { recursive: stat.isDirectory(), force: true });
      removed.push(path);
    }
  } catch {
    // A data dir we cannot read is `install`'s problem elsewhere, not here.
  }
  return removed;
}

/** Is `node:sqlite` importable and answering? What `tenjin doctor` probes. */
export async function probeSqlite(): Promise<{ ok: boolean; version: string | null }> {
  try {
    const sqlite = (await import('node:sqlite')) as unknown as {
      DatabaseSync: new (path: string) => SqliteDatabase;
    };
    const db = new sqlite.DatabaseSync(':memory:');
    try {
      const row = db.prepare('SELECT sqlite_version() AS v').get();
      const version = isRecord(row) && typeof row.v === 'string' ? row.v : null;
      return { ok: true, version };
    } finally {
      db.close();
    }
  } catch {
    return { ok: false, version: null };
  }
}

/** The '' bucket a payload naming no session falls into; see the DDL note. */
export function storeSession(sessionId: string | null | undefined): string {
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : '';
}

/** ⚠ MIRRORED with `searchFingerprint` in the hook core above. */
export function searchFingerprint(question: string): string {
  return question.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 512);
}

/** ⚠ MIRRORED with `shortHash` in the hook core above: a cwd or machine string
 *  reduced to a stable, non-reversible 16-hex join key. The CLI computes it to
 *  read the same `pairings.project` the hooks wrote. */
export function shortHash(text: string): string {
  return createHash('sha256').update(String(text)).digest('hex').slice(0, 16);
}

/** ⚠ MIRRORED with `projectId` in the hook core above. The `project` column a
 *  pairing was stamped with, so the CLI (`tenjin sync`) scopes its read to the
 *  same checkout the failure happened in; null for a cwd-less payload. */
export function projectId(cwd: string | null | undefined): string | null {
  return typeof cwd === 'string' && cwd.length > 0 ? shortHash(cwd) : null;
}

/** ⚠ MIRRORED with `STATE_PAIRING_POST_PREFIX` in the hook core above: the
 *  `session_state` row (machine session `''`) linking a local pairing to its
 *  team-shelf post, `{ postId, origin, at, own?, held?, closedAt?, status?,
 *  fixFiles? }`. The failure arm writes it; `tenjin sync` reads and extends it. */
export const STATE_PAIRING_POST_PREFIX = 'pairing_post:';

/**
 * The coarse key AS IT GOES ON THE TEAM-SHELF WIRE (plan 06, "The naming, fixed
 * once"): `shortHash(coarseKey + '|' + repo)`, where `coarseKey` is the stored,
 * UNSALTED `sig_v1c` hash (`pairings.coarse_key`) and `repo` is the origin URL
 * read from `.git/config`. The salt goes over the stored hash, not the raw
 * message, because a `pairings` row keeps only the hashes and `tenjin sync`
 * reads rows back long after the failure arm's `sigV1()` call is gone.
 *
 * THE ONE DEFINITION. `tenjin sync` (commands/sync.ts) imports it directly; a
 * hook script cannot import, so the failure arm's resolve leg carries a copy
 * inside its generated source, and that copy must produce the same bytes for
 * the same (coarse_key, repo) — a resolve query and a synced post that salted
 * two different ways would never find each other, and the miss would be
 * indistinguishable from "no teammate has hit this". The pinned value in
 * state-store.test.ts is what both sides are held to. The caller adds the wire
 * prefix: `` `sig_v1c:${teamCoarseKey(coarseKey, repo)}` ``.
 */
export function teamCoarseKey(coarseKey: string, repo: string): string {
  return shortHash(`${coarseKey}|${repo}`);
}

// ---- searches: the CLI's typed handle ----

/**
 * The same `searches` rows the hooks write, in the shape the commands read.
 *
 * A local ledger of recent searches so `outcome --last` can target the most
 * recent one and `buy <resourceId>` can resolve the payable read URL a candidate
 * carried (the read route is keyed by handle/slug, not id, so an id alone can't
 * build the URL). Best-effort: an unavailable store reads as empty rather than
 * blocking a command. NOT an entitlement record, that is the library receipt.
 *
 * This used to be its own module over the same table. One store, one file: the
 * statements live in {@link STORE_SQL} beside every other reader's, so a query
 * that needs an index is visible next to the DDL that has to carry it.
 */

const StoredCandidateSchema = z.object({
  resourceId: z.string(),
  url: z.string(),
  title: z.string(),
  price: z.string(),
});
export type StoredCandidate = z.infer<typeof StoredCandidateSchema>;

/**
 * What closed an open loop. The Stop hook stays quiet once either is recorded:
 * `outcome` (the loop was reported) or `publish` (the answer went back to the
 * marketplace).
 */
export const SearchResolutionSchema = z.enum(['outcome', 'publish']);
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
   * The WORKER inside that session: Claude Code's `agent_id`, present only for
   * a subagent's fire and absent for the lead's own turn.
   *
   * A session is not a worker. Parallel subagents all file under their parent's
   * `session_id`, so a search attributed to the session alone belongs to every
   * agent in it at once — which is how `push status --sessions` credited one
   * child's search to a sibling's `research-then-edit`. Stored as '' when
   * absent, the same bucket `sessionId` uses, and read back as the null agent
   * `events.data.agentId` reports.
   */
  agentId?: string;
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
 * How many rows the ledger's unkeyed reads look at, newest first: what a bare
 * {@link loadSearches} returns, and how deep {@link STORE_SQL.searchForResource}
 * scans for the search a resource came out of.
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
const MACHINE_SESSION = storeSession(undefined);

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
    // '' is the lead's own turn, and it is reported as ABSENT rather than as an
    // empty agent — the same shape `sessionId` takes, and what keeps a
    // re-record through `recordSearch` from blanking a child's stamp.
    ...(typeof row.agent === 'string' && row.agent.length > 0 ? { agentId: row.agent } : {}),
    ...(typeof row.draft_post_id === 'string' && row.draft_post_id.length > 0
      ? { draftPostId: row.draft_post_id }
      : {}),
    ...(typeof row.paid_browse_count === 'number'
      ? { paidBrowseCount: row.paid_browse_count }
      : {}),
  };
}

/** Open, run `fn`, close. A null store yields `fallback`, the same fail-open
 *  posture every other reader of this file takes. */
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

/** One search by id, case-insensitively (see {@link STORE_SQL.getSearch}). */
export async function getStoredSearch(
  dataDir: string,
  searchId: string,
): Promise<StoredSearch | null> {
  return await withStore(dataDir, null as StoredSearch | null, (store) => {
    const row = store.get(STORE_SQL.getSearch, [searchId]);
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
  const scope = storeSession(sessionId);
  return await withStore(dataDir, [] as StoredSearch[], (store) => {
    const rows = store.all(STORE_SQL.openSearches, [scope, scope, RECENT_LIMIT]);
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
      // '' is the lead's own bucket; see `StoredSearch.agentId`.
      storeSession(entry.agentId),
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
      const row = store.get(STORE_SQL.getSearch, [searchId]);
      if (row === null) continue;
      // Keyed on the STORED spelling, not the caller's: the lookup above is
      // case-insensitive ({@link STORE_SQL.getSearch}) while the join that reads
      // the link back concatenates `s.search_id` under BINARY collation, so a
      // caller's differently-cased id would park the claim on a key nothing
      // joins to.
      const stored = typeof row.search_id === 'string' ? row.search_id : searchId;
      store.run(STORE_SQL.setState, [MACHINE_SESSION, DRAFT_LINK_PREFIX + stored, parkedOn, at]);
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
  return await withStore(dataDir, null as StoredCandidate | null, (store) => {
    const row = store.get(STORE_SQL.searchForResource, [RECENT_LIMIT, resourceId, '']);
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
  return await withStore(dataDir, null as string | null, (store) => {
    const row = store.get(STORE_SQL.searchForResource, [
      RECENT_LIMIT,
      match.resourceId ?? '',
      match.url ?? '',
    ]);
    return row !== null && typeof row.search_id === 'string' ? row.search_id : null;
  });
}
