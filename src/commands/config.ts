import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { styleText } from 'node:util';
import { CliError } from '../lib/errors';
import { confirmChoice } from '../lib/clack';
import {
  inspectFreeVerbRules,
  MODE_GATED_RULES,
  retractModeGatedRules,
  wireFreeVerbAllowlist,
  type PermissionsResult,
} from '../lib/harness-permissions';
import { modeGatedPointer } from '../lib/permissions';
import { stopHookIsCurrent } from '../lib/harness-hooks';
import { resolveHermesHomeLenient } from '../lib/hermes';
import {
  CONFIG_KEYS,
  HOOKS_CONFIG_KEYS,
  PUBLISH_CONFIG_KEYS,
  PublishModeSchema,
  RawConfigSchema,
  SEND_MAX_UNSET,
  UPDATE_CONFIG_KEYS,
  loadRawConfig,
  parseSearchHookModeFlag,
  parseSessionPrimerFlag,
  parseStopNagFlag,
  parseUpdateModeFlag,
  resolveSettings,
} from '../lib/config';
import type {
  EffectiveSettings,
  HooksConfigKey,
  PartialConfig,
  Provenance,
  PublishConfigKey,
  PublishMode,
  ScalarConfigKey,
  SearchHookMode,
  UpdateConfigKey,
} from '../lib/config';
import {
  detectHarnesses,
  harnessInPlay,
  harnessTargetDir,
  onPath,
  type HarnessTarget,
} from '../lib/skill-wiring';
import { loadProjectConfig } from '../lib/settings';
import { configPath } from '../lib/paths';
import { writeFileAtomic } from '../lib/atomic-json';
import { withFileLock, LockTimeoutError } from '../lib/lock';
import { parseUsdToAtomic, toMoney } from '../lib/money';
import type { Money } from '../schemas';
import type { CommandContext, CommandResult } from '../context';

/**
 * How one config key is presented in `data`. `value` is the machine form: dual
 * Money for the spend keys, the stored string for `confirm`/URLs, the string[]
 * for the allowlist. `threshold` rides along only for `confirm: above:<atomic>`
 * so an agent reads the dollar amount without re-parsing the string.
 */
interface RenderedValue {
  value: Money | string | string[] | boolean;
  threshold?: Money;
}
interface RenderedSetting extends RenderedValue {
  source: Provenance;
}

/**
 * Seams for the one `config set` path that touches a file outside the data dir.
 * Tests inject all of them; nothing here is reachable from a flag.
 */
