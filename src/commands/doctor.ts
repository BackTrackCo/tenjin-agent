import { styleText } from 'node:util';
import { Stream } from 'node:stream';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lstat, rm, stat } from 'node:fs/promises';
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
import { skillMaterialize } from '../lib/skill-materialize';
import type { HarnessWiring, NotInvocableReason } from '../lib/skill-wiring';
import type { Harness } from '../adapters/types';
import { fetchJson, type FetchJsonFailure, type ShelfBypass } from '../lib/http';
import { loadRawConfig, resolveSettings } from '../lib/config';
import {
  isTeamModeConfig,
  isTeamShelfOrigin,
  loadProjectConfig,
  resolveShelfBypass,
} from '../lib/settings';
import { tryOriginOf, trimSlash } from '../lib/url';
import { configPath, dataDir as resolveDataDir, loopDbPath } from '../lib/paths';
import { toMoney } from '../lib/money';
import { walletFileExists } from '../lib/wallet/store';
import { sanitizeForTerminal } from '../lib/output';
import { modeGatedPointer, recommendedPermissions } from '../lib/permissions';
import {
  claudeSettingsPath,
  inspectFreeVerbRules,
  MODE_GATED_RULES,
} from '../lib/harness-permissions';
import { hookBundlesPresent, registeredHooks } from '../lib/harness-hooks';
import { ADAPTERS } from '../adapters/registry';
import { existsSync } from 'node:fs';
import { health, readPid } from '../hooks/shim';
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
import { openLoopDbForCli } from '../lib/loop-db';
import type { LoopDb } from '../hooks/store';
import { runRetention } from '../daemon/retention';

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
 * the secret itself never reaches any check output.
 */
const FIX_SET_SHELF_BYPASS =
  'If that deployment is access-protected, set the team shelf key: `tenjin config set shelfBypassSecret <value>`.';
/**
 * Same page, but the probe CARRIED the configured key and still did not get
 * past. Telling this machine to set the secret it already sent (the stale-key
 * case: a rotated Vercel bypass token answers the 200 gate page, a 401, or the
 * 307 interstitial) would read as "doctor says my config is fine as is".
 */
const FIX_ROTATE_SHELF_BYPASS =
  'The configured shelfBypassSecret was sent and did not get past, so it is stale or rotated: `tenjin config set shelfBypassSecret <value>`.';
/**
 * A keyed probe was redirected, but to the SAME host it asked for: an `http://`
 * base URL that 301s to https, or a host normalising to its canonical name. The
 * key was refused by nothing here, so the rotate line would invert #218 all over
 * again, blaming the setting that was right. `baseUrl` is the one that moves.
 */
const FIX_FOLLOW_REDIRECT_IN_BASE_URL =
  'That URL redirects: point the configured base URL at the canonical host it names (`tenjin config set baseUrl <url>`).';
/**
 * The same page, from a URL where the team key is not the answer. Naming
 * `baseUrl` would be wrong too: something answered, it just was not Tenjin. So
 * this describes what happened rather than prescribing a setting.
 */
const FIX_PAGE_NOT_THE_API =
  'Something answered with a page instead of the API (a proxy, a captive portal, or a sign-in wall); check your network path and the configured base URL (`tenjin config get baseUrl`).';

/**
 * A CheckResult plus the error code to raise if it is a *required* failure. Only
 * required checks carry a `failCode`; the outcome step raises the first one, so
 * the failure envelope's `error.code` names what actually broke (an `api` that
 * is unreachable and one that is malformed differ) while still carrying the
 * whole check list.
 */
interface BuiltCheck {
  result: CheckResult;
  failCode?: ErrorCode;
}

