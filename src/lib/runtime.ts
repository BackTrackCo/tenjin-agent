import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { RuntimeLaunch } from '../router/launcher-files';
import { proxyNodeStep, proxySkipped } from './env-proxy';
import { CliError } from './errors';
import { isSourceCheckout } from './install-location';
import { withRuntimeLock, type RuntimeLockOptions } from './lock';
import { isDefaultDataDir, runtimeDir } from './paths';
import {
  activate,
  NewerRuntime,
  readRawState,
  runnable,
  runtimeHostFiles,
  runtimeMod,
} from './runtime-activate';
import { nodeKey, runningGlibc, unpinnedPlatform } from './runtime-fetch';
import { writeLaunchers, type LauncherResult } from './runtime-launchers';
import {
  nodeBinPath,
  readRuntimeState,
  runtimeBuild,
  runtimeStatePath,
  versionDir,
  versionEntry,
  type RuntimePointer,
} from './runtime-layout';
import {
  completeValid,
  ensureNode,
  packageRootOf,
  placeVersion,
  readNodePin,
  stageSelf,
} from './runtime-place';
import { verifyBuild } from './runtime-verify';
import { isNewer } from './version-order';

/**
 * Tenjin's own runtime, `~/.tenjin/runtime`: a copy of each CLI version, the
 * pinned Node that runs it, and the plugin folder Claude Code loads, so neither
 * a Node upgrade nor `npm rm -g tenjin-cli` can take the plugin away. Only the
 * default data dir has one.
 *
 * Every change runs under one lock (`withRuntimeLock`), and every step stages
 * under `tmp/`, marks `.complete` last and renames in, so a crash never leaves
 * a half copy at a live path. The switch is `activate`: `state.json` records
 * the version as `pending` before the plugin folder is rendered, and the write
 * that makes it `current` clears it. Nothing here touches the wallet, the
 * passphrase store, the config or the spend ledger.
 */

// ---------------------------------------------------------------------------
// setupRuntime: what install runs
// ---------------------------------------------------------------------------

export interface RuntimeSetup {
  state: 'active' | 'current' | 'kept' | 'failed' | 'skipped';
  root: string;
  cli?: string;
  nodeVersion?: string;
  /** Set for active, current and kept. */
  node?: string;
  entry?: string;
  hostsDir?: string;
  /** No state.json existed before this run. */
  firstTime: boolean;
  launcher: LauncherResult | null;
  reason?: string;
  /**
   * This machine's platform when Tenjin pins no Node for it (musl, glibc below
   * 2.28, another architecture): no install here can set the runtime up, so
   * nothing tells the person to retry.
   */
  unpinned?: string;
  /** The step that works, said in place of a retry that would fail the same way. */
  fix?: string;
  /** `kept` because the runtime already runs a newer build: no failure to report. */
  newer?: true;
  /** Set only for 'active'. */
  restore?: () => Promise<void>;
}

/** Under `install --refresh`, update's child, killed at 60 s: the runtime work gets 35 s, registration the rest. */
const REFRESH_BUDGET_MS = 35_000;
const REFRESH_LOCK_MS = 5_000;
const REFRESH_NODE_MS = 20_000;
const REFRESH_VERIFY_MS = 18_000;
const BUDGET_GONE = 'the 35 s refresh budget ran out';

class BudgetGone extends Error {
  constructor() {
    super(BUDGET_GONE);
  }
}

/**
 * `work`, abandoned (not cancelled) once `ms` pass, so a step that ignores its
 * own timeout cannot hold a refresh past its budget. An infinite `ms` (a plain
 * install, where each step keeps its own default) just waits.
 */
async function within<T>(work: Promise<T>, ms: number): Promise<T> {
  if (!Number.isFinite(ms)) return work;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, fail) => (timer = setTimeout(() => fail(new BudgetGone()), ms))),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Do `runtime/claude` and `runtime/codex` hold, byte for byte, the runtime render for this launch? */
async function hostsMatch(root: string, version: string, launch: RuntimeLaunch): Promise<boolean> {
  const mod = await runtimeMod(launch);
  try {
    return Object.entries(runtimeHostFiles(root, version, launch, mod)).every(
      ([path, body]) => readFileSync(join(root, path), 'utf8') === body,
    );
  } catch {
    return false;
  }
}

