import { styleText } from 'node:util';
import { Stream } from 'node:stream';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import {
  OPTIONAL_PAY_SKILL,
  OPTIONAL_SKILL_NAMES,
  resolveSkillsSource,
} from '../lib/skills-source';
import { CliError } from '../lib/errors';
import {
  CLI_SKILL_NAMES,
  HOSTED_SKILL_NAME,
  anyTenjinSkill,
  cliSkillsWired,
  detectHarnesses,
  harnessDetectedBy,
  harnessFlagFor,
  harnessInPlay,
  harnessReads,
  harnessRequested,
  missingCliSkills,
  onPath,
  readAllWiring,
  readSkillFile,
  shadowedCliSkills,
} from '../lib/skill-wiring';
import { readHermesIntegrationStatus, resolveHermesHomeLenient } from '../lib/hermes';
import { skillMaterialize } from '../lib/skill-materialize';
import type {
  DirState,
  HarnessTarget,
  HarnessWiring,
  NotInvocableReason,
} from '../lib/skill-wiring';
import { fetchJson, type FetchJsonFailure, type ShelfBypass } from '../lib/http';
import { loadRawConfig, resolveSettings } from '../lib/config';
import {
  isTeamModeConfig,
  isTeamShelfOrigin,
  loadProjectConfig,
  resolveShelfBypass,
} from '../lib/settings';
import { tryOriginOf, trimSlash } from '../lib/url';
import { configPath, hooksDir, sessionPath } from '../lib/paths';
import { toMoney } from '../lib/money';
import { walletFileExists } from '../lib/wallet/store';
import { isSessionPresentable, readSessionFile, scopeSatisfies } from '../lib/session-present';
import { sanitizeForTerminal } from '../lib/output';
import { modeGatedPointer, permissionsPointer, recommendedPermissions } from '../lib/permissions';
import { inspectFreeVerbRules, MODE_GATED_RULES } from '../lib/harness-permissions';
import {
  PUSH_SCRIPT_FILES,
  compareHookScripts,
  countPushHookEntries,
  pushScriptsPresent,
} from '../lib/harness-hooks';
import { PUSH_VITEST_REPORTER_FILE } from '../lib/push-scripts';
import type { EffectiveSettings, PartialConfig, PublishMode } from '../lib/config';
import type { ErrorCode } from '../schemas';
import type { Io } from '../lib/output';
import type {
  PassphraseOverrides,
  WalletDescription,
  WalletProvider,
  WalletVerification,
} from '../lib/wallet';
import type { CommandContext, CommandResult } from '../context';
import { readStoreJournal, stateDbPath, probeSqlite } from '../lib/state-store';

/**
 * One environment/reachability check. The doctor agent builds the check list
 * against this shape without changing it: `required` drives the exit code (exit
 * 0 iff every required check is ok), `status` drives the TTY rendering, and a
 * `fix` is mandatory on every failure (spec 10). Warn-level checks never fail
 * the command.
 */
export interface CheckResult {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  required: boolean;
  detail: string;
  fix?: string;
  /**
   * Optional structured payload for machine consumers, so `--json` carries the
   * check's findings as data instead of only as the prose in `detail`. Additive
   * and per-check; the human renderer ignores it.
   */
  data?: unknown;
}

/** ~$20 in atomic USDC (6 decimals). Above this, the pocket-money wallet warns. */
const POCKET_MONEY_CEILING_ATOMIC = 20_000_000n;

/**
 * `doctor` is an allowlisted verb an unattended agent runs on its own, and its
 * `fix:` lines reach that agent both on the TTY and in `error.details.checks`.
 * So they name the CONFIGURED base URL and the operator command that changes it,
 * never `--base-url`: the flag rides every allowlisted verb (see FLAG_CAVEAT in
 * lib/permissions), and a fix line telling the agent to pass it would be the CLI
 * coaching the exact move the skills forbid. `config set` is not allowlisted, so
 * pointing there routes the change through the operator by construction.
 */
const FIX_POINT_AT_TENJIN_API =
  'Point the configured base URL at a Tenjin API (expected an OpenAPI document): `tenjin config set baseUrl <url>`.';
const FIX_CHECK_NETWORK_AND_BASE_URL =
  'Check your network connection and the configured base URL (`tenjin config get baseUrl`).';
/**
 * The base URL was RIGHT and the credential was missing. Sending the operator to
 * `baseUrl` here (what a bare CONTRACT_MISMATCH did, #218) asks them to change
 * the one setting that was already correct. Names the config key and no value:
 * the secret itself never reaches any check output. Says "if" because the page
 * signal alone does not prove protection; only the off-host redirect does, and
 * the detail line carries that distinction. Names the alternative for the same
 * reason {@link FIX_ROTATE_SHELF_BYPASS} does: an HTML page also answers a
 * `baseUrl` that is one typo off any site on the web, and setting a key would
 * not touch that.
 */
const FIX_SET_SHELF_BYPASS =
  'If that deployment is access-protected these probes did not get past it; set the team shelf key: `tenjin config set shelfBypassSecret <value>`. If it is not, something else answered instead (a proxy, WAF, or a base URL that is not the shelf you meant); confirm which before setting one.';
/**
 * Same page, but the probe CARRIED the configured key and still did not get
 * past. Telling this machine to set the secret it already sent (the stale-key
 * case: a rotated Vercel bypass token answers the 200 gate page, a 401, or the
 * 307 interstitial) would read as "doctor says my config is fine as is".
 */
const FIX_ROTATE_SHELF_BYPASS =
  'The configured shelfBypassSecret was sent and did not get past. Either the key is stale or rotated (update it: `tenjin config set shelfBypassSecret <value>`), or something between you and the shelf answered instead (a proxy, WAF, or another sign-in layer); confirm which before rotating.';
/**
 * A keyed probe was redirected, but to the SAME host it asked for: an `http://`
 * base URL that 301s to https, or a host normalising to its canonical name. The
 * key was refused by nothing here, so the rotate line would invert #218 all over
 * again, blaming the setting that was right. `baseUrl` is the one that moves.
 */
const FIX_FOLLOW_REDIRECT_IN_BASE_URL =
  'That URL redirects, and a probe carrying the team shelf key does not follow redirects. Point the configured base URL at the canonical host and scheme it redirects to: `tenjin config set baseUrl <url>`.';
/**
 * The same page, from a URL where the team key is not the answer. Naming
 * `baseUrl` would be wrong too: something answered, it just was not Tenjin. So
 * this describes what happened and points at the two things that can cause it,
 * without prescribing either.
 */
const FIX_PAGE_NOT_THE_API =
  'Something between this machine and that URL answered with a page instead of the API (a proxy, a captive portal, or a sign-in wall). Check your network path and the configured base URL (`tenjin config get baseUrl`).';

/**
 * A CheckResult plus the error code to raise if it is a *required* failure. Only
 * required checks carry a `failCode`; the outcome step raises the first one, so
 * the failure envelope's `error.code` names what actually broke (api-contract
 * unreachable vs malformed differ) while still carrying the whole check list.
 */
interface BuiltCheck {
  result: CheckResult;
  failCode?: ErrorCode;
}

export interface DoctorDeps {
  /** Environment for wallet-key detection and settings precedence. */
  env?: NodeJS.ProcessEnv;
  /** The `node:sqlite` probe; tests inject a failing one to exercise the
   * damaged-install diagnosis without a damaged install. */
  probeSqlite?: typeof probeSqlite;
  /** The degraded-store marker reader; tests inject one so the rollback-journal
   * line can be exercised without a filesystem that cannot do WAL. */
  readStoreJournal?: typeof readStoreJournal;
  /** Injected fetch for the reachability checks; tests pass a canned stub. */
  fetchImpl?: typeof fetch;
  /** Inject the active wallet provider. When set, NO local fs/env is consulted —
   * the provider owns its own describe() and diagnostics(), so a remote provider's
   * checks can't be contaminated by a stale local wallet file. */
  provider?: WalletProvider;
  /** Home directory root for the skill-wiring check. Defaults to os.homedir(); tests
   * (and `install`, which reuses these checks) inject their own. */
  homeDir?: string;
  /** PATH probe for the `claude`/`codex` binaries, half of harness detection. Defaults
   * to probing `env.PATH`, so a test passing `env: {}` detects neither. */
  which?: (bin: string) => boolean;
  /**
   * Working directory the project `.tenjin.json` layer is resolved from. Defaults
   * to `process.cwd()`, matching `config get` and `publish`.
   */
  cwd?: string;
  /** Clock seam (ms since epoch) for the session-expiry check. */
  now?: () => number;
  /** Packaged skills to compare the wired copies against; defaults to this build's. */
  skillsSourceDir?: string;
  /** Hermes home override; defaults through HERMES_HOME using the same resolver as install. */
  hermesHome?: string;
  /**
   * Passphrase seams for the wallet verification (#70), which reads the OS
   * credential store. Tests inject a platform with no store, or a stubbed exec,
   * so no assertion here depends on what is in the developer's real keychain.
   */
  walletPassphrase?: Omit<PassphraseOverrides, 'isTTY'>;
}

/**
 * The full check list plus the first required failure, if any. `install` reuses
 * this to run the doctor checks as its last step and EMBED the summary without
 * throwing (D39: doctor is diagnostics, it never blocks the caller); `runDoctor`
 * wraps it and turns a required failure into the thrown failure envelope.
 */
export interface DoctorChecks {
  checks: CheckResult[];
  /** The mode-gated rules this machine is missing, if any; drives the pointer. */
  missingModeGated: string[];
  failure?: { code: ErrorCode; result: CheckResult };
  /**
   * The publish mode this machine resolves right now (global config, or the
   * environment when it overrides). Reported rather than checked: it decides
   * which harness rules the operator needs, and it can never pass or fail.
   */
  publishMode: PublishMode;
}