export interface DoctorDeps {
  /** Environment for wallet-key detection and settings precedence. */
  env?: NodeJS.ProcessEnv;
  /** The loop-database open; tests inject a failing one to exercise the
   * damaged-install diagnosis without a damaged install. */
  openLoopDb?: typeof openLoopDbForCli;
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
  const teamMode = isTeamModeConfig(config);
  const built: BuiltCheck[] = [
    checkNode(),
    // One open, two facts: the file opens, and what it holds that is waiting.
    ...checkLoopDb(ctx.dataDir, deps.openLoopDb ?? openLoopDbForCli, teamMode),
  ];
  // Only when there is something to say: a machine on the default data dir is
  // the ordinary case and gets no line about it.
  const redirected = checkDataDirOverride(env);
  if (redirected !== null) built.push(redirected);
  built.push(
    configCheck,
    // The two baseUrl probes carry the team shelf's bypass. Without it both
    // report a protected team deployment as unreachable, which is the check
    // saying "your CLI is broken" about the one setting that is right.
    ...(await checkShelfContract(
      baseUrl,
      ctx.flags.timeout,
      deps.fetchImpl,
      bypass,
      shelfKeyIsTheRemedy(settings, bypass),
    )),
    await checkReadPath(
      baseUrl,
      ctx.flags.timeout,
      deps.fetchImpl,
      bypass,
      shelfKeyIsTheRemedy(settings, bypass),
    ),
  );

  // Silent unless one of the two settings claims a team shelf, so a default
  // machine gets no check about a feature it never turned on.
  const teamShelf = checkTeamShelf(settings, bypass);
  if (teamShelf !== null) built.push(teamShelf);

  // Silent (nothing pushed) on a machine with no hook entries of ours at all;
  // see checkHooks.
  built.push(
    ...(await checkHooks(home, ctx.dataDir, env, deps.openLoopDb ?? openLoopDbForCli)),
    await checkSkills(
      home,
      which,
      requested,
      settings.bazaarPay.value,
      deps.skillsSourceDir,
      // The raw config, not resolved settings: the staleness compare has to shape
      // the packaged copies the way the WRITERS shaped them, and they read the
      // machine's configured mode with no flag layer (lib/skill-materialize).
      teamMode,
    ),
  );

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

  // The one line doctor adds to the check list, and only when there is one: it
  // names a rule this machine's own mode is missing, which is a finding. The
  // standing recommendation is `--json`'s `permissions` payload and the page it
  // documents; a pointer at that page on every run was a nag with no action
  // behind it, so there is none.
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
      ...(showModeLine && modeLine !== null ? ['', modeLine] : []),
    ],
  };
}

/**
 * The seven files and directories the loop database replaced. Deleted by
 * `doctor --prune`, never imported: the pairings and the outcome history in
 * `state.db` are a record of a system that no longer exists, and a one-time
 * importer is code that lives forever to serve a week (plan 03, owner
 * decision 3).
 *
 * `searches.json.lock` is in the list because the file version took an mkdir
 * mutex: a lock directory left behind by a crashed writer is never
 * stale-stolen (that is the protocol's whole safety property), so nothing
 * would ever remove it once its owner is gone.
 *
 * `hook-nags.json` and `hook-health.json` are the pre-daemon hook notebooks
 * (which loops were already nagged about; the dispatch arm's health log).
 * Nothing reads either since the loop database replaced them — no importer in
 * `src/` references them — so they are retired the same way (#315).
 */
const RETIRED_STATE_ENTRIES = [
  'push-ledger.jsonl',
  'searches.json',
  'searches.json.lock',
  'push',
  'candidates',
  'hook-nags.json',
  'hook-health.json',
] as const;

/** The retired database and the two WAL sidecars that are meaningless without it. */
const RETIRED_STORE_FILES = ['state.db', 'state.db-wal', 'state.db-shm'] as const;

