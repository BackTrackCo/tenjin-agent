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
import { linuxAttempt, reapLockDir, reapPrepared } from './held-lock-linux';
import { LockTimeoutError } from './lock';

/**
 * A LOCK THAT ENDS WITH THE PROCESS THAT HOLDS IT. Nothing is ever taken over from a live
 * process, and a dead holder never blocks for good:
 *
 * - macOS and Windows: an exclusive open of the never-written `<path>.held` file. The system
 *   drops the lock when the holder's process ends, at whatever line it dies.
 * - Linux: a named-entry directory `<path>.held` (see `held-lock-linux.ts`), where a waiter
 *   clears the entry of a process that is certainly gone, and of no other.
 *
 * Callers pass the lock path WITHOUT the suffix and never branch on the platform. A held lock
 * file is never opened, read or deleted by anything else in a process that may hold it: on
 * Windows a second open fails, and on every platform a sweep may remove a lock file only through
 * {@link discardHeldLock}.
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
    this.message =
      process.platform === 'linux'
        ? `Timed out waiting for lock ${lockPath} after ${timeoutMs}ms. Another Tenjin process holds it. If no Tenjin process runs on this machine or in a container that shares this folder, remove ${lockPath} and retry.`
        : `Timed out waiting for lock ${lockPath} after ${timeoutMs}ms. Another Tenjin process holds it, and the lock ends when that process ends.`;
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

/** One acquisition: `tryOnce` is one attempt, and `abandon` cleans up after a failed wait. */
export interface Attempt {
  tryOnce(): (() => void) | null;
  abandon(): void;
}
export type AttemptFactory = (heldPath: string) => Attempt;

/** Whether a file name in a store is a lock file or a leftover of one being made. */
export const isHeldLockName = (name: string) => /\.held(\.new-[0-9a-f]+)?$/.test(name);

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
  if (platform === 'linux') return (held) => linuxAttempt(held);
  return () => {
    throw new LockUnavailableError(`Tenjin cannot lock files on ${platform}`);
  };
}
const factory = defaultFactory();

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
 * Removes a lock file no one holds, for the job sweep: macOS probes, unlinks while holding and
 * then closes; Windows probes, closes and then unlinks, ignoring a lost race; Linux clears an
 * empty directory or one whose only entry is gone. A lock that is held is left alone. True when
 * the lock is gone afterwards.
 */
export async function discardHeldLock(lockPath: string): Promise<boolean> {
  const held = `${lockPath}.held`;
  if (process.platform === 'linux') return reapLockDir(held);
  let release: () => void;
  try {
    release = await holdLockWith(factory, lockPath, { timeoutMs: 0 });
  } catch (error) {
    if (error instanceof LockTimeoutError) return false;
    throw error;
  }
  if (process.platform === 'darwin') {
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
 * Housekeeping for the lock files in `dir`. A prepared directory of a killed Linux acquirer is
 * removed when its only entry is gone. Every other `*.held` name is discarded through
 * {@link discardHeldLock} when `eligible` says so (the sweep passes only what belongs to a job
 * that is final and idle). Never throws.
 */
export async function sweepHeldLocks(
  dir: string,
  eligible: (name: string) => Promise<boolean>,
  limit = 50_000,
): Promise<void> {
  try {
    let seen = 0;
    for await (const entry of await opendir(dir)) {
      if (++seen > limit) return;
      const path = join(dir, entry.name);
      if (/\.held\.new-[0-9a-f]+$/.test(entry.name)) {
        if (process.platform === 'linux' && entry.isDirectory()) reapPrepared(path);
        continue;
      }
      if (!entry.name.endsWith('.held')) continue;
      if (await eligible(entry.name).catch(() => false))
        await discardHeldLock(path.slice(0, -'.held'.length)).catch(() => false);
    }
  } catch {
    // Housekeeping only.
  }
}
