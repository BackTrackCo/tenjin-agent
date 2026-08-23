import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { CliError } from './errors';
import { PRODUCTION_ORIGIN } from './production-origin';
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

/**
 * What the harness WebSearch hook does when the agent is about to search the web
 * (see lib/hook-scripts.ts). `auto` asks Tenjin first and mentions a tested
 * answer when one exists, `remind` says the marketplace is there without sending
 * the query anywhere, `off` leaves the installed hook inert.
 */
export const SearchHookModeSchema = z.enum(['auto', 'remind', 'off']);
export type SearchHookMode = z.infer<typeof SearchHookModeSchema>;

/**
 * Validate a search-hook mode at a command edge (`--search-hooks`), the same way
 * publish-mode values are validated: an unrecognized value is USAGE, never a
 * silent fallback to the default.
 */
export function parseSearchHookModeFlag(value: string, flagName: string): SearchHookMode {
  const parsed = SearchHookModeSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new CliError('USAGE', `Invalid ${flagName} ${JSON.stringify(value)}`, {
    fix: 'Use "auto", "remind", or "off".',
  });
}

/**
 * Which open loops the Stop hook may raise at the end of a turn.
 *
 * `deliberate-only` is the middle setting the two-value toggle was missing. The
 * hook has two arms, and they are not equally welcome: a deliberate `tenjin
 * search` MISS is a question the agent chose to ask, while the batched
 * ride-along web searches are a firehose in a research session. With only `on`
 * and `off`, silencing the noisy arm meant silencing both, and nothing ever
 * prompts turning them back on (tenjin-agent #162). This keeps the high-signal
 * arm and drops the batch.
 */
export const StopNagModeSchema = z.enum(['on', 'deliberate-only', 'off']);
export type StopNagMode = z.infer<typeof StopNagModeSchema>;

export function parseStopNagFlag(value: string, flagName: string): StopNagMode {
  const parsed = StopNagModeSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new CliError('USAGE', `Invalid ${flagName} ${JSON.stringify(value)}`, {
    fix: 'Use "on", "deliberate-only", or "off".',
  });
}

/** Whether the SessionStart hook prints its primer. Two values and no middle
 *  one: one paragraph either belongs at the top of a session or does not. */
export const SessionPrimerModeSchema = z.enum(['on', 'off']);
export type SessionPrimerMode = z.infer<typeof SessionPrimerModeSchema>;

export function parseSessionPrimerFlag(value: string, flagName: string): SessionPrimerMode {
  const parsed = SessionPrimerModeSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new CliError('USAGE', `Invalid ${flagName} ${JSON.stringify(value)}`, {
    fix: 'Use "on" or "off".',
  });
}

/**
 * Whether the push experiment's hook scripts are wired and speaking (docs/command-reference.md#push-experimental).
 * `on` is what `tenjin push on` writes: `tenjin install` then wires the extra hook
 * entries (prompt, failure, subagent, context) alongside the search hooks it always
 * wires. `off` (the default) leaves any already-wired push scripts on disk but
 * inert — every push arm reads this at run time before it spends a request, so
 * turning the experiment off never needs a re-install.
 */
export const PushModeSchema = z.enum(['on', 'off']);
export type PushMode = z.infer<typeof PushModeSchema>;

export function parsePushModeFlag(value: string, flagName: string): PushMode {
  const parsed = PushModeSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new CliError('USAGE', `Invalid ${flagName} ${JSON.stringify(value)}`, {
    fix: 'Use "on" or "off".',
  });
}

/**
 * What the Stop hook does with an end-of-session capture prompt (docs/command-reference.md#push-experimental's
 * notes half): `block` raises a blocking reason, once per session, when the
 * session carried a research signal (a recorded search, or a push-ledger row) and
 * nothing has captured it yet; `nudge` says the same thing as additionalContext
 * with no block; `off` is silent. Default `off`.
 */