/**
 * `tenjin doctor --prune`: run the loop ledger through its retention rule, then
 * delete what the loop database replaced.
 *
 * NAMED ENTRIES ONLY, and never a sweep. The data dir also holds the wallet,
 * the config and the library: those are the operator's, `install` did not
 * create them, and their loss is unrecoverable. So this removes exactly the
 * names below and reports each one, rather than deleting anything on a pattern.
 *
 * The retention pass is the same {@link runRetention} the daemon runs at its
 * idle exit — a bounded, batched delete of `fires` past `RETENTION_DAYS` or
 * `FIRES_ROW_CAP` with their `legs` by cascade, then a checkpoint and an
 * incremental vacuum. Running it here is what gives an operator whose daemon
 * never goes idle a way to reclaim the file by hand.
 */
export async function runDoctorPrune(ctx: CommandContext): Promise<CommandResult> {
  const db = openLoopDbForCli(ctx.dataDir);
  let retention;
  try {
    retention = runRetention(db, Date.now());
  } finally {
    db.close();
  }
  const removed: string[] = [];
  for (const name of [...RETIRED_STORE_FILES, ...RETIRED_STATE_ENTRIES]) {
    const path = join(ctx.dataDir, name);
    // A symlink parked at one of these names is not ours to follow, and a
    // socket or device is not ours to delete.
    const found = await lstat(path).catch(() => null);
    if (found === null || (!found.isFile() && !found.isDirectory())) continue;
    await rm(path, { recursive: found.isDirectory(), force: true });
    removed.push(path);
  }
  const lines = [
    `${loopDbPath(ctx.dataDir)}: removed ${retention.fires} fire(s), ${retention.marks} mark(s), ${retention.handoff} parked handoff(s)` +
      (retention.truncated ? ' (time-bounded; run it again to finish)' : ''),
    ...(removed.length === 0
      ? ['Nothing retired left to remove.']
      : ['Removed:', ...removed.map((path) => `  - ${path}`)]),
    'Kept: your wallet, config and library under the data dir.',
  ];
  return { data: { retention, removed }, humanLines: lines };
}

function checkNode(): BuiltCheck {
  const version = process.versions.node;
  const major = Number.parseInt(version.split('.')[0] ?? '0', 10);
  if (major >= 24) {
    return { result: { name: 'node', status: 'ok', required: true, detail: version } };
  }
  return {
    result: {
      name: 'node',
      status: 'fail',
      required: true,
      detail: `${version}, below the 24 this CLI needs`,
      fix: 'Install Node 24 or newer.',
    },
    failCode: 'NODE_UNSUPPORTED',
  };
}

/**
 * Does this machine's loop database open, and what is it holding?
 *
 * The whole of the loop's state — every fire and leg, the gate marks, the
 * error→fix pairings, the search record, the finding queue — is one SQLite
 * file opened through Node's built-in module. The daemon fails OPEN without
 * it, which is the right posture for a tool call and the wrong one for a
 * diagnosis: a machine whose loop has quietly stopped remembering anything
 * looks identical from the outside to one that simply had nothing to say. So
 * doctor opens it, which proves the module, the file and its shape in one go.
 *
 * THE OPEN IS THE PROBE: a separate `node:sqlite` import check answers a
 * strict subset of what opening the real file answers. The same open serves
 * the `pairings` line below, so the diagnosis costs one handle, not two.
 */
function checkLoopDb(dir: string, open: typeof openLoopDbForCli, teamMode: boolean): BuiltCheck[] {
  const path = loopDbPath(dir);
  try {
    const db = open(dir);
    try {
      return [
        { result: { name: 'store', status: 'ok', required: true, detail: `${path} open` } },
        ...(teamMode ? [checkPairings(db)] : []),
      ];
    } finally {
      db.close();
    }
  } catch (err) {
    return [
      {
        result: {
          name: 'store',
          status: 'fail',
          required: true,
          // Anyone reading this already cleared the >=24 preflight in src/index.ts,
          // so "upgrade Node" cannot be the remedy: the runtime is supported and
          // the open still failed, which points at the install — a damaged or
          // re-bundled dist (tsup once shipped `import("sqlite")`,
          // tenjin-agent#225), a patched runtime — or at a file another build's
          // daemon is holding open.
          detail: `${path} could not be opened, so the loop keeps no state at all: ${err instanceof Error ? err.message : String(err)}`,
          fix: 'Run `tenjin daemon stop` and retry; if it persists, reinstall tenjin-cli (npm i -g tenjin-cli@latest).',
        },
        failCode: 'INTERNAL',
      },
    ];
  }
}

