import { styleText } from 'node:util';
import { Stream } from 'node:stream';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { fetchJson, type ShelfBypass } from '../lib/http';
import { loadRawConfig, resolveSettings } from '../lib/config';
import {
  isTeamModeConfig,
  isTeamShelfOrigin,
  loadProjectConfig,
  resolveShelfBypass,
} from '../lib/settings';
import { tryOriginOf, trimSlash } from '../lib/url';
import { configPath, sessionPath } from '../lib/paths';
import { toMoney } from '../lib/money';
import { walletFileExists } from '../lib/wallet/store';
import { isSessionPresentable, readSessionFile, scopeSatisfies } from '../lib/session-present';
import { sanitizeForTerminal } from '../lib/output';
import { modeGatedPointer, permissionsPointer, recommendedPermissions } from '../lib/permissions';
import { inspectFreeVerbRules, MODE_GATED_RULES } from '../lib/harness-permissions';
import { PUSH_SCRIPT_FILES, countPushHookEntries, pushScriptsPresent } from '../lib/harness-hooks';
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
import { probeSqlite } from '../lib/state-store';

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
  const project = await loadProjectConfig(deps.cwd ?? process.cwd()).catch(() => null);
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

  const built: BuiltCheck[] = [
    checkNode(),
    await checkStateStore(deps.probeSqlite ?? probeSqlite),
    configCheck,
    // The three baseUrl probes carry the team shelf's bypass. Without it every
    // one of them reports a protected team deployment as unreachable, which is
    // the check saying "your CLI is broken" about the one setting that is right.
    await checkApiContract(baseUrl, ctx.flags.timeout, deps.fetchImpl, bypass),
    await checkReadPath(baseUrl, ctx.flags.timeout, deps.fetchImpl, bypass),
    await checkSearchContract(baseUrl, ctx.flags.timeout, deps.fetchImpl, bypass),
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
  ];

  // Only when the experiment is on. Off, there is nothing to be half-wired and
  // a permanently-present check about a feature nobody enabled is noise.
  if (config.hooks?.push === 'on') {
    built.push(await checkPushHooks(home, ctx.dataDir));
  }

  // Same rule: only when a secret is set is there a team shelf to be wrong about.
  const teamShelf = checkTeamShelf(settings, bypass);
  if (teamShelf !== null) built.push(teamShelf);

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

async function checkApiContract(
  baseUrl: string,
  timeoutMs: number,
  fetchImpl?: typeof fetch,
  bypass?: ShelfBypass,
): Promise<BuiltCheck> {
  const url = `${trimSlash(baseUrl)}/openapi.json`;
  const res = await fetchJson(url, {
    timeoutMs,
    fetchImpl,
    ...(bypass !== undefined ? { bypass } : {}),
  });
  if (!res.ok) {
    const malformed = res.kind === 'invalid-json';
    return {
      result: {
        name: 'api-contract',
        status: 'fail',
        required: true,
        detail: malformed
          ? `OpenAPI document at ${url} was not valid JSON`
          : `Could not reach the Tenjin API at ${url}: ${res.message}`,
        fix: malformed ? FIX_POINT_AT_TENJIN_API : FIX_CHECK_NETWORK_AND_BASE_URL,
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
): Promise<BuiltCheck> {
  const url = `${trimSlash(baseUrl)}/openapi.json`;
  const res = await fetchJson(url, {
    timeoutMs,
    fetchImpl,
    ...(bypass !== undefined ? { bypass } : {}),
  });
  if (!res.ok) {
    return {
      result: {
        name: 'search-contract',
        status: 'warn',
        required: false,
        detail: `Could not confirm the search endpoint at ${url}`,
        fix: 'Check the configured base URL (`tenjin config get baseUrl`); search/buy need the A2 endpoints deployed.',
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
 * the reachable wrong state is a machine with the bypass secret and `baseUrl`
 * still on the public marketplace. The CLI fails that safe to public mode —
 * publishes keep the client scan and the confirm cascade — but silently, and an
 * operator who believes they are on the team shelf would keep writing internal
 * notes at a command that sends them to tenjin.blog. Warn, never fail: public
 * mode is a working machine, just not the one they meant to configure.
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
  if (settings.shelfBypassSecret.value.length === 0) return null;
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
 * The push experiment's TWO halves, asked separately, because either one alone
 * reports a healthy sidecar that does nothing: the generated scripts on disk
 * with no settings.json entries pointing at them (a `push on` whose settings
 * write refused), or six entries pointing at scripts that are gone (a
 * half-finished uninstall, a moved data dir). Six entries across five events,
 * so "half-wired" is a state with several ways in. Both counts are read from
 * the writer's own plan rather than stated here.
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
        detail: `Read path ${url} failed: ${res.message}`,
        fix: FIX_CHECK_NETWORK_AND_BASE_URL,
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
