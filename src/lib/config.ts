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
 * The standing answer to the MARKETPLACE gate's warn tier (lib/consent.ts,
 * `acksServerWarnings`), which is a different question from `publish.mode`: the
 * mode decides what a run asks about the findings it can see locally, and this
 * decides whether a yes already given also covers findings only the server
 * found.
 *
 * `mode` (the default) derives the answer: `full-auto` acks, and anything else
 * acks only when the server contributed nothing the local pass had not already
 * rendered. `off` never acks, whatever the mode says, which is the off switch a
 * `full-auto` machine has without changing its mode. `on` is the operator's
 * standing yes for server findings, and it still needs a yes for the run: it
 * restores the pre-gate reading of `--yes` rather than manufacturing one.
 */
export const AckServerWarningsSchema = z.enum(['mode', 'on', 'off']);
export type AckServerWarnings = z.infer<typeof AckServerWarningsSchema>;

/**
 * Validate an ack-setting value at a command edge: an unrecognized value is
 * USAGE (exit 2), never silently dropped onto the looser reading.
 */
export function parseAckServerWarnings(value: string, keyName: string): AckServerWarnings {
  const parsed = AckServerWarningsSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new CliError('USAGE', `Invalid ${keyName} ${JSON.stringify(value)}`, {
    fix: 'Use "mode", "on", or "off".',
  });
}

/**
 * The publish block (B3): `mode` governs the confirm cascade a `publish` runs,
 * `defaultPrice` is the atomic USDC price a card is published at when no
 * per-publish price is given (stored atomic like the spend keys), and
 * `ackServerWarnings` is the standing answer to the server gate's warn tier.
 */
const PublishConfigSchema = z.object({
  mode: PublishModeSchema,
  defaultPrice: atomicString,
  ackServerWarnings: AckServerWarningsSchema,
});

/**
 * What the harness WebSearch hook does when the agent is about to search the web
 * (see lib/hook-scripts.ts). `auto` asks Tenjin first and mentions a tested
 * answer when one exists, `remind` says the marketplace is there without sending
 * the query anywhere, `off` leaves the installed hook inert.
 */
export const WebSearchModeSchema = z.enum(['auto', 'remind', 'off']);
export type WebSearchMode = z.infer<typeof WebSearchModeSchema>;

/**
 * What the subagent-dispatch hook does, on its own switch. Disjoint from
 * `hooks.webSearch`: both default `auto`, no `inherit`. The split exists because
 * a dispatch prompt is the most sensitive payload any hook sees: a fleet can keep
 * `webSearch auto` and still run dispatch as `remind` (a local nudge, nothing
 * sent) or `off`.
 */
export const AgentDispatchModeSchema = z.enum(['auto', 'remind', 'off']);
export type AgentDispatchMode = z.infer<typeof AgentDispatchModeSchema>;

// Backward compat aliases — old keys still parse, new code uses the WebSearch/AgentDispatch names.
export const SearchHookModeSchema = WebSearchModeSchema;
export type SearchHookMode = WebSearchMode;
/** Legacy: accepted on read for old config files that stored `inherit`. */
export const DispatchHookModeSchema = z.enum(['inherit', 'auto', 'remind', 'off']);
export type DispatchHookMode = z.infer<typeof DispatchHookModeSchema>;

/** Validate a dispatch-hook mode at a command edge for the new disjoint key. */
export function parseAgentDispatchHookModeFlag(value: string, flagName: string): AgentDispatchMode {
  const parsed = AgentDispatchModeSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new CliError('USAGE', `Invalid ${flagName} ${JSON.stringify(value)}`, {
    fix: 'Use "auto", "remind", or "off".',
  });
}

/** Validate a web-search hook mode at a command edge. */
export function parseWebSearchHookModeFlag(value: string, flagName: string): WebSearchMode {
  const parsed = WebSearchModeSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new CliError('USAGE', `Invalid ${flagName} ${JSON.stringify(value)}`, {
    fix: 'Use "auto", "remind", or "off".',
  });
}

