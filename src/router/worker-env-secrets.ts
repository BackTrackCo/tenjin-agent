import { type FSWatcher, watch } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

/**
 * A DEEPSEEK WORKER'S ENV FILES. The worker and its commands read `.env*` files
 * in its working directories as a native subagent does, and their values never
 * reach Tenjin, DeepSeek, the parent or the local display: each value becomes
 * `[env:NAME]` wherever it appears. A file is read and parsed whole, whatever
 * its size up to `MAX_ENV_FILE_BYTES`, each time it changes. The set lives in
 * this process's memory only, is never logged or saved, and only grows during a
 * job, because a value already in the conversation stays there after its file
 * changes.
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
/** A file this user may not read is closed to the worker's commands as well. */
const UNREADABLE_BY_ANYONE = new Set(['EACCES', 'EPERM']);
const SKIP = new Set(['node_modules', '.git']);
const WITHHELD_LINE = '[env:withheld line]';
/** How long a check waits for file events still in flight (macOS coalesces at 50 ms). */
const SETTLE_MS = 120;

export type EnvAssignment = { key: string; value: string; written: string };
export type ParsedEnv = { ok: true; assignments: EnvAssignment[] } | { ok: false; lines: string[] };

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
 * an old secret. Any other line, an unclosed quote or a NUL byte makes the file
 * unparseable, and then every line is withheld.
 */
export function parseEnvFile(text: string): ParsedEnv {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const failed = (): ParsedEnv => ({
    ok: false,
    lines: lines.map((line) => line.trim()).filter(Boolean),
  });
  if (text.includes('\0')) return failed();
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
    if (!match) return failed();
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
    if (end < 0) return failed();
    const last = parts.pop()!;
    const after = last.slice(end + 1).trim();
    if (after && !after.startsWith('#')) return failed();
    const written = [...parts, last.slice(0, end)].join('\n');
    assignments.push({
      key,
      value: quote === '"' ? written.replace(/\\n/g, '\n').replace(/\\r/g, '\r') : written,
      written,
    });
  }
  return { ok: true, assignments };
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

export type EnvScanLimits = {
  maxDirectories?: number;
  maxFiles?: number;
  deadlineMs?: number;
  /** Recursive watching where the OS does it natively (macOS, Windows). */
  watch?: boolean;
};

export class WorkerEnvSecrets {
  /** False when the start scan stopped short: the env denies then stay. */
  scanned = false;
  /** Env files found at start that could not be read in full: denied to the worker. */
  readonly withheld: string[] = [];
  /**
   * Env files that appeared or changed after start and cannot be read in full.
   * The worker's denies are fixed at start, so while one is here nothing more
   * may be forwarded or shown.
   */
  readonly uncovered = new Set<string>();
  private readonly roots: string[];
  private readonly files = new Map<string, string>();
  private readonly hot = new Set<string>();
  private readonly dirty = new Set<string>();
  private readonly placeholders = new Map<string, string>();
  private readonly derived = new Set<string>();
  /** By the hash of a piece's first characters: the lengths of the pieces that start so, longest first. */
  private readonly index = new Map<number, number[]>();
  private readonly watchers: FSWatcher[] = [];
  private running: Promise<void> | undefined;
  private queued: Promise<void> | undefined;

  private constructor(roots: readonly string[]) {
    this.roots = [...new Set(roots.map((root) => resolve(root)))];
  }

