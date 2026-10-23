import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  CONFIG_DEFAULTS,
  loadRawConfig,
  parseRouterLayer,
  readPersonalRouter,
  type NativeReplacementMode,
  type PartialConfig,
  type RouterContext,
  type RouterLayer,
  type SourceDescriptor,
} from '../lib/config';
import { normalizeForWire, POLICY_VERSION, type SavedPolicy } from './access';
import { connectedSourceIds } from './accounts/presence';
import { WirePolicySchema, type Target, type WirePolicy } from './decision';
import { CliError } from '../lib/errors';
import { configPath } from '../lib/paths';
import {
  findAllProjectFiles,
  findNearestProjectFiles,
  mainWorktreeOf,
  ownedCandidates,
  projectRoot,
  type ProjectWalkDeps,
} from '../lib/settings';

/**
 * THE ONE READER OF THE ROUTER'S OWN KEYS, `router.enabled` and
 * `router.context`. Both hooks, the `request` tool, doctor, the status line and
 * `tenjin config` call {@link routerSettings} first, and nothing reads a router
 * key any other way.
 *
 * THE LAYERS: the default, `~/.tenjin/config.json`, then EVERY
 * `.tenjin/config.json` and `config.local.json` from the working directory up
 * to the git root, and in a linked git worktree the main checkout's pair too.
 * No environment variable.
 *
 * EVERY LAYER IS A FLOOR. `enabled` is false when any layer says false, and
 * `context` is `turn` when any layer says turn; a key a file leaves out
 * inherits, and a looser value is not read. So a file a cloned repository
 * carries cannot undo `tenjin config set router.enabled false` on this
 * machine, a package in a monorepo cannot undo its root, and a
 * `config.local.json` a repository commits anyway cannot undo the committed
 * one. Both keys fail toward less data sent, and no project file has a spend
 * key to loosen. The source reported is the nearest layer at the value.
 *
 * ONE PARSER. The global block is the one `loadRawConfig` already validated,
 * and a project file goes through `parseRouterLayer` from the same schema.
 *
 * THE PERSONAL SETTINGS COME FROM THE GLOBAL FILE ONLY: the routing rules
 * (`router.policy`), saved accounts (`router.sources`) and automatic
 * replacement with its provider scope. A project file cannot add a rule or
 * turn replacement on, so a cloned repository can never change what Tenjin
 * may use or run on this machine. Each is reread on every call, never cached,
 * so a change from another process applies to the next call.
 */

/** The committed project file and the personal one beside it. */
export const PROJECT_ROUTER_FILE = join('.tenjin', 'config.json');
export const LOCAL_ROUTER_FILE = join('.tenjin', 'config.local.json');

export type RouterSource = 'default' | 'file' | 'project' | 'local';

export interface RouterSetting<T> {
  value: T;
  source: RouterSource;
  /** The file that set it; absent for the default. */
  path?: string;
}

/**
 * The saved routing rules, and what this client sends for them. `wire` is
 * absent when there are no rules, so the body is the one it always was.
 * `invalid` (a hand edit this build cannot read, another version, or a policy
 * past the wire's bounds) is fail-closed: what reads rules refuses, and
 * nothing is sent unrestricted.
 */
export type PolicySetting =
  | { status: 'none'; path: string }
  | {
      status: 'ok';
      saved: SavedPolicy;
      wire?: WirePolicy;
      /** The wire policy's revision: logged and shown, never authority. */
      revision?: string;
      path: string;
    }
  | { status: 'invalid'; problem: string; path: string };

/** Saved account descriptors (#37). A descriptor alone connects nothing:
 *  `connected` is those this machine also holds a vault for. */
export type SourcesSetting =
  | { status: 'ok'; saved: SourceDescriptor[]; connected: string[] }
  | { status: 'invalid'; problem: string };

/** Automatic replacement: off unless the global file says `when-routed`. An
 *  absent provider scope means every allowed provider. */
