import { mkdir } from 'node:fs/promises';
import { styleText } from 'node:util';
import { CliError } from '../lib/errors';
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
import type { HarnessTarget } from '../lib/skill-wiring';
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
  'hooks.stopNag': 'end-of-turn reminder about searches nothing answered yet',
  'update.mode':
    'auto=install newer versions in the background, nudge=only tell a human, off=neither',
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
): Promise<CommandResult> {
  if (isPublishKey(key)) return setPublishKey(key, value, ctx);
  if (isHooksKey(key)) return setHooksKey(key, value, ctx);
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
  return { data: { key, ...entry }, humanLines: [formatLine(key, entry)] };
}

/**
 * `config set hooks.searchMode`. Merged into the nested hooks block through the
 * same locked read-modify-write every other set uses, so a subkey a newer CLI
 * wrote survives. The installed hook script reads this file on every run, so the
 * new mode takes effect immediately with no re-install.
 */
async function setHooksKey(
  key: HooksConfigKey,
  value: string,
  ctx: CommandContext,
): Promise<CommandResult> {
  const subkey = key === 'hooks.searchMode' ? 'searchMode' : 'stopNag';
  const parsed =
    key === 'hooks.searchMode' ? parseSearchHookModeFlag(value, key) : parseStopNagFlag(value, key);
  await persist(ctx.dataDir, (existing) => ({
    ...existing,
    hooks: { ...existing.hooks, [subkey]: parsed },
  }));
  const entry: RenderedSetting = { value: parsed, source: 'file' };
  return { data: { key, ...entry }, humanLines: [formatLine(key, entry)] };
}

/**
 * `config set update.mode`. Same locked merge-write as every other set, so the
 * background installer sees the new mode on the very next run with nothing to
 * re-install and no process to restart.
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

/** The list/get shape for a hooks key: a plain enum string either way. */
function renderHooksSetting(key: HooksConfigKey, settings: EffectiveSettings): RenderedSetting {
  const resolved = key === 'hooks.searchMode' ? settings.hooksSearchMode : settings.hooksStopNag;
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