export async function collectDoctorChecks(
  ctx: CommandContext,
  deps: DoctorDeps = {},
): Promise<DoctorChecks> {
  const env = deps.env ?? process.env;
  const { config, check: configCheck } = await loadConfigForDoctor(ctx.dataDir);
  /**
   * PROJECT-AWARE, like `config get` and `publish`. Doctor read the global file
   * and env only, so inside a repo whose `.tenjin.json` pins `review` under a
   * global `auto` it reported the machine as needing the mode-gated grant that the
   * next publish in that same directory would not use. That made three mode
   * surfaces disagree, which is the class the Stop hook fix was written for.
   *
   * A malformed project file is not doctor's failure to report: it throws
   * CONFIG_INVALID from `config get`, where the operator is asking about config.
   * Here it degrades to the global answer rather than taking down every unrelated
   * check on the page.
   */
  const cwd = deps.cwd ?? process.cwd();
  const project = await loadProjectConfig(cwd).catch(() => null);
  const settings = resolveSettings({
    config,
    flags: { baseUrl: ctx.flags.baseUrl },
    env,
    project: project?.layer,
  });
  const baseUrl = settings.baseUrl.value;
  // The SAME resolver resolveContextSettings uses, not a second copy of the
  // rule: the key is paired with the origin the operator configured, so
  // `tenjin doctor --base-url <anywhere>` runs its three probes unauthenticated
  // instead of sending the team shelf's key to that host three times.
  const bypass: ShelfBypass | undefined = resolveShelfBypass(config, settings);
  const home = deps.homeDir ?? homedir();
  const which = deps.which ?? ((bin: string) => onPath(bin, env));
  const requested = config.install?.harness ?? [];
  // NEVER the strict resolver here. Doctor is the command you reach for when
  // something is already broken, so a stray relative HERMES_HOME must not abort it
  // before a single check runs: it warns on the Hermes check and falls back.
  const hermesTarget =
    deps.hermesHome === undefined
      ? resolveHermesHomeLenient(home, env)
      : { home: deps.hermesHome, warning: undefined };
  const hermesHome = hermesTarget.home;

  const built: BuiltCheck[] = [checkNode(), await checkStateStore(deps.probeSqlite ?? probeSqlite)];
  // Beside the probe it belongs to, and only when there is something to say.
  const journal = await checkStoreJournal(ctx.dataDir, deps.readStoreJournal ?? readStoreJournal);
  if (journal !== null) built.push(journal);
  built.push(
    configCheck,
    // The three baseUrl probes carry the team shelf's bypass. Without it every
    // one of them reports a protected team deployment as unreachable, which is
    // the check saying "your CLI is broken" about the one setting that is right.
    await checkApiContract(
      baseUrl,
      ctx.flags.timeout,
      deps.fetchImpl,
      bypass,
      shelfKeyIsTheRemedy(settings, bypass),
    ),
    await checkReadPath(
      baseUrl,
      ctx.flags.timeout,
      deps.fetchImpl,
      bypass,
      shelfKeyIsTheRemedy(settings, bypass),
    ),
    await checkSearchContract(
      baseUrl,
      ctx.flags.timeout,
      deps.fetchImpl,
      bypass,
      shelfKeyIsTheRemedy(settings, bypass),
    ),
    await checkSkills(
      home,
      which,
      requested,
      settings.bazaarPay.value,
      deps.skillsSourceDir,
      hermesHome,
      // The raw config, not resolved settings: the staleness compare has to shape
      // the packaged copies the way the WRITERS shaped them, and they read the
      // machine's configured mode with no flag layer (lib/skill-materialize).
      isTeamModeConfig(config),
    ),
    await checkSession(ctx.dataDir, deps.now ?? Date.now, tryOriginOf(baseUrl)),
  );

  // Silent (no check pushed) on a machine with no hook scripts on disk at all;
  // see checkHookScripts.
  const hookScripts = await checkHookScripts(ctx.dataDir);
  if (hookScripts !== null) built.push(hookScripts);

  // Only when the experiment is on. Off, there is nothing to be half-wired and
  // a permanently-present check about a feature nobody enabled is noise.
  if (config.hooks?.push === 'on') {
    built.push(await checkPushHooks(home, ctx.dataDir));
  }

  // Same rule: silent unless one of the two settings claims a team shelf, so a
  // default machine gets no check about a feature it never turned on.
  const teamShelf = checkTeamShelf(settings, bypass);
  if (teamShelf !== null) built.push(teamShelf);

  // Same rule again: silent when this project has no vitest, or already wires
  // the reporter the failure arm's test-identity lane (tenjin-agent#267) prefers.
  const testReporterHint = await checkTestReporterHints(cwd, ctx.dataDir);
  if (testReporterHint !== null) built.push(testReporterHint);

  const hermes = await checkHermes({
    home,
    hermesHome,
    which,
    requested,
    webSearch:
      (config.hooks as { webSearch?: string; searchMode?: string })?.webSearch ??
      (config.hooks as { searchMode?: string })?.searchMode,
    homeWarning: hermesTarget.warning,
  });
  if (hermes !== null) built.push(hermes);

  // The wallet/custody/balance checks all come from the ACTIVE provider: it owns
  // describe() and diagnostics(), so doctor never runs its own fs/env probe.
  for (const result of await checkWallet(ctx, deps, env, settings.rpcUrl.value)) {
    built.push({ result });
  }

  const checks = built.map((b) => b.result);
  const publishMode = settings.publishMode.value;
  // Ask the settings file rather than assuming: the pointer below exists to name
  // a rule that is MISSING, and printing it at a machine that already carries
  // both is a nag with no action behind it.
  const probe = await inspectFreeVerbRules(deps.homeDir ?? homedir(), publishMode);
  const gated = new Set<string>(MODE_GATED_RULES);
  const missingModeGated = (probe.pending ?? []).filter((r) => gated.has(r));
  const firstFail = built.find((b) => b.result.required && b.result.status === 'fail');
  if (firstFail === undefined) return { checks, publishMode, missingModeGated };
  return {
    checks,
    publishMode,
    missingModeGated,
    failure: { code: firstFail.failCode ?? 'INTERNAL', result: firstFail.result },
  };
}

export async function runDoctor(
  ctx: CommandContext,
  deps: DoctorDeps = {},
): Promise<CommandResult> {
  const { checks, failure, publishMode, missingModeGated } = await collectDoctorChecks(ctx, deps);
  if (failure !== undefined) {
    const r = failure.result;
    // The allowlist rides on the FAILURE envelope too. An operator whose fresh
    // install is broken is the likeliest one to be reading doctor output at all,
    // and the earlier version dropped the block on exactly that path while the
    // comment below claimed otherwise. The human failure path still renders only
    // the error and its fix (that is emitFailure's contract, not doctor's), so
    // the machine payload is where this has to land.
    throw new CliError(failure.code, r.detail, {
      ...(r.fix !== undefined ? { fix: r.fix } : {}),
      details: { checks, permissions: recommendedPermissions(publishMode) },
    });
  }

  // The discoverability surface for the auto-mode denial problem (#33), now one
  // line rather than the ~60 that used to bury the check list this command was
  // run for: an operator whose agent just got denied still learns the allowlist
  // exists and where to get it. It reports nothing about the local machine, so it
  // is deliberately NOT a check: it can never pass or fail. `--json` is unchanged
  // and still carries the whole recommendation as data.
  // The mode-gated line goes ABOVE the pointer, and only when there is one: it
  // names a rule this machine's own mode needs, which is closer to a finding than
  // to the standing recommendation the pointer links to.
  // An env-set mode needs `config set`, not `install`: install resolves the mode
  // from the global file, so it would write nothing for a mode that only exists
  // in this process's environment.
  const env = deps.env ?? process.env;
  const fromEnv = env.TENJIN_PUBLISH_MODE !== undefined && env.TENJIN_PUBLISH_MODE.length > 0;
  // An env var is per-run and settable by anything in the agent's shell, so an
  // override is reported AS an override rather than as a remedy to make
  // permanent: `doctor` is an allowlisted free verb, and printing a `config set`
  // for a value it just read out of the environment is an escalation command
  // built from untrusted input.
  const modeLine = fromEnv
    ? `TENJIN_PUBLISH_MODE=${publishMode} is overriding your configured publish mode for this run only; the harness rules it needs are ${missingModeGated.join(' and ')}.`
    : modeGatedPointer(publishMode, missingModeGated, 'tenjin install');
  const showModeLine = fromEnv ? missingModeGated.length > 0 : modeLine !== null;
  return {
    data: { status: 'pass', checks, permissions: recommendedPermissions(publishMode) },
    humanLines: [
      ...renderDoctorHuman(ctx.io, checks),
      '',
      ...(showModeLine && modeLine !== null ? [modeLine] : []),
      permissionsPointer(),
    ],
  };
}

function checkNode(): BuiltCheck {
  const version = process.versions.node;
  const major = Number.parseInt(version.split('.')[0] ?? '0', 10);
  if (major >= 24) {
    return { result: { name: 'node', status: 'ok', required: true, detail: `Node ${version}` } };
  }
  return {
    result: {
      name: 'node',
      status: 'fail',
      required: true,
      detail: `Node ${version} is unsupported (need >= 24)`,
      fix: 'Install Node 24 or newer',
    },
    failCode: 'NODE_UNSUPPORTED',
  };
}

/**
 * Is `node:sqlite` there and answering?
 *
 * The hook sidecar's whole state — the already-shown set, the lookup buckets,
 * the per-session working state, the local error/fix pairings — lives in one
 * SQLite file opened through Node's built-in module (tenjin-agent#209). The
 * hooks fail OPEN without it, which is the right posture for a tool call and
 * the wrong one for a diagnosis: a machine whose sidecar has quietly stopped
 * remembering anything looks identical from the outside to one that simply had
 * nothing to say. So doctor asks directly.
 */
async function checkStateStore(probe_: typeof probeSqlite): Promise<BuiltCheck> {
  const probe = await probe_();
  if (probe.ok) {
    return {
      result: {
        name: 'state-store',
        status: 'ok',
        required: true,
        detail: `node:sqlite OK (SQLite ${probe.version ?? 'unknown'})`,
      },
    };
  }
  return {
    result: {
      name: 'state-store',
      status: 'fail',
      required: true,
      // Anyone reading this already cleared the >=24 preflight in src/index.ts,
      // so "upgrade Node" cannot be the remedy: the runtime is supported and the
      // import still failed, which points at the install — a damaged or
      // re-bundled dist (tsup once shipped `import("sqlite")`, tenjin-agent#225),
      // a patched runtime. Distinct code from the preflight so `--json` readers
      // can tell the two apart.
      detail: `node:sqlite failed to load on Node ${process.versions.node}, so the hooks keep no state at all`,
      fix: 'Reinstall tenjin-cli (npm i -g tenjin-cli@latest); if it persists, report the output of node -e "import(\'node:sqlite\')"',
    },
    failCode: 'INTERNAL',
  };
}

/**
 * Is the store stuck on a rollback journal?
 *
 * The sibling of the probe above, at lower stakes. `PRAGMA journal_mode = wal`
 * is the one statement in the store the busy timeout cannot protect, so an open
 * that loses it twice runs on against a rollback journal — every statement still
 * correct, but the eight hooks a single turn can fire now serialise instead of
 * overlapping. `openStore` records that in one row; without a line here it stays
 * a fact no one can reach, which is the state the `node:sqlite` check exists to
 * refuse.
 *
 * NEVER REQUIRED, NEVER A FAIL. Degradation is not absence: the store answers
 * real counts, so the caps and the dedup all still work (tenjin-agent#246). And
 * silent when healthy — a permanently-present line about a pragma that has never
 * failed is the noise that teaches an operator to skim the page.
 */
async function checkStoreJournal(
  dataDir: string,
  read: typeof readStoreJournal,
): Promise<BuiltCheck | null> {
  const journal = await read(dataDir);
  if (journal === null || journal.mode !== 'rollback') return null;
  return {
    result: {
      name: 'state-store-journal',
      status: 'warn',
      required: false,
      detail: `The state store at ${stateDbPath(dataDir)} is on a rollback journal (WAL unavailable) as of ${new Date(journal.at).toISOString()}, so concurrent hooks serialise on it instead of overlapping`,
      fix: 'Usually the data directory sits on a filesystem that cannot do WAL — a network mount, a container overlay. Point TENJIN_DATA_DIR at local disk; the flag clears itself the next time a WAL switch succeeds. Safe to ignore otherwise: the store stays correct either way, only slower under concurrent hooks.',
      data: { mode: journal.mode, at: journal.at },
    },
  };
}

