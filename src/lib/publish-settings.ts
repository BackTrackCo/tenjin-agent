import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { CliError } from './errors';
import {
  PublishModeSchema,
  loadRawConfig,
  resolvePublishDefaultPrice,
  resolvePublishMode,
} from './config';
import type { Provenance, ProjectPublishLayer } from './config';

/**
 * Resolving the publish consent settings (B3, D38) needs the per-project layer
 * that the pure config resolvers can't reach: it walks up from cwd for a
 * `.tenjin.json`, and asks git whether that file is committed (the loosening gate
 * on `full-auto`). This is the I/O seam over the pure resolvers in lib/config.
 */

export const PROJECT_CONFIG_FILE = '.tenjin.json';

/**
 * The per-project override file. `publish.defaultPrice` is atomic USDC (the same
 * stored form as config.json), not decimal, so the layer feeds the resolvers
 * unchanged. Partial + passthrough: forward-compatible with subkeys a newer CLI
 * adds, same posture as the global config.
 */
const ProjectConfigSchema = z
  .object({
    publish: z
      .object({
        mode: PublishModeSchema.optional(),
        defaultPrice: z
          .string()
          .regex(/^\d+$/, 'expected an atomic USDC integer string')
          .optional(),
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
  /** git check-ignore seam; defaults to shelling out to git. */
  isGitignored?: (filePath: string) => Promise<boolean>;
}

export interface ResolvedPublishSettings {
  mode: 'review' | 'auto' | 'full-auto';
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
 * Find the nearest `.tenjin.json` walking up from cwd to the repo root (the first
 * directory holding a `.git`, inclusive) or the filesystem root, then load,
 * validate, and check whether it is gitignored. Null when none is found; a
 * present-but-malformed file is CONFIG_INVALID (never silently skipped).
 */
export async function loadProjectConfig(
  cwd: string,
  deps: PublishSettingsDeps = {},
): Promise<LoadedProjectConfig | null> {
  const path = await findProjectConfigFile(cwd);
  if (path === null) return null;

  const raw = await readFile(path, 'utf8');
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new CliError('CONFIG_INVALID', `${PROJECT_CONFIG_FILE} at ${path} is not valid JSON`, {
      fix: `Fix the JSON syntax in ${path}, or delete it.`,
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
    layer.publish = {
      ...(parsed.data.publish.mode !== undefined ? { mode: parsed.data.publish.mode } : {}),
      ...(parsed.data.publish.defaultPrice !== undefined
        ? { defaultPrice: parsed.data.publish.defaultPrice }
        : {}),
    };
  }
  return { path, layer };
}

async function findProjectConfigFile(cwd: string): Promise<string | null> {
  let dir = cwd;
  // Bounded by the filesystem root: dirname('/') === '/', which breaks the loop.
  for (;;) {
    const candidate = join(dir, PROJECT_CONFIG_FILE);
    if (await pathExists(candidate)) return candidate;
    if (await pathExists(join(dir, '.git'))) return null; // repo root, no file
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
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
 * from a project file ONLY when git positively confirms it is ignored.
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
