import { execFile } from 'node:child_process';
import { lstat, readdir, readFile, realpath, rm } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pidAlive } from '../lib/lock';
import { WORKER_WALL_MS } from './model-worker-control';

/**
 * THE FOLDERS A DEEPSEEK JOB LEAVES ON DISK, and how they go.
 *
 * - `tenjin-worker-settings-*` (system temp): the worker's flag settings file, which holds the
 *   job's bridge token and GitHub token (`claude-worker-process`).
 * - `tenjin-worker-*` (system temp): the job's gh config, caches, run logs and gitconfig
 *   (`worker-github`); `tenjin-worker-cancel-*` is the Windows launcher's stop file.
 * - `/tmp/tenjin-job-*`: the job's commands' output and its scratchpad (`claude-worker-session`).
 *
 * Each job removes its own once its child has exited ({@link removeJobFolder}), also when its
 * end is an error, a cancel or the wall time. A crash or a kill of `tenjin mcp` cannot run
 * that, so each folder carries {@link JOB_FOLDER_MARKER} (the process that made it) and
 * `tenjin mcp` sweeps stale ones at start ({@link sweepJobFolders}).
 */
export const JOB_FOLDER_MARKER = 'tenjin-owner.json';

/** Folder names a job makes, by the random six characters `mkdtemp` adds. */
const JOB_FOLDER_NAME =
  /^(?:tenjin-worker-settings-|tenjin-worker-cancel-|tenjin-worker-|tenjin-job-)[A-Za-z0-9]{6}$/;

/** No job is still going this long after it started: the wall limit, then a long margin. */
export const JOB_FOLDER_STALE_MS = WORKER_WALL_MS + 15 * 60_000;
/** A folder whose owner is gone is still left this long, so a folder being made is never taken. */
const DEAD_OWNER_FLOOR_MS = 60_000;
/** `ps` shows a start time to the second; the process's own count of its uptime drifts a little. */
const START_TOLERANCE_MS = 10_000;

type Marker = { pid: number; startedAt: number };

/** When this process started, in ms: what its folders' markers name it by. */
const ownStart = () => Math.round(Date.now() - process.uptime() * 1000);

/**
 * Names the process that made a job folder. Written inside the folder with mode 0600; a
 * failed write leaves the folder to the age rule of the sweep, never fails the job.
 */
export function markJobFolder(folder: string): void {
  try {
    const marker: Marker = { pid: process.pid, startedAt: ownStart() };
    writeFileSync(join(folder, JOB_FOLDER_MARKER), JSON.stringify(marker), {
      mode: 0o600,
      flag: 'wx',
    });
  } catch {
    // The sweep treats a folder with no marker by its age.
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const RETRY_WAITS = [50, 150, 400];

/**
 * Removes a job's folder. Never throws: a delete that fails (a dying descendant still
 * writing into it, a busy file) is tried again and then left to the next sweep, and never
 * changes the job's result. Returns whether the folder is gone.
 */
export async function removeJobFolder(folder: string): Promise<boolean> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(folder, { recursive: true, force: true });
      return true;
    } catch {
      const wait = RETRY_WAITS[attempt];
      if (wait === undefined) return false;
      await sleep(wait);
    }
  }
}

export type ProcessFacts = {
  /** Whether the process exists. */
  alive: (pid: number) => boolean;
  /** When the process started, or undefined where that cannot be read. */
  startedAt: (pid: number) => Promise<number | undefined>;
  /** The command lines (and, where the system shows them, environments) of this user's processes. */
  commandLines: () => Promise<string | undefined>;
};

const run = (file: string, args: string[]) =>
  new Promise<string>((resolve, reject) =>
    execFile(
      file,
      args,
      { timeout: 10_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } },
      (error, stdout) => (error ? reject(error) : resolve(String(stdout))),
    ),
  );

