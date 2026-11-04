import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hasCode } from './errno';

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
 * Make the lock directory `lockPath`. mkdir is atomic, so a second holder gets
 * EEXIST: `onBusy` is asked first, and retries at once when it moved the lock
 * aside; otherwise this waits `retryMs` and tries again until `deadline` on
 * `now`, then throws LockTimeoutError.
 */
async function acquire(
  lockPath: string,
  o: {
    deadline: number;
    timeoutMs: number;
    retryMs: number;
    now: () => number;
    onBusy?: () => boolean;
  },
): Promise<void> {
  for (;;) {
    try {
      mkdirSync(lockPath);
      return;
    } catch (err) {
      if (!isEexist(err)) throw err;
      if (o.onBusy?.() === true) continue;
      if (o.now() >= o.deadline) throw new LockTimeoutError(lockPath, o.timeoutMs);
      await delay(o.retryMs);
    }
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
  await acquire(lockPath, {
    deadline: Date.now() + timeoutMs,
    timeoutMs,
    retryMs,
    now: () => Date.now(),
  });
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

// ---------------------------------------------------------------------------
// The runtime lock
// ---------------------------------------------------------------------------

export interface RuntimeLockOptions {
  /** How long to wait for another holder. Default 300 s, longer than any holder runs. */
  lockWaitMs?: number;
  /** Is this pid running? Defaults to `process.kill(pid, 0)`, where EPERM is alive. */
  isAlive?: (pid: number) => boolean;
  now?: () => number;
}

/** No holder runs this long: the Node download, the longest step, is capped at 300 s. */
const LOCK_STALE_MS = 10 * 60_000;
/** A lock with no readable owner this old was left by a holder killed between mkdir and write. */
const OWNERLESS_STALE_MS = 10_000;
/** The takeover lock is held for one rename; one this old was left by a killed waiter. */
const TAKEOVER_STALE_MS = 60_000;
const LOCK_POLL_MS = 50;

/**
 * Runtime locks this process holds, by path and the inode it created, removed
 * at exit: the default signal action skips `finally`, and a lock left by a
 * live pid would make every later run wait.
 */
const held = new Map<string, number>();
let exitHookInstalled = false;

function releaseHeld(): void {
  for (const [path, ino] of held) releaseIfOurs(path, ino);
  held.clear();
}

/** Remove the lock only when it is still the directory this process made: a waiter may have taken over a holder it judged stale, and the successor's lock is not ours to remove. */
function releaseIfOurs(path: string, ino: number): void {
  try {
    if (statSync(path).ino === ino) rmSync(path, { recursive: true, force: true });
  } catch {
    // Gone already (removeRuntime takes the lock dir with the root), or not removable: a dead pid is stale for the next waiter.
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return hasCode(err, 'EPERM');
  }
}

/**
 * The lock's identity when it is stale, or null when its holder may still be
 * running. The identity is its inode plus its `owner.json` bytes, so a takeover
 * renames only the exact lock it judged, never one a new holder made since.
 */
function staleLock(lock: string, isAlive: (pid: number) => boolean, now: number): string | null {
  let info;
  try {
    info = statSync(lock);
  } catch {
    return null;
  }
  let text: string;
  try {
    text = readFileSync(join(lock, 'owner.json'), 'utf8');
  } catch {
    return now - info.mtimeMs > OWNERLESS_STALE_MS ? `${info.ino}:` : null;
  }
  let owner: { pid?: unknown; startedAt?: unknown };
  try {
    owner = JSON.parse(text) as typeof owner;
  } catch {
    return now - info.mtimeMs > OWNERLESS_STALE_MS ? `${info.ino}:${text}` : null;
  }
  const started = typeof owner.startedAt === 'string' ? Date.parse(owner.startedAt) : NaN;
  const dead = typeof owner.pid === 'number' && !isAlive(owner.pid);
  const old = Number.isNaN(started) || now - started > LOCK_STALE_MS;
  return dead || old ? `${info.ino}:${text}` : null;
}

/**
 * Move a stale lock aside, serialised by `.lock-takeover` so two waiters that
 * judged the same lock stale cannot both take it: the second finds a different
 * identity (or no lock) once the first has renamed it. True when this call
 * moved it.
 */
function takeOver(
  root: string,
  lock: string,
  judged: string,
  o: Required<RuntimeLockOptions>,
): boolean {
  const gate = join(root, '.lock-takeover');
  try {
    mkdirSync(gate);
  } catch (err) {
    if (!hasCode(err, 'EEXIST')) return false;
    try {
      if (o.now() - statSync(gate).mtimeMs > TAKEOVER_STALE_MS) {
        rmSync(gate, { recursive: true, force: true });
      }
    } catch {
      // Released meanwhile.
    }
    return false;
  }
  try {
    if (staleLock(lock, o.isAlive, o.now()) !== judged) return false;
    mkdirSync(join(root, 'tmp'), { recursive: true });
    renameSync(lock, join(root, 'tmp', `trash-lock-${randomBytes(6).toString('hex')}`));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(gate, { recursive: true, force: true });
  }
}

/**
 * Run `fn` holding `runtime/.lock`. The lock is a directory (mkdir is atomic)
 * holding `owner.json` `{pid, startedAt}`. Unlike `withFileLock`, a stale lock
 * is taken over: its owner's pid is dead, or it is older than any holder runs,
 * so an update killed mid-download does not block every later install.
 */
export async function withRuntimeLock<T>(
  root: string,
  fn: () => Promise<T>,
  o: RuntimeLockOptions = {},
): Promise<T> {
  const opts: Required<RuntimeLockOptions> = {
    lockWaitMs: o.lockWaitMs ?? 300_000,
    isAlive: o.isAlive ?? pidAlive,
    now: o.now ?? Date.now,
  };
  const lock = join(root, '.lock');
  const deadline = opts.now() + opts.lockWaitMs;
  mkdirSync(root, { recursive: true });
  await acquire(lock, {
    deadline,
    timeoutMs: opts.lockWaitMs,
    retryMs: LOCK_POLL_MS,
    now: opts.now,
    onBusy: () => {
      const judged = staleLock(lock, opts.isAlive, opts.now());
      return judged !== null && takeOver(root, lock, judged, opts);
    },
  });
  const ino = statSync(lock).ino;
  held.set(lock, ino);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once('exit', releaseHeld);
  }
  try {
    writeFileSync(
      join(lock, 'owner.json'),
      JSON.stringify({ pid: process.pid, startedAt: new Date(opts.now()).toISOString() }),
    );
    return await fn();
  } finally {
    held.delete(lock);
    releaseIfOurs(lock, ino);
  }
}