export const CaptureModeSchema = z.enum(['block', 'nudge', 'off']);
export type CaptureMode = z.infer<typeof CaptureModeSchema>;

export function parseCaptureModeFlag(value: string, flagName: string): CaptureMode {
  const parsed = CaptureModeSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new CliError('USAGE', `Invalid ${flagName} ${JSON.stringify(value)}`, {
    fix: 'Use "block", "nudge", or "off".',
  });
}

/**
 * The harness-hook block. EVERY key is read by the installed scripts at run
 * time, which is what makes them runtime toggles rather than install-time
 * choices: `tenjin config set hooks.searchMode off`, `hooks.stopNag off` or
 * `hooks.sessionPrimer off` silences a hook immediately, with no re-install and
 * nothing to unwire. The scripts stay registered and no-op, which is also what
 * lets turning one back on be a single `config set`.
 */
const HooksConfigSchema = z.object({
  searchMode: SearchHookModeSchema,
  stopNag: StopNagModeSchema,
  sessionPrimer: SessionPrimerModeSchema,
  push: PushModeSchema,
  capture: CaptureModeSchema,
});

/**
 * What the daily update check is allowed to do about a newer version.
 *
 * `nudge` reports it — one dim line for a human at a terminal, and an
 * `updateAvailable` field on the JSON envelope for everyone else, which is how
 * an agent learns to run `tenjin update` itself. `off` reports neither and stops
 * asking npm entirely.
 *
 * There is deliberately no mode that installs on its own. Replacing the binary
 * under a running agent has no safe moment in a CLI that starts a fresh process
 * per invocation: "next start" IS "mid-session". Reporting is the part that was
 * missing, so reporting is what this key controls.
 */
export const UpdateModeSchema = z.enum(['nudge', 'off']);
export type UpdateMode = z.infer<typeof UpdateModeSchema>;

const UpdateConfigSchema = z.object({
  mode: UpdateModeSchema,
});

export function parseUpdateModeFlag(value: string, flagName: string): UpdateMode {
  const parsed = UpdateModeSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new CliError('USAGE', `Invalid ${flagName} ${JSON.stringify(value)}`, {
    fix: 'Use "nudge" or "off".',
  });
}

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
  /**
   * The Bazaar pay lane opt-in: when true, `tenjin pay` may pay a NON-Tenjin
   * x402 endpoint, provided a configured registry lists that exact resource and
   * the live 402 matches the listed deal. Off by default; `install` asks once.
   * The lane's teaching is the OPTIONAL tenjin-pay skill, present on disk
   * exactly while this is on (lib/skill-placement).
   */
  bazaarPay: z.boolean(),
  /** x402 discovery registries (facilitator base URLs) `discover` queries and
   *  the Bazaar pay lane verifies against. */
  bazaarRegistries: z.array(z.url()),
  publish: PublishConfigSchema,
  install: InstallConfigSchema,
  hooks: HooksConfigSchema,
  update: UpdateConfigSchema,
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
    hooks: HooksConfigSchema.partial().passthrough().optional(),
    update: UpdateConfigSchema.partial().passthrough().optional(),
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

/**
 * Registries verified keyless (CDP/UV on 2026-08-14, PayAI on 2026-08-18): all
 * answer GET /discovery/resources with no credential in the Bazaar envelope
 * the sweep parses. CDP's Bazaar is settlement-derived (it indexes what its
 * facilitator settles, Tenjin's endpoints included); UltraVioleta is the
 * registry Tenjin also announces to; PayAI's facilitator is settlement-derived
 * like CDP's (26k+ listings at verification). PayAI has no /discovery/search
 * and ignores payTo filters, the same shapes UV and CDP already exhibit, which
 * the query sweep's per-registry errors and the stored-sweep evidence cover.
 */