export interface ReplacementSetting {
  mode: NativeReplacementMode;
  providers?: Target[];
  /** Why the saved value could not be read; the mode then reads off. */
  problem?: string;
}

export interface RouterSettings {
  enabled: RouterSetting<boolean>;
  context: RouterSetting<RouterContext>;
  policy: PolicySetting;
  sources: SourcesSetting;
  nativeReplacement: ReplacementSetting;
}

export interface RouterSettingsInput {
  /** The directory the harness is working in. */
  cwd: string;
  /** The data dir whose `config.json` is the global layer. */
  dataDir: string;
  /** That file, when the caller has already loaded it; read here otherwise. */
  config?: PartialConfig;
}

export async function routerSettings(
  input: RouterSettingsInput,
  deps: ProjectWalkDeps = {},
): Promise<RouterSettings> {
  const globalPath = configPath(input.dataDir);
  const global = (input.config ?? (await loadRawConfig(input.dataDir))).router;
  let enabled: RouterSetting<boolean> = {
    value: CONFIG_DEFAULTS.router.enabled,
    source: 'default',
  };
  let context: RouterSetting<RouterContext> = {
    value: CONFIG_DEFAULTS.router.context,
    source: 'default',
  };
  if (global?.enabled !== undefined) {
    enabled = { value: global.enabled, source: 'file', path: globalPath };
  }
  if (global?.context !== undefined) {
    context = { value: global.context, source: 'file', path: globalPath };
  }

  for (const { source, path, layer } of await projectLayers(input, deps)) {
    // Every layer is a floor: a value looser than the one so far is not read.
    if (layer.enabled !== undefined && (layer.enabled === false || enabled.value)) {
      enabled = { value: layer.enabled, source, path };
    }
    if (layer.context !== undefined && (layer.context === 'turn' || context.value === 'session')) {
      context = { value: layer.context, source, path };
    }
  }
  return { enabled, context, ...personalSettings(global, globalPath) };
}

/**
 * The personal settings, from the global file's router block alone. A saved
 * descriptor names an account; it is connected only where this machine also
 * holds its vault (`accounts/presence.ts`), beside the file in `dataDir`.
 */
export function personalSettings(
  router: unknown,
  path: string,
  dataDir: string = dirname(path),
): Pick<RouterSettings, 'policy' | 'sources' | 'nativeReplacement'> {
  const personal = readPersonalRouter(router);
  const sources: SourcesSetting =
    personal.sources.status === 'ok'
      ? {
          status: 'ok',
          saved: personal.sources.saved,
          connected: connectedSourceIds(
            dataDir,
            personal.sources.saved.map(({ id }) => id),
          ),
        }
      : personal.sources;
  return {
    policy: policySetting(personal.policy, sources, path),
    sources,
    nativeReplacement: personal.nativeReplacement,
  };
}

function policySetting(
  saved: ReturnType<typeof readPersonalRouter>['policy'],
  sources: SourcesSetting,
  path: string,
): PolicySetting {
  if (saved.status === 'invalid') return { ...saved, path };
  // The sources ride inside the policy that is sent, so saved accounts this
  // build cannot read make the rules unreadable too: fail closed.
  if (sources.status === 'invalid') return { status: 'invalid', problem: sources.problem, path };
  // A connected account rides in `sources` with no rule at all: without it the
  // router reads every route on that account as unavailable.
  if (saved.status === 'none' && sources.connected.length === 0) return { status: 'none', path };
  const rules: SavedPolicy = saved.status === 'ok' ? saved.saved : { version: POLICY_VERSION };
  const wire = normalizeForWire(rules, sources.connected);
  if (wire === undefined) return { status: 'ok', saved: rules, path };
  // The bounds a single rule cannot break: the whole policy's serialized size.
  const checked = WirePolicySchema.safeParse(wire);
  if (!checked.success) {
    const [issue] = checked.error.issues;
    return {
      status: 'invalid',
      problem: `router.policy: ${issue?.message ?? 'not a policy the router takes'}`,
      path,
    };
  }
  return {
    status: 'ok',
    saved: rules,
    wire,
    ...(wire.revision !== undefined ? { revision: wire.revision } : {}),
    path,
  };
}

