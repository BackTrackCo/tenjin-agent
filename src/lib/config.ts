import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { CliError } from './errors';
import { configPath } from './paths';
import { HARNESS_TARGETS } from './skill-wiring';
import { writeFileAtomic } from './atomic-json';

/** A non-negative integer string in USDC atomic units (6-decimal base). */
const atomicString = z.string().regex(/^\d+$/, 'expected an atomic USDC integer string');

/** The publish consent mode (B3, D38). `full-auto` is loosening-gated, below. */
export const PublishModeSchema = z.enum(['review', 'auto', 'full-auto']);
export type PublishMode = z.infer<typeof PublishModeSchema>;

/**
 * Validate a publish-mode value at a command edge (`--mode`, `--publish-mode`):
 * an unrecognized value is USAGE (exit 2), never silently dropped. `flagName` is
 * woven into the message so the failing flag is named.
 */
export function parsePublishModeFlag(value: string, flagName: string): PublishMode {
  const parsed = PublishModeSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new CliError('USAGE', `Invalid ${flagName} ${JSON.stringify(value)}`, {
    fix: 'Use "review", "auto", or "full-auto".',
  });
}

/**
 * The publish block (B3): `mode` governs the confirm cascade a `publish` runs,
 * `defaultPrice` is the atomic USDC price a card is published at when no
 * per-publish price is given. Stored atomic like the spend keys.
 */
const PublishConfigSchema = z.object({
  mode: PublishModeSchema,
  defaultPrice: atomicString,
});

/** Harnesses that may select an isolated autonomy policy. */
export const PolicyProfileNameSchema = z.enum(['hermes', 'openclaw']);
export type PolicyProfileName = z.infer<typeof PolicyProfileNameSchema>;
export const POLICY_PROFILE_NAMES = PolicyProfileNameSchema.options;

/** Scalar autonomy keys a harness profile may override. Single source of truth. */
export const PROFILE_SCALAR_KEYS = [
  'maxAutoSpend',
  'sessionBudget',
  'confirm',
  'allowlistCreators',
] as const;
export type ProfileScalarKey = (typeof PROFILE_SCALAR_KEYS)[number];

/** Known config keys that must never be accepted inside a harness profile. */
const GLOBAL_ONLY_PROFILE_KEYS = [
  'sendMaxAmount',
  'baseUrl',
  'rpcUrl',
  'evalCohort',
  'install',
  'policyProfiles',
] as const;

/**
 * A harness profile can tune agent autonomy without moving credentials or spend
 * accounting into a separate silo. Network, telemetry, and `send` settings stay
 * global on purpose: selecting a harness must never re-point the CLI or enable a
 * model-facing wallet drain primitive.
 */
export const PolicyProfileConfigSchema = z
  .object({
    maxAutoSpend: atomicString.optional(),
    sessionBudget: atomicString.optional(),
    confirm: z.union([z.literal('always'), z.string().regex(/^above:\d+$/)]).optional(),
    allowlistCreators: z.array(z.string()).optional(),
    publish: PublishConfigSchema.partial().passthrough().optional(),
  })
  .passthrough()
  .superRefine((profile, ctx) => {
    for (const key of GLOBAL_ONLY_PROFILE_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(profile, key)) continue;
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message: `${key} is global-only and cannot appear in a policy profile`,
      });
    }
  });
export type PolicyProfileConfig = z.infer<typeof PolicyProfileConfigSchema>;

const PolicyProfilesSchema = z
  .object({
    hermes: PolicyProfileConfigSchema.optional(),
    openclaw: PolicyProfileConfigSchema.optional(),
  })
  .passthrough();

/**
 * What `install` recorded about its OWN targets. `harness` is the explicit
 * `--harness` set of the last install that passed the flag, and it exists so
 * `doctor` keeps judging a directory the user named by hand: detection cannot see a
 * harness this CLI does not probe for, and without the record such a directory is a
 * target for one run and invisible to every later check. Written by `install`, not a
 * `config set` key.
 */