/** @deprecated use parseAgentDispatchHookModeFlag — kept for `hooks.dispatchMode` alias */
export function parseDispatchHookModeFlag(value: string, flagName: string): DispatchHookMode {
  const parsed = DispatchHookModeSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new CliError('USAGE', `Invalid ${flagName} ${JSON.stringify(value)}`, {
    fix: 'Use "inherit", "auto", "remind", or "off".',
  });
}

/**
 * @deprecated use parseWebSearchHookModeFlag — kept for `hooks.searchMode` alias
 */
export function parseSearchHookModeFlag(value: string, flagName: string): SearchHookMode {
  return parseWebSearchHookModeFlag(value, flagName);
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
 * notes half): `block` raises a blocking reason when the
 * session carried a research signal (a search it asked for, a row showing an
 * arm actually surfaced something, or a subagent finding on the queue) and
 * nothing has captured it yet, and it is also the one mode in which a subagent
 * is asked at its own end; `nudge` says the same thing to the parent as
 * additionalContext, blocks nobody, and never spends a child a turn, which
 * makes it the "parent asks, child never blocked" switch; `off` is silent
 * everywhere. Default `off`. The parent's ask fires once per session plus once
 * for anything that arrives afterwards and has not been named.
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
 * choices: `tenjin config set hooks.webSearch off`, `hooks.agentDispatch off`,
 * `hooks.stopNag off` or `hooks.sessionPrimer off` silences a hook immediately,
 * with no re-install and nothing to unwire. The scripts stay registered and
 * no-op, which is also what lets turning one back on be a single `config set`.
 */
const HooksConfigSchema = z.object({
  webSearch: WebSearchModeSchema,
  agentDispatch: AgentDispatchModeSchema,
  stopNag: StopNagModeSchema,
  sessionPrimer: SessionPrimerModeSchema,
  push: PushModeSchema,
  capture: CaptureModeSchema,
});

/**
 * Legacy hook fields kept for one release so an old config.json still parses.
 * `searchMode` maps to `webSearch`; `dispatchMode` (including `inherit`) maps
 * to `agentDispatch` per the migration in loadConfig / resolve* below.
 */