const ROUTER_FILES = [PROJECT_ROUTER_FILE, LOCAL_ROUTER_FILE];

/**
 * Every project layer, outermost first so the nearest one at a value is the
 * one reported: the main checkout's pair when this is a linked worktree, then
 * each directory from the git root down to `cwd`, its project file before its
 * personal one.
 */
async function projectLayers(
  input: RouterSettingsInput,
  deps: ProjectWalkDeps,
): Promise<{ source: 'project' | 'local'; path: string; layer: RouterLayer }[]> {
  const { levels, gitRoot } = await findAllProjectFiles(input.cwd, ROUTER_FILES, {
    ...deps,
    // $HOME/.tenjin is the global scope, not a project.
    homeIsProject: false,
  });
  const main = gitRoot === null ? null : await mainWorktreeOf(gitRoot, deps.homeDir);
  const outer =
    main === null ? [] : [{ dir: main, found: await ownedCandidates(main, ROUTER_FILES, deps) }];
  const layers = [];
  for (const { dir, found } of [...outer, ...levels.reverse()]) {
    // A data dir kept inside a project is the global file, already read.
    if (resolve(dir, '.tenjin') === resolve(input.dataDir)) continue;
    for (const path of found) {
      const file = await readProjectRouterFile(path);
      if (file === null) continue;
      layers.push({
        source: path === join(dir, LOCAL_ROUTER_FILE) ? ('local' as const) : ('project' as const),
        path,
        layer: file.layer,
      });
    }
  }
  return layers;
}

const ABSENT = new Set(['ENOENT', 'ENOTDIR']);

/**
 * One project file: its whole JSON, for a writer that keeps sibling keys, and
 * its router layer through the one parser. Null when there is no file.
 */
export async function readProjectRouterFile(
  path: string,
): Promise<{ json: Record<string, unknown>; layer: RouterLayer } | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if (ABSENT.has(String((err as { code?: unknown }).code))) return null;
    throw invalid(path, 'could not be read', err);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw invalid(path, 'is not valid JSON', err);
  }
  const layer = parseRouterLayer(json, path);
  return { json: json as Record<string, unknown>, layer };
}

/**
 * Where `tenjin config set --project [--local]` writes from `cwd`: beside the
 * layer {@link routerSettings} already reads there, else at the git root, else
 * in `cwd`. Never in $HOME, whose `.tenjin/config.json` is the global file.
 */
export async function projectRouterPath(
  input: { cwd: string; local: boolean },
  deps: ProjectWalkDeps = {},
): Promise<string> {
  const home = deps.homeDir ?? homedir();
  const hit = await findNearestProjectFiles(input.cwd, [PROJECT_ROUTER_FILE, LOCAL_ROUTER_FILE], {
    ...deps,
    warn: () => undefined,
    homeIsProject: false,
  });
  const dir = hit?.dir ?? (await projectRoot(input.cwd, home));
  if (dir === home) {
    throw new CliError(
      'USAGE',
      'Your home directory is not a project: its .tenjin is the global config.',
      {
        fix: 'Run it from inside the project, or drop --project to set it for this machine.',
      },
    );
  }
  return join(dir, input.local ? LOCAL_ROUTER_FILE : PROJECT_ROUTER_FILE);
}

function invalid(path: string, what: string, cause?: unknown): CliError {
  return new CliError('CONFIG_INVALID', `Config at ${path} ${what}`, {
    fix: `Fix ${path}, or delete it.`,
    ...(cause !== undefined ? { cause } : {}),
  });
}
