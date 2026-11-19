import { execFile } from 'node:child_process';
import { type Dirent, type FSWatcher, type Stats, watch } from 'node:fs';
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * A DEEPSEEK WORKER'S ENV FILES. The worker and its commands read `.env*` files
 * in its working directories as a native subagent does, and their values never
 * reach Tenjin, DeepSeek, the parent or the local display: each value becomes
 * `[env:NAME]` wherever it appears. A file is read and parsed whole, whatever
 * its size up to `MAX_ENV_FILE_BYTES`, each time it changes. The set lives in
 * this process's memory only, is never logged or saved, and only grows during a
 * job, because a value already in the conversation stays there after its file
 * changes. A repository's `.claude/settings.json` is covered the same way: the
 * values of its `env` block are replaced, and one that cannot be parsed is denied.
 *
 * Builtins only: this module must load without the bundle.
 */

/** A shorter value (`true`, `3000`, `dev`) would corrupt unrelated text. */
export const MIN_SECRET_LENGTH = 8;
/** A bare word or number shorter than this is a setting: `development`, `localhost`. */
const PLAIN_BELOW = 16;
/**
 * The one hard limit: every replaced value is held in memory, in several forms,
 * so memory grows with the file. A larger env file cannot be covered at all.
 */
export const MAX_ENV_FILE_BYTES = 16 * 1024 * 1024;
/** Folders the scan could not list are denied one by one up to this many; past it every env file is. */
const MAX_UNLISTED = 64;
/** A file this user may not read is closed to the worker's commands as well. */
const UNREADABLE_BY_ANYONE = new Set(['EACCES', 'EPERM']);
/**
 * Folders no walk enters, nor the stat pass before each send: they hold most of a workspace's
 * folders (a pnpm install about 3,000 per repository). Their env and settings files are denied to
 * the worker instead, by `skippedEnvPatterns`, so none is read unscanned.
 */
export const SKIPPED_FOLDERS = ['node_modules', '.git'] as const;
const SKIP: ReadonlySet<string> = new Set(SKIPPED_FOLDERS);
/** How long a check waits for file events still in flight, where it trusts a watcher (Windows). */
const SETTLE_MS = 120;
/** Paths a watcher named since the last check, past which the next check walks every root. */
const MAX_NAMED = 10_000;
/**
 * A folder that changed this soon before it was listed is listed again at the next check, since
 * a change after the listing may carry the same time where the file system's clock is coarse.
 */
const RACY_MS = 2_000;

export type EnvAssignment = { key: string; value: string; written: string };

/**
 * The env and settings files inside the folders no walk enters (`SKIPPED_FOLDERS`) under
 * `root`, as deny patterns by the scan's own name rule (`covered`): none of them is read
 * unscanned, whether it was there at the start or written during the job.
 */
export function skippedEnvPatterns(root: string): string[] {
  return SKIPPED_FOLDERS.flatMap((folder) => [
    `${root}/**/${folder}/**/${ENV_GLOB}`,
    `${root}/**/${folder}/**/.claude/settings.json`,
  ]);
}

/**
 * A repository's Claude Code settings file, `.claude/settings.json`, at any depth. The
 * worker reads it as a native subagent does, and its `env` block's values are replaced as
 * an env file's are. One that cannot be parsed is not read line by line: it is denied.
 */
export function isClaudeSettingsFile(path: string): boolean {
  return (
    basename(path).toLowerCase() === 'settings.json' &&
    basename(dirname(path)).toLowerCase() === '.claude'
  );
}

/**
 * A file this scan covers: an env file, or a repository's Claude Code settings file. In any
 * case: macOS and Windows volumes ignore case by default, so `cat .env` opens `.ENV`, and a
 * scan that took only the lower case would leave its values unreplaced.
 */
function covered(path: string): boolean {
  return basename(path).toLowerCase().startsWith('.env') || isClaudeSettingsFile(path);
}

/** An env file's name in any case, as a deny pattern: `.env*` by the scan's own rule (`covered`). */
export const ENV_GLOB = '.[eE][nN][vV]*';

/**
 * A Claude Code settings file's `env` block: `{}` when it has none, undefined when the
 * file is not a JSON object or its `env` is not one, so its values are unknown.
 */
export function parseSettingsEnv(text: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const env = (parsed as { env?: unknown }).env;
  if (env === undefined) return {};
  return env !== null && typeof env === 'object' && !Array.isArray(env)
    ? (env as Record<string, unknown>)
    : undefined;
}

/**
 * A settings file's `env` values as Claude Code hands them to commands (strings, numbers,
 * booleans), or undefined when the file cannot be parsed.
 */
function parseSettingsFile(text: string): EnvAssignment[] | undefined {
  const env = parseSettingsEnv(text);
  if (!env) return undefined;
  return Object.entries(env).flatMap(([key, raw]) => {
    const value = typeof raw === 'number' || typeof raw === 'boolean' ? String(raw) : raw;
    return typeof value === 'string' ? [{ key, value, written: value }] : [];
  });
}

const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*(?:=|:(?=\s))[ \t]*(.*)$/;

function closing(body: string, quote: string): number {
  for (let at = 0; at < body.length; at++) {
    if (body[at] === '\\') at++;
    else if (body[at] === quote) return at;
  }
  return -1;
}