const LegacyHooksFields = z.object({
  searchMode: SearchHookModeSchema.optional(),
  dispatchMode: DispatchHookModeSchema.optional(),
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

/**
 * The loop daemon's numbers (tenjin-notes loop-redesign/02-redesign.md §7). TWO
 * budget numbers and two daemon knobs; every other bound is a formula over
 * these or a constant with a stated reason in `src/hooks/constants.ts`.
 *
 * `human_wait_ms`: a fire the human is waiting on (prompt, Stop, SessionStart).
 * `tool_wait_ms`: a fire a tool call is waiting on. There is no third budget:
 * a client-side rate limit rationed the research panel the loop exists to
 * capture, so the runaway stop is the server's own 429. `idle_exit_min`: the
 * daemon exits after this long with no request. `port`: null derives one from
 * the data dir path; set it only when doctor reports a foreign listener.
 */
const positiveInt = z.number().int().positive();
export const LoopConfigSchema = z.object({
  human_wait_ms: positiveInt,
  tool_wait_ms: positiveInt,
  idle_exit_min: positiveInt,
  port: z.number().int().min(0).max(65535).nullable(),
});
export type LoopConfig = z.infer<typeof LoopConfigSchema>;

/**
 * `team.publicFallback` (tenjin-agent#229): `off` drops every public-only stage
 * from every lookup plan, so a team-mode miss never reaches tenjin.blog. Plain
 * config read by the daemon per fire; install against a team shelf writes `off`.
 */
export const PublicFallbackSchema = z.enum(['on', 'off']);
export type PublicFallback = z.infer<typeof PublicFallbackSchema>;
export const TeamConfigSchema = z.object({ publicFallback: PublicFallbackSchema });
export type TeamConfig = z.infer<typeof TeamConfigSchema>;

export function parsePublicFallbackFlag(value: string, keyName: string): PublicFallback {
  const parsed = PublicFallbackSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new CliError('USAGE', `Invalid ${keyName}: ${JSON.stringify(value)}`, {
    fix: 'Use "on" or "off".',
  });
}

/** A `loop.*` value from `config set`: a positive integer, or for `loop.port`
 *  also `0`..`65535` or `null` (derive). */
export function parseLoopValue(key: LoopConfigKey, value: string): number | null {
  const field = key.slice('loop.'.length) as keyof LoopConfig;
  if (field === 'port' && (value === 'null' || value === 'auto')) return null;
  const n = /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN;
  const parsed = LoopConfigSchema.shape[field].safeParse(n);
  if (parsed.success) return parsed.data;
  throw new CliError('USAGE', `Invalid ${key}: ${JSON.stringify(value)}`, {
    fix:
      field === 'port'
        ? 'Use an integer from 0 to 65535, or "null" to derive one from the data dir.'
        : 'Use a positive integer.',
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
  /**
   * The EXACT rule strings still pending the last time an install explicitly
   * declined the free-verb allowlist (`--no-allow-free-verbs`, or "no" at the
   * interactive prompt), so `--refresh` can subtract them from what it would
   * otherwise report as pending instead of recomputing from the settings file
   * and nagging about a settled "no" on every refresh (tenjin-agent#234).
   *
   * A LIST, NOT A FLAG, on purpose: a boolean has no way to say "these were
   * declined" without also silencing every rule a LATER version might add, so a
   * genuinely new suggestion would never be reported again either. Per-rule
   * suppression means only the rules that were actually offered and refused
   * stay quiet; a new one still surfaces.
   *
   * Cleared back to `[]` the next time an install actually wires the allowlist,
   * or finds it already fully satisfied, so a later legitimate grant (manual or
   * otherwise) is never shadowed by a stale decline.
   */
  freeVerbsDeclined: z.array(z.string()),
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
  /**
   * The PUBLIC marketplace, consume-only, and the second shelf a team-mode
   * lookup falls through to. Distinct from `baseUrl` because in team mode
   * `baseUrl` is the team's own deployment: `publish`, `read` and the first leg
   * of every search go there, and this is the shelf that still gets asked when
   * the team's own has nothing. In public mode the two are the same origin and
   * nothing falls through.
   */
  publicShelfUrl: z.url(),
  /**
   * The team shelf's Vercel "Protection Bypass for Automation" secret, and the
   * ONE key that decides which mode this CLI is in: empty (the default) is
   * public mode, byte-for-byte what it always did; non-empty is team mode.
   *
   * It is a DOOR KEY, not a credential of the operator's: it gets a request past
   * Deployment Protection on the team's preview deployment and authenticates
   * nobody. Stored in plain config.json alongside everything else for exactly
   * that reason — anything that can read this file can already read the wallet's
   * keystore path and rewrite `baseUrl`. It is redacted from `config get` and
   * `config list` all the same, because those outputs are pasted into issues.
   *
   * Sent ONLY to `baseUrl`'s origin; see lib/http.ts's `bypass` option, which
   * derives that from the request URL rather than from the caller's intent.
   */
  shelfBypassSecret: z.string(),
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
  loop: LoopConfigSchema,
  team: TeamConfigSchema,
});
export type Config = z.infer<typeof ConfigSchema>;

/**
 * `install`'s raw shape, widened to still parse a `freeVerbsDeclined: true`
 * left by an earlier revision of this same key (before tenjin-agent#234's
 * rewrite from a suppress-everything boolean to a per-rule list): a stray
 * boolean must not fail config.json with CONFIG_INVALID. See
 * {@link resolveFreeVerbsDeclined} for how it is read back — treated the same
 * as absent either way, never as "these specific rules were declined", because
 * a boolean carries no per-rule information to recover.
 */
const RawInstallConfigSchema = InstallConfigSchema.partial()
  .extend({ freeVerbsDeclined: z.union([z.array(z.string()), z.boolean()]).optional() })
  .passthrough();

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
    install: RawInstallConfigSchema.optional(),
    hooks: HooksConfigSchema.partial().merge(LegacyHooksFields).passthrough().optional(),
    update: UpdateConfigSchema.partial().passthrough().optional(),
    loop: LoopConfigSchema.partial().passthrough().optional(),
    team: TeamConfigSchema.partial().passthrough().optional(),
  })
  .passthrough();
export type PartialConfig = z.infer<typeof RawConfigSchema>;

/**
 * Normalize `install.freeVerbsDeclined` as read from config.json: the current
 * shape (an array of exact declined rule strings) passes through as-is; the
 * boolean the key held before tenjin-agent#234, and an absent key, both read
 * back as "nothing specific is known to be declined" — `[]`. That is the safe
 * direction for the boolean: a stray `true` from before the rewrite silences
 * nothing, so at worst a settled decline is reported pending once more (the
 * exact bug this key exists to prevent, but the machine has already re-decided
 * this by installing the version that made the rewrite); it never silently
 * papers over a rule that this list should be naming.
 */
export function resolveFreeVerbsDeclined(value: string[] | boolean | undefined): string[] {
  return Array.isArray(value) ? value : [];
}

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
  publicShelfUrl: PRODUCTION_ORIGIN,
  // Empty = public mode. Setting it is the whole of "turn on team mode".
  shelfBypassSecret: '',
  rpcUrl: 'https://mainnet.base.org',
  evalCohort: false,
  bazaarPay: false,
  bazaarRegistries: DEFAULT_BAZAAR_REGISTRIES,
  publish: { mode: 'review', defaultPrice: '100000', ackServerWarnings: 'mode' },
  install: { harness: [], freeVerbsDeclined: [] },
  // `auto` is the default because the hook exists to be useful without being
  // asked for; the disclosure and the undo ride the install output, and `off`
  // leaves the installed script inert without touching settings.json. Both hooks
  // are `auto` by default and disjoint — no `inherit`. `push` and `capture`
  // default `off`: the push experiment (docs/command-reference.md#push-experimental) is opt-in only,
  // through `tenjin push on`.
  hooks: {
    webSearch: 'auto',
    agentDispatch: 'auto',
    stopNag: 'on',
    sessionPrimer: 'on',
    push: 'off',
    capture: 'off',
  },
  update: { mode: 'nudge' },
  loop: {
    human_wait_ms: 2500,
    tool_wait_ms: 4000,
    idle_exit_min: 30,
    port: null,
  },
  team: { publicFallback: 'on' },
};

