import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { loopDbPath } from '../lib/paths';
import { DAEMON_BUSY_TIMEOUT_MS } from './constants';

/**
 * `loop.db`: the daemon's ledger and gate state (02-redesign.md §10).
 *
 * ONE WRITER ON THE HOOK PATH. The daemon is the only process that writes
 * `fires`, `legs` and `marks`; the CLI opens the file directly (PR E)
 * to read them and to write its own tables, rarely and briefly. That is why
 * there is no bootstrap lock, no busy-wait tier and no WAL retry here (compare
 * `state-store.ts` `openStore`, written for eight processes racing one file):
 * `busy_timeout` alone covers the CLI's occasional write.
 *
 * NO `user_version` LADDER AND NO MIGRATION. Nothing before launch has readers
 * to migrate; `CREATE TABLE IF NOT EXISTS` per table, and a shape change means
 * DELETE `loop.db`, which is what a column added or dropped here (PR C's
 * `legs.calibration`, PR C's dropped `actors`) costs. Each PR creates only the
 * tables it writes; `handoff`, `facts` and `pairings` come with the PRs that
 * first write them.
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
  /** `busy_timeout` in ms. The daemon's default; the CLI passes its own (PR E). */
  busyTimeoutMs?: number;
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
    // Deleted with its WAL companions: a stale `-wal` would replay the old shape
    // straight back into the new file. Exactly once — the rebuilt file is this
    // build's DDL by construction, so a second mismatch would be a bug in
    // LOOP_SHAPE and must not become a loop that deletes the ledger every open.
    db.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
    db = open();
  }
  db.exec(LOOP_DDL);
  return db;
}

/** Row shapes as `all()`/`get()` return them (null-prototype objects). */
export type Row = Record<string, unknown>;
