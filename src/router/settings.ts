import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  CONFIG_DEFAULTS,
  EFFORT_LEVELS,
  loadRawConfig,
  type EffortClass,
  type EffortFloor,
  type EffortLevel,
  LOWERING_CLASSES,
  type LoweringClass,
  parseRouterLayer,
  ROUTER_SWITCHES,
  type PartialConfig,
  type RouterContext,
  type RouterLayer,
  type RouterSwitch,
} from '../lib/config';
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
 * THE ONE READER OF THE ROUTER'S OWN KEYS, `router.enabled`,
 * `router.context`, `router.improve`, `router.subagents` and the `router.effort`
 * keys. Both hooks, the `request` tool, doctor, the status line and
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
 * `subagents`, `effort`, `effortClasses` AND `effortCap` ARE RAISED BY THE
 * GLOBAL FILE ALONE. `subagents` (`off`, `shadow`, `apply`) decides a delegated
 * task's model; `effort` (the same three) decides effort everywhere: the main
 * agent's turns, and a delegated task's effort at its spawn and on each step.
 * Neither turns the other on. `effortClasses`, `effortCap` and `effortSteps`
 * shape the main agent's turns only; `effortFloor`, the lowest level a lowering
 * reaches, holds for both. A project layer is read for each as a floor like
 * the others: a switch moves toward `off`, the cap toward `low`, the classes
 * narrow, the steps shrink, the effort floor rises toward `medium`, so a
 * repository can make any of them more careful for itself, never less. The
 * Claude mod cannot run this code, so its `effort-rules.ts` reads the same files
 * by the same rule for the main agent's turns; `effort-settings.test.ts` holds
 * the two to the same answers.
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
  /** "Help improve routing": the global file's, or the default, off. */
  improve: RouterSetting<boolean>;
  /** A delegated task's model decision: `off` (the default), `shadow` or `apply`. */
  subagents: RouterSetting<RouterSwitch>;
  /** Every effort decision, the main agent's turns and a delegated task's alike. */
  effort: RouterSetting<RouterSwitch>;
  /** The main-agent turn classes it may change: the two that lower, unless a file says. */
  effortClasses: RouterSetting<EffortClass[]>;
  /** The highest level a main-agent `correction` turn may be raised to. */
  effortCap: RouterSetting<EffortLevel>;
  /** How many steps each main-agent lowering class goes down: 1 each unless a file says. */
  effortSteps: RouterSetting<Record<LoweringClass, number>>;
  /** The lowest level any effort lowering reaches, main agent and delegated task alike. */
  effortFloor: RouterSetting<EffortFloor>;
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
  let subagents: RouterSetting<RouterSwitch> =
    global?.subagents !== undefined
      ? { value: global.subagents, source: 'file', path: globalPath }
      : { value: CONFIG_DEFAULTS.router.subagents, source: 'default' };
  let effort: RouterSetting<RouterSwitch> =
    global?.effort !== undefined
      ? { value: global.effort, source: 'file', path: globalPath }
      : { value: CONFIG_DEFAULTS.router.effort, source: 'default' };
  let effortClasses: RouterSetting<EffortClass[]> =
    global?.effortClasses !== undefined
      ? { value: global.effortClasses, source: 'file', path: globalPath }
      : { value: [...CONFIG_DEFAULTS.router.effortClasses], source: 'default' };
  let effortCap: RouterSetting<EffortLevel> =
    global?.effortCap !== undefined
      ? { value: global.effortCap, source: 'file', path: globalPath }
      : { value: CONFIG_DEFAULTS.router.effortCap, source: 'default' };
  const stepsOf = (given: Partial<Record<LoweringClass, number>> | undefined) =>
    Object.fromEntries(
      LOWERING_CLASSES.map((c) => [c, given?.[c] ?? CONFIG_DEFAULTS.router.effortSteps[c] ?? 1]),
    ) as Record<LoweringClass, number>;
  let effortSteps: RouterSetting<Record<LoweringClass, number>> =
    global?.effortSteps !== undefined
      ? { value: stepsOf(global.effortSteps), source: 'file', path: globalPath }
      : { value: stepsOf(undefined), source: 'default' };
  let effortFloor: RouterSetting<EffortFloor> =
    global?.effortFloor !== undefined
      ? { value: global.effortFloor, source: 'file', path: globalPath }
      : { value: CONFIG_DEFAULTS.router.effortFloor, source: 'default' };

  for (const { source, path, layer } of await projectLayers(input, deps)) {
    // Every layer is a floor: a value looser than the one so far is not read.
    if (layer.enabled !== undefined && (layer.enabled === false || enabled.value)) {
      enabled = { value: layer.enabled, source, path };
    }
    if (layer.context !== undefined && (layer.context === 'turn' || context.value === 'session')) {
      context = { value: layer.context, source, path };
    }
    if (layer.subagents !== undefined && lower(ROUTER_SWITCHES, layer.subagents, subagents.value)) {
      subagents = { value: layer.subagents, source, path };
    }
    if (layer.effort !== undefined && lower(ROUTER_SWITCHES, layer.effort, effort.value)) {
      effort = { value: layer.effort, source, path };
    }
    if (layer.effortClasses !== undefined) {
      const only = layer.effortClasses;
      effortClasses = {
        value: effortClasses.value.filter((c) => only.includes(c)),
        source,
        path,
      };
    }
    if (layer.effortCap !== undefined && lower(EFFORT_LEVELS, layer.effortCap, effortCap.value)) {
      effortCap = { value: layer.effortCap, source, path };
    }
    if (layer.effortSteps !== undefined) {
      const fewer = layer.effortSteps;
      const value = stepsOf(
        Object.fromEntries(
          LOWERING_CLASSES.map((c) => [c, Math.min(effortSteps.value[c], fewer[c] ?? Infinity)]),
        ),
      );
      effortSteps = { value, source, path };
    }
    // The floor is careful upward: a layer is read where it is at or above the one so far.
    if (
      layer.effortFloor !== undefined &&
      lower(EFFORT_LEVELS, effortFloor.value, layer.effortFloor)
    ) {
      effortFloor = { value: layer.effortFloor, source, path };
    }
  }
  return {
    enabled,
    context,
    improve,
    subagents,
    effort,
    effortClasses,
    effortCap,
    effortSteps,
    effortFloor,
  };
}

/** A project value is read only where it is at or below the one so far, on that ladder. */
function lower<T extends string>(ladder: readonly T[], value: T, current: T): boolean {
  return ladder.indexOf(value) <= ladder.indexOf(current);
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