function unquoted(key: string, rest: string): EnvAssignment {
  // dotenv ends an unquoted value at `#`; the file still holds what follows.
  return {
    key,
    value: rest.replace(/#.*$/, '').trim(),
    written: rest.replace(/\s+#.*$/, '').trim(),
  };
}

/**
 * dotenv's rules: `export `, `KEY=value` or `KEY: value`, single, double and
 * backtick quotes that may span lines, `\n` and `\r` expanded in double quotes,
 * `#` comments. A commented-out assignment counts as one, since it often holds
 * an old secret. Any other line, an unclosed quote or a NUL byte leaves the
 * file's values uncovered.
 */
export function parseEnvFile(text: string): EnvAssignment[] | undefined {
  if (text.includes('\0')) return undefined;
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const assignments: EnvAssignment[] = [];
  for (let at = 0; at < lines.length; at++) {
    const line = lines[at]!;
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) {
      const old = ASSIGNMENT.exec(trimmed.replace(/^#+\s*/, ''));
      if (old) {
        const rest = old[2]!.trim();
        const quoted = /^(["'`])([\s\S]*)\1$/.exec(rest);
        assignments.push(
          quoted
            ? { key: old[1]!, value: quoted[2]!, written: quoted[2]! }
            : unquoted(old[1]!, rest),
        );
      }
      continue;
    }
    const match = ASSIGNMENT.exec(line);
    if (!match) return undefined;
    const key = match[1]!;
    const rest = match[2]!;
    const quote = rest[0];
    if (quote !== '"' && quote !== "'" && quote !== '`') {
      assignments.push(unquoted(key, rest));
      continue;
    }
    // Each added line is scanned once: a value of many lines stays linear in its size.
    const parts = [rest.slice(1)];
    let end = closing(parts[0]!, quote);
    while (end < 0 && at + 1 < lines.length) {
      parts.push(lines[++at]!);
      end = closing(parts.at(-1)!, quote);
    }
    if (end < 0) return undefined;
    const last = parts.pop()!;
    const after = last.slice(end + 1).trim();
    if (after && !after.startsWith('#')) return undefined;
    const written = [...parts, last.slice(0, end)].join('\n');
    assignments.push({
      key,
      value: quote === '"' ? written.replace(/\\n/g, '\n').replace(/\\r/g, '\r') : written,
      written,
    });
  }
  return assignments;
}

function parseUrl(value: string): URL | undefined {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return undefined;
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Whether a value is replaced wherever it appears: 8 characters or more, and
 * not a bare word or number under 16 characters, a PEM armor line, nor a URL
 * without credentials whose path, query and fragment hold nothing that is
 * itself replaced. A URL with a user name or password always is, as a whole.
 */
export function secretLike(value: string): boolean {
  const text = value.trim();
  if (text.length < MIN_SECRET_LENGTH) return false;
  if (
    text.length < PLAIN_BELOW &&
    (/^[+-]?\d+(?:\.\d+)?$/.test(text) || /^[A-Za-z][A-Za-z._-]*$/.test(text))
  )
    return false;
  // PEM armor is public boilerplate that code handling keys prints too.
  if (/^-----(?:BEGIN|END) [A-Z0-9 ]+-----$/.test(text)) return false;
  const url = parseUrl(text);
  if (url && !url.username && !url.password)
    return [...url.pathname.split('/'), ...[...url.searchParams].flat(), url.hash.slice(1)].some(
      (part) => secretLike(decoded(part)),
    );
  return true;
}

/** The forms of one value that are replaced: as parsed, as written, encoded. */
export function envPieces({ value, written }: EnvAssignment): string[] {
  const out = new Set<string>();
  const add = (piece: string) => {
    if (piece.trim().length >= MIN_SECRET_LENGTH) out.add(piece);
  };
  // Each form stands on its own: `localhost#x9F!2kQ` written never makes `localhost` a secret.
  for (const whole of new Set([value, written])) {
    if (!secretLike(whole)) continue;
    const bytes = Buffer.from(whole, 'utf8');
    for (const form of [
      whole,
      whole.trim(),
      encodeURIComponent(whole),
      JSON.stringify(whole).slice(1, -1),
      bytes.toString('base64'),
      bytes.toString('base64').replace(/=+$/, ''),
      bytes.toString('base64url'),
    ])
      add(form);
    // A multi-line value is often printed in part: each line counts on its own.
    if (whole.includes('\n'))
      for (const line of whole.split('\n')) if (secretLike(line)) add(line.trim());
  }
  return [...out];
}

/** A URL's password on its own, named after the URL until a variable holds it whole. */
export function urlPasswordPieces(value: string): string[] {
  const password = parseUrl(value.trim())?.password;
  if (!password) return [];
  return [...new Set([password, decoded(password)])].filter(secretLike);
}

const BASE = 131;
/** BASE ** (MIN_SECRET_LENGTH - 1), modulo 2 ** 32. */
const TOP = (() => {
  let power = 1;
  for (let at = 1; at < MIN_SECRET_LENGTH; at++) power = Math.imul(power, BASE);
  return power;
})();
function window(text: string, from: number): number {
  let hash = 0;
  for (let at = from; at < from + MIN_SECRET_LENGTH; at++)
    hash = (Math.imul(hash, BASE) + text.charCodeAt(at)) | 0;
  return hash;
}

function inside(root: string, path: string): boolean {
  const way = relative(root, path);
  return way === '' || (!!way && !way.startsWith('..') && !isAbsolute(way));
}

/** Roots that keep the env denies: outside every working directory, or all when unscanned. */
export function envDeniedRoots(
  protectedRoots: readonly string[],
  workingRoots: readonly string[],
  scanned: boolean,
): string[] {
  return scanned
    ? protectedRoots.filter((root) => !workingRoots.some((working) => inside(working, root)))
    : [...protectedRoots];
}

/** The roots that no other root holds: each is walked, and the rest with it. */
function topRoots(roots: readonly string[]): string[] {
  return roots.filter((root) => !roots.some((other) => other !== root && inside(other, root)));
}

/**
 * The folders of `paths` that no other one holds, by their parents: a walk of each covers the
 * rest. Linear in the paths and their depth, for the thousands a checkout or an install names.
 */
function outermost(paths: readonly string[]): string[] {
  const all = new Set(paths);
  return [...all].filter((path) => {
    for (let at = path, up = dirname(at); up !== at; at = up, up = dirname(up))
      if (all.has(up)) return false;
    return true;
  });
}

/** A folder as last listed: what its own entry said just before the listing, and when. */
type Folder = { dev: number; ino: number; ctime: number; mtime: number; at: number };

function folderOf(info: Stats, at: number): Folder {
  return { dev: info.dev, ino: info.ino, ctime: info.ctimeMs, mtime: info.mtimeMs, at };
}

/**
 * The file systems where a folder's own times prove that it gained no entry: APFS and HFS+
 * move a folder's change time for every entry made, removed or renamed in it, and no command
 * can set that time back. On exFAT and FAT the change time is the settable modification time,
 * and NTFS lets a program set it. By device, for this process; false when unknown.
 */
const trustedDevices = new Map<number, boolean>();
const TRUSTED_TYPES = new Set(['apfs', 'hfs']);

/** The type of the file system that holds each path, from the mount table (macOS). */
async function fileSystemTypes(paths: readonly string[]): Promise<(string | undefined)[]> {
  if (process.platform !== 'darwin') return paths.map(() => undefined);
  const table = await new Promise<string>((done) =>
    execFile('/sbin/mount', [], (error, stdout) => done(error ? '' : String(stdout))),
  );
  const mounts = table.split('\n').flatMap((line) => {
    const match = /^.+? on (.+) \(([^,)]+)/.exec(line);
    return match ? [{ on: match[1]!, type: match[2]! }] : [];
  });
  return Promise.all(
    paths.map(async (path) => {
      const real = await realpath(path).catch(() => undefined);
      if (!real) return undefined;
      let best: { on: string; type: string } | undefined;
      for (const mount of mounts)
        if (inside(mount.on, real) && (!best || mount.on.length > best.on.length)) best = mount;
      return best?.type;
    }),
  );
}

/** Learns which of these devices are trusted, by a folder of each. */
async function trustDevices(samples: ReadonlyMap<number, string>): Promise<void> {
  const unknown = [...samples].filter(([dev]) => !trustedDevices.has(dev));
  if (!unknown.length) return;
  const types = await fileSystemTypes(unknown.map(([, path]) => path));
  unknown.forEach(([dev], at) => trustedDevices.set(dev, TRUSTED_TYPES.has(types[at] ?? '')));
}

/**
 * Whether a folder may have gained or lost an entry since it was listed: always on a file
 * system not trusted (`trustedDevices`); there, a new entry moves the folder's own change time,
 * and a folder replaced by another has another inode.
 */
function folderChanged(info: Stats, folder: Folder): boolean {
  return (
    trustedDevices.get(info.dev) !== true ||
    info.ino !== folder.ino ||
    info.ctimeMs !== folder.ctime ||
    info.mtimeMs !== folder.mtime ||
    folder.ctime > folder.at - RACY_MS
  );
}

async function pool<T>(
  items: readonly T[],
  width: number,
  each: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(width, items.length) }, async () => {
      while (next < items.length) await each(items[next++]!);
    }),
  );
}

type WalkLimits = Pick<EnvScanLimits, 'maxDirectories' | 'maxFiles' | 'deadlineMs'>;

/**
 * Every env and settings file under `starts`, skipping `node_modules` and `.git` and following
 * no link to a folder. `complete` is false when the walk stopped short: a limit, a start in
 * `fatal` that cannot be listed, or more unlistable folders than can each be denied. With
 * `folders`, each folder listed is recorded there as its entry stood just before the listing.
 * `vanished` are the folders, other than those in `fatal`, that were gone when their turn to be
 * listed came: moved, perhaps into a folder already listed.
 */
async function walkTree(
  starts: readonly string[],
  limits: WalkLimits,
  fatal: readonly string[],
  folders?: Map<string, Folder>,
): Promise<{ found: string[]; unlisted: string[]; vanished: string[]; complete: boolean }> {
  const maxDirectories = limits.maxDirectories ?? 400_000;
  const maxFiles = limits.maxFiles ?? 5_000;
  const deadline = Date.now() + (limits.deadlineMs ?? 20_000);
  const found: string[] = [];
  const unlisted: string[] = [];
  const vanished: string[] = [];
  const queue = [...starts];
  let directories = 0;
  let complete = true;
  let active = 0;
  const list = async (directory: string) => {
    if (!folders) return readdir(directory, { withFileTypes: true });
    const at = Date.now();
    // A start may be a link to its folder; a folder below it is never one.
    const info = await (starts.includes(directory) ? stat : lstat)(directory);
    const entries = await readdir(directory, { withFileTypes: true });
    if (info.isDirectory()) folders.set(directory, folderOf(info, at));
    return entries;
  };
  await new Promise<void>((done) => {
    const pump = () => {
      if (!complete) return active ? undefined : done();
      if (!queue.length && !active) return done();
      // A recorded folder costs a stat before its listing: twice as many at once keeps pace.
      while (active < (folders ? 64 : 32) && queue.length) {
        const directory = queue.pop()!;
        if (++directories > maxDirectories || Date.now() > deadline) {
          complete = false;
          return active ? undefined : done();
        }
        active++;
        list(directory)
          .then(
            (entries) => {
              for (const entry of entries) {
                const path = join(directory, entry.name);
                if (entry.isDirectory()) {
                  if (!SKIP.has(entry.name)) queue.push(path);
                } else if (covered(path)) found.push(path);
              }
              if (found.length > maxFiles) complete = false;
            },
            (error: NodeJS.ErrnoException) => {
              // Gone, or a file in its place: it has nothing inside to read here.
              if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
                if (!fatal.includes(directory)) vanished.push(directory);
                return;
              }
              // A folder that cannot be listed may hold env files the worker can reach.
              // A root, or more such folders than can each be denied, fails the walk.
              if (fatal.includes(directory) || unlisted.length >= MAX_UNLISTED) complete = false;
              else unlisted.push(directory);
            },
          )
          .finally(() => {
            active--;
            pump();
          });
      }
    };
    pump();
  });
  return { found, unlisted, vanished, complete };
}

/**
 * How a job learns the env files made after its start scan, before each send:
 * - `relist` (macOS): every folder the scan listed is stat'ed, and each one that changed is
 *   listed again, so nothing depends on file events. macOS loses them unreported: measured
 *   2026-11-19, a watcher on a thread of its own lost the event of an env file written right
 *   after 14,000 new folders in 8 of 8 tries, and libuv loses what is in flight whenever any
 *   watcher of the same event loop starts or closes (19 to 29 of 40).
 * - `events` (Windows): a recursive watcher, which reports when it lost changes.
 * - `none` (Linux): the known files and their folders only.
 */
export type EnvLearning = 'relist' | 'events' | 'none';
const PLATFORM_LEARNING: EnvLearning =
  process.platform === 'darwin' ? 'relist' : process.platform === 'win32' ? 'events' : 'none';

export type EnvScanLimits = {
  maxDirectories?: number;
  maxFiles?: number;
  deadlineMs?: number;
  /** False: this scan learns nothing after it (`none`), as for a scan made only to compare. */
  watch?: boolean;
  /** Default: the platform's own (`EnvLearning`); for tests. */
  learning?: EnvLearning;
  /** Keep a complete scan of `roots` for the next worker over them (`WorkerEnvSecrets.resume`). */
  keep?: boolean;
  /**
   * Folders made for this job alone (its temp folder): scanned with the roots, and left out
   * of a kept scan.
   */
  fresh?: readonly string[];
};

/**
 * THE LAST FULL SCAN OF EACH SET OF ROOTS IN THIS PROCESS, so the next worker over the
 * same roots need not wait for its own scan before its Claude Code may start: it starts
 * from this one's denies, and its own full scan runs meanwhile and must agree before
 * anything is sent (`WorkerEnvSecrets.resume`). In memory only, like every scan, and
 * replaced by each newer complete scan of the same roots.
 */
const lastScans = new Map<string, WorkerEnvSecrets>();
/** One session works in one set of roots; a few more cover a changed worktree list. */
const MAX_KEPT_SCANS = 4;
const scanKey = (roots: readonly string[]) =>
  JSON.stringify([...new Set(roots.map((root) => resolve(root)))].sort());

export class WorkerEnvSecrets {
  /** False when the start scan stopped short: the env denies then stay. */
  scanned = false;
  /** Files found at start whose values could not be covered: denied to the worker. */
  readonly withheld: string[] = [];
  /**
   * Folders the start scan could not list. One that may be entered but not
   * listed can hold an env file a command opens by name, with values never
   * learned here: the worker is denied what is inside.
   */
  readonly unlisted: string[] = [];
  /**
   * Files that appeared or changed after start and whose values cannot be covered,
   * and folders that held one and can no longer be listed. The worker's denies
   * are fixed at start, so while one is here nothing more may be forwarded or
   * shown.
   */
  readonly uncovered = new Set<string>();
  private readonly roots: string[];
  private readonly files = new Map<string, string>();
  /** When each known file was last read: one that changed within `RACY_MS` of it is read again. */
  private readonly readAt = new Map<string, number>();
  private readonly hot = new Set<string>();
  private readonly dirty = new Set<string>();
  private readonly placeholders = new Map<string, string>();
  private readonly derived = new Set<string>();
  /** By the hash of a piece's first characters: the lengths of the pieces that start so, longest first. */
  private readonly index = new Map<number, number[]>();
  private learning: EnvLearning = 'none';
  /** The start scan's limits, which every walk during the job keeps too. */
  private limits: WalkLimits = {};
  /** Every folder listed, for `relist`: a root missing here is walked in full at the next check. */
  private readonly folders = new Map<string, Folder>();
  private readonly watchers: FSWatcher[] = [];
  /** A watcher failed (`events`): from now on every check re-lists, as `relist` does. */
  private failed = false;
  /** Every path the watcher named since the last check: any of them may be a folder moved in. */
  private readonly named = new Set<string>();
  /** The watcher named more than `MAX_NAMED`, or said it lost changes: the next check walks every root. */
  private overflow = false;
  /**
   * Whether a check before each send learns env and settings files made during the job: by a
   * re-listing (macOS), or by a recursive watcher that has not failed (Windows). Without it, a
   * settings file made in a new folder is found by no check before output leaves.
   */
  get watching(): boolean {
    return (
      this.learning === 'relist' ||
      (this.learning === 'events' && !this.failed && this.watchers.length > 0)
    );
  }
  private running: Promise<void> | undefined;
  private queued: Promise<void> | undefined;
  /** Set while the running check still waits for file events: when that wait ends. */
  private settling: { until: number } | undefined;
  /** Set while the running check stats folders: a call meanwhile restarts that pass (`relist`). */
  private relisting: { again: boolean } | undefined;

  private constructor(roots: readonly string[]) {
    this.roots = [...new Set(roots.map((root) => resolve(root)))];
  }

  /** Scans the working directories once; never throws. */
  static async start(
    roots: readonly string[],
    limits: EnvScanLimits = {},
  ): Promise<WorkerEnvSecrets> {
    const env = new WorkerEnvSecrets([...roots, ...(limits.fresh ?? [])]);
    env.learning = limits.watch === false ? 'none' : (limits.learning ?? PLATFORM_LEARNING);
    env.limits = {
      maxDirectories: limits.maxDirectories,
      maxFiles: limits.maxFiles,
      deadlineMs: limits.deadlineMs,
    };
    // Watching before the walk begins: a file made in a folder after the walk listed it is
    // named by an event.
    if (env.learning === 'events') env.watch();
    try {
      env.scanned = await env.scan(limits);
    } catch {
      env.scanned = false;
    }
    // Kept for the next worker over these roots when the scan ran to its end: a copy,
    // which this job's later finds never reach.
    if (limits.keep && env.scanned) {
      const key = scanKey(roots);
      lastScans.delete(key);
      lastScans.set(key, env.copy(roots));
      while (lastScans.size > MAX_KEPT_SCANS) lastScans.delete(lastScans.keys().next().value!);
    }
    return env;
  }

  /**
   * A worker's scan that starts from the last full scan of `roots` in this process, so
   * its Claude Code can start at once with that scan's read denies. `fresh` are folders
   * made for this job alone (its temp folder), which hold nothing yet and are walked at
   * the first per-request check. Undefined where nothing learns files made during the job
   * (Linux, or a Windows watcher that cannot start): a file made between the scans would be
   * missed.
   *
   * `verified` is this worker's own full scan, started here: it adds every value it
   * finds, and resolves false when the denies the child started with no longer cover
   * what it found. NOTHING MAY BE SENT BEFORE IT RESOLVES TRUE; on false the caller
   * starts over with `start`, which now holds the newer scan.
   */
  static resume(
    roots: readonly string[],
    fresh: readonly string[] = [],
  ): { env: WorkerEnvSecrets; verified: Promise<boolean> } | undefined {
    if (PLATFORM_LEARNING === 'none') return undefined;
    const held = lastScans.get(scanKey(roots));
    if (!held) return undefined;
    const env = held.copy([...roots, ...fresh]);
    env.learning = PLATFORM_LEARNING;
    // Watching before its own scan begins: no change falls between the two.
    if (env.learning === 'events') env.watch();
    if (!env.watching) {
      env.close();
      return undefined;
    }
    for (const root of fresh) env.hot.add(resolve(root));
    return { env, verified: env.refreshBeforeAssignment(held.roots, true).catch(() => false) };
  }

  /** Forgets the scans kept for later workers; for tests. */
  static forgetScans(): void {
    lastScans.clear();
    trustedDevices.clear();
  }

  /** The same findings over `roots`, sharing nothing that a later find changes. */
  private copy(roots: readonly string[]): WorkerEnvSecrets {
    const env = new WorkerEnvSecrets(roots);
    env.scanned = this.scanned;
    env.withheld.push(...this.withheld);
    env.unlisted.push(...this.unlisted);
    for (const [path, signature] of this.files) env.files.set(path, signature);
    for (const [path, at] of this.readAt) env.readAt.set(path, at);
    for (const directory of this.hot)
      if (env.roots.some((root) => inside(root, directory))) env.hot.add(directory);
    for (const [value, name] of this.placeholders) env.placeholders.set(value, name);
    for (const value of this.derived) env.derived.add(value);
    for (const [key, lengths] of this.index) env.index.set(key, [...lengths]);
    return env;
  }

  /**
   * Refreshes a warm child's scan without weakening the read denies it started with:
   * a full scan of `roots` (default: every root of this one), whose values are added
   * here. False when it found a file or folder to deny that the child was not denied.
   * With `relist`, the folders it listed are the ones each later check stats.
   */
  async refreshBeforeAssignment(
    roots: readonly string[] = this.roots,
    keep = false,
  ): Promise<boolean> {
    const current = await WorkerEnvSecrets.start(roots, {
      keep,
      learning: this.learning === 'relist' ? 'relist' : 'none',
    });
    if (
      current.scanned !== this.scanned ||
      current.withheld.some((path) => !this.withheld.includes(path)) ||
      current.unlisted.some((path) => !this.unlisted.includes(path))
    )
      return false;

    // An MCP server can still hold a value it read during startup. Keep both versions
    // covered and learn the locations of new files for later, incremental refreshes.
    for (const [value, name] of current.placeholders)
      this.remember(value, name, current.derived.has(value));
    for (const [path, signature] of current.files) this.files.set(path, signature);
    for (const [path, at] of current.readAt) this.readAt.set(path, at);
    for (const directory of current.hot) this.hot.add(directory);
    if (this.learning === 'relist')
      for (const [path, folder] of current.folders) this.folders.set(path, folder);
    return true;
  }

  /**
   * THE ENV DENIES, FROM THE ONE LIST OF ROOTS THIS SCAN WALKS, so no root is walked with a
   * skip and left without the matching deny. Under each root it walks (working directories,
   * worktrees, the job's temp folder), the env and settings files of the folders the walk
   * skips (`skippedEnvPatterns`), or every env and settings file when the scan stopped short.
   * Under each other root the worker is granted (a read or write exception, a Claude config
   * path it may read), which no scan covers, every env file. Path patterns, for the file
   * tools' rules and the sandbox alike.
   */
  envDenies(granted: readonly string[]): string[] {
    const walked = topRoots(this.roots);
    const every = (root: string) => [
      `${root}/${ENV_GLOB}`,
      `${root}/**/${ENV_GLOB}`,
      ...(covered(root) ? [root] : []),
    ];
    return [
      ...new Set([
        ...walked.flatMap((root) =>
          this.scanned
            ? skippedEnvPatterns(root)
            : [...every(root), `${root}/**/.claude/settings.json`],
        ),
        ...granted
          .filter((root) => !walked.some((top) => inside(top, resolve(root))))
          .flatMap(every),
      ]),
    ];
  }

  /** How many distinct strings are replaced; never the strings. */
  get size(): number {
    return this.placeholders.size;
  }

  /** Replaces every known value, longest first at each position, in one pass. */
  readonly redact = (text: string): string => {
    if (!this.placeholders.size || text.length < MIN_SECRET_LENGTH) return text;
    let out = '';
    let last = 0;
    let hash = window(text, 0);
    for (let at = 0; at + MIN_SECRET_LENGTH <= text.length;) {
      let hit: string | undefined;
      for (const length of this.index.get(hash & 0x3fffffff) ?? []) {
        if (at + length > text.length) continue;
        const piece = text.slice(at, at + length);
        if (this.placeholders.has(piece)) {
          hit = piece;
          break;
        }
      }
      if (hit !== undefined) {
        out += text.slice(last, at) + this.placeholders.get(hit)!;
        at += hit.length;
        last = at;
        if (at + MIN_SECRET_LENGTH <= text.length) hash = window(text, at);
        continue;
      }
      if (at + MIN_SECRET_LENGTH < text.length)
        hash =
          (Math.imul(hash - Math.imul(text.charCodeAt(at), TOP), BASE) +
            text.charCodeAt(at + MIN_SECRET_LENGTH)) |
          0;
      at++;
    }
    return last === 0 ? text : out + text.slice(last);
  };

  /**
   * Picks up env files that changed or appeared since the last check, before
   * anything is forwarded: every known file is re-read when its size, time or
   * inode changed, and every working root and folder that held an env file is
   * listed again. On macOS every folder is stat'ed and each changed one listed
   * (`relist`); on Windows every folder the watcher named is listed (`catchUp`).
   * Calls during a check queue one more check after it.
   *
   * A CHECK THAT HAS NOT YET READ WHAT IT DEPENDS ON is joined by a call made meanwhile:
   * its wait for file events is run again in full from that call, or its pass over the
   * folders starts again, so what the check then reads is as new as a check of this call's
   * own would read. A worker's tool result starts a check and its next model request, a few
   * milliseconds later, asked for another after it: two waits and two listings in a row
   * before every request that followed a tool.
   */
  refresh(): Promise<void> {
    if (this.settling && this.running) {
      this.settling.until = Date.now() + SETTLE_MS;
      return this.running;
    }
    if (this.relisting && this.running) {
      this.relisting.again = true;
      return this.running;
    }
    if (this.queued) return this.queued;
    const next = (async () => {
      await this.running?.catch(() => undefined);
      this.queued = undefined;
      this.running = this.check();
      return this.running;
    })();
    this.queued = next;
    return next;
  }

  /** Loads one env or settings file the worker is about to read, if it is in a working root. */
  async add(path: unknown): Promise<void> {
    if (typeof path !== 'string' || !covered(path)) return;
    const absolute = resolve(path);
    if (this.roots.some((root) => inside(root, absolute))) await this.load(absolute);
  }

  close(): void {
    for (const watcher of this.watchers.splice(0)) watcher.close();
  }

  private async check(): Promise<void> {
    // File events trail a command's writes by tens of milliseconds: let them arrive. The
    // wait runs its full length from the last call that joined it (`refresh`).
    if (this.learning === 'events' && this.watching) {
      const settling = (this.settling = { until: Date.now() + SETTLE_MS });
      for (let wait = SETTLE_MS; wait > 0; wait = settling.until - Date.now())
        await new Promise((done) => setTimeout(done, wait));
      this.settling = undefined;
    }
    // A scan that stopped short keeps every env file denied: there is nothing to learn.
    const found =
      !this.scanned || this.learning === 'none'
        ? []
        : this.learning === 'relist' || this.failed
          ? await this.relist()
          : await this.catchUp();
    const paths = new Set([...found, ...this.dirty, ...this.files.keys()]);
    this.dirty.clear();
    await Promise.all(
      [...this.hot].map(async (directory) => {
        let entries: Dirent[];
        try {
          entries = await readdir(directory, { withFileTypes: true });
        } catch (error) {
          // A folder this user can no longer list may still be entered: a command can open
          // an env file in it by name, with values never learned here. One the start scan
          // could not list is denied already, and so is every env file of an unscanned job.
          if (
            UNREADABLE_BY_ANYONE.has((error as NodeJS.ErrnoException).code ?? '') &&
            this.scanned &&
            !this.unlisted.some((folder) => inside(folder, directory))
          )
            this.uncovered.add(directory);
          return;
        }
        this.uncovered.delete(directory);
        for (const entry of entries) {
          const path = join(directory, entry.name);
          if (covered(path) && !entry.isDirectory()) paths.add(path);
        }
      }),
    );
    await Promise.all([...paths].map((path) => this.load(path).catch(() => undefined)));
  }

  /**
   * EVERY FOLDER AGAIN, WITH NO FILE EVENT TRUSTED: each folder listed before is stat'ed, and
   * each one that may have gained an entry (`folderChanged`) is listed again; a folder not
   * listed before (new, moved in, or a root never walked) is walked in full. A call made
   * while the folders are stat'ed starts that pass again (`refresh`). Returns the env files
   * found; a folder that cannot be listed, or a walk that stops short, holds every later send
   * (`uncovered`).
   */
  private async relist(): Promise<string[]> {
    const tops = topRoots(this.roots);
    const found: string[] = [];
    // A folder gone for a moment while the pass runs (moved away and back, or moved within
    // the roots) may hold what this send carries: the pass runs again until none is gone.
    for (let round = 0; ; round++) {
      const changed: { path: string; folder: Folder }[] = [];
      const gone: string[] = [];
      const relisting: { again: boolean } = (this.relisting = { again: true });
      while (relisting.again) {
        relisting.again = false;
        changed.length = 0;
        gone.length = 0;
        await pool([...this.folders], 64, async ([path, folder]) => {
          if (relisting.again) return;
          const at = Date.now();
          let info: Stats;
          try {
            info = await (tops.includes(path) ? stat : lstat)(path);
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'ENOENT' || code === 'ENOTDIR') gone.push(path);
            // Listed below, where a folder that cannot be read holds the send.
            else changed.push({ path, folder });
            return;
          }
          if (!info.isDirectory()) gone.push(path);
          else if (folderChanged(info, folder)) changed.push({ path, folder: folderOf(info, at) });
        });
      }
      this.relisting = undefined;
      const starts = tops.filter((top) => !this.folders.has(top));
      for (const path of gone) {
        this.folders.delete(path);
        // Its folder is listed again, which walks it if it is back, and the pass runs again,
        // which finds it if it moved to a folder this pass had already stat'ed.
        const parent = this.folders.get(dirname(path));
        if (parent && !changed.some((entry) => entry.path === dirname(path)))
          changed.push({ path: dirname(path), folder: { ...parent, ctime: Number.NaN } });
      }
      // Folders gone by the time they were listed or walked: moved, perhaps into a folder this
      // pass had already stat'ed, so they count as gone too.
      const vanished: string[] = [];
      await pool(changed, 32, async ({ path, folder }) => {
        let entries: Dirent[];
        try {
          entries = await readdir(path, { withFileTypes: true });
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ENOENT' || code === 'ENOTDIR') vanished.push(path);
          else this.unlistable(path);
          return;
        }
        this.folders.set(path, folder);
        for (const entry of entries) {
          const child = join(path, entry.name);
          if (entry.isDirectory()) {
            if (!SKIP.has(entry.name) && !this.folders.has(child)) starts.push(child);
          } else if (covered(child)) found.push(child);
        }
      });
      found.push(...(await this.walked(starts, tops, this.folders, vanished)));
      // Each moved after this pass stat'ed every folder: the next round finds where it went, or
      // that it is back, by the change times that move moved.
      for (const path of vanished) this.folders.delete(path);
      gone.push(...vanished);
      await this.trust();
      if (!gone.length) return found;
      // Folders that keep going and coming hold the send rather than let it rest on a guess.
      if (round >= 8) {
        for (const path of gone) this.unlistable(dirname(path));
        return found;
      }
    }
  }

  /**
   * WHAT THE WATCHER NAMED IS LISTED (`events`), before anything leaves: every folder it
   * named, whatever its name, since a folder moved in or copied reports itself alone. Every
   * root instead when it named too many or said it lost changes.
   */
  private async catchUp(): Promise<string[]> {
    const named = [...this.named];
    this.named.clear();
    const tops = topRoots(this.roots);
    if (this.overflow) {
      this.overflow = false;
      return this.walked(tops, tops);
    }
    const folders = (
      await Promise.all(
        named.map(async (path) =>
          (await lstat(path).catch(() => null))?.isDirectory() ? path : '',
        ),
      )
    ).filter((path) => path && !this.unlisted.some((folder) => inside(folder, path)));
    return this.walked(outermost(folders), tops);
  }

  /**
   * The env files a walk of `starts` finds during the job; what it cannot cover holds every send.
   * The folders gone before their listing go to `vanished`.
   */
  private async walked(
    starts: string[],
    tops: readonly string[],
    folders?: Map<string, Folder>,
    vanished?: string[],
  ): Promise<string[]> {
    if (!starts.length) return [];
    const walk = await walkTree(starts, this.limits, tops, folders);
    if (!walk.complete) for (const start of starts) this.uncovered.add(start);
    for (const folder of walk.unlisted) this.unlistable(folder);
    vanished?.push(...walk.vanished);
    return walk.found;
  }

  /** Learns the file system of each device its folders are on (`trustedDevices`). */
  private async trust(): Promise<void> {
    const samples = new Map<number, string>();
    for (const [path, folder] of this.folders)
      if (!trustedDevices.has(folder.dev) && !samples.has(folder.dev))
        samples.set(folder.dev, path);
    await trustDevices(samples);
  }

  /** A folder found during the job that cannot be listed: listed again at each check from now. */
  private unlistable(folder: string): void {
    if (this.unlisted.some((denied) => inside(denied, folder))) return;
    this.uncovered.add(folder);
    this.hot.add(folder);
  }

  private async scan(limits: EnvScanLimits): Promise<boolean> {
    const tops = topRoots(this.roots);
    for (const root of this.roots) this.hot.add(root);
    const relist = this.learning === 'relist';
    const walk = await walkTree(tops, limits, tops, relist ? this.folders : undefined);
    if (relist) await this.trust();
    this.unlisted.push(...walk.unlisted);
    await Promise.all(walk.found.map((path) => this.load(path, true)));
    return walk.complete;
  }

  private watch(): void {
    for (const root of topRoots(this.roots)) {
      try {
        const watcher = watch(root, { recursive: true, persistent: false }, (_event, name) => {
          // The system lost count of changes (a Windows buffer overflow): walk every root.
          if (name === null || name === undefined) {
            this.overflow = true;
            return;
          }
          const path = join(root, String(name));
          if (covered(path)) this.dirty.add(path);
          // Inside `node_modules` or `.git` only an env or settings file is read, by its name.
          if (
            String(name)
              .split(sep)
              .some((part) => SKIP.has(part))
          )
            return;
          if (this.named.size < MAX_NAMED) this.named.add(path);
          else this.overflow = true;
        });
        // A watcher that fails reports nothing more: it is dropped, and every check from
        // now re-lists every folder instead, and the accept walks again.
        watcher.on('error', () => {
          watcher.close();
          const at = this.watchers.indexOf(watcher);
          if (at >= 0) this.watchers.splice(at, 1);
          this.failed = true;
        });
        this.watchers.push(watcher);
      } catch {
        // No native recursive watching for this root: every check re-lists instead.
        this.failed = true;
      }
    }
  }

  private async load(path: string, atStart = false): Promise<void> {
    const at = Date.now();
    const info = await stat(path).catch(() => null);
    // Deleted or not a file: the values already seen stay replaced.
    if (!info?.isFile()) {
      this.uncovered.delete(path);
      return;
    }
    // The change time too: `cp -p` or `touch -r` can rewrite a file in place with its old size
    // and modification time, and only the change time moves.
    const signature = `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    // A file denied at start stays denied: the worker cannot read it, whatever it holds now.
    if (!atStart && this.withheld.includes(path)) return;
    // Read again while it changed within RACY_MS of its last read: on a coarse clock (HFS+ has
    // 1 s) a later rewrite of the same size can keep every time it had.
    if (
      this.files.get(path) === signature &&
      !(info.ctimeMs > (this.readAt.get(path) ?? 0) - RACY_MS)
    )
      return;
    this.hot.add(dirname(path));
    let bytes: Buffer | undefined;
    let readable = info.size <= MAX_ENV_FILE_BYTES;
    if (readable)
      try {
        bytes = await readFile(path);
        // It may have grown since the size was read.
        readable = bytes.length <= MAX_ENV_FILE_BYTES;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return;
        // After start, a file this user may not read is closed to the worker too.
        if (!atStart && UNREADABLE_BY_ANYONE.has(code ?? '')) return;
        readable = false;
      }
    const text = readable && bytes ? bytes.toString('utf8') : undefined;
    const assignments =
      text === undefined
        ? undefined
        : isClaudeSettingsFile(path)
          ? parseSettingsFile(text)
          : parseEnvFile(text);
    if (!assignments) {
      // Redacting whole lines would miss values printed on their own.
      if (atStart) this.withheld.push(path);
      else this.uncovered.add(path);
      return;
    }
    let learned = 0;
    // A large file must not hold the process: other work runs between batches.
    const pause = async () => {
      if (++learned % 2_000 === 0) await new Promise<void>((next) => setImmediate(next));
    };
    for (const assignment of assignments) {
      const name = `[env:${assignment.key}]`;
      for (const piece of envPieces(assignment)) this.remember(piece, name);
      for (const piece of urlPasswordPieces(assignment.value)) this.remember(piece, name, true);
      await pause();
    }
    // Only now is this version of the file covered in full.
    this.files.set(path, signature);
    this.readAt.set(path, at);
    this.uncovered.delete(path);
  }

  private remember(piece: string, placeholder: string, derived = false): void {
    if (this.placeholders.has(piece)) {
      // A variable that holds the value whole names it over a URL it is part of.
      if (!derived && this.derived.delete(piece)) this.placeholders.set(piece, placeholder);
      return;
    }
    if (derived) this.derived.add(piece);
    this.placeholders.set(piece, placeholder);
    const key = window(piece, 0) & 0x3fffffff;
    // A file of many values that start alike costs one entry per length, not per value.
    const lengths = this.index.get(key) ?? [];
    if (lengths.includes(piece.length)) return;
    let at = lengths.findIndex((other) => other < piece.length);
    if (at < 0) at = lengths.length;
    lengths.splice(at, 0, piece.length);
    this.index.set(key, lengths);
  }
}
