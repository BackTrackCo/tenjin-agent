import { chmodSync, mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { loopDbPath } from '../lib/paths';
import { DAEMON_BUSY_TIMEOUT_MS } from './constants';

/**
 * `loop.db`: the daemon's ledger and gate state (02-redesign.md §10).
 *
 * ONE WRITER ON THE HOOK PATH. The daemon is the only process that writes
 * `actors`, `fires`, `legs` and `marks`; the CLI opens the file directly (PR E)
 * to read them and to write its own tables, rarely and briefly. That is why
 * there is no bootstrap lock, no busy-wait tier and no WAL retry here (compare
 * `state-store.ts` `openStore`, written for eight processes racing one file):
 * `busy_timeout` alone covers the CLI's occasional write.
 *
 * NO `user_version` LADDER. Nothing before launch has readers to migrate;
 * `CREATE TABLE IF NOT EXISTS` per table, and a shape change means delete the
 * file. PR B creates only the tables it writes; `handoff`, `facts` and
 * `pairings` are created by the PRs that first write them.
 *
 * Gate state is written SYNCHRONOUSLY per fire (`DatabaseSync` under WAL with
 * `synchronous=normal` is tens of microseconds a statement). Only the ledger row
 * is written after the response flushes (`ledger.ts`).
 */

export const LOOP_DDL = `
CREATE TABLE IF NOT EXISTS actors (
  session TEXT NOT NULL,
  agent   TEXT NOT NULL DEFAULT '',
  arm     TEXT NOT NULL,
  tat     INTEGER NOT NULL,
  PRIMARY KEY (session, agent, arm)
);
CREATE TABLE IF NOT EXISTS fires (
  id          TEXT PRIMARY KEY,
  at          INTEGER NOT NULL,
  session     TEXT NOT NULL,
  agent       TEXT NOT NULL DEFAULT '',
  arm         TEXT NOT NULL,
  harness     TEXT NOT NULL,
  event       TEXT NOT NULL,
  prompt_id   TEXT,
  cwd         TEXT NOT NULL DEFAULT '',
  wait        TEXT NOT NULL,
  deadline_ms INTEGER NOT NULL,
  elapsed_ms  INTEGER NOT NULL,
  reason      TEXT NOT NULL,
  fingerprint TEXT,
  question    TEXT,
  delivered   TEXT,
  emit        TEXT
);
CREATE INDEX IF NOT EXISTS fires_at ON fires (at);
CREATE INDEX IF NOT EXISTS fires_actor ON fires (session, agent, at);
CREATE TABLE IF NOT EXISTS legs (
  fire_id    TEXT NOT NULL REFERENCES fires(id) ON DELETE CASCADE,
  stage      INTEGER NOT NULL,
  shelf      TEXT NOT NULL,
  status     TEXT NOT NULL,
  outcome    TEXT,
  elapsed_ms INTEGER NOT NULL,
  search_id  TEXT,
  title      TEXT,
  url        TEXT,
  form       TEXT,
  graded     TEXT,
  posted_at  INTEGER,
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
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA busy_timeout = ${opts.busyTimeoutMs ?? DAEMON_BUSY_TIMEOUT_MS}`);
  db.exec('PRAGMA auto_vacuum = INCREMENTAL');
  db.exec('PRAGMA journal_mode = wal');
  db.exec('PRAGMA synchronous = normal');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(LOOP_DDL);
  try {
    chmodSync(path, 0o600);
  } catch {
    // Defence in depth under a 0700 directory, not the guard.
  }
  return db;
}

/** Row shapes as `all()`/`get()` return them (null-prototype objects). */
export type Row = Record<string, unknown>;
