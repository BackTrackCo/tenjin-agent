import { randomBytes } from 'node:crypto';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { hasCode } from './errno';

/**
 * THE LINUX HALF OF A HELD LOCK. Node's standard library has no lock the system releases when
 * its process ends on Linux, so the lock here is a directory `L` that holds one empty file, the
 * holder's entry. The entry's NAME carries who holds it (pid, start ticks, pid namespace, time
 * offset, boot id, machine id), and nothing ever reads an entry's contents.
 *
 * - L appears whole, with exactly one entry, by one rename of a prepared directory onto an
 *   absent or empty L. A second holder's rename fails while L has anything in it.
 * - A waiter removes an entry only when its process is certainly gone, and only by that exact
 *   name (`unlink`), then `rmdir`s L, which removes only an empty directory. A stale action is
 *   therefore a no-op, never a theft: no gate, no rename of L, no `rm -r` of L, no fork, no
 *   wall clock.
 * - Anything this process cannot judge (another pid namespace, another time offset, an unreadable
 *   `/proc`, an unknown name) reads as alive: a dead lock a person removes, never a theft.
 */

/** What is read from the system, so tests can force each branch. */
export interface Proc {
  read(path: string): string | undefined;
  readlink(path: string): string | undefined;
  /** `kill(pid, 0)`: 'gone' is ESRCH; 'exists' is success or EPERM; 'other' is anything else. */
  kill0(pid: number): 'gone' | 'exists' | 'other';
}

export const systemProc: Proc = {
  read(path) {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return undefined;
    }
  },
  readlink(path) {
    try {
      return readlinkSync(path);
    } catch {
      return undefined;
    }
  },
  kill0(pid) {
    try {
      process.kill(pid, 0);
      return 'exists';
    } catch (error) {
      if (hasCode(error, 'ESRCH')) return 'gone';
      return hasCode(error, 'EPERM') ? 'exists' : 'other';
    }
  },
};

/** The file calls the scheme makes. Tests wrap them to stop between two steps. */
export interface LockFs {
  mkdir(path: string): void;
  createEntry(path: string): void;
  rename(from: string, to: string): void;
  readdir(path: string): string[];
  unlink(path: string): void;
  rmdir(path: string): void;
  removeTree(path: string): void;
}

export const systemFs: LockFs = {
  mkdir: (path) => mkdirSync(path, { mode: 0o700 }),
  createEntry: (path) => writeFileSync(path, '', { flag: 'wx', mode: 0o600 }),
  rename: renameSync,
  readdir: (path) => readdirSync(path),
  unlink: unlinkSync,
  rmdir: rmdirSync,
  removeTree: (path) => rmSync(path, { recursive: true, force: true }),
};

/** A holder's identity. `x` marks a field that could not be read. */
export interface Identity {
  pid: number;
  ticks: string;
  pidns: string;
  offset: string;
  boot: string;
  machine: string;
}

const UNKNOWN = 'x';
const ENTRY =
  /^h-([0-9a-f]{16})-(\d+)-(\d+|x)-(\d+|x)-(n?\d+_\d+|x)-([0-9a-f]{32}|x)-([0-9a-f]{32}|x)$/;

/** The state and start ticks from the text of a `/proc/<pid>/stat`, counted after the last `)`. */
export function parseStat(text: string | undefined): { state: string; ticks: string } | undefined {
  if (text === undefined) return undefined;
  const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
  // `fields[0]` is field 3 (the state), so field 22 is `fields[19]`.
  const ticks = fields[19]?.trim();
  const state = fields[0];
  return state && ticks && /^\d+$/.test(ticks) ? { state, ticks } : undefined;
}