/**
 * loadRawConfig throws CONFIG_INVALID on a bad file (which we convert into a
 * failing check) but the config value is also needed for baseUrl/rpcUrl
 * resolution; an invalid file falls back to {} so the reachability checks still
 * run and appear in the list, and config is reported as the first required fail.
 */
async function loadConfigForDoctor(
  dataDir: string,
): Promise<{ config: PartialConfig; check: BuiltCheck }> {
  try {
    const config = await loadRawConfig(dataDir);
    const detail =
      Object.keys(config).length === 0
        ? 'No config file; using defaults'
        : `Config at ${configPath(dataDir)} is valid`;
    return { config, check: { result: { name: 'config', status: 'ok', required: true, detail } } };
  } catch (err) {
    if (err instanceof CliError && err.code === 'CONFIG_INVALID') {
      return {
        config: {},
        check: {
          result: {
            name: 'config',
            status: 'fail',
            required: true,
            detail: err.message,
            ...(err.fix !== undefined ? { fix: err.fix } : {}),
          },
          failCode: 'CONFIG_INVALID',
        },
      };
    }
    throw err;
  }
}

/**
 * The fix line for a probe failure that reads as an access gate, shared by the
 * three baseUrl probes so `--json` cannot carry two verdicts about one machine.
 *
 * Returns undefined when no gate story applies and the caller's ordinary fix
 * stands. The page is a fact about the response; whether the team key fixes it
 * is a fact about the CONFIG, and only the second one licenses naming the key.
 * On the public marketplace the key is inert (`resolveShelfBypass` refuses it),
 * and an override pointing anywhere but the configured shelf carries none, so
 * both get the neutral line instead. An override that REPEATS the configured
 * shelf does carry the key, so it earns the same wording a configured base URL
 * does: the pair is issued on the origins matching, not on where the value came
 * from. Where the key IS the remedy, what the probe DID decides the
 * wording: `bypass` present means the key was sent and did not get past
 * (whether the gate answered 200 HTML, 401/403, or the blocked 30x
 * interstitial), so "set it" would prescribe the config this machine already
 * has; absent means setting it is the move.
 *
 * A blocked redirect qualifies only when its `Location` LEAVES the host asked
 * for. The transport refuses to follow any 3xx while carrying the key, so the
 * status alone says nothing about the key: a same-host hop is what an `http://`
 * base URL or a non-canonical host name gets, with a perfectly good secret.
 *
 * A same-origin JSON 401/403 is deliberately NOT a gate: an API refusing in its
 * own envelope is an honest refusal, and the transport keeps `gateSuspected`
 * false on it. But on a machine where the door key is the remedy, the missing or
 * stale key is the likeliest thing being refused, so the REMEDY still names it
 * while the classification stays put. Nothing here reads `kind` or the gate
 * flags to say what happened; the detail lines do that, and they say only what
 * the transport saw.
 */
function shelfGateFix(
  res: FetchJsonFailure,
  bypass: ShelfBypass | undefined,
  shelfKeyRemedy: boolean,
): string | undefined {
  const blocked = res.kind === 'blocked-redirect' && bypass !== undefined;
  const refused =
    res.kind === 'http' && (res.status === 401 || res.status === 403) && shelfKeyRemedy;
  if (res.gateSuspected !== true && !blocked && !refused) return undefined;
  if (blocked && res.gateOffOrigin !== true) return FIX_FOLLOW_REDIRECT_IN_BASE_URL;
  if (!shelfKeyRemedy) return FIX_PAGE_NOT_THE_API;
  return bypass !== undefined ? FIX_ROTATE_SHELF_BYPASS : FIX_SET_SHELF_BYPASS;
}

/**
 * What a gate-suspected failure SAYS happened, shared by the probes that print
 * one so a `detail` and its `fix` cannot tell different stories about one
 * response (read-path used to print the transport's raw "was not valid JSON"
 * beside a fix about the key). Claims no more than the signal proves: an
 * off-host landing proves a sign-in redirect, an HTML content-type alone proves
 * only that a page answered. The status rides both arms, since a 401 is the
 * most useful word in either sentence.
 */
function gateDetail(url: string, res: FetchJsonFailure): string {
  const status = res.kind === 'http' ? ` ${res.status}` : '';
  return res.gateOffOrigin === true
    ? `${url} answered${status} from a different host than the one asked for (an access-protection or sign-in redirect), not from a Tenjin API`
    : `${url} answered${status} with an HTML page, not JSON`;
}

async function checkApiContract(
  baseUrl: string,
  timeoutMs: number,
  fetchImpl?: typeof fetch,
  bypass?: ShelfBypass,
  /** Whether the bypass key is a remedy this machine can use; see {@link shelfKeyIsTheRemedy}. */
  shelfKeyRemedy = false,
): Promise<BuiltCheck> {
  const url = `${trimSlash(baseUrl)}/openapi.json`;
  const res = await fetchJson(url, {
    timeoutMs,
    fetchImpl,
    ...(bypass !== undefined ? { bypass } : {}),
  });
  if (!res.ok) {
    const malformed = res.kind === 'invalid-json';
    // Same failure code either way (the contract was not met), but a different
    // cause and so a different fix: the transport saw the response and says
    // whether it read as a protection page. Only it can, so doctor asks rather
    // than guessing from the body it no longer has. The detail claims no more
    // than the signal proves: an off-host landing proves a sign-in redirect, an
    // HTML content-type alone proves only that a page answered.
    const gated = res.gateSuspected === true;
    return {
      result: {
        name: 'api-contract',
        status: 'fail',
        required: true,
        detail: gated
          ? gateDetail(url, res)
          : malformed
            ? `OpenAPI document at ${url} was not valid JSON`
            : `Could not reach the Tenjin API at ${url}: ${res.message}`,
        fix:
          shelfGateFix(res, bypass, shelfKeyRemedy) ??
          (malformed ? FIX_POINT_AT_TENJIN_API : FIX_CHECK_NETWORK_AND_BASE_URL),
      },
      failCode: malformed ? 'CONTRACT_MISMATCH' : 'API_UNREACHABLE',
    };
  }
  const version = infoVersion(res.json);
  if (version === undefined) {
    return {
      result: {
        name: 'api-contract',
        status: 'fail',
        required: true,
        detail: `OpenAPI document at ${url} is missing a string info.version`,
        fix: FIX_POINT_AT_TENJIN_API,
      },
      failCode: 'CONTRACT_MISMATCH',
    };
  }
  return {
    result: {
      name: 'api-contract',
      status: 'ok',
      required: true,
      detail: `Tenjin API ${version} at ${baseUrl}`,
    },
  };
}

/**
 * WARN-level (never fails doctor): is the search endpoint advertised in the
 * OpenAPI doc? Absent means the deployment predates search v3 (tenjin#137), so
 * `tenjin search` and the buy path that starts there will not work against it.
 * Warn-only because doctor's job is a working READ path, and search is additive.
 *
 * It probes `/api/search`, the path the client actually calls. The
 * `/api/agent/search` alias it replaced is deprecated and answers 410 after one
 * release, so a deployment advertising ONLY the alias is exactly the case this
 * check has to warn about rather than pass.
 */
async function checkSearchContract(
  baseUrl: string,
  timeoutMs: number,
  fetchImpl?: typeof fetch,
  bypass?: ShelfBypass,
  /** Whether the bypass key is a remedy this machine can use; see {@link shelfKeyIsTheRemedy}. */
  shelfKeyRemedy = false,
): Promise<BuiltCheck> {
  const url = `${trimSlash(baseUrl)}/openapi.json`;
  const res = await fetchJson(url, {
    timeoutMs,
    fetchImpl,
    ...(bypass !== undefined ? { bypass } : {}),
  });
  if (!res.ok) {
    // The gate-aware fix rides here too: a gated failure answers all three
    // probes at once, `--json` carries every check, and a "check the base URL"
    // here beside a "set the key" on api-contract is two verdicts on one cause.
    return {
      result: {
        name: 'search-contract',
        status: 'warn',
        required: false,
        detail: `Could not confirm the search endpoint at ${url}`,
        fix:
          shelfGateFix(res, bypass, shelfKeyRemedy) ??
          'Check the configured base URL (`tenjin config get baseUrl`); search/buy need the A2 endpoints deployed.',
      },
    };
  }
  const present = hasSearchPath(res.json);
  return {
    result: present
      ? {
          name: 'search-contract',
          status: 'ok',
          required: false,
          detail: 'Search endpoint advertised',
        }
      : {
          name: 'search-contract',
          status: 'warn',
          required: false,
          detail: 'This deployment does not advertise POST /api/search (it predates search v3)',
          fix: 'search/buy need search v3 deployed; point the configured base URL at a deploy that has it (`tenjin config set baseUrl <url>`).',
        },
  };
}

function hasSearchPath(json: unknown): boolean {
  if (!isRecord(json)) return false;
  const paths = json.paths;
  return isRecord(paths) && '/api/search' in paths;
}

/**
 * WARN-level (never fails doctor): is the harness skill wiring usable? #35 was
 * invisible without a screen recording, because the publish skill was on disk yet
 * the model never saw it and only the hosted skill answered publish asks.
 *
 * Verdicts are per DIRECTORY, never unioned across them — in EITHER direction.
 * Unioning the problems contradicts itself on a real machine: a Claude-only install
 * leaves a stray hosted skill in ~/.agents/skills, and flat-mapping announced both
 * CLI skills "missing" in the same sentence that listed them wired. Unioning the
 * successes is the same bug inverted, and worse: Claude Code reads ~/.claude/skills
 * and Codex reads ~/.agents/skills, so a wired .agents cannot answer for .claude,
 * and asking whether SOME directory is wired reported `ok` on a machine where
 * `tenjin-publish` was unreachable from Claude Code — exactly the #35 shape.
 *
 * So each directory is judged alone, and only when a harness on this machine
 * actually reads it (`harnessReads`, the probes `install` picks targets with). That
 * gate is what keeps a leftover mirror quiet: a hosted-only ~/.agents/skills with no
 * Codex is nobody's problem, while a hosted-only ~/.claude/skills with Claude Code
 * installed is the bug.
 *
 * Warn and never required: a CI or server machine legitimately has no harness, so
 * this must not move the exit code.
 */
/**
 * `requested` is the `--harness` set a past `install` recorded (config `install.harness`).
 * It joins detection in deciding which directories are in play, and rides in the data as
 * its own field so `harnessPresent` keeps meaning "a harness detected here reads this".
 */
