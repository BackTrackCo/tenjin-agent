import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { CliError } from './errors';
import { configPath } from './paths';
import { writeFileAtomic } from './atomic-json';

/** A non-negative integer string in USDC atomic units (6-decimal base). */
const atomicString = z.string().regex(/^\d+$/, 'expected an atomic USDC integer string');

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
});
export type Config = z.infer<typeof ConfigSchema>;

/** Values as they may appear in config.json — every key optional; absent = default. */
export const RawConfigSchema = ConfigSchema.partial();
export type PartialConfig = z.infer<typeof RawConfigSchema>;

export const CONFIG_DEFAULTS: Config = {
  maxAutoSpend: '0',
  sessionBudget: '0',
  confirm: 'always',
  allowlistCreators: [],
  baseUrl: 'https://tenjin.blog',
  rpcUrl: 'https://mainnet.base.org',
  evalCohort: false,
};

export const CONFIG_KEYS = Object.keys(CONFIG_DEFAULTS) as Array<keyof Config>;

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

/** File values merged over defaults — the effective persisted config. */
export async function loadConfig(dir: string): Promise<Config> {
  return { ...CONFIG_DEFAULTS, ...(await loadRawConfig(dir)) };
}

export type Provenance = 'default' | 'file' | 'env' | 'flag';

export interface ResolvedSetting<T> {
  value: T;
  source: Provenance;
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
}

/** CLI flags that participate in settings precedence (global `--base-url`). */
export interface SettingsFlags {
  baseUrl?: string;
}

export interface ResolveSettingsInput {
  /** Raw file values (present keys only) — from loadRawConfig, not loadConfig. */
  config: PartialConfig;
  flags: SettingsFlags;
  env: NodeJS.ProcessEnv;
}

/**
 * Apply precedence flag > env > file > default per key, returning each effective
 * value with its source. In B1 only baseUrl has flag/env overrides
 * (`--base-url`, TENJIN_BASE_URL); the rest resolve file-or-default.
 */
export function resolveSettings(input: ResolveSettingsInput): EffectiveSettings {
  const { config, flags, env } = input;
  return {
    maxAutoSpend: fileOrDefault('maxAutoSpend', config),
    sessionBudget: fileOrDefault('sessionBudget', config),
    confirm: fileOrDefault('confirm', config),
    allowlistCreators: fileOrDefault('allowlistCreators', config),
    baseUrl: resolveBaseUrl(config, flags, env),
    rpcUrl: fileOrDefault('rpcUrl', config),
    evalCohort: fileOrDefault('evalCohort', config),
  };
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
