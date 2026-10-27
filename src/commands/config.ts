import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CliError } from '../lib/errors';
import { PRODUCTION_ORIGIN } from '../lib/production-origin';
import {
  CONFIG_KEYS,
  RETIRED_PAYMENT_GUIDANCE,
  retiredPaymentKeys,
  RawConfigSchema,
  SEND_MAX_UNSET,
  UPDATE_CONFIG_KEYS,
  EXPERIMENTAL_CONFIG_KEYS,
  ROUTER_CONFIG_KEYS,
  ROUTER_CONTEXTS,
  loadRawConfig,
  MAX_AUTO_SPEND_FLOOR_ATOMIC,
  MAX_AUTO_SPEND_FLOOR_WHY,
  parseOnOffFlag,
  parseUpdateModeFlag,
  resolveSettings,
} from '../lib/config';
import type {
  EffectiveSettings,
  PartialConfig,
  Provenance,
  ScalarConfigKey,
  UpdateConfigKey,
  ExperimentalConfigKey,
  RouterConfigKey,
  RouterContext,
} from '../lib/config';
import { configPath } from '../lib/paths';
import { writeFileAtomic } from '../lib/atomic-json';
import { withFileLock, LockTimeoutError } from '../lib/lock';
import { parseUsdToAtomic, toMoney } from '../lib/money';
import type { Money } from '../schemas';
import type { CommandContext, CommandResult } from '../context';
import { ROUTER_DEFAULTS, type RouterLimits } from '../router/spend-question';
import {
  projectRouterPath,
  readProjectRouterFile,
  routerSettings,
  type RouterSettings,
} from '../router/settings';
import { style } from '../lib/output';

/** Machine values use Money for spending keys and scalars for other settings. */
interface RenderedValue {
  value: Money | string | string[] | boolean | null;
}
interface RenderedSetting extends RenderedValue {
  source: Provenance;
  /** The file a router key came from, when one did. */
  path?: string;
}

/**
 * Keys `config get/set` accept and `--json` carries, but the human listing
 * leaves out. `allowlistCreators` is still enforced on every payment
 * (lib/policy.ts), so it stays settable; it is not one of the settings the
 * listing shows.
 */
const UNLISTED_KEYS: ReadonlySet<string> = new Set<string>(['allowlistCreators']);

const KEY_WIDTH = Math.max(
  ...[...CONFIG_KEYS, ...UPDATE_CONFIG_KEYS, ...ROUTER_CONFIG_KEYS, ...EXPERIMENTAL_CONFIG_KEYS]
    .filter((key) => !UNLISTED_KEYS.has(key))
    .map((key) => key.length),
);

/**
 * A one-line human description per key, appended (dim) to the bare `config`
 * listing only. Machine `data` is unchanged; these are humanLines decoration.
 */
const KEY_DESCRIPTIONS: Record<string, string> = {
  maxAutoSpend:
    'automatic router limit per call, the runaway guard: at least 0.25 (the default); router.enabled false turns the router off',
  sessionBudget:
    'automatic router daily limit, the main control (5 by default): 0 blocks automatic spend, none removes the ceiling',
  sendMaxAmount:
    'hard cap per tenjin wallet send; unset = send refuses until set, 0 disables send, none = uncapped; never bypassed by --yes',
  allowlistCreators: 'only auto-pay these creators (empty = any)',
  baseUrl: 'Tenjin API base URL the router asks',
  rpcUrl: 'Base RPC endpoint for balance reads',
  bazaarRegistries: 'x402 registries used to verify direct-payment listings',
  'update.mode':
    "auto=update in the background where Tenjin's runtime is set up (else as nudge), nudge=report a newer version (stderr line, JSON envelope, hook output), off=neither report nor ask npm",
  'router.enabled':
    'false stops every router hook and the request tool; --project sets it for this repository, --project --local for you alone in it',
  'router.context':
    'session=a hook packet carries up to six prior messages, turn=the current turn only; --project and --local as for router.enabled',
  'experimental.bazaar':
    "EXPERIMENTAL. on=the router may also suggest unreviewed sellers from Coinbase's open x402 Bazaar, off=curated services and Tenjin's reviewed list only",
};

