import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { CliError } from './errors';
import { PRODUCTION_ORIGIN } from './production-origin';
import { configPath } from './paths';
import { writeFileAtomic } from './atomic-json';
import { DEFAULT_RPC_URL } from './usdc-balance';

/** A non-negative integer string in USDC atomic units (6-decimal base). */
const atomicString = z.string().regex(/^\d+$/, 'expected an atomic USDC integer string');

/** How much conversation a router hook packet carries. */
export const ROUTER_CONTEXTS = ['session', 'turn'] as const;
export type RouterContext = (typeof ROUTER_CONTEXTS)[number];

/**
 * The router's own block: `enabled` is the off switch every router hook and the
 * `request` tool honour, and `context` is how much conversation a hook packet
 * carries (`session`, up to six prior messages, or `turn`, none). THE ONE SCHEMA
 * for it: the global file validates it here, and a project's
 * `.tenjin/config.json` and `config.local.json` go through
 * {@link parseRouterLayer}. Both keys only ever tighten, which is why a
 * project file may carry them; a key that loosens (spend, allowlist, enabling,
 * base URL) must never join this object. `routerSettings` in
 * router/settings.ts is the one reader of the resolved values.
 */
export const RouterLayerSchema = z.object({
  enabled: z.boolean().optional(),
  context: z.enum(ROUTER_CONTEXTS).optional(),
});
export type RouterLayer = z.infer<typeof RouterLayerSchema>;
const RouterConfigSchema = RouterLayerSchema.required();

/**
 * The `router` block of one project file's parsed JSON, and nothing else: an
 * unknown key, inside the block or beside it, is never read. CONFIG_INVALID,
 * naming the file, when the file is not an object or a key has the wrong type.
 */
export function parseRouterLayer(json: unknown, path: string): RouterLayer {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    throw new CliError('CONFIG_INVALID', `Config at ${path} is not a JSON object`, {
      fix: `Fix ${path}, or delete it.`,
    });
  }
  const parsed = RouterLayerSchema.safeParse((json as { router?: unknown }).router ?? {});
  if (!parsed.success) {
    throw new CliError('CONFIG_INVALID', `Config at ${path} has an invalid router block`, {
      fix: `Use router.enabled true|false and router.context "session"|"turn" in ${path}, or delete it.`,
      details: parsed.error.issues,
    });
  }
  const { enabled, context } = parsed.data;
  return {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(context !== undefined ? { context } : {}),
  };
}

/**
 * What the daily update check is allowed to do about a newer version.
 *
 * `auto` installs it in the background where Tenjin's runtime is set up for the
 * default data dir (see lib/auto-update), and elsewhere behaves as `nudge`: the
 * runtime is the deferred-activation window a self-update needs, since versions
 * sit side by side and a running session keeps the one it started on. `nudge`
 * only reports it — one dim line for a human at a terminal, and an
 * `updateAvailable` field on the JSON envelope for everyone else, which is how
 * an agent learns to run `tenjin update` itself. `off` neither reports nor asks
 * npm.
 */
export const UpdateModeSchema = z.enum(['auto', 'nudge', 'off']);

/** An on/off switch, as `experimental.*` keys take it. */
export const OnOffSchema = z.enum(['on', 'off']);
export type OnOff = z.infer<typeof OnOffSchema>;

/**
 * `experimental.*`: features that ship off. `bazaar` widens the third-party
 * services the router may offer from Tenjin's reviewed list (always on) to the
 * open x402 Bazaar: unreviewed sellers. Off, the client never asks for them.
 */
export const ExperimentalConfigSchema = z.object({ bazaar: OnOffSchema });
export type ExperimentalConfig = z.infer<typeof ExperimentalConfigSchema>;

export function parseOnOffFlag(value: string, keyName: string): OnOff {
  const parsed = OnOffSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new CliError('USAGE', `Invalid ${keyName}: ${JSON.stringify(value)}`, {
    fix: 'Use "on" or "off".',
  });
}

export type UpdateMode = z.infer<typeof UpdateModeSchema>;

const UpdateConfigSchema = z.object({
  mode: UpdateModeSchema,
});

export function parseUpdateModeFlag(value: string, flagName: string): UpdateMode {
  const parsed = UpdateModeSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new CliError('USAGE', `Invalid ${flagName} ${JSON.stringify(value)}`, {
    fix: 'Use "auto", "nudge" or "off".',
  });
}

