import { readFileSync, statSync } from 'node:fs';
import pkg from '../../package.json';
import { ADAPTERS } from '../adapters/registry';
import { ARMS } from '../hooks/arms/registry';
import { openLoopDb } from '../hooks/store';
import { readToken, resolveDataDir } from '../hooks/shim';
import type { Deps, KernelConfig } from '../hooks/types';
import { configPath } from '../lib/paths';
import { CONFIG_DEFAULTS, RawConfigSchema, resolveLoopConfig } from '../lib/config';
import { resolveWriteAuth } from '../lib/consent';
import { searchHeaders } from '../lib/search-auth';
import type { SignableRequest } from '../lib/session-present';
import type { WriteAuth } from '../lib/session-key';
import { createLocalProvider } from '../lib/wallet/local';
import { bind, derivePort, IdleTimer, openLog, shutdown, writePid } from './lifecycle';
import { createHookServer } from './server';
import { createWriteAuthCache } from './write-auth';

/**
 * Entry for `tenjin-daemon.mjs`. One process per data dir, on loopback, that
 * serves every session and every subagent on the machine until it has been
 * idle for `loop.idle_exit_min`.
 *
 * The arms it serves, and the order they are tried in, are
 * `hooks/arms/registry.ts`: this module runs `main()` on import, so the list
 * cannot live here and still be readable by a test.
 */

/**
 * Config is read here without `loadConfig`'s hooks-key migration: the daemon
 * needs `loop`, `team`, `hooks`, the one origin and the one shelf slug the
 * search leg routes on, and must not throw on a file an older CLI wrote.
 * Invalid JSON or schema falls back to defaults with a log line, never to a
 * dead daemon.
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
  shelf: CONFIG_DEFAULTS.shelf,
  publish: CONFIG_DEFAULTS.publish,
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
      shelf: r.shelf ?? DEFAULTS.shelf,
      publish: { ...CONFIG_DEFAULTS.publish, ...(r.publish ?? {}) } as KernelConfig['publish'],
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
  let config = readKernelConfig(dataDir, log);
  let mtime = configMtime(dataDir);
  const clock = () => Date.now();
  // `db` IS OPENED AFTER `bind()`, the daemon's only mutual exclusion:
  // `openLoopDb` deletes and rebuilds a file of another build's shape, and two
  // shims racing to spawn could otherwise have the loser unlink the file the
  // winner had just opened. The continuation after `await bind()` runs before
  // any connection callback, so no fire can see `deps.db` unset.
  // ONE WriteAuth PER DAEMON PER ORIGIN, built lazily and reused: minting
  // decrypts the keystore, and the daemon must never prompt. `createLocalProvider`
  // with `isTTY: false` is the seam `verifyLocalWallet` uses, so the passphrase
  // comes from `TENJIN_WALLET_PASSPHRASE` or the OS keychain or not at all.
  // A machine that cannot sign gets `unauthenticated` rows and public answers,
  // which is the whole point: a credential problem never withholds one.
  //
  // WHY THE CACHE IS NOT JUST A `let`: the delegation bakes in the origin it
  // was minted for, so `refreshConfig` swapping `config` underneath it is not
  // enough. `write-auth.ts` holds the two rules that make one stale, and it is
  // a module rather than a closure here so they can be tested without booting
  // a daemon.
  const writeAuth = createWriteAuthCache({
    baseUrl: () => config.baseUrl,
    log,
    mint: async (baseUrl: string): Promise<WriteAuth> => {
      const provider = createLocalProvider({
        dir: dataDir,
        env: process.env,
        passphrase: { isTTY: false },
      });
      const signer = await provider.getSigner();
      return resolveWriteAuth({ signer, baseUrl, dataDir, scope: 'read', env: process.env });
    },
  });

  const deps = {
    config: () => config,
    clock,
    log,
    arms: ARMS,
    adapters: ADAPTERS,
    auth: (req: SignableRequest) =>
      searchHeaders(dataDir, req, { now: clock, env: process.env, mint: writeAuth.get }),
    authRefused: writeAuth.refused,
  } as Deps;

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
        db: deps.db,
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
      deps.db?.close();
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
      deps.db?.close();
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
    process.exit(0);
  }
  if (bound.kind === 'foreign') {
    log(`bind ${port}: ${bound.detail}; set \`loop.port\` if this persists`);
    process.exit(1);
  }
  try {
    deps.db = openLoopDb(dataDir);
  } catch (err) {
    log(`loop.db open failed: ${err instanceof Error ? err.message : String(err)}`);
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