/** Reads this process's identity. Once per process in normal use. */
export function readIdentity(proc: Proc, pid: number = process.pid): Identity {
  const ticks = parseStat(proc.read('/proc/self/stat'))?.ticks ?? UNKNOWN;
  // `/proc` belongs to this pid namespace only when it names this process as `self`.
  const ownProc = proc.readlink('/proc/self') === String(pid);
  const pidns = ownProc
    ? (/\[(\d+)\]/.exec(proc.readlink('/proc/self/ns/pid') ?? '')?.[1] ?? UNKNOWN)
    : UNKNOWN;
  const boottime = /^boottime\s+(-?\d+)\s+(\d+)\s*$/m.exec(
    proc.read('/proc/self/timens_offsets') ?? '',
  );
  const offset = boottime ? `${boottime[1]!.replace('-', 'n')}_${boottime[2]}` : UNKNOWN;
  const id = (text: string | undefined) => {
    const value = text?.trim().replaceAll('-', '');
    return value && /^[0-9a-f]{32}$/.test(value) ? value : UNKNOWN;
  };
  return {
    pid,
    ticks,
    pidns,
    offset,
    boot: id(proc.read('/proc/sys/kernel/random/boot_id')),
    machine: id(proc.read('/etc/machine-id')),
  };
}

export function entryName(owner: string, id: Identity): string {
  return `h-${owner}-${id.pid}-${id.ticks}-${id.pidns}-${id.offset}-${id.boot}-${id.machine}`;
}

/** A holder's identity from its entry name, or undefined for a name that is not an entry. */
export function parseEntry(name: string): Identity | undefined {
  const m = ENTRY.exec(name);
  if (!m) return undefined;
  return {
    pid: Number(m[2]),
    ticks: m[3]!,
    pidns: m[4]!,
    offset: m[5]!,
    boot: m[6]!,
    machine: m[7]!,
  };
}

/**
 * Whether the process behind an entry is certainly gone. "Alive" includes "cannot tell": only an
 * exact judgment inside one pid namespace and one time offset, or a reboot proven by the boot
 * id of the same machine, says gone.
 */
export function entryGone(name: string, self: Identity, proc: Proc): boolean {
  const entry = parseEntry(name);
  if (!entry) return false;
  if (self.ticks === UNKNOWN || self.pidns === UNKNOWN) return false;
  if (entry.boot !== self.boot) {
    return (
      entry.boot !== UNKNOWN &&
      self.boot !== UNKNOWN &&
      entry.machine !== UNKNOWN &&
      self.machine !== UNKNOWN &&
      entry.machine === self.machine
    );
  }
  if (entry.pidns !== self.pidns) return false;
  if (entry.offset !== self.offset) return false;
  const killed = proc.kill0(entry.pid);
  if (killed === 'gone') return true;
  if (killed === 'other') return false;
  const stat = parseStat(proc.read(`/proc/${entry.pid}/stat`));
  if (!stat) return false;
  if (stat.state === 'Z' || stat.state === 'X') return true;
  return entry.ticks !== UNKNOWN && stat.ticks !== entry.ticks;
}

export interface LinuxDeps {
  fs: LockFs;
  proc: Proc;
  /** This process's identity, read once. */
  self: () => Identity;
  /** Called with a short name for a point between two steps; tests stop the process there. */
  hook?: (point: 'judged' | 'unlinked' | 'released') => void;
  /** Reports a lock that was lost while held. Cannot happen by design. */
  onLost?: (lockDir: string) => void;
}

let ownIdentity: Identity | undefined;
export const systemDeps: LinuxDeps = {
  fs: systemFs,
  proc: systemProc,
  self: () => (ownIdentity ??= readIdentity(systemProc)),
  onLost: (lockDir) =>
    process.emitWarning(`A Tenjin lock entry in ${lockDir} was removed while it was held.`),
};

const REPEATS = 4;

/**
 * One acquisition of the directory lock `dir`. `tryOnce` is one attempt, which may evict a dead
 * entry and then take the lock; it returns the release, or null while the lock is held.
 */