/** What `install` records about itself. Written by `install`, not a `config set` key. */
const InstallConfigSchema = z.object({
  /**
   * Absolute directories a `tenjin install --project` wired, so `tenjin update`
   * can refresh them. It spawns `install --refresh` from the HOME directory,
   * which is the one place a project install can never be found by looking
   * around: without this list a project-only machine refreshed nothing and
   * reported success while its hooks stayed on the old build.
   *
   * A LIST, because one machine can wire several projects, and entries are
   * dropped by `tenjin uninstall --project` and by any refresh that finds the
   * project's settings file no longer carries our entries.
   */
  routerProjects: z.array(z.string()),
});

/**
 * The persisted config shape. Spend keys are stored atomic (accepted as decimal
 * USD at the command edge, see lib/money). These are client-enforced guardrails, not a
 * security boundary — any process that runs the CLI can also edit this file.
 */
export const ConfigSchema = z.object({
  maxAutoSpend: atomicString,
  sessionBudget: z.union([atomicString, z.literal('none')]),
  /**
   * Hard per-send cap for `tenjin wallet send`, NOT satisfiable by --yes or a prompt
   * (the spend-policy posture): an atomic amount caps each send, "0" disables
   * the verb entirely, and "none" = explicitly uncapped (send exists to drain
   * the wallet, but uncapped is an opt-in, never a default). The key has NO
   * usable default: absent from config.json, `tenjin wallet send` refuses until it is
   * set (see resolveSendMaxAmount). Client-enforced like every spend key (see
   * the note above).
   */
  sendMaxAmount: z.union([z.literal('none'), atomicString]),
  allowlistCreators: z.array(z.string()),
  /** The router's base URL: the Tenjin deployment every router call goes to. */
  baseUrl: z.url(),
  rpcUrl: z.url(),
  /** x402 discovery registries (facilitator base URLs) the direct pay lane
   *  verifies a seller's listing against. */
  bazaarRegistries: z.array(z.url()),
  install: InstallConfigSchema,
  update: UpdateConfigSchema,
  router: RouterConfigSchema,
  experimental: ExperimentalConfigSchema,
});
export type Config = z.infer<typeof ConfigSchema>;

/**
 * Values as they may appear in config.json — every known key optional; absent =
 * default. `.passthrough()` PRESERVES unknown keys through load + persist: a key
 * a newer CLI wrote survives an older binary's `config set`, and so does a key
 * an earlier release wrote and this one no longer reads (the shelf's `publish`,
 * `hooks`, `loop`, `team`, `publicShelfUrl`, `shelfBypassSecret`, `evalCohort`,
 * and `install.harness`/`install.grantDeclined`). Known keys are still
 * validated; unknown keys ride along untouched and are never read.
 */
export const RawConfigSchema = ConfigSchema.partial()
  // Each block is itself partial + passthrough, for the same reason: `config
  // set` writes one subkey, and a sibling it does not know survives.
  .extend({
    install: InstallConfigSchema.partial().passthrough().optional(),
    update: UpdateConfigSchema.partial().passthrough().optional(),
    router: RouterLayerSchema.passthrough().optional(),
    experimental: ExperimentalConfigSchema.partial().passthrough().optional(),
  })
  .passthrough();
export type PartialConfig = z.infer<typeof RawConfigSchema>;

/**
 * The resolved-view sentinel for an absent sendMaxAmount. Never a persistable
 * value (ConfigSchema rejects it, and `config set` has no way to produce it);
 * while the resolved value is this sentinel, `tenjin wallet send` refuses —
 * require-set-before-first-send.
 */
export const SEND_MAX_UNSET = 'unset';

/**
 * Registries verified keyless (CDP/UV on 2026-08-14, PayAI on 2026-08-18): all
 * answer GET /discovery/resources with no credential in the Bazaar envelope
 * the sweep parses. CDP's Bazaar is settlement-derived (it indexes what its
 * facilitator settles, Tenjin's endpoints included); UltraVioleta is the
 * registry Tenjin also announces to; PayAI's facilitator is settlement-derived
 * like CDP's (26k+ listings at verification). PayAI's /discovery/search is
 * keyword-only (measured 2026-10-02), so a natural-language query finds nothing
 * there. It also ignores payTo filters, as UV and CDP do, which the query
 * sweep's per-registry errors and the stored-sweep evidence cover.
 */
export const DEFAULT_BAZAAR_REGISTRIES = [
  'https://api.cdp.coinbase.com/platform/v2/x402',
  'https://facilitator.ultravioletadao.xyz',
  'https://facilitator.payai.network',
];

