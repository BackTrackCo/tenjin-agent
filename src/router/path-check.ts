import { execFile } from 'node:child_process';
import { posix, win32 } from 'node:path';
import type { RouterCheck } from './reachability';

/**
 * WHICH PATH CLAUDE CODE STARTED WITH. Claude Code hands every process it
 * spawns the PATH it was itself started with, and the plugin starts `node`
 * from that PATH. On Windows that PATH is fixed when the app starts, so a
 * Claude Code running (or relaunched by a tray icon or updater) from before
 * Node's installer edited PATH cannot start the plugin's server, and the
 * session shows only a closed connection. This row names the gap.
 */

/** Everything the stale-PATH row reads, injected in tests. */
export interface PathProbe {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** The PATH entries saved for new processes (Windows: user, then machine), or null. */
  savedPath: () => Promise<string[] | null>;
  /** `npm config get prefix`, or null when npm is not reachable. */
  npmPrefix: () => Promise<string | null>;
  /** The running CLI's entry: npm's prefix counts only when it holds this install. */
  cliEntry: string;
}

/** The process PATH, under whichever casing the environment carries it. */
export function processPath(env: NodeJS.ProcessEnv): string {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
  return key !== undefined ? (env[key] ?? '') : '';
}

/** `reg query ... /v Path`'s value, or null when the output carries none. */
export function parseRegPath(stdout: string): string | null {
  const line = stdout.split(/\r?\n/).find((l) => /^\s+Path\s+REG_(EXPAND_)?SZ\s/i.test(l));
  return line?.replace(/^\s+Path\s+REG_(EXPAND_)?SZ\s+/i, '').trim() ?? null;
}

/** `%NAME%` expanded from `env`, by name in any case; an unknown name stays as written. */
export function expandWindowsVars(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/%([^%]+)%/g, (whole, name: string) => {
    const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
    return key !== undefined && env[key] !== undefined ? env[key] : whole;
  });
}

export function splitPath(value: string, platform: NodeJS.Platform): string[] {
  return value
    .split(platform === 'win32' ? ';' : ':')
    .map((d) => d.trim())
    .filter((d) => d.length > 0);
}

function normalizeDir(dir: string, platform: NodeJS.Platform): string {
  if (platform !== 'win32') return dir.replace(/\/+$/, '');
  return dir.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

/** Where npm puts global bins: the prefix itself on Windows, `<prefix>/bin` elsewhere. */
export function npmBinDir(prefix: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? prefix : posix.join(prefix, 'bin');
}

/** The wanted directories the process PATH lacks, in the order wanted, each once. */
export function missingFromPath(
  current: string,
  wanted: readonly string[],
  platform: NodeJS.Platform,
): string[] {
  const have = new Set(splitPath(current, platform).map((d) => normalizeDir(d, platform)));
  const out = new Map<string, string>();
  for (const dir of wanted) {
    const key = normalizeDir(dir, platform);
    if (!have.has(key) && !out.has(key)) out.set(key, dir);
  }
  return [...out.values()];
}

function under(file: string, dir: string, platform: NodeJS.Platform): boolean {
  const f = normalizeDir(file, platform);
  const d = normalizeDir(dir, platform);
  return f.startsWith(`${d}${platform === 'win32' ? '\\' : '/'}`);
}

/**
 * THE STALE-PATH ROW: the directories saved for new processes (the Windows
 * registry's user and machine PATH) and npm's global bin directory, when this
 * CLI lives under npm's prefix, that the running process's PATH lacks. Run in
 * a Claude Code session, that is Claude Code's own PATH. A warning: a missing
 * directory breaks the plugin only when it holds `node`, and the `router
 * server` row fails when it does.
 */
export async function stalePathCheck(probe: PathProbe): Promise<RouterCheck | null> {
  const wanted = [...((await probe.savedPath()) ?? [])];
  // npm is asked only when this CLI runs from a package folder it could own.
  const prefix = /[\\/]node_modules[\\/]/.test(probe.cliEntry) ? await probe.npmPrefix() : null;
  if (prefix !== null && under(probe.cliEntry, prefix, probe.platform)) {
    wanted.push(npmBinDir(prefix, probe.platform));
  }
  const missing = missingFromPath(processPath(probe.env), wanted, probe.platform);
  if (missing.length === 0) return null;
  const shown =
    missing.slice(0, 3).join(', ') + (missing.length > 3 ? ` and ${missing.length - 3} more` : '');
  const inClaude = probe.env.CLAUDECODE === '1';
  return {
    name: 'PATH',
    status: 'warn',
    required: false,
    detail: inClaude ? `Claude Code's PATH lacks ${shown}` : `this shell's PATH lacks ${shown}`,
    fix: inClaude
      ? 'Restart Claude Code (quit it from the tray) or sign out and in.'
      : 'Open a new terminal. If Claude Code was open before, restart Claude Code (quit it from the tray) or sign out and in.',
  };
}

function run(file: string, args: string[], shell: boolean): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 5_000, shell, windowsHide: true }, (err, stdout) =>
      resolve(err === null ? String(stdout) : null),
    );
  });
}

const USER_ENV_KEY = 'HKCU\\Environment';
const MACHINE_ENV_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';

/**
 * The saved PATH on Windows, user entries then machine entries, read with
 * `reg query` (no admin needed) from System32 by its full path, since the PATH
 * being judged may itself be the stale one. Null off Windows or when neither
 * key reads.
 */
export async function readSavedPath(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  query: (key: string) => Promise<string | null> = (key) =>
    run(
      win32.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe'),
      ['query', key, '/v', 'Path'],
      false,
    ),
): Promise<string[] | null> {
  if (platform !== 'win32') return null;
  const values = (await Promise.all([USER_ENV_KEY, MACHINE_ENV_KEY].map(query)))
    .map((out) => (out === null ? null : parseRegPath(out)))
    .filter((v) => v !== null);
  if (values.length === 0) return null;
  return values.flatMap((v) => splitPath(expandWindowsVars(v, env), platform));
}

/** `npm config get prefix`, through a shell on Windows, where npm is a `.cmd`. */
export async function readNpmPrefix(platform: NodeJS.Platform): Promise<string | null> {
  const out = await run('npm', ['config', 'get', 'prefix'], platform === 'win32');
  const prefix = out?.trim() ?? '';
  return prefix.length > 0 ? prefix : null;
}