export interface ConfigSetDeps {
  /** Home whose `.claude/settings.json` is synced; defaults to os.homedir(). */
  homeDir?: string;
  /** Overrides TTY detection, exactly as install's own seam does. */
  isInteractive?: boolean;
  /** The yes/no for a loosening write; defaults to the clack confirm (default yes). */
  confirmRule?: (label: string) => Promise<boolean>;
  /** Whether this machine's harness is Claude Code (the only settings file we write).
   *  Absent, it is DETECTED the way install and doctor detect it. */
  harnessIsClaude?: boolean;
  /** The retraction-only pass `review` runs; defaults to the real writer. */
  retractModeGated?: (home: string) => Promise<PermissionsResult>;
  /** Whether the installed Stop hook matches this build; defaults to reading it. */
  stopHookIsCurrent?: (dataDir: string) => Promise<boolean>;
  /** PATH probe for harness detection; defaults to probing `env.PATH`. */
  which?: (bin: string) => boolean;
  /** Environment for that probe; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  inspectAllowlist?: typeof inspectFreeVerbRules;
  wireAllowlist?: (home: string, mode: PublishMode) => Promise<PermissionsResult>;
}

const CONFIRM_ABOVE = 'above:';
const KEY_WIDTH = Math.max(
  ...[...CONFIG_KEYS, ...PUBLISH_CONFIG_KEYS, ...HOOKS_CONFIG_KEYS, ...UPDATE_CONFIG_KEYS].map(
    (key) => key.length,
  ),
);

/**
 * A one-line human description per key, appended (dim) to the bare `config`
 * listing only. Machine `data` is unchanged; these are humanLines decoration.
 */
const KEY_DESCRIPTIONS: Record<string, string> = {
  maxAutoSpend: 'auto-approve a read up to this amount',
  sessionBudget: 'cap on total auto-spend per session',
  confirm: 'when to ask before paying',
  sendMaxAmount:
    'hard cap per tenjin send; unset = send refuses until set, 0 disables send, none = uncapped; never bypassed by --yes',
  allowlistCreators: 'only auto-pay these creators (empty = any)',
  baseUrl: 'Tenjin API base URL',
  rpcUrl: 'Base RPC endpoint for balance reads',
  evalCohort: 'opt in to the search evaluation cohort',
  'publish.mode': 'review=always ask, auto=ask on findings, full-auto=only hard blocks stop it',
  'publish.defaultPrice': 'price used when none is given',
  'hooks.searchMode':
    'harness WebSearch hook: auto=ask Tenjin first, remind=static reminder, off=inert',
  'hooks.stopNag':
    'end-of-turn reminder about searches nothing answered yet: on=both arms, deliberate-only=drop the batched web-search arm, off=neither',
  'hooks.sessionPrimer':
    'one-paragraph search-first primer at session start: on=print it, off=print nothing',
  'update.mode':
    'nudge=report a newer version (stderr line, JSON envelope, hook output), off=neither report nor ask npm',
};

function isPublishKey(key: string): key is PublishConfigKey {
  return (PUBLISH_CONFIG_KEYS as readonly string[]).includes(key);
}

function isHooksKey(key: string): key is HooksConfigKey {
  return (HOOKS_CONFIG_KEYS as readonly string[]).includes(key);
}

function isUpdateKey(key: string): key is UpdateConfigKey {
  return (UPDATE_CONFIG_KEYS as readonly string[]).includes(key);
}

/**
 * Show every effective key with its value and provenance. `data` is keyed by
 * config key; provenance comes from resolveSettings over the *raw* file (not the
 * defaults-merged config), so a key the user never set reads `default`, not
 * `file`.
 */
export async function runConfigList(ctx: CommandContext): Promise<CommandResult> {
  const settings = await resolveFromContext(ctx);
  const data: Record<string, RenderedSetting> = {};
  const humanLines: string[] = [];
  for (const key of CONFIG_KEYS) {
    const entry = renderSetting(key, settings[key].value, settings[key].source);
    data[key] = entry;
    humanLines.push(describedLine(key, entry));
  }
  for (const key of PUBLISH_CONFIG_KEYS) {
    const entry = renderPublishSetting(key, settings);
    data[key] = entry;
    humanLines.push(describedLine(key, entry, downgradeNote(key, settings)));
  }
  for (const key of HOOKS_CONFIG_KEYS) {
    const entry = renderHooksSetting(key, settings);
    data[key] = entry;
    humanLines.push(describedLine(key, entry));
  }
  for (const key of UPDATE_CONFIG_KEYS) {
    const entry: RenderedSetting = {
      value: settings.updateMode.value,
      source: settings.updateMode.source,
    };
    data[key] = entry;
    humanLines.push(describedLine(key, entry));
  }
  return { data, humanLines };
}

/** Same per-key shape as list, for one key. Unknown key is a USAGE failure. */
export async function runConfigGet(
  { key }: { key: string },
  ctx: CommandContext,
): Promise<CommandResult> {
  if (isPublishKey(key)) {
    const settings = await resolveFromContext(ctx);
    const entry = renderPublishSetting(key, settings);
    return {
      data: { key, ...entry },
      humanLines: [withNote(formatLine(key, entry), downgradeNote(key, settings))],
    };
  }
  if (isHooksKey(key)) {
    const entry = renderHooksSetting(key, await resolveFromContext(ctx));
    return { data: { key, ...entry }, humanLines: [formatLine(key, entry)] };
  }
  if (isUpdateKey(key)) {
    const { updateMode } = await resolveFromContext(ctx);
    const entry: RenderedSetting = { value: updateMode.value, source: updateMode.source };
    return { data: { key, ...entry }, humanLines: [formatLine(key, entry)] };
  }
  const configKey = assertKey(key);
  const settings = await resolveFromContext(ctx);
  const entry = renderSetting(configKey, settings[configKey].value, settings[configKey].source);
  return { data: { key: configKey, ...entry }, humanLines: [formatLine(configKey, entry)] };
}

/**
 * Parse the value for this key, then persist it merged into the existing raw
 * file — never materializing defaults for keys the user did not set, so
 * provenance stays truthful. The written key now reads `file`.
 */
export async function runConfigSet(
  { key, value }: { key: string; value: string },
  ctx: CommandContext,
  deps: ConfigSetDeps = {},
): Promise<CommandResult> {
  if (isPublishKey(key)) return setPublishKey(key, value, ctx, deps);
  if (isHooksKey(key)) return setHooksKey(key, value, ctx, deps);
  if (isUpdateKey(key)) return setUpdateKey(key, value, ctx);
  const configKey = assertKey(key);
  const stored = parseValue(configKey, value);
  await persist(ctx.dataDir, (existing) => ({ ...existing, [configKey]: stored }));
  const entry = renderSetting(configKey, stored, 'file');
  return { data: { key: configKey, ...entry }, humanLines: [formatLine(configKey, entry)] };
}

/**
 * `config set publish.mode|publish.defaultPrice`. mode validates to the enum;
 * defaultPrice parses decimal USD at the edge into atomic (matching the spend
 * keys). The subkey is merged into the nested publish block, so a sibling subkey
 * (or an unknown one a newer CLI wrote) is preserved.
 */
async function setPublishKey(
  key: PublishConfigKey,
  value: string,
  ctx: CommandContext,
  deps: ConfigSetDeps,
): Promise<CommandResult> {
  const entry: RenderedSetting =
    key === 'publish.mode'
      ? { value: parsePublishMode(value), source: 'file' }
      : { value: toMoney(parseUsdToAtomic(value)), source: 'file' };
  const subkey = key === 'publish.mode' ? 'mode' : 'defaultPrice';
  const stored = key === 'publish.mode' ? (entry.value as string) : (entry.value as Money).atomic;
  await persist(ctx.dataDir, (existing) => ({
    ...existing,
    publish: { ...existing.publish, [subkey]: stored },
  }));
  const humanLines = [formatLine(key, entry)];
  if (key !== 'publish.mode') return { data: { key, ...entry }, humanLines };

  // The mode decides whether a publish asks; the harness rule decides whether the
  // harness asks ANYWAY. Settling one and leaving the other to the next `tenjin
  // install` is the seam that made publish.mode look broken (tenjin-agent #161),
  // so the two move together from here too.
  const allowlist = await syncPublishRule(entry.value as PublishMode, ctx, deps);
  return {
    data: { key, ...entry, allowlist },
    humanLines: [...humanLines, ...allowlistLines(allowlist)],
  };
}

/**
 * What `config set publish.mode` did about the harness rule the mode carries.
 * `skipped` names why nothing was written; `pointer` is the line to show when it
 * is the operator's move.
 */
interface AllowlistSync {
  added: string[];
  removed: string[];
  skipped?: 'not-claude' | 'no-tty' | 'declined' | 'unwritable';
  pointer?: string;
}

/** Names what the write actually carries: on a machine that never ran `install`,
 *  the free tier is pending too, and a question naming two lines while eleven
 *  land is asking about something else. */
function publishRuleQuestion(mode: PublishMode, pending: readonly string[]): string {
  const gated = new Set<string>(MODE_GATED_RULES);
  const others = pending.filter((rule) => !gated.has(rule)).length;
  const also =
    others > 0 ? ` Also adds the ${others} free-verb rule(s) \`tenjin install\` writes.` : '';
  return (
    `publish.mode ${mode} is unattended only if your harness allowlist carries ` +
    `${MODE_GATED_RULES.join(' and ')}. Add them to ~/.claude/settings.json now?${also}`
  );
}

/**
 * Keep the harness allowlist in step with the mode just written.
 *
 * ASYMMETRIC ON PURPOSE, and the asymmetry is the consent rule:
 *  - Loosening (auto/full-auto) ADDS a grant, so it needs a human in the loop.
 *    No TTY, `--json`, or a declined prompt all leave the file alone and return
 *    the pointer instead; nothing here writes on silence.
 *  - Tightening (review) only ever REMOVES a rule this CLI wrote under a setting
 *    the operator has just changed, so it runs unconditionally — the same reason
 *    install sweeps a retired rule without asking. Leaving it behind would keep
 *    publishing pre-cleared after the operator said "ask me first", which is the
 *    failure that matters.
 */
async function syncPublishRule(
  mode: PublishMode,
  ctx: CommandContext,
  deps: ConfigSetDeps,
): Promise<AllowlistSync> {
  const home = deps.homeDir ?? homedir();
  const nothing: AllowlistSync = { added: [], removed: [] };

  const write = async (): Promise<AllowlistSync> => {
    const result = await (deps.wireAllowlist ?? wireFreeVerbAllowlist)(home, mode);
    if (result.skipped !== undefined) {
      return {
        added: [],
        removed: [],
        skipped: 'unwritable',
        ...(result.fix !== undefined ? { pointer: result.fix } : {}),
      };
    }
    return { added: result.added, removed: result.removed };
  };

  // Only Claude Code has a settings file of this shape; guessing at another
  // harness's config is the uninvited write lib/harness-permissions.ts avoids.
  // DETECTED, never assumed: a codex-only machine has a ~/.claude/settings.json
  // that nothing reads, so prompting about it is noise and writing to it is an
  // uninvited edit — and the retraction would sweep a file we never owned.
  const isClaude = deps.harnessIsClaude ?? (await claudeInPlay(home, ctx, deps));
  if (!isClaude) {
    // No settings file of ours to be missing anything, so the pointer would be
    // advice about a machine this is not.
    return { ...nothing, skipped: 'not-claude' };
  }

  const probe = await (deps.inspectAllowlist ?? inspectFreeVerbRules)(home, mode);
  const gated = new Set<string>(MODE_GATED_RULES);
  const missing = (probe.pending ?? []).filter((r) => gated.has(r));
  // Only ever names rules this machine does not have. A pointer built from the
  // mode alone told a fully-wired operator to go add what they already had.
  const pointer = modeGatedPointer(mode, missing) ?? undefined;

  // Tightening runs with no question and with no precondition, through a pass
  // that can only ever REMOVE. Riding the additive writer made this decline
  // whenever the free tier was not byte-exact — silently, and in the tightening
  // direction, on the undo the operator just typed.
  if (mode === 'review') {
    const retracted = await (deps.retractModeGated ?? retractModeGatedRules)(home);
    if (retracted.skipped !== undefined) {
      return {
        ...nothing,
        skipped: 'unwritable',
        ...(retracted.fix !== undefined ? { pointer: retracted.fix } : {}),
      };
    }
    return { added: [], removed: retracted.removed };
  }

  // SATISFIED BEFORE TTY, and the order is the point: a fully-wired machine has
  // nothing to ask about and nothing to write, so a `--json` or headless run
  // there is a no-op rather than a `no-tty` skip carrying a pointer at rules it
  // already has.
  if (probe.satisfied !== undefined) return nothing;

  const canPrompt =
    ctx.flags.json === true ? false : (deps.isInteractive ?? Boolean(process.stdin.isTTY));
  if (!canPrompt) return { ...nothing, skipped: 'no-tty', ...(pointer ? { pointer } : {}) };

  const confirm = deps.confirmRule ?? ((label: string) => confirmChoice(label, true));
  if (!(await confirm(publishRuleQuestion(mode, probe.pending ?? [])))) {
    return { ...nothing, skipped: 'declined', ...(pointer ? { pointer } : {}) };
  }
  return write();
}

/** Claude Code's business? The union install and doctor target with: detected on
 *  PATH or by its home directory, or named by a past `--harness`, which outranks
 *  the probes. */
async function claudeInPlay(
  home: string,
  ctx: CommandContext,
  deps: ConfigSetDeps,
): Promise<boolean> {
  const env = deps.env ?? process.env;
  const which = deps.which ?? ((bin: string) => onPath(bin, env));
  const requested = await loadRawConfig(ctx.dataDir)
    .then((c) => c.install?.harness ?? [])
    .catch(() => [] as HarnessTarget[]);
  const hermesHome = resolveHermesHomeLenient(home, env).home;
  return harnessInPlay(
    home,
    harnessTargetDir(home, 'claude', hermesHome),
    detectHarnesses(home, which, hermesHome),
    requested,
    hermesHome,
  );
}

/** The human rendering of {@link syncPublishRule}, or nothing when it was a no-op. */
function allowlistLines(sync: AllowlistSync): string[] {
  const lines: string[] = [];
  if (sync.added.length > 0) {
    lines.push(`Added ${sync.added.length} harness rule(s) to your allowlist.`);
  }
  if (sync.removed.length > 0) {
    lines.push(`Removed ${sync.removed.join(', ')} from your allowlist.`);
  }
  if (sync.pointer !== undefined) lines.push(sync.pointer);
  return lines;
}

/**
 * `config set hooks.searchMode`. Merged into the nested hooks block through the
 * same locked read-modify-write every other set uses, so a subkey a newer CLI
 * wrote survives. The installed script reads this file on every run, so a value
 * that script UNDERSTANDS takes effect immediately with no re-install — which is
 * every value it shipped knowing about, and not `deliberate-only` on a script
 * written before that existed. That one case is reported, once, below.
 */
async function setHooksKey(
  key: HooksConfigKey,
  value: string,
  ctx: CommandContext,
  deps: ConfigSetDeps,
): Promise<CommandResult> {
  const subkey =
    key === 'hooks.searchMode'
      ? 'searchMode'
      : key === 'hooks.stopNag'
        ? 'stopNag'
        : 'sessionPrimer';
  const parsed =
    key === 'hooks.searchMode'
      ? parseSearchHookModeFlag(value, key)
      : key === 'hooks.stopNag'
        ? parseStopNagFlag(value, key)
        : parseSessionPrimerFlag(value, key);
  await persist(ctx.dataDir, (existing) => ({
    ...existing,
    hooks: { ...existing.hooks, [subkey]: parsed },
  }));
  const entry: RenderedSetting = { value: parsed, source: 'file' };
  // ONE honest line, not a nag loop: the value is stored either way, and the
  // operator is told the running script predates it rather than left believing a
  // setting took that did not.
  const current = await (deps.stopHookIsCurrent ?? stopHookIsCurrent)(ctx.dataDir);
  const stale =
    parsed === 'deliberate-only' && !current
      ? `The installed Stop hook predates ${JSON.stringify(parsed)} and will keep treating it as "on". Run \`tenjin install\` to update it.`
      : undefined;
  return {
    data: { key, ...entry, ...(stale !== undefined ? { hookScriptStale: true } : {}) },
    humanLines: [formatLine(key, entry), ...(stale !== undefined ? [stale] : [])],
  };
}

/**
 * `config set update.mode`. Same locked merge-write as every other set, so the
 * next command reports (or stops reporting) under the new mode immediately,
 * with nothing to re-install and no process to restart.
 */
async function setUpdateKey(
  key: UpdateConfigKey,
  value: string,
  ctx: CommandContext,
): Promise<CommandResult> {
  const parsed = parseUpdateModeFlag(value, key);
  await persist(ctx.dataDir, (existing) => ({
    ...existing,
    update: { ...existing.update, mode: parsed },
  }));
  const entry: RenderedSetting = { value: parsed, source: 'file' };
  return { data: { key, ...entry }, humanLines: [formatLine(key, entry)] };
}

function parsePublishMode(value: string): string {
  const parsed = PublishModeSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new CliError('USAGE', `Invalid publish mode: ${JSON.stringify(value)}`, {
    fix: 'Use "review", "auto", or "full-auto".',
  });
}

/**
 * Persist just `publish.mode` into the global config through the same locked
 * merge-write every `config set` uses (never a raw overwrite), so a sibling
 * subkey or an unknown block a newer CLI wrote is preserved. Used by `install`'s
 * setup prompt; the mode is a validated PublishMode.
 */
export async function persistPublishMode(dir: string, mode: PublishMode): Promise<void> {
  await persist(dir, (existing) => ({
    ...existing,
    publish: { ...existing.publish, mode },
  }));
}

/**
 * Persist `hooks.searchMode` through the same locked merge-write, for `install`'s
 * hook decision. The mode is already a validated SearchHookMode.
 */
export async function persistSearchHookMode(dir: string, mode: SearchHookMode): Promise<void> {
  await persist(dir, (existing) => ({
    ...existing,
    hooks: { ...existing.hooks, searchMode: mode },
  }));
}

/**
 * Record the explicit `--harness` set `install` was given, through the same locked
 * merge-write. It REPLACES the previous record rather than unioning with it: the last
 * explicit request is the current intent, and re-running install with the right flag
 * is then the way out of a mistaken one. Detected harnesses are never recorded — they
 * are re-probed on every `doctor` — so this file holds only what detection cannot see.
 */
export async function persistInstallHarness(
  dir: string,
  harness: readonly HarnessTarget[],
): Promise<void> {
  await persist(dir, (existing) => ({
    ...existing,
    install: { ...existing.install, harness: [...harness] },
  }));
}

async function resolveFromContext(ctx: CommandContext): Promise<EffectiveSettings> {
  const config = await loadRawConfig(ctx.dataDir);
  // Feed the per-project `.tenjin.json` layer so the publish keys read out what a
  // real `publish` would resolve (project/env included), not a global-only guess.
  const project = await loadProjectConfig(process.cwd());
  return resolveSettings({
    config,
    flags: { baseUrl: ctx.flags.baseUrl },
    env: process.env,
    project: project?.layer,
  });
}

function assertKey(key: string): ScalarConfigKey {
  if ((CONFIG_KEYS as string[]).includes(key)) return key as ScalarConfigKey;
  throw new CliError('USAGE', `Unknown config key: ${JSON.stringify(key)}`, {
    fix: `Valid keys: ${[...CONFIG_KEYS, ...PUBLISH_CONFIG_KEYS, ...HOOKS_CONFIG_KEYS].join(', ')}.`,
  });
}

function renderSetting(
  key: ScalarConfigKey,
  stored: string | string[] | boolean,
  source: Provenance,
): RenderedSetting {
  return { ...renderValue(key, stored), source };
}

/**
 * The list/get shape for a publish key, read from the resolved effective
 * settings, which now include the per-project `.tenjin.json` layer (see
 * resolveFromContext) so the source reflects what a publish would actually use.
 */
function renderPublishSetting(key: PublishConfigKey, settings: EffectiveSettings): RenderedSetting {
  if (key === 'publish.mode') {
    return { value: settings.publishMode.value, source: settings.publishMode.source };
  }
  return {
    value: toMoney(settings.publishDefaultPrice.value),
    source: settings.publishDefaultPrice.source,
  };
}

/** The list/get shape for a hooks key: a plain enum string whichever it is. */
function renderHooksSetting(key: HooksConfigKey, settings: EffectiveSettings): RenderedSetting {
  const resolved =
    key === 'hooks.searchMode'
      ? settings.hooksSearchMode
      : key === 'hooks.stopNag'
        ? settings.hooksStopNag
        : settings.hooksSessionPrimer;
  return { value: resolved.value, source: resolved.source };
}

function renderValue(key: ScalarConfigKey, stored: string | string[] | boolean): RenderedValue {
  if (Array.isArray(stored) || typeof stored === 'boolean') return { value: stored };
  if (key === 'maxAutoSpend' || key === 'sessionBudget') return { value: toMoney(stored) };
  if (key === 'sendMaxAmount') {
    // 'unset' is the resolved sentinel for an absent key (send refuses), never
    // a stored value; 'none' is the explicit uncapped opt-in.
    return { value: stored === 'none' || stored === SEND_MAX_UNSET ? stored : toMoney(stored) };
  }
  if (key === 'confirm' && stored.startsWith(CONFIRM_ABOVE)) {
    return { value: stored, threshold: toMoney(stored.slice(CONFIRM_ABOVE.length)) };
  }
  return { value: stored };
}

/** Per-key edge parsing. Returns the persisted form; throws USAGE on bad input. */
function parseValue(key: ScalarConfigKey, value: string): string | string[] | boolean {
  switch (key) {
    case 'maxAutoSpend':
    case 'sessionBudget':
      return parseUsdToAtomic(value); // throws USAGE on a bad amount
    case 'sendMaxAmount':
      return value === 'none' ? 'none' : parseUsdToAtomic(value);
    case 'confirm':
      return parseConfirm(value);
    case 'allowlistCreators':
      return parseAllowlist(value);
    case 'baseUrl':
    case 'rpcUrl':
      return parseHttpUrl(value);
    case 'evalCohort':
      return parseBoolean(value);
  }
}

function parseBoolean(value: string): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new CliError('USAGE', `Invalid boolean value: ${JSON.stringify(value)}`, {
    fix: 'Use "true" or "false".',
  });
}