/**
 * THE TWO SPEND LIMITS, IN EFFECT WHETHER OR NOT ANYONE ANSWERED. The daily
 * budget ($5) is the control; the per-call ceiling ($0.25) is the runaway
 * guard; the wallet balance is the hard stop. Install asks once, these or your
 * own limits, and an install nobody answered still runs on these. A call
 * priced above the ceiling is approved once, for that call.
 */
export const DEFAULT_MAX_AUTO_SPEND = '250000';
export const DEFAULT_SESSION_BUDGET = '5000000';

/** The lowest configurable per-call ceiling, atomic USDC ($0.25). */
export const MAX_AUTO_SPEND_FLOOR_ATOMIC = 250_000n;
/** Why: said by install, `config set` and doctor wherever the floor refuses. */
export const MAX_AUTO_SPEND_FLOOR_WHY =
  'The per-call limit must be at least $0.25. To stop automatic payments, turn the router off with `tenjin config set router.enabled false`.';

export const CONFIG_DEFAULTS: Config = {
  maxAutoSpend: DEFAULT_MAX_AUTO_SPEND,
  sessionBudget: DEFAULT_SESSION_BUDGET,
  // A type placeholder only, never honored: Config requires every key (and
  // CONFIG_KEYS derives from these). resolveSendMaxAmount never reads it — an
  // absent key resolves to SEND_MAX_UNSET and `tenjin wallet send` refuses until the
  // cap is set. '0' (send disabled) rather than 'none' (uncapped) so that if a
  // future caller ever DOES read the cap through loadConfig/fileOrDefault, the
  // leak fails closed instead of silently running uncapped.
  sendMaxAmount: '0',
  allowlistCreators: [],
  baseUrl: PRODUCTION_ORIGIN,
  rpcUrl: DEFAULT_RPC_URL,
  bazaarRegistries: DEFAULT_BAZAAR_REGISTRIES,
  install: { routerProjects: [] },
  update: { mode: 'auto' },
  router: { enabled: true, context: 'session' },
  experimental: { bazaar: 'off' },
};

/**
 * Scalar keys `config get/set/list` render one line each. The nested blocks are
 * excluded: `update`, `router` and `experimental` are addressed by their dotted
 * keys, and `install` is a record `install` writes about itself rather than a
 * setting to hand-edit, so none is ever a bare scalar.
 */
export type ScalarConfigKey = Exclude<
  keyof Config,
  'install' | 'update' | 'router' | 'experimental'
>;
const NESTED_CONFIG_KEYS: ReadonlySet<string> = new Set([
  'install',
  'update',
  'router',
  'experimental',
]);
export const CONFIG_KEYS = (Object.keys(CONFIG_DEFAULTS) as Array<keyof Config>).filter(
  (key): key is ScalarConfigKey => !NESTED_CONFIG_KEYS.has(key),
);

/** The dotted key `config get/set` accepts for the nested update block. */
export const UPDATE_CONFIG_KEYS = ['update.mode'] as const;
export type UpdateConfigKey = (typeof UPDATE_CONFIG_KEYS)[number];

/** The dotted key `config get/set` accepts for the experimental block. */
export const EXPERIMENTAL_CONFIG_KEYS = ['experimental.bazaar'] as const;
export type ExperimentalConfigKey = (typeof EXPERIMENTAL_CONFIG_KEYS)[number];

/** The dotted keys `config get/set` accept for the router block. */
export const ROUTER_CONFIG_KEYS = ['router.enabled', 'router.context'] as const;
export type RouterConfigKey = (typeof ROUTER_CONFIG_KEYS)[number];

export const RETIRED_PAYMENT_KEYS = ['bazaarPay', 'confirm'] as const;
export const RETIRED_PAYMENT_GUIDANCE =
  'Retired payment settings no longer control payments. Use router.enabled, maxAutoSpend and sessionBudget for automatic routing; manual pay always requires consent. Run tenjin install to remove retired keys.';

export function retiredPaymentKeys(raw: PartialConfig): string[] {
  return RETIRED_PAYMENT_KEYS.filter((key) => Object.hasOwn(raw, key));
}

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

/** File values merged over defaults — the effective persisted config. Each
 *  nested block is merged per-subkey, so a file that sets one subkey keeps the
 *  defaults of its siblings (a shallow spread would drop them). */
