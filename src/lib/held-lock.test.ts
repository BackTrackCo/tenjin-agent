import {
  closeSync,
  constants,
  existsSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  discardHeldLock,
  HeldLockTimeoutError,
  holdLock,
  holdLockWith,
  lockSupport,
  LockUnavailableError,
  openAttempt,
  resetSelfTest,
  sweepHeldLocks,
  systemOpenDeps,
  withHeldLock,
  type OpenDeps,
} from './held-lock';
import { forgetSqlite, loadSqlite, sqliteAttempt } from './held-lock-sqlite';
import { child, holder as startHolder, killChildren, probe } from './held-lock-test/child';
import { LockTimeoutError } from './lock';

// A child process starts slowly on a loaded runner: its tests get more than the default 5 s.
vi.setConfig({ testTimeout: 30_000 });
const posix = process.platform !== 'win32';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'held-lock-'));
});
afterEach(() => {
  killChildren();
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const heldPath = (lock: string) => `${lock}.held`;

it('is the only code that names a lock file: nothing else opens, reads or deletes a `.held` path', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const offenders: string[] = [];
  const walk = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) {
        if (/held-lock/.test(full)) continue;
        const code = readFileSync(full, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/(^|[^:])\/\/.*$/gm, '$1');
        if (/['"`][^'"`\n]*\.held\b/.test(code)) offenders.push(full);
      }
    }
  };
  walk(root);
  expect(offenders).toEqual([]);
});