function parseConfirm(value: string): string {
  if (value === 'always') return 'always';
  if (value.startsWith(CONFIRM_ABOVE)) {
    return `${CONFIRM_ABOVE}${parseUsdToAtomic(value.slice(CONFIRM_ABOVE.length))}`;
  }
  throw new CliError('USAGE', `Invalid confirm value: ${JSON.stringify(value)}`, {
    fix: 'Use "always" or "above:<usd>", e.g. above:0.25.',
  });
}

function parseAllowlist(value: string): string[] {
  // "" clears to []; comma-split, trim, drop empties. Reject an entry with
  // internal whitespace — a creator handle/address is a single token.
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  for (const entry of entries) {
    if (/\s/.test(entry)) {
      throw new CliError('USAGE', `Invalid creator entry: ${JSON.stringify(entry)}`, {
        fix: 'Creator entries cannot contain spaces; separate multiple with commas.',
      });
    }
  }
  return entries;
}

function parseHttpUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliError('USAGE', `Invalid URL: ${JSON.stringify(value)}`, {
      fix: 'Pass an absolute http(s) URL like https://tenjin.blog.',
    });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new CliError('USAGE', `URL must be http or https: ${JSON.stringify(value)}`, {
      fix: 'Pass an absolute http(s) URL like https://tenjin.blog.',
    });
  }
  return value;
}