export async function loadConfig(dir: string): Promise<Config> {
  const raw = { ...(await loadRawConfig(dir)) };
  for (const key of retiredPaymentKeys(raw)) delete raw[key];
  // loadConfig's job is the effective Config object, so an absent key is its
  // default here; the provenance question lives in resolve* below.
  return {
    ...CONFIG_DEFAULTS,
    ...raw,
    install: {
      routerProjects: raw.install?.routerProjects ?? CONFIG_DEFAULTS.install.routerProjects,
    },
    update: { mode: raw.update?.mode ?? CONFIG_DEFAULTS.update.mode },
    router: {
      enabled: raw.router?.enabled ?? CONFIG_DEFAULTS.router.enabled,
      context: raw.router?.context ?? CONFIG_DEFAULTS.router.context,
    },
    experimental: {
      bazaar: raw.experimental?.bazaar ?? CONFIG_DEFAULTS.experimental.bazaar,
    },
  };
}

/** `local` is a project's personal `.tenjin/config.local.json` (router keys only). */
export type Provenance = 'default' | 'file' | 'project' | 'local' | 'env' | 'flag';

export interface ResolvedSetting<T> {
  value: T;
  source: Provenance;
}

/** Effective value + where it came from, per key. What `config` (bare) renders. */
export interface EffectiveSettings {
  maxAutoSpend: ResolvedSetting<string>;
  sessionBudget: ResolvedSetting<string>;
  sendMaxAmount: ResolvedSetting<string>;
  allowlistCreators: ResolvedSetting<string[]>;
  baseUrl: ResolvedSetting<string>;
  rpcUrl: ResolvedSetting<string>;
  bazaarRegistries: ResolvedSetting<string[]>;
  updateMode: ResolvedSetting<UpdateMode>;
  experimentalBazaar: ResolvedSetting<OnOff>;
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
}

/**
 * Apply precedence flag > env > file > default per key, returning each effective
 * value with its source. Only baseUrl has flag/env overrides (`--base-url`,
 * TENJIN_BASE_URL); the rest resolve file-or-default.
 */
export function resolveSettings(input: ResolveSettingsInput): EffectiveSettings {
  const { config, flags, env } = input;
  return {
    maxAutoSpend: fileOrDefault('maxAutoSpend', config),
    sessionBudget: fileOrDefault('sessionBudget', config),
    sendMaxAmount: resolveSendMaxAmount(config),
    allowlistCreators: fileOrDefault('allowlistCreators', config),
    baseUrl: resolveBaseUrl(config, flags, env),
    rpcUrl: fileOrDefault('rpcUrl', config),
    bazaarRegistries: fileOrDefault('bazaarRegistries', config),
    updateMode: resolveUpdateMode(config),
    experimentalBazaar: resolveExperimentalBazaar(config),
  };
}

/** experimental.bazaar: file or default (off), no env or flag. */
export function resolveExperimentalBazaar(config: PartialConfig): ResolvedSetting<OnOff> {
  const fromFile = config.experimental?.bazaar;
  if (fromFile !== undefined) return { value: fromFile, source: 'file' };
  return { value: CONFIG_DEFAULTS.experimental.bazaar, source: 'default' };
}

/** update.mode: file or default, no env or flag. Every surface that reports a
 *  newer version reads this one resolved value, so they cannot disagree. */
function resolveUpdateMode(config: PartialConfig): ResolvedSetting<UpdateMode> {
  const fromFile = config.update?.mode;
  if (fromFile !== undefined) return { value: fromFile, source: 'file' };
  return { value: CONFIG_DEFAULTS.update.mode, source: 'default' };
}

/**
 * Persist a full, validated config via the atomic writer (0700 dir, 0600 file).
 *
 * 0600 BECAUSE config.json CAN HOLD A CREDENTIAL: `rpcUrl` commonly embeds an
 * RPC provider's API key, and every other secret in this tree is 0600 (the
 * wallet, the passphrase, the spend ledger). `dirMode: 0o700` is not a
 * substitute: node's recursive mkdir does not chmod a directory that already
 * exists, so a `~/.tenjin` or `TENJIN_DATA_DIR` created at 0755 by a
 * devcontainer volume, a restored backup or a shared CI image would leave the
 * file world-readable. Keep this in step with `persist` in commands/config.ts,
 * the other writer of this file.
 */
export async function writeConfig(dir: string, config: Config): Promise<void> {
  const validated = ConfigSchema.parse(config);
  await writeFileAtomic(configPath(dir), `${JSON.stringify(validated, null, 2)}\n`, {
    mode: 0o600,
    dirMode: 0o700,
  });
}

/**
 * sendMaxAmount deliberately bypasses fileOrDefault: it has no usable default
 * (the operator's require-set-before-first-send posture). Absent from
 * config.json it resolves to the SEND_MAX_UNSET sentinel with source 'default',
 * which `tenjin wallet send` refuses outright — the cap must be set to an amount, "0"
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
