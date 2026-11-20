import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * WHICH PROCESS A PID NAMES, as a token that is the same for the life of one process and
 * differs for the next process that takes the pid. Compared for equality only: it is never
 * ordered or aged, so no wall clock decides anything.
 *
 * - Linux: field 22 of `/proc/<pid>/stat`, the start in clock ticks since boot. Read from the
 *   file, no fork.
 * - macOS and other Unix: `ps -o lstart= -p <pid>`, which the kernel stores at process start
 *   (read in UTC with the C locale). One fork, so callers read a holder at most once per wait.
 * - Windows: none (undefined). Nothing the repo already has reads a creation time cheaply.
 *
 * Undefined means the token cannot be read; callers treat that as alive.
 */
export function processStartToken(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    if (platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      // The command name is in parentheses and may hold spaces or parentheses: count from the last.
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      // `fields[0]` is field 3 (the state), so field 22 is `fields[19]`.
      const start = fields[19];
      return start && /^\d+$/.test(start) ? `linux:${start}` : undefined;
    }
    if (platform === 'win32') return undefined;
    const out = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2000,
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    });
    const text = String(out.stdout).trim();
    return out.status === 0 && text ? `ps:${text}` : undefined;
  } catch {
    return undefined;
  }
}

let own: string | undefined | null = null;
/** This process's own token, read once. */
export function ownStartToken(): string | undefined {
  if (own === null) own = processStartToken(process.pid);
  return own;
}

/**
 * Whether a process that recorded `token` for `pid` is gone: its pid is not running, or the pid
 * is held by a process with a different token (a reused pid). A token that was never recorded
 * or cannot be read now is alive: the pid alone decides, and a doubt reads as alive.
 * `read` memoizes one wait's reads by pid and recorded token, so a holder is read once per wait.
 */
export function holderGone(
  pid: number,
  token: string | undefined,
  alive: (pid: number) => boolean,
  read: Map<string, string | undefined> = new Map(),
): boolean {
  if (!alive(pid)) return true;
  if (token === undefined) return false;
  // Keyed by the recorded token too: a pid reused by another holder of the same lock is another key.
  const key = `${pid}:${token}`;
  if (!read.has(key)) read.set(key, processStartToken(pid));
  const now = read.get(key);
  return now !== undefined && now !== token;
}