  /** Scans the working directories once; never throws. */
  static async start(
    roots: readonly string[],
    limits: EnvScanLimits = {},
  ): Promise<WorkerEnvSecrets> {
    const env = new WorkerEnvSecrets(roots);
    try {
      env.scanned = await env.scan(limits);
    } catch {
      env.scanned = false;
    }
    if (limits.watch !== false && (process.platform === 'darwin' || process.platform === 'win32'))
      env.watch();
    return env;
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
   * listed again. Calls during a check queue one more check after it.
   */
  refresh(): Promise<void> {
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

  /** Loads one env file the worker is about to read, if it is in a working root. */
  async add(path: unknown): Promise<void> {
    if (typeof path !== 'string' || !basename(path).startsWith('.env')) return;
    const absolute = resolve(path);
    if (this.roots.some((root) => inside(root, absolute))) await this.load(absolute);
  }

  close(): void {
    for (const watcher of this.watchers.splice(0)) watcher.close();
  }

  private async check(): Promise<void> {
    // File events trail a command's writes by tens of milliseconds: let them arrive.
    if (this.watchers.length) await new Promise((done) => setTimeout(done, SETTLE_MS));
    const paths = new Set([...this.dirty, ...this.files.keys()]);
    this.dirty.clear();
    await Promise.all(
      [...this.hot].map(async (directory) => {
        const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
        for (const entry of entries)
          if (entry.name.startsWith('.env') && !entry.isDirectory())
            paths.add(join(directory, entry.name));
      }),
    );
    await Promise.all([...paths].map((path) => this.load(path).catch(() => undefined)));
  }

  private async scan(limits: EnvScanLimits): Promise<boolean> {
    const maxDirectories = limits.maxDirectories ?? 400_000;
    const maxFiles = limits.maxFiles ?? 5_000;
    const deadline = Date.now() + (limits.deadlineMs ?? 20_000);
    const tops = this.roots.filter(
      (root) => !this.roots.some((other) => other !== root && inside(other, root)),
    );
    for (const root of this.roots) this.hot.add(root);
    const found: string[] = [];
    const queue = [...tops];
    let directories = 0;
    let complete = true;
    let active = 0;
    await new Promise<void>((done) => {
      const pump = () => {
        if (!complete) return active ? undefined : done();
        if (!queue.length && !active) return done();
        while (active < 32 && queue.length) {
          const directory = queue.pop()!;
          if (++directories > maxDirectories || Date.now() > deadline) {
            complete = false;
            return active ? undefined : done();
          }
          active++;
          readdir(directory, { withFileTypes: true })
            .then(
              (entries) => {
                for (const entry of entries) {
                  if (entry.isDirectory()) {
                    if (!SKIP.has(entry.name)) queue.push(join(directory, entry.name));
                  } else if (entry.name.startsWith('.env')) found.push(join(directory, entry.name));
                }
                if (found.length > maxFiles) complete = false;
              },
              (error: NodeJS.ErrnoException) => {
                // A root that cannot be listed may hold env files the worker can reach.
                if (tops.includes(directory) && error.code !== 'ENOENT') complete = false;
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
    await Promise.all(found.map((path) => this.load(path, true)));
    return complete;
  }

  private watch(): void {
    for (const root of this.roots.filter(
      (root) => !this.roots.some((other) => other !== root && inside(other, root)),
    )) {
      try {
        const watcher = watch(root, { recursive: true, persistent: false }, (_event, name) => {
          if (name && basename(String(name)).startsWith('.env'))
            this.dirty.add(join(root, String(name)));
        });
        // A watcher that fails leaves the per-request checks of known folders.
        watcher.on('error', () => watcher.close());
        this.watchers.push(watcher);
      } catch {
        // No native recursive watching here.
      }
    }
  }

  private async load(path: string, atStart = false): Promise<void> {
    const info = await stat(path).catch(() => null);
    // Deleted or not a file: the values already seen stay replaced.
    if (!info?.isFile()) {
      this.uncovered.delete(path);
      return;
    }
    const signature = `${info.ino}:${info.size}:${info.mtimeMs}`;
    // A file denied at start stays denied: the worker cannot read it, whatever it holds now.
    if (this.files.get(path) === signature || (!atStart && this.withheld.includes(path))) return;
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
    if (!readable || !bytes) {
      // Not remembered as seen: the next check reads it again.
      if (atStart) this.withheld.push(path);
      else this.uncovered.add(path);
      return;
    }
    const parsed = parseEnvFile(bytes.toString('utf8'));
    let learned = 0;
    // A large file must not hold the process: other work runs between batches.
    const pause = async () => {
      if (++learned % 2_000 === 0) await new Promise<void>((next) => setImmediate(next));
    };
    if (parsed.ok)
      for (const assignment of parsed.assignments) {
        const name = `[env:${assignment.key}]`;
        for (const piece of envPieces(assignment)) this.remember(piece, name);
        for (const piece of urlPasswordPieces(assignment.value)) this.remember(piece, name, true);
        await pause();
      }
    else
      for (const line of parsed.lines) {
        if (line.length >= MIN_SECRET_LENGTH) this.remember(line, WITHHELD_LINE);
        await pause();
      }
    // Only now is this version of the file covered in full.
    this.files.set(path, signature);
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