const InstallConfigSchema = z.object({
  harness: z.array(z.enum(HARNESS_TARGETS)),
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
  /**
   * Hard per-send cap for `tenjin send`, NOT satisfiable by --yes or a prompt
   * (the spend-policy posture): an atomic amount caps each send, "0" disables
   * the verb entirely, and "none" = explicitly uncapped (send exists to drain
   * the wallet, but uncapped is an opt-in, never a default). The key has NO
   * usable default: absent from config.json, `tenjin send` refuses until it is
   * set (see resolveSendMaxAmount). Client-enforced like every spend key (see
   * the note above).
   */
  sendMaxAmount: z.union([z.literal('none'), atomicString]),
  allowlistCreators: z.array(z.string()),
  baseUrl: z.url(),
  rpcUrl: z.url(),
  /**
   * Evaluation-cohort opt-in (spec 09 §3): when true, search sends
   * X-Tenjin-Eval-Cohort: 1 and the server stores the generalized question for
   * 90 days. Off by default; no query text is retained server-side without it.
   */
  evalCohort: z.boolean(),
  publish: PublishConfigSchema,
  install: InstallConfigSchema,
  policyProfiles: PolicyProfilesSchema,
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
  .extend({
    publish: PublishConfigSchema.partial().passthrough().optional(),
    install: InstallConfigSchema.partial().passthrough().optional(),
    policyProfiles: PolicyProfilesSchema.optional(),
  })
  .passthrough();
export type PartialConfig = z.infer<typeof RawConfigSchema>;

/**
 * The resolved-view sentinel for an absent sendMaxAmount. Never a persistable
 * value (ConfigSchema rejects it, and `config set` has no way to produce it);
 * while the resolved value is this sentinel, `tenjin send` refuses —
 * require-set-before-first-send.
 */
export const SEND_MAX_UNSET = 'unset';

export const CONFIG_DEFAULTS: Config = {
  maxAutoSpend: '0',
  sessionBudget: '0',
  confirm: 'always',
  // A type placeholder only, never honored: Config requires every key (and
  // CONFIG_KEYS derives from these). resolveSendMaxAmount never reads it — an
  // absent key resolves to SEND_MAX_UNSET and `tenjin send` refuses until the
  // cap is set. '0' (send disabled) rather than 'none' (uncapped) so that if a
  // future caller ever DOES read the cap through loadConfig/fileOrDefault, the
  // leak fails closed instead of silently running uncapped.
  sendMaxAmount: '0',
  allowlistCreators: [],
  baseUrl: 'https://tenjin.blog',
  rpcUrl: 'https://mainnet.base.org',
  evalCohort: false,
  publish: { mode: 'review', defaultPrice: '100000' },
  install: { harness: [] },
  policyProfiles: {},
};

/**
 * Scalar keys `config get/set/list` render one line each. Nested blocks are
 * excluded: `publish` is addressed by dotted keys, `install` is managed by the
 * installer, and `policyProfiles` is selected with `--profile` / TENJIN_HARNESS.
 */
export type ScalarConfigKey = Exclude<keyof Config, 'publish' | 'install' | 'policyProfiles'>;
const NESTED_CONFIG_KEYS: ReadonlySet<string> = new Set(['publish', 'install', 'policyProfiles']);
export const CONFIG_KEYS = (Object.keys(CONFIG_DEFAULTS) as Array<keyof Config>).filter(
  (key): key is ScalarConfigKey => !NESTED_CONFIG_KEYS.has(key),
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
    install: { harness: raw.install?.harness ?? CONFIG_DEFAULTS.install.harness },
    policyProfiles: raw.policyProfiles ?? CONFIG_DEFAULTS.policyProfiles,
  };
}

export type Provenance = 'default' | 'file' | 'profile' | 'project' | 'env' | 'flag';

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
  /** Selected policy profile, if TENJIN_HARNESS or an explicit caller chose one. */
  policyProfile?: PolicyProfileName;
  maxAutoSpend: ResolvedSetting<string>;
  sessionBudget: ResolvedSetting<string>;
  confirm: ResolvedSetting<string>;
  sendMaxAmount: ResolvedSetting<string>;
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
  /** Explicit selection wins over TENJIN_HARNESS. */
  profile?: PolicyProfileName;
}

/** Known profile names only; an unknown environment value fails closed to global policy. */
export function resolvePolicyProfileName(env: NodeJS.ProcessEnv): PolicyProfileName | undefined {
  const parsed = PolicyProfileNameSchema.safeParse(env.TENJIN_HARNESS);
  return parsed.success ? parsed.data : undefined;
}

/** Non-empty invalid env selector, for reporting surfaces that must not hide it. */
export function unrecognizedPolicyProfileName(env: NodeJS.ProcessEnv): string | undefined {
  const value = env.TENJIN_HARNESS;
  if (value === undefined || value.length === 0) return undefined;
  return PolicyProfileNameSchema.safeParse(value).success ? undefined : value;
}