/**
 * Fixes this machine worked out that no piece explains yet.
 *
 * A closed code-scope pairing with no `post_id` is an error someone already
 * solved here and nowhere else: the turn-end ask names each one with its key,
 * and `publish --key` stamps the pairing when the write-up lands. So this is a
 * count of what the shelf is still missing, never a defect — `ok` either way,
 * with no fix line, because the remedy is a piece only the agent that made the
 * fix can write.
 *
 * TEAM MODE ONLY: on the public marketplace there is no shelf for a teammate to
 * find the answer on, so the number would be a standing reproach with nowhere
 * to send it.
 */
function checkPairings(db: LoopDb): BuiltCheck {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM pairings
       WHERE post_id IS NULL AND scope = 'code' AND closed_at IS NOT NULL`,
    )
    .get() as unknown as { n?: unknown };
  const waiting = typeof row?.n === 'number' ? row.n : 0;
  return {
    result: {
      name: 'pairings',
      status: 'ok',
      required: false,
      detail:
        waiting === 0
          ? 'none waiting for the shelf'
          : `${waiting} fixed, not yet written up (the turn-end ask names them)`,
    },
  };
}

/**
 * Is this invocation pointed at a data dir that is not the machine's own?
 *
 * `TENJIN_DATA_DIR` is the documented way to run a second profile, a CI job or
 * an ephemeral agent (tenjin-agent#227), and it is silent about one
 * consequence: `lib/skill-heal.ts` stands its self-healing down under an
 * override, because the skills it would converge are machine-wide while the
 * mode that shapes them is read per invocation. Nothing else says so, so
 * doctor does — as a note, never a warning: this is what the operator asked
 * for.
 */
function checkDataDirOverride(env: NodeJS.ProcessEnv): BuiltCheck | null {
  if (resolveDataDir(env) === resolveDataDir({})) return null;
  return {
    result: {
      name: 'data-dir',
      status: 'ok',
      required: false,
      detail: `${resolveDataDir(env)} (TENJIN_DATA_DIR); skill self-healing stands down while it is set`,
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
      Object.keys(config).length === 0 ? 'no config file; using defaults' : configPath(dataDir);
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
 * response (`read` used to print the transport's raw "was not valid JSON"
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

/**
 * ONE `openapi.json`, two verdicts.
 *
 * `api` is required: the document proves a Tenjin API answered and names its
 * version. `search` is warn-only and rides the same response — the deployment
 * either advertises `/api/search` or predates search v3 (tenjin#137), which
 * `tenjin search` and the buy path that starts there need. Two fetches of one
 * document is what this was, and the second one's failure branch existed mostly
 * to avoid contradicting the first.
 *
 * It probes `/api/search`, the path the client actually calls. The
 * `/api/agent/search` alias it replaced answers 410 after one release, so a
 * deployment advertising ONLY the alias is exactly the case to warn about.
 */
async function checkShelfContract(
  baseUrl: string,
  timeoutMs: number,
  fetchImpl?: typeof fetch,
  bypass?: ShelfBypass,
  /** Whether the bypass key is a remedy this machine can use; see {@link shelfKeyIsTheRemedy}. */
  shelfKeyRemedy = false,
): Promise<BuiltCheck[]> {
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
    // The gate-aware fix rides BOTH verdicts: one response cannot be told to
    // set a key on one line and to check the base URL on the next.
    const fix =
      shelfGateFix(res, bypass, shelfKeyRemedy) ??
      (malformed ? FIX_POINT_AT_TENJIN_API : FIX_CHECK_NETWORK_AND_BASE_URL);
    return [
      {
        result: {
          name: 'api',
          status: 'fail',
          required: true,
          detail: gated
            ? gateDetail(url, res)
            : malformed
              ? `OpenAPI document at ${url} was not valid JSON`
              : `Could not reach the Tenjin API at ${url}: ${res.message}`,
          fix,
        },
        failCode: malformed ? 'CONTRACT_MISMATCH' : 'API_UNREACHABLE',
      },
      {
        result: {
          name: 'search',
          status: 'warn',
          required: false,
          detail: 'not confirmed: the same document did not answer',
          fix,
        },
      },
    ];
  }
  const search: BuiltCheck = hasSearchPath(res.json)
    ? { result: { name: 'search', status: 'ok', required: false, detail: 'advertised' } }
    : {
        result: {
          name: 'search',
          status: 'warn',
          required: false,
          detail: 'POST /api/search not advertised (this deployment predates search v3)',
          fix: 'Point the configured base URL at a deploy that has search v3: `tenjin config set baseUrl <url>`.',
        },
      };
  const version = infoVersion(res.json);
  if (version === undefined) {
    return [
      {
        result: {
          name: 'api',
          status: 'fail',
          required: true,
          detail: `OpenAPI document at ${url} is missing a string info.version`,
          fix: FIX_POINT_AT_TENJIN_API,
        },
        failCode: 'CONTRACT_MISMATCH',
      },
      search,
    ];
  }
  return [
    {
      result: {
        name: 'api',
        status: 'ok',
        required: true,
        detail: `Tenjin ${version} at ${baseUrl}`,
      },
    },
    search,
  ];
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
  requested: readonly Harness[],
  bazaarPay: boolean,
  skillsSourceDir: string | undefined,
  teamMode: boolean,
): Promise<BuiltCheck> {
  const present = detectHarnesses(home, which);
  const wiring = await readAllWiring(home);
  const data = {
    directories: wiring.map((w) => ({
      ...w,
      harnessPresent: harnessReads(home, w.dir, present),
      requested: harnessRequested(home, w.dir, requested),
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
        ? wiring.filter((w) => harnessInPlay(home, w.dir, present, requested))
        : [];
    return {
      result: {
        name: 'skills',
        status: 'warn',
        required: false,
        detail: `No Tenjin skills wired under ${home} (looked in .claude/skills and .agents/skills)`,
        fix: targeted.length > 0 ? fixFor(home, targeted) : 'tenjin install',
        data,
      },
    };
  }

  // Every directory in play must carry BOTH CLI skills, model-invocable. Anything less
  // is the defect, whether it is shadowed, half-installed, hosted-only or absent; a
  // directory neither detected nor asked for is described but never warned about.
  const broken = wiring.filter(
    (w) => harnessInPlay(home, w.dir, present, requested) && !cliSkillsWired(w),
  );
  if (broken.length > 0) {
    return {
      result: {
        name: 'skills',
        status: 'warn',
        required: false,
        detail: broken.map(describeProblem).join('; '),
        fix: fixFor(home, broken),
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
    if (!harnessInPlay(home, w.dir, present, requested)) continue;
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
        detail: `${CLI_SKILL_NAMES.join(' + ')} wired, but this build's packaged copies could not be read`,
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
        detail: `not from this CLI build (${stale.join(', ')}); agents are reading an older version's instructions`,
        // fixFor, like every neighbouring branch: a plain `tenjin install` targets
        // DETECTED harnesses only, so for a directory that exists because someone
        // passed --harness it would be a fix that never clears the warning.
        fix: fixFor(
          home,
          wiring.filter((w) => stale.includes(w.dir)),
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
      detail: `${CLI_SKILL_NAMES.join(' + ')}, current`,
      data,
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

/**
 * A fix that can actually clear the warning. A bare `tenjin install` only targets
 * the directories detection picks, so a problem in ~/.agents/skills on a
 * Claude-only machine needs `--harness codex` spelled out.
 */
function fixFor(home: string, dirs: HarnessWiring[]): string {
  const flags = [...new Set(dirs.map((w) => harnessFlagFor(home, w.dir)))];
  return `tenjin install ${flags.map((f) => `--harness ${f}`).join(' ')}`;
}

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
        detail: `${sanitizeForTerminal(baseUrl)}, and requests to it carry the bypass header`,
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
        detail: `this run's base URL came from ${settings.baseUrl.source === 'flag' ? 'a command-line override' : 'the environment'} (${sanitizeForTerminal(baseUrl)}), so the team shelf's bypass key was withheld and these probes ran unauthenticated`,
        fix: 'Run doctor with no base-URL override to check the configured team shelf.',
      },
    };
  }
  return {
    result: {
      name: 'team shelf',
      status: 'warn',
      required: false,
      detail: `shelfBypassSecret is set, but baseUrl is the public marketplace (${sanitizeForTerminal(baseUrl)}), so this machine is in PUBLIC mode`,
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
      detail: `${sanitizeForTerminal(baseUrl)} is a shelf of your own, but no shelfBypassSecret is set, so every probe above ran unauthenticated`,
      fix: 'Set the team shelf key so requests get past deployment protection: `tenjin config set shelfBypassSecret <value>`.',
    },
  };
}