/**
 * Scalar keys `config get/set/list` render one line each. The nested blocks are
 * excluded: `publish` and `hooks` are addressed by their dotted keys (see
 * PUBLISH_CONFIG_KEYS / HOOKS_CONFIG_KEYS), and `install` is a record `install`
 * writes about itself rather than a setting to hand-edit, so none is ever a bare
 * scalar.
 */
export type ScalarConfigKey = Exclude<
  keyof Config,
  'publish' | 'install' | 'hooks' | 'update' | 'loop' | 'team'
>;
const NESTED_CONFIG_KEYS: ReadonlySet<string> = new Set([
  'publish',
  'install',
  'hooks',
  'update',
  'loop',
  'team',
]);
export const CONFIG_KEYS = (Object.keys(CONFIG_DEFAULTS) as Array<keyof Config>).filter(
  (key): key is ScalarConfigKey => !NESTED_CONFIG_KEYS.has(key),
);

/** The dotted keys `config get/set` accept for the nested publish block. */
export const PUBLISH_CONFIG_KEYS = [
  'publish.mode',
  'publish.defaultPrice',
  'publish.ackServerWarnings',
] as const;
export type PublishConfigKey = (typeof PUBLISH_CONFIG_KEYS)[number];

/** The dotted keys `config get/set` accept for the nested hooks block. */
export const HOOKS_CONFIG_KEYS = [
  'hooks.webSearch',
  'hooks.agentDispatch',
  'hooks.stopNag',
  'hooks.sessionPrimer',
  'hooks.push',
  'hooks.capture',
] as const;
export type HooksConfigKey = (typeof HOOKS_CONFIG_KEYS)[number];

/** Legacy aliases still accepted on `config set/get` for one release. */
export const LEGACY_HOOKS_CONFIG_KEYS = ['hooks.searchMode', 'hooks.dispatchMode'] as const;
export type LegacyHooksConfigKey = (typeof LEGACY_HOOKS_CONFIG_KEYS)[number];

