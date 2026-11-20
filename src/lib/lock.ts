import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { holderGone, ownStartToken } from './process-identity';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { hasCode } from './errno';

export interface FileLockOptions {
  /** Give up acquiring after this long (ms). */
  timeoutMs?: number;
  /** Poll interval between acquisition attempts (ms). */
  retryMs?: number;
  /** Stops waiting to acquire. Once running, the callback owns cancellation. */
  signal?: AbortSignal;
  /**
   * Called when the lock could not be removed on release. The work succeeded,
   * but the leftover blocks later runs, and only the caller can say so.
   */
  onReleaseError?: (lockPath: string, err: unknown) => void;
  /**
   * Move aside a lock whose holder is gone (its pid not running, or held by another
   * process), or whose owner record is unreadable. For a store whose
   * holders can be killed mid-update and whose every later operation would
   * otherwise time out. Off by default: see {@link withFileLock}.
   */
  takeOverDead?: boolean;
}

const DEFAULTS = { timeoutMs: 5000, retryMs: 25 };

/** Thrown when the lock cannot be acquired within `timeoutMs`, carrying the path
 * so a caller can show the manual-recovery step. */
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
 * Make the lock directory `lockPath`. mkdir is atomic, so a second holder gets EEXIST:
 * `onBusy` is asked first, and the lock is tried again at once when it moved the lock aside.
 * While it is held this waits `retryMs` and tries again until `deadline` on `now`, then
 * throws LockTimeoutError.
 */
async function acquire(
  lockPath: string,
  o: {
    deadline: number;
    timeoutMs: number;
    retryMs: number;
    now: () => number;
    /** Makes the lock whole in one step; false when it is held. Default: `mkdir`. */
    make?: (lockPath: string) => boolean;
    onBusy?: (lockPath: string) => boolean;
    signal?: AbortSignal;
  },
): Promise<void> {
  for (;;) {
    o.signal?.throwIfAborted();
    try {
      if (o.make) {
        if (o.make(lockPath)) return;
      } else {
        mkdirSync(lockPath);
        return;
      }
      if (o.onBusy?.(lockPath) === true) continue;
    } catch (err) {
      if (!hasCode(err, 'EEXIST')) throw err;
      if (o.onBusy?.(lockPath) === true) continue;
    }
    if (o.now() >= o.deadline) throw new LockTimeoutError(lockPath, o.timeoutMs);
    await delay(o.retryMs, undefined, { signal: o.signal }).catch((error) => {
      o.signal?.throwIfAborted();
      throw error;
    });
  }
}

/**
 * Minimal cross-process mutex: the lock is a directory, and mkdir is atomic, so
 * a second holder gets EEXIST and retries until `timeoutMs`. By default a stale
 * lock is never stolen: waiters that each judged it stale could remove a fresh
 * holder's directory and lose its update. A crashed holder's lock is removed by
 * hand (the timeout error names the path); the pid+acquiredAt meta only helps
 * diagnose it. With `takeOverDead`, a waiter moves a dead holder's lock aside,
 * one waiter at a time and only the exact lock it judged.
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  opts: FileLockOptions = {},
): Promise<T> {
  const { timeoutMs, retryMs } = { ...DEFAULTS, ...opts };
  // One wait reads a holder's start token once per holder it meets, and never on Linux by a fork.
  const read = new Map<string, string | undefined>();
  // WHO HOLDS IT, written before the lock exists: the pid, the process's start token (a reused
  // pid has another) and a random id, so the release can tell this lock from one a waiter put
  // there. The lock appears whole in one atomic step, so there is no moment with no owner.
  const owner = randomBytes(8).toString('hex');
  const token = ownStartToken();
  const record = JSON.stringify({
    pid: process.pid,
    acquiredAt: Date.now(),
    owner,
    ...(token === undefined ? {} : { token }),
  });
  await acquire(lockPath, {
    deadline: performance.now() + timeoutMs,
    timeoutMs,
    retryMs,
    now: () => performance.now(),
    signal: opts.signal,
    make: (path) => makeWhole(path, record),
    ...(opts.takeOverDead ? { onBusy: (path: string) => takeOverDeadHolder(path, read) } : {}),
  });
  let ino: number | undefined;
  try {
    ino = statSync(lockPath).ino;
  } catch {
    // Taken away already: the release finds nothing of ours.
  }
  try {
    opts.signal?.throwIfAborted();
    return await fn();
  } finally {
    // Only a lock that is still this holder's is removed: one a waiter took after judging
    // this holder gone belongs to the taker.
    try {
      if (stillOurs(lockPath, owner, ino)) rmSync(lockPath, { recursive: true, force: true });
    } catch (err) {
      // A leftover blocks every later run; tell the caller now, not as a timeout.
      opts.onReleaseError?.(lockPath, err);
    }
  }
}

/**
 * Makes the lock directory at `path` with its `meta` already in it, by one rename of a
 * prepared directory: the rename fails when `path` holds a directory with anything in it, so
 * the lock is never seen without its owner. False when it is held.
 */