/**
 * The loop's wiring, per harness, and silent on a machine with no entry of
 * ours: a fresh machine that never ran `tenjin install` is the skills check's
 * business, not this one's.
 *
 * `daemon` is the comparison that fails silently in the wild: the URL in
 * Claude's settings.json carries the port the daemon had bound WHEN INSTALL
 * RAN, and a daemon that later lost that port (a pinned `loop.port` changed, a
 * foreign listener took it, a second profile) comes back on another one.
 * Claude Code then posts every tool fire into a closed port and reports a
 * non-blocking `HTTP hook error` the operator never sees. `/health` tells the
 * two apart. A Codex entry names no port (it runs the shim, which finds the
 * daemon itself), so there the daemon is checked through `daemon.pid` alone.
 *
 * `entries` is Claude's file itself: how many of ours are registered, and its
 * mode, because that file carries the daemon token as a literal.
 *
 * `codex hooks` keeps two durable facts apart: configured (entries of ours in
 * hooks.json) and observed (fires the daemon recorded from Codex this week).
 * Install already carries the registrar's one-time `/hooks` activation step;
 * doctor does not parse Codex's private, versioned trust-ledger grammar.
 */
async function checkHooks(
  homeDir: string,
  dataDir: string,
  env: NodeJS.ProcessEnv,
  open: typeof openLoopDbForCli,
): Promise<BuiltCheck[]> {
  const out: BuiltCheck[] = [];
  const claude = await registeredHooks(ADAPTERS.claude, homeDir, dataDir, env);
  const codex = await registeredHooks(ADAPTERS.codex, homeDir, dataDir, env);
  if (claude.entries === 0 && codex.entries === 0) return out;
  out.push(await checkDaemon(claude.port, dataDir));
  if (claude.entries > 0) {
    const path = claudeSettingsPath(homeDir);
    const mode = await settingsMode(homeDir);
    const wide = mode !== null && (mode & 0o077) !== 0;
    out.push({
      result: wide
        ? {
            name: 'entries',
            status: 'warn',
            required: false,
            detail: `${claude.entries} in ${path}, mode ${mode.toString(8).padStart(3, '0')} — wider than 0600, and it carries the daemon token`,
            fix: `chmod 600 ${path}`,
          }
        : {
            name: 'entries',
            status: 'ok',
            required: false,
            detail: `${claude.entries} in ${path}`,
          },
    });
  }
  if (codex.entries > 0) {
    const observed = codexFiresThisWeek(dataDir, open);
    const facts = `${codex.entries} in ${codex.path}; ${observed} fire${observed === 1 ? '' : 's'} observed in ${WEEK_DAYS}d`;
    out.push({
      result: { name: 'codex hooks', status: 'ok', required: false, detail: facts },
    });
  }
  return out;
}

