import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PLUGIN_DIR, renderHostFiles, type ModSources } from '../router/plugin-files';
import { type RuntimeLaunch } from '../router/launcher-files';
import { renderCodexHostFiles } from '../router/codex-plugin-files';
import { readModSources } from '../router/plugin-folder';
import { writeFileAtomic } from './atomic-json';
import { hasCode } from './errno';
import { CliError } from './errors';
import { pidAlive, withRuntimeLock, type RuntimeLockOptions } from './lock';
import { launcherDir } from './paths';
import {
  inspectLauncher,
  launcherNames,
  writeLaunchers,
  type LauncherResult,
} from './runtime-launchers';
import {
  nodeBinPath,
  runtimeStatePath,
  versionDir,
  versionEntry,
  type RuntimePointer,
} from './runtime-layout';
import {
  completeValid,
  NODE_VERSION_RE,
  rand,
  readNodePin,
  renameDir,
  tmpOf,
} from './runtime-place';
import { isNewer, parseVersion } from './version-order';

// ---------------------------------------------------------------------------
// Activation, collection, removal
// ---------------------------------------------------------------------------

interface RawState {
  current: RuntimePointer | null;
  previous: RuntimePointer | null;
  pending: RuntimePointer | null;
  /**
   * The id of the activation whose final write this is, so its `restore()`
   * can tell whether a later activation has written since. Unset before the
   * first activation that carried one.
   */
  activation?: string;
}

function pointerOf(raw: unknown): RuntimePointer | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { cli, node } = raw as { cli?: unknown; node?: unknown };
  if (typeof cli !== 'string' || parseVersion(cli) === null) return null;
  if (typeof node !== 'string' || !NODE_VERSION_RE.test(node)) return null;
  return { cli, node };
}

/**
 * Every pointer in `state.json`, a `current` of null included: during a first
 * activation only `pending` is set, and GC must keep that version too.
 */
export function readRawState(root: string): RawState {
  try {
    const raw = JSON.parse(readFileSync(runtimeStatePath(root), 'utf8')) as Record<string, unknown>;
    return {
      current: pointerOf(raw.current),
      previous: pointerOf(raw.previous),
      pending: pointerOf(raw.pending),
      ...(typeof raw.activation === 'string' ? { activation: raw.activation } : {}),
    };
  } catch {
    return { current: null, previous: null, pending: null };
  }
}

async function writeState(root: string, state: RawState): Promise<void> {
  await writeFileAtomic(
    runtimeStatePath(root),
    `${JSON.stringify({ schemaVersion: 1, ...state }, null, 2)}\n`,
  );
}

const readOrNull = (path: string): Promise<string | null> =>
  readFile(path, 'utf8').catch(() => null);

/** Put back a file's earlier body, or remove it when there was none. */
async function putBack(path: string, body: string | null, mode: number): Promise<void> {
  if (body === null) await rm(path, { force: true });
  else await writeFileAtomic(path, body, { mode });
}

/**
 * The marketplaces' files in the order a reader can never see a half render:
 * the parts (the mod's files before the hooks file that names its module), then
 * the manifests, then both catalogs.
 */
function renderOrder(files: Record<string, string>): string[] {
  const rank = (path: string): number => {
    const inHost = path.slice(path.indexOf('/') + 1);
    if (inHost === 'tenjin/hooks/hooks.json') return 1;
    if (inHost.startsWith('tenjin/bin/')) return 2;
    if (/^tenjin\/\.(claude|codex)-plugin\/plugin\.json$/.test(inHost)) return 3;
    if (['.claude-plugin/marketplace.json', '.agents/plugins/marketplace.json'].includes(inHost)) {
      return 4;
    }
    return 0;
  };
  return Object.keys(files).sort((a, b) => rank(a) - rank(b));
}

/**
 * THE MOD THE BUILD AT `launch.entry` SHIPS, as written in its own
 * `dist/hosts/claude/tenjin`, so the runtime render carries the mod of the
 * version it runs, never the running package's. Undefined when that build
 * carries none: the render then names no module.
 */
