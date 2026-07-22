import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { CliError } from './errors';
import { configPath } from './paths';
import { writeFileAtomic } from './atomic-json';

/** A non-negative integer string in USDC atomic units (6-decimal base). */
const atomicString = z.string().regex(/^\d+$/, 'expected an atomic USDC integer string');

/** The publish consent mode (B3, D38). `full-auto` is loosening-gated, below. */
export const PublishModeSchema = z.enum(['review', 'auto', 'full-auto']);
export type PublishMode = z.infer<typeof PublishModeSchema>;

/**
 * The publish block (B3): `mode` governs the confirm cascade a `publish` runs,
 * `defaultPrice` is the atomic USDC price a card is published at when no
 * per-publish price is given. Stored atomic like the spend keys.
 */
const PublishConfigSchema = z.object({
  mode: PublishModeSchema,
  defaultPrice: atomicString,
});

/**
 * The persisted config shape. Spend keys are stored atomic (accepted as decimal
 * USD at the command edge, see lib/money); `confirm` is the stored form
 * "always" | "above:<atomic>". These are client-enforced guardrails, not a
 * security boundary — any process that runs the CLI can also edit this file.
 */
export const ConfigSchema = z.object({
  maxAutoSpend: atomicString,
  sessionBudget: atomicString,
  confirm: z.union([z.literal('always'), z.string().regex(/^above:\d+$/)]),
  allowlistCreators: z.array(z.string()),
  baseUrl: z.url(),
  rpcUrl: z.url(),
  /**
   * Evaluation-cohort opt-in (spec 09 §3): when true, lookup sends
   * X-Tenjin-Eval-Cohort: 1 and the server stores the generalized question for
   * 90 days. Off by default; no query text is retained server-side without it.
   */
  evalCohort: z.boolean(),
  publish: PublishConfigSchema,
});
export type Config = z.infer<typeof ConfigSchema>;

/**
 * Values as they may appear in config.json — every known key optional; absent =
 * default. `.passthrough()` PRESERVES unknown keys through load + persist: without
 * it an older binary's `config set` would strip (and re-serialize away) any newer
 * block a later CLI wrote, e.g. B3's `publish.*`. Known keys are still validated;
 * unknown keys ride along untouched.
 */
export const RawConfigSchema = ConfigSchema.partial()
  // The publish block is itself partial + passthrough: `config set publish.mode`
  // writes only the one subkey, and a subkey a newer CLI adds (e.g. publish.*
  // beyond mode/defaultPrice) survives an older binary's set, same reason the
  // outer object passes unknown keys through.
  .extend({ publish: PublishConfigSchema.partial().passthrough().optional() })
  .passthrough();
export type PartialConfig = z.infer<typeof RawConfigSchema>;

export const CONFIG_DEFAULTS: Config = {
  maxAutoSpend: '0',
  sessionBudget: '0',
  confirm: 'always',
  allowlistCreators: [],
  baseUrl: 'https://tenjin.blog',
  rpcUrl: 'https://mainnet.base.org',
  evalCohort: false,
  publish: { mode: 'auto', defaultPrice: '100000' },
};

/**
 * Scalar keys `config get/set/list` render one line each. `publish` is excluded:
 * it is a nested block addressed by the dotted `publish.mode`/`publish.defaultPrice`
 * keys (see PUBLISH_CONFIG_KEYS), so it is never rendered as a bare scalar.
 */
export type ScalarConfigKey = Exclude<keyof Config, 'publish'>;
export const CONFIG_KEYS = (Object.keys(CONFIG_DEFAULTS) as Array<keyof Config>).filter(
  (key): key is ScalarConfigKey => key !== 'publish',
);

/** The dotted keys `config get/set` accept for the nested publish block. */
export const PUBLISH_CONFIG_KEYS = ['publish.mode', 'publish.defaultPrice'] as const;
export type PublishConfigKey = (typeof PUBLISH_CONFIG_KEYS)[number];

/**
 * Read and validate config.json WITHOUT applying defaults, so provenance can
 * distinguish "present in file" from "absent". Missing file is fine (returns
 * {}); malformed JSON or a failed schema is CONFIG_INVALID with a fix.
 */
