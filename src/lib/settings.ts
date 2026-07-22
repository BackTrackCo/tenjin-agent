import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { CliError } from './errors';
import {
  PublishModeSchema,
  loadRawConfig,
  resolvePublishDefaultPrice,
  resolvePublishMode,
  resolveSettings,
} from './config';
import type { Provenance, ProjectPublishLayer, PublishMode } from './config';
import { parseUsdToAtomic } from './money';
import { parseConfirmPolicy, type SpendPolicy } from './policy';
import type { CommandContext } from '../context';

/**
 * The effective runtime settings a B2 command needs, resolved once through the
 * same precedence (flag > env > file > default) config/doctor use. Spend values
 * arrive atomic from config and are handed on as bigint for the policy layer.
 */
export interface ResolvedSettings {
  baseUrl: string;
  rpcUrl: string;
  policy: SpendPolicy;
  /** Lookup-only privacy opt-in; sends X-Tenjin-Eval-Cohort: 1 when true. */
  evalCohort: boolean;
}

export async function resolveContextSettings(ctx: CommandContext): Promise<ResolvedSettings> {
  const config = await loadRawConfig(ctx.dataDir);
  const s = resolveSettings({ config, flags: { baseUrl: ctx.flags.baseUrl }, env: process.env });
  return {
    baseUrl: s.baseUrl.value,
    rpcUrl: s.rpcUrl.value,
    evalCohort: s.evalCohort.value,
    policy: {
      maxAutoSpendAtomic: BigInt(s.maxAutoSpend.value),
      sessionBudgetAtomic: BigInt(s.sessionBudget.value),
      confirm: parseConfirmPolicy(s.confirm.value),
      allowlistCreators: s.allowlistCreators.value,
    },
  };
}

// ---------------------------------------------------------------------------
// Publish consent settings (B3, D38)
//
// The publish mode/price cascade extends the same precedence machinery
// (resolvePublishMode / resolvePublishDefaultPrice in lib/config) with a
// per-project layer that needs I/O the pure resolvers can't do: it walks up from
// cwd for a `.tenjin.json` and asks git whether that file is committed (the
// loosening gate on `full-auto`). It lives here beside resolveContextSettings so
// there is one settings resolver, not a parallel one.
// ---------------------------------------------------------------------------

export const PROJECT_CONFIG_FILE = '.tenjin.json';

/**
 * The per-project override file. `publish.defaultPrice` is DECIMAL USD ("0.10"),
 * because a hand-edited project file is a human edge (O1) — unlike config.json,
 * which stores atomic because `config set` converts at the command edge. The
 * decimal string is converted to atomic at load via the same money util the
 * config command uses. Partial + passthrough: forward-compatible with subkeys a
 * newer CLI adds, same posture as the global config.
 */
