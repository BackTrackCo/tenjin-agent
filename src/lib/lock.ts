import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface FileLockOptions {
  /** Give up acquiring after this long (ms). */
  timeoutMs?: number;
  /** Poll interval between acquisition attempts (ms). */
  retryMs?: number;
  /**
   * OPT-IN stale-lock recovery: a lock whose directory has not been modified in
   * this long is treated as abandoned, removed once, and re-acquired. Leave it
   * unset (the default) for anything where a wrongly-stolen lock could lose
   * data; see the note on {@link withFileLock} for when it is safe to set.
   */
  staleMs?: number;
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
 * throws LockTimeoutError. Always released in the finally.
 *
 * Stale recovery is OPT-IN via `staleMs`, and off by default, because concurrent
 * waiters each judging a lock stale could remove a fresh holder's directory and
 * lose its update. Set it only where the protected work is idempotent and
 * re-runnable, so a wrongly-stolen lock costs a redundant pass rather than data:
 * the skills self-heal qualifies, the spend ledger does not. Without it a crashed
 * holder's lock is recovered by hand and the timeout error names the path; the
 * pid+acquiredAt meta exists to make that call diagnosable.
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  opts: FileLockOptions = {},
): Promise<T> {
  const { timeoutMs, retryMs } = { ...DEFAULTS, ...opts };
  const { staleMs } = opts;
  const metaPath = join(lockPath, 'meta');
  const deadline = Date.now() + timeoutMs;
  let stealAttempted = false;
  for (;;) {
    try {
      await mkdir(lockPath);
      break; // acquired
    } catch (err) {
      if (!isEexist(err)) throw err;
      // Once, and only when the caller opted in: a lock older than staleMs
      // belongs to a process that is gone, and without this every later run
      // waits out the full timeout forever.
      if (staleMs !== undefined && !stealAttempted && (await isStale(lockPath, staleMs))) {
        stealAttempted = true;
        await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
        continue;
      }
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
    // the lock here is provably the one we created — the unconditional rm is sound.
    await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Has the lock directory sat untouched for longer than `staleMs`? */
async function isStale(lockPath: string, staleMs: number): Promise<boolean> {
  try {
    return Date.now() - (await stat(lockPath)).mtimeMs > staleMs;
  } catch {
    // Gone between the EEXIST and the stat: not stale, just race the retry.
    return false;
  }
}

function isEexist(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'EEXIST';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