export const DEFAULT_BAZAAR_REGISTRIES = [
  'https://api.cdp.coinbase.com/platform/v2/x402',
  'https://facilitator.ultravioletadao.xyz',
  'https://facilitator.payai.network',
];

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
  baseUrl: PRODUCTION_ORIGIN,
  rpcUrl: 'https://mainnet.base.org',
  evalCohort: false,
  bazaarPay: false,
  bazaarRegistries: DEFAULT_BAZAAR_REGISTRIES,
  publish: { mode: 'review', defaultPrice: '100000' },
  install: { harness: [] },
  // `auto` is the default because the hook exists to be useful without being
  // asked for; the disclosure and the undo ride the install output, and `off`
  // leaves the installed script inert without touching settings.json. `push` and
  // `capture` default `off`: the push experiment (docs/command-reference.md#push-experimental) is opt-in only,
  // through `tenjin push on`.
  hooks: { searchMode: 'auto', stopNag: 'on', sessionPrimer: 'on', push: 'off', capture: 'off' },
  update: { mode: 'nudge' },
};

/**
 * Scalar keys `config get/set/list` render one line each. The nested blocks are
 * excluded: `publish` and `hooks` are addressed by their dotted keys (see
 * PUBLISH_CONFIG_KEYS / HOOKS_CONFIG_KEYS), and `install` is a record `install`
 * writes about itself rather than a setting to hand-edit, so none is ever a bare
 * scalar.
 */
export type ScalarConfigKey = Exclude<keyof Config, 'publish' | 'install' | 'hooks' | 'update'>;
const NESTED_CONFIG_KEYS: ReadonlySet<string> = new Set(['publish', 'install', 'hooks', 'update']);
export const CONFIG_KEYS = (Object.keys(CONFIG_DEFAULTS) as Array<keyof Config>).filter(
  (key): key is ScalarConfigKey => !NESTED_CONFIG_KEYS.has(key),
);

/** The dotted keys `config get/set` accept for the nested publish block. */
export const PUBLISH_CONFIG_KEYS = ['publish.mode', 'publish.defaultPrice'] as const;
export type PublishConfigKey = (typeof PUBLISH_CONFIG_KEYS)[number];

/** The dotted keys `config get/set` accept for the nested hooks block. */
export const HOOKS_CONFIG_KEYS = [
  'hooks.searchMode',
  'hooks.stopNag',
  'hooks.sessionPrimer',
  'hooks.push',
  'hooks.capture',
] as const;
export type HooksConfigKey = (typeof HOOKS_CONFIG_KEYS)[number];

/** The dotted key `config get/set` accepts for the nested update block. */
export const UPDATE_CONFIG_KEYS = ['update.mode'] as const;
export type UpdateConfigKey = (typeof UPDATE_CONFIG_KEYS)[number];

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
    hooks: {
      searchMode: raw.hooks?.searchMode ?? CONFIG_DEFAULTS.hooks.searchMode,
      stopNag: raw.hooks?.stopNag ?? CONFIG_DEFAULTS.hooks.stopNag,
      sessionPrimer: raw.hooks?.sessionPrimer ?? CONFIG_DEFAULTS.hooks.sessionPrimer,
      push: raw.hooks?.push ?? CONFIG_DEFAULTS.hooks.push,
      capture: raw.hooks?.capture ?? CONFIG_DEFAULTS.hooks.capture,
    },
    update: { mode: raw.update?.mode ?? CONFIG_DEFAULTS.update.mode },
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
  sendMaxAmount: ResolvedSetting<string>;
  allowlistCreators: ResolvedSetting<string[]>;
  baseUrl: ResolvedSetting<string>;
  rpcUrl: ResolvedSetting<string>;
  evalCohort: ResolvedSetting<boolean>;
  bazaarPay: ResolvedSetting<boolean>;
  bazaarRegistries: ResolvedSetting<string[]>;
  publishMode: PublishModeResolution;
  publishDefaultPrice: ResolvedSetting<string>;
  hooksSearchMode: ResolvedSetting<SearchHookMode>;
  hooksStopNag: ResolvedSetting<StopNagMode>;
  hooksSessionPrimer: ResolvedSetting<SessionPrimerMode>;
  hooksPush: ResolvedSetting<PushMode>;
  hooksCapture: ResolvedSetting<CaptureMode>;
  updateMode: ResolvedSetting<UpdateMode>;
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
    sendMaxAmount: resolveSendMaxAmount(config),
    allowlistCreators: fileOrDefault('allowlistCreators', config),
    baseUrl: resolveBaseUrl(config, flags, env),
    rpcUrl: fileOrDefault('rpcUrl', config),
    evalCohort: fileOrDefault('evalCohort', config),
    bazaarPay: fileOrDefault('bazaarPay', config),
    bazaarRegistries: fileOrDefault('bazaarRegistries', config),
    publishMode: resolvePublishMode({ config, project, env }),
    publishDefaultPrice: resolvePublishDefaultPrice({ config, project }),
    hooksSearchMode: resolveHooksSearchMode(config),
    hooksStopNag: resolveHooksStopNag(config),
    hooksSessionPrimer: resolveHooksSessionPrimer(config),
    hooksPush: resolveHooksPush(config),
    hooksCapture: resolveHooksCapture(config),
    updateMode: resolveUpdateMode(config),
  };
}

