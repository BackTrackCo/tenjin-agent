import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pkg from '../../package.json';
import type { RouterCheck } from './reachability';

/**
 * A `tenjin mcp` STARTED BEFORE THIS INSTALL still runs the code it started
 * with. Claude Code keeps its MCP servers for the life of a session, so after
 * an update the hooks the new install wrote can call a tool the old process
 * does not have ("Tool hook not found"), while every file on disk reads as
 * correct. This finds this user's running `tenjin mcp` processes and compares
 * each start time with the installed package's own `package.json`.
 */

export interface McpProcess {
  pid: number;
  /** Start time in epoch ms, or null when `ps` gave none this could read. */
  startedAt: number | null;
  /** The parent pid, when `ps` gave one. */
  ppid?: number;
  /**
   * What started it, from its own arguments: `plugin` (the plugin's `--plugin`
   * router), `codex` (`--harness codex`) or `other`. Absent on an injected
   * entry, which then counts as it always did.
   */
  kind?: 'plugin' | 'codex' | 'other';
  /**
   * Whether a Claude Code process is among its ancestors (up to 10 levels).
   * False for a router nothing Claude started: a `tenjin mcp` in a terminal, a
   * Codex one, a test harness. Absent (injected) counts as true.
   */
  underClaude?: boolean;
  /**
   * The CLI version it runs, when it runs from Tenjin's runtime
   * (`runtime/versions/<v>/dist/index.js`). Absent for any other launch.
   */
  version?: string;
}

/**
 * One `ps` read, in the two lists doctor and install need: this user's running
 * `tenjin mcp` routers (zombies and this process left out), and the Claude Code
 * sessions themselves, so a router's ancestry and a session's start time can
 * be told without a second `ps`.
 */
export interface ProcessSnapshot {
  routers: McpProcess[];
  claude: McpProcess[];
}

/** This user's running routers and Claude Code processes, or null where they cannot be listed. */
export type ListProcesses = () => Promise<ProcessSnapshot | null>;

/** This user's running `tenjin mcp` processes, or null where they cannot be listed. */
export type ListMcpProcesses = () => Promise<McpProcess[] | null>;

/** When the installed package was written, in epoch ms, or null. */
export type InstalledAt = () => Promise<number | null>;

const exec = promisify(execFile);

/** `ps` on macOS and Linux; null on Windows or when `ps` fails, which is "unknown". */
export const listProcesses: ListProcesses = async () => {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') return null;
  try {
    const { stdout } = await exec(
      'ps',
      ['-U', String(process.getuid()), '-o', 'pid=,ppid=,stat=,lstart=,args='],
      { timeout: 5_000, env: { ...process.env, LC_ALL: 'C' }, maxBuffer: 4 * 1024 * 1024 },
    );
    return parsePs(stdout, process.pid);
  } catch {
    return null;
  }
};

/** The routers alone, as before the snapshot: kept so its callers and seams keep their shape. */
export const listMcpProcesses: ListMcpProcesses = async () =>
  (await listProcesses())?.routers ?? null;

const PS_LINE =
  /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/;

/** How far up the parent chain a router is followed to find the Claude Code that started it. */
const ANCESTRY_DEPTH = 10;

interface PsRow {
  pid: number;
  ppid: number;
  startedAt: number | null;
  args: string;
}

/**
 * The `ps -o pid=,ppid=,stat=,lstart=,args=` lines as a {@link ProcessSnapshot}:
 * the `tenjin mcp` routers, this process left out, and the Claude Code
 * processes. A zombie (stat starting `Z`) is neither: it has exited, and its
 * pid may already name nothing.
 */
