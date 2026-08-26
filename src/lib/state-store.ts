import { join } from 'node:path';

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
 * The schema version this build creates and expects. The DDL runs exactly once,
 * inside one `BEGIN IMMEDIATE`, gated on `PRAGMA user_version`: a second process
 * racing the first blocks on the transaction, then reads the new version and
 * skips.
 *
 * `#212` adds `error_signatures`/`trigger_stats` under version 2 in the shape it
 * needs. Nothing here is `NOT NULL` that a later issue is supposed to fill.
 */
export const STORE_USER_VERSION = 1;

/**
 * How long a colliding writer waits before giving up, in ms.
 *
 * SET FIRST, BEFORE `journal_mode`. Probed 2026-08-25: eight processes writing a
 * fresh database with `journal_mode=wal` set first killed one of them at that
 * pragma with `ERR_SQLITE_ERROR: database is locked` — exit 1 and a stack trace
 * on stderr, which is exactly what Claude Code shows the operator. With
 * `busy_timeout` first, 3/3 runs completed with zero BUSY. The `timeout`
 * constructor option would do the same job but is 22.16+, so it is the pragma.
 */
export const STORE_BUSY_TIMEOUT_MS = 250;

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
CREATE INDEX IF NOT EXISTS injections_session_resource ON injections(session, resource_id);
CREATE INDEX IF NOT EXISTS injections_hook_at ON injections(hook, at);
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
CREATE INDEX IF NOT EXISTS pairings_key_status ON pairings(key, status);
CREATE INDEX IF NOT EXISTS pairings_coarse_status ON pairings(coarse_key, status);
CREATE INDEX IF NOT EXISTS pairings_open_head ON pairings(cmd_head, at) WHERE status = 'open';
`;

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

  recordSearch: `INSERT INTO searches (
       search_id, at, session, question, fingerprint, decision, candidates,
       source, shelf_base_url, paid_browse_count
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(search_id) DO UPDATE SET
       at = excluded.at, session = excluded.session, question = excluded.question,
       fingerprint = excluded.fingerprint, decision = excluded.decision,
       candidates = excluded.candidates, source = excluded.source,
       shelf_base_url = excluded.shelf_base_url,
       paid_browse_count = COALESCE(excluded.paid_browse_count, searches.paid_browse_count)`,
  /** Newest first. `rowid` breaks a tie so two rows stamped the same
   *  millisecond come back write-order-newest-first, which is what "prepend"
   *  meant when this was a JSON array. */
  listSearches: 'SELECT * FROM searches ORDER BY at DESC, rowid DESC LIMIT ?',
  getSearch: 'SELECT * FROM searches WHERE search_id = ?',
  latestDeliberate: `SELECT * FROM searches
     WHERE source IS NULL OR source = 'cli' ORDER BY at DESC, rowid DESC LIMIT 1`,
  resolveSearch: 'UPDATE searches SET resolved_by = ?, resolved_at = ? WHERE search_id = ?',
  askedFingerprint: `SELECT 1 FROM searches
     WHERE session = ? AND fingerprint = ? LIMIT 1`,
  countBySource: `SELECT COUNT(*) AS n FROM searches
     WHERE session = ? AND source = ? AND at >= ?`,
  openLoops: `SELECT * FROM searches
     WHERE decision = 'MISS' AND resolved_by IS NULL AND at >= ?
     ORDER BY at DESC, rowid DESC LIMIT ?`,
  /** Did this session ask for a search ITSELF? The push arms search on their own
   *  initiative, so their rows are not evidence the session researched anything
   *  — see the Stop hook's \`didResearch\`. */
  researchedBySession: `SELECT 1 FROM searches
     WHERE session = ? AND (source IS NULL OR source <> 'push-hook') LIMIT 1`,

  insertPairing: `INSERT INTO pairings (
       uid, at, session, project, machine, kind, key, coarse_key,
       cmd_head, cmd, error_line, error_files, pkg_versions, scope, status
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
  /** A local match, best first: verified outranks unverified, then most recent. */
  findPairing: `SELECT * FROM pairings
     WHERE (key = ? OR (coarse_key IS NOT NULL AND coarse_key = ?))
       AND status IN ('unverified', 'verified')
     ORDER BY CASE status WHEN 'verified' THEN 0 ELSE 1 END, closes DESC, at DESC
     LIMIT 1`,
  /** Pairings this success could be closing: same command head, still open. */
  openForHead: `SELECT * FROM pairings
     WHERE status = 'open' AND cmd_head = ? AND at <= ? ORDER BY at DESC LIMIT ?`,
  /** A close is `unverified`; the SECOND independent close promotes to
   *  `verified` (04, "Close rule"). `closes` is the count, so the promotion is
   *  one statement rather than a read-then-write race. */
  closePairing: `UPDATE pairings SET
       status = CASE WHEN closes + 1 >= 2 THEN 'verified' ELSE 'unverified' END,
       closes = closes + 1,
       closed_at = ?,
       fix_cmd = COALESCE(fix_cmd, ?),
       fix_files = COALESCE(fix_files, ?),
       scope = ?
     WHERE id = ?`,
  /** A later close of an already-closed pairing on the same key, from a
   *  DIFFERENT session: two independent closes make it `verified`. */
  closedOnKey: `SELECT * FROM pairings
     WHERE key = ? AND status = 'unverified' AND session <> ? ORDER BY at DESC LIMIT 1`,

  /** `tenjin push status`, one pass over the window. */
  statusRows: `SELECT hook, shelf, action, reason, resource_id, deny, tokens
     FROM injections WHERE at >= ?`,
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
const STORE_USER_VERSION = __USER_VERSION__;
const STORE_BUSY_TIMEOUT_MS = __BUSY_TIMEOUT_MS__;

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
const STATE_EDITS = 'edits';
const STATE_EDITED = 'edited';
const STATE_PACKAGES = 'packages';
const STATE_SIGNATURES = 'signatures';
const STATE_CACHE = 'dispatch_cache';
const STATE_CAPTURE_ASKED = 'capture_asked';
const STATE_PUBLISHED_PREFIX = 'published:';
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

const MACHINE_ID = shortHash(hostname() + ' ' + (userInfo().username || ''));
function projectId(cwd) {
  return typeof cwd === 'string' && cwd.length > 0 ? shortHash(cwd) : null;
}

/** A session id for the store: '' is the machine-global bucket a payload that
 *  names no session falls into, never an exemption from the bounds. */
function storeSession(sessionId) {
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : '';
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
    db.exec('PRAGMA journal_mode = wal');
    db.exec('PRAGMA synchronous = normal');
    if (storeVersion(db) !== STORE_USER_VERSION) {
      // ONE transaction for the whole schema, gated on the version inside it: a
      // racer blocks on BEGIN IMMEDIATE, then reads the new version and skips.
      db.exec('BEGIN IMMEDIATE');
      try {
        if (storeVersion(db) !== STORE_USER_VERSION) {
          db.exec(STORE_DDL);
          db.exec(STORE_SQL.setUserVersion);
        }
        db.exec('COMMIT');
      } catch (err) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // Already rolled back by the failure itself.
        }
        throw err;
      }
    }
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
function storeRun(sql, params) {
  if (STORE === null) return null;
  try {
    return STORE.prepare(sql).run(...params);
  } catch {
    return null;
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

/** A count query's answer, or 0 for anything unreadable. */
function storeCount(sql, params) {
  const row = storeGet(sql, params);
  return row !== null && typeof row.n === 'number' ? row.n : 0;
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
    MACHINE_ID,
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
  storeRun(STORE_SQL.insertInjection, [
    id,
    row.eventUid === undefined ? null : String(row.eventUid),
    Date.now(),
    storeSession(row.session),
    projectId(row.cwd),
    MACHINE_ID,
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
  return id;
}

/** Has this session already been shown this piece, by ANY hook? */
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

/** SessionStart: one INSERT OR IGNORE-shaped upsert. */
function touchSession(sessionId, cwd) {
  storeRun(STORE_SQL.touchSession, [
    storeSession(sessionId),
    projectId(cwd),
    typeof cwd === 'string' ? cwd : null,
    Date.now(),
    MACHINE_ID,
  ]);
}

/** Stop: stamp ended_at, creating the row if this machine never saw the start. */
function endSession(sessionId) {
  const now = Date.now();
  storeRun(STORE_SQL.endSession, [storeSession(sessionId), now, now, MACHINE_ID]);
}

// ---- searches (what searches.json used to hold) ----

/** A fan-out re-dispatches near-identical prompts; case and spacing carry no
 *  meaning here. Mirrored by lib/search-store.ts's own fingerprint. */
function searchFingerprint(question) {
  return String(question).toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 512);
}

function recordSearchRow(entry) {
  storeRun(STORE_SQL.recordSearch, [
    String(entry.searchId),
    typeof entry.at === 'number' ? entry.at : Date.now(),
    storeSession(entry.sessionId),
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

/** MISSes nothing has closed, newest first, inside \`sinceMs\`. */
function openLoops(sinceMs, limit) {
  return storeAll(STORE_SQL.openLoops, [sinceMs, limit]).map(searchRow);
}

/** A stored row in the shape the callers used to read out of searches.json. */
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
 * failure's signature and the row is what a later success closes.
 */
function openPairing(row) {
  const id = uid();
  storeRun(STORE_SQL.insertPairing, [
    id,
    Date.now(),
    storeSession(row.session),
    projectId(row.cwd),
    MACHINE_ID,
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
  return id;
}

/** The best local match for a signature: verified first, then most closed, then
 *  most recent. Fine key, then coarse — one indexed query does both. */
function findPairing(key, coarseKey) {
  const coarse = typeof coarseKey === 'string' && coarseKey.length > 0 ? coarseKey : '';
  const row = storeGet(STORE_SQL.findPairing, [String(key), coarse]);
  return row === null ? null : pairingRow(row);
}

function openPairingsForHead(cmdHead, beforeMs, limit) {
  return storeAll(STORE_SQL.openForHead, [String(cmdHead), beforeMs, limit]).map(pairingRow);
}

/**
 * Close one pairing. The FIRST close is \`unverified\` ("someone once fixed this
 * by touching X"); a SECOND independent one promotes it to \`verified\` and it
 * injects as a fix. The promotion is inside the UPDATE so two closes racing
 * cannot both read \`closes = 0\`.
 */
function closePairing(id, fixCmd, fixFiles, scope) {
  storeRun(STORE_SQL.closePairing, [
    Date.now(),
    typeof fixCmd === 'string' ? fixCmd : null,
    storeJson(fixFiles),
    String(scope),
    id,
  ]);
}

function pairingRow(row) {
  return {
    id: typeof row.id === 'number' ? row.id : 0,
    at: typeof row.at === 'number' ? row.at : 0,
    session: typeof row.session === 'string' ? row.session : '',
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
    .replaceAll('__SQL__', JSON.stringify(STORE_SQL, null, 2))
    .replaceAll('__DDL__', JSON.stringify(STORE_DDL))
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
    db.exec('PRAGMA journal_mode = wal');
    db.exec('PRAGMA synchronous = normal');
    if (storeVersionOf(db) !== STORE_USER_VERSION) {
      db.exec('BEGIN IMMEDIATE');
      try {
        if (storeVersionOf(db) !== STORE_USER_VERSION) {
          db.exec(STORE_DDL);
          db.exec(STORE_SQL.setUserVersion);
        }
        db.exec('COMMIT');
      } catch (err) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // Already rolled back by the failure itself.
        }
        throw err;
      }
    }
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