/**
 * Apply precedence flag > env > project > profile > file > default per key,
 * returning each effective value with its source. Only autonomy and publish
 * fields participate in the profile layer; only publish fields participate in
 * the project layer. baseUrl retains its flag/env/file/default cascade.
 */
export function resolveSettings(input: ResolveSettingsInput): EffectiveSettings {
  const { config, flags, env, project } = input;
  const profile = input.profile ?? resolvePolicyProfileName(env);
  const policy = profile === undefined ? undefined : config.policyProfiles?.[profile];
  return {
    ...(profile !== undefined ? { policyProfile: profile } : {}),
    maxAutoSpend: profileOrFile('maxAutoSpend', config, policy),
    sessionBudget: profileOrFile('sessionBudget', config, policy),
    confirm: profileOrFile('confirm', config, policy),
    sendMaxAmount: resolveSendMaxAmount(config),
    allowlistCreators: profileOrFile('allowlistCreators', config, policy),
    baseUrl: resolveBaseUrl(config, flags, env),
    rpcUrl: fileOrDefault('rpcUrl', config),
    evalCohort: fileOrDefault('evalCohort', config),
    publishMode: resolvePublishMode({ config, profile, project, env }),
    publishDefaultPrice: resolvePublishDefaultPrice({ config, profile, project }),
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
 * Resolve publish.mode through global file < harness profile < project
 * `.tenjin.json` < env (TENJIN_PUBLISH_MODE) < flag (`--mode`). Total: an
 * invalid env/flag value is ignored (validation lives at the command edge, like
 * baseUrl). The project layer's `full-auto` is gated on that file being
 * gitignored.
 */
export function resolvePublishMode(input: {
  config: PartialConfig;
  profile?: PolicyProfileName;
  project?: ProjectPublishLayer;
  env: NodeJS.ProcessEnv;
  flag?: string;
}): PublishModeResolution {
  const { config, profile, project, env, flag } = input;
  let winner: PublishModeResolution = { value: CONFIG_DEFAULTS.publish.mode, source: 'default' };

  const fromFile = config.publish?.mode;
  if (fromFile !== undefined) winner = { value: fromFile, source: 'file' };

  const fromProfile =
    profile === undefined ? undefined : config.policyProfiles?.[profile]?.publish?.mode;
  if (fromProfile !== undefined) winner = { value: fromProfile, source: 'profile' };

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

/** Resolve publish.defaultPrice (atomic) through default < file < profile < project. */
export function resolvePublishDefaultPrice(input: {
  config: PartialConfig;
  profile?: PolicyProfileName;
  project?: ProjectPublishLayer;
}): ResolvedSetting<string> {
  const { config, profile, project } = input;
  let result: ResolvedSetting<string> = {
    value: CONFIG_DEFAULTS.publish.defaultPrice,
    source: 'default',
  };
  if (config.publish?.defaultPrice !== undefined) {
    result = { value: config.publish.defaultPrice, source: 'file' };
  }
  const fromProfile =
    profile === undefined ? undefined : config.policyProfiles?.[profile]?.publish?.defaultPrice;
  if (fromProfile !== undefined) {
    result = { value: fromProfile, source: 'profile' };
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

/**
 * sendMaxAmount deliberately bypasses fileOrDefault: it has no usable default
 * (the operator's require-set-before-first-send posture). Absent from
 * config.json it resolves to the SEND_MAX_UNSET sentinel with source 'default',
 * which `tenjin send` refuses outright — the cap must be set to an amount, "0"
 * (disable), or an explicit "none" (uncapped opt-in) before the first send.
 */
function resolveSendMaxAmount(config: PartialConfig): ResolvedSetting<string> {
  if (config.sendMaxAmount !== undefined) return { value: config.sendMaxAmount, source: 'file' };
  return { value: SEND_MAX_UNSET, source: 'default' };
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

function profileOrFile<K extends ProfileScalarKey>(
  key: K,
  config: PartialConfig,
  profile: PolicyProfileConfig | undefined,
): ResolvedSetting<Config[K]> {
  const fromProfile = profile?.[key];
  if (fromProfile !== undefined) {
    return { value: fromProfile as Config[K], source: 'profile' };
  }
  return fileOrDefault(key, config);
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
