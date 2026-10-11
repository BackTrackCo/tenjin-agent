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
}

/** This user's running `tenjin mcp` processes, or null where they cannot be listed. */
export type ListMcpProcesses = () => Promise<McpProcess[] | null>;

/** When the installed package was written, in epoch ms, or null. */
export type InstalledAt = () => Promise<number | null>;

const exec = promisify(execFile);

/** `ps` on macOS and Linux; null on Windows or when `ps` fails, which is "unknown". */
export const listMcpProcesses: ListMcpProcesses = async () => {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') return null;
  try {
    const { stdout } = await exec(
      'ps',
      ['-U', String(process.getuid()), '-o', 'pid=,lstart=,args='],
      { timeout: 5_000, env: { ...process.env, LC_ALL: 'C' }, maxBuffer: 4 * 1024 * 1024 },
    );
    return parsePs(stdout, process.pid);
  } catch {
    return null;
  }
};

const PS_LINE = /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/;

/** The `tenjin mcp` lines of `ps -o pid=,lstart=,args=`, this process left out. */
export function parsePs(stdout: string, selfPid: number): McpProcess[] {
  const found: McpProcess[] = [];
  for (const line of stdout.split('\n')) {
    const m = PS_LINE.exec(line);
    if (m === null) continue;
    const pid = Number(m[1]);
    if (pid === selfPid || !isTenjinMcp(m[3]!)) continue;
    const startedAt = Date.parse(m[2]!.replace(/\s+/g, ' '));
    found.push({ pid, startedAt: Number.isNaN(startedAt) ? null : startedAt });
  }
  return found;
}

/** `tenjin mcp`, however the bin was invoked: `node /path/bin/tenjin mcp`, `tenjin mcp`. */
function isTenjinMcp(args: string): boolean {
  const tokens = args.trim().split(/\s+/);
  const bin = tokens.findIndex(
    (t) => /(^|[/\\])tenjin(\.js|\.cmd)?$/.test(t) || /[/\\]tenjin-cli[/\\]/.test(t),
  );
  return bin >= 0 && tokens[bin + 1] === 'mcp';
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

export const RECONNECT_FIX = 'Reconnect x402 with /mcp, or start a new Claude Code session.';

/** The `mcp server` check from a process list and the install time. Never a failure. */
export function mcpServersState(
  procs: McpProcess[] | null,
  installed: number | null,
  version: string = pkg.version,
): McpServersState {
  const check = (detail: string): McpServersState => ({
    stale: 0,
    check: { name: 'mcp server', status: 'ok', required: false, detail },
  });
  if (procs === null) {
    return check('unknown: running `tenjin mcp` processes cannot be listed on this platform');
  }
  if (procs.length === 0) return check('none running (starts with the next session)');
  if (installed === null) {
    return check(`${procs.length} running; when this build was installed is unknown`);
  }
  const stale = procs.filter((p) => p.startedAt !== null && p.startedAt < installed).length;
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
      fix: RECONNECT_FIX,
    },
  };
}

/** The check, read from this machine (or the injected sources). */
export async function readMcpServers(
  deps: { listMcpProcesses?: ListMcpProcesses; installedAt?: InstalledAt } = {},
): Promise<McpServersState> {
  const [procs, installed] = await Promise.all([
    (deps.listMcpProcesses ?? listMcpProcesses)().catch(() => null),
    (deps.installedAt ?? installedAt)().catch(() => null),
  ]);
  return mcpServersState(procs, installed);
}