/**
 * What turning the experimental list on means, said when it is turned on:
 * whose services these are, that the price is theirs, and how to turn it off.
 */
export const EXPERIMENTAL_BAZAAR_WARNING =
  "Experimental: the router may now also suggest sellers from Coinbase's open x402 Bazaar. " +
  'They are unreviewed third parties, Tenjin has not checked them, matches can be noisy, ' +
  'prices can vary with the input, and payments are real, under your spend limits. ' +
  "To find them, short snippets of your prompts are sent to Coinbase's public Bazaar search. " +
  "Tenjin's reviewed list stays on either way. Turn this off with " +
  '`tenjin config set experimental.bazaar off`.';

function isExperimentalKey(key: string): key is ExperimentalConfigKey {
  return (EXPERIMENTAL_CONFIG_KEYS as readonly string[]).includes(key);
}

function isRouterKey(key: string): key is RouterConfigKey {
  return (ROUTER_CONFIG_KEYS as readonly string[]).includes(key);
}

/** The list/get shape for a router key, with the file that set it. */
function renderRouterSetting(key: RouterConfigKey, settings: RouterSettings): RenderedSetting {
  const { value, source, path } = key === 'router.enabled' ? settings.enabled : settings.context;
  return { value, source, ...(path !== undefined ? { path } : {}) };
}

/** Router keys resolve against the directory the command runs in, as a hook would. */
async function resolveRouterFromContext(ctx: CommandContext): Promise<RouterSettings> {
  return routerSettings({ cwd: process.cwd(), dataDir: ctx.dataDir });
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
  const show = (key: string, line: string) => {
    if (!UNLISTED_KEYS.has(key)) humanLines.push(line);
  };
  for (const key of CONFIG_KEYS) {
    const entry = renderSetting(key, settings[key].value, settings[key].source);
    data[key] = entry;
    show(key, describedLine(key, entry));
  }
  for (const key of UPDATE_CONFIG_KEYS) {
    const entry: RenderedSetting = {
      value: settings.updateMode.value,
      source: settings.updateMode.source,
    };
    data[key] = entry;
    show(key, describedLine(key, entry));
  }
  const router = await resolveRouterFromContext(ctx);
  for (const key of ROUTER_CONFIG_KEYS) {
    const entry = renderRouterSetting(key, router);
    data[key] = entry;
    show(key, describedLine(key, entry));
  }
  for (const key of EXPERIMENTAL_CONFIG_KEYS) {
    const entry: RenderedSetting = {
      value: settings.experimentalBazaar.value,
      source: settings.experimentalBazaar.source,
    };
    data[key] = entry;
    show(key, describedLine(key, entry));
  }
  return { data, humanLines };
}

