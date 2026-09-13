import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { loopDbPath } from '../lib/paths';
import { DAEMON_BUSY_TIMEOUT_MS } from './constants';

/**
 * `loop.db`: the daemon's ledger and gate state (02-redesign.md §10).
 *
 * ONE WRITER ON THE HOOK PATH. The daemon is the only process that writes
 * `fires`, `legs` and `marks`; the CLI opens the file directly (`lib/loop-db.ts`)
 * to read them and to write its own tables — `searches` is the CLI's, one row per
 * `tenjin search` — rarely and briefly. That is why there is no bootstrap lock,
 * no busy-wait tier and no WAL retry here: `busy_timeout` alone covers the CLI's
 * occasional write.
 *
 * NO `user_version` LADDER AND NO MIGRATION. Nothing before launch has readers
 * to migrate; `CREATE TABLE IF NOT EXISTS` per table, and a shape change means
 * DELETE `loop.db`, which is what a column added or dropped here (PR C's
 * `legs.calibration`, PR C's dropped `actors`) costs. Each PR creates only the
 * tables it writes: PR D's `handoff` and `facts`.
 *
 * AND THE DELETE HAPPENS HERE, because nothing else does it: `CREATE TABLE IF
 * NOT EXISTS` is silent about a table whose columns have changed, and the row
 * that would then fail to insert takes its whole fire's ledger entry with it —
 * a ledger that looks alive while every real lookup vanishes. So the columns on
 * disk are compared against {@link LOOP_SHAPE} at open and a file that does not
 * match is deleted and rebuilt. This is the no-migration rule implemented, not
 * a ladder: state older than the current shape is thrown away, never carried.
 *
 * Gate state is written SYNCHRONOUSLY per fire (`DatabaseSync` under WAL with
 * `synchronous=normal` is tens of microseconds a statement). Only the ledger row
 * is written after the response flushes (`ledger.ts`).
 */

export const LOOP_DDL = `
-- THESE TWO DROPS ARE PERMANENT, NOT A MIGRATION STEP. The mechanical
-- error-to-fix lane is gone, so neither table is in LOOP_SHAPE any more -- and
-- shapeMatches only inspects what LOOP_SHAPE lists, so a file still carrying
-- them passes the shape check and is never rebuilt. Without these two lines the
-- tables would sit on disk on every machine that ever ran the lane, forever,
-- holding masked error lines and command strings nothing reads. There is
-- nowhere else it could be done: there is no migration ladder by design, and
-- the rebuild path fires only on a shape MISMATCH.
--
-- One hazard, taken knowingly: this DDL runs on every open, the CLI's included,
-- so a new-build CLI in one worktree drops the tables under an old-build daemon
-- holding the same file open in another, and that daemon's next pairing insert
-- throws until it is restarted. The alternative is never dropping them.
--
-- No index drops: SQLite takes pairings_key_status and pairings_open_head with
-- their table.
DROP TABLE IF EXISTS pairings;
DROP TABLE IF EXISTS pairing_closes;
CREATE TABLE IF NOT EXISTS fires (
  id           TEXT PRIMARY KEY,
  at           INTEGER NOT NULL,
  session      TEXT NOT NULL,
  agent        TEXT NOT NULL DEFAULT '',
  arm          TEXT NOT NULL,
  harness      TEXT NOT NULL,
  event        TEXT NOT NULL,
  prompt_id    TEXT,
  cwd          TEXT NOT NULL DEFAULT '',
  wait         TEXT NOT NULL,
  deadline_ms  INTEGER NOT NULL,
  elapsed_ms   INTEGER NOT NULL,
  reason       TEXT NOT NULL,
  question_key TEXT,
  question     TEXT,
  delivered    TEXT,
  emit         TEXT,
  error        TEXT
);
CREATE INDEX IF NOT EXISTS fires_at ON fires (at);
CREATE INDEX IF NOT EXISTS fires_actor ON fires (session, agent, at);
CREATE TABLE IF NOT EXISTS legs (
  fire_id     TEXT NOT NULL REFERENCES fires(id) ON DELETE CASCADE,
  stage       INTEGER NOT NULL,
  shelf       TEXT NOT NULL,
  status      TEXT NOT NULL,
  outcome     TEXT,
  elapsed_ms  INTEGER NOT NULL,
  search_id   TEXT,
  title       TEXT,
  url         TEXT,
  form        TEXT,
  calibration TEXT,
  graded      TEXT,
  posted_at   INTEGER,
  PRIMARY KEY (fire_id, stage, shelf)
);
CREATE TABLE IF NOT EXISTS marks (
  session TEXT NOT NULL,
  agent   TEXT NOT NULL DEFAULT '',
  key     TEXT NOT NULL,
  value   TEXT NOT NULL,
  at      INTEGER NOT NULL,
  PRIMARY KEY (session, agent, key)
);
CREATE TABLE IF NOT EXISTS handoff (
  id        INTEGER PRIMARY KEY,
  session   TEXT NOT NULL,
  prompt_id TEXT,
  at        INTEGER NOT NULL,
  question  TEXT NOT NULL,
  search_id TEXT,
  answer    TEXT
);
CREATE INDEX IF NOT EXISTS handoff_claim ON handoff (session, prompt_id, at);
CREATE TABLE IF NOT EXISTS facts (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS searches (
  search_id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  session TEXT NOT NULL,
  agent_id TEXT,
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
`;