const WEEK_DAYS = 7;

/** Fires the daemon recorded from Codex in the last week; 0 when there is no
 *  ledger yet or it cannot be opened, which the `store` check reports itself. */
function codexFiresThisWeek(dataDir: string, open: typeof openLoopDbForCli): number {
  if (!existsSync(loopDbPath(dataDir))) return 0;
  try {
    const db = open(dataDir);
    try {
      const row = db
        .prepare("SELECT count(*) AS n FROM fires WHERE harness = 'codex' AND at >= ?")
        .get(Date.now() - WEEK_DAYS * 24 * 60 * 60 * 1000) as { n?: unknown } | undefined;
      return typeof row?.n === 'number' ? row.n : 0;
    } finally {
      db.close();
    }
  } catch {
    return 0;
  }
}

/**
 * The daemon behind the entries. With a port from Claude's `http` entries the
 * check is whether THAT port answers; with none (Codex alone), whether the
 * daemon `daemon.pid` names answers at all.
 */
async function checkDaemon(port: number | null, dataDir: string): Promise<BuiltCheck> {
  const pid = readPid(dataDir);
  const probe = port ?? pid?.port ?? null;
  const live = probe === null ? null : await health(probe);
  if (live !== null && live.data_dir === dataDir) {
    return {
      result: {
        name: 'daemon',
        status: 'ok',
        required: false,
        detail: `127.0.0.1:${probe}, pid ${live.pid}, v${live.version}`,
      },
    };
  }
  const moved = port !== null && pid !== null && pid.port !== port;
  const bundles = await hookBundlesPresent(dataDir);
  return {
    result: {
      name: 'daemon',
      status: 'warn',
      required: false,
      detail: `${port === null ? 'the entries run the shim' : `the entries point at 127.0.0.1:${port}`}, but ${moved ? `the daemon is on port ${pid.port} instead` : 'daemon not running'}${bundles ? '' : ', and no daemon bundle is installed'}; every hook fire is a silent ${port === null ? 'daemon-down line' : 'HTTP error'} until it is back`,
      fix: moved ? 'tenjin install' : 'tenjin daemon start',
    },
  };
}

