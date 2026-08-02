import { rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Locks this process currently holds. Ownership starts the instant `mkdir`
 * succeeds and ends in the release, so there is no window where a lock is on disk
 * and unaccounted for.
 *
 * It exists because the default signal action terminates WITHOUT running
 * `finally`: without this, one Ctrl-C leaves a lock nothing will ever clean and
 * every later run of the same command times out on it.
 */
const owned = new Set<string>();

/** Does this process hold any lock right now? */
export function ownsAnyLock(): boolean {
  return owned.size > 0;
}

/**
 * Synchronously release every lock this process holds. Safe to call from a signal
 * handler, and a no-op when this process holds none, so a run that was merely
 * QUEUED behind another cannot remove that other run's lock.
 */
export function releaseOwnedLocks(): void {
  for (const path of owned) rmSync(path, { recursive: true, force: true });
  owned.clear();
}

export interface FileLockOptions {
  /** Give up acquiring after this long (ms). */
  timeoutMs?: number;
  /** Poll interval between acquisition attempts (ms). */
  retryMs?: number;
}

const DEFAULTS = { timeoutMs: 5000, retryMs: 25 };

/** Thrown when the lock cannot be acquired within `timeoutMs`. Carries the lock
 * path so a caller can surface the manual-recovery step in its own error contract. */
export class LockTimeoutError extends Error {
  readonly lockPath: string;
  constructor(lockPath: string, timeoutMs: number) {
    super(
      `Timed out waiting for lock at ${lockPath} after ${timeoutMs}ms; if no other tenjin process is running, remove that directory and retry.`,
    );
    this.name = 'LockTimeoutError';
    this.lockPath = lockPath;
  }
}

/**
 * Minimal cross-process mutex: the lock IS a directory, and mkdir is atomic, so a
 * second holder gets EEXIST and retries with backoff until `timeoutMs`, then
 * throws LockTimeoutError. There is deliberately NO auto-steal of a "stale" lock:
 * concurrent waiters each judging a lock stale could remove a fresh holder's
 * directory and lose its update. A crashed holder's lock is recovered by hand (the
 * timeout error names the path); the pid+acquiredAt meta exists only to make that
 * manual call diagnosable. Always released in the finally.
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  opts: FileLockOptions = {},
): Promise<T> {
  const { timeoutMs, retryMs } = { ...DEFAULTS, ...opts };
  const metaPath = join(lockPath, 'meta');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await mkdir(lockPath);
      owned.add(lockPath); // owned from here, released only in the finally below
      break; // acquired
    } catch (err) {
      if (!isEexist(err)) throw err;
      if (Date.now() >= deadline) throw new LockTimeoutError(lockPath, timeoutMs);
      await delay(retryMs);
    }
  }
  await writeFile(metaPath, JSON.stringify({ pid: process.pid, acquiredAt: Date.now() })).catch(
    () => undefined,
  );
  try {
    return await fn();
  } finally {
    // SYNCHRONOUS, and in this order, because both are load-bearing. A signal
    // handler cannot run between two synchronous statements, so there is no instant
    // where the lock is on disk but unclaimed (a signal would exit without removing
    // it, and with no stale recovery nothing ever would) nor one where it is
    // claimed after release (a signal would remove whatever SUCCESSOR had since
    // acquired the path). An `await` here reopens the first window: `rm` yields, the
    // handler runs, sees no ownership, and leaves the directory behind.
    //
    // With no stealing, nothing else ever removes or replaces this directory, so
    // the lock here is provably the one we created — the unconditional rm is sound.
    try {
      rmSync(lockPath, { recursive: true, force: true });
    } catch {
      // Best effort, as the async removal was. Ownership is dropped either way:
      // a directory we failed to remove is recoverable by hand, while staying
      // claimed risks deleting a successor's live lock.
    }
    owned.delete(lockPath);
  }
}

function isEexist(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'EEXIST';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
