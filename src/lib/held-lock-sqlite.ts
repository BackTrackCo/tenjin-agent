import { chmodSync, statSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { hasCode } from './errno';
import type { Attempt } from './held-lock';

/**
 * THE LINUX HALF OF A HELD LOCK. Node's standard library has no file lock the system releases
 * when its process ends, except through `node:sqlite`: an exclusive SQLite transaction on a
 * dedicated, never-written, never-deleted file (see `discardHeldLock`). SQLite takes a POSIX
 * byte-range lock on it, which the kernel drops when the holder's process ends (a crash, SIGKILL,
 * a container restart) and which holds across pid namespaces. Nothing is taken over, no pid is
 * read.
 *
 * FILE RULES. Nothing but this module opens, reads or writes the lock file in a process that may
 * hold it: closing ANY other descriptor of the file drops the process's POSIX locks. SQLite's own
 * connections are safe. A lock database is never written, and its journal lives in memory, so
 * a take creates no side file.
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

/**
 * Every connection that holds a lock, until its release runs. A connection that nothing
 * references is closed at garbage collection, which drops its lock; the caller's release is the
 * only other reference, and a caller that loses it must not lose the lock.
 */
const live = new Set<DatabaseSync>();
/** How many locks this process holds through SQLite. For tests only. */
export const heldConnections = () => live.size;

const INODE_RETRIES = 5;

/**
 * One acquisition: one connection, `BEGIN EXCLUSIVE` retried on it, `ROLLBACK` and close to release.
 *
 * Tenjin never deletes this file (see `discardHeldLock`): a connection cannot show which file it
 * has open, so no check can make a deletion safe. The two inode reads below only catch a file
 * that something outside Tenjin removed and that came back with another inode number:
 *
 * 1. The taker reads the file's inode BEFORE it opens the file, and creates the file first when
 *    there is none. Read after the open, the path could already name a replacement.
 * 2. Once it holds the lock it reads the path again. Another inode (or none) means the file it
 *    holds is gone, so it lets go and starts over.
 *
 * A replacement that got the old inode number back (ext4 reuses a freed number at once) passes
 * both reads, which is why nothing in Tenjin deletes a lock file on Linux.
 */
export function sqliteAttempt(file: string, sqlite: Sqlite): Attempt {
  let db: DatabaseSync | undefined;
  let ino: number | undefined;
  /** Whether the pending connection already runs with its journal in memory. */
  let memoryJournal = false;
  const close = () => {
    try {
      db?.close();
    } catch {
      // Already closed.
    }
    db = undefined;
    memoryJournal = false;
  };
  /** Opens a connection on the file, creating it. The parent folder must exist. */
  const open = () => {
    const connection = new sqlite.DatabaseSync(file);
    // SQLite creates the file with the umask's mode; the lock file is the user's alone. A
    // chmod opens no descriptor, so it cannot drop a lock this process holds.
    chmodSync(file, 0o600);
    return connection;
  };
  const once = (): (() => void) | null | 'again' => {
    if (!db) {
      try {
        ino = inoOf(file);
        if (ino === undefined) {
          // No file to compare with yet: make it, then read its inode before the real open.
          open().close();
          ino = inoOf(file);
          if (ino === undefined) return 'again';
        }
        db = open();
      } catch (error) {
        // The file was removed between the open and the chmod: start over.
        if (hasCode(error, 'ENOENT')) return 'again';
        throw error;
      }
    }
    try {
      // A journal in memory: the default writes a `-journal` side file at `BEGIN EXCLUSIVE`,
      // which a read-only folder or a full disk refuses. The pragma needs the database, so it
      // is busy while another process holds the lock, and is retried with the lock.
      if (!memoryJournal) {
        db.exec('PRAGMA journal_mode=MEMORY');
        memoryJournal = true;
      }
      db.exec('BEGIN EXCLUSIVE');
    } catch (error) {
      if (isBusy(error)) return null;
      // SQLite refuses a file that was moved or deleted under it (a disk I/O error): the lock
      // file is a new one, so start over on it.
      const moved = inoOf(file) !== ino;
      close();
      if (moved) return 'again';
      throw error;
    }
    if (inoOf(file) !== ino) {
      try {
        db.exec('ROLLBACK');
      } finally {
        close();
      }
      return 'again';
    }
    const held = db;
    db = undefined;
    live.add(held);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      try {
        held.exec('ROLLBACK');
      } finally {
        live.delete(held);
        held.close();
      }
    };
  };
  return {
    tryOnce() {
      for (let attempt = 0; attempt < INODE_RETRIES; attempt++) {
        const result = once();
        if (result !== 'again') return result;
      }
      return null;
    },
    abandon: close,
    deletable: false,
  };
}
