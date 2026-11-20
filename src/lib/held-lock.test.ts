import {
  closeSync,
  constants,
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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  discardHeldLock,
  HeldLockTimeoutError,
  holdLock,
  holdLockWith,
  LockUnavailableError,
  openAttempt,
  resetSelfTest,
  sweepHeldLocks,
  systemOpenDeps,
  withHeldLock,
  type OpenDeps,
} from './held-lock';
import {
  entryGone,
  entryName,
  linuxAttempt,
  parseEntry,
  parseStat,
  readIdentity,
  reapLockDir,
  reapPrepared,
  systemFs,
  type Identity,
  type LinuxDeps,
  type Proc,
} from './held-lock-linux';
import { child, holder as startHolder, killChildren, probe } from './held-lock-test/child';
import { LockTimeoutError } from './lock';

const posix = process.platform !== 'win32';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'held-lock-'));
});
afterEach(() => {
  killChildren();
  rmSync(tmp, { recursive: true, force: true });
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
    const before = existsSync(heldPath(lock)) ? readdirOrFile(heldPath(lock)) : [];
    held.proc.kill('SIGSTOP');
    await expect(holdLock(lock, { timeoutMs: 0 })).rejects.toBeInstanceOf(LockTimeoutError);
    // Nothing was evicted: on Linux the entry is unchanged.
    expect(readdirOrFile(heldPath(lock))).toEqual(before);
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
    expect(readdirSync(tmp).filter((name) => name.includes('.held.new-'))).toEqual([]);
    await expect(holdLock(lock, { timeoutMs: 0 })).rejects.toBeInstanceOf(LockTimeoutError);
    release();
  });

  it('names the lock in a timeout', async () => {
    const lock = join(tmp, 'g');
    const release = await holdLock(lock);
    const error = await holdLock(lock, { timeoutMs: 20, retryMs: 5 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HeldLockTimeoutError);
    expect(error).toMatchObject({ name: 'LockTimeoutError', lockPath: lock });
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

function readdirOrFile(path: string): string[] {
  return statSync(path).isDirectory() ? readdirSync(path) : [];
}

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
});

// ---------------------------------------------------------------------------
// The Linux scheme, forced through injected /proc readers and forged entry names. The
// rename-onto-an-empty-directory rule these rely on holds on Linux and macOS.
// ---------------------------------------------------------------------------

const NS = '4026532381';
const BOOT = 'b'.repeat(32);
const MACHINE = 'a'.repeat(32);

function world() {
  const live = new Map<number, { state: string; ticks: string }>();
  const proc: Proc = {
    read(path) {
      const m = /^\/proc\/(\d+)\/stat$/.exec(path);
      const entry = m ? live.get(Number(m[1])) : undefined;
      return entry
        ? `${m![1]} (cmd (x)) ${[entry.state, ...Array<string>(18).fill('0'), entry.ticks].join(' ')}\n`
        : undefined;
    },
    readlink: () => undefined,
    kill0: (pid) => (live.has(pid) ? 'exists' : 'gone'),
  };
  return { live, proc };
}

const identity = (pid: number, over: Partial<Identity> = {}): Identity => ({
  pid,
  ticks: '1000',
  pidns: NS,
  offset: '0_0',
  boot: BOOT,
  machine: MACHINE,
  ...over,
});

function deps(
  w: ReturnType<typeof world>,
  self: Identity,
  extra: Partial<LinuxDeps> = {},
): LinuxDeps {
  return { fs: systemFs, proc: w.proc, self: () => self, ...extra };
}

describe.skipIf(!posix)('named-entry lock (Linux scheme)', () => {
  const lockDir = () => join(tmp, 'l.held');
  const names = () => readdirSync(lockDir());
  /** A holder with pid `pid` that is alive in the fake world. */
  function holderOf(w: ReturnType<typeof world>, pid: number, over: Partial<Identity> = {}) {
    const id = identity(pid, over);
    w.live.set(pid, { state: 'S', ticks: id.ticks });
    const release = linuxAttempt(lockDir(), deps(w, id)).tryOnce();
    expect(release).not.toBeNull();
    return { id, release: release! };
  }
  const judge = (w: ReturnType<typeof world>, selfOver: Partial<Identity> = {}) =>
    linuxAttempt(lockDir(), deps(w, identity(222, selfOver)));

  beforeEach(() => {
    mkdirSync(tmp, { recursive: true });
  });

  it('parses the name it makes, and nothing else', () => {
    const id = identity(5, { offset: 'n12_34' });
    const name = entryName('0123456789abcdef', id);
    expect(parseEntry(name)).toEqual(id);
    for (const junk of ['meta', 'h-zz', `${name}x`, '']) expect(parseEntry(junk)).toBeUndefined();
  });

  it('reads the identity from /proc, with x for what it cannot read', () => {
    const files: Record<string, string> = {
      '/proc/self/stat': `7 (a b) S ${Array<string>(18).fill('0').join(' ')} 4321 0\n`,
      '/proc/self/timens_offsets': 'monotonic 0 0\nboottime -5 9\n',
      '/proc/sys/kernel/random/boot_id': `${'b'.repeat(8)}-${'b'.repeat(24)}\n`,
    };
    const links: Record<string, string> = { '/proc/self': '7', '/proc/self/ns/pid': 'pid:[42]' };
    const proc: Proc = {
      read: (path) => files[path],
      readlink: (path) => links[path],
      kill0: () => 'exists',
    };
    expect(readIdentity(proc, 7)).toEqual({
      pid: 7,
      ticks: '4321',
      pidns: '42',
      offset: 'n5_9',
      boot: BOOT,
      machine: 'x',
    });
    expect(parseStat('1 (x) S 0')).toBeUndefined();
  });

  it('leaves its own entry and a live holder alone, and a second holder waits', () => {
    const w = world();
    const first = holderOf(w, 111);
    const before = names();
    expect(judge(w).tryOnce()).toBeNull();
    expect(names()).toEqual(before);
    first.release();
    expect(existsSync(lockDir())).toBe(false);
  });

  it('evicts a holder whose process is gone and takes the lock', () => {
    const w = world();
    holderOf(w, 111);
    w.live.delete(111);
    const release = judge(w).tryOnce();
    expect(release).not.toBeNull();
    expect(names()).toHaveLength(1);
    expect(parseEntry(names()[0]!)?.pid).toBe(222);
    release!();
  });

  it('evicts an entry whose pid was reused (other start ticks)', () => {
    const w = world();
    holderOf(w, 111);
    w.live.set(111, { state: 'S', ticks: '1001' });
    expect(judge(w).tryOnce()).not.toBeNull();
  });

  it('never evicts an entry from another pid namespace, or one with none', () => {
    for (const pidns of ['4026532999', 'x']) {
      const w = world();
      holderOf(w, 111, { pidns });
      w.live.delete(111);
      const before = names();
      expect(judge(w).tryOnce()).toBeNull();
      expect(names()).toEqual(before);
      rmSync(lockDir(), { recursive: true });
    }
  });

  it('never evicts an entry from another time offset', () => {
    const w = world();
    holderOf(w, 111, { offset: '100000_0' });
    w.live.delete(111);
    expect(judge(w).tryOnce()).toBeNull();
    expect(names()).toHaveLength(1);
  });

  it('judges a reboot only on the same machine id', () => {
    const other = 'c'.repeat(32);
    const cases: Array<[Partial<Identity>, boolean]> = [
      [{ boot: other }, true],
      [{ boot: other, machine: other }, false],
      [{ boot: other, machine: 'x' }, false],
      [{ boot: 'x' }, false],
    ];
    for (const [over, evicted] of cases) {
      const w = world();
      holderOf(w, 111, over);
      expect(judge(w).tryOnce() !== null).toBe(evicted);
      rmSync(lockDir(), { recursive: true });
    }
  });

  it('evicts a zombie', () => {
    const w = world();
    holderOf(w, 111);
    w.live.set(111, { state: 'Z', ticks: '1000' });
    expect(judge(w).tryOnce()).not.toBeNull();
  });

  it('never removes what it does not understand', () => {
    const w = world();
    mkdirSync(lockDir());
    writeFileSync(join(lockDir(), 'meta'), '{}');
    expect(judge(w).tryOnce()).toBeNull();
    writeFileSync(join(lockDir(), 'junk'), '');
    expect(judge(w).tryOnce()).toBeNull();
    expect(names().sort()).toEqual(['junk', 'meta']);
    rmSync(lockDir(), { recursive: true });
    // Two forged entries, both gone: still never judged.
    mkdirSync(lockDir(), { recursive: true });
    for (const pid of [301, 302])
      writeFileSync(join(lockDir(), entryName(String(pid).padStart(16, '0'), identity(pid))), '');
    expect(judge(w).tryOnce()).toBeNull();
    expect(names()).toHaveLength(2);
  });

  it('a process that cannot read its own /proc judges nobody', () => {
    const w = world();
    holderOf(w, 111);
    w.live.delete(111);
    for (const self of [identity(222, { pidns: 'x' }), identity(222, { ticks: 'x' })])
      expect(linuxAttempt(lockDir(), deps(w, self)).tryOnce()).toBeNull();
    expect(names()).toHaveLength(1);
  });

  it('leaves the waiter intact when a release is paused between its two steps', () => {
    const w = world();
    let waiter: (() => void) | null = null;
    const id = identity(111);
    w.live.set(111, { state: 'S', ticks: id.ticks });
    const releaser = linuxAttempt(
      lockDir(),
      deps(w, id, {
        hook: (point) => {
          // The entry is gone and the directory is empty: a waiter renames onto it.
          if (point === 'unlinked') waiter = judge(w).tryOnce();
        },
      }),
    );
    const release = releaser.tryOnce()!;
    release();
    expect(waiter).not.toBeNull();
    expect(names()).toHaveLength(1);
    expect(parseEntry(names()[0]!)?.pid).toBe(222);
    waiter!();
    expect(existsSync(lockDir())).toBe(false);
  });

  it('a stale evictor resumes onto a successor and changes nothing', () => {
    const w = world();
    holderOf(w, 111);
    w.live.delete(111);
    let successor: (() => void) | null = null;
    w.live.set(333, { state: 'S', ticks: '1000' });
    const stale = linuxAttempt(
      lockDir(),
      deps(w, identity(222), {
        hook: (point) => {
          // Paused after judging: another waiter evicts the same entry and takes the lock.
          if (point === 'judged')
            successor = linuxAttempt(lockDir(), deps(w, identity(333))).tryOnce();
        },
      }),
    );
    expect(stale.tryOnce()).toBeNull();
    expect(successor).not.toBeNull();
    expect(names()).toHaveLength(1);
    expect(parseEntry(names()[0]!)?.pid).toBe(333);
  });

  it('an evictor paused between unlink and rmdir cannot remove a successor', () => {
    const w = world();
    holderOf(w, 111);
    w.live.delete(111);
    w.live.set(333, { state: 'S', ticks: '1000' });
    let successor: (() => void) | null = null;
    const evictor = linuxAttempt(
      lockDir(),
      deps(w, identity(222), {
        hook: (point) => {
          if (point === 'released')
            successor = linuxAttempt(lockDir(), deps(w, identity(333))).tryOnce();
        },
      }),
    );
    expect(evictor.tryOnce()).toBeNull();
    expect(successor).not.toBeNull();
    expect(parseEntry(names()[0]!)?.pid).toBe(333);
  });

  it('removes its prepared directory when the wait is abandoned', () => {
    const w = world();
    holderOf(w, 111);
    const waiting = judge(w);
    expect(waiting.tryOnce()).toBeNull();
    expect(readdirSync(tmp).some((name) => name.includes('.held.new-'))).toBe(true);
    waiting.abandon();
    expect(readdirSync(tmp).filter((name) => name.includes('.held.new-'))).toEqual([]);
  });

  it('sweeps a prepared directory only when its entry is gone, and a lock directory by its two steps', () => {
    const w = world();
    const self = identity(222);
    const prepared = (pid: number) => {
      const path = join(tmp, `p${pid}.held.new-${'0'.repeat(15)}${pid % 10}`);
      mkdirSync(path);
      writeFileSync(join(path, entryName('0'.repeat(16), identity(pid))), '');
      return path;
    };
    w.live.set(401, { state: 'S', ticks: '1000' });
    const alive = prepared(401);
    const gone = prepared(402);
    expect(reapPrepared(alive, deps(w, self))).toBe(false);
    expect(reapPrepared(gone, deps(w, self))).toBe(true);
    expect(existsSync(alive)).toBe(true);
    expect(existsSync(gone)).toBe(false);

    holderOf(w, 111);
    w.live.delete(111);
    expect(reapLockDir(lockDir(), deps(w, self))).toBe(true);
    expect(existsSync(lockDir())).toBe(false);
    holderOf(w, 112);
    expect(reapLockDir(lockDir(), deps(w, self))).toBe(false);
    expect(existsSync(lockDir())).toBe(true);
    expect(entryGone('meta', self, w.proc)).toBe(false);
  });

  it('clears the lock of a killed child at its next waiter (real /proc, Linux only)', async () => {
    if (process.platform !== 'linux') return;
    const lock = join(tmp, 'real');
    const held = await startHolder(lock);
    await held.kill();
    (await holdLock(lock, { timeoutMs: 1000 }))();
  });
});

const stress = process.env.TENJIN_LOCK_STRESS === '1';
describe.skipIf(!stress)('stress (opt in with TENJIN_LOCK_STRESS=1)', () => {
  it('lets no two holders in, with kills and stops', async () => {
    const run = child(
      'stress.ts',
      process.env.TENJIN_LOCK_STRESS_MS ?? '20000',
      process.env.TENJIN_LOCK_STRESS_CHAOS ?? 'both',
      process.env.TENJIN_LOCK_STRESS_WORKERS ?? '4',
      join(tmp, 'stress'),
    );
    const result = JSON.parse(await run.line('{')) as {
      rounds: number;
      overlaps: number;
      timeouts: number;
      errors: number;
    };
    console.warn(`lock stress: ${JSON.stringify(result)}`);
    expect(result.rounds).toBeGreaterThan(0);
    expect(result.overlaps).toBe(0);
    expect(result.errors).toBe(0);
  }, 120_000);
});