export function parsePs(stdout: string, selfPid: number): ProcessSnapshot {
  const rows: PsRow[] = [];
  for (const line of stdout.split('\n')) {
    const m = PS_LINE.exec(line);
    if (m === null || m[3]!.startsWith('Z')) continue;
    const startedAt = Date.parse(m[4]!.replace(/\s+/g, ' '));
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      startedAt: Number.isNaN(startedAt) ? null : startedAt,
      args: m[5]!,
    });
  }
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const underClaude = (row: PsRow): boolean => {
    let parent = byPid.get(row.ppid);
    for (let i = 0; i < ANCESTRY_DEPTH && parent !== undefined; i += 1) {
      if (isClaudeCode(parent.args)) return true;
      if (parent.ppid === parent.pid) break;
      parent = byPid.get(parent.ppid);
    }
    return false;
  };
  const routers: McpProcess[] = [];
  const claude: McpProcess[] = [];
  for (const row of rows) {
    const mcp = row.pid !== selfPid ? tenjinMcp(row.args) : null;
    if (mcp !== null) {
      routers.push({
        pid: row.pid,
        startedAt: row.startedAt,
        ppid: row.ppid,
        kind: routerKind(row.args),
        underClaude: underClaude(row),
        ...(mcp.version !== undefined ? { version: mcp.version } : {}),
      });
    } else if (isClaudeCode(row.args)) {
      claude.push({ pid: row.pid, startedAt: row.startedAt, ppid: row.ppid });
    }
  }
  return { routers, claude };
}

/** Who started a router, read from the flags its starter passes. */
function routerKind(args: string): 'plugin' | 'codex' | 'other' {
  const tokens = args.trim().split(/\s+/);
  if (tokens.includes('--plugin')) return 'plugin';
  const harness = tokens.indexOf('--harness');
  if (harness >= 0 && tokens[harness + 1] === 'codex') return 'codex';
  if (tokens.includes('--harness=codex')) return 'codex';
  return 'other';
}

/**
 * `claude`'s own one-shot subcommands. Each starts, answers and exits; none is
 * a session. `claude mcp get` (doctor) and `claude mcp list` even start a
 * `tenjin mcp` of their own, and that router must never pass for one a
 * session started.
 */
const ONE_SHOT = new Set(['mcp', 'plugin', 'config', 'update', 'doctor', 'setup-token']);

/** Interpreters a JS build of Claude Code runs under, as the first token. */
const INTERPRETER = /^(node|nodejs|bun)(\.exe)?$/i;

/** Is this path Claude Code's own binary or bundle? */
function isClaudePath(token: string): boolean {
  return (
    isClaudeBinary(token) ||
    token.includes('/claude/versions/') ||
    token.includes('/claude-code/') ||
    token.includes('@anthropic-ai/claude-code/cli.js')
  );
}

/** Is this the `claude` binary itself (its basename), not just a path under Claude Code's folder? */
function isClaudeBinary(path: string): boolean {
  const base = path.split(/[/\\]/).pop() ?? path;
  return base === 'claude' || base === 'claude.exe';
}

/**
 * Where Claude Code's path, starting at `tokens[at]`, ends: the index of the
 * first token after it, or -1 when it is not Claude Code. `ps` joins the
 * arguments with spaces, so a path that holds one (the desktop app's
 * `/Users/<u>/Library/Application Support/Claude/claude-code/<ver>/.../claude`)
 * spans several tokens. An absolute path is extended over the tokens after it
 * while none starts a new path or a flag, and a joined path counts only when
 * it ends at the `claude` binary itself.
 */
function claudePathEnd(tokens: string[], at: number): number {
  const first = tokens[at];
  if (first === undefined) return -1;
  if (isClaudePath(first)) return at + 1;
  if (!/^(\/|[A-Za-z]:\\)/.test(first)) return -1;
  let path = first;
  for (let i = at + 1; i < tokens.length; i += 1) {
    const next = tokens[i]!;
    if (/^[-/\\]/.test(next)) return -1;
    path = `${path} ${next}`;
    if (isClaudeBinary(path)) return i + 1;
  }
  return -1;
}