/** update.mode: file or default, no env or flag. Every surface that reports a
 *  newer version reads this one resolved value, so they cannot disagree. */
function resolveUpdateMode(config: PartialConfig): ResolvedSetting<UpdateMode> {
  const fromFile = config.update?.mode;
  if (fromFile !== undefined) return { value: fromFile, source: 'file' };
  return { value: CONFIG_DEFAULTS.update.mode, source: 'default' };
}

/** hooks.sessionPrimer: file or default, same shape as hooks.searchMode. */
function resolveHooksSessionPrimer(config: PartialConfig): ResolvedSetting<SessionPrimerMode> {
  const fromFile = config.hooks?.sessionPrimer;
  if (fromFile !== undefined) return { value: fromFile, source: 'file' };
  return { value: CONFIG_DEFAULTS.hooks.sessionPrimer, source: 'default' };
}

/** hooks.stopNag: file or default, same shape as hooks.searchMode. */
function resolveHooksStopNag(config: PartialConfig): ResolvedSetting<StopNagMode> {
  const fromFile = config.hooks?.stopNag;
  if (fromFile !== undefined) return { value: fromFile, source: 'file' };
  return { value: CONFIG_DEFAULTS.hooks.stopNag, source: 'default' };
}

/** hooks.searchMode: file or default. No env, flag, or project layer, because the
 *  installed hook script reads the global file directly and has no CLI edge. */
function resolveHooksSearchMode(config: PartialConfig): ResolvedSetting<SearchHookMode> {
  const fromFile = config.hooks?.searchMode;
  if (fromFile !== undefined) return { value: fromFile, source: 'file' };
  return { value: CONFIG_DEFAULTS.hooks.searchMode, source: 'default' };
}

/** hooks.push: file or default, same shape as hooks.searchMode — read at run time
 *  by every push arm, so a set takes effect with no re-install. */
function resolveHooksPush(config: PartialConfig): ResolvedSetting<PushMode> {
  const fromFile = config.hooks?.push;
  if (fromFile !== undefined) return { value: fromFile, source: 'file' };
  return { value: CONFIG_DEFAULTS.hooks.push, source: 'default' };
}

/** hooks.capture: file or default, same shape as hooks.searchMode. */
function resolveHooksCapture(config: PartialConfig): ResolvedSetting<CaptureMode> {
  const fromFile = config.hooks?.capture;
  if (fromFile !== undefined) return { value: fromFile, source: 'file' };
  return { value: CONFIG_DEFAULTS.hooks.capture, source: 'default' };
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