/**
 * Set up Tenjin's runtime for this build, as install runs it. `skipped` for a
 * source checkout; a non-default data dir fails. Otherwise `current` when this
 * version is already in place, `active` once it was placed, verified and
 * switched to, `kept` when it could not be (or a newer one is there) and a
 * usable runtime stays, and `failed` with nothing to register. Only `active`
 * changes anything Claude Code reads, and only after `verify` passed.
 */
export async function setupRuntime(o: {
  dataDir: string;
  home: string;
  env: NodeJS.ProcessEnv;
  version: string;
  moduleDir: string;
  refresh: boolean;
  fetchImpl?: typeof fetch;
  platform?: NodeJS.Platform;
  arch?: string;
  verify?: typeof verifyBuild;
  /** Test seam; production asks this Node whether it can use the shell's proxy. */
  proxySupported?: boolean;
}): Promise<RuntimeSetup> {
  const root = runtimeDir(o.dataDir);
  if (isSourceCheckout(o.moduleDir)) {
    return { state: 'skipped', root, firstTime: false, launcher: null };
  }
  if (!isDefaultDataDir(o.dataDir, o.home)) {
    return {
      state: 'failed',
      root,
      firstTime: false,
      launcher: null,
      reason: 'Plugin installation needs the default data directory.',
      fix: 'Run without TENJIN_DATA_DIR.',
    };
  }
  const platform = o.platform ?? process.platform;
  const arch = o.arch ?? process.arch;
  const deadline = o.refresh ? Date.now() + REFRESH_BUDGET_MS : Infinity;
  /** What a step may take: its cap or what is left of the refresh budget, or no bound for a plain install. */
  const left = (cap: number): number => {
    if (!o.refresh) return Infinity;
    const ms = Math.min(cap, deadline - Date.now());
    if (ms <= 0) throw new BudgetGone();
    return ms;
  };
  const lockOpts = (): RuntimeLockOptions =>
    o.refresh ? { lockWaitMs: left(REFRESH_LOCK_MS) } : {};
  const firstTime = !existsSync(runtimeStatePath(root));
  const hostsDir = join(root, 'claude');
  const launchOf = (p: RuntimePointer): RuntimeLaunch => ({
    node: nodeBinPath(root, p.node, platform),
    entry: versionEntry(root, p.cli),
    platform,
    home: o.home,
  });
  const runs = (p: RuntimePointer): RuntimeSetup => ({
    state: 'kept',
    root,
    cli: p.cli,
    nodeVersion: p.node,
    node: launchOf(p).node,
    entry: launchOf(p).entry,
    hostsDir,
    firstTime,
    launcher: null,
  });

  const keptNewer = (p: RuntimePointer): RuntimeSetup => ({
    ...runs(p),
    reason: `Tenjin ${p.cli} is already set up here; this ${o.version} did not replace it`,
    newer: true,
  });

  const state = readRuntimeState(root);
  const usable = state !== null && runnable(root, state.current, platform) ? state.current : null;
  // An older build never replaces a newer one: npm's copy can outlive an update
  // and still answer `tenjin`, and must not silently roll every scope back.
  // Going back is `tenjin uninstall`, then the older install. `activate` checks
  // again under the lock.
  if (usable !== null && isNewer(usable.cli, o.version)) return keptNewer(usable);
  const alreadyCurrent =
    usable !== null &&
    state !== null &&
    usable.cli === o.version &&
    state.pending === null &&
    completeValid(versionDir(root, usable.cli)) &&
    completeValid(join(root, 'node', usable.node)) &&
    (await hostsMatch(root, o.version, launchOf(usable)));

  /**
   * The launchers of a build already current, written under the lock and only
   * while it still is: a newer install may have switched the runtime since
   * `state` was read. Null when the state moved some other way, so the whole
   * setup runs and re-renders.
   */
  const stillCurrent = (p: RuntimePointer): Promise<RuntimeSetup | null> =>
    withRuntimeLock(
      root,
      async () => {
        const now = readRawState(root);
        if (
          now.current !== null &&
          isNewer(now.current.cli, p.cli) &&
          runnable(root, now.current, platform)
        ) {
          return keptNewer(now.current);
        }
        if (now.pending !== null || now.current?.cli !== p.cli || now.current.node !== p.node) {
          return null;
        }
        const launcher = await writeLaunchers(o.home, launchOf(p), { env: o.env, platform });
        return { ...runs(p), state: 'current', launcher };
      },
      lockOpts(),
    );

  const failed = (reason: string): RuntimeSetup =>
    usable !== null
      ? { ...runs(usable), reason }
      : { state: 'failed', root, firstTime, launcher: null, reason };

  // Set while the pinned Node downloads: a failure then, on a Node that skips
  // the shell's proxy, is the proxy's, which no retry on that Node fixes.
  let downloading = false;
  let usedProxyTransport = false;
  try {
    if (alreadyCurrent) {
      const current = await stillCurrent(usable);
      if (current !== null) return current;
    }
    const glibc = platform === 'linux' ? runningGlibc() : null;
    const key = nodeKey(platform, arch, glibc);
    const unpinned = unpinnedPlatform(platform, arch, glibc);
    if (unpinned !== null) {
      return { ...failed(`no pinned Node for this platform, ${unpinned}`), unpinned };
    }
    const build = runtimeBuild(o.moduleDir);
    const packageRoot =
      build !== null ? versionDir(build.root, build.cli) : packageRootOf(o.moduleDir);
    const pin = packageRoot === null ? null : readNodePin(packageRoot);
    if (key === null || pin === null || pin.sha256[key] === undefined) {
      return failed(`no pinned Node for ${key ?? `${platform}-${arch}`}`);
    }
    const next = { cli: o.version, node: pin.version };

    // A runtime build setting itself up is already in place.
    if (build === null || build.cli !== o.version || resolve(build.root) !== resolve(root)) {
      const stage = await within(stageSelf(root, packageRoot!), left(REFRESH_BUDGET_MS));
      await within(
        placeVersion(root, stage, o.version, { ...lockOpts(), platform }),
        left(REFRESH_BUDGET_MS),
      );
    }
    const nodeMs = left(REFRESH_NODE_MS);
    downloading = true;
    usedProxyTransport =
      o.fetchImpl === undefined && proxySkipped(o.env, o.proxySupported) !== null;
    await within(
      ensureNode(root, pin, {
        ...lockOpts(),
        timeoutMs: Number.isFinite(nodeMs) ? nodeMs : 300_000,
        fetchImpl: o.fetchImpl,
        platform,
        arch,
        glibc,
        archivePath: o.env.TENJIN_BOOTSTRAP_NODE_ARCHIVE,
        proxyEnv: usedProxyTransport ? o.env : undefined,
      }),
      nodeMs,
    );
    downloading = false;
    const launch = launchOf(next);
    const verified = await (o.verify ?? verifyBuild)(
      launch,
      o.version,
      o.refresh ? { timeoutMs: left(REFRESH_VERIFY_MS) } : {},
    );
    if (!verified.ok) return failed(verified.reason.slice(0, 200));
    const activation = await activate(root, next, {
      ...lockOpts(),
      home: o.home,
      env: o.env,
      platform,
    });
    return {
      state: 'active',
      root,
      cli: next.cli,
      nodeVersion: next.node,
      node: launch.node,
      entry: launch.entry,
      hostsDir,
      firstTime,
      launcher: activation.launcher,
      restore: activation.restore,
    };
  } catch (err) {
    if (err instanceof NewerRuntime) return keptNewer(err.current);
    const message = err instanceof Error ? err.message : String(err);
    const network =
      (err instanceof CliError && err.code === 'NETWORK_ERROR') || err instanceof BudgetGone;
    const skipped =
      downloading && network && !usedProxyTransport ? proxySkipped(o.env, o.proxySupported) : null;
    if (skipped !== null) {
      return {
        ...failed(`${skipped}: ${message}`.slice(0, 200)),
        fix: proxyNodeStep('tenjin install'),
      };
    }
    return failed(message.slice(0, 200));
  }
}
