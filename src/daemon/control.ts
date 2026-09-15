import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pkg from '../../package.json';
import { STOP_GRACE_MS } from '../hooks/constants';
import {
  ensureDaemon,
  health,
  missingRoutes,
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
  vitestReporterPath,
} from '../lib/paths';

/**
 * Starting, stopping and materializing the loop daemon (02-redesign.md §4a).
 *
 * Its own module rather than part of `commands/daemon.ts` because two callers
 * need it and only one of them is a command: `tenjin daemon start|stop` renders
 * it, and `install` runs it as step 1-3 of the hook cutover — the settings file
 * may not name a daemon until a healthy one answers (lib/harness-hooks.ts).
 */

export interface DaemonDeps {
  /** Where the built bundles live; the CLI's own dist by default. */
  bundleDir?: string;
  env?: NodeJS.ProcessEnv;
  spawnMs?: number;
  sleep?: (ms: number) => Promise<void>;
  kill?: (pid: number, signal: NodeJS.Signals | 0) => void;
  now?: () => number;
  /**
   * Harnesses whose hook entries this start is about to make live. A running
   * daemon with no route for one of them is replaced, whatever its version
   * says (see {@link startDaemon}).
   */
  requires?: readonly string[];
}

/**
 * How long `install` waits for a spawned daemon, as opposed to the shim's
 * `SPAWN_MS`. The shim's budget is a fraction of one hook fire and a miss
 * there costs that fire; install has a person waiting and a miss there costs
 * the whole activation, so it buys certainty with time it already has. The
 * measured cold start is 75-120 ms, so this is ~40x headroom for a laptop
 * under load (tenjin-agent#342).
 */
export const INSTALL_SPAWN_MS = 5_000;

/**
 * Every built file that belongs in the hooks dir, and where each one goes. The
 * reporter rides with the two bundles because it is materialized the same way
 * and by the same command; it is the one of the three that is never spawned —
 * a repo's own vitest config imports it (`lib/paths.ts`).
 */
const BUNDLES: Readonly<Record<string, (dir: string) => string>> = {
  'tenjin-daemon.mjs': daemonBundlePath,
  'tenjin-shim.mjs': shimBundlePath,
  'tenjin-vitest-reporter.mjs': vitestReporterPath,
};

/** In the built CLI this file's chunk sits in `dist/` beside the two bundles. */
export function defaultBundleDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/** Copy the built files from `dist` into the hooks dir; mint the token if absent. */
export function installDaemonFiles(dataDir: string, bundleDir: string): { written: string[] } {
  const written: string[] = [];
  mkdirSync(hooksDir(dataDir), { recursive: true, mode: 0o700 });
  for (const [name, target] of Object.entries(BUNDLES)) {
    const src = join(bundleDir, name);
    if (!existsSync(src)) {
      throw new CliError('INTERNAL', `Daemon bundle missing: ${src}`, {
        fix: `Reinstall tenjin-cli; the package ships dist/${Object.keys(BUNDLES).join(', dist/')}.`,
      });
    }
    const dest = target(dataDir);
    // COPY ASIDE, THEN RENAME. `copyFileSync` truncates the destination and
    // refills it, so anything reading that path mid-copy — a shim spawned by a
    // live session, a `node --import` of the reporter — sees a half-written
    // file and fails on a syntax error it can do nothing about. A rename is
    // atomic, so a reader gets the old bundle or the new one and never a
    // fragment of both (tenjin-agent#342).
    const staged = `${dest}.${process.pid}.tmp`;
    copyFileSync(src, staged);
    renameSync(staged, dest);
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

/** Why a running daemon had to go. */
export type ReplaceReason = 'older-build' | 'missing-routes';

/** What one start did, for whoever renders it. */
export interface DaemonStart {
  health: Health;
  spawned: boolean;
  /** The daemon this start replaced. */
  replaced: PidRecord | null;
  /** Why it was replaced, when one was. */
  replacedReason?: ReplaceReason;
  /** The routes the replaced daemon could not serve, on `missing-routes`. */
  missingRoutes?: string[];
  /** An older daemon that would not confirm itself and was left alone. */
  unconfirmed: number | null;
  /** Bundles and token this call wrote. */
  written: string[];
}

/**
 * Materialize the bundles, replace a daemon this build has outgrown, and return
 * only once one is healthy. Throws when nothing came up: a caller that goes on
 * to write hook entries has no daemon to point them at.
 *
 * TWO REASONS TO REPLACE, and the second is the one that bit. A version bump
 * is obvious. The other is the route table: `deps.requires` names the
 * harnesses whose entries are about to go live, and a daemon without one of
 * those routes 404s their every fire, silently. It can be on THIS build's
 * version and still be wrong, because a version says nothing about which
 * adapters the process loaded (tenjin-agent#342). A daemon too old to report
 * `harnesses` counts as serving none, which is the safe reading.
 */
export async function startDaemon(dataDir: string, deps: DaemonDeps = {}): Promise<DaemonStart> {
  const { written } = installDaemonFiles(dataDir, deps.bundleDir ?? defaultBundleDir());
  // A daemon from an older build keeps serving until told: the bundle on disk
  // changed only because THIS call copied it, so this call is what stops it.
  const rec = readPid(dataDir);
  const running = rec === null ? null : await health(rec.port);
  let replaced: PidRecord | null = null;
  let reason: ReplaceReason | undefined;
  let short: string[] = [];
  let unconfirmed: number | null = null;
  if (running !== null && running.data_dir === dataDir) {
    short = missingRoutes(running, deps.requires ?? []);
    const stale =
      running.version !== pkg.version
        ? ('older-build' as const)
        : short.length > 0
          ? ('missing-routes' as const)
          : undefined;
    if (stale !== undefined) {
      const stopped = await stopDaemon(dataDir, deps);
      if (stopped.state === 'stopped' || stopped.state === 'killed') {
        replaced = rec;
        reason = stale;
      } else if (stopped.state === 'unconfirmed') unconfirmed = stopped.pid ?? null;
    }
  }
  const ensured = await ensureDaemon(dataDir, {
    ...(deps.env ? { env: deps.env } : {}),
    spawnMs: deps.spawnMs ?? INSTALL_SPAWN_MS,
    ...(deps.now ? { now: deps.now } : {}),
  });
  if (!ensured.ok) {
    throw new CliError('INTERNAL', `Daemon did not start: ${ensured.reason}`, {
      fix: `Read ${join(dataDir, 'daemon.log')}; if it names a port conflict, set \`tenjin config set loop.port <n>\`.`,
    });
  }
  // Checked again on the daemon actually serving now: a start that reused a
  // healthy process never went through the replace branch at all, and the
  // caller needs the routes to exist, not a restart to have been attempted.
  const stillShort = missingRoutes(ensured.health, deps.requires ?? []);
  if (stillShort.length > 0) {
    throw new CliError(
      'INTERNAL',
      `The daemon on 127.0.0.1:${ensured.health.port} (v${ensured.health.version}) has no route for ${stillShort.join(', ')}, so its hook entries would answer 404.`,
      { fix: 'Run `tenjin daemon stop`, then re-run `tenjin install`.' },
    );
  }
  return {
    health: ensured.health,
    spawned: ensured.spawned,
    replaced,
    ...(reason !== undefined ? { replacedReason: reason } : {}),
    ...(reason === 'missing-routes' ? { missingRoutes: short } : {}),
    unconfirmed,
    written,
  };
}
