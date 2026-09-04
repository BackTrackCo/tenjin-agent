import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pkg from '../../package.json';
import type { CommandContext, CommandResult } from '../context';
import { STOP_GRACE_MS } from '../hooks/constants';
import {
  ensureDaemon,
  health,
  readPid,
  readToken,
  type Health,
  type PidRecord,
} from '../hooks/shim';
import { CliError } from '../lib/errors';
import {
  daemonBundlePath,
  daemonPidPath,
  daemonTokenPath,
  hooksDir,
  shimBundlePath,
} from '../lib/paths';

/**
 * `tenjin daemon start|stop|status` (02-redesign.md §4a). Nothing here reads
 * or writes a harness settings file; wiring the hook entries is `tenjin
 * install` (PR C). `start` is also what install and update call.
 */

export interface DaemonDeps {
  /** Where the built bundles live; the CLI's own dist by default. */
  bundleDir?: string;
  env?: NodeJS.ProcessEnv;
  spawnMs?: number;
  sleep?: (ms: number) => Promise<void>;
  kill?: (pid: number, signal: NodeJS.Signals | 0) => void;
  now?: () => number;
}

const BUNDLES = ['tenjin-daemon.mjs', 'tenjin-shim.mjs'] as const;

/** In the built CLI this file's chunk sits in `dist/` beside the two bundles. */
function defaultBundleDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/** Copy the two bundles from `dist` into the hooks dir; mint the token if absent. */
export function installDaemonFiles(dataDir: string, bundleDir: string): { written: string[] } {
  const written: string[] = [];
  mkdirSync(hooksDir(dataDir), { recursive: true, mode: 0o700 });
  for (const name of BUNDLES) {
    const src = join(bundleDir, name);
    if (!existsSync(src)) {
      throw new CliError('INTERNAL', `Daemon bundle missing: ${src}`, {
        fix: 'Reinstall tenjin-cli; the package ships dist/tenjin-daemon.mjs and dist/tenjin-shim.mjs.',
      });
    }
    const dest = name === 'tenjin-daemon.mjs' ? daemonBundlePath(dataDir) : shimBundlePath(dataDir);
    copyFileSync(src, dest);
    written.push(dest);
  }
  if (readToken(dataDir) === null) {
    writeFileSync(daemonTokenPath(dataDir), randomBytes(32).toString('hex'), { mode: 0o600 });
    written.push(daemonTokenPath(dataDir));
  }
  return { written };
}

function alive(pid: number, kill: NonNullable<DaemonDeps['kill']>): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** SIGTERM, wait, SIGKILL. Returns how it ended; clears a pid file left behind. */
export async function stopDaemon(
  dataDir: string,
  deps: DaemonDeps = {},
): Promise<{ state: 'stopped' | 'killed' | 'not-running' | 'unconfirmed'; pid?: number }> {
  const kill = deps.kill ?? ((pid, sig) => process.kill(pid, sig));
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());
  const rec = readPid(dataDir);
  if (rec === null || !alive(rec.pid, kill)) {
    if (rec !== null) rmSync(daemonPidPath(dataDir), { force: true });
    return { state: 'not-running' };
  }
  // Signal only a process `/health` confirms is our daemon: a crash-left pid
  // file can name a reused pid, and a signal on hearsay could kill a stranger.
  // A different pid answering on the port proves the file stale, so it goes.
  // A live pid that did not answer in time is left alone AND keeps its file:
  // a busy daemon that missed one 200 ms probe must not be orphaned without
  // a record (the next start would lose the bind to it and exit quietly).
  const h = await health(rec.port);
  if (h !== null && (h.pid !== rec.pid || h.data_dir !== dataDir)) {
    rmSync(daemonPidPath(dataDir), { force: true });
    return { state: 'not-running' };
  }
  if (h === null) return { state: 'unconfirmed', pid: rec.pid };
  kill(rec.pid, 'SIGTERM');
  const until = now() + STOP_GRACE_MS;
  while (now() < until) {
    await sleep(50);
    if (!alive(rec.pid, kill)) return { state: 'stopped', pid: rec.pid };
  }
  try {
    kill(rec.pid, 'SIGKILL');
  } catch {
    // Died between the check and the kill.
  }
  rmSync(daemonPidPath(dataDir), { force: true });
  return { state: 'killed', pid: rec.pid };
}