/** Same per-key shape as list, for one key. Unknown key is a USAGE failure. */
export async function runConfigGet(
  { key }: { key: string },
  ctx: CommandContext,
): Promise<CommandResult> {
  if (isUpdateKey(key)) {
    const { updateMode } = await resolveFromContext(ctx);
    const entry: RenderedSetting = { value: updateMode.value, source: updateMode.source };
    return { data: { key, ...entry }, humanLines: [formatLine(key, entry)] };
  }
  if (isRouterKey(key)) {
    const entry = renderRouterSetting(key, await resolveRouterFromContext(ctx));
    return { data: { key, ...entry }, humanLines: [formatLine(key, entry)] };
  }
  if (isExperimentalKey(key)) {
    const { experimentalBazaar } = await resolveFromContext(ctx);
    const entry: RenderedSetting = {
      value: experimentalBazaar.value,
      source: experimentalBazaar.source,
    };
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
  {
    key,
    value,
    project,
    local,
  }: { key: string; value: string; project?: boolean; local?: boolean },
  ctx: CommandContext,
): Promise<CommandResult> {
  if (local === true && project !== true) {
    throw new CliError('USAGE', '--local names the personal project file, so it needs --project', {
      fix: `Run \`tenjin config set --project --local ${key} ${value}\`.`,
    });
  }
  if (isRouterKey(key)) {
    return setRouterKey(key, value, ctx, project === true ? { local: local === true } : undefined);
  }
  if (project === true) {
    throw new CliError('USAGE', `${key} is not a project key`, {
      fix: `--project applies to ${ROUTER_CONFIG_KEYS.join(' and ')} only; drop it to set ${key} for this machine.`,
    });
  }
  if (isUpdateKey(key)) return setUpdateKey(key, value, ctx);
  if (isExperimentalKey(key)) return setExperimentalKey(key, value, ctx);
  const configKey = assertKey(key);
  const stored = parseValue(configKey, value);
  await persist(ctx.dataDir, (existing) => ({ ...existing, [configKey]: stored }));
  const entry = renderSetting(configKey, stored, 'file');
  return { data: { key: configKey, ...entry }, humanLines: [formatLine(configKey, entry)] };
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

/** `config set experimental.bazaar on|off`; turning it on says what it means. */
async function setExperimentalKey(
  key: ExperimentalConfigKey,
  value: string,
  ctx: CommandContext,
): Promise<CommandResult> {
  const parsed = parseOnOffFlag(value, key);
  await persist(ctx.dataDir, (existing) => ({
    ...existing,
    experimental: { ...existing.experimental, bazaar: parsed },
  }));
  const entry: RenderedSetting = { value: parsed, source: 'file' };
  const warning = parsed === 'on' ? EXPERIMENTAL_BAZAAR_WARNING : undefined;
  return {
    data: { key, ...entry, ...(warning !== undefined ? { warning } : {}) },
    humanLines: [formatLine(key, entry), ...(warning !== undefined ? [warning] : [])],
  };
}

/**
 * `config set [--project [--local]] router.enabled|router.context`. Without
 * `--project` the key goes into the global config through the same locked merge
 * every set uses. With it, into the project file {@link projectRouterPath}
 * names from here, merged so a sibling key survives. The line after the write
 * is what a hook here would now resolve, which differs from the value written
 * when an outer layer is tighter.
 */
async function setRouterKey(
  key: RouterConfigKey,
  value: string,
  ctx: CommandContext,
  project: { local: boolean } | undefined,
): Promise<CommandResult> {
  const field = key === 'router.enabled' ? 'enabled' : 'context';
  const parsed = field === 'enabled' ? parseBoolean(value) : parseRouterContext(value);
  let written: RenderedSetting;
  if (project === undefined) {
    await persist(ctx.dataDir, (existing) => ({
      ...existing,
      router: { ...existing.router, [field]: parsed },
    }));
    written = { value: parsed, source: 'file', path: configPath(ctx.dataDir) };
  } else {
    const path = await projectRouterPath({ cwd: process.cwd(), local: project.local });
    await persistProjectRouter(path, field, parsed);
    written = { value: parsed, source: project.local ? 'local' : 'project', path };
  }
  const effective = renderRouterSetting(key, await resolveRouterFromContext(ctx));
  const humanLines = [formatLine(key, written)];
  if (effective.value !== written.value) {
    humanLines.push(
      `Still ${String(effective.value)} here: ${effective.path ?? 'the default'} is tighter, and a nearer file can only tighten an outer one.`,
    );
  }
  if (project?.local === true) {
    humanLines.push('Keep .tenjin/config.local.json out of git: add it to .gitignore.');
  }
  return { data: { key, ...written, effective }, humanLines };
}

function parseRouterContext(value: string): RouterContext {
  const found = ROUTER_CONTEXTS.find((context) => context === value);
  if (found !== undefined) return found;
  throw new CliError('USAGE', `Invalid router.context: ${JSON.stringify(value)}`, {
    fix: 'Use "session" or "turn".',
  });
}

/**
 * Merge one router key into a project file. It holds the router block and
 * nothing else this CLI reads, so it is written 0644 like any committed file;
 * an existing file that is not a JSON object is refused rather than replaced.
 * The read, merge and write run under the same cross-process lock the global
 * writer takes, so two concurrent sets both land.
 */
async function persistProjectRouter(
  path: string,
  field: 'enabled' | 'context',
  value: boolean | RouterContext,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o755 });
  const lockPath = `${path}.lock`;
  try {
    await withFileLock(lockPath, () => mergeProjectRouter(path, field, value));
  } catch (err) {
    if (err instanceof LockTimeoutError) {
      throw new CliError('INTERNAL', err.message, {
        fix: `If no other tenjin process is running, remove ${lockPath} and retry.`,
        cause: err,
      });
    }
    throw err;
  }
}

