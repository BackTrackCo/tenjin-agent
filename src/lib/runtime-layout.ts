import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultDataDir, runtimeDir } from './paths';
import { isNewer, parseVersion } from './version-order';

/**
 * WHERE THINGS SIT IN TENJIN'S RUNTIME, and nothing that changes it. Kept apart
 * from `runtime.ts` so the hand-off in `index.ts` and the live marker in
 * `tenjin mcp` can read the layout with `node:*` alone: everything here is
 * synchronous and imports no other Tenjin module but the paths and the version
 * order.
 *
 *   <root>/state.json                 which version is current, previous, pending,
 *                                     and the id of the activation that wrote it
 *   <root>/node/<V>/bin/node          (win32: node/<V>/node.exe)
 *   <root>/versions/<cli>/dist/index.js
 *   <root>/versions/<cli>/.live/<pid> one per `tenjin mcp` running from it
 */

export interface RuntimePointer {
  cli: string;
  node: string;
}

export interface RuntimeState {
  current: RuntimePointer;
  previous: RuntimePointer | null;
  pending: RuntimePointer | null;
}

/** A Node version as `node/<V>` names it: digits only, so it can never be a path. */
const NODE_VERSION_RE = /^\d+\.\d+\.\d+$/;

export function runtimeStatePath(root: string): string {
  return join(root, 'state.json');
}

/**
 * A pointer whose two fields can only name a folder under the root: the CLI
 * version must parse as one this package publishes and the Node version is
 * digits and dots. Anything else is null, so a hand-edited `state.json` cannot
 * point a launcher or a hand-off at some other path.
 */
function pointer(raw: unknown): RuntimePointer | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { cli, node } = raw as { cli?: unknown; node?: unknown };
  if (typeof cli !== 'string' || parseVersion(cli) === null) return null;
  if (typeof node !== 'string' || !NODE_VERSION_RE.test(node)) return null;
  return { cli, node };
}

/** The runtime's state, or null when there is none or its `current` is unusable. */
export function readRuntimeState(root: string): RuntimeState | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(runtimeStatePath(root), 'utf8'));
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const current = pointer(record.current);
  if (current === null) return null;
  return { current, previous: pointer(record.previous), pending: pointer(record.pending) };
}

export function nodeBinPath(
  root: string,
  nodeVersion: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const dir = join(root, 'node', nodeVersion);
  return platform === 'win32' ? join(dir, 'node.exe') : join(dir, 'bin', 'node');
}

export function versionDir(root: string, cli: string): string {
  return join(root, 'versions', cli);
}

export function versionEntry(root: string, cli: string): string {
  return join(versionDir(root, cli), 'dist', 'index.js');
}

/**
 * Is this module running from a runtime copy? `moduleDir` is the bundle's own
 * folder, which in the runtime is `<root>/versions/<cli>/dist`; anything else,
 * the npm folder or a checkout, is null.
 */
export function runtimeBuild(moduleDir: string): { root: string; cli: string } | null {
  if (basename(moduleDir) !== 'dist') return null;
  const cliDir = dirname(moduleDir);
  const cli = basename(cliDir);
  const versions = dirname(cliDir);
  if (parseVersion(cli) === null || basename(versions) !== 'versions') return null;
  return { root: dirname(versions), cli };
}

/**
 * THE RUNTIME TO HAND A COMMAND TO, or null to run this build. A copy of the
 * CLI outside the runtime (npm's, typically, found first on PATH) defers to the
 * runtime's current version when that one is the same or newer, so an old npm copy
 * never answers for a machine that has moved on. Null for a runtime build
 * itself, a non-default data dir (the runtime belongs to `~/.tenjin` alone), no
 * state, a current older than this build, or a current whose files are gone; any
 * error is null too, and this build runs.
 */
export function handoffTarget(
  moduleUrl: string,
  version: string,
  env: NodeJS.ProcessEnv,
  home: string = homedir(),
): { node: string; entry: string } | null {
  try {
    if (runtimeBuild(dirname(fileURLToPath(moduleUrl))) !== null) return null;
    const override = env.TENJIN_DATA_DIR;
    const fallback = defaultDataDir(home);
    const dir = override !== undefined && override.length > 0 ? resolve(override) : fallback;
    if (dir !== fallback) return null;
    const root = runtimeDir(dir);
    const state = readRuntimeState(root);
    if (state === null || (state.current.cli !== version && !isNewer(state.current.cli, version)))
      return null;
    const node = nodeBinPath(root, state.current.node);
    const entry = versionEntry(root, state.current.cli);
    if (!existsSync(node) || !existsSync(entry)) return null;
    return { node, entry };
  } catch {
    return null;
  }
}

/**
 * A `tenjin mcp` running from a runtime version marks it in use, so `collect`
 * leaves it alone while a session still runs it. Returns an idempotent unlink,
 * also run at exit. A no-op outside a runtime build, and every error is
 * swallowed: the marker only spares GC a version, it is never a reason for the
 * server not to start.
 */
export function markLive(moduleDir: string, pid: number = process.pid): () => void {
  const build = runtimeBuild(moduleDir);
  if (build === null) return () => undefined;
  const marker = join(versionDir(build.root, build.cli), '.live', String(pid));
  let done = false;
  const unlink = (): void => {
    if (done) return;
    done = true;
    process.removeListener('exit', unlink);
    try {
      rmSync(marker, { force: true });
    } catch {
      // A leftover marker for a dead pid is pruned by the next collect.
    }
  };
  try {
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, '');
  } catch {
    done = true;
    return () => undefined;
  }
  process.once('exit', unlink);
  return unlink;
}