function makeWhole(path: string, record: string): boolean {
  const prepared = `${path}.new-${randomBytes(6).toString('hex')}`;
  mkdirSync(prepared, { mode: 0o700 });
  try {
    writeFileSync(join(prepared, 'meta'), record, { mode: 0o600 });
    renameSync(prepared, path);
    return true;
  } catch (err) {
    rmSync(prepared, { recursive: true, force: true });
    // A held lock is a directory with a `meta` in it; Windows says EPERM where POSIX says
    // EEXIST or ENOTEMPTY.
    if (hasCode(err, 'EEXIST') || hasCode(err, 'ENOTEMPTY') || hasCode(err, 'EPERM')) return false;
    throw err;
  }
}

/** Whether the lock on disk is the one this holder made: its owner id, or its inode when its meta is unreadable. */
function stillOurs(lockPath: string, owner: string, ino: number | undefined): boolean {
  let meta: { owner?: unknown } | undefined;
  try {
    meta = JSON.parse(readFileSync(join(lockPath, 'meta'), 'utf8')) as { owner?: unknown };
  } catch {
    // No readable meta: ours only by its inode.
  }
  if (meta !== undefined) return meta.owner === owner;
  try {
    return ino !== undefined && statSync(lockPath).ino === ino;
  } catch {
    return false;
  }
}

/**
 * The identity of a `withFileLock` directory whose holder is gone, or null while it may still
 * be held: its inode plus its `meta` bytes, so a takeover moves only the exact lock it judged.
 * A holder is gone when its pid is not running, or is held by a process with another start
 * token than the one recorded (a reused pid): an equality of tokens, never a comparison of
 * times. A holder with no recorded token, or whose token cannot be read, is alive: the pid
 * alone decides and a doubt reads as alive. A lock whose `meta` cannot be read or parsed is a
 * corrupt one (a lock is only ever made whole): it is gone at once.
 * `read` memoizes tokens by pid AND the recorded token, so a lock another process took after
 * the pid was reused is read fresh; pass a new map to read every holder afresh.
 */
function deadHolder(lockPath: string, read: Map<string, string | undefined>): string | null {
  let info;
  try {
    info = statSync(lockPath);
  } catch {
    return null;
  }
  let text = '';
  let pid: unknown;
  let token: unknown;
  try {
    text = readFileSync(join(lockPath, 'meta'), 'utf8');
    ({ pid, token } = JSON.parse(text) as { pid?: unknown; token?: unknown });
  } catch {
    return `${info.ino}:${text}`;
  }
  if (typeof pid !== 'number') return `${info.ino}:${text}`;
  return holderGone(pid, typeof token === 'string' ? token : undefined, pidAlive, read)
    ? `${info.ino}:${text}`
    : null;
}

/**
 * Move a dead holder's lock aside, serialised by `<lock>.takeover` (a gate made whole like a
 * lock, so a gate of a killed waiter is told by its holder's identity) so two waiters that
 * judged the same lock cannot both take it. Every judgment to move is confirmed with fresh
 * reads of the holder just before the move. True when this call moved it.
 */
function takeOverDeadHolder(lockPath: string, read: Map<string, string | undefined>): boolean {
  if (deadHolder(lockPath, read) === null) return false;
  const gate = `${lockPath}.takeover`;
  const token = ownStartToken();
  let made: boolean;
  try {
    made = makeWhole(
      gate,
      JSON.stringify({
        pid: process.pid,
        owner: randomBytes(8).toString('hex'),
        ...(token ? { token } : {}),
      }),
    );
  } catch {
    return false;
  }
  if (!made) {
    // A gate is held for one rename: one whose holder is gone was left by a killed waiter.
    const left = deadHolder(gate, new Map());
    if (left !== null) {
      try {
        const aside = `${gate}.dead-${randomBytes(6).toString('hex')}`;
        renameSync(gate, aside);
        rmSync(aside, { recursive: true, force: true });
      } catch {
        // Taken or released meanwhile.
      }
    }
    return false;
  }
  try {
    // The confirmation reads the holder afresh, never from this wait's memo.
    const judged = deadHolder(lockPath, new Map());
    if (judged === null) return false;
    const aside = `${lockPath}.dead-${randomBytes(6).toString('hex')}`;
    renameSync(lockPath, aside);
    rmSync(aside, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  } finally {
    rmSync(gate, { recursive: true, force: true });
  }
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