describe('held lock, every platform', () => {
  it('discards an idle lock file and leaves a held one', async () => {
    const lock = join(tmp, 'discard');
    (await holdLock(lock))();
    expect(await discardHeldLock(lock)).toBe(true);
    expect(existsSync(heldPath(lock))).toBe(false);
    const held = await startHolder(lock);
    expect(await discardHeldLock(lock)).toBe(false);
    expect(existsSync(heldPath(lock))).toBe(true);
    await held.release();
  });

  it('sweeps only the names it is told are eligible', async () => {
    const keep = join(tmp, 'keep.held');
    const drop = join(tmp, 'drop.held');
    writeFileSync(keep, '');
    writeFileSync(drop, '');
    await sweepHeldLocks(tmp, async (name) => name === 'drop.held');
    expect(existsSync(keep)).toBe(true);
    expect(existsSync(drop)).toBe(false);
  });

  it('rejects a zero-wait probe while this process holds it', async () => {
    const lock = join(tmp, 'a');
    const release = await holdLock(lock);
    await expect(holdLock(lock, { timeoutMs: 0 })).rejects.toBeInstanceOf(LockTimeoutError);
    release();
    (await holdLock(lock, { timeoutMs: 0 }))();
  });

  it('excludes another process, and frees on release', async () => {
    const lock = join(tmp, 'b');
    const held = await startHolder(lock);
    await expect(holdLock(lock, { timeoutMs: 0 })).rejects.toBeInstanceOf(LockTimeoutError);
    await held.release();
    (await holdLock(lock, { timeoutMs: 1000 }))();
  });

  it('frees at once when its holder is killed inside the critical section', async () => {
    const lock = join(tmp, 'c');
    const held = await startHolder(lock);
    await held.kill();
    (await holdLock(lock, { timeoutMs: 1000 }))();
  });

  it.skipIf(!posix)('keeps the lock of a stopped holder', async () => {
    const lock = join(tmp, 'd');
    const held = await startHolder(lock);
    held.proc.kill('SIGSTOP');
    await expect(holdLock(lock, { timeoutMs: 0 })).rejects.toBeInstanceOf(LockTimeoutError);
    held.proc.kill('SIGCONT');
    await held.release();
    (await holdLock(lock, { timeoutMs: 1000 }))();
  });

  it('is free after the callback throws', async () => {
    const lock = join(tmp, 'e');
    await expect(
      withHeldLock(lock, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    (await holdLock(lock, { timeoutMs: 0 }))();
  });

  it('stops waiting on abort and leaves the holder alone', async () => {
    const lock = join(tmp, 'f');
    const release = await holdLock(lock);
    const abort = new AbortController();
    const waiting = holdLock(lock, { timeoutMs: 10_000, retryMs: 5, signal: abort.signal });
    setTimeout(() => abort.abort(), 30);
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    await expect(holdLock(lock, { timeoutMs: 0 })).rejects.toBeInstanceOf(LockTimeoutError);
    release();
  });

  it('names the lock in a timeout', async () => {
    const lock = join(tmp, 'g');
    const release = await holdLock(lock);
    const error = await holdLock(lock, { timeoutMs: 20, retryMs: 5 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HeldLockTimeoutError);
    expect(error).toMatchObject({ name: 'LockTimeoutError', lockPath: heldPath(lock) });
    expect((error as Error).message).toContain('Another Tenjin process holds');
    release();
  });

  it('release is idempotent and does not free a later holder', async () => {
    const lock = join(tmp, 'h');
    const first = await holdLock(lock);
    first();
    const second = await holdLock(lock);
    first();
    await expect(holdLock(lock, { timeoutMs: 0 })).rejects.toBeInstanceOf(LockTimeoutError);
    second();
  });

  it('a waiter that gives up does not free the holder', async () => {
    const lock = join(tmp, 'i');
    const release = await holdLock(lock);
    await expect(holdLock(lock, { timeoutMs: 0 })).rejects.toBeInstanceOf(LockTimeoutError);
    expect(await probe(lock)).toBe('held');
    release();
  });
});

describe.skipIf(process.platform === 'linux')('exclusive open (macOS and Windows)', () => {
  beforeEach(() => resetSelfTest());
  afterEach(() => resetSelfTest());

  it('fails loudly when the flag is ignored', () => {
    const platform = process.platform === 'win32' ? 'win32' : 'darwin';
    const ignoring: OpenDeps = {
      ...systemOpenDeps(platform),
      open: (path, _flags, mode) => openSync(path, constants.O_RDWR | constants.O_CREAT, mode),
    };
    const attempt = openAttempt(join(tmp, 'x.held'), ignoring);
    expect(() => attempt.tryOnce()).toThrow(LockUnavailableError);
    // A process that found it fails every later lock the same way.
    expect(() => attempt.tryOnce()).toThrow(LockUnavailableError);
  });

  it.skipIf(process.platform !== 'darwin')('throws on a symlink planted at the path', async () => {
    const lock = join(tmp, 'link');
    writeFileSync(join(tmp, 'target'), '');
    symlinkSync(join(tmp, 'target'), heldPath(lock));
    await expect(holdLock(lock, { timeoutMs: 0 })).rejects.toMatchObject({ code: 'ELOOP' });
  });

  it.skipIf(process.platform !== 'darwin')(
    'a read or stat of the file in the holder does not drop the lock',
    async () => {
      const lock = join(tmp, 'plain');
      const release = await holdLock(lock);
      readFileSync(heldPath(lock));
      statSync(heldPath(lock));
      closeSync(openSync(heldPath(lock), 'r'));
      expect(await probe(lock)).toBe('held');
      release();
    },
  );

  it.skipIf(process.platform !== 'darwin')(
    'retries on the new inode when the file is deleted after the open',
    async () => {
      const lock = join(tmp, 'ino');
      const real = systemOpenDeps('darwin');
      let deleted = false;
      const deps: OpenDeps = {
        ...real,
        fstat: (fd) => {
          if (!deleted) {
            deleted = true;
            unlinkSync(heldPath(lock));
          }
          return real.fstat(fd);
        },
      };
      const release = await holdLockWith((path) => openAttempt(path, deps), lock);
      expect(deleted).toBe(true);
      expect(await probe(lock)).toBe('held');
      release();
    },
  );
});

// The Linux primitive, on any platform that has node:sqlite.
describe.skipIf(process.platform === 'win32' || loadSqlite() === null)(
  'exclusive SQLite transaction (Linux primitive)',
  () => {
    const attemptOn = (lock: string) => sqliteAttempt(heldPath(lock), loadSqlite()!);

    it('starts over on the new file when the lock file is deleted after its connection opened', async () => {
      const lock = join(tmp, 'sq-ino');
      const holding = await holdLockWith((path) => sqliteAttempt(path, loadSqlite()!), lock);
      const waiter = attemptOn(lock);
      // Busy: this connection is open on the first file.
      expect(waiter.tryOnce()).toBeNull();
      unlinkSync(heldPath(lock));
      holding();
      // The old file is free, but it is no longer the lock file: the waiter ends on the new one.
      const release = waiter.tryOnce();
      expect(release).not.toBeNull();
      expect(await probe(lock)).toBe('held');
      release!();
    });

    it.skipIf(!posix)('makes the lock file private to the user', async () => {
      const lock = join(tmp, 'sq-mode');
      (await holdLockWith((path) => sqliteAttempt(path, loadSqlite()!), lock))();
      expect(statSync(heldPath(lock)).mode & 0o077).toBe(0);
    });

    it('abandoning a wait closes its connection and leaves the holder alone', async () => {
      const lock = join(tmp, 'sq-abandon');
      const holding = await holdLock(lock);
      const waiter = attemptOn(lock);
      expect(waiter.tryOnce()).toBeNull();
      waiter.abandon();
      expect(await probe(lock)).toBe('held');
      holding();
      expect(await probe(lock)).toBe('free');
    });

    // A container restart gives the next process another pid namespace: a lock that depended on
    // a pid would stay stuck. The kernel drops the dead holder's lock whatever namespace asks.
    it('is free the moment its holder is killed, for a process that shares nothing with it', async () => {
      const lock = join(tmp, 'sq-restart');
      const held = await startHolder(lock);
      expect(await probe(lock)).toBe('held');
      await held.kill();
      expect(await probe(lock)).toBe('free');
    });
  },
);

describe.skipIf(process.platform !== 'linux')('Linux without node:sqlite', () => {
  afterEach(() => forgetSqlite());

  it('says why the lock cannot be taken, once, and holds nothing', async () => {
    const original = process.getBuiltinModule;
    process.getBuiltinModule = (() => undefined) as typeof process.getBuiltinModule;
    forgetSqlite();
    try {
      expect(lockSupport()).toMatchObject({
        ok: false,
        reason: expect.stringContaining('Node 22.13 or later'),
      });
      await expect(holdLock(join(tmp, 'none'), { timeoutMs: 0 })).rejects.toBeInstanceOf(
        LockUnavailableError,
      );
    } finally {
      process.getBuiltinModule = original;
    }
  });
});

async function runStress(ms: string, chaos: string, workers: string, broken = '0') {
  const run = child('stress.ts', ms, chaos, workers, join(tmp, 'stress'), broken);
  return JSON.parse(await run.line('{')) as {
    rounds: number;
    overlaps: number;
    timeouts: number;
    errors: number;
  };
}

// The control for the harness: against a lock skipped altogether, the log detector MUST
// report overlaps. A detector that reports none here has proved nothing about a real lock.
it('the stress detector sees two holders inside a deliberately broken lock', async () => {
  const result = await runStress('5000', 'none', '4', '1');
  expect(result.rounds).toBeGreaterThan(0);
  expect(result.overlaps).toBeGreaterThan(0);
}, 60_000);

const stress = process.env.TENJIN_LOCK_STRESS === '1';
describe.skipIf(!stress)('stress (opt in with TENJIN_LOCK_STRESS=1)', () => {
  it('lets no two holders in, with kills and stops', async () => {
    const result = await runStress(
      process.env.TENJIN_LOCK_STRESS_MS ?? '20000',
      process.env.TENJIN_LOCK_STRESS_CHAOS ?? 'both',
      process.env.TENJIN_LOCK_STRESS_WORKERS ?? '8',
    );
    console.warn(`lock stress: ${JSON.stringify(result)}`);
    expect(result.rounds).toBeGreaterThan(0);
    expect(result.overlaps).toBe(0);
    expect(result.errors).toBe(0);
  }, 120_000);
});
