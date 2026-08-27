import { mkdirSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Locks this process currently holds. Ownership starts the instant `mkdir`
 * succeeds and ends when the release has removed the directory, so there is no
 * window where a lock is on disk and unaccounted for. A removal that FAILS keeps
 * the lock owned: the directory is still on disk, no successor can claim the path
 * while it exists, and a signal-time release gets another attempt. The one place
 * ownership is dropped without a successful removal is `releaseOwnedLocks`, which
 * runs only as the process exits, where a claim held by a dying process helps
 * nobody.
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
 * Synchronously attempt to release every lock this process holds. BEST EFFORT: a
 * path that refuses to be removed is left on disk and the next run's timeout names
 * it. Safe to call from a signal handler, and a no-op when this process holds
 * none, so a run merely QUEUED behind another cannot remove that other run's lock.
 */
export function releaseOwnedLocks(): void {
  for (const path of owned) {
    // NEVER throws. This runs inside a signal handler, and a throw there is an
    // uncaught exception: the process dies with code 1 and a stack trace instead
    // of the diagnostic and exit 130 the handler promises. One lock we could not
    // remove must not cost the report, or the exit code, or the other locks.
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // Left behind; the next run's timeout names the path.
    }
  }
  owned.clear();
}

export interface FileLockOptions {
  /** Give up acquiring after this long (ms). */
  timeoutMs?: number;
  /** Poll interval between acquisition attempts (ms). */
  retryMs?: number;
  /**
   * Called when the lock could not be removed on release. The protected work
   * succeeded, so this is not a failure of the command; it is a leftover that will
   * block later runs, and the caller is the only one able to say so.
   */
  onReleaseError?: (lockPath: string, err: unknown) => void;
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
 *
 * NO LONGER MIRRORED IN THE HOOKS. The generated scripts used to reimplement
 * this protocol byte for byte — they run as standalone .mjs files outside the
 * CLI and cannot import this module, yet wrote the same searches.json, and two
 * writers of one file that disagree about the mutex have no mutex. That file is
 * gone (tenjin-agent#209): hook state is one SQLite database and WAL serializes
 * the writers, so nothing outside this module implements this protocol any more.
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
      // SYNCHRONOUS, for the same reason the release is: `await mkdir` finishes the
      // syscall before the continuation records ownership, so between the two the
      // directory is on disk and unclaimed. A signal there exits without removing
      // it and, with no stale recovery, nothing ever will. mkdirSync and the add
      // are one uninterruptible step.
      mkdirSync(lockPath);
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
      owned.delete(lockPath);
    } catch (err) {
      // KEEP ownership when the removal fails: the successor-steal risk only
      // exists once the directory is gone and someone else can take the path, so a
      // removal that failed leaves it on disk and still ours, and a signal-time
      // release gets another attempt. That only helps while THIS process lives,
      // though; once it exits normally the leftover blocks every later run, so the
      // caller is told rather than left to discover it as a timeout.
      opts.onReleaseError?.(lockPath, err);
    }
  }
}

function isEexist(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'EEXIST';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
