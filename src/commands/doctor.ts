import { styleText } from 'node:util';
import { Stream } from 'node:stream';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSkillsSource } from '../lib/skills-source';
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
import type {
  DirState,
  HarnessTarget,
  HarnessWiring,
  NotInvocableReason,
} from '../lib/skill-wiring';
import { fetchJson } from '../lib/http';
import { loadRawConfig, resolveSettings } from '../lib/config';
import { tryOriginOf, trimSlash } from '../lib/url';
import { configPath, sessionPath } from '../lib/paths';
import { toMoney } from '../lib/money';
import { walletFileExists } from '../lib/wallet/store';
import { isSessionPresentable, readSessionFile } from '../lib/session-present';
import { sanitizeForTerminal } from '../lib/output';
import { recommendedPermissions, renderPermissionsBlock } from '../lib/permissions';
import type { PartialConfig } from '../lib/config';
import type { ErrorCode } from '../schemas';
import type { Io } from '../lib/output';
import type { WalletDescription, WalletProvider } from '../lib/wallet';
import type { CommandContext, CommandResult } from '../context';

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
  /** Clock seam (ms since epoch) for the session-expiry check. */
  now?: () => number;
  /** Packaged skills to compare the wired copies against; defaults to this build's. */
  skillsSourceDir?: string;
}

/**
 * The full check list plus the first required failure, if any. `install` reuses
 * this to run the doctor checks as its last step and EMBED the summary without
 * throwing (D39: doctor is diagnostics, it never blocks the caller); `runDoctor`
 * wraps it and turns a required failure into the thrown failure envelope.
 */
export interface DoctorChecks {
  checks: CheckResult[];
  failure?: { code: ErrorCode; result: CheckResult };
}

export async function collectDoctorChecks(
  ctx: CommandContext,
  deps: DoctorDeps = {},
): Promise<DoctorChecks> {
  const env = deps.env ?? process.env;
  const { config, check: configCheck } = await loadConfigForDoctor(ctx.dataDir);
  const settings = resolveSettings({ config, flags: { baseUrl: ctx.flags.baseUrl }, env });
  const baseUrl = settings.baseUrl.value;

  const built: BuiltCheck[] = [
    checkNode(),
    configCheck,
    await checkApiContract(baseUrl, ctx.flags.timeout, deps.fetchImpl),
    await checkReadPath(baseUrl, ctx.flags.timeout, deps.fetchImpl),
    await checkSearchContract(baseUrl, ctx.flags.timeout, deps.fetchImpl),
    await checkSkills(
      deps.homeDir ?? homedir(),
      deps.which ?? ((bin) => onPath(bin, env)),
      config.install?.harness ?? [],
      deps.skillsSourceDir,
    ),
    await checkSession(ctx.dataDir, deps.now ?? Date.now, tryOriginOf(baseUrl)),
  ];

  // The wallet/custody/balance checks all come from the ACTIVE provider: it owns
  // describe() and diagnostics(), so doctor never runs its own fs/env probe.
  for (const result of await checkWallet(ctx, deps, env, settings.rpcUrl.value)) {
    built.push({ result });
  }

  const checks = built.map((b) => b.result);
  const firstFail = built.find((b) => b.result.required && b.result.status === 'fail');
  if (firstFail === undefined) return { checks };
  return { checks, failure: { code: firstFail.failCode ?? 'INTERNAL', result: firstFail.result } };
}

export async function runDoctor(
  ctx: CommandContext,
  deps: DoctorDeps = {},
): Promise<CommandResult> {
  const { checks, failure } = await collectDoctorChecks(ctx, deps);
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
      details: { checks, permissions: recommendedPermissions() },
    });
  }

  // The discoverability surface for the auto-mode denial problem (#33): an
  // operator whose agent just got denied runs doctor and gets the exact lines to
  // paste, without having to already know they exist. It reports nothing about the
  // local machine, so it is deliberately NOT a check: it can never pass or fail.
  return {
    data: { status: 'pass', checks, permissions: recommendedPermissions() },
    humanLines: [...renderDoctorHuman(ctx.io, checks), '', ...renderPermissionsBlock()],
  };
}

function checkNode(): BuiltCheck {
  const version = process.versions.node;
  const major = Number.parseInt(version.split('.')[0] ?? '0', 10);
  if (major >= 22) {
    return { result: { name: 'node', status: 'ok', required: true, detail: `Node ${version}` } };
  }
  return {
    result: {
      name: 'node',
      status: 'fail',
      required: true,
      detail: `Node ${version} is unsupported (need >= 22)`,
      fix: 'Install Node 22 or newer',
    },
    failCode: 'NODE_UNSUPPORTED',
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
): Promise<BuiltCheck> {
  const url = `${trimSlash(baseUrl)}/openapi.json`;
  const res = await fetchJson(url, { timeoutMs, fetchImpl });
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
 * WARN-level (never fails doctor): is the A2 search endpoint advertised in the
 * OpenAPI doc? Absent means the deployment predates A2 (the buy/search path will
 * not work against it yet). Warn-only because doctor's job is a working READ path,
 * and search is additive.
 */
async function checkSearchContract(
  baseUrl: string,
  timeoutMs: number,
  fetchImpl?: typeof fetch,
): Promise<BuiltCheck> {
  const url = `${trimSlash(baseUrl)}/openapi.json`;
  const res = await fetchJson(url, { timeoutMs, fetchImpl });
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
          detail: 'This deployment does not advertise POST /api/agent/search (A2 not deployed)',
          fix: 'search/buy need A2 deployed; point the configured base URL at a deploy that has it (`tenjin config set baseUrl <url>`).',
        },
  };
}

