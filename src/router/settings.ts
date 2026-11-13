import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  CONFIG_DEFAULTS,
  loadRawConfig,
  parseRouterLayer,
  readPersonalRouter,
  type PartialConfig,
  type PersonalRouter,
  type RouterContext,
  type RouterLayer,
} from '../lib/config';
import { CliError } from '../lib/errors';
import { configPath } from '../lib/paths';
import { hasRules, wireSettings, type WireSettings } from './settings-wire';
import {
  findAllProjectFiles,
  findNearestProjectFiles,
  mainWorktreeOf,
  ownedCandidates,
  projectRoot,
  type ProjectWalkDeps,
} from '../lib/settings';

/**
 * THE ONE READER OF THE ROUTER'S OWN KEYS, `router.enabled`,
 * `router.context` and `router.improve`. Both hooks, the `request` tool, doctor, the status line and
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
 * `improve` IS THE GLOBAL FILE'S ALONE. It is the person's own consent for the
 * router to keep the masked text of the turns it sees, so no project layer is
 * read for it: a repository cannot opt anyone in, and turning it off is the
 * one switch in `~/.tenjin/config.json`.
 *
 * SO ARE THE PERSONAL SETTINGS (plan 36): the routing rules (`router.policy`)
 * and automatic use with its provider scope (`router.nativeReplacement`,
 * `router.nativeReplacementProviders`). A project file cannot add a rule or
 * turn automatic use on, so a cloned repository never changes what Tenjin
 * may use or run on this machine. They are reread on every call, never
 * cached, so a change from another process applies to the next call without
 * restarting `tenjin mcp`.
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

/** The saved routing rules: none, readable, or not readable by this build. */
export type PolicySetting = PersonalRouter['policy'];

/** Automatic use: off unless the global file says `when-routed`. An absent
 *  provider scope means every eligible provider; a `problem` says why the
 *  saved value could not be read, and the mode then reads off. */
export type ReplacementSetting = PersonalRouter['nativeReplacement'];

/**
 * WHAT EVERY ROUTING CALL SENDS: the `settings` field with its hash, and
 * whether it carries any rule. `invalid` is fail-closed: rules this build
 * cannot read are never guessed, so nothing routes or runs until they are
 * fixed (`tenjin config` shows the problem, `reset --all` clears it).
 */
export type WireState =
  | { status: 'ok'; settings: WireSettings; hasRules: boolean }
  | { status: 'invalid'; problem: string };

/** The personal settings, from the global file alone. */
export interface PersonalSettings {
  policy: PolicySetting;
  nativeReplacement: ReplacementSetting;
  wire: WireState;
}

export interface RouterSettings extends PersonalSettings {
  enabled: RouterSetting<boolean>;
  context: RouterSetting<RouterContext>;
  /** "Help improve routing": the global file's, or the default, off. */
  improve: RouterSetting<boolean>;
}

/**
 * The personal settings from the global file's router block. The sources are
 * Tenjin's own until accounts land: nothing is connected on this machine.
 */
export function personalSettings(router: unknown): PersonalSettings {
  const personal = readPersonalRouter(router);
  const { policy, nativeReplacement } = personal;
  if (policy.status === 'invalid') {
    return { policy, nativeReplacement, wire: { status: 'invalid', problem: policy.problem } };
  }
  const saved = policy.status === 'ok' ? policy.saved : undefined;
  const settings = wireSettings(saved, nativeReplacement);
  return {
    policy,
    nativeReplacement,
    wire: { status: 'ok', settings, hasRules: hasRules(settings.policy) },
  };
}

/** {@link personalSettings} straight from the global file in `dataDir`: what
 *  the check before every call compares an offer against. */
export async function personalSettingsAt(dataDir: string): Promise<PersonalSettings> {
  return personalSettings((await loadRawConfig(dataDir)).router);
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
  const improve: RouterSetting<boolean> =
    global?.improve !== undefined
      ? { value: global.improve, source: 'file', path: globalPath }
      : { value: CONFIG_DEFAULTS.router.improve, source: 'default' };

  for (const { source, path, layer } of await projectLayers(input, deps)) {
    // Every layer is a floor: a value looser than the one so far is not read.
    if (layer.enabled !== undefined && (layer.enabled === false || enabled.value)) {
      enabled = { value: layer.enabled, source, path };
    }
    if (layer.context !== undefined && (layer.context === 'turn' || context.value === 'session')) {
      context = { value: layer.context, source, path };
    }
  }
  return { enabled, context, improve, ...personalSettings(global) };
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
