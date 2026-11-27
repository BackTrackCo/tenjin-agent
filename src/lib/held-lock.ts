import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  statSync,
  unlinkSync,
  type Stats,
} from 'node:fs';
import { opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { hasCode } from './errno';
import { loadSqlite, sqliteAttempt } from './held-lock-sqlite';
import { LockTimeoutError } from './lock';

/**
 * A LOCK THAT ENDS WITH THE PROCESS THAT HOLDS IT. Nothing is ever taken over from a live
 * process, and a dead holder never blocks for good:
 *
 * - macOS and Windows: an exclusive open of the never-written `<path>.held` file. The system
 *   drops the lock when the holder's process ends, at whatever line it dies.
 * - Linux: an exclusive SQLite transaction on the same never-written file (`node:sqlite`, see
 *   `held-lock-sqlite.ts`), which the kernel drops when the holder's process ends.
 *
 * Callers pass the lock path WITHOUT the suffix and never branch on the platform. A held lock
 * file is never opened, read or deleted by anything else in a process that may hold it: on
 * Windows a second open fails. A sweep may remove a lock file only through
 * {@link discardHeldLock}, which never removes a Linux (SQLite) lock file.
 */

/** The platform or filesystem cannot lock. */
export class LockUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockUnavailableError';
  }
}

/** The wait for a held lock ran out. A live process holds it, so nothing here is stale. */
export class HeldLockTimeoutError extends LockTimeoutError {
  constructor(lockPath: string, timeoutMs: number) {
    super(lockPath, timeoutMs);
    const held = `${lockPath}.held`;
    // The lock file itself is what is held: it is never removed by hand.
    (this as { lockPath: string }).lockPath = held;
    this.message = `Timed out waiting for lock ${held} after ${timeoutMs}ms. Another Tenjin process holds it, and the lock ends when that process ends; do not delete the file.`;
  }
}

export interface HeldLockOptions {
  /** Give up after this long (ms), on a monotonic clock. 0 is one attempt, a probe. Default 5000. */
  timeoutMs?: number;
  /** Poll interval while the lock is held (ms). Default 25. */
  retryMs?: number;
  /** Stops waiting. Once the lock is held, the caller owns cancellation. */
  signal?: AbortSignal;
}

/**
 * One acquisition: `tryOnce` is one attempt, and `abandon` cleans up after a failed wait.
 * `deletable` says whether a cleanup may delete the primitive's file at all.
 */
export interface Attempt {
  tryOnce(): (() => void) | null;
  abandon(): void;
  readonly deletable: boolean;
}
export type AttemptFactory = (heldPath: string) => Attempt;

/** Whether a file name in a store is a lock file. */
export const isHeldLockName = (name: string) => name.endsWith('.held');

/** The exclusive-open flags, numeric because Node exports neither `O_EXLOCK` nor libuv's. */
const O_EXLOCK_DARWIN = 0x20;
const UV_FS_O_EXLOCK_WIN32 = 0x10000000;

export interface OpenDeps {
  platform: 'darwin' | 'win32';
  open(path: string, flags: number, mode: number): number;
  close(fd: number): void;
  fstat(fd: number): Stats;
  stat(path: string): Stats;
}

export const systemOpenDeps = (platform: 'darwin' | 'win32'): OpenDeps => ({
  platform,
  open: openSync,
  close: closeSync,
  fstat: fstatSync,
  stat: (path) => statSync(path),
});

/** The error that says the file is held by another exclusive open. */
const isHeld = (platform: 'darwin' | 'win32', error: unknown) =>
  platform === 'darwin'
    ? hasCode(error, 'EAGAIN') || hasCode(error, 'EWOULDBLOCK')
    : hasCode(error, 'EBUSY');

const INODE_RETRIES = 5;
/** Once per process: a Node that ignores the flag fails every later lock the same way. */
let selfTestState: 'untested' | 'passed' | 'failed' = 'untested';