export async function loadRawConfig(dir: string): Promise<PartialConfig> {
  const path = configPath(dir);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if (isNotFound(err)) return {};
    throw new CliError('CONFIG_INVALID', `Could not read config at ${path}`, {
      fix: `Check file permissions on ${path}.`,
      cause: err,
    });
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new CliError('CONFIG_INVALID', `Config at ${path} is not valid JSON`, {
      fix: `Fix the JSON syntax in ${path}, or delete it to restore defaults.`,
      cause: err,
    });
  }
  const parsed = RawConfigSchema.safeParse(json);
  if (!parsed.success) {
    throw new CliError('CONFIG_INVALID', `Config at ${path} is invalid`, {
      fix: `Correct the reported keys in ${path}, or delete it to restore defaults.`,
      details: parsed.error.issues,
    });
  }
  return parsed.data;
}

/** File values merged over defaults — the effective persisted config. The nested
 *  publish block is merged per-subkey so a file that sets only publish.mode keeps
 *  the default defaultPrice (a shallow spread would drop it). */
export async function loadConfig(dir: string): Promise<Config> {
  const raw = await loadRawConfig(dir);
  return {
    ...CONFIG_DEFAULTS,
    ...raw,
    publish: {
      mode: raw.publish?.mode ?? CONFIG_DEFAULTS.publish.mode,
      defaultPrice: raw.publish?.defaultPrice ?? CONFIG_DEFAULTS.publish.defaultPrice,
    },
  };
}

export type Provenance = 'default' | 'file' | 'project' | 'env' | 'flag';

export interface ResolvedSetting<T> {
  value: T;
  source: Provenance;
}

/**
 * The per-project `.tenjin.json` layer (B3, D38): publish overrides discovered by
 * walking up from cwd, plus whether that file is gitignored. `gitignored` gates
 * `full-auto` — a committed file requesting it is downgraded (loosening gate).
 */
export interface ProjectPublishLayer {
  publish?: { mode?: PublishMode; defaultPrice?: string };
  gitignored: boolean;
}

/** publish.mode resolution: value, source, and the downgrade warning (if any). */
export interface PublishModeResolution {
  value: PublishMode;
  source: Provenance;
  /** Set when a committed `.tenjin.json`'s `full-auto` was downgraded to `auto`. */
  downgradedWarning?: string;
}

/** Effective value + where it came from, per key. What `config` (bare) renders. */
export interface EffectiveSettings {
  maxAutoSpend: ResolvedSetting<string>;
  sessionBudget: ResolvedSetting<string>;
  confirm: ResolvedSetting<string>;
  allowlistCreators: ResolvedSetting<string[]>;
  baseUrl: ResolvedSetting<string>;
  rpcUrl: ResolvedSetting<string>;
  evalCohort: ResolvedSetting<boolean>;
  publishMode: PublishModeResolution;
  publishDefaultPrice: ResolvedSetting<string>;
}

/** CLI flags that participate in settings precedence (`--base-url`). */
export interface SettingsFlags {
  baseUrl?: string;
}

export interface ResolveSettingsInput {
  /** Raw file values (present keys only) — from loadRawConfig, not loadConfig. */
  config: PartialConfig;
  flags: SettingsFlags;
  env: NodeJS.ProcessEnv;
  /** The nearest `.tenjin.json` layer, when one was found (see publish-settings). */
  project?: ProjectPublishLayer;
}

/**
 * Apply precedence flag > env > file > default per key, returning each effective
 * value with its source. In B1 only baseUrl has flag/env overrides
 * (`--base-url`, TENJIN_BASE_URL); the rest resolve file-or-default. B3 adds the
 * publish keys, which additionally fold in the per-project `.tenjin.json` layer.
 */
export function resolveSettings(input: ResolveSettingsInput): EffectiveSettings {
  const { config, flags, env, project } = input;
  return {
    maxAutoSpend: fileOrDefault('maxAutoSpend', config),
    sessionBudget: fileOrDefault('sessionBudget', config),
    confirm: fileOrDefault('confirm', config),
    allowlistCreators: fileOrDefault('allowlistCreators', config),
    baseUrl: resolveBaseUrl(config, flags, env),
    rpcUrl: fileOrDefault('rpcUrl', config),
    evalCohort: fileOrDefault('evalCohort', config),
    publishMode: resolvePublishMode({ config, project, env }),
    publishDefaultPrice: resolvePublishDefaultPrice({ config, project }),
  };
}