/**
 * A Claude Code SESSION, from its `ps` arguments: the first token is the
 * `claude` binary (or an installed version of it, whose path may hold
 * spaces), or an interpreter running Claude Code's bundle. Its one-shot
 * subcommands (`claude mcp get`, `claude plugin list`, `claude update`, ...)
 * are not sessions, and are left out.
 */
export function isClaudeCode(args: string): boolean {
  const tokens = args.trim().split(/\s+/);
  let at = 0;
  if (tokens[0] !== undefined && INTERPRETER.test(tokens[0].split(/[/\\]/).pop() ?? '')) at = 1;
  const end = claudePathEnd(tokens, at);
  if (end < 0) return false;
  const sub = tokens[end];
  return sub === undefined || !ONE_SHOT.has(sub);
}

/**
 * A runtime build's entry, `<root>/runtime/versions/<v>/dist/index.js`, with
 * the version. Anchored at the token's end, because `ps` joins arguments with
 * spaces: a data dir under a home with a space splits the path, and its last
 * token still ends this way.
 */
const RUNTIME_ENTRY = /[/\\]runtime[/\\]versions[/\\]([^/\\]+)[/\\]dist[/\\]index\.js$/;

/**
 * `tenjin mcp`, however the bin was invoked: `node /path/bin/tenjin mcp`,
 * `tenjin mcp`, the npm folder plugin's `node <plugin root>/../../../index.js
 * mcp`, or the runtime plugin's `<runtime node> <runtime>/versions/<v>/dist/index.js
 * mcp`, which also says the version it runs. Null when it is none of these.
 */
function tenjinMcp(args: string): { version?: string } | null {
  const tokens = args.trim().split(/\s+/);
  let version: string | undefined;
  const bin = tokens.findIndex((t) => {
    const runtime = RUNTIME_ENTRY.exec(t);
    if (runtime !== null) {
      version = runtime[1];
      return true;
    }
    return (
      /(^|[/\\])tenjin(\.js|\.cmd)?$/.test(t) ||
      /[/\\]tenjin-cli[/\\]/.test(t) ||
      /[/\\]hosts[/\\]claude[/\\]tenjin[/\\]\.\.[/\\]\.\.[/\\]\.\.[/\\]index\.js$/.test(t)
    );
  });
  if (bin < 0 || tokens[bin + 1] !== 'mcp') return null;
  return version !== undefined ? { version } : {};
}

/**
 * When this build's `package.json`, the nearest one above this module, was
 * written. Its ctime, not its mtime: npm extracts a package with the
 * tarball's fixed 1985 mtimes, and setting them is what moves the ctime to
 * the moment of the install.
 */
export const installedAt: InstalledAt = async () => {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    try {
      const st = await stat(join(dir, 'package.json'));
      return Math.max(st.ctimeMs, st.mtimeMs);
    } catch {
      dir = dirname(dir);
    }
  }
  return null;
};

/** How many running servers predate the install, and what doctor says about it. */
export interface McpServersState {
  stale: number;
  check: RouterCheck;
}

/**
 * Worded for the session the person is in, never a terminal. Only a new
 * session: `/reload-plugins` reconnects the server but does not run the
 * plugin's `SessionStart`, and while a settings install is still here it would
 * load the plugin beside a pre-upgrade `x402` server, so every event would
 * route twice.
 */
export const RECONNECT_FIX =
  'Start a new Claude Code session: this one still runs the earlier Tenjin build.';
/** The same step while a settings install is still here; kept as its own export for its callers. */
export const NEW_SESSION_FIX = RECONNECT_FIX;

/**
 * The `mcp server` check from a process list and the install time. Never a
 * failure.
 *
 * STALE MEANS A CLAUDE CODE SESSION IS STILL RUNNING THE OLD BUILD. A router
 * launched from Tenjin's runtime says its version, so it is stale when that is
 * not `version`, whenever it started: the runtime switches builds without any
 * package being written. Any other router is stale when it started before the
 * install. A Codex
 * router (`kind: 'codex'`) and one nothing Claude started (`underClaude:
 * false`: a terminal, a test) are not this check's business, so they are not
 * counted. An injected entry without those fields counts, as it always did.
 *
 * What this cannot see is said as not checked (`checked: false`), never as a
 * pass: a platform without `ps`, or an install time it could not read.
 */
