import { chmodSync, statSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type { Attempt } from './held-lock';

/**
 * THE LINUX HALF OF A HELD LOCK. Node's standard library has no file lock the system releases
 * when its process ends, except through `node:sqlite`: an exclusive SQLite transaction on a
 * dedicated, never-written, never-deleted-while-held file. SQLite takes a POSIX byte-range lock
 * on it, which the kernel drops when the holder's process ends (a crash, SIGKILL, a container
 * restart) and which holds across pid namespaces. Nothing is taken over, no pid is read.
 *
 * FILE RULES. Nothing but this module opens, reads or writes the lock file in a process that may
 * hold it: closing ANY other descriptor of the file drops the process's POSIX locks. SQLite's own
 * connections are safe. A lock database is never written, so it has no journal.
 */
export type Sqlite = typeof import('node:sqlite');

let loaded: Sqlite | null | undefined;
/** Forgets what was loaded. For tests only. */
export function forgetSqlite() {
  loaded = undefined;
}
/**
 * `node:sqlite`, loaded the first time a Linux lock is needed and nowhere else: null when this
 * Node has none (before 22.13 it needs a flag). Node 22.13 to 24.14 print an ExperimentalWarning
 * on load, which would reach hook or MCP stderr, so that one warning is dropped.
 */
export function loadSqlite(): Sqlite | null {
  if (loaded !== undefined) return loaded;
  const original = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : (warning?.message ?? '');
    if (/sqlite/i.test(text)) return;
    return (original as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    loaded = process.getBuiltinModule?.('node:sqlite') ?? null;
  } catch {
    loaded = null;
  } finally {
    process.emitWarning = original;
  }
  return loaded;
}

/** SQLITE_BUSY (5), including its extended codes. */
function isBusy(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { errcode, message } = error as { errcode?: unknown; message?: unknown };
  if (typeof errcode === 'number') return errcode % 256 === 5;
  return typeof message === 'string' && /database is locked/i.test(message);
}

const inoOf = (file: string): number | undefined => {
  try {
    return statSync(file).ino;
  } catch {
    return undefined;
  }
};

/** One acquisition: one connection, `BEGIN EXCLUSIVE` retried on it, `ROLLBACK` and close to release. */
export function sqliteAttempt(file: string, sqlite: Sqlite): Attempt {
  let db: DatabaseSync | undefined;
  let ino: number | undefined;
  const close = () => {
    try {
      db?.close();
    } catch {
      // Already closed.
    }
    db = undefined;
  };
  return {
    tryOnce() {
      // The parent folder must exist. Opening creates the zero-byte file and takes no lock.
      if (!db) {
        db = new sqlite.DatabaseSync(file);
        // SQLite creates the file with the umask's mode; the lock file is the user's alone. A
        // chmod opens no descriptor, so it cannot drop a lock this process holds.
        chmodSync(file, 0o600);
        ino = inoOf(file);
      }
      try {
        db.exec('BEGIN EXCLUSIVE');
      } catch (error) {
        if (isBusy(error)) return null;
        // SQLite refuses a file that was moved or deleted under it (a disk I/O error): the lock
        // file is a new one, so start over on it.
        const moved = inoOf(file) !== ino;
        close();
        if (moved) return this.tryOnce();
        throw error;
      }
      // A file deleted after this connection opened it (by the job sweep) is another inode: the
      // lock held on this one guards nothing, so start over on the new file.
      if (inoOf(file) !== ino) {
        try {
          db.exec('ROLLBACK');
        } finally {
          close();
        }
        return this.tryOnce();
      }
      const held = db;
      db = undefined;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          held.exec('ROLLBACK');
        } finally {
          held.close();
        }
      };
    },
    abandon: close,
  };
}