export function linuxAttempt(
  dir: string,
  deps: LinuxDeps = systemDeps,
): { tryOnce(): (() => void) | null; abandon(): void } {
  const owner = randomBytes(8).toString('hex');
  const prepared = `${dir}.new-${owner}`;
  const name = entryName(owner, deps.self());
  let made = false;
  let done = false;
  const { fs } = deps;

  const release = (): void => {
    try {
      fs.unlink(join(dir, name));
    } catch {
      // ENOENT means the entry was removed while held, which cannot happen by design; any
      // other error leaves the name until this process ends, and a waiter then clears it.
      deps.onLost?.(dir);
      return;
    }
    deps.hook?.('unlinked');
    try {
      fs.rmdir(dir);
    } catch {
      // ENOTEMPTY: a successor already took the emptied lock, and it is theirs.
    }
  };
  let released = false;
  const once = () => {
    if (released) return;
    released = true;
    release();
  };

  return {
    tryOnce() {
      if (!made) {
        fs.mkdir(prepared);
        try {
          fs.createEntry(join(prepared, name));
        } catch (error) {
          fs.removeTree(prepared);
          throw error;
        }
        made = true;
      }
      for (let repeat = 0; repeat <= REPEATS; repeat++) {
        try {
          fs.rename(prepared, dir);
          done = true;
          return once;
        } catch (error) {
          if (!hasCode(error, 'ENOTEMPTY') && !hasCode(error, 'EEXIST')) {
            fs.removeTree(prepared);
            made = false;
            throw error;
          }
        }
        let entries: string[];
        try {
          entries = fs.readdir(dir);
        } catch (error) {
          if (hasCode(error, 'ENOENT')) continue;
          fs.removeTree(prepared);
          made = false;
          throw error;
        }
        if (entries.length === 0) {
          try {
            fs.rmdir(dir);
          } catch {
            // Something was put in it meanwhile: the next rename says so.
          }
          continue;
        }
        const only = entries[0]!;
        if (entries.length === 1 && entryGone(only, deps.self(), deps.proc)) {
          deps.hook?.('judged');
          try {
            fs.unlink(join(dir, only));
          } catch (error) {
            if (!hasCode(error, 'ENOENT')) return null;
          }
          deps.hook?.('released');
          try {
            fs.rmdir(dir);
          } catch {
            // ENOTEMPTY: a successor took the emptied lock first.
          }
          continue;
        }
        return null;
      }
      return null;
    },
    abandon() {
      if (made && !done) {
        fs.removeTree(prepared);
        made = false;
      }
    },
  };
}

/**
 * Clears what a dead process left of the lock directory `dir`, never what a live one holds:
 * an empty one is removed, and one whose only entry is gone loses that exact entry and then the
 * directory. Never `rm -r`. True when `dir` is gone afterwards.
 */
export function reapLockDir(dir: string, deps: LinuxDeps = systemDeps): boolean {
  const { fs } = deps;
  let entries: string[];
  try {
    entries = fs.readdir(dir);
  } catch (error) {
    return hasCode(error, 'ENOENT');
  }
  if (entries.length === 1 && entryGone(entries[0]!, deps.self(), deps.proc)) {
    try {
      fs.unlink(join(dir, entries[0]!));
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) return false;
    }
  } else if (entries.length > 0) return false;
  try {
    fs.rmdir(dir);
    return true;
  } catch (error) {
    return hasCode(error, 'ENOENT');
  }
}

/**
 * Removes a prepared directory `<lock>.new-<owner>` a killed acquirer left: only when it holds
 * exactly one entry and that entry is gone, because nobody but its owner ever renames it.
 */
export function reapPrepared(dir: string, deps: LinuxDeps = systemDeps): boolean {
  const { fs } = deps;
  try {
    const entries = fs.readdir(dir);
    if (entries.length !== 1 || !entryGone(entries[0]!, deps.self(), deps.proc)) return false;
    fs.removeTree(dir);
    return true;
  } catch {
    return false;
  }
}