async function checkSkills(
  home: string,
  which: (bin: string) => boolean,
  requested: readonly HarnessTarget[],
  bazaarPay: boolean,
  skillsSourceDir: string | undefined,
  hermesHome: string,
  teamMode: boolean,
): Promise<BuiltCheck> {
  const resolvedHermesHome = hermesHome;
  const present = detectHarnesses(home, which, resolvedHermesHome);
  const wiring = await readAllWiring(home, resolvedHermesHome);
  const data = {
    directories: wiring.map((w) => ({
      ...w,
      harnessPresent: harnessReads(home, w.dir, present, resolvedHermesHome),
      requested: harnessRequested(home, w.dir, requested, resolvedHermesHome),
    })),
  };
  const inPlay = wiring.filter((w) => anyTenjinSkill(w));

  if (inPlay.length === 0) {
    // Same fixFor path every other branch uses, over the same harnessInPlay
    // predicate (detected OR requested) — filtering on `requested` alone named
    // only the recorded directory and left a DETECTED one unwired, which just
    // swapped which directory the first command missed. Gated on
    // `requested.length > 0` so a machine with no record at all keeps the plain
    // `tenjin install` rather than newly spelling out a detected harness that
    // nobody asked to see named.
    const targeted =
      requested.length > 0
        ? wiring.filter((w) => harnessInPlay(home, w.dir, present, requested, resolvedHermesHome))
        : [];
    return {
      result: {
        name: 'skills',
        status: 'warn',
        required: false,
        detail: `No Tenjin skills wired under ${home} (looked in .claude/skills, .agents/skills, and Hermes skills)`,
        fix: targeted.length > 0 ? fixFor(home, targeted, resolvedHermesHome) : 'tenjin install',
        data,
      },
    };
  }

  // Every directory in play must carry BOTH CLI skills, model-invocable. Anything less
  // is the defect, whether it is shadowed, half-installed, hosted-only or absent; a
  // directory neither detected nor asked for is described but never warned about.
  const broken = wiring.filter(
    (w) => harnessInPlay(home, w.dir, present, requested, resolvedHermesHome) && !cliSkillsWired(w),
  );
  if (broken.length > 0) {
    return {
      result: {
        name: 'skills',
        status: 'warn',
        required: false,
        detail: `${broken.map(describeProblem).join('; ')}. Full state: ${describeWiring(inPlay)}`,
        fix: fixFor(home, broken, resolvedHermesHome),
        data,
      },
    };
  }

  // The OPTIONAL tenjin-pay skill's presence must MATCH the `bazaarPay` toggle
  // (lib/skill-placement): install and `config set bazaarPay` both place/remove
  // it best-effort and stay quiet on failure, so this is the one surface where
  // that drift is reported. Toggle off with the skill still teaching the lane,
  // or on with no teaching, both warn; the runtime gate in pay's resolveLane
  // keeps the lane itself safe either way, which is why this is warn, not fail.
  const payDrift: string[] = [];
  for (const w of inPlay) {
    if (!harnessInPlay(home, w.dir, present, requested, resolvedHermesHome)) continue;
    const onDisk = await readSkillFile(join(w.dir, OPTIONAL_PAY_SKILL, 'SKILL.md'));
    if ((onDisk.kind === 'ok') !== bazaarPay) payDrift.push(w.dir);
  }
  if (payDrift.length > 0) {
    return {
      result: {
        name: 'skills',
        status: 'warn',
        required: false,
        detail: bazaarPay
          ? `bazaarPay is on but the ${OPTIONAL_PAY_SKILL} skill is missing under ${payDrift.join(', ')}; agents are not being taught the lane`
          : `bazaarPay is off but the ${OPTIONAL_PAY_SKILL} skill is still present under ${payDrift.join(', ')}; agents are being taught a lane the runtime gate will refuse`,
        fix: `Re-run \`tenjin config set bazaarPay ${bazaarPay ? 'on' : 'off'}\` to re-sync the skill's presence.`,
        data,
      },
    };
  }

  // Wired is not the same as CURRENT. `npm i -g tenjin-cli` updates the binary and
  // nothing else, so the copies install wrote stay at whatever version wrote them
  // until someone re-runs install, and every check above passes the whole time.
  //
  // EVERY directory, not just the ones in play. The checks above ask what a
  // harness on this machine reads; this one has to cover what the self-heal
  // writes, which is any directory holding one of our adapters. A ~/.agents/skills
  // that fell out of play (a fallback install, then Claude Code arrives) is where
  // the heal keeps working and, when it cannot, keeps quiet: reporting a narrower
  // set than it writes would leave a stale directory nothing ever names.
  const { stale, verifiable } = await compareWiredSkills(
    wiring.map((w) => w.dir),
    teamMode,
    skillsSourceDir,
  );
  if (!verifiable) {
    return {
      result: {
        name: 'skills',
        status: 'warn',
        required: false,
        detail: `${CLI_SKILL_NAMES.join(' + ')} wired, but this build's packaged copies could not be read, so whether they are current is unknown`,
        // NOT `tenjin update`: this warning means the packaged copies are
        // unreadable, which a current version answers with "up to date" and no
        // work at all. Reinstalling the same version is the actual repair.
        fix: 'Reinstall the CLI: `npm i -g tenjin-cli`, then `tenjin install`.',
        data,
      },
    };
  }
  if (stale.length > 0) {
    return {
      result: {
        name: 'skills',
        status: 'warn',
        required: false,
        detail: `${CLI_SKILL_NAMES.join(' + ')} wired but not from this CLI build (${stale.join(', ')}); agents are reading an older version's instructions`,
        // fixFor, like every neighbouring branch: a plain `tenjin install` targets
        // DETECTED harnesses only, so for a directory that exists because someone
        // passed --harness it would be a fix that never clears the warning.
        fix: fixFor(
          home,
          wiring.filter((w) => stale.includes(w.dir)),
          resolvedHermesHome,
        ),
        data,
      },
    };
  }

  return {
    result: {
      name: 'skills',
      status: 'ok',
      required: false,
      detail: `${CLI_SKILL_NAMES.join(' + ')} wired: ${describeWiring(inPlay)}`,
      data,
    },
  };
}

/** Native Hermes wiring is a separate warn-level check from portable skills. */
async function checkHermes(args: {
  home: string;
  hermesHome: string;
  which: (bin: string) => boolean;
  requested: readonly HarnessTarget[];
  webSearch?: string;
  homeWarning?: string;
}): Promise<BuiltCheck | null> {
  const { home, hermesHome, which, requested, webSearch: searchMode, homeWarning } = args;
  const inPlay =
    requested.includes('hermes') || harnessDetectedBy(home, 'hermes', which, hermesHome).length > 0;
  if (!inPlay) return null;
  const status = {
    ...(await readHermesIntegrationStatus(hermesHome)),
    ...(homeWarning !== undefined ? { homeWarning } : {}),
  };
  const ok =
    status.mcp === 'configured' && status.plugin === 'installed' && status.activation === 'enabled';
  if (ok && homeWarning === undefined) {
    return {
      result: {
        name: 'hermes',
        status: 'ok',
        required: false,
        detail: `Native Tenjin retrieval and publish-back plugin enabled in ${hermesHome}`,
        data: status,
      },
    };
  }
  const problems: string[] = [];
  if (status.mcp === 'stale') {
    problems.push(`MCP command missing (${status.mcpCommand ?? 'unknown'})`);
  } else if (status.mcp !== 'configured') problems.push(`MCP ${status.mcp}`);
  if (status.plugin !== 'installed') problems.push(`plugin ${status.plugin}`);
  // Named `activation`, not a second `plugin`: "plugin missing, plugin not-enabled"
  // read as one subject twice.
  if (status.activation !== 'enabled') problems.push(`activation ${status.activation}`);
  if (homeWarning !== undefined) problems.push('HERMES_HOME ignored');
  return {
    result: {
      name: 'hermes',
      status: 'warn',
      required: false,
      detail: `Hermes Tenjin integration incomplete in ${hermesHome}: ${problems.join(', ')}${
        homeWarning === undefined ? '' : `. ${homeWarning}`
      }`,
      // `tenjin install --harness hermes` alone is a dead end when the stored mode
      // is `off`: it re-runs, withholds the hook code by design, and prints the same
      // warning forever. Name the blocker that actually has to move first.
      fix:
        searchMode === 'off'
          ? 'tenjin config set hooks.webSearch auto && tenjin install --harness hermes'
          : 'tenjin install --harness hermes',
      data: status,
    },
  };
}

/**
 * How the wired CLI adapter skills compare to the packaged ones.
 *
 * The packaged side is MATERIALIZED for this machine's mode before the compare, so
 * "current" means "matches what a writer on this machine would write now" — which
 * also makes a mode change legible as drift until the heal converges it, rather
 * than either invisible or permanent.
 *
 * `verifiable` is false when this build cannot read its own packaged copies, which
 * is a broken package rather than evidence of no drift; reporting that as current
 * would make the check quietly green on exactly the install doctor should describe.
 *
 * Only the ADAPTERS are compared: the hosted mirror is a copy of
 * tenjin.blog/skills.md that an operator may legitimately have re-fetched newer
 * than this package ships.
 *
 * This is also where a skill the post-command self-heal could NOT rewrite
 * surfaces. That writer stays silent about its failures on purpose: a cause it
 * cannot clear (an unwritable skills directory) would otherwise print the same
 * line on every command forever. Stale here means exactly that, and the fix names
 * the harness. For the handoff to hold, the CALLER has to pass every directory
 * the heal can reach, not only the ones a detected harness reads.
 */
async function compareWiredSkills(
  dirs: readonly string[],
  teamMode: boolean,
  sourceDir?: string,
): Promise<{ stale: string[]; verifiable: boolean }> {
  let source: string;
  try {
    source = sourceDir ?? resolveSkillsSource(fileURLToPath(new URL('.', import.meta.url)));
  } catch {
    return { stale: [], verifiable: false };
  }
  // Read once, not once per directory. Optional skills join the compare when
  // present on disk (their presence is gated elsewhere), but only the required
  // adapters decide `verifiable`: a package missing an optional copy is odd,
  // not a reason to call every adapter unverifiable.
  const packaged = new Map<string, Buffer>();
  const materialize = skillMaterialize({ teamMode });
  for (const name of [...CLI_SKILL_NAMES, ...OPTIONAL_SKILL_NAMES]) {
    const read = await readSkillFile(join(source, name, 'SKILL.md'));
    // SHAPED before the compare, exactly as the writers shape it. Comparing raw
    // packaged bytes here would call every skill on a marker-carrying build stale
    // in both modes, forever, with a fix that cannot clear it.
    if (read.kind === 'ok') packaged.set(name, materialize('SKILL.md', read.bytes));
  }
  if (CLI_SKILL_NAMES.some((name) => !packaged.has(name))) {
    return { stale: [], verifiable: false };
  }

  const stale: string[] = [];
  for (const dir of dirs) {
    for (const name of [...CLI_SKILL_NAMES, ...OPTIONAL_SKILL_NAMES]) {
      if (!packaged.has(name)) continue;
      // Guarded: a pipe or device at this path would otherwise block the whole
      // diagnostic. Anything but a readable regular file is the wiring check's
      // business, not this one's.
      const onDisk = await readSkillFile(join(dir, name, 'SKILL.md'));
      if (onDisk.kind !== 'ok') continue;
      if (!packaged.get(name)!.equals(onDisk.bytes)) {
        stale.push(dir);
        break;
      }
    }
  }
  return { stale, verifiable: true };
}

