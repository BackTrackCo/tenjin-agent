import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
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
   * Move aside a lock whose holder's pid is no longer running, or one left
   * with no readable holder for {@link OWNERLESS_STALE_MS}. For a store whose
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
 * Make one of the lock directories `lockPaths`, the first that is free in the order
 * given, and say which. mkdir is atomic, so a second holder gets EEXIST: `onBusy` is
 * asked first, and that lock is tried again at once when it moved the lock aside. With
 * every lock held, `onHeld` is told once, then this waits `retryMs` and tries them all
 * again until `deadline` on `now`, then throws LockTimeoutError for the first.
 */
async function acquire(
  lockPaths: readonly string[],
  o: {
    deadline: number;
    timeoutMs: number;
    retryMs: number;
    now: () => number;
    onBusy?: (lockPath: string) => boolean;
    onHeld?: () => void;
    signal?: AbortSignal;
  },
): Promise<number> {
  let told = false;
  for (;;) {
    o.signal?.throwIfAborted();
    for (let index = 0; index < lockPaths.length;) {
      try {
        mkdirSync(lockPaths[index]!);
        return index;
      } catch (err) {
        if (!hasCode(err, 'EEXIST')) throw err;
        if (o.onBusy?.(lockPaths[index]!) !== true) index++;
      }
    }
    if (!told) {
      told = true;
      o.onHeld?.();
    }
    if (o.now() >= o.deadline) throw new LockTimeoutError(lockPaths[0]!, o.timeoutMs);
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
  return withFirstFileLock([lockPath], fn, opts);
}

/**
 * `withFileLock` over several locks that guard interchangeable things: `fn` runs holding
 * the first that is free, in the order given, and is told which. With every lock held it
 * waits for whichever comes free first, trying them in that order each round. `onHeld`
 * is told once, when the first round found them all held, with the pid holding the first
 * lock (undefined when its holder cannot be read).
 */
export async function withFirstFileLock<T>(
  lockPaths: readonly string[],
  fn: (index: number) => Promise<T>,
  opts: FileLockOptions & { onHeld?: (holderPid: number | undefined) => void } = {},
): Promise<T> {
  const { timeoutMs, retryMs } = { ...DEFAULTS, ...opts };
  const { onHeld } = opts;
  const index = await acquire(lockPaths, {
    deadline: Date.now() + timeoutMs,
    timeoutMs,
    retryMs,
    now: () => Date.now(),
    signal: opts.signal,
    ...(opts.takeOverDead ? { onBusy: takeOverDeadHolder } : {}),
    ...(onHeld ? { onHeld: () => onHeld(holderPid(lockPaths[0]!)) } : {}),
  });
  const lockPath = lockPaths[index]!;
  await writeFile(
    join(lockPath, 'meta'),
    JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }),
  ).catch(() => undefined);
  try {
    opts.signal?.throwIfAborted();
    return await fn(index);
  } finally {
    // Only a dead holder's lock is ever taken over, so it is still ours and the plain rm is safe.
    try {
      rmSync(lockPath, { recursive: true, force: true });
    } catch (err) {
      // A leftover blocks every later run; tell the caller now, not as a timeout.
      opts.onReleaseError?.(lockPath, err);
    }
  }
}

/** The pid a `withFileLock` directory names as its holder, when it can be read. */
function holderPid(lockPath: string): number | undefined {
  try {
    const pid = (JSON.parse(readFileSync(join(lockPath, 'meta'), 'utf8')) as { pid?: unknown }).pid;
    return typeof pid === 'number' ? pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The identity of a `withFileLock` directory whose holder is gone, or null
 * while it may still be held: its inode plus its `meta` bytes, so a takeover
 * moves only the exact lock it judged.
 */
function deadHolder(lockPath: string): string | null {
  let info;
  try {
    info = statSync(lockPath);
  } catch {
    return null;
  }
  let text = '';
  let pid: unknown;
  try {
    text = readFileSync(join(lockPath, 'meta'), 'utf8');
    pid = (JSON.parse(text) as { pid?: unknown }).pid;
  } catch {
    // No meta, or half of one: a holder killed between its mkdir and its write.
    return Date.now() - info.mtimeMs > OWNERLESS_STALE_MS ? `${info.ino}:${text}` : null;
  }
  return typeof pid === 'number' && !pidAlive(pid) ? `${info.ino}:${text}` : null;
}

/**
 * Move a dead holder's lock aside, serialised by `<lock>.takeover` so two
 * waiters that judged the same lock cannot both take it: the second finds a
 * different identity, or no lock, once the first has moved it. True when this
 * call moved it.
 */
function takeOverDeadHolder(lockPath: string): boolean {
  const judged = deadHolder(lockPath);
  if (judged === null) return false;
  const gate = `${lockPath}.takeover`;
  try {
    mkdirSync(gate);
  } catch {
    try {
      if (Date.now() - statSync(gate).mtimeMs > TAKEOVER_STALE_MS)
        rmSync(gate, { recursive: true, force: true });
    } catch {
      // Released meanwhile.
    }
    return false;
  }
  try {
    if (deadHolder(lockPath) !== judged) return false;
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
  await acquire([lock], {
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