function hasSearchPath(json: unknown): boolean {
  if (!isRecord(json)) return false;
  const paths = json.paths;
  return isRecord(paths) && '/api/agent/search' in paths;
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
  skillsSourceDir?: string,
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
        detail: `${broken.map(describeProblem).join('; ')}. Full state: ${describeWiring(inPlay)}`,
        fix: fixFor(home, broken),
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
    skillsSourceDir,
  );
  if (!verifiable) {
    return {
      result: {
        name: 'skills',
        status: 'warn',
        required: false,
        detail: `${CLI_SKILL_NAMES.join(' + ')} wired, but this build's packaged copies could not be read, so whether they are current is unknown`,
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

/**
 * How the wired CLI adapter skills compare to the packaged ones.
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
  sourceDir?: string,
): Promise<{ stale: string[]; verifiable: boolean }> {
  let source: string;
  try {
    source = sourceDir ?? resolveSkillsSource(fileURLToPath(new URL('.', import.meta.url)));
  } catch {
    return { stale: [], verifiable: false };
  }
  // Read once, not once per directory.
  const packaged = new Map<string, Buffer>();
  for (const name of CLI_SKILL_NAMES) {
    const read = await readSkillFile(join(source, name, 'SKILL.md'));
    if (read.kind === 'ok') packaged.set(name, read.bytes);
  }
  if (packaged.size !== CLI_SKILL_NAMES.length) return { stale: [], verifiable: false };

  const stale: string[] = [];
  for (const dir of dirs) {
    for (const name of CLI_SKILL_NAMES) {
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
function fixFor(home: string, dirs: HarnessWiring[]): string {
  const flags = [...new Set(dirs.map((w) => harnessFlagFor(home, w.dir)))];
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
 * The delegated session key `tenjin read` presents to recover a piece this wallet
 * already owns (`tenjin session start --scope read` mints it). Never required and
 * never a fail — `read` works without one — so ABSENT is `ok`: the normal
 * posture, not a defect.
 *
 * Everything else warns, and the states are kept apart on purpose. A 0600 file
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
  if (!isSessionPresentable(file, now(), 'read', origin)) {
    return warn(
      `Session key for ${file.address} is expired or out of scope (scope ${file.scope}, exp ${file.exp})`,
      data,
    );
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
): Promise<BuiltCheck> {
  // The shipped public read path. The A2 search-contract check is a B2 follow-up.
  // Probe the UNFILTERED listing: the server logs every nonblank first-page `q`
  // as agent search demand, so a `q` here would fabricate that demand into the
  // experiment this CLI exists to measure. Never add a `q` to this probe.
  const url = `${trimSlash(baseUrl)}/api/articles?limit=1`;
  const res = await fetchJson(url, { timeoutMs, fetchImpl });
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
 * it). Otherwise the provider describes itself (address + source), reports its own
 * custody warnings, and the balance probes describe()'s address. A custody problem
 * (bad key, provider refusal) is warn-level, never a hard fail.
 */
async function checkWallet(
  ctx: CommandContext,
  deps: DoctorDeps,
  env: NodeJS.ProcessEnv,
  rpcUrl: string,
): Promise<CheckResult[]> {
  const provider = deps.provider ?? (await resolveLocalProviderOrNull(ctx, env));
  if (provider === null) return [noWalletCheck()];

  const { describeWallet } = await import('../lib/wallet');
  let desc: WalletDescription;
  try {
    desc = await describeWallet(provider);
  } catch (err) {
    if (err instanceof CliError && err.code === 'WALLET_MISSING') return [noWalletCheck()];
    return [walletWarn(err)];
  }

  const checks: CheckResult[] = [
    {
      name: 'wallet',
      status: 'ok',
      required: false,
      detail: `Wallet ${desc.address} (${desc.credentialSource})`,
    },
  ];
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
): Promise<WalletProvider | null> {
  const envKey = env.TENJIN_WALLET_KEY;
  const envKeySet = typeof envKey === 'string' && envKey.length > 0;
  if (!envKeySet && !(await walletFileExists(ctx.dataDir))) return null;
  const { resolveWalletProvider } = await import('../lib/wallet');
  return resolveWalletProvider(ctx);
}

function noWalletCheck(): CheckResult {
  return {
    name: 'wallet',
    status: 'warn',
    required: false,
    detail: 'No wallet; needed only for buy/publish',
    fix: 'tenjin wallet create',
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
        detail: 'Wallet USDC balance is 0',
        fix: 'Send USDC on Base. $5 covers ~50 typical resources.',
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
    // info.version, a provider's error text). doctor now prints them directly
    // above the allowlist block the operator is told to paste, so a newline or
    // ANSI in a hostile deployment's version string could forge a second, wider
    // "allowlist" section in the terminal. Sanitize at the render seam: output.ts
    // exempts doctor on the assumption it only paints its OWN text, which stopped
    // being true the moment these lines sat next to a copy-paste block.
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
