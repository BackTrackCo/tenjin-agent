import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join, posix, win32 } from 'node:path';
import { commandForm, handlersIn } from './hook-form';
import type { RouterCheck } from './reachability';

/**
 * WHAT THE PLUGIN STARTS, AND FROM WHICH PATH. Claude Code hands every process
 * it spawns the PATH it was itself started with. On Windows that PATH is fixed
 * when the app starts, so a Claude Code running (or relaunched by a tray icon
 * or updater) from before Node's installer edited PATH finds neither `tenjin`
 * nor `node`, and the plugin's server fails with no cause shown. `install`
 * therefore renders every command with absolute paths; these checks prove the
 * paths still exist, and name a stale PATH in one line.
 */

/** A launch as a plugin file carries it: a hook's or stdio server's `command` and `args`. */
interface Launch {
  command: string;
  args: string[];
}

const isAbsolutePath = (p: string): boolean => posix.isAbsolute(p) || win32.isAbsolute(p);

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

function asLaunch(value: unknown): Launch | null {
  if (value === null || typeof value !== 'object') return null;
  const { command, args } = value as { command?: unknown; args?: unknown };
  if (typeof command !== 'string' || !Array.isArray(args)) return null;
  return { command, args: args.filter((a): a is string => typeof a === 'string') };
}

/** Every launch a plugin root carries: its stdio servers, then its exec-form command hooks. */
export async function pluginLaunches(root: string): Promise<{ server: Launch[]; hooks: Launch[] }> {
  const mcp = (await readJson(join(root, '.mcp.json'))) as {
    mcpServers?: Record<string, unknown>;
  } | null;
  const server = Object.values(mcp?.mcpServers ?? {})
    .map(asLaunch)
    .filter((l) => l !== null);
  const hooks = handlersIn(await readJson(join(root, 'hooks', 'hooks.json')))
    .filter((h) => commandForm(h) === 'exec')
    .map(asLaunch)
    .filter((l) => l !== null);
  return { server, hooks };
}

const fileExists = async (path: string): Promise<boolean> =>
  (await stat(path).catch(() => null))?.isFile() === true;

/**
 * THE LAUNCH ROW. Fails when a pinned path is gone (a version manager moved
 * Node, or the package moved), since every command then fails to start; warns
 * when a command still names `node` with no path, which only a PATH current
 * at Claude Code's start can resolve.
 */
export async function launchCheck(
  roots: readonly string[],
  opts: { scope: 'user' | 'local'; exists?: (path: string) => Promise<boolean> },
): Promise<RouterCheck | null> {
  const exists = opts.exists ?? fileExists;
  const install = `\`tenjin install${opts.scope === 'local' ? ' --project' : ''}\``;
  const missing = new Set<string>();
  const bare = new Set<string>();
  let pinned: Launch | null = null;
  for (const root of roots) {
    const { server, hooks } = await pluginLaunches(root);
    for (const launch of [...server, ...hooks]) {
      const paths = [launch.command];
      const entry = launch.args[0];
      if (entry !== undefined && entry !== '-e' && isAbsolutePath(entry)) paths.push(entry);
      for (const path of paths) {
        if (!isAbsolutePath(path)) bare.add(path);
        else if (!(await exists(path))) missing.add(path);
      }
    }
    pinned ??= server.find((l) => isAbsolutePath(l.command)) ?? null;
  }
  const name = 'plugin launch';
  if (missing.size > 0) {
    return {
      name,
      status: 'fail',
      required: true,
      detail: `the plugin starts from ${[...missing].join(', ')}, which no longer exists`,
      fix: `Run ${install} again: it pins the Node binary and CLI entry running it.`,
    };
  }
  if (bare.size > 0) {
    return {
      name,
      status: 'warn',
      required: false,
      detail: `the plugin starts \`${[...bare].join('`, `')}\` from the PATH Claude Code started with, which can predate Node's install`,
      fix: `Run ${install} again: it renders the plugin with this machine's absolute Node and CLI paths.`,
    };
  }
  if (pinned === null) return null;
  return {
    name,
    status: 'ok',
    required: false,
    detail: `${pinned.command} ${pinned.args[0] ?? ''}`.trim(),
  };
}

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
 * a Claude Code session, that is Claude Code's own PATH. Only a warning: the
 * plugin's rendered commands do not read PATH.
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
    detail: inClaude
      ? `Claude Code's PATH lacks ${shown}; restart Claude Code (quit it from the tray) or sign out and in`
      : `this shell's PATH lacks ${shown}; open a new terminal, and restart Claude Code (quit it from the tray) or sign out and in if it was open before`,
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