export function runtimeMod(launch: RuntimeLaunch): Promise<ModSources | undefined> {
  return readModSources(join(dirname(launch.entry), 'hosts', 'claude', PLUGIN_DIR));
}

/**
 * Everything the runtime renders for `launch`, by path under the root: the
 * Claude Code marketplace in `claude/` and the Codex one in `codex/`.
 */
export function runtimeHostFiles(
  root: string,
  version: string,
  launch: RuntimeLaunch,
  mod: ModSources | undefined,
): Record<string, string> {
  const under = (host: string, files: Record<string, string>) =>
    Object.entries(files).map(([path, body]) => [`${host}/${path}`, body] as const);
  return Object.fromEntries([
    ...under('claude', renderHostFiles(version, { launch, mod })),
    ...under(
      'codex',
      renderCodexHostFiles({ launch, binDir: join(root, 'codex', PLUGIN_DIR, 'bin') }),
    ),
  ]);
}

const modeFor = (path: string): number => (path.includes('/tenjin/bin/') ? 0o755 : 0o644);

export interface Activation {
  previous: RuntimePointer | null;
  launcher: LauncherResult;
  restore: () => Promise<void>;
}

/** Are `p`'s Node and entry both in place, so the runtime can run it? */
export function runnable(root: string, p: RuntimePointer, platform: NodeJS.Platform): boolean {
  return existsSync(nodeBinPath(root, p.node, platform)) && existsSync(versionEntry(root, p.cli));
}

/**
 * `activate` refused, writing nothing: the runtime already runs `current`, a
 * newer build than the one it was asked to switch to.
 */
export class NewerRuntime extends Error {
  constructor(readonly current: RuntimePointer) {
    super(`Tenjin ${current.cli} is already set up here`);
  }
}

/**
 * SWITCH THE RUNTIME TO `next`, under the lock: record it as `pending`, render
 * `runtime/claude` and `runtime/codex` for it, write the launchers, then make it `current` and
 * clear `pending` in one write. It throws {@link NewerRuntime}, writing
 * nothing, when `current` is already a newer build that runs. A crash in
 * between leaves `pending` set, which GC keeps and the next install
 * re-renders; a render that throws puts the old files back and leaves
 * `pending`. `restore()` undoes the whole switch, for a caller whose
 * registration then failed, and does nothing once a later activation has
 * written `state.json` (its random `activation` id is gone).
 */