const ProjectConfigSchema = z
  .object({
    publish: z
      .object({
        mode: PublishModeSchema.optional(),
        defaultPrice: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export interface LoadedProjectConfig {
  /** Absolute path of the discovered `.tenjin.json`. */
  path: string;
  layer: ProjectPublishLayer;
}

export interface PublishSettingsDeps {
  /** git check-ignore seam; defaults to shelling out to git (see wallet/passphrase). */
  isGitignored?: (filePath: string) => Promise<boolean>;
  /** Ownership seam; defaults to stat().uid vs process uid. Gates a planted file. */
  isForeignOwned?: (filePath: string) => Promise<boolean>;
  /** One-line stderr warning sink; defaults to process.stderr. */
  warn?: (message: string) => void;
  /** Upper bound of the walk; defaults to the user's home directory. */
  homeDir?: string;
}

export interface ResolvedPublishSettings {
  mode: PublishMode;
  modeSource: Provenance;
  defaultPriceAtomic: string;
  defaultPriceSource: Provenance;
  /** Non-fatal notices for stderr (e.g. the full-auto downgrade). */
  warnings: string[];
  /** The `.tenjin.json` that contributed the project layer, if one was found. */
  projectConfigPath?: string;
}

/**
 * Resolve the effective publish mode + default price across every layer:
 * global config.json < project `.tenjin.json` < env (TENJIN_PUBLISH_MODE) <
 * flag (`--mode`), with the `full-auto` loosening gate applied to the project
 * layer. The seam a `publish` command (B3.2) resolves its consent through.
 */
export async function resolvePublishSettings(
  input: { dataDir: string; cwd: string; flag?: string; env?: NodeJS.ProcessEnv },
  deps: PublishSettingsDeps = {},
): Promise<ResolvedPublishSettings> {
  const env = input.env ?? process.env;
  const config = await loadRawConfig(input.dataDir);
  const project = await loadProjectConfig(input.cwd, deps);
  const layer = project?.layer;

  const mode = resolvePublishMode({ config, project: layer, env, flag: input.flag });
  const price = resolvePublishDefaultPrice({ config, project: layer });
  const warnings = mode.downgradedWarning !== undefined ? [mode.downgradedWarning] : [];

  return {
    mode: mode.value,
    modeSource: mode.source,
    defaultPriceAtomic: price.value,
    defaultPriceSource: price.source,
    warnings,
    ...(project !== null ? { projectConfigPath: project.path } : {}),
  };
}

/**
 * Find the nearest `.tenjin.json` walking up from cwd toward the repo root (the
 * first directory holding a `.git`, inclusive), never crossing above $HOME, then
 * load, validate, and check whether it is gitignored. A file not owned by the
 * current user is ignored with a stderr warning (a planted config on a shared
 * host must not become the honored project layer). Null when none is found; a
 * present-but-unreadable/malformed file is CONFIG_INVALID (never silently
 * skipped).
 */
export async function loadProjectConfig(
  cwd: string,
  deps: PublishSettingsDeps = {},
): Promise<LoadedProjectConfig | null> {
  const path = await findProjectConfigFile(cwd, deps);
  if (path === null) return null;

  let json: unknown;
  try {
    // readFile is inside the try: a raced delete (ENOENT), a directory named
    // .tenjin.json (EISDIR), or a permission error (EACCES) is a bad project file,
    // not an INTERNAL fault.
    json = JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    throw new CliError('CONFIG_INVALID', `${PROJECT_CONFIG_FILE} at ${path} could not be read`, {
      fix: `Fix or delete ${path} (must be a readable JSON file).`,
      cause: err,
    });
  }
  const parsed = ProjectConfigSchema.safeParse(json);
  if (!parsed.success) {
    throw new CliError('CONFIG_INVALID', `${PROJECT_CONFIG_FILE} at ${path} is invalid`, {
      fix: `Correct the reported keys in ${path}, or delete it.`,
      details: parsed.error.issues,
    });
  }

  const isGitignored = deps.isGitignored ?? defaultIsGitignored;
  const gitignored = await isGitignored(path);
  const layer: ProjectPublishLayer = { gitignored };
  if (parsed.data.publish !== undefined) {
    const { mode, defaultPrice } = parsed.data.publish;
    layer.publish = {
      ...(mode !== undefined ? { mode } : {}),
      ...(defaultPrice !== undefined
        ? { defaultPrice: parseProjectPrice(defaultPrice, path) }
        : {}),
    };
  }
  return { path, layer };
}

/**
 * Convert a `.tenjin.json` decimal-USD price to atomic via the shared money
 * parser. parseUsdToAtomic throws USAGE on a bad amount; re-raise as
 * CONFIG_INVALID naming the file, so it reads like the file's other errors.
 */
function parseProjectPrice(decimalUsd: string, path: string): string {
  try {
    return parseUsdToAtomic(decimalUsd);
  } catch (err) {
    throw new CliError(
      'CONFIG_INVALID',
      `${PROJECT_CONFIG_FILE} at ${path} has an invalid publish.defaultPrice`,
      { fix: 'Use a non-negative decimal USD amount like "0.10".', cause: err },
    );
  }
}

async function findProjectConfigFile(
  cwd: string,
  deps: PublishSettingsDeps,
): Promise<string | null> {
  const homeDir = deps.homeDir ?? homedir();
  const isForeignOwned = deps.isForeignOwned ?? defaultIsForeignOwned;
  const warn = deps.warn ?? ((message: string) => process.stderr.write(`${message}\n`));

  let dir = cwd;
  // Bounded by $HOME (a shared-host trust boundary) and the filesystem root
  // (dirname('/') === '/'), whichever comes first.
  for (;;) {
    const candidate = join(dir, PROJECT_CONFIG_FILE);
    if (await pathExists(candidate)) {
      if (await isForeignOwned(candidate)) {
        // A file owned by another user (e.g. /tmp/.tenjin.json on a shared box)
        // must never become the honored layer; skip it and keep walking.
        warn(`Ignoring ${candidate}: not owned by the current user.`);
      } else {
        return candidate;
      }
    }
    if (await pathExists(join(dir, '.git'))) return null; // repo root, no file
    if (dir === homeDir) return null; // never cross above $HOME
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * True when the file is owned by a different uid than the process. On a platform
 * without a uid model (Windows: process.getuid is undefined) this is always
 * false — the ownership gate is a POSIX shared-host protection.
 */
async function defaultIsForeignOwned(filePath: string): Promise<boolean> {
  const uid = process.getuid?.();
  if (uid === undefined) return false;
  try {
    return (await stat(filePath)).uid !== uid;
  } catch {
    return false;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * True only on a git check-ignore exit 0 (the path is ignored). Exit 1 (tracked)
 * and any error (git absent, not a repo) resolve false: `full-auto` is honored
 * from a project file ONLY when git positively confirms it is ignored. Uses
 * execFile with an argv array (never a shell), matching wallet/passphrase.ts.
 */
function defaultIsGitignored(filePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['check-ignore', '--quiet', '--', filePath],
      { cwd: dirname(filePath) },
      (err) => resolve(err === null),
    );
  });
}