/** What is wrong in ONE directory, naming the directory and the skills. */
function describeProblem(w: HarnessWiring): string {
  const shadowed = shadowedCliSkills(w);
  const missing = missingCliSkills(w);
  const parts: string[] = [];
  // Grouped BY REASON, not into one clause: the two claims differ in strength. A
  // readable file with the flag set is a fact; an unreadable one is a disjunction,
  // because the whole reason we cannot assert the flag is that we could not read it.
  // Merging them would spread that hedge onto a skill we know the answer for.
  const unreadable = shadowed.filter((n) => reasonFor(w, n) === 'unreadable');
  const disabled = shadowed.filter((n) => reasonFor(w, n) !== 'unreadable');
  if (disabled.length > 0) {
    parts.push(
      `${disabled.join(', ')} installed but not model-invocable (disable-model-invocation: true)`,
    );
  }
  if (unreadable.length > 0) {
    parts.push(
      `${unreadable.join(', ')} installed but not model-invocable (unreadable or disable-model-invocation: true)`,
    );
  }
  // Naming both by name reads as a half-install; when NEITHER is there the state is
  // "this harness has no CLI skills at all", which is a different sentence.
  if (missing.length === CLI_SKILL_NAMES.length) {
    parts.push(
      w.state === 'hosted-only'
        ? `the hosted ${HOSTED_SKILL_NAME} skill is here but neither CLI skill is wired`
        : 'neither CLI skill is wired',
    );
  } else if (missing.length > 0) parts.push(`${missing.join(', ')} missing`);
  return `${w.dir}: ${parts.join(' and ')}`;
}

function reasonFor(w: HarnessWiring, name: string): NotInvocableReason | undefined {
  return w.skills.find((s) => s.name === name)?.reason;
}

/** Is the hosted zero-install mirror in THIS directory? */
function hostedHere(w: HarnessWiring): boolean {
  return w.skills.find((s) => s.name === HOSTED_SKILL_NAME)?.present === true;
}

/**
 * A fix that can actually clear the warning. A bare `tenjin install` only targets
 * the directories detection picks, so a problem in ~/.agents/skills on a
 * Claude-only machine needs `--harness shared` spelled out.
 */
function fixFor(home: string, dirs: HarnessWiring[], hermesHome: string): string {
  const flags = [...new Set(dirs.map((w) => harnessFlagFor(home, w.dir, hermesHome)))];
  return `tenjin install ${flags.map((f) => `--harness ${f}`).join(' ')}`;
}

/** One-line per-directory summary: `<dir> -> <skills> (<posture>)`. */
function describeWiring(wiring: HarnessWiring[]): string {
  return wiring
    .map((w) => {
      const parts = w.skills
        .filter((s) => s.present)
        .map((s) =>
          s.modelInvocable === false ? `${s.name} [${s.reason ?? 'shadowed'}]` : s.name,
        );
      return `${w.dir} -> ${parts.join(', ')} (${posture(w)})`;
    })
    .join('; ');
}

/**
 * The precedence half of the `wired` posture is only true when there is a mirror
 * here to take precedence OVER. `classify` keys `wired` off the two CLI skills
 * alone, so a directory whose mirror was deleted is `wired` with no `tenjin` in it,
 * and the unconditional string claimed a file the same line had just not listed.
 */
function posture(w: HarnessWiring): string {
  if (w.state !== 'wired') return POSTURE[w.state];
  return hostedHere(w)
    ? 'CLI skills wired, take precedence over the hosted mirror'
    : 'CLI skills wired';
}

const POSTURE: Record<DirState, string> = {
  empty: 'no Tenjin skills',
  'hosted-only': 'hosted skill only, no CLI skills here',
  partial: 'only one CLI skill',
  // "at least one": a directory with one CLI skill shadowed and the other absent
  // classifies as `shadowed` too, and "CLI skills present" would be false there.
  shadowed: 'at least one CLI skill present but not model-invocable',
  wired: 'CLI skills wired, take precedence over the hosted mirror',
};

/**
 * Is team mode actually on, and does the operator know which answer they got?
 *
 * Team mode needs TWO settings, and the setup is two independent commands, so
 * BOTH halves are reachable: a machine with the bypass secret and `baseUrl`
 * still on the public marketplace, and a machine with `baseUrl` on a shelf of
 * its own and no secret. The CLI fails the first safe to public mode —
 * publishes keep the client scan and the confirm cascade — but silently, and an
 * operator who believes they are on the team shelf would keep writing internal
 * notes at a command that sends them to tenjin.blog. The second half is the one
 * that breaks every network probe (see {@link halfWiredShelfWarn}). Warn, never
 * fail, for both: each is a working machine, just not the one they configured.
 *
 * Reports what the probes ACTUALLY DID — it is handed the same `bypass` they
 * were, rather than re-deriving the answer — so a run whose base URL came from
 * `--base-url` reports the key as withheld instead of claiming a team mode this
 * run does not have.
 */
function checkTeamShelf(
  settings: EffectiveSettings,
  bypass: ShelfBypass | undefined,
): BuiltCheck | null {
  if (settings.shelfBypassSecret.value.length === 0) return halfWiredShelfWarn(settings);
  const baseUrl = settings.baseUrl.value;
  if (bypass !== undefined) {
    return {
      result: {
        name: 'team shelf',
        status: 'ok',
        required: false,
        detail: `team mode: baseUrl is ${sanitizeForTerminal(baseUrl)}, and requests to it carry the bypass header`,
      },
    };
  }
  // The secret is set and the shelf is a real one, but THIS run was pointed
  // elsewhere, so the key was withheld. Not a misconfiguration — the config is
  // fine — which is why it reads differently from the half-wired case below.
  const origin = tryOriginOf(baseUrl);
  if (
    settings.baseUrl.source !== 'file' &&
    settings.baseUrl.source !== 'default' &&
    origin !== null &&
    isTeamShelfOrigin(origin, settings.publicShelfUrl.value)
  ) {
    return {
      result: {
        name: 'team shelf',
        status: 'warn',
        required: false,
        // NAMING THE FLAG HERE IS ITSELF THE HAZARD (see FIX_POINT_AT_TENJIN_API
        // and lib/permissions FLAG_CAVEAT): doctor's lines reach an unattended
        // agent, and an override is what a prompt-injected one would reach for.
        // So this says an override happened, never how to make one.
        detail: `this run's base URL came from ${settings.baseUrl.source === 'flag' ? 'a command-line override' : 'the environment'} (${sanitizeForTerminal(baseUrl)}) rather than from config, so the team shelf's bypass key was withheld and these probes ran unauthenticated`,
        fix: 'Run doctor with no base-URL override to check the configured team shelf.',
      },
    };
  }
  return {
    result: {
      name: 'team shelf',
      status: 'warn',
      required: false,
      detail: `shelfBypassSecret is set, but baseUrl is the public marketplace (${sanitizeForTerminal(baseUrl)}), so this machine is in PUBLIC mode: publishes go to the marketplace with the client scan and the confirm cascade on, and there is no second shelf to fall through to`,
      fix: 'Point the base URL at the team deployment: `tenjin config set baseUrl <team shelf url>` (or clear the secret with `tenjin config set shelfBypassSecret ""`).',
    },
  };
}

/**
 * Is the team's bypass key a remedy THIS MACHINE can use?
 *
 * Two conditions, and both are about the config rather than about any response:
 * the base URL came from config, and it points at a shelf of the team's own.
 *
 * - Not from config means the origin belongs to this RUN (`--base-url`,
 *   `TENJIN_BASE_URL`). Naming the key against a host a flag chose is doctor
 *   coaching the team's door key toward it, which is the move FLAG_CAVEAT exists
 *   to stop; the withheld-key warn already names the override instead.
 * - The public marketplace is not access-protected and takes no key: a secret
 *   set beside it is refused outright (`resolveShelfBypass` fails safe to public
 *   mode), so the advice would be inert AND would trip the other half-wired warn.
 *
 * Shared by the three baseUrl probes' fix lines (via {@link shelfGateFix}) and
 * {@link halfWiredShelfWarn} so they cannot answer differently about one
 * machine.
 */
function shelfKeyIsTheRemedy(settings: EffectiveSettings, bypass?: ShelfBypass): boolean {
  // A key that WAS issued for this request is the remedy whatever named the
  // origin: resolveShelfBypass keys on the configured and effective origins
  // matching, not on baseUrl.source, so repeating the configured shelf through
  // --base-url or TENJIN_BASE_URL still sends it. Deciding on source alone hid
  // a rejected key behind the neutral page advice.
  if (bypass !== undefined) return true;
  // Exactly 'file': resolveBaseUrl never returns 'project' today (a project
  // .tenjin.json baseUrl is dropped on the floor by loadProjectConfig, by
  // design). If a project layer ever lands, whether a repo-checked-in file may
  // summon the team's door key must be decided then, not inherited from here.
  if (settings.baseUrl.source !== 'file') return false;
  const origin = tryOriginOf(settings.baseUrl.value);
  return origin !== null && isTeamShelfOrigin(origin, settings.publicShelfUrl.value);
}

/**
 * The other half-wiring: `baseUrl` on a shelf of the team's own, no secret.
 *
 * Response-INDEPENDENT on purpose. The symptom is a protection page answering
 * every probe, and `checkApiContract` now names that when it sees one, but a
 * deployment that is not protected today can be protected tomorrow with no
 * config change here. This check reads the two settings alone, so it is true
 * before the network says anything and stays true when the network says nothing.
 *
 * The gate is {@link shelfKeyIsTheRemedy}: there is nothing to warn about unless
 * the missing key is one this machine could actually use. Empty secret plus the
 * public marketplace stays silent, because that is the default machine.
 */
function halfWiredShelfWarn(settings: EffectiveSettings): BuiltCheck | null {
  if (!shelfKeyIsTheRemedy(settings)) return null;
  const baseUrl = settings.baseUrl.value;
  return {
    result: {
      name: 'team shelf',
      status: 'warn',
      required: false,
      detail: `baseUrl is ${sanitizeForTerminal(baseUrl)}, a shelf of your own, but no shelfBypassSecret is set, so every probe above ran unauthenticated; if that deployment is access-protected they were answered by its protection page rather than by Tenjin`,
      fix: 'Set the team shelf key so requests get past deployment protection: `tenjin config set shelfBypassSecret <value>`.',
    },
  };
}

/**
 * One test framework's reporter hint: how to spot its config, how to tell
 * whether a machine-readable report is already wired, and what to suggest when
 * it is not.
 *
 * EVERY RUNNER IN THE TEST LANE HAS A ROW, because the lane is
 * runner-agnostic now: the structured identity leg reads JUnit XML, which
 * vitest, jest, pytest, go and cargo-nextest can all write, so the hint is a
 * one-line reporter setup per runner rather than a vitest-only note. vitest
 * keeps its dedicated `tenjin-vitest-reporter` row as well — it carries its
 * own `startTime`, which is a stronger window check than a file mtime — and is
 * checked first.
 */