/** Exclusive open of `file`, for macOS and Windows. */
export function openAttempt(file: string, deps: OpenDeps): Attempt {
  const flags =
    deps.platform === 'darwin'
      ? constants.O_RDWR |
        constants.O_CREAT |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK |
        O_EXLOCK_DARWIN
      : constants.O_RDWR | constants.O_CREAT | UV_FS_O_EXLOCK_WIN32;
  const openOnce = (): number | null => {
    try {
      return deps.open(file, flags, 0o600);
    } catch (error) {
      if (isHeld(deps.platform, error)) return null;
      // The filesystem has no locks: fail closed with a name for it.
      if (hasCode(error, 'EOPNOTSUPP') || hasCode(error, 'ENOTSUP'))
        throw new LockUnavailableError(`This filesystem cannot lock ${file}`);
      throw error;
    }
  };
  return {
    tryOnce() {
      for (let attempt = 0; attempt < INODE_RETRIES; attempt++) {
        if (selfTestState === 'failed') throw new LockUnavailableError(NO_FLAG);
        const fd = openOnce();
        if (fd === null) return null;
        // A file deleted (or replaced) between the open and now is another inode: the lock on
        // this one guards nothing, so open again.
        let same: boolean;
        try {
          same = deps.fstat(fd).ino === deps.stat(file).ino;
        } catch {
          same = false;
        }
        if (!same) {
          deps.close(fd);
          continue;
        }
        if (selfTestState === 'untested') {
          selfTest(fd, openOnce, deps);
          selfTestState = 'passed';
        }
        let closed = false;
        return () => {
          if (closed) return;
          closed = true;
          deps.close(fd);
        };
      }
      return null;
    },
    abandon() {
      // Nothing is held between attempts.
    },
    // The holder's own descriptor is compared with the path, and both files are alive at that
    // moment, so they cannot share an inode number: a lock on a deleted file is always seen.
    deletable: true,
  };
}

const NO_FLAG = 'This Node does not honour the exclusive-open flag, so Tenjin cannot lock files.';

/** A second exclusive open of the held file must fail as held; a Node that ignores the flag fails loudly. */
function selfTest(fd: number, openOnce: () => number | null, deps: OpenDeps) {
  let second: number | null;
  try {
    second = openOnce();
  } catch (error) {
    deps.close(fd);
    throw error;
  }
  if (second === null) return;
  deps.close(second);
  deps.close(fd);
  selfTestState = 'failed';
  throw new LockUnavailableError(NO_FLAG);
}

/** Forgets the self-test result. For tests only. */
export function resetSelfTest() {
  selfTestState = 'untested';
}

function defaultFactory(): AttemptFactory {
  const { platform } = process;
  if (platform === 'darwin' || platform === 'win32')
    return (held) => openAttempt(held, systemOpenDeps(platform));
  if (platform === 'linux')
    return (held) => {
      const sqlite = loadSqlite();
      if (!sqlite) throw new LockUnavailableError(sqliteMissing());
      return sqliteAttempt(held, sqlite);
    };
  return () => {
    throw new LockUnavailableError(`Tenjin cannot lock files on ${platform}`);
  };
}
const factory = defaultFactory();

const sqliteMissing = (version: string = process.versions.node) =>
  `Subagent workers on Linux need Node 22.13 or later; this is Node ${version}.`;

/** The first Node whose `node:sqlite` loads with no flag. */
const SQLITE_FROM = [22, 13, 0] as const;
const atLeastSqliteNode = (version: string) => {
  const [major = 0, minor = 0, patch = 0] = version.split('.').map(Number);
  const have = [major, minor, patch];
  for (const [index, need] of SQLITE_FROM.entries())
    if (have[index]! !== need) return have[index]! > need;
  return true;
};

/**
 * Whether this platform and Node can take a held lock, and if not, one sentence why. Linux needs
 * the built-in node:sqlite (Node 22.13 or later); macOS and Windows need nothing. `nodeVersion`
 * is the version of the Node that will take the lock when that is not this process: a terminal
 * command judging the Node of Tenjin's own runtime, which runs the plugin and its workers.
 */
export function lockSupport(nodeVersion?: string): { ok: true } | { ok: false; reason: string } {
  const { platform } = process;
  if (platform === 'darwin' || platform === 'win32') return { ok: true };
  if (platform === 'linux') {
    if (nodeVersion !== undefined)
      return atLeastSqliteNode(nodeVersion)
        ? { ok: true }
        : { ok: false, reason: sqliteMissing(nodeVersion) };
    return loadSqlite() ? { ok: true } : { ok: false, reason: sqliteMissing() };
  }
  return { ok: false, reason: `Tenjin cannot lock files on ${platform}.` };
}