export const systemProcessFacts: ProcessFacts = {
  alive: pidAlive,
  startedAt: async (pid) => {
    if (process.platform === 'win32') return undefined;
    try {
      const at = Date.parse((await run('ps', ['-o', 'lstart=', '-p', String(pid)])).trim());
      return Number.isFinite(at) ? at : undefined;
    } catch {
      return undefined;
    }
  },
  commandLines: async () => {
    if (process.platform === 'win32') return undefined;
    try {
      // `E` (macOS) and `e` (Linux) add each process's environment, where GH_CONFIG_DIR and
      // CLAUDE_CODE_TMPDIR name a job's folders; the settings file is on its command line.
      return await run('ps', [
        process.platform === 'darwin' ? '-axwwE' : 'axwwe',
        '-o',
        'command=',
      ]);
    } catch {
      return undefined;
    }
  },
};

export type SweepOptions = {
  /** Where job folders can be. Default: the system temp folder and /tmp. */
  directories?: readonly string[];
  now?: number;
  facts?: ProcessFacts;
  /** The longest a job can live, which a folder with no live owner must exceed. */
  staleMs?: number;
  /** When a folder was last changed. Default: the newest of its birth, modification and change times. */
  changedAt?: (stat: Stats) => number;
};

const newest = (stat: Stats) => Math.max(stat.birthtimeMs, stat.mtimeMs, stat.ctimeMs);

async function readMarker(folder: string): Promise<Marker | undefined> {
  try {
    const raw = JSON.parse(await readFile(join(folder, JOB_FOLDER_MARKER), 'utf8')) as Marker;
    return Number.isInteger(raw.pid) && raw.pid > 0 && Number.isFinite(raw.startedAt)
      ? { pid: raw.pid, startedAt: raw.startedAt }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Removes the job folders that nothing can still use, and returns their paths. Never throws.
 *
 * A folder is stale, by facts and then by age:
 * - its marker names a process that is gone, or whose pid another process now holds (its
 *   start time differs), and the folder is over a minute old; or
 * - its marker names a process whose start cannot be read, and the folder is older than any
 *   job can be; or
 * - it has no marker (an older build made it), it is older than any job can be, and no
 *   process names it on its command line or in its environment.
 * A folder whose owner is this process, or a live process that started when the marker says,
 * is never removed, so a job of another `tenjin mcp` stays untouched. Where the process list
 * cannot be read, a folder with no marker stays.
 */
export async function sweepJobFolders(o: SweepOptions = {}): Promise<string[]> {
  try {
    const now = o.now ?? Date.now();
    const facts = o.facts ?? systemProcessFacts;
    const staleMs = o.staleMs ?? JOB_FOLDER_STALE_MS;
    const uid = process.getuid?.();
    // Each folder by its real path, with the spelling its directory was given: a process
    // names it by either.
    const roots = new Map<string, string>();
    for (const dir of o.directories ?? [tmpdir(), '/tmp'])
      roots.set(await realpath(dir).catch(() => dir), dir);
    let commandLines: string | undefined | null = null;
    const removed: string[] = [];
    for (const [root, given] of roots) {
      const names = await readdir(root).catch(() => [] as string[]);
      for (const name of names) {
        if (!JOB_FOLDER_NAME.test(name)) continue;
        const folder = join(root, name);
        try {
          const stat = await lstat(folder);
          if (!stat.isDirectory() || (uid !== undefined && stat.uid !== uid)) continue;
          // The newest of its times: a folder is as old as its latest change.
          const age = now - (o.changedAt ?? newest)(stat);
          const marker = await readMarker(folder);
          let stale: boolean;
          if (marker) {
            if (marker.pid === process.pid) continue;
            if (!facts.alive(marker.pid)) stale = age > DEAD_OWNER_FLOOR_MS;
            else {
              const started = await facts.startedAt(marker.pid);
              stale =
                started === undefined
                  ? age > staleMs
                  : Math.abs(started - marker.startedAt) > START_TOLERANCE_MS &&
                    age > DEAD_OWNER_FLOOR_MS;
            }
          } else {
            if (age <= staleMs) continue;
            if (commandLines === null) commandLines = await facts.commandLines();
            stale =
              commandLines !== undefined &&
              !commandLines.includes(folder) &&
              !commandLines.includes(join(given, name));
          }
          if (stale && (await removeJobFolder(folder))) removed.push(folder);
        } catch {
          // Gone, or not ours to read: left alone.
        }
      }
    }
    return removed;
  } catch {
    return [];
  }
}