export function mcpServersState(
  procs: McpProcess[] | null,
  installed: number | null,
  version: string = pkg.version,
  fix: string = RECONNECT_FIX,
): McpServersState {
  const check = (detail: string): McpServersState => ({
    stale: 0,
    check: { name: 'mcp server', status: 'ok', required: false, detail },
  });
  const unchecked = (detail: string): McpServersState => ({
    stale: 0,
    check: { name: 'mcp server', status: 'warn', required: false, detail, checked: false },
  });
  if (procs === null) {
    return unchecked(
      'could not check for `tenjin mcp` processes started before this install: they cannot be listed on this platform',
    );
  }
  if (procs.length === 0) return check('none running (starts with the next session)');
  if (installed === null && procs.some((p) => p.version === undefined)) {
    return unchecked(`${procs.length} running; when this build was installed is unknown`);
  }
  const stale = procs.filter(
    (p) =>
      p.kind !== 'codex' &&
      p.underClaude !== false &&
      (p.version !== undefined
        ? p.version !== version
        : p.startedAt !== null && installed !== null && p.startedAt < installed),
  ).length;
  if (stale === 0) {
    return check(`${procs.length} running, all started after this install`);
  }
  const which = stale === 1 ? 'process' : 'processes';
  return {
    stale,
    check: {
      name: 'mcp server',
      status: 'warn',
      required: false,
      detail: `${stale} running \`tenjin mcp\` ${which} started before this install (${version}), so ${stale === 1 ? 'it runs' : 'they run'} the older build, where the hooks can fail with "Tool hook not found"`,
      fix,
    },
  };
}

/** The process seams doctor and install take; each defaults to this machine. */
export interface ProcessDeps {
  /** The whole snapshot; wins over `listMcpProcesses`. */
  listProcesses?: ListProcesses;
  /**
   * The routers alone (the older seam). Injected without `listProcesses`, it
   * stands for a snapshot with these routers and no Claude Code process.
   */
  listMcpProcesses?: ListMcpProcesses;
  installedAt?: InstalledAt;
}

/**
 * ONE `ps` AND THE INSTALL TIME, read once and shared: doctor's `mcp server`,
 * `claude session` and `plugin` rows all decide from the same snapshot, so a
 * process that starts between two reads cannot make them disagree. Never
 * rejects: a failing source is null, which every reader says as not checked.
 */
export async function readProcessSnapshot(
  deps: ProcessDeps = {},
): Promise<{ snapshot: ProcessSnapshot | null; installed: number | null }> {
  const list: ListProcesses =
    deps.listProcesses ??
    (deps.listMcpProcesses !== undefined
      ? async () => {
          const routers = await deps.listMcpProcesses!();
          return routers === null ? null : { routers, claude: [] };
        }
      : listProcesses);
  const [snapshot, installed] = await Promise.all([
    list().catch(() => null),
    (deps.installedAt ?? installedAt)().catch(() => null),
  ]);
  return { snapshot, installed };
}

/**
 * The check, read from this machine (or the injected sources). `version` is
 * the build the plugin now runs, when that is not this one: `tenjin update`'s
 * parent names the version it just moved the runtime to.
 */
export async function readMcpServers(
  deps: ProcessDeps = {},
  opts: { settingsInstallPending?: boolean; version?: string } = {},
): Promise<McpServersState> {
  const { snapshot, installed } = await readProcessSnapshot(deps);
  const fix = opts.settingsInstallPending === true ? NEW_SESSION_FIX : RECONNECT_FIX;
  return mcpServersState(snapshot?.routers ?? null, installed, opts.version ?? pkg.version, fix);
}