/** The dotted key `config get/set` accepts for the nested update block. */
export const UPDATE_CONFIG_KEYS = ['update.mode'] as const;
export type UpdateConfigKey = (typeof UPDATE_CONFIG_KEYS)[number];

/** The dotted keys `config get/set` accept for the loop daemon's block. */
export const LOOP_CONFIG_KEYS = [
  'loop.human_wait_ms',
  'loop.tool_wait_ms',
  'loop.idle_exit_min',
  'loop.port',
] as const;
export type LoopConfigKey = (typeof LOOP_CONFIG_KEYS)[number];

/** The dotted key `config get/set` accepts for the team block. */
export const TEAM_CONFIG_KEYS = ['team.publicFallback'] as const;
export type TeamConfigKey = (typeof TEAM_CONFIG_KEYS)[number];

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
  const rawHooks = raw.hooks as
    | {
        webSearch?: WebSearchMode;
        agentDispatch?: AgentDispatchMode;
        searchMode?: WebSearchMode;
        dispatchMode?: DispatchHookMode;
        stopNag?: StopNagMode;
        sessionPrimer?: SessionPrimerMode;
      }
    | undefined;
  // Backward compat: new webSearch wins, else legacy searchMode, else default.
  const resolvedWebSearch =
    rawHooks?.webSearch ?? rawHooks?.searchMode ?? CONFIG_DEFAULTS.hooks.webSearch;
  // Migration for agentDispatch: new key wins; else legacy dispatchMode (if not inherit) wins;
  // else if legacy is inherit or missing but webSearch resolved, copy webSearch; else default.
  // Since dispatch never shipped to npm (only searchMode did), the elaborate branch is only
  // for the unreleased `inherit` branch; the important legacy is searchMode -> webSearch.
  let resolvedAgentDispatch: AgentDispatchMode;
  if (rawHooks?.agentDispatch !== undefined) {
    resolvedAgentDispatch = rawHooks.agentDispatch;
  } else if (rawHooks?.dispatchMode !== undefined && rawHooks.dispatchMode !== 'inherit') {
    resolvedAgentDispatch = rawHooks.dispatchMode as AgentDispatchMode;
  } else if (rawHooks?.dispatchMode === 'inherit') {
    resolvedAgentDispatch = resolvedWebSearch;
  } else if (rawHooks?.dispatchMode === undefined && rawHooks?.searchMode !== undefined) {
    // Old file had only searchMode (dispatch inherited): preserve previous behavior for one release.
    resolvedAgentDispatch = resolvedWebSearch;
  } else if (
    rawHooks?.dispatchMode === undefined &&
    rawHooks?.webSearch !== undefined &&
    rawHooks?.agentDispatch === undefined
  ) {
    // New file with only webSearch set after the rename — keep disjoint: do NOT copy.
    resolvedAgentDispatch = CONFIG_DEFAULTS.hooks.agentDispatch;
  } else {
    resolvedAgentDispatch = CONFIG_DEFAULTS.hooks.agentDispatch;
  }
  // If the file had neither new nor legacy hooks at all, loadSettings' file-or-default
  // semantics would say `default` rather than `file` — but loadConfig's job is to produce
  // the effective Config object, so defaults are correct here regardless. The provenance
  // question lives in resolve* below.
  return {
    ...CONFIG_DEFAULTS,
    ...raw,
    publish: {
      mode: raw.publish?.mode ?? CONFIG_DEFAULTS.publish.mode,
      defaultPrice: raw.publish?.defaultPrice ?? CONFIG_DEFAULTS.publish.defaultPrice,
      ackServerWarnings:
        raw.publish?.ackServerWarnings ?? CONFIG_DEFAULTS.publish.ackServerWarnings,
    },
    install: {
      harness: raw.install?.harness ?? CONFIG_DEFAULTS.install.harness,
      freeVerbsDeclined: resolveFreeVerbsDeclined(raw.install?.freeVerbsDeclined),
    },
    hooks: {
      webSearch: resolvedWebSearch,
      agentDispatch: resolvedAgentDispatch,
      stopNag: rawHooks?.stopNag ?? CONFIG_DEFAULTS.hooks.stopNag,
      sessionPrimer: rawHooks?.sessionPrimer ?? CONFIG_DEFAULTS.hooks.sessionPrimer,
      push: raw.hooks?.push ?? CONFIG_DEFAULTS.hooks.push,
      capture: raw.hooks?.capture ?? CONFIG_DEFAULTS.hooks.capture,
    },
    update: { mode: raw.update?.mode ?? CONFIG_DEFAULTS.update.mode },
    loop: resolveLoopConfig(raw),
    team: { publicFallback: raw.team?.publicFallback ?? CONFIG_DEFAULTS.team.publicFallback },
  };
}