/** The settings file's permission bits, or null when there is nothing to stat. */
async function settingsMode(homeDir: string): Promise<number | null> {
  if (process.platform === 'win32') return null;
  try {
    return (await stat(claudeSettingsPath(homeDir))).mode & 0o777;
  } catch {
    return null;
  }
}

async function checkReadPath(
  baseUrl: string,
  timeoutMs: number,
  fetchImpl?: typeof fetch,
  bypass?: ShelfBypass,
  /** Whether the bypass key is a remedy this machine can use; see {@link shelfKeyIsTheRemedy}. */
  shelfKeyRemedy = false,
): Promise<BuiltCheck> {
  // The shipped public read path, its own request: `api` and `search` share the
  // openapi document, and this probes what a reader actually fetches.
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
        name: 'read',
        status: 'fail',
        required: true,
        // Gate-aware on BOTH halves. The transport's message for a gate page is
        // "was not valid JSON", which read beside a fix about the key was one
        // check telling `--json` two stories about one response.
        detail:
          res.gateSuspected === true
            ? `Read path ${gateDetail(url, res)}`
            : `Read path ${url} failed: ${res.message}`,
        // Same gate-aware fix as `api` (see shelfGateFix): the identical
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
        name: 'read',
        status: 'fail',
        required: true,
        detail: `Read path ${url} did not return an items array`,
        fix: 'Point the configured base URL at a Tenjin API: `tenjin config set baseUrl <url>`.',
      },
      failCode: 'API_UNREACHABLE',
    };
  }
  return {
    result: { name: 'read', status: 'ok', required: true, detail: 'ok' },
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
  const head = `${desc.address} (${desc.credentialSource})`;
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
    detail: 'none; needed only for buy/publish',
    fix: 'tenjin wallet create',
    data: { credential: 'absent' },
  };
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
        detail: '$0.00 USDC',
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
        detail: `${money.usd} USDC, above the ~$20 pocket-money ceiling`,
        fix: 'Keep only small change in the CLI wallet; sweep the excess to cold storage.',
      };
    }
    return {
      name: 'balance',
      status: 'ok',
      required: false,
      detail: `${money.usd} USDC (${money.atomic} atomic)`,
    };
  } catch (err) {
    return {
      name: 'balance',
      status: 'warn',
      required: false,
      detail: `could not be read: ${err instanceof Error ? err.message : String(err)}`,
      fix: 'Check rpcUrl or retry; a balance read failure never fails doctor.',
    };
  }
}