/**
 * Apply `merge` to the raw file and write it back atomically. Uses the partial
 * schema and writeFileAtomic (not writeConfig, which would materialize every
 * default into the file and corrupt provenance). loadRawConfig surfaces a
 * corrupt existing file as CONFIG_INVALID, which propagates.
 *
 * The whole read-merge-write runs under a cross-process file lock: without it two
 * concurrent `config set` on different keys race on the read, and the last writer
 * drops the other's update (worst case, a zeroed maxAutoSpend resurrected). The
 * data dir is ensured first so the lock's mkdir has a parent on a fresh install.
 */
async function persist(
  dir: string,
  merge: (existing: PartialConfig) => PartialConfig,
): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const lockPath = `${configPath(dir)}.lock`;
  try {
    await withFileLock(lockPath, async () => {
      const existing = await loadRawConfig(dir);
      const merged = merge(existing);
      const validated = RawConfigSchema.parse(merged);
      await writeFileAtomic(configPath(dir), `${JSON.stringify(validated, null, 2)}\n`, {
        mode: 0o644,
        dirMode: 0o700,
      });
    });
  } catch (err) {
    // A lock timeout is not the user's malformed input; surface it as INTERNAL with
    // the one manual step (there is no auto-steal), keeping the JSON error contract.
    if (err instanceof LockTimeoutError) {
      throw new CliError('INTERNAL', err.message, {
        fix: `If no other tenjin process is running, remove ${lockPath} and retry.`,
        cause: err,
      });
    }
    throw err;
  }
}