function describe(h: Health): string[] {
  return [
    `running: pid ${h.pid}, port ${h.port}, v${h.version}`,
    `uptime ${Math.round(h.uptime_ms / 1000)} s, idle ${Math.round(h.idle_ms / 1000)} s, rss ${Math.round(h.rss / 1048576)} MB`,
    `data dir ${h.data_dir}`,
  ];
}

export async function runDaemonStart(
  ctx: CommandContext,
  deps: DaemonDeps = {},
): Promise<CommandResult> {
  const { dataDir } = ctx;
  const { written } = installDaemonFiles(dataDir, deps.bundleDir ?? defaultBundleDir());
  // A daemon from an older build keeps serving until told: the bundle on disk
  // changed only because THIS call copied it, so this call is what stops it.
  const rec = readPid(dataDir);
  const running = rec === null ? null : await health(rec.port);
  let replaced: PidRecord | null = null;
  let unconfirmed: number | null = null;
  if (running !== null && running.data_dir === dataDir && running.version !== pkg.version) {
    const stopped = await stopDaemon(dataDir, deps);
    if (stopped.state === 'stopped' || stopped.state === 'killed') replaced = rec;
    else if (stopped.state === 'unconfirmed') unconfirmed = stopped.pid ?? null;
  }
  const ensured = await ensureDaemon(dataDir, {
    ...(deps.env ? { env: deps.env } : {}),
    ...(deps.spawnMs !== undefined ? { spawnMs: deps.spawnMs } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  });
  if (!ensured.ok) {
    throw new CliError('INTERNAL', `Daemon did not start: ${ensured.reason}`, {
      fix: `Read ${join(dataDir, 'daemon.log')}; if it names a port conflict, set \`tenjin config set loop.port <n>\`.`,
    });
  }
  const h = ensured.health;
  return {
    data: {
      state: ensured.spawned ? 'started' : 'already-running',
      pid: h.pid,
      port: h.port,
      version: h.version,
      dataDir,
      written,
      replaced: replaced?.pid ?? null,
    },
    humanLines: [
      ensured.spawned
        ? `started daemon: pid ${h.pid}, port ${h.port}, v${h.version}`
        : `already running: pid ${h.pid}, port ${h.port}, v${h.version}`,
      ...(replaced ? [`stopped previous daemon pid ${replaced.pid}`] : []),
      ...(unconfirmed !== null
        ? [
            `previous daemon pid ${unconfirmed} did not answer /health and was left alone; run \`tenjin daemon start\` again`,
          ]
        : []),
      ...(written.length > 0 ? [`wrote ${written.length} file(s) under ${hooksDir(dataDir)}`] : []),
    ],
  };
}

export async function runDaemonStop(
  ctx: CommandContext,
  deps: DaemonDeps = {},
): Promise<CommandResult> {
  const r = await stopDaemon(ctx.dataDir, deps);
  const line =
    r.state === 'not-running'
      ? 'not running'
      : r.state === 'unconfirmed'
        ? `pid ${r.pid} is alive but did not answer /health; left alone. Retry, or kill it by hand if it is hung.`
        : r.state === 'stopped'
          ? `stopped pid ${r.pid}`
          : `killed pid ${r.pid} (did not exit within ${STOP_GRACE_MS} ms)`;
  return { data: r, humanLines: [line] };
}

export async function runDaemonStatus(ctx: CommandContext): Promise<CommandResult> {
  const rec = readPid(ctx.dataDir);
  const h = rec === null ? null : await health(rec.port);
  if (h === null || h.data_dir !== ctx.dataDir) {
    return {
      data: { state: 'not-running', pidFile: rec, tokenPresent: readToken(ctx.dataDir) !== null },
      humanLines: ['not running'],
    };
  }
  return { data: { state: 'running', ...h }, humanLines: describe(h) };
}
