import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  CONFIG_DEFAULTS,
  loadRawConfig,
  parseRouterLayer,
  type PartialConfig,
  type RouterContext,
  type RouterLayer,
} from '../lib/config';
import { CliError } from '../lib/errors';
import { configPath } from '../lib/paths';
import { findNearestProjectFiles, projectRoot, type ProjectWalkDeps } from '../lib/settings';

/**
 * THE ONE READER OF THE ROUTER'S OWN KEYS, `router.enabled` and
 * `router.context`. Both hooks, the `request` tool, doctor, the status line and
 * `tenjin config` call {@link routerSettings} first, and nothing reads a router
 * key any other way.
 *
 * FOUR LAYERS, NEAREST WINS: the default, `~/.tenjin/config.json`, the nearest
 * `<project>/.tenjin/config.json` walking up from the working directory to the
 * git root, then `config.local.json` beside it. There is no ancestor merge and
 * no environment variable.
 *
 * EVERY LAYER ONLY TIGHTENS. A nearer file can turn the router off or narrow
 * the packet to the turn, and a nearer value that would loosen an outer one is
 * not read: a file a cloned repository carries must not undo `tenjin config set
 * router.enabled false` on this machine, and a `config.local.json` a repository
 * commits anyway must not undo the committed one. Both keys fail toward less
 * data sent, and no project file has a spend key to loosen.
 *
 * ONE PARSER. The global block is the one `loadRawConfig` already validated,
 * and a project file goes through `parseRouterLayer` from the same schema.
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

export interface RouterSettings {
  enabled: RouterSetting<boolean>;
  context: RouterSetting<RouterContext>;
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
    // An outer value is a floor: a nearer one that would loosen it is not read.
    if (layer.enabled !== undefined && (layer.enabled === false || enabled.value)) {
      enabled = { value: layer.enabled, source, path };
    }
    if (layer.context !== undefined && (layer.context === 'turn' || context.value === 'session')) {
      context = { value: layer.context, source, path };
    }
  }
  return { enabled, context };
}

/** The project file, then the personal one, from the nearest directory holding either. */
async function projectLayers(
  input: RouterSettingsInput,
  deps: ProjectWalkDeps,
): Promise<{ source: 'project' | 'local'; path: string; layer: RouterLayer }[]> {
  const hit = await findNearestProjectFiles(input.cwd, [PROJECT_ROUTER_FILE, LOCAL_ROUTER_FILE], {
    ...deps,
    // $HOME/.tenjin is the global scope, not a project.
    homeIsProject: false,
  });
  if (hit === null || resolve(hit.dir, '.tenjin') === resolve(input.dataDir)) return [];
  const layers = [];
  for (const path of hit.found) {
    const file = await readProjectRouterFile(path);
    if (file === null) continue;
    const { layer } = file;
    layers.push({
      source: path === join(hit.dir, LOCAL_ROUTER_FILE) ? ('local' as const) : ('project' as const),
      path,
      layer,
    });
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