/** Per-subkey merge over the defaults; an unknown key a newer CLI wrote is
 *  dropped from the EFFECTIVE object (it still rides through persist). */
export function resolveLoopConfig(raw: PartialConfig): LoopConfig {
  const file = raw.loop ?? {};
  return {
    human_wait_ms: file.human_wait_ms ?? CONFIG_DEFAULTS.loop.human_wait_ms,
    tool_wait_ms: file.tool_wait_ms ?? CONFIG_DEFAULTS.loop.tool_wait_ms,
    idle_exit_min: file.idle_exit_min ?? CONFIG_DEFAULTS.loop.idle_exit_min,
    port: file.port === undefined ? CONFIG_DEFAULTS.loop.port : file.port,
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
  /** The file named `publish.ackServerWarnings`, which this layer never supplies. */
  ignoredAckServerWarnings?: boolean;
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
  publicShelfUrl: ResolvedSetting<string>;
  shelfBypassSecret: ResolvedSetting<string>;
  rpcUrl: ResolvedSetting<string>;
  evalCohort: ResolvedSetting<boolean>;
  bazaarPay: ResolvedSetting<boolean>;
  bazaarRegistries: ResolvedSetting<string[]>;
  publishMode: PublishModeResolution;
  publishDefaultPrice: ResolvedSetting<string>;
  publishAckServerWarnings: ResolvedSetting<AckServerWarnings>;
  hooksWebSearch: ResolvedSetting<WebSearchMode>;
  hooksAgentDispatch: ResolvedSetting<AgentDispatchMode>;
  hooksStopNag: ResolvedSetting<StopNagMode>;
  hooksSessionPrimer: ResolvedSetting<SessionPrimerMode>;
  hooksPush: ResolvedSetting<PushMode>;
  hooksCapture: ResolvedSetting<CaptureMode>;
  updateMode: ResolvedSetting<UpdateMode>;
  loop: { [K in keyof LoopConfig]: ResolvedSetting<LoopConfig[K]> };
  teamPublicFallback: ResolvedSetting<PublicFallback>;
  /** @deprecated use hooksWebSearch — kept for backward compat */
  hooksSearchMode: ResolvedSetting<WebSearchMode>;
  /** @deprecated use hooksAgentDispatch — kept for backward compat (never `inherit`) */
  hooksDispatchMode: ResolvedSetting<AgentDispatchMode>;
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
  const webSearch = resolveHooksWebSearch(config);
  const agentDispatch = resolveHooksAgentDispatch(config);
  return {
    maxAutoSpend: fileOrDefault('maxAutoSpend', config),
    sessionBudget: fileOrDefault('sessionBudget', config),
    confirm: fileOrDefault('confirm', config),
    sendMaxAmount: resolveSendMaxAmount(config),
    allowlistCreators: fileOrDefault('allowlistCreators', config),
    baseUrl: resolveBaseUrl(config, flags, env),
    publicShelfUrl: fileOrDefault('publicShelfUrl', config),
    shelfBypassSecret: fileOrDefault('shelfBypassSecret', config),
    rpcUrl: fileOrDefault('rpcUrl', config),
    evalCohort: fileOrDefault('evalCohort', config),
    bazaarPay: fileOrDefault('bazaarPay', config),
    bazaarRegistries: fileOrDefault('bazaarRegistries', config),
    publishMode: resolvePublishMode({ config, project, env }),
    publishDefaultPrice: resolvePublishDefaultPrice({ config, project }),
    publishAckServerWarnings: resolveAckServerWarnings(config),
    hooksWebSearch: webSearch,
    hooksAgentDispatch: agentDispatch,
    hooksSearchMode: webSearch,
    hooksDispatchMode: agentDispatch,
    hooksStopNag: resolveHooksStopNag(config),
    hooksSessionPrimer: resolveHooksSessionPrimer(config),
    hooksPush: resolveHooksPush(config),
    hooksCapture: resolveHooksCapture(config),
    updateMode: resolveUpdateMode(config),
    loop: resolveLoopSettings(config),
    teamPublicFallback: resolveTeamPublicFallback(config),
  };
}

function resolveLoopSettings(config: PartialConfig): EffectiveSettings['loop'] {
  const file = config.loop ?? {};
  const one = <K extends keyof LoopConfig>(key: K): ResolvedSetting<LoopConfig[K]> => {
    const fromFile = file[key];
    if (fromFile !== undefined) return { value: fromFile as LoopConfig[K], source: 'file' };
    return { value: CONFIG_DEFAULTS.loop[key], source: 'default' };
  };
  return {
    human_wait_ms: one('human_wait_ms'),
    tool_wait_ms: one('tool_wait_ms'),
    idle_exit_min: one('idle_exit_min'),
    port: one('port'),
  };
}

/** team.publicFallback: file or default, no env or flag. */
export function resolveTeamPublicFallback(config: PartialConfig): ResolvedSetting<PublicFallback> {
  const fromFile = config.team?.publicFallback;
  if (fromFile !== undefined) return { value: fromFile, source: 'file' };
  return { value: CONFIG_DEFAULTS.team.publicFallback, source: 'default' };
}

/**
 * publish.ackServerWarnings: the GLOBAL config file or the default, deliberately
 * with no project `.tenjin.json` layer and no env override. The other two publish
 * keys take the project layer because a repo may reasonably state its own price
 * and its own mode; this one only ever LOOSENS what a yes covers, so a file
 * checked into a repo the operator cloned must not be able to set it. That is the
 * same reason `resolvePublishMode` gates `full-auto` out of the project layer,
 * applied one step earlier: here there is no benign reading of the key at all.
 *
 * Exported because `resolvePublishSettings` (lib/settings.ts) resolves the same
 * key for the two writing commands, and two global-only readings that disagreed
 * would disagree about consent.
 */
export function resolveAckServerWarnings(
  config: PartialConfig,
): ResolvedSetting<AckServerWarnings> {
  const fromFile = config.publish?.ackServerWarnings;
  if (fromFile !== undefined) return { value: fromFile, source: 'file' };
  return { value: CONFIG_DEFAULTS.publish.ackServerWarnings, source: 'default' };
}

/** update.mode: file or default, no env or flag. Every surface that reports a
 *  newer version reads this one resolved value, so they cannot disagree. */
function resolveUpdateMode(config: PartialConfig): ResolvedSetting<UpdateMode> {
  const fromFile = config.update?.mode;
  if (fromFile !== undefined) return { value: fromFile, source: 'file' };
  return { value: CONFIG_DEFAULTS.update.mode, source: 'default' };
}

/** hooks.webSearch: file or default. Legacy `hooks.searchMode` counts as `file`. */
export function resolveHooksWebSearch(config: PartialConfig): ResolvedSetting<WebSearchMode> {
  const hooks = config.hooks as
    { webSearch?: WebSearchMode; searchMode?: WebSearchMode } | undefined;
  if (hooks?.webSearch !== undefined) return { value: hooks.webSearch, source: 'file' };
  if (hooks?.searchMode !== undefined) return { value: hooks.searchMode, source: 'file' };
  return { value: CONFIG_DEFAULTS.hooks.webSearch, source: 'default' };
}

/** @deprecated use resolveHooksWebSearch */
export function resolveHooksSearchMode(config: PartialConfig): ResolvedSetting<WebSearchMode> {
  return resolveHooksWebSearch(config);
}

/** hooks.agentDispatch: file or default, disjoint from webSearch. Legacy `dispatchMode` (including `inherit`) honoured on read. */
export function resolveHooksAgentDispatch(
  config: PartialConfig,
): ResolvedSetting<AgentDispatchMode> {
  const hooks = config.hooks as
    | {
        agentDispatch?: AgentDispatchMode;
        dispatchMode?: DispatchHookMode;
        webSearch?: WebSearchMode;
        searchMode?: WebSearchMode;
      }
    | undefined;
  if (hooks?.agentDispatch !== undefined) return { value: hooks.agentDispatch, source: 'file' };
  const legacy = hooks?.dispatchMode;
  if (legacy !== undefined && legacy !== 'inherit') {
    return { value: legacy as AgentDispatchMode, source: 'file' };
  }
  if (legacy === 'inherit') {
    const webSearch = hooks?.webSearch ?? hooks?.searchMode ?? CONFIG_DEFAULTS.hooks.webSearch;
    return { value: webSearch as AgentDispatchMode, source: 'file' };
  }
  // File had only legacy searchMode (dispatch inherited implicitly) — preserve prior behaviour for one release.
  if (
    hooks?.searchMode !== undefined &&
    hooks?.dispatchMode === undefined &&
    hooks?.agentDispatch === undefined
  ) {
    const webSearch = hooks.webSearch ?? hooks.searchMode ?? CONFIG_DEFAULTS.hooks.webSearch;
    return { value: webSearch as AgentDispatchMode, source: 'file' };
  }
  return { value: CONFIG_DEFAULTS.hooks.agentDispatch, source: 'default' };
}

/** @deprecated use resolveHooksAgentDispatch — `inherit` never surfaces; value is already resolved */
export function resolveHooksDispatchMode(
  config: PartialConfig,
): ResolvedSetting<AgentDispatchMode> {
  return resolveHooksAgentDispatch(config);
}

/** hooks.sessionPrimer: file or default, same shape as hooks.webSearch. */
function resolveHooksSessionPrimer(config: PartialConfig): ResolvedSetting<SessionPrimerMode> {
  const fromFile = (config.hooks as { sessionPrimer?: SessionPrimerMode } | undefined)
    ?.sessionPrimer;
  if (fromFile !== undefined) return { value: fromFile, source: 'file' };
  return { value: CONFIG_DEFAULTS.hooks.sessionPrimer, source: 'default' };
}

/** hooks.stopNag: file or default, same shape as hooks.webSearch. */
function resolveHooksStopNag(config: PartialConfig): ResolvedSetting<StopNagMode> {
  const fromFile = (config.hooks as { stopNag?: StopNagMode } | undefined)?.stopNag;
  if (fromFile !== undefined) return { value: fromFile, source: 'file' };
  return { value: CONFIG_DEFAULTS.hooks.stopNag, source: 'default' };
}

/** hooks.push: file or default, same shape as hooks.webSearch — read at run time
 *  by every push arm, so a set takes effect with no re-install. */
function resolveHooksPush(config: PartialConfig): ResolvedSetting<PushMode> {
  const fromFile = config.hooks?.push;
  if (fromFile !== undefined) return { value: fromFile, source: 'file' };
  return { value: CONFIG_DEFAULTS.hooks.push, source: 'default' };
}

/** hooks.capture: file or default, same shape as hooks.webSearch. */
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

/**
 * Persist a full, validated config via the atomic writer (0700 dir, 0600 file).
 *
 * 0600 BECAUSE config.json NOW HOLDS A CREDENTIAL: `shelfBypassSecret` is the
 * team shelf's shared door key, and every other secret in this tree is 0600
 * (the wallet, the passphrase, the session key, the spend ledger, the generated
 * hook scripts) — wallet/local.ts even warns when it finds one that is not.
 * `dirMode: 0o700` is not a substitute: node's recursive mkdir does not chmod a
 * directory that already exists, so a `~/.tenjin` or `TENJIN_DATA_DIR` created
 * at 0755 by a devcontainer volume, a restored backup or a shared CI image left
 * the key world-readable. `config --json` already redacts it, which is the same
 * care applied one layer up. Keep this in step with `persist` in commands/config.ts,
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
