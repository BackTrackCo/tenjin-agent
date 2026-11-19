import { execFile } from 'node:child_process';
import { lstat, readdir, readFile, realpath, rm } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { utimesSync, writeFileSync } from 'node:fs';
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
/**
 * A folder whose owner looks gone is left this long after the owner's last sign of life (its
 * marker is touched every {@link HEARTBEAT_MS} while the job runs). A late sweep costs
 * nothing; a wrong delete loses a running job's files and the money paid for it.
 */
const OWNER_GONE_FLOOR_MS = 2 * 60 * 60_000;
/**
 * A process that holds the owner's pid counts as another one only if it started this long
 * after the owner's last sign of life: no clock change, time zone or rounding makes that
 * gap, and any doubt reads as the owner being alive.
 */
const REUSE_GAP_MS = 10 * 60_000;
const HEARTBEAT_MS = 30_000;

type Marker = { pid: number; startedAt: number };

/** When this process started, in ms: what its folders' markers name it by. */
const ownStart = () => Math.round(Date.now() - process.uptime() * 1000);

/** Folders this process made and still owns, whose markers are touched while it runs. */
const owned = new Set<string>();
let heartbeat: ReturnType<typeof setInterval> | undefined;

function beat() {
  const at = new Date();
  for (const folder of owned) {
    try {
      utimesSync(join(folder, JOB_FOLDER_MARKER), at, at);
    } catch {
      // The folder is gone or unwritable; the sweep reads a stale beat as an owner to check.
    }
  }
}

/**
 * Names the process that made a job folder, and keeps its marker's modification time fresh
 * while this process runs, so a live owner is known without any clock comparison between
 * processes. Written inside the folder with mode 0600; a failed write leaves the folder to
 * the age rule of the sweep, never fails the job.
 */
export function markJobFolder(folder: string): void {
  try {
    const marker: Marker = { pid: process.pid, startedAt: ownStart() };
    writeFileSync(join(folder, JOB_FOLDER_MARKER), JSON.stringify(marker), {
      mode: 0o600,
      flag: 'wx',
    });
    owned.add(folder);
    clearInterval(heartbeat);
    heartbeat = setInterval(beat, HEARTBEAT_MS);
    heartbeat.unref();
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
  owned.delete(folder);
  if (owned.size === 0) clearInterval(heartbeat);
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

/**
 * Reads a `ps -o lstart=` line that was printed with `TZ=UTC` (macOS and Linux, where
 * `lstart` is local time with no offset and so ambiguous in a fall-back hour and missing in a
 * spring-forward gap; in UTC it is neither). Windows has no `ps`: no start time is read there.
 * Anything that does not read as one date is undefined, which the sweep takes as alive.
 */
export function parsePsStart(text: string): number | undefined {
  const line = text.trim();
  if (!/^[A-Z][a-z]{2} [A-Z][a-z]{2} +\d{1,2} \d\d:\d\d:\d\d \d{4}$/.test(line)) return undefined;
  const at = Date.parse(`${line} UTC`);
  return Number.isFinite(at) ? at : undefined;
}

const run = (file: string, args: string[]) =>
  new Promise<string>((resolve, reject) =>
    execFile(
      file,
      args,
      {
        timeout: 10_000,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
      },
      (error, stdout) => (error ? reject(error) : resolve(String(stdout))),
    ),
  );

export const systemProcessFacts: ProcessFacts = {
  alive: pidAlive,
  startedAt: async (pid) => {
    if (process.platform === 'win32') return undefined;
    try {
      return parsePsStart(await run('ps', ['-o', 'lstart=', '-p', String(pid)]));
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
 * A folder with a marker is stale only when ALL hold: its owner's marker has not been touched
 * for hours (a running owner touches it every 30 s, so a live one is known by no clock
 * comparison between processes), and either its owner's pid is gone, or a process that holds
 * the pid started more than ten minutes after that last touch. Every doubt reads as alive: a
 * start time that cannot be read, is off by an hour, or lies in an ambiguous hour never
 * leads to a delete (`ps` is read in UTC besides). A folder with no marker (an older build
 * made it) is stale when it is older than any job can be and no process names it on its
 * command line or in its environment; where the process list cannot be read, it stays.
 * A folder of this process is never removed, so a job of another `tenjin mcp` stays untouched.
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
            // The owner's last sign of life: its marker's own time, which it touches while
            // it runs (a marker an older build wrote is its creation).
            const beat = (await lstat(join(folder, JOB_FOLDER_MARKER)).catch(() => undefined))
              ?.mtimeMs;
            if (beat === undefined) continue;
            const quiet = now - beat;
            if (quiet <= OWNER_GONE_FLOOR_MS) continue;
            if (!facts.alive(marker.pid)) stale = true;
            else {
              // The pid is held: stale only if its holder started well after the owner's
              // last sign of life. Anything else, an unreadable start included, is alive.
              const started = await facts.startedAt(marker.pid);
              stale = started !== undefined && started > beat + REUSE_GAP_MS;
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