export async function activate(
  root: string,
  next: RuntimePointer,
  o: RuntimeLockOptions & { home: string; env: NodeJS.ProcessEnv; platform?: NodeJS.Platform },
): Promise<Activation> {
  const platform = o.platform ?? process.platform;
  const launch: RuntimeLaunch = {
    node: nodeBinPath(root, next.node, platform),
    entry: versionEntry(root, next.cli),
    platform,
    home: o.home,
  };
  return withRuntimeLock(
    root,
    async () => {
      // AN OLDER BUILD NEVER REPLACES A NEWER ONE, checked again here: the
      // caller read `current` before staging, without the lock, and a newer
      // install may have switched to its own build since. Writing `next` now
      // would silently roll every scope back.
      const old = readRawState(root);
      if (
        old.current !== null &&
        isNewer(old.current.cli, next.cli) &&
        runnable(root, old.current, platform)
      ) {
        throw new NewerRuntime(old.current);
      }
      // THE BUILD MUST STILL BE THERE: it was placed under an earlier hold of
      // the lock, and a collect may have run since. A switch to a folder that
      // is gone would leave Claude Code starting nothing.
      if (
        !completeValid(versionDir(root, next.cli)) ||
        !existsSync(launch.entry) ||
        !completeValid(join(root, 'node', next.node)) ||
        !existsSync(launch.node)
      ) {
        throw new CliError(
          'UPDATE_FAILED',
          `tenjin-cli ${next.cli} or its Node ${next.node} is no longer in place in ${root}, so the runtime was not switched to it`,
        );
      }
      const oldStateText = await readOrNull(runtimeStatePath(root));
      await writeState(root, { ...old, pending: next });

      const files = runtimeHostFiles(root, next.cli, launch, await runtimeMod(launch));
      const order = renderOrder(files);
      const oldBodies = new Map<string, string | null>();
      try {
        for (const path of order) {
          const target = join(root, path);
          oldBodies.set(path, await readOrNull(target));
          await writeFileAtomic(target, files[path]!, { mode: modeFor(path) });
        }
      } catch (err) {
        for (const [path, body] of [...oldBodies].reverse()) {
          await putBack(join(root, path), body, modeFor(path)).catch(() => undefined);
        }
        throw err;
      }

      const launcherPaths = launcherNames(platform).map((n) => join(launcherDir(o.home), n));
      const oldLaunchers = await Promise.all(launcherPaths.map(inspectLauncher));
      const launcher = await writeLaunchers(o.home, launch, { env: o.env, platform });

      const previous =
        old.current !== null && old.current.cli !== next.cli ? old.current : old.previous;
      const activation = rand();
      await writeState(root, { current: next, previous, pending: null, activation });

      const restore = () =>
        withRuntimeLock(
          root,
          async () => {
            // ONLY WHILE THIS ACTIVATION IS STILL THE LAST ONE. The lock is
            // released between this switch and the caller's registration, so
            // another install may have activated (and registered) since;
            // putting back what was here before this one would overwrite its
            // switch, or, on a first activation, delete its files.
            if (readRawState(root).activation !== activation) return;
            for (const path of [...order].reverse()) {
              await putBack(join(root, path), oldBodies.get(path) ?? null, modeFor(path));
            }
            if (oldStateText === null) await rm(runtimeStatePath(root), { force: true });
            else await writeFileAtomic(runtimeStatePath(root), oldStateText);
            // Only launchers this activation could have written: ours before, or absent.
            for (const [i, path] of launcherPaths.entries()) {
              const before = oldLaunchers[i]!;
              if (before.state === 'ours') await putBack(path, before.body, 0o755);
              else if (
                before.state === 'absent' &&
                (await inspectLauncher(path)).state === 'ours'
              ) {
                await rm(path, { force: true });
              }
            }
          },
          o,
        );
      return { previous: old.current, launcher, restore };
    },
    o,
  );
}

const IN_USE = 'in use; removed by a later install';
const PLACED = 'placed for an activation still on its way';
const TMP_MAX_AGE_MS = 60 * 60_000;
/**
 * How long a folder no state names is spared after it was placed: longer than
 * any install runs from `placeVersion` or `ensureNode` to `activate` (update's
 * child, verify included, is killed at 60 s).
 */
const PLACED_GRACE_MS = 15 * 60_000;

/** Why `collect` keeps a version a `keep` pointer names. */
const KEPT_FOR_FOLDER = 'a plugin folder runs it';

/**
 * GC, under the lock. Keeps the current, previous and pending versions, every
 * version in `keep` (a plugin folder that runs it by absolute path, which
 * `state.json` does not name), every version a running `tenjin mcp` marked
 * live, the Node versions they pin, and any version or Node placed in the
 * last 15 minutes (by its `.complete`): the lock is held per step, so one
 * placed for an activation still on its way (update's child verifying it) has
 * no role yet. Removes the rest by renaming each into `tmp/trash-*` first. A
 * folder held open (Windows: a running `node.exe`) is kept for a later
 * install. Then sweeps `tmp/` of trash and of anything older than an hour.
 */