interface TestReporterFramework {
  /** Name used in the hint text. */
  name: string;
  /** Dedicated config filenames to look for in cwd, in priority order. */
  configFiles: string[];
  /** package.json dependency key that marks this framework present with no dedicated config file. */
  depName: string;
  /**
   * A config file shared with other tooling (`vite.config.*`) only counts when
   * its source matches this pattern; otherwise a Vite-only project with no
   * test block at all would be misread as an unconfigured vitest.
   */
  sharedConfigNeedsPattern?: RegExp;
  /**
   * Heuristic, plain-text scan of the config source — never a config
   * evaluation. Answers whether the tenjin reporter looks already wired.
   */
  hasJsonReporter: (source: string) => boolean;
  /** Doctor detail line for a framework detected without that reporter. */
  detail: string;
  /** Doctor fix line: the snippet to add. */
  fix: (reporterPath: string) => string;
}

const TEST_REPORTER_FRAMEWORKS: readonly TestReporterFramework[] = [
  {
    name: 'vitest',
    // Kept in step with push-scripts.ts's own TEST_CONFIG_FILES (tenjin-agent#278
    // nit 2): a repo on `vitest.config.cts`/`.cjs` cleared the failure arm's own
    // read but never got this hint, since this list was a strict subset.
    configFiles: [
      'vitest.config.ts',
      'vitest.config.mts',
      'vitest.config.cts',
      'vitest.config.js',
      'vitest.config.mjs',
      'vitest.config.cjs',
      'vite.config.ts',
      'vite.config.mts',
      'vite.config.js',
      'vite.config.mjs',
    ],
    depName: 'vitest',
    sharedConfigNeedsPattern: /\btest\s*:/,
    // EITHER STRUCTURED REPORT COUNTS. The tenjin reporter is preferred (it
    // stamps its own `startTime`, which tells "this run" from "the run before
    // it" without trusting a file mtime), but a `junit` reporter writing an
    // outputFile is read by the same lane and is a perfectly good answer, so a
    // repo that already has one is not nagged about the other.
    hasJsonReporter: (source) =>
      /reporters\s*:/.test(source) &&
      (/tenjin-vitest-reporter/.test(source) || /['"]junit['"]/.test(source)),
    detail:
      'vitest detected without a machine-readable report — test-failure matching falls back to console parsing (lower precision)',
    // The reporter's own path, not a relative guess: `tenjin install`/`push on`
    // always writes it to this exact spot, so the snippet works pasted verbatim.
    // Also names WHERE the report lands: it holds every failure's full message
    // and stack, absolute paths included (tenjin-agent#278, round 1 verdict
    // note) — worth telling an operator adopting this for the first time.
    fix: (reporterPath) =>
      `Add to vitest.config.ts: reporters: ['default', ['${reporterPath}', { outputFile: '.vitest-report.json' }]] — or, for the portable JUnit path, reporters: ['default', ['junit', { outputFile: '.tenjin/junit.xml' }]]. Add the report to .gitignore (it holds full failure messages and absolute paths)`,
  },
  {
    name: 'jest',
    configFiles: ['jest.config.ts', 'jest.config.js', 'jest.config.mjs', 'jest.config.cjs'],
    depName: 'jest',
    hasJsonReporter: (source) => /jest-junit/.test(source),
    detail:
      'jest detected without a JUnit report — test-failure matching falls back to console parsing (lower precision)',
    fix: () =>
      "Add to jest.config.js: reporters: ['default', ['jest-junit', { outputDirectory: '.tenjin', outputName: 'junit.xml' }]] (pnpm add -D jest-junit) — and add .tenjin/junit.xml to .gitignore",
  },
  {
    name: 'pytest',
    configFiles: ['pytest.ini', 'pyproject.toml', 'setup.cfg', 'tox.ini'],
    depName: 'pytest',
    // A shared config only counts once it actually configures pytest.
    sharedConfigNeedsPattern: /\[(?:tool\.)?pytest/,
    hasJsonReporter: (source) => /--junitxml/.test(source),
    detail:
      'pytest detected without a JUnit report — test-failure matching falls back to console parsing (lower precision)',
    fix: () =>
      'Add to pytest.ini (or [tool.pytest.ini_options] in pyproject.toml): addopts = --junitxml=.tenjin/junit.xml — and add .tenjin/junit.xml to .gitignore',
  },
  {
    name: 'go',
    configFiles: ['go.mod'],
    depName: '',
    // go's report is a FLAG, not config, so nothing in the repo says "wired".
    // The existing-report check in {@link checkTestReporterHints} is what
    // silences this row once the repo actually produces one.
    hasJsonReporter: () => false,
    detail:
      'go tests write no machine-readable report by default — test-failure matching falls back to console parsing (lower precision)',
    fix: () =>
      'Run tests through gotestsum: gotestsum --junitfile .tenjin/junit.xml ./... — and add .tenjin/junit.xml to .gitignore',
  },
  {
    name: 'cargo',
    configFiles: ['Cargo.toml'],
    depName: '',
    // NOT A FLAG, unlike go's: cargo-nextest has no `--junit` option at all.
    // JUnit is a PROFILE setting in `.config/nextest.toml`, and the report
    // lands under `target/nextest/<profile>/`. `detectFrameworkConfig` reads
    // `Cargo.toml`, which never carries it, so this row is silenced by the
    // existing-report check (which now knows nextest's own output path) rather
    // than by anything in the config it scanned.
    hasJsonReporter: () => false,
    detail:
      'cargo tests write no machine-readable report by default — test-failure matching falls back to console parsing (lower precision)',
    fix: () =>
      'Run tests through cargo-nextest and turn its JUnit profile on: add [profile.default.junit] path = "junit.xml" to .config/nextest.toml, then `cargo nextest run` writes target/nextest/default/junit.xml (already gitignored with target/)',
  },
];

/** ⚠ MIRRORED with `JUNIT_DEFAULT_PATHS` in lib/push-scripts.ts: the paths the
 *  failure arm's structured identity leg actually reads. A report sitting at
 *  one of them is what silences every row of the table above. */
const JUNIT_DOCTOR_PATHS = [
  '.tenjin/junit.xml',
  'junit.xml',
  'test-results/junit.xml',
  'reports/junit.xml',
  'target/nextest/default/junit.xml',
];

/**
 * Whether `.gitignore` covers `rel`, and whether git already tracks it.
 *
 * A FILE READ, NEVER A GIT SPAWN — the same rule the failure arm and
 * `tenjin sync` both follow for reading `origin`. So this is a deliberately
 * simple `.gitignore` reader: exact lines, a leading `/`, and a directory
 * prefix (`target/` covering `target/nextest/default/junit.xml`). It does not
 * implement negation, `**` globbing or nested `.gitignore` files, so it can
 * only ever be WRONG IN THE NOISY DIRECTION — a warn on a path some pattern
 * this cannot read does cover — and a warn names the remedy rather than
 * blocking anything.
 */
async function isGitIgnored(cwd: string, rel: string): Promise<boolean> {
  let text: string;
  try {
    text = await readFile(join(cwd, '.gitignore'), 'utf8');
  } catch {
    return false;
  }
  const path = rel.split('\\').join('/');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#') || line.startsWith('!')) continue;
    const pattern = line.replace(/^\//, '');
    if (pattern === path) return true;
    if (pattern.endsWith('/') && path.startsWith(pattern)) return true;
    if (!pattern.includes('/') && path.split('/').includes(pattern)) return true;
  }
  return false;
}

/** Whether git's index already holds `rel`, read straight out of `.git/index`'s
 *  path table rather than by spawning git. A false negative reads as "not
 *  committed", which is the quiet answer. */
async function isTrackedByGit(cwd: string, rel: string): Promise<boolean> {
  let index: Buffer;
  try {
    index = await readFile(join(cwd, '.git', 'index'));
  } catch {
    return false;
  }
  // Index entries store the path followed by NUL padding, so the terminator is
  // what makes this a whole-path match rather than a prefix one: without it
  // `junit.xml` would also match a tracked `reports/junit.xml.bak`.
  return index.includes(`${rel.split('\\').join('/')}\0`);
}

/** What {@link detectFrameworkConfig} found, or 'dep-only' for a dependency with no dedicated config file. */
type FrameworkConfigFound = { path: string; source: string } | 'dep-only';

/**
 * Does this project have `fw` at all, and if so, from what? A dedicated config
 * file wins over a bare dependency, since only the file's source can be
 * scanned for a reporter; a `vite.config.*` file only counts once its source
 * matches {@link TestReporterFramework.sharedConfigNeedsPattern}, so a Vite
 * project with no `test:` block is not read as unconfigured vitest.
 */
async function detectFrameworkConfig(
  cwd: string,
  fw: TestReporterFramework,
): Promise<FrameworkConfigFound | null> {
  for (const file of fw.configFiles) {
    let source: string;
    try {
      source = await readFile(join(cwd, file), 'utf8');
    } catch {
      continue;
    }
    if (
      file.startsWith('vite.config') &&
      fw.sharedConfigNeedsPattern !== undefined &&
      !fw.sharedConfigNeedsPattern.test(source)
    ) {
      continue;
    }
    return { path: join(cwd, file), source };
  }
  try {
    const pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')) as {
      devDependencies?: Record<string, unknown>;
      dependencies?: Record<string, unknown>;
    };
    if (fw.depName in (pkg.devDependencies ?? {}) || fw.depName in (pkg.dependencies ?? {})) {
      return 'dep-only';
    }
  } catch {
    // No package.json, or it does not parse; nothing more to detect from.
  }
  return null;
}

/**
 * WARN-level (never fails doctor), and silent unless there is something to
 * say: a project with no recognized test framework, or one whose config
 * already wires a report the test lane can read, gets no line at all — the same "nothing to report" posture as
 * {@link checkStoreJournal}. Detection is a plain-text scan of config source,
 * described as heuristic in every doc that mentions it: never a config
 * evaluation, so it can both miss a reporter wired through a shared helper
 * and mistake a commented-out one for live.
 */
async function checkTestReporterHints(cwd: string, dataDir: string): Promise<BuiltCheck | null> {
  // A REPORT THAT ALREADY EXISTS SETTLES IT, whatever the config says. go's
  // report comes from a command-line flag and cargo-nextest's from a profile in
  // a file this never scans, so for neither is there anything in the repo to
  // detect — and for every runner, a file at one of the paths the failure arm
  // actually reads is better evidence than a regex over a config.
  //
  // ...BUT AN IGNORED ONE. A JUnit report holds every failure's full message
  // and stack with absolute paths in it, so a report that is not gitignored is
  // one commit away from being pushed, and a report ALREADY COMMITTED is worse
  // than none: it silences this row forever while the failure arm's mtime check
  // rejects it on every run, so the operator is told nothing and gets nothing.
  for (const rel of JUNIT_DOCTOR_PATHS) {
    try {
      await readFile(join(cwd, rel), 'utf8');
    } catch {
      continue;
    }
    const committed = await isTrackedByGit(cwd, rel);
    if (committed) {
      return {
        result: {
          name: 'test-reporters',
          status: 'warn',
          required: false,
          detail: `${rel} is committed to git — it holds every failure's full message and stack, absolute paths included, and a committed report is never fresh enough for test-failure matching to read`,
          fix: `Run \`git rm --cached ${rel}\` and add ${rel} to .gitignore.`,
        },
      };
    }
    if (!(await isGitIgnored(cwd, rel))) {
      return {
        result: {
          name: 'test-reporters',
          status: 'warn',
          required: false,
          detail: `${rel} is not gitignored — it holds every failure's full message and stack, absolute paths included`,
          fix: `Add ${rel} to .gitignore.`,
        },
      };
    }
    return null;
  }
  const reporterPath = join(hooksDir(dataDir), PUSH_VITEST_REPORTER_FILE);
  for (const fw of TEST_REPORTER_FRAMEWORKS) {
    const found = await detectFrameworkConfig(cwd, fw);
    if (found === null) continue;
    const hasReporter = found !== 'dep-only' && fw.hasJsonReporter(found.source);
    if (hasReporter) continue;
    return {
      result: {
        name: 'test-reporters',
        status: 'warn',
        required: false,
        detail: fw.detail,
        fix: fw.fix(reporterPath),
      },
    };
  }
  return null;
}

/**
 * Are the generated hook/push scripts ON DISK current for this build?
 *
 * `tenjin update` bumps the npm-installed binary and nothing else; the scripts
 * under `<dataDir>/hooks` are written once, at `tenjin install` time, and stay
 * exactly those bytes until an operator reinstalls (`lib/install-location.ts`
 * refuses the self-heal outright on a git checkout, which is how this team
 * runs `main` — there is no `update` path that could have refreshed them).
 * tenjin-agent#242's hook-allowlist fix merged and kept producing junk pairings
 * on a machine that had not reinstalled for hours, which is the dogfooded case
 * this check exists to catch earlier than that.
 *
 * The skills-staleness check above (`compareWiredSkills`) is the model: same
 * "matches what this build would write now" compare, same silent-until-there
 * shape. Silent (`null`) when nothing is installed at all — a fresh machine
 * that never ran `tenjin install` is the skills/push-hooks checks' business,
 * not this one's. A script that IS installed but could not be READ is neither
 * of those: `compareHookScripts` reports it separately rather than dropping
 * it, so a permissions problem under the hooks directory (or a device node
 * where a script should be) is a `warn` an operator sees, not a diagnostic
 * that silently found "nothing wrong" by never looking.
 */
async function checkHookScripts(dataDir: string): Promise<BuiltCheck | null> {
  const { stale, present, unreadable } = await compareHookScripts(dataDir);
  if (present.length === 0 && unreadable.length === 0) return null;
  if (stale.length === 0 && unreadable.length === 0) {
    return {
      result: {
        name: 'hook scripts',
        status: 'ok',
        required: false,
        detail: `${present.length} generated hook/push script(s) on disk match this build`,
      },
    };
  }
  const parts: string[] = [];
  if (stale.length > 0) {
    parts.push(
      `${stale.length} of ${present.length} readable script(s) are stale (${stale.join(', ')})`,
    );
  }
  if (unreadable.length > 0) {
    parts.push(`${unreadable.length} could not be read (${unreadable.join(', ')})`);
  }
  return {
    result: {
      name: 'hook scripts',
      status: 'warn',
      required: false,
      detail: `${parts.join('; ')}; agents may be running an older build's hook code`,
      fix:
        unreadable.length > 0
          ? 'Check permissions under the hooks directory, then `tenjin install`.'
          : 'tenjin install',
    },
  };
}

/**
 * The push experiment's TWO halves, asked separately, because either one alone
 * reports a healthy sidecar that does nothing: the generated scripts on disk
 * with no settings.json entries pointing at them (a `push on` whose settings
 * write refused), or seven entries pointing at scripts that are gone (a
 * half-finished uninstall, a moved data dir). Seven entries across six events,
 * so "half-wired" is a state with several ways in. Both counts are read from
 * the writer's own plan rather than stated here.
 *
 * ONE OF THOSE WAYS IN IS AN UPGRADE, and it needs its own sentence. `tenjin
 * update` refreshes hook BODIES and materializes no new surface
 * (tenjin-agent#224), so a machine that was wired before `SubagentStop` existed
 * runs the new subagent body under the old entries: every other arm works, the
 * child-capture half is simply never fired, and the generic "half wired" line
 * would send the operator hunting. The fix is `tenjin install`, once, which is
 * also what the release note says.
 *
 * Never required and never a fail: an experiment that is off-by-default cannot
 * take down the verb an operator runs when something else is broken.
 */
async function checkPushHooks(homeDir: string, dataDir: string): Promise<BuiltCheck> {
  const scripts = await pushScriptsPresent(dataDir);
  const entries = await countPushHookEntries(homeDir, dataDir);
  const where = entries.path === null ? 'no settings.json found' : entries.path;
  const registered = `${entries.present}/${entries.planned} hook entries registered (${where})`;
  if (scripts && entries.present === entries.planned) {
    return {
      result: {
        name: 'push hooks',
        status: 'ok',
        required: false,
        detail: `hooks.push is on: all ${PUSH_SCRIPT_FILES.length} push scripts written, ${registered}`,
      },
    };
  }
  // The upgrade shape: everything else is registered and only the newest event
  // is not. Named before the generic warn, because the remedy is a different
  // command.
  if (scripts && entries.missing.length === 1 && entries.missing[0] === 'SubagentStop') {
    return {
      result: {
        name: 'push hooks',
        status: 'warn',
        required: false,
        detail: `hooks.push is on and ${registered}, but the SubagentStop entry is missing: this machine was wired before that arm existed, so a subagent's finding is never captured at the end of the child that settled it. tenjin update refreshes hook bodies and adds no new entry`,
        fix: 'tenjin install',
      },
    };
  }
  return {
    result: {
      name: 'push hooks',
      status: 'warn',
      required: false,
      detail: `hooks.push is on, but the sidecar is only half wired: ${
        scripts
          ? `all ${PUSH_SCRIPT_FILES.length} push scripts are written`
          : 'one or more push scripts are missing'
      }, ${registered}. Nothing runs unless both halves are there`,
      fix: 'tenjin push on',
    },
  };
}

/**
 * The delegated session key `tenjin read` presents to recover a piece this wallet
 * already owns (`tenjin session start --scope read` mints it). Never required and
 * never a fail — `read` works without one — so ABSENT is `ok`: the normal
 * posture, not a defect. So are the states that are ordinary decay rather than
 * damage: an older CLI's file, a spent 24h expiry, a scope that does not cover
 * reading. One command re-mints all of them, and a check that yellowed on them
 * would be permanently yellow on any machine that ever minted a key.
 *
 * A genuine fault still warns, and the states are kept apart on purpose. A 0600 file
 * that is now group-readable, or one whose contents no longer parse, is a TAMPER
 * signal on a wallet-derived credential; `loadSessionFile` fails closed on both
 * and collapses them to "no session", which is the right instruction for a caller
 * that can re-mint and exactly the wrong report for the verb an operator runs
 * when something looks wrong. `readSessionFile` keeps them distinguishable and
 * this is the one caller that needs them.
 *
 * An unreadable file (EACCES after a `sudo` run, EIO) warns rather than throwing:
 * doctor is diagnostics, and a session cache nobody asked about must never take
 * down the run that was going to explain the rest of the machine.
 *
 * Reports address / origin / scope / expiry and nothing else. The delegation and
 * the private JWK never reach this output — doctor's payload is the single most
 * likely thing in this CLI to be pasted into an issue.
 */
async function checkSession(
  dataDir: string,
  now: () => number,
  origin: string | null,
): Promise<BuiltCheck> {
  const warn = (detail: string, data?: unknown): BuiltCheck => ({
    result: {
      name: 'session',
      status: 'warn',
      required: false,
      detail,
      fix: 'tenjin session start --scope read',
      ...(data !== undefined ? { data } : {}),
    },
  });

  const state = await readSessionFile(dataDir);
  if (state.kind === 'absent') {
    return {
      result: {
        name: 'session',
        status: 'ok',
        required: false,
        detail:
          'No session key; `tenjin read` delivers free and locally-cached pieces (`tenjin session start --scope read` adds owned-piece recovery)',
      },
    };
  }
  if (state.kind === 'loosened') {
    return warn(
      `Session key at ${sessionPath(dataDir)} is mode 0${state.mode.toString(8)}, not 0600, so it is refused; it holds a wallet-derived credential and was changed out of band. Delete it and re-mint`,
    );
  }
  // Same standing as `absent`: a cache this CLI cannot use, re-minted by one
  // command. A failing check here meant a permanent post-update warning.
  if (state.kind === 'outdated') {
    return {
      result: {
        name: 'session',
        status: 'ok',
        required: false,
        detail: `Cached session key at ${sessionPath(dataDir)} predates this CLI version (no \`${state.field}\`) and is not used; \`tenjin session start --scope read\` mints a current one`,
      },
    };
  }
  if (state.kind === 'corrupt') {
    return warn(`Session key at ${sessionPath(dataDir)} could not be parsed (${state.reason})`);
  }
  if (state.kind === 'unreadable') {
    return warn(`Session key at ${sessionPath(dataDir)} could not be read: ${state.message}`);
  }

  const file = state.file;
  // A base URL that is not an http(s) origin cannot be compared against, and this
  // is the diagnostic verb: it reports that and keeps going. The `config` check
  // above owns the fix for the value itself.
  if (origin === null) {
    return {
      result: {
        name: 'session',
        status: 'warn',
        required: false,
        detail: `Session key was minted for ${file.origin}, but the configured base URL is not an http(s) origin, so it cannot be matched`,
        fix: 'Set an absolute http(s) base URL: `tenjin config set baseUrl <url>`.',
        data: { address: file.address, origin: file.origin, scope: file.scope, exp: file.exp },
      },
    };
  }
  const data = { address: file.address, origin: file.origin, scope: file.scope, exp: file.exp };
  if (file.origin !== origin) {
    return warn(
      `Session key was minted for ${file.origin}, but the configured base URL is ${origin}; it is not presented off its own origin`,
      data,
    );
  }
  // Expiry and scope are DESIGNED DECAY, not faults. A delegation lives 24h by
  // construction, so warning on a spent one made every machine that ever ran
  // `tenjin session start` permanently yellow for behaving exactly as intended —
  // the same permanent-warning trap `outdated` above was already pulled out of.
  // Both are re-minted by the one command named in the detail. An expiry that
  // does not PARSE is a different thing and stays a warning: that is a malformed
  // file, not a spent one.
  if (!Number.isFinite(Date.parse(file.exp))) {
    return warn(
      `Session key for ${file.address} carries an unparseable expiry (exp ${file.exp})`,
      data,
    );
  }
  if (!scopeSatisfies(file.scope, 'read')) {
    return {
      result: {
        name: 'session',
        status: 'ok',
        required: false,
        detail: `Session key has scope ${file.scope}, which does not cover reading; \`tenjin session start --scope read\` mints one that does`,
        data,
      },
    };
  }
  if (!isSessionPresentable(file, now(), 'read', origin)) {
    return {
      result: {
        name: 'session',
        status: 'ok',
        required: false,
        detail:
          'Session key expired (normal after 24h); mint one with `tenjin session start --scope read` when you want free re-reads of owned pieces',
        data,
      },
    };
  }
  return {
    result: {
      name: 'session',
      status: 'ok',
      required: false,
      detail: `Session key ${file.address}, scope ${file.scope}, for ${file.origin}, expires ${file.exp}`,
      data,
    },
  };
}

async function checkReadPath(
  baseUrl: string,
  timeoutMs: number,
  fetchImpl?: typeof fetch,
  bypass?: ShelfBypass,
  /** Whether the bypass key is a remedy this machine can use; see {@link shelfKeyIsTheRemedy}. */
  shelfKeyRemedy = false,
): Promise<BuiltCheck> {
  // The shipped public read path, separate from the search-contract check above.
  // Probe the UNFILTERED listing: the server logs every nonblank first-page `q`
  // as agent search demand, so a `q` here would fabricate that demand into the
  // experiment this CLI exists to measure. Never add a `q` to this probe.
  const url = `${trimSlash(baseUrl)}/api/articles?limit=1`;
  const res = await fetchJson(url, {
    timeoutMs,
    fetchImpl,
    ...(bypass !== undefined ? { bypass } : {}),
  });
  if (!res.ok) {
    return {
      result: {
        name: 'read-path',
        status: 'fail',
        required: true,
        // Gate-aware on BOTH halves. The transport's message for a gate page is
        // "was not valid JSON", which read beside a fix about the key was one
        // check telling `--json` two stories about one response.
        detail:
          res.gateSuspected === true
            ? `Read path ${gateDetail(url, res)}`
            : `Read path ${url} failed: ${res.message}`,
        // Same gate-aware fix as api-contract (see shelfGateFix): the identical
        // protection page answers this probe too, and `--json` carries both.
        fix: shelfGateFix(res, bypass, shelfKeyRemedy) ?? FIX_CHECK_NETWORK_AND_BASE_URL,
      },
      failCode: 'API_UNREACHABLE',
    };
  }
  const items = isRecord(res.json) ? res.json.items : undefined;
  if (!Array.isArray(items)) {
    return {
      result: {
        name: 'read-path',
        status: 'fail',
        required: true,
        detail: `Read path ${url} did not return an items array`,
        fix: 'Point the configured base URL at a Tenjin API: `tenjin config set baseUrl <url>`.',
      },
      failCode: 'API_UNREACHABLE',
    };
  }
  return {
    result: { name: 'read-path', status: 'ok', required: true, detail: `Read path OK at ${url}` },
  };
}

/**
 * Diagnose the wallet the CLI would actually use, entirely through the ACTIVE
 * provider. An injected provider owns everything — no local file or env is touched.
 * With no injected provider we do ONE cheap fs/env probe purely to decide whether
 * any credential exists: none → emit the "no wallet" warn WITHOUT importing the
 * wallet lib (that import statically pulls viem, and a no-wallet run must not parse
 * it). Otherwise the provider describes itself (address + source), PROVES the
 * credential can sign when it can do so without prompting (#70), reports its own
 * custody warnings, and the balance probes describe()'s address. A custody problem
 * (bad key, provider refusal) is warn-level, never a hard fail.
 */
async function checkWallet(
  ctx: CommandContext,
  deps: DoctorDeps,
  env: NodeJS.ProcessEnv,
  rpcUrl: string,
): Promise<CheckResult[]> {
  const provider = deps.provider ?? (await resolveLocalProviderOrNull(ctx, env, deps));
  if (provider === null) return [noWalletCheck()];

  const { describeWallet } = await import('../lib/wallet');
  let desc: WalletDescription;
  try {
    desc = await describeWallet(provider);
  } catch (err) {
    if (err instanceof CliError && err.code === 'WALLET_MISSING') return [noWalletCheck()];
    return [walletWarn(err)];
  }

  const checks: CheckResult[] = [walletCheck(desc, await verifyWallet(provider))];
  // Custody warnings are the provider's own (perms, env-shadow for the local
  // provider; none for a remote one). Render each as a warn check; the fix text,
  // when there is one, is carried inline in the warning string.
  for (const warning of (await provider.diagnostics()).warnings) {
    checks.push({ name: 'wallet-custody', status: 'warn', required: false, detail: warning });
  }
  checks.push(await checkBalance(desc.address, rpcUrl));
  return checks;
}

/**
 * The active local provider, or null when no credential exists at all. The null
 * path never imports the wallet lib, keeping a no-wallet doctor run off viem.
 */
async function resolveLocalProviderOrNull(
  ctx: CommandContext,
  env: NodeJS.ProcessEnv,
  deps: DoctorDeps,
): Promise<WalletProvider | null> {
  const envKey = env.TENJIN_WALLET_KEY;
  const envKeySet = typeof envKey === 'string' && envKey.length > 0;
  if (!envKeySet && !(await walletFileExists(ctx.dataDir))) return null;
  const { resolveWalletProvider } = await import('../lib/wallet');
  return resolveWalletProvider(ctx, {
    ...(deps.walletPassphrase !== undefined ? { passphrase: deps.walletPassphrase } : {}),
  });
}

/**
 * Ask the provider to prove the credential can sign (#70). A provider without a
 * `verify` is not a failure and not a pass: it is the `unverified` state, same as
 * a keystore whose passphrase only a human could supply. A provider that throws
 * is treated the same way — doctor reports what it could not establish and keeps
 * going; it never turns a diagnostic's own failure into a verdict about the
 * wallet.
 */
async function verifyWallet(provider: WalletProvider): Promise<WalletVerification> {
  if (provider.verify === undefined) {
    return {
      status: 'unverified',
      detail: `provider "${provider.id}" cannot verify without a key`,
    };
  }
  try {
    return await provider.verify();
  } catch (err) {
    return {
      status: 'unverified',
      detail: `verification could not run (${err instanceof Error ? err.message : String(err)})`,
    };
  }
}

/**
 * The wallet check, with the verification folded INTO its status rather than
 * reported beside it. #70 was exactly a green `wallet` line above an unopenable
 * keystore, so an `ok` here has to mean the key is usable, not merely that a file
 * parsed. Still never `required` and never a `fail`: a wallet nobody can open is
 * a real problem, but `read` and `search` work without one, so it must not move
 * the exit code.
 */
function walletCheck(desc: WalletDescription, v: WalletVerification): CheckResult {
  const head = `Wallet ${desc.address} (${desc.credentialSource})`;
  if (v.status === 'broken') {
    return {
      name: 'wallet',
      status: 'warn',
      required: false,
      detail: `${head}: ${v.detail}`,
      fix: v.fix,
    };
  }
  if (v.status === 'unverified') {
    return {
      name: 'wallet',
      status: 'warn',
      required: false,
      detail: `${head} present, not verified: ${v.detail}`,
      fix: 'Set TENJIN_WALLET_PASSPHRASE, or store the passphrase in your OS credential store, so doctor can prove the keystore still opens.',
    };
  }
  return { name: 'wallet', status: 'ok', required: false, detail: `${head}, ${v.detail}` };
}

function noWalletCheck(): CheckResult {
  return {
    name: 'wallet',
    status: 'warn',
    required: false,
    detail: 'No wallet; needed only for buy/publish',
    fix: 'tenjin wallet create',
    data: { credential: 'absent' },
  };
}

/**
 * Is this the check that says there is no credential at all? `install` prints its
 * own line for that state and drops the duplicate, so it has to recognise THIS
 * check and not merely one named `wallet`: a warn about a credential that exists
 * and does not work (an unopenable keystore, an invalid TENJIN_WALLET_KEY) shares
 * the name and is the one wallet state nothing else in install's output carries.
 */
export function isNoWalletCheck(c: CheckResult): boolean {
  return c.name === 'wallet' && isRecord(c.data) && c.data.credential === 'absent';
}

function walletWarn(err: unknown): CheckResult {
  return {
    name: 'wallet',
    status: 'warn',
    required: false,
    detail: err instanceof Error ? err.message : String(err),
    ...(err instanceof CliError && err.fix !== undefined ? { fix: err.fix } : {}),
  };
}

/**
 * Balance is best-effort: a zero balance is a fundable warning and an RPC flake
 * must never fail doctor. viem loads only here, via a lazy import, so a doctor
 * run without a wallet never parses the viem chunk.
 */
async function checkBalance(address: string, rpcUrl: string): Promise<CheckResult> {
  try {
    const { getUsdcBalance } = await import('../lib/usdc');
    const balance = await getUsdcBalance(address as `0x${string}`, rpcUrl);
    if (balance === 0n) {
      return {
        name: 'balance',
        status: 'warn',
        required: false,
        detail: 'Wallet USDC balance is 0',
        fix: 'Fund it with `tenjin wallet fund` (card via Coinbase), or send USDC on Base. $5 covers ~50 typical resources.',
      };
    }
    const money = toMoney(balance.toString());
    // Pocket-money posture (roadmap B2): a plaintext-adjacent local key should
    // hold only small change, so a balance over ~$20 is a warn, not an error.
    if (balance > POCKET_MONEY_CEILING_ATOMIC) {
      return {
        name: 'balance',
        status: 'warn',
        required: false,
        detail: `Balance ${money.usd} USDC is above the ~$20 pocket-money ceiling`,
        fix: 'Keep only small change in the CLI wallet; sweep the excess to cold storage.',
      };
    }
    return {
      name: 'balance',
      status: 'ok',
      required: false,
      detail: `Balance ${money.usd} USDC (${money.atomic} atomic)`,
    };
  } catch (err) {
    return {
      name: 'balance',
      status: 'warn',
      required: false,
      detail: `Could not read balance: ${err instanceof Error ? err.message : String(err)}`,
      fix: 'Check rpcUrl or retry; a balance read failure never fails doctor.',
    };
  }
}

export function renderDoctorHuman(io: Io, checks: CheckResult[]): string[] {
  const nameWidth = Math.max(...checks.map((c) => c.name.length));
  const lines: string[] = [];
  for (const c of checks) {
    const icon =
      c.status === 'ok'
        ? paint(io, 'green', '✓')
        : c.status === 'warn'
          ? paint(io, 'yellow', '!')
          : paint(io, 'red', '✗');
    // `detail` and `fix` interpolate SERVER-sourced strings (the OpenAPI
    // info.version, a provider's error text), so a newline or ANSI in a hostile
    // deployment's version string could forge extra lines here — including a
    // convincing closing pointer at a URL of its choosing. Sanitize at the render
    // seam: output.ts exempts doctor on the assumption it only paints its OWN
    // text, which has not been true since these lines began carrying server text.
    lines.push(
      `${icon} ${c.name.padEnd(nameWidth)}  ${paint(io, 'dim', sanitizeForTerminal(c.detail))}`,
    );
    if (c.status !== 'ok' && c.fix !== undefined) {
      lines.push(`    ${paint(io, 'dim', `fix: ${sanitizeForTerminal(c.fix)}`)}`);
    }
  }
  return lines;
}

/**
 * Color for stderr, honoring NO_COLOR and the target's color depth: styleText
 * takes the stderr stream when it is a genuine Stream (it throws on anything
 * else, so a test/redirected sink falls back to the default plain check).
 */
function paint(io: Io, format: Parameters<typeof styleText>[0], text: string): string {
  if (io.stdout instanceof Stream) return styleText(format, text, { stream: io.stdout });
  return styleText(format, text);
}

function infoVersion(json: unknown): string | undefined {
  if (!isRecord(json)) return undefined;
  const info = json.info;
  if (!isRecord(info)) return undefined;
  return typeof info.version === 'string' ? info.version : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
