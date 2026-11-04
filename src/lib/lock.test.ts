import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';

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
      if (fsHooks.failRmSync) {
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      }
      return actual.rmSync(...args);
    },
  };
});
import { LockTimeoutError, withFileLock, withRuntimeLock } from './lock';

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

describe('a lock that cannot be removed is reported, not swallowed', () => {
  // The protected work succeeded, so this is not a failure of the command. It is a
  // leftover that will make every later run wait on it.
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
      expect(existsSync(p)).toBe(true);
    } finally {
      fsHooks.failRmSync = false;
      await rm(p, { recursive: true, force: true });
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

describe('withRuntimeLock', () => {
  let root: string;
  beforeEach(() => {
    root = join(dir, 'runtime');
  });
  const DEAD = 999_999;
  const lockAt = (pid: number, startedAt: Date): void => {
    mkdirSync(join(root, '.lock'), { recursive: true });
    writeFileSync(join(root, '.lock', 'owner.json'), JSON.stringify({ pid, startedAt }));
  };
  const trashLocks = () =>
    readdirSync(join(root, 'tmp')).filter((name) => name.startsWith('trash-lock-'));

  it('writes owner.json while held and removes the lock after', async () => {
    const seen = await withRuntimeLock(root, async () =>
      JSON.parse(readFileSync(join(root, '.lock', 'owner.json'), 'utf8')),
    );
    expect(seen.pid).toBe(process.pid);
    expect(Number.isNaN(Date.parse(seen.startedAt))).toBe(false);
    expect(existsSync(join(root, '.lock'))).toBe(false);
  });

  it('takes over a lock whose owner pid is dead', async () => {
    lockAt(DEAD, new Date());
    const ran = await withRuntimeLock(root, async () => 'ran', {
      isAlive: (pid) => pid !== DEAD,
      lockWaitMs: 1_000,
    });
    expect(ran).toBe('ran');
    expect(trashLocks()).toHaveLength(1);
  });

  it('takes over a live owner whose startedAt is 11 minutes old', async () => {
    lockAt(process.pid, new Date(Date.now() - 11 * 60_000));
    await expect(
      withRuntimeLock(root, async () => 'ran', { isAlive: () => true, lockWaitMs: 1_000 }),
    ).resolves.toBe('ran');
  });

  it('waits, then times out, on a live owner under 10 minutes', async () => {
    lockAt(process.pid, new Date(Date.now() - 9 * 60_000));
    const started = Date.now();
    const err = await withRuntimeLock(root, async () => 'ran', {
      isAlive: () => true,
      lockWaitMs: 200,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LockTimeoutError);
    expect((err as Error).message).toContain(join(root, '.lock'));
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
    expect(existsSync(join(root, '.lock', 'owner.json'))).toBe(true);
  });

  it('takes over an ownerless lock only once it is older than 10 s', async () => {
    mkdirSync(join(root, '.lock'), { recursive: true });
    await expect(
      withRuntimeLock(root, async () => 'ran', { lockWaitMs: 100 }),
    ).rejects.toBeInstanceOf(LockTimeoutError);
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(root, '.lock'), old, old);
    await expect(withRuntimeLock(root, async () => 'ran', { lockWaitMs: 100 })).resolves.toBe(
      'ran',
    );
  });

  /**
   * Both waiters judge the SAME dead holder's lock stale: the second arrives
   * inside the first's judgement, before the first moves anything, takes the
   * lock over and is running its body when the first gets to its takeover.
   * The first must find a different lock there and wait, not move the live one.
   */
  it('lets exactly one of two waiters take over a stale lock, and never overlaps the bodies', async () => {
    lockAt(DEAD, new Date());
    let inside = 0;
    let overlapped = false;
    const body = async () => {
      inside += 1;
      if (inside > 1) overlapped = true;
      await new Promise((done) => setTimeout(done, 80));
      inside -= 1;
    };
    const alive = (pid: number) => pid !== DEAD;
    let second: Promise<void> | undefined;
    const first = withRuntimeLock(root, body, {
      lockWaitMs: 5_000,
      isAlive: (pid) => {
        second ??= withRuntimeLock(root, body, { isAlive: alive, lockWaitMs: 5_000 });
        return alive(pid);
      },
    });
    await Promise.all([first, second]);
    expect(second).toBeDefined();
    expect(overlapped).toBe(false);
    expect(trashLocks()).toHaveLength(1);
  });

  it('releases on a throw, and tolerates its directory going with the root', async () => {
    await expect(
      withRuntimeLock(root, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(existsSync(join(root, '.lock'))).toBe(false);
    await withRuntimeLock(root, async () => rmSync(root, { recursive: true, force: true }));
    expect(existsSync(root)).toBe(false);
  });
});
