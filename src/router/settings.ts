import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { CliError } from '../lib/errors';
import { configPath } from '../lib/paths';
import { findNearestProjectFiles, projectRoot, type ProjectWalkDeps } from '../lib/project-walk';

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
 * No zod and no config schema: the status line calls this once a second.
 */

export const ROUTER_CONTEXTS = ['session', 'turn'] as const;
export type RouterContext = (typeof ROUTER_CONTEXTS)[number];

export const ROUTER_SETTING_DEFAULTS: { enabled: boolean; context: RouterContext } = {
  enabled: true,
  context: 'session',
};

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
}

interface RouterLayer {
  enabled?: boolean;
  context?: RouterContext;
}

export async function routerSettings(
  input: RouterSettingsInput,
  deps: ProjectWalkDeps = {},
): Promise<RouterSettings> {
  const globalPath = configPath(input.dataDir);
  const global = await readLayer(globalPath);
  let enabled: RouterSetting<boolean> = {
    value: ROUTER_SETTING_DEFAULTS.enabled,
    source: 'default',
  };
  let context: RouterSetting<RouterContext> = {
    value: ROUTER_SETTING_DEFAULTS.context,
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
    const layer = await readLayer(path);
    if (layer === null) continue;
    layers.push({
      source: path === join(hit.dir, LOCAL_ROUTER_FILE) ? ('local' as const) : ('project' as const),
      path,
      layer,
    });
  }
  return layers;
}

const ABSENT = new Set(['ENOENT', 'ENOTDIR', 'ERR_INVALID_ARG_VALUE']);

/** The `router` block of one file; null when the file does not exist. */
async function readLayer(path: string): Promise<RouterLayer | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    // No file can be at such a path, which is absence, not a file that failed.
    if (ABSENT.has(String((err as { code?: unknown }).code))) return null;
    throw invalid(path, 'could not be read', err);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw invalid(path, 'is not valid JSON', err);
  }
  if (!isObject(json)) throw invalid(path, 'is not a JSON object');
  const block = json.router;
  if (block === undefined) return {};
  if (!isObject(block)) throw invalid(path, 'has a `router` that is not an object');
  const layer: RouterLayer = {};
  if (block.enabled !== undefined) {
    if (typeof block.enabled !== 'boolean') throw invalid(path, 'has a non-boolean router.enabled');
    layer.enabled = block.enabled;
  }
  if (block.context !== undefined) {
    if (!(ROUTER_CONTEXTS as readonly unknown[]).includes(block.context)) {
      throw invalid(path, 'has a router.context that is not "session" or "turn"');
    }
    layer.context = block.context as RouterContext;
  }
  return layer;
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

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
