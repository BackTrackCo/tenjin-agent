import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

/**
 * A seam for the one branch that only exists when the filesystem refuses: the
 * release cannot remove the lock. Inert unless a test arms it.
 */
const fsHooks = vi.hoisted(() => ({ failRmSync: false }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    rmSync: (...args: Parameters<typeof actual.rmSync>) => {
      if (fsHooks.failRmSync) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      return actual.rmSync(...args);
    },
  };
});
import { LockTimeoutError, ownsAnyLock, releaseOwnedLocks, withFileLock } from './lock';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-lock-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('withFileLock', () => {
  it('serializes overlapping critical sections (no interleave)', async () => {
    const lock = join(dir, 'a.lock');
    const events: string[] = [];
    const section = (id: string) =>
      withFileLock(lock, async () => {
        events.push(`${id}:start`);
        await delay(30);
        events.push(`${id}:end`);
      });
    await Promise.all([section('x'), section('y')]);
    // Serialized: one holder's start+end fully precede the other's — never
    // interleaved (which would be x:start,y:start,...). Order between them is free.
    expect([
      ['x:start', 'x:end', 'y:start', 'y:end'],
      ['y:start', 'y:end', 'x:start', 'x:end'],
    ]).toContainEqual(events);
  });

  it('N concurrent critical sections all land their update, no leftover lock dir', async () => {
    // Regression for the stale-steal lost-update bug: without a sound mutex, N
    // read-modify-writes read the same base and the last writer drops the rest.
    // Every section must land, and the last holder's finally must leave no dir.
    const lock = join(dir, 'multi.lock');
    const target = join(dir, 'state.json');
    await writeFile(target, '{}');
    const bump = (key: string) =>
      withFileLock(lock, async () => {
        const obj = JSON.parse(await readFile(target, 'utf8')) as Record<string, boolean>;
        await delay(5); // widen the read-modify-write window a lost update would exploit
        obj[key] = true;
        await writeFile(target, JSON.stringify(obj));
      });
    await Promise.all(['a', 'b', 'c', 'd', 'e'].map(bump));
    const final = JSON.parse(await readFile(target, 'utf8')) as Record<string, boolean>;
    expect(Object.keys(final).sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
    await expect(stat(lock)).rejects.toThrow(); // released, nothing leftover
  });

  it('times out with an actionable error when a live lock is never released', async () => {
    const lock = join(dir, 'live.lock');
    await mkdir(lock);
    await writeFile(
      join(lock, 'meta'),
      JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }),
    );
    const err = await withFileLock(lock, async () => 'unreached', {
      timeoutMs: 60,
      retryMs: 10,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LockTimeoutError);
    expect((err as LockTimeoutError).lockPath).toBe(lock);
    expect((err as Error).message).toContain(lock);
    expect((err as Error).message).toMatch(/remove that directory/);
  });
});

/**
 * The in-memory ownership registry. It exists so a signal handler can release
 * exactly the locks this process holds, and its whole value depends on ownership
 * ending when the lock does.
 */
describe('lock ownership tracking', () => {
  it('claims the lock while the callback runs and lets it go afterwards', async () => {
    const p = join(dir, 'own.lock');
    expect(ownsAnyLock()).toBe(false);
    await withFileLock(p, async () => {
      expect(ownsAnyLock()).toBe(true);
    });
    expect(ownsAnyLock()).toBe(false);
  });

  it('lets go even when the callback throws', async () => {
    const p = join(dir, 'throw.lock');
    await expect(
      withFileLock(p, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(ownsAnyLock()).toBe(false);
  });

  // The bug this guards: ownership outliving the release meant a later signal in
  // this process deleted whatever SUCCESSOR had since taken the same path.
  it("never deletes a successor's lock at a path it has already released", async () => {
    const p = join(dir, 'successor.lock');
    await withFileLock(p, async () => undefined);
    await mkdir(p, { recursive: true }); // stands in for another process acquiring
    releaseOwnedLocks();
    expect(existsSync(p)).toBe(true);
  });

  // A signal handler runs between macrotasks, so a macrotask probe observes exactly
  // what one would. The release must never be observable as "on disk but unowned":
  // a handler there exits without removing the lock, and with no stale recovery
  // nothing ever will. An `await` inside the release reopens that window.
  it('is never observable on disk while unowned', async () => {
    const p = join(dir, 'window.lock');
    let sawWindow = false;
    let sawReverse = false;
    const probe = setInterval(() => {
      // Both directions. On disk but unclaimed means a signal exits without
      // removing it. Claimed but already gone means a signal would remove
      // whatever SUCCESSOR had since taken the path. Neither may ever be seen.
      if (existsSync(p) && !ownsAnyLock()) sawWindow = true;
      if (!existsSync(p) && ownsAnyLock()) sawReverse = true;
    }, 0);
    try {
      await withFileLock(p, async () => {
        // Give the removal something to do, so a yielding release would be caught.
        for (let i = 0; i < 400; i++) await writeFile(join(p, `f${i}`), 'x');
      });
    } finally {
      clearInterval(probe);
    }
    expect(sawWindow).toBe(false);
    expect(sawReverse).toBe(false);
    expect(existsSync(p)).toBe(false);
  });

  it('releasing while holding nothing removes nothing', async () => {
    const p = join(dir, 'held-by-other.lock');
    await mkdir(p, { recursive: true });
    releaseOwnedLocks();
    expect(existsSync(p)).toBe(true);
  });
});

describe('a lock that cannot be removed is reported, not swallowed', () => {
  // The protected work succeeded, so this is not a failure of the command. It is a
  // leftover that will make every later run wait on it, and retaining the in-memory
  // ownership bit does nothing once this process exits normally.
  it('calls onReleaseError with the path, and still returns the result', async () => {
    const p = join(dir, 'stuck.lock');
    const seen: string[] = [];
    fsHooks.failRmSync = true;
    try {
      const out = await withFileLock(p, async () => 'done', {
        onReleaseError: (path) => seen.push(path),
      });
      expect(out).toBe('done');
      expect(seen).toEqual([p]);
      // Still on disk, and still claimed: no successor can take the path.
      expect(existsSync(p)).toBe(true);
      expect(ownsAnyLock()).toBe(true);
    } finally {
      fsHooks.failRmSync = false;
      releaseOwnedLocks();
    }
    expect(existsSync(p)).toBe(false);
  });

  // releaseOwnedLocks runs inside a signal handler, where a throw is an uncaught
  // exception: the process would die with code 1 and a stack trace instead of the
  // handler's diagnostic and exit 130.
  it('never throws, even when every removal fails', async () => {
    const a = join(dir, 'a.lock');
    const b = join(dir, 'b.lock');
    fsHooks.failRmSync = true;
    try {
      // Each acquires normally; only the release fails, so both stay claimed.
      await withFileLock(a, async () => undefined);
      await withFileLock(b, async () => undefined);
      expect(ownsAnyLock()).toBe(true);

      expect(() => releaseOwnedLocks()).not.toThrow();
      // Ownership is cleared regardless, so a second signal is a no-op.
      expect(ownsAnyLock()).toBe(false);
    } finally {
      fsHooks.failRmSync = false;
      await rm(a, { recursive: true, force: true });
      await rm(b, { recursive: true, force: true });
    }
  });

  it('says nothing when the removal succeeds', async () => {
    const seen: string[] = [];
    await withFileLock(join(dir, 'fine.lock'), async () => undefined, {
      onReleaseError: (path) => seen.push(path),
    });
    expect(seen).toEqual([]);
  });
});