async function mergeProjectRouter(
  path: string,
  field: 'enabled' | 'context',
  value: boolean | RouterContext,
): Promise<void> {
  // Through the one parser: a file that is not an object, or whose block is
  // invalid, is refused rather than replaced. A router subkey this build does
  // not know rides along untouched, as in the global file; it is never read.
  const existing = await readProjectRouterFile(path);
  const block = existing?.json.router;
  const next = {
    ...(existing?.json ?? {}),
    router: { ...(block !== undefined ? (block as object) : {}), [field]: value },
  };
  await writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`, {
    mode: 0o644,
    dirMode: 0o755,
  });
}

/**
 * Remember, or forget, a project directory this machine wired with
 * `install --project`. `tenjin update` spawns its refresh from the HOME
 * directory, so a project install is unfindable by looking around; this list is
 * how a later refresh reaches it. Absolute paths, de-duplicated, and pruned
 * when a project is uninstalled or its settings file stops carrying our
 * entries.
 */
export async function persistRouterProject(
  dir: string,
  projectDir: string,
  present = true,
): Promise<void> {
  await persist(dir, (existing) => {
    const known = new Set(existing.install?.routerProjects ?? []);
    if (present) known.add(projectDir);
    else known.delete(projectDir);
    return { ...existing, install: { ...existing.install, routerProjects: [...known].sort() } };
  });
}

/** Absent-only automatic router defaults; defined beside the spend question that shows them. */
export { ROUTER_DEFAULTS, type RouterLimits };

export interface RouterDefaultsResult {
  /** Keys this run wrote, because the file did not name them or the user named a new value. */
  set: string[];
  /** Keys the operator had already written, left exactly as they are. */
  kept: string[];
  removed: string[];
}

/** Remove/report retired keys in the same locked write. Refresh preserves absent
 * current settings; a fresh install fills only missing automatic limits, with the
 * values the person approved or chose. A key `limits` leaves out stays absent,
 * and the code default ($0.25 a call, $5 a day) holds for it: that is an install
 * nobody answered. A key in `chosen` is an amount the
 * user named for this install (`--max-auto-spend`, `--session-budget`), so it
 * replaces what the file holds. */
export async function persistRouterDefaults(
  dir: string,
  refresh = false,
  limits: Partial<RouterLimits> = ROUTER_DEFAULTS,
  chosen: readonly (keyof RouterLimits)[] = [],
): Promise<RouterDefaultsResult> {
  const result: RouterDefaultsResult = { set: [], kept: [], removed: [] };
  if (refresh && retiredPaymentKeys(await loadRawConfig(dir)).length === 0) return result;
  await persist(dir, (existing) => {
    const next: PartialConfig = { ...existing };
    result.removed = retiredPaymentKeys(existing);
    for (const key of result.removed) delete next[key];
    if (refresh) return next;
    for (const key of Object.keys(ROUTER_DEFAULTS) as (keyof RouterLimits)[]) {
      const value = limits[key];
      if (existing[key] !== undefined && !chosen.includes(key)) result.kept.push(key);
      else if (value !== undefined) {
        next[key] = value;
        result.set.push(key);
      }
    }
    return next;
  });
  return result;
}

async function resolveFromContext(ctx: CommandContext): Promise<EffectiveSettings> {
  const config = await loadRawConfig(ctx.dataDir);
  return resolveSettings({ config, flags: { baseUrl: ctx.flags.baseUrl }, env: process.env });
}

function assertKey(key: string): ScalarConfigKey {
  if (key === 'bazaarPay' || key === 'confirm') {
    throw new CliError('USAGE', `Retired config key: ${key}`, { fix: RETIRED_PAYMENT_GUIDANCE });
  }
  if ((CONFIG_KEYS as string[]).includes(key)) return key as ScalarConfigKey;
  throw new CliError('USAGE', `Unknown config key: ${JSON.stringify(key)}`, {
    fix: `Valid keys: ${[...CONFIG_KEYS, ...UPDATE_CONFIG_KEYS, ...ROUTER_CONFIG_KEYS, ...EXPERIMENTAL_CONFIG_KEYS].join(', ')}.`,
  });
}

function renderSetting(
  key: ScalarConfigKey,
  stored: string | string[] | boolean,
  source: Provenance,
): RenderedSetting {
  return { ...renderValue(key, stored), source };
}

function renderValue(key: ScalarConfigKey, stored: string | string[] | boolean): RenderedValue {
  if (Array.isArray(stored) || typeof stored === 'boolean') return { value: stored };
  if (key === 'sessionBudget' && stored === 'none') return { value: null };
  if (key === 'maxAutoSpend' || key === 'sessionBudget') return { value: toMoney(stored) };
  if (key === 'sendMaxAmount') {
    // 'unset' is the resolved sentinel for an absent key (send refuses), never
    // a stored value; 'none' is the explicit uncapped opt-in.
    return { value: stored === 'none' || stored === SEND_MAX_UNSET ? stored : toMoney(stored) };
  }
  return { value: stored };
}

/** Per-key edge parsing. Returns the persisted form; throws USAGE on bad input. */
function parseValue(key: ScalarConfigKey, value: string): string | string[] | boolean {
  switch (key) {
    case 'sessionBudget':
      return value === 'none' ? 'none' : parseUsdToAtomic(value);
    case 'maxAutoSpend':
      return parseAutoSpend(value);
    case 'sendMaxAmount':
      return value === 'none' ? 'none' : parseUsdToAtomic(value);
    case 'allowlistCreators':
      return parseAllowlist(value);
    case 'baseUrl':
    case 'rpcUrl':
      return parseHttpUrl(value);
    case 'bazaarRegistries':
      return parseRegistryList(value);
  }
}

/** A per-call limit, refused below the $0.25 floor (and on a bad amount). */
function parseAutoSpend(value: string): string {
  const atomic = parseUsdToAtomic(value);
  if (BigInt(atomic) < MAX_AUTO_SPEND_FLOOR_ATOMIC) {
    throw new CliError('USAGE', `maxAutoSpend ${value} is below the 0.25 USD minimum.`, {
      fix: MAX_AUTO_SPEND_FLOOR_WHY,
    });
  }
  return atomic;
}

/** "" clears to []; comma-split, each entry an absolute http(s) URL. */
function parseRegistryList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => parseHttpUrl(entry));
}

// Boolean settings accept both on/off and true/false.
function parseBoolean(value: string): boolean {
  if (value === 'true' || value === 'on') return true;
  if (value === 'false' || value === 'off') return false;
  throw new CliError('USAGE', `Invalid boolean value: ${JSON.stringify(value)}`, {
    fix: 'Use "on" or "off" (or "true"/"false").',
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
      fix: `Pass an absolute http(s) URL like ${PRODUCTION_ORIGIN}.`,
    });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new CliError('USAGE', `URL must be http or https: ${JSON.stringify(value)}`, {
      fix: `Pass an absolute http(s) URL like ${PRODUCTION_ORIGIN}.`,
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
      // 0600, matching lib/config.ts's `writeConfig`: `rpcUrl` can carry an RPC
      // provider's key, and this is the writer `config set` uses to put it
      // there. See that function for why dirMode alone is not enough.
      await writeFileAtomic(configPath(dir), `${JSON.stringify(validated, null, 2)}\n`, {
        mode: 0o600,
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
  // A router key from a project names its file: which of several is in force is the question.
  const where =
    entry.path !== undefined && (entry.source === 'project' || entry.source === 'local')
      ? ` ${entry.path}`
      : '';
  return `  ${label}  ${displayValue(entry)}  ${style('dim', `(${entry.source}${where})`)}`;
}

/** The list variant: the value line and a dim description. */
function describedLine(key: string, entry: RenderedSetting): string {
  const description = KEY_DESCRIPTIONS[key];
  const line = formatLine(key, entry);
  return description !== undefined ? `${line}  ${style('dim', `- ${description}`)}` : line;
}

function displayValue(entry: RenderedSetting): string {
  const { value } = entry;
  if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : '(empty)';
  if (typeof value === 'boolean') return value ? 'true' : 'false'; // router.enabled
  if (value === null) return 'none (no daily limit)';
  if (typeof value === 'object') return `${value.usd} USD`; // Money (spend keys)
  return value; // 'always', baseUrl, rpcUrl
}
