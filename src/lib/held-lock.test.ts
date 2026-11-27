import {
  closeSync,
  constants,
  chmodSync,
  existsSync,
  mkdirSync,
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
  type AttemptFactory,
  type OpenDeps,
} from './held-lock';
import {
  forgetSqlite,
  heldConnections,
  loadSqlite,
  sqliteAttempt,
  type Sqlite,
} from './held-lock-sqlite';
import {
  child,
  forgetter,
  holder as startHolder,
  killChildren,
  probe,
} from './held-lock-test/child';
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
        // `.held` in a string, after a template placeholder or in a pattern. A property named
        // `held` (`this.held`) is something else.
        if (/['"`][^'"`\n]*\.held\b|\}\.held\b|\\\.held\b/.test(code)) offenders.push(full);
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
    const sqliteMake: AttemptFactory = (path) => sqliteAttempt(path, loadSqlite()!);

    it('a cleanup deletes the lock file only while it holds the lock', async () => {
      const lock = join(tmp, 'sq-discard');
      const held = await startHolder(lock, 'sqlite');
      expect(await discardHeldLock(lock, sqliteMake)).toBe(false);
      await sweepHeldLocks(tmp, async () => true, 50_000, sqliteMake);
      expect(existsSync(heldPath(lock))).toBe(true);
      expect(await probe(lock, 'sqlite')).toBe('held');
      await held.release();
      expect(await discardHeldLock(lock, sqliteMake)).toBe(true);
      expect(existsSync(heldPath(lock))).toBe(false);
      // A lock taken afterwards is on a new file, and it excludes.
      const again = await startHolder(lock, 'sqlite');
      expect(await probe(lock, 'sqlite')).toBe('held');
      await again.release();
    });

    it('the housekeeping of a holder process leaves its own lock in place', async () => {
      const lock = join(tmp, 'sq-own');
      const release = await holdLockWith(sqliteMake, lock);
      await sweepHeldLocks(tmp, async () => false, 50_000, sqliteMake);
      expect(await discardHeldLock(lock, sqliteMake)).toBe(false);
      expect(existsSync(heldPath(lock))).toBe(true);
      expect(await probe(lock, 'sqlite')).toBe('held');
      release();
      expect(await probe(lock, 'sqlite')).toBe('free');
    });

    // The taker reads the file's inode before it opens it. Read after the open, a file deleted
    // and replaced in between would pass the check for a connection on the deleted file: two
    // holders, one on each file.
    it('does not hold a deleted file when a replacement appears while it opens', async () => {
      const lock = join(tmp, 'sq-replaced');
      const real = loadSqlite()!;
      writeFileSync(heldPath(lock), '');
      let replaced = false;
      const replacing = {
        ...real,
        DatabaseSync: class extends real.DatabaseSync {
          constructor(path: string) {
            super(path);
            if (replaced) return;
            replaced = true;
            // Another process's cleanup deleting the file and a taker creating its replacement.
            unlinkSync(path);
            new real.DatabaseSync(path).close();
          }
        },
      } as Sqlite;
      const release = await holdLockWith((path) => sqliteAttempt(path, replacing), lock);
      expect(replaced).toBe(true);
      expect(await probe(lock, 'sqlite')).toBe('held');
      release();
    });

    it('creates no side file, and locks a read-only folder', async () => {
      const lock = join(tmp, 'sq-journal');
      const release = await holdLockWith(sqliteMake, lock);
      expect(readdirSync(tmp).filter((name) => name.startsWith('sq-journal'))).toEqual([
        'sq-journal.held',
      ]);
      expect(await probe(lock, 'sqlite')).toBe('held');
      release();
      if (!posix || process.getuid?.() === 0) return;
      const folder = join(tmp, 'sq-readonly');
      mkdirSync(folder);
      const inside = join(folder, 'lock');
      (await holdLockWith(sqliteMake, inside))();
      chmodSync(folder, 0o555);
      try {
        const held = await holdLockWith(sqliteMake, inside);
        expect(await probe(inside, 'sqlite')).toBe('held');
        held();
      } finally {
        chmodSync(folder, 0o755);
      }
    });

    it('still excludes a second process with the journal in memory', async () => {
      const lock = join(tmp, 'sq-exclude');
      const held = await startHolder(lock, 'sqlite');
      await expect(holdLockWith(sqliteMake, lock, { timeoutMs: 0 })).rejects.toBeInstanceOf(
        LockTimeoutError,
      );
      await held.release();
      (await holdLockWith(sqliteMake, lock, { timeoutMs: 1000 }))();
    });

    it('keeps its connection until the release runs, so a lost release does not lose the lock', async () => {
      const lock = join(tmp, 'sq-gc');
      expect(heldConnections()).toBe(0);
      const release = await holdLockWith(sqliteMake, lock);
      expect(heldConnections()).toBe(1);
      release();
      expect(heldConnections()).toBe(0);
      // A holder that drops its release and collects garbage still holds.
      const lost = await forgetter(lock, 'sqlite');
      expect(await probe(lock, 'sqlite')).toBe('held');
      lost.proc.kill('SIGKILL');
      await lost.exited;
      expect(await probe(lock, 'sqlite')).toBe('free');
    });

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

// Issue 577: a terminal command judges the Node that runs the worker, not the terminal's own.
it('judges the Node it is given on Linux, and this one on macOS and Windows', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  try {
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
    expect(lockSupport('24.22.3')).toEqual({ ok: true });
    expect(lockSupport('22.13.0')).toEqual({ ok: true });
    expect(lockSupport('22.12.9')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('this is Node 22.12.9'),
    });
    expect(lockSupport('20.19.0')).toMatchObject({ ok: false });
    Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
    expect(lockSupport('20.19.0')).toEqual({ ok: true });
  } finally {
    Object.defineProperty(process, 'platform', platform);
  }
});

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