/**
 * The columns each table must have, in DDL order — the whole of what "the same
 * shape" means. A table missing from the file is created; one that has it in a
 * different shape means the file is from another build.
 */
const LOOP_SHAPE: Record<string, readonly string[]> = {
  fires: [
    'id',
    'at',
    'session',
    'agent',
    'arm',
    'harness',
    'event',
    'prompt_id',
    'cwd',
    'wait',
    'deadline_ms',
    'elapsed_ms',
    'reason',
    'question_key',
    'question',
    'delivered',
    'emit',
    'error',
  ],
  legs: [
    'fire_id',
    'stage',
    'shelf',
    'status',
    'outcome',
    'elapsed_ms',
    'search_id',
    'title',
    'url',
    'form',
    'calibration',
    'graded',
    'posted_at',
  ],
  marks: ['session', 'agent', 'key', 'value', 'at'],
  handoff: ['id', 'session', 'prompt_id', 'at', 'question', 'search_id', 'answer'],
  facts: ['key', 'value', 'at'],
  searches: [
    'search_id',
    'at',
    'session',
    'agent_id',
    'question',
    'fingerprint',
    'decision',
    'candidates',
    'source',
    'shelf_base_url',
    'paid_browse_count',
    'resolved_by',
    'resolved_at',
  ],
};

/** Does every table this build knows about have exactly the columns it expects? */
function shapeMatches(db: LoopDb): boolean {
  for (const [table, columns] of Object.entries(LOOP_SHAPE)) {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>;
    if (rows.length === 0) continue; // not created yet; the DDL is about to.
    const found = rows.map((r) => String(r.name));
    if (found.length !== columns.length || columns.some((c, i) => found[i] !== c)) return false;
  }
  return true;
}

export type LoopDb = DatabaseSync;

export interface OpenLoopDbOptions {
  /** `busy_timeout` in ms. The daemon's default; the CLI passes its own. */
  busyTimeoutMs?: number;
  /**
   * Delete and rebuild a file whose shape is not this build's. The daemon owns
   * the ledger, so it does; the CLI (`lib/loop-db.ts`) passes false, because a
   * CLI of one build must never unlink the ledger a daemon of another build is
   * writing — two worktrees on one laptop is the ordinary case. There the
   * mismatch is reported instead, and the file is left exactly as it was.
   */
  rebuild?: boolean;
}

/**
 * Open (creating if needed) `loop.db` under `dataDir`. Pragma order matters:
 * `busy_timeout` first so the WAL switch can wait on a CLI writer;
 * `auto_vacuum` before any table exists, because it cannot be switched later
 * without a full VACUUM; `foreign_keys` on so `legs` follow their `fires` row
 * through retention's deletes.
 */
export function openLoopDb(dataDir: string, opts: OpenLoopDbOptions = {}): LoopDb {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const path = loopDbPath(dataDir);
  const open = (): LoopDb => {
    const db = new DatabaseSync(path);
    try {
      // Before the WAL switch, so `-wal` and `-shm` inherit 0600 too (SQLite
      // copies the main file's mode). Defence in depth under a 0700 directory.
      chmodSync(path, 0o600);
    } catch {
      // Not the guard.
    }
    db.exec(`PRAGMA busy_timeout = ${opts.busyTimeoutMs ?? DAEMON_BUSY_TIMEOUT_MS}`);
    db.exec('PRAGMA auto_vacuum = INCREMENTAL');
    db.exec('PRAGMA journal_mode = wal');
    db.exec('PRAGMA synchronous = normal');
    db.exec('PRAGMA foreign_keys = ON');
    return db;
  };

  let db = open();
  if (!shapeMatches(db)) {
    db.close();
    if (opts.rebuild === false) {
      throw new Error('loop.db is from another build; run tenjin daemon stop and retry');
    }
    // Deleted with its WAL companions: a stale `-wal` would replay the old shape
    // straight back into the new file. Exactly once — the rebuilt file is this
    // build's DDL by construction, so a second mismatch would be a bug in
    // LOOP_SHAPE and must not become a loop that deletes the ledger every open.
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
    db = open();
  }
  db.exec(LOOP_DDL);
  return db;
}

/** Row shapes as `all()`/`get()` return them (null-prototype objects). */
export type Row = Record<string, unknown>;