/**
 * The loosening gate (D38): a committed (not-gitignored) `.tenjin.json` requesting
 * `full-auto` is downgraded to `auto`, never silently honored — cloning a repo
 * must not enable auto-publish. `full-auto` from global config / env / flag (all
 * inherently local, not cloned) is always honored.
 */
const FULL_AUTO_DOWNGRADE_WARNING =
  'Ignoring publish.mode "full-auto" from a committed .tenjin.json (cloning a repo must not enable auto-publish); using "auto". Add .tenjin.json to .gitignore to opt in.';

function coercePublishMode(raw: string | undefined): PublishMode | undefined {
  if (raw === undefined || raw.length === 0) return undefined;
  const parsed = PublishModeSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Resolve publish.mode through global file < project `.tenjin.json` < env
 * (TENJIN_PUBLISH_MODE) < flag (`--mode`). Total: an invalid env/flag value is
 * ignored (validation lives at the command edge, like baseUrl). The project
 * layer's `full-auto` is gated on that file being gitignored.
 */
export function resolvePublishMode(input: {
  config: PartialConfig;
  project?: ProjectPublishLayer;
  env: NodeJS.ProcessEnv;
  flag?: string;
}): PublishModeResolution {
  const { config, project, env, flag } = input;
  let winner: PublishModeResolution = { value: CONFIG_DEFAULTS.publish.mode, source: 'default' };

  const fromFile = config.publish?.mode;
  if (fromFile !== undefined) winner = { value: fromFile, source: 'file' };

  if (project !== undefined && project.publish?.mode !== undefined) {
    const fromProject = project.publish.mode;
    if (fromProject === 'full-auto' && !project.gitignored) {
      winner = { value: 'auto', source: 'project', downgradedWarning: FULL_AUTO_DOWNGRADE_WARNING };
    } else {
      winner = { value: fromProject, source: 'project' };
    }
  }

  const fromEnv = coercePublishMode(env.TENJIN_PUBLISH_MODE);
  if (fromEnv !== undefined) winner = { value: fromEnv, source: 'env' };

  const fromFlag = coercePublishMode(flag);
  if (fromFlag !== undefined) winner = { value: fromFlag, source: 'flag' };

  return winner;
}

/** Resolve publish.defaultPrice (atomic) through global file < project < default. */
export function resolvePublishDefaultPrice(input: {
  config: PartialConfig;
  project?: ProjectPublishLayer;
}): ResolvedSetting<string> {
  const { config, project } = input;
  let result: ResolvedSetting<string> = {
    value: CONFIG_DEFAULTS.publish.defaultPrice,
    source: 'default',
  };
  if (config.publish?.defaultPrice !== undefined) {
    result = { value: config.publish.defaultPrice, source: 'file' };
  }
  if (project?.publish?.defaultPrice !== undefined) {
    result = { value: project.publish.defaultPrice, source: 'project' };
  }
  return result;
}

/** Persist a full, validated config via the atomic writer (0700 dir, 0644 file). */
export async function writeConfig(dir: string, config: Config): Promise<void> {
  const validated = ConfigSchema.parse(config);
  await writeFileAtomic(configPath(dir), `${JSON.stringify(validated, null, 2)}\n`, {
    mode: 0o644,
    dirMode: 0o700,
  });
}

function fileOrDefault<K extends keyof Config>(
  key: K,
  config: PartialConfig,
): ResolvedSetting<Config[K]> {
  const fromFile = config[key];
  // PartialConfig[K] is Config[K] | undefined; narrowing an indexed access of a
  // type parameter doesn't refine K, so assert the excluded-undefined type.
  if (fromFile !== undefined) return { value: fromFile as Config[K], source: 'file' };
  return { value: CONFIG_DEFAULTS[key], source: 'default' };
}

function resolveBaseUrl(
  config: PartialConfig,
  flags: SettingsFlags,
  env: NodeJS.ProcessEnv,
): ResolvedSetting<string> {
  if (flags.baseUrl !== undefined && flags.baseUrl.length > 0) {
    return { value: flags.baseUrl, source: 'flag' };
  }
  const fromEnv = env.TENJIN_BASE_URL;
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return { value: fromEnv, source: 'env' };
  }
  if (config.baseUrl !== undefined) return { value: config.baseUrl, source: 'file' };
  return { value: CONFIG_DEFAULTS.baseUrl, source: 'default' };
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}