async function runStress(
  ms: string,
  chaos: string,
  workers: string,
  broken = '0',
  minBroken = '0',
  primitive = '',
) {
  const run = child(
    'stress.ts',
    ms,
    chaos,
    workers,
    join(tmp, 'stress'),
    broken,
    minBroken,
    primitive,
  );
  return JSON.parse(await run.line('{')) as {
    rounds: number;
    overlaps: number;
    timeouts: number;
    errors: number;
    broken: number;
  };
}

// The control for the harness: against a lock that is skipped on 2% of the rounds, the log
// detector MUST report overlaps. The run goes on until the workers broke the lock 10 times (a
// slow runner reached 23 of 25 inside the time cap), and a detector that sees none of 10 breaks
// has proved nothing about a real lock. Local runs reported an overlap for every break (47 of 47),
// so missing all ten by luck is far below one in a thousand even if only half of the breaks met
// another holder.
const primitives = [''].concat(
  process.platform !== 'linux' && process.platform !== 'win32' && loadSqlite() ? ['sqlite'] : [],
);
it.each(primitives.map((primitive) => ({ primitive, name: primitive || 'platform' })))(
  'the stress detector sees two holders when the lock is broken on 2 percent of the rounds ($name)',
  async ({ primitive }) => {
    const result = await runStress('4000', 'none', '4', '0.02', '10', primitive);
    // Ten breaks cannot be met by luck at 2 percent, and a slow runner reaches them.
    expect(result.broken).toBeGreaterThanOrEqual(10);
    expect(result.rounds).toBeGreaterThan(result.broken);
    expect(result.overlaps).toBeGreaterThan(0);
    // One break meets at most one other holder on each side, so more overlaps than that
    // would be the detector counting something else.
    expect(result.overlaps).toBeLessThanOrEqual(2 * result.broken);
    expect(result.errors).toBe(0);
    console.warn(`lock stress control: ${JSON.stringify(result)}`);
  },
  90_000,
);

const stress = process.env.TENJIN_LOCK_STRESS === '1';
describe.skipIf(!stress)('stress (opt in with TENJIN_LOCK_STRESS=1)', () => {
  it('lets no two holders in, with kills, stops and deleted lock files', async () => {
    vi.stubEnv('STRESS_DISCARD', '0.1');
    const result = await runStress(
      process.env.TENJIN_LOCK_STRESS_MS ?? '20000',
      process.env.TENJIN_LOCK_STRESS_CHAOS ?? 'both',
      process.env.TENJIN_LOCK_STRESS_WORKERS ?? '8',
      '0',
      '0',
      process.env.TENJIN_LOCK_STRESS_PRIMITIVE ?? '',
    );
    vi.unstubAllEnvs();
    console.warn(`lock stress: ${JSON.stringify(result)}`);
    // Zero overlaps in a handful of rounds proves nothing: require a run that was long enough.
    expect(result.rounds).toBeGreaterThan(500);
    expect(result.broken).toBe(0);
    expect(result.overlaps).toBe(0);
    expect(result.errors).toBe(0);
  }, 120_000);
});
