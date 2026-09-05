import { readFileSync, statSync } from 'node:fs';
import pkg from '../../package.json';
import { claudeAdapter } from '../adapters/claude';
import { contextArm } from '../hooks/arms/context';
import { promptArm } from '../hooks/arms/prompt';
import { fetchArm, researchArm } from '../hooks/arms/research';
import { openLoopDb } from '../hooks/store';
import { readToken, resolveDataDir } from '../hooks/shim';
import type { Arm, Deps, KernelConfig } from '../hooks/types';
import { configPath } from '../lib/paths';
import { CONFIG_DEFAULTS, RawConfigSchema, resolveLoopConfig } from '../lib/config';
import { bind, derivePort, IdleTimer, openLog, shutdown, writePid } from './lifecycle';
import { createHookServer } from './server';

/**
 * Entry for `tenjin-daemon.mjs`. One process per data dir, on loopback, that
 * serves every session and every subagent on the machine until it has been
 * idle for `loop.idle_exit_min`.
 *
 * ARMS: the lookup arms of PR C. ORDER IS THE MAP — `selectArm` takes the
 * first arm whose `on` matches, so a later arm can be shadowed by an earlier
 * one. These four cannot shadow each other: they key on four disjoint
 * (event, kind) pairs, and `context` is last regardless because it is the only
 * one with more than one. Every entry `install` writes for an arm PR D has yet
 * to add finds nothing here, records `no-question` and answers 204.
 */

const ARMS: Arm[] = [promptArm, researchArm, fetchArm, contextArm];

/**
 * Config is read here without `loadConfig`'s hooks-key migration: the daemon
 * needs `loop`, `team`, `hooks` and the three shelf fields the search leg
 * routes on, and must not throw on a file an older CLI wrote. Invalid JSON or
 * schema falls back to defaults with a log line, never to a dead daemon.
 *
 * NO FLAG OR ENV LAYER. A daemon serves every session on the machine, so the
 * only `baseUrl` it can honour is the one on disk; `--base-url` belongs to the
 * CLI invocation that carried it.
 */
const DEFAULTS: KernelConfig = {
  loop: CONFIG_DEFAULTS.loop,
  team: CONFIG_DEFAULTS.team,
  hooks: CONFIG_DEFAULTS.hooks,
  baseUrl: CONFIG_DEFAULTS.baseUrl,
  publicShelfUrl: CONFIG_DEFAULTS.publicShelfUrl,
  shelfBypassSecret: CONFIG_DEFAULTS.shelfBypassSecret,
};

function readKernelConfig(dataDir: string, log: (l: string) => void): KernelConfig {
  try {
    const raw = RawConfigSchema.safeParse(JSON.parse(readFileSync(configPath(dataDir), 'utf8')));
    if (!raw.success) {
      log(`config.json invalid; using defaults: ${raw.error.issues[0]?.message ?? ''}`);
      return DEFAULTS;
    }
    const r = raw.data;
    return {
      loop: resolveLoopConfig(r),
      team: { publicFallback: r.team?.publicFallback ?? CONFIG_DEFAULTS.team.publicFallback },
      hooks: { ...CONFIG_DEFAULTS.hooks, ...(r.hooks ?? {}) } as KernelConfig['hooks'],
      baseUrl: r.baseUrl ?? DEFAULTS.baseUrl,
      publicShelfUrl: r.publicShelfUrl ?? DEFAULTS.publicShelfUrl,
      shelfBypassSecret: r.shelfBypassSecret ?? DEFAULTS.shelfBypassSecret,
    };
  } catch {
    return DEFAULTS;
  }
}

function configMtime(dataDir: string): number {
  try {
    return statSync(configPath(dataDir)).mtimeMs;
  } catch {
    return 0;
  }
}

async function main(): Promise<void> {
  const dataDir = resolveDataDir();
  const log = openLog(dataDir);
  const version = pkg.version;
  const token = readToken(dataDir);
  if (token === null) {
    log('no daemon.token; run `tenjin daemon start`');
    process.exit(1);
  }
  let db;
  try {
    db = openLoopDb(dataDir);
  } catch (err) {
    log(`loop.db open failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  let config = readKernelConfig(dataDir, log);
  let mtime = configMtime(dataDir);
  const clock = () => Date.now();
  const deps: Deps = {
    db,
    config: () => config,
    clock,
    log,
    arms: ARMS,
    adapters: { claude: claudeAdapter },
  };

  const startedAt = clock();
  let lastRequestAt = startedAt;
  let port = config.loop.port ?? derivePort(dataDir);
  let idle: IdleTimer | null = null;
  const hook = createHookServer({
    deps,
    token,
    version,
    dataDir,
    startedAt,
    onRequest: () => {
      lastRequestAt = clock();
      idle?.touch();
    },
    lastRequestAt: () => lastRequestAt,
    port: () => port,
    refreshConfig: async () => {
      const m = configMtime(dataDir);
      if (m !== mtime) {
        mtime = m;
        config = readKernelConfig(dataDir, log);
      }
    },
  });

  let exiting = false;
  const exit = async (code: number, retention: boolean, why: string): Promise<never> => {
    if (exiting) return new Promise<never>(() => undefined);
    exiting = true;
    idle?.stop();
    log(`exit: ${why}`);
    try {
      await shutdown({
        server: hook.server,
        db,
        dataDir,
        pid: process.pid,
        inFlight: hook.drain,
        clock,
        log,
        retention,
      });
    } catch (err) {
      log(`shutdown error: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exit(code);
  };

  // Never keep serving after an uncaught throw: Node documents resumption as
  // undefined state, and a throw inside a write would leave every later write
  // failing while gate state advances. The next prompt's shim respawns.
  process.on('uncaughtException', (err) => {
    log(`uncaughtException: ${err.stack ?? err.message}`);
    try {
      db.close();
    } catch {
      // Already closed.
    }
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    log(
      `unhandledRejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`,
    );
    try {
      db.close();
    } catch {
      // Already closed.
    }
    process.exit(1);
  });
  process.on('SIGTERM', () => void exit(0, false, 'SIGTERM'));
  process.on('SIGINT', () => void exit(0, false, 'SIGINT'));

  const bound = await bind(hook.server, port, dataDir, version);
  if (bound.kind === 'peer') {
    // Lost a benign race to a daemon just like us; it serves, we go.
    db.close();
    process.exit(0);
  }
  if (bound.kind === 'foreign') {
    log(`bind ${port}: ${bound.detail}; set \`loop.port\` if this persists`);
    db.close();
    process.exit(1);
  }
  port = bound.port;
  writePid(dataDir, { pid: process.pid, port, started_at: startedAt, data_dir: dataDir });
  idle = new IdleTimer({
    idleMs: config.loop.idle_exit_min * 60_000,
    clock,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as NodeJS.Timeout),
    onIdle: () => void exit(0, true, 'idle'),
    log,
  });
  log(`listening on 127.0.0.1:${port} (v${version}, pid ${process.pid}, data ${dataDir})`);
}

void main();