/**
 * Where each check belongs on the page, and the order within a group.
 *
 * Four questions an operator actually asks — is this machine able to run the
 * CLI, can it reach the shelf, is the loop wired, can it pay — instead of one
 * flat list of fifteen. A check whose name is missing here would not render, so
 * the doctor test walks a full run and asserts every name is placed.
 */
const CHECK_GROUPS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['Environment', ['node', 'store', 'config', 'data-dir']],
  ['Shelf', ['api', 'read', 'search', 'team shelf']],
  ['Hooks', ['daemon', 'entries', 'codex hooks', 'skills', 'pairings']],
  ['Wallet', ['wallet', 'wallet-custody', 'balance']],
];

/**
 * One line per check under its group heading, and a `fix:` line ONLY where
 * there is something to fix. A fix under a passing check is advice nobody
 * asked for, and fifteen of them is the wall this rendering replaced.
 */
export function renderDoctorHuman(io: Io, checks: CheckResult[]): string[] {
  const nameWidth = Math.max(...checks.map((c) => c.name.length));
  const lines: string[] = [];
  for (const [group, names] of CHECK_GROUPS) {
    // The GROUP's order, not the build order: the page reads the same however
    // the checks were assembled. A name can match twice (a provider with two
    // custody warnings), so this filters rather than finds.
    const here = names.flatMap((name) => checks.filter((c) => c.name === name));
    if (here.length === 0) continue;
    lines.push(group);
    for (const c of here) {
      const icon =
        c.status === 'ok'
          ? paint(io, 'green', '✓')
          : c.status === 'warn'
            ? paint(io, 'yellow', '!')
            : paint(io, 'red', '✗');
      // `detail` and `fix` interpolate SERVER-sourced strings (the OpenAPI
      // info.version, a provider's error text), so a newline or ANSI in a
      // hostile deployment's version string could forge extra lines here.
      // Sanitize at the render seam: output.ts exempts doctor on the assumption
      // it only paints its OWN text, which has not been true since these lines
      // began carrying server text.
      lines.push(
        `  ${icon} ${c.name.padEnd(nameWidth)}  ${paint(io, 'dim', sanitizeForTerminal(c.detail))}`,
      );
      if (c.status !== 'ok' && c.fix !== undefined) {
        lines.push(`    ${paint(io, 'dim', `fix: ${sanitizeForTerminal(c.fix)}`)}`);
      }
    }
  }
  lines.push('', tally(checks));
  return lines;
}

/** `12 checks: 10 ok, 2 warn.` — a status with no count is left out. */
function tally(checks: CheckResult[]): string {
  const count = (status: CheckResult['status']): number =>
    checks.filter((c) => c.status === status).length;
  const parts = [
    `${count('ok')} ok`,
    ...(count('warn') > 0 ? [`${count('warn')} warn`] : []),
    ...(count('fail') > 0 ? [`${count('fail')} fail`] : []),
  ];
  return `${checks.length} checks: ${parts.join(', ')}.`;
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
