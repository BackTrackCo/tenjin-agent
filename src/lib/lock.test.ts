import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
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
import { LockTimeoutError, withFileLock, withFirstFileLock, withRuntimeLock } from './lock';
import { processStartToken } from './process-identity';

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

describe('withFirstFileLock', () => {
  const gate = () => {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { open, opened };
  };

  it('takes the next lock while the first is held, and the first again once it is free', async () => {
    // Two sessions queued on one inference lane while the other lane stood idle.
    const locks = [join(dir, 'lane-0.lock'), join(dir, 'lane-1.lock')];
    const release = gate();
    const entered = gate();
    const first = withFirstFileLock(locks, async (index) => {
      entered.open();
      await release.opened;
      return index;
    });
    await entered.opened;
    // Held by the first caller: the second runs on the other lock at once.
    await expect(withFirstFileLock(locks, async (index) => index)).resolves.toBe(1);
    release.open();
    await expect(first).resolves.toBe(0);
    await expect(withFirstFileLock(locks, async (index) => index)).resolves.toBe(0);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('waits when every lock is held, says who held the first, and takes whichever is released first', async () => {
    const locks = [join(dir, 'lane-0.lock'), join(dir, 'lane-1.lock')];
    const releases = [gate(), gate()];
    const entered = [gate(), gate()];
    const holders = [0, 1].map((n) =>
      withFirstFileLock(locks, async (index) => {
        entered[index]!.open();
        await releases[index]!.opened;
        return [n, index];
      }),
    );
    await Promise.all(entered.map((e) => e.opened));
    const held = gate();
    let holder: number | undefined;
    let running = 0;
    const third = withFirstFileLock(
      locks,
      async (index) => {
        running++;
        return index;
      },
      {
        retryMs: 2,
        onHeld: (pid) => {
          holder = pid;
          held.open();
        },
      },
    );
    await held.opened;
    expect(holder).toBe(process.pid);
    expect(running).toBe(0);
    // The second lock comes free first: the waiter takes it, not the first in its order.
    releases[1]!.open();
    await expect(third).resolves.toBe(1);
    releases[0]!.open();
    await expect(Promise.all(holders)).resolves.toEqual([
      [0, 0],
      [1, 1],
    ]);
  });

  it('never runs two holders of one lock at a time, however many callers share the locks', async () => {
    const locks = [join(dir, 'lane-0.lock'), join(dir, 'lane-1.lock')];
    const inside = [0, 0];
    let most = 0;
    const call = () =>
      withFirstFileLock(
        locks,
        async (index) => {
          inside[index]!++;
          most = Math.max(most, inside[index]!);
          await new Promise<void>((resolve) => setImmediate(resolve));
          inside[index]!--;
        },
        { retryMs: 1 },
      );
    await Promise.all(Array.from({ length: 12 }, call));
    expect(most).toBe(1);
    expect(readdirSync(dir)).toEqual([]);
  });

  // Whether two callers overlap in time depends on the runner, so no timing is guessed: each
  // holder stays until the other one is inside too. Locks that let only one caller in at a
  // time would leave both waiting for each other, and the test would time out.
  it('lets two callers hold the two locks at once, each its own', async () => {
    const locks = [join(dir, 'lane-0.lock'), join(dir, 'lane-1.lock')];
    const held: number[] = [];
    let bothIn!: () => void;
    const both = new Promise<void>((resolve) => (bothIn = resolve));
    const call = () =>
      withFirstFileLock(
        locks,
        async (index) => {
          held.push(index);
          if (held.length === 2) bothIn();
          await both;
        },
        { retryMs: 1 },
      );
    await Promise.all([call(), call()]);
    expect([...held].sort()).toEqual([0, 1]);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('withFileLock with takeOverDead', () => {
  // A pid that ran and ended: nothing answers for it.
  const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;
  const leave = (lock: string, meta?: string): void => {
    mkdirSync(lock);
    if (meta !== undefined) writeFileSync(join(lock, 'meta'), meta);
  };
  const quick = { timeoutMs: 80, retryMs: 10 };

  it('runs after a holder that died with the lock, and only when asked to', async () => {
    const lock = join(dir, 'dead.lock');
    leave(lock, JSON.stringify({ pid: deadPid(), acquiredAt: Date.now() }));
    await expect(withFileLock(lock, async () => 'ran', quick)).rejects.toBeInstanceOf(
      LockTimeoutError,
    );
    expect(await withFileLock(lock, async () => 'ran', { ...quick, takeOverDead: true })).toBe(
      'ran',
    );
    expect(readdirSync(dir)).toEqual([]);
  });

  it('never takes a lock whose holder is running', async () => {
    const lock = join(dir, 'live.lock');
    leave(lock, JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }));
    await expect(
      withFileLock(lock, async () => 'unreached', { ...quick, takeOverDead: true }),
    ).rejects.toBeInstanceOf(LockTimeoutError);
    expect(existsSync(join(lock, 'meta'))).toBe(true);
  });

  // Failure caught (Greptile): after a crash or a reboot an unrelated long-lived process took
  // the recorded pid, and a pid-only check held the lock for ever, with no deadline on the wait.
  it('takes a lock whose live pid has another start token, as a reused pid', async () => {
    const lock = join(dir, 'reused.lock');
    leave(lock, JSON.stringify({ pid: process.pid, acquiredAt: Date.now(), token: 'not:this' }));
    expect(await withFileLock(lock, async () => 'ran', { ...quick, takeOverDead: true })).toBe(
      'ran',
    );
  });

  it('never takes a lock whose live pid has the recorded token, however long it holds', async () => {
    const lock = join(dir, 'same.lock');
    leave(
      lock,
      JSON.stringify({ pid: process.pid, acquiredAt: 0, token: processStartToken(process.pid) }),
    );
    // Nothing beats and no timer runs in the holder: a suspended session is still the holder.
    await expect(
      withFileLock(lock, async () => 'unreached', { ...quick, takeOverDead: true }),
    ).rejects.toBeInstanceOf(LockTimeoutError);
    expect(existsSync(join(lock, 'meta'))).toBe(true);
  });

  it('treats a holder with no recorded token, or one it cannot read, as alive', async () => {
    const lock = join(dir, 'no-token.lock');
    leave(lock, JSON.stringify({ pid: process.pid, acquiredAt: 0 }));
    await expect(
      withFileLock(lock, async () => 'unreached', { ...quick, takeOverDead: true }),
    ).rejects.toBeInstanceOf(LockTimeoutError);
  });

  it('writes its own pid, token and owner id into a lock, readable by the user alone', async () => {
    const lock = join(dir, 'meta.lock');
    let meta: { pid?: number; token?: string; owner?: string } = {};
    let mode = 0;
    await withFileLock(lock, async () => {
      meta = JSON.parse(await readFile(join(lock, 'meta'), 'utf8'));
      mode = (await stat(join(lock, 'meta'))).mode & 0o777;
    });
    expect(meta.pid).toBe(process.pid);
    expect(meta.token).toBe(processStartToken(process.pid));
    expect(typeof meta.owner).toBe('string');
    expect(mode).toBe(0o600);
  });

  it('is not moved by a step of the wall clock, forward or back, and its wait is monotonic', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now(), shouldAdvanceTime: true });
    try {
      const same = join(dir, 'same-step.lock');
      leave(
        same,
        JSON.stringify({ pid: process.pid, acquiredAt: 0, token: processStartToken(process.pid) }),
      );
      const reused = join(dir, 'reused-step.lock');
      leave(reused, JSON.stringify({ pid: process.pid, acquiredAt: 0, token: 'not:this' }));
      for (const step of [86_400_000, -2 * 86_400_000]) {
        vi.setSystemTime(Date.now() + step);
        // A live holder with its token is held however the clock moved, and the wait lasts its
        // own timeout, not the clock's.
        const began = performance.now();
        await expect(
          withFileLock(same, async () => 'unreached', {
            timeoutMs: 300,
            retryMs: 10,
            takeOverDead: true,
          }),
        ).rejects.toBeInstanceOf(LockTimeoutError);
        expect(performance.now() - began).toBeGreaterThanOrEqual(290);
      }
      // A reused pid is taken at once, with no age to read.
      expect(await withFileLock(reused, async () => 'ran', { ...quick, takeOverDead: true })).toBe(
        'ran',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves the lock a waiter took in place when the first holder releases', async () => {
    const lock = join(dir, 'taken.lock');
    let release!: () => void;
    const first = withFileLock(lock, () => new Promise<void>((resolve) => (release = resolve)), {
      takeOverDead: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The first holder's record is rewritten as another process's (a taker's), as after a takeover.
    writeFileSync(
      join(lock, 'meta'),
      JSON.stringify({ pid: process.pid, owner: 'someone-else', acquiredAt: Date.now() }),
    );
    release();
    await first;
    expect(existsSync(join(lock, 'meta'))).toBe(true);
  });

  // Failure caught (Greptile): a holder that died between mkdir and its meta write left an
  // ownerless lock that a fresh process had to watch for 10 s, longer than the 5 s wait.
  it('makes a lock whole in one step, so no lock is ever seen without its owner', async () => {
    const lock = join(dir, 'whole.lock');
    const seen: string[] = [];
    const waiter = (async () => {
      for (let n = 0; n < 200; n++) {
        try {
          seen.push(readFileSync(join(lock, 'meta'), 'utf8'));
        } catch {
          // Absent, or no lock yet; but a lock directory with no meta is the failure.
          if (existsSync(lock) && !existsSync(join(lock, 'meta'))) seen.push('OWNERLESS');
        }
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    })();
    for (let n = 0; n < 20; n++) await withFileLock(lock, async () => undefined);
    await waiter;
    expect(seen).not.toContain('OWNERLESS');
  });

  it('takes a lock whose owner record is missing or unreadable at once, within the default wait', async () => {
    for (const meta of [undefined, '{"pid":']) {
      const lock = join(dir, `corrupt-${meta === undefined ? 'none' : 'half'}.lock`);
      leave(lock, meta);
      const began = performance.now();
      expect(await withFileLock(lock, async () => 'ran', { takeOverDead: true })).toBe('ran');
      expect(performance.now() - began).toBeLessThan(1000);
    }
  });

  it('clears the takeover gate of a waiter that died, and goes on to take the dead lock', async () => {
    const lock = join(dir, 'gated.lock');
    leave(lock, JSON.stringify({ pid: deadPid(), acquiredAt: 0 }));
    mkdirSync(`${lock}.takeover`);
    writeFileSync(join(`${lock}.takeover`, 'meta'), JSON.stringify({ pid: deadPid() }));
    const began = performance.now();
    expect(
      await withFileLock(lock, async () => 'ran', {
        timeoutMs: 3000,
        retryMs: 10,
        takeOverDead: true,
      }),
    ).toBe('ran');
    expect(performance.now() - began).toBeLessThan(1500);
  });

  it('lets waiters on one dead lock run one at a time, each landing its update', async () => {
    const lock = join(dir, 'raced.lock');
    const file = join(dir, 'count');
    await writeFile(file, '0');
    leave(lock, JSON.stringify({ pid: deadPid(), acquiredAt: Date.now() }));
    let inside = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        withFileLock(
          lock,
          async () => {
            expect(++inside).toBe(1);
            const count = Number(await readFile(file, 'utf8'));
            await delay(2);
            await writeFile(file, String(count + 1));
            inside--;
          },
          { timeoutMs: 2_000, retryMs: 5, takeOverDead: true },
        ),
      ),
    );
    expect(await readFile(file, 'utf8')).toBe('6');
    expect(readdirSync(dir)).toEqual(['count']);
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