function formatLine(key: string, entry: RenderedSetting): string {
  const label = key.padEnd(KEY_WIDTH);
  return `  ${label}  ${displayValue(entry)}  ${styleText('dim', `(${entry.source})`)}`;
}

/** The list variant: the value line, a dim description, and an optional dim note. */
function describedLine(key: string, entry: RenderedSetting, note?: string): string {
  const description = KEY_DESCRIPTIONS[key];
  let line = formatLine(key, entry);
  if (description !== undefined) line += `  ${styleText('dim', `- ${description}`)}`;
  return withNote(line, note);
}

/** Append a dim parenthetical note (e.g. the full-auto downgrade) when present. */
function withNote(line: string, note?: string): string {
  return note !== undefined ? `${line}  ${styleText('dim', `(${note})`)}` : line;
}

/**
 * The `publish.mode` line gains a downgrade note when the effective mode came from
 * a committed `.tenjin.json` asking for `full-auto` (the loosening gate demoted it
 * to `auto`). Human-only; the machine `data` shape is unchanged.
 */
function downgradeNote(key: PublishConfigKey, settings: EffectiveSettings): string | undefined {
  if (key !== 'publish.mode' || settings.publishMode.downgradedWarning === undefined) {
    return undefined;
  }
  return 'downgraded from full-auto: committed .tenjin.json (gitignore it to opt in)';
}

function displayValue(entry: RenderedSetting): string {
  const { value } = entry;
  if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : '(empty)';
  if (typeof value === 'boolean') return value ? 'true' : 'false'; // evalCohort
  if (typeof value === 'object') return `${value.usd} USD`; // Money (spend keys)
  if (entry.threshold !== undefined) return `above ${entry.threshold.usd} USD`; // confirm
  return value; // 'always', baseUrl, rpcUrl
}
