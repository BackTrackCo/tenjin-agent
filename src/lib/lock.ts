import { mkdirSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

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
      mkdirSync(lockPath);
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
    // With no stealing, nothing else ever removes or replaces this directory, so
    // the lock here is provably the one we created: the unconditional rm is sound.
    try {
      rmSync(lockPath, { recursive: true, force: true });
    } catch (err) {
      // A leftover blocks every later run, so the caller is told rather than left
      // to discover it as a timeout.
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