export async function collect(
  root: string,
  o: RuntimeLockOptions & { platform?: NodeJS.Platform; keep?: readonly RuntimePointer[] } = {},
): Promise<{ removed: string[]; kept: { path: string; reason: string }[] }> {
  const isAlive = o.isAlive ?? pidAlive;
  const now = o.now ?? Date.now;
  return withRuntimeLock(
    root,
    async () => {
      const state = readRawState(root);
      const removed: string[] = [];
      const kept: { path: string; reason: string }[] = [];
      const keepNode = new Set<string>();
      const roles = new Map<string, string>();
      for (const role of ['current', 'previous', 'pending'] as const) {
        const p = state[role];
        if (p === null) continue;
        if (!roles.has(p.cli)) roles.set(p.cli, role);
        keepNode.add(p.node);
      }
      for (const p of o.keep ?? []) {
        if (!roles.has(p.cli)) roles.set(p.cli, KEPT_FOR_FOLDER);
        keepNode.add(p.node);
      }
      const remove = async (path: string): Promise<void> => {
        const to = join(tmpOf(root), `trash-${rand()}`);
        try {
          await mkdir(tmpOf(root), { recursive: true });
          await renameDir(path, to, o.platform);
        } catch (err) {
          kept.push({
            path,
            reason: ['EBUSY', 'EPERM', 'ENOTEMPTY'].some((c) => hasCode(err, c))
              ? IN_USE
              : `not removed: ${err instanceof Error ? err.message : String(err)}`,
          });
          return;
        }
        removed.push(path);
        await rm(to, { recursive: true, force: true }).catch(() => undefined);
      };
      const placedJustNow = async (dir: string): Promise<boolean> =>
        completeValid(dir) &&
        (await stat(join(dir, '.complete')).then(
          (s) => now() - s.mtimeMs < PLACED_GRACE_MS,
          () => false,
        ));

      const versions = join(root, 'versions');
      for (const name of await readdir(versions).catch(() => [] as string[])) {
        const dir = join(versions, name);
        const liveDir = join(dir, '.live');
        let live = false;
        for (const pid of await readdir(liveDir).catch(() => [] as string[])) {
          if (/^\d+$/.test(pid) && isAlive(Number(pid))) live = true;
          else await rm(join(liveDir, pid), { force: true }).catch(() => undefined);
        }
        const role = roles.get(name);
        if (role !== undefined) {
          kept.push({ path: dir, reason: role });
        } else if (live) {
          kept.push({ path: dir, reason: 'a running tenjin mcp uses it' });
          const pin = readNodePin(dir);
          if (pin !== null) keepNode.add(pin.version);
        } else if (await placedJustNow(dir)) {
          kept.push({ path: dir, reason: PLACED });
          const pin = readNodePin(dir);
          if (pin !== null) keepNode.add(pin.version);
        } else {
          await remove(dir);
        }
      }

      const nodes = join(root, 'node');
      for (const name of await readdir(nodes).catch(() => [] as string[])) {
        const dir = join(nodes, name);
        if (keepNode.has(name)) kept.push({ path: dir, reason: 'pinned by a kept version' });
        else if (await placedJustNow(dir)) kept.push({ path: dir, reason: PLACED });
        else await remove(dir);
      }

      for (const name of await readdir(tmpOf(root)).catch(() => [] as string[])) {
        const path = join(tmpOf(root), name);
        const age = await stat(path).then(
          (s) => now() - s.mtimeMs,
          () => 0,
        );
        if (name.startsWith('trash-') || age > TMP_MAX_AGE_MS) {
          await rm(path, { recursive: true, force: true }).catch(() => undefined);
        }
      }
      return { removed, kept };
    },
    o,
  );
}

/** Every path under `dir` that could not be removed; removes the rest. */
async function removeWhatCan(dir: string): Promise<string[]> {
  try {
    await rm(dir, { recursive: true, force: true });
    return [];
  } catch (err) {
    if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].some((c) => hasCode(err, c))) throw err;
  }
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (entries === null) return [dir];
  const left: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) left.push(...(await removeWhatCan(path)));
    else await rm(path, { force: true }).catch(() => left.push(path));
  }
  if (left.length === 0)
    await rm(dir, { recursive: true, force: true }).catch(() => left.push(dir));
  return left;
}

/** Uninstall's last step: the whole runtime, under its lock (whose directory goes with it). */
export async function removeRuntime(
  root: string,
  o: RuntimeLockOptions = {},
): Promise<{ removed: boolean; left: string[] }> {
  if (!existsSync(root)) return { removed: false, left: [] };
  return withRuntimeLock(
    root,
    async () => {
      const left = await removeWhatCan(root);
      return { removed: left.length === 0, left };
    },
    o,
  );
}