/**
 * The wait loop shared by every platform. Takes the lock, or throws {@link HeldLockTimeoutError}
 * after `timeoutMs` on a monotonic clock, or throws the signal's reason once it aborts. The
 * returned release is idempotent.
 */
export async function holdLockWith(
  make: AttemptFactory,
  lockPath: string,
  o: HeldLockOptions = {},
): Promise<() => void> {
  const { timeoutMs = 5000, retryMs = 25, signal } = o;
  const deadline = performance.now() + timeoutMs;
  const attempt = make(`${lockPath}.held`);
  try {
    for (;;) {
      signal?.throwIfAborted();
      const release = attempt.tryOnce();
      if (release) return release;
      if (performance.now() >= deadline) throw new HeldLockTimeoutError(lockPath, timeoutMs);
      await delay(retryMs, undefined, { signal });
    }
  } catch (error) {
    attempt.abandon();
    throw error;
  }
}

export const holdLock = (lockPath: string, o?: HeldLockOptions) =>
  holdLockWith(factory, lockPath, o);

export async function withHeldLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  o?: HeldLockOptions,
): Promise<T> {
  const release = await holdLock(lockPath, o);
  try {
    return await fn();
  } finally {
    release();
  }
}

/**
 * Removes a lock file no one holds, for the job sweep, except a Linux (SQLite) lock file, which
 * is never removed: this returns false for it. macOS probes, unlinks while holding and then
 * closes (an opener that resolved the old file sees its own descriptor's inode differ from the
 * path's, and starts over); Windows probes, closes and then unlinks, and an opener that slipped
 * in keeps a valid lock on a file that stays, because Windows deletes no file a holder has open. A lock
 * that is held is left alone. True when the lock is gone afterwards. `make` is the primitive;
 * only tests pass another.
 *
 * Why Linux keeps its lock files: a SQLite connection cannot show which file it has open, so a
 * taker can compare only the path's inode number before its open with the number after it holds
 * the lock. If the file was deleted in between and another took its place, ext4 can give a later
 * replacement the freed number back. The taker then holds a deleted file while another process
 * holds the one the path names: two holders, with no way to see it from the path. If no code
 * deletes a lock file, that cannot happen. The cost is a few empty files for each job.
 */
export async function discardHeldLock(
  lockPath: string,
  make: AttemptFactory = factory,
): Promise<boolean> {
  const held = `${lockPath}.held`;
  const attempt = make(held);
  if (!attempt.deletable) return false;
  let release: () => void;
  try {
    release = await holdLockWith(() => attempt, lockPath, { timeoutMs: 0 });
  } catch (error) {
    if (error instanceof LockTimeoutError) return false;
    throw error;
  }
  if (process.platform !== 'win32') {
    try {
      unlinkSync(held);
      return true;
    } catch (error) {
      return hasCode(error, 'ENOENT');
    } finally {
      release();
    }
  }
  release();
  try {
    unlinkSync(held);
    return true;
  } catch (error) {
    // An opener slipped in and keeps a valid lock.
    return hasCode(error, 'ENOENT');
  }
}

/**
 * Housekeeping for the lock files in `dir`: a `*.held` name is discarded through
 * {@link discardHeldLock} when `eligible` says so (the sweep passes only what belongs to a job
 * that is final and idle). Never throws.
 */
export async function sweepHeldLocks(
  dir: string,
  eligible: (name: string) => Promise<boolean>,
  limit = 50_000,
  make: AttemptFactory = factory,
): Promise<void> {
  try {
    let seen = 0;
    for await (const entry of await opendir(dir)) {
      if (++seen > limit) return;
      const path = join(dir, entry.name);
      if (!entry.name.endsWith('.held')) continue;
      if (await eligible(entry.name).catch(() => false))
        await discardHeldLock(path.slice(0, -'.held'.length), make).catch(() => false);
    }
  } catch {
    // Housekeeping only.
  }
}
