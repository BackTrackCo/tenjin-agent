import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import { styleText } from 'node:util';
import { Stream } from 'node:stream';
import { CliError } from '../lib/errors';
import { hasCode } from '../lib/errno';
import { ownsAnyLock, releaseOwnedLocks } from '../lib/lock';
import { skillMaterialize } from '../lib/skill-materialize';
import { installSkill } from '../lib/skill-writer';
import { isTeamModeConfig } from '../lib/settings';
import type { SkillInstallStatus } from '../lib/skill-writer';
import { resolveSkillsSource, OPTIONAL_PAY_SKILL, SKILL_NAMES } from '../lib/skills-source';
import { placeOptionalSkill } from '../lib/skill-placement';
import {
  CLI_SKILL_NAMES,
  HARNESS_TARGETS,
  HOSTED_SKILL_NAME,
  harnessDetectedBy,
  harnessTargetDir,
  isModelInvocationDisabled,
  onPath,
  readSkillFile,
} from '../lib/skill-wiring';
import type { HarnessTarget } from '../lib/skill-wiring';
import {
  CONFIG_DEFAULTS,
  HOOK_ARMS,
  loadRawConfig,
  PublishModeSchema,
  parsePublishModeFlag,
  resolveFreeVerbsDeclined,
} from '../lib/config';
import type { PartialConfig, PublishMode } from '../lib/config';
import {
  persistBazaarPay,
  persistFreeVerbsDeclined,
  persistInstallHarness,
  persistPublishMode,
} from './config';
import { runWalletCreate } from './wallet';
import { collectDoctorChecks } from './doctor';
import type { CheckResult, DoctorDeps, DoctorChecks } from './doctor';
import { describeWallet, resolveWalletProvider } from '../lib/wallet';
import type { PassphraseOverrides } from '../lib/wallet/local';
import { walletFileExists } from '../lib/wallet/store';
import { recommendedPermissions } from '../lib/permissions';
import {
  claudeSettingsPath,
  inspectFreeVerbRules,
  permissionsSkipped,
  planFreeVerbAllowlist,
  retractModeGatedRules,
  wireFreeVerbAllowlist,
} from '../lib/harness-permissions';
import type { PermissionsResult } from '../lib/harness-permissions';
import { hasClaudeHooks, hooksSkipped, writeClaudeHooks } from '../lib/harness-hooks';
import type { WriteClaudeHooksOptions } from '../lib/harness-hooks';
import { healWiredSkills } from '../lib/skill-heal';
import type { HealOutcome } from '../lib/skill-heal';
import type { HooksResult } from '../lib/harness-hooks';
import { confirmChoice, intro as clackIntro, selectOne } from '../lib/clack';
import { sanitizeForTerminal } from '../lib/output';
import type { Io } from '../lib/output';
import type { CommandContext, CommandResult } from '../context';

// The `--harness` vocabulary and its directory mapping are single-sourced in
// skill-wiring beside the detection probes, because `doctor` maps a persisted choice
// back to a directory with the same rules.
const HARNESSES = HARNESS_TARGETS;
type Harness = HarnessTarget;

const InstallInputSchema = z.object({
  harness: z.array(z.string()).optional(),
  dryRun: z.boolean().optional(),
  publishMode: z.string().optional(),
  noWallet: z.boolean().optional(),
  /**
   * `--no-allow-free-verbs`: write no permission rule at all. The allowlist is
   * otherwise written on every run, because installing tenjin is the consent for
   * it (the publish-mode select says what an auto mode adds).
   */
  noAllowFreeVerbs: z.boolean().optional(),
  /**
   * `--bazaar-pay`: let `tenjin pay` pay Bazaar-listed non-Tenjin endpoints under
   * the spend policy, and place the skill that teaches the lane. Off unless asked
   * for: this gate opens spending at sellers Tenjin does not operate.
   */
  bazaarPay: z.boolean().optional(),
  /**
   * `--no-hooks`: register no hooks THIS RUN, changing nothing persistent. It is
   * deliberately not the same as `tenjin config set hooks.<arm> false`, which is
   * a durable statement about one arm's behavior.
   */
  noHooks: z.boolean().optional(),
  /**
   * `--refresh`: re-materialize what this machine ALREADY has, and nothing else.
   * See {@link runInstallRefresh}. Every other flag is ignored on a refresh run,
   * because a refresh makes no decision any of them could settle.
   */
  refresh: z.boolean().optional(),
});
export type InstallInput = z.infer<typeof InstallInputSchema>;

/**
 * The publish-mode question's seam: returns the chosen mode, or `null` when the
 * operator cancelled (which changes nothing and writes nothing). The choices
 * themselves are {@link PUBLISH_MODE_CHOICES}; the seam exists so tests answer
 * in-process and never render a prompt.
 */
export type PromptPublishModeFn = () => Promise<PublishMode | null>;

/** A yes/no seam, same shape as buy's `confirm`. */
export type ConfirmFn = (label: string) => Promise<boolean>;

type PublishModeSource = 'flag' | 'existing' | 'prompt' | 'headless-default' | 'default-skipped';
interface PublishModeSelection {
  value: PublishMode;
  source: PublishModeSource;
}

/**
 * Why no wallet was created, when none was.
 *
 * `no-passphrase-store` is the one that matters: this machine has no OS
 * credential store that would hold a generated passphrase, and no
 * `TENJIN_WALLET_PASSPHRASE`. There is no fallback here BY DESIGN. A passphrase
 * written to a plain file beside the keystore it unlocks is not a passphrase, so
 * the run creates nothing and says so loudly with both remedies.
 */
type WalletSkipReason = 'no-passphrase-store' | 'create-failed' | 'dry-run' | 'flag';

/**
 * How the wallet step resolved, so rendering stays separate from prompting.
 *
 * `declined` (an answer) and `skipped` (no answer, with a reason) are kept apart
 * deliberately: an install that could not create a key is a different state from
 * one the operator told not to, and only the first needs a remedy.
 */
interface WalletOutcome {
  status: 'existing' | 'created' | 'declined' | 'skipped';
  address?: string;
  /** Only ever set on `skipped`. */
  reason?: WalletSkipReason;
  /** The exact command that changes this outcome, mirroring the CliError contract. */
  fix?: string;
  /** The underlying failure, for a `create-failed` skip. */
  warning?: string;
}

/** The remedy for each skip, so no skipped state is ever a dead end. */
function walletFix(reason: WalletSkipReason): string {
  switch (reason) {
    case 'no-passphrase-store':
      return 'No OS credential store is available to hold the wallet passphrase. Set TENJIN_WALLET_PASSPHRASE and re-run `tenjin install`, or run `tenjin wallet create` in a terminal to enter one.';
    case 'create-failed':
      return 'Fix the reported problem, then run `tenjin wallet create`.';
    case 'dry-run':
    case 'flag':
      return 'Create one with `tenjin wallet create`.';
  }
}

/**
 * The Codex config.toml rule the user must add by hand. We PRINT it, never edit
 * config.toml: Codex's default workspace-write sandbox blocks network, which would
 * make every paid x402 call fail (or prompt) until this is set.
 */
const CODEX_NETWORK_RULE = '[sandbox_workspace_write]\nnetwork_access = true';

/** Per-skill install outcome for one harness target. */
interface SkillResult {
  name: string;
  status: SkillInstallStatus;
  /** Was a real copy (a SKILL.md, not just the directory) already on disk before this run? */
  preexisting: boolean;
  /** Is this one of the two CLI adapter skills (as opposed to the hosted mirror)? */
  cli: boolean;
  /** Will a harness surface it to the model after this run? On a --dry-run nothing is
   * written, so it answers for the packaged copy that would land. */
  modelInvocable: boolean;
}

interface HarnessResult {
  harness: Harness;
  detected: boolean;
  detectedBy: string[];
  skillsDir: string;
  skills: SkillResult[];
  /**
   * Was the hosted zero-install `tenjin` skill already in this target before the
   * run? Reported so an upgrade over a hosted-skill machine is visible in `--json`,
   * which is exactly the state #35 was invisible in.
   */
  hostedPreexisting: boolean;
  /**
   * Narrower than {@link HarnessResult.hostedPreexisting}: the hosted skill was here
   * AND the CLI adapters were not, which is the hosted-zero-install-first funnel
   * rather than a second run finding our own mirror. This is what gates the notice.
   */
  hostedArrivedFirst: boolean;
  codexNetworkRule?: string;
  notes: string[];
  warnings: string[];
}

export interface InstallDeps {
  /** Home directory root for harness detection + skill destinations. Tests inject a temp dir. */
  homeDir?: string;
  /** The packaged skills source directory. Defaults to resolving it from this module's location. */
  skillsSourceDir?: string;
  /** PATH probe for `claude`/`codex` binaries. Injectable so tests never depend on the real PATH. */
  which?: (bin: string) => boolean;
  /** Environment (PATH for the default `which`). Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Doctor check collector; defaults to the real one. Injected in tests to avoid the network. */
  collectChecks?: (ctx: CommandContext) => Promise<DoctorChecks>;
  /** Deps forwarded to the default doctor collector (e.g. a canned fetch). */
  doctorDeps?: DoctorDeps;
  /** The publish-mode select; defaults to the clack list. */
  promptPublishMode?: PromptPublishModeFn;
  /** What a real run WOULD write, for `--dry-run`; defaults to the read-only plan pass. */
  planPermissions?: (home: string, mode: PublishMode) => Promise<PermissionsResult>;
  /** Whether the allowlist has anything left to grant; defaults to reading settings.json. */
  inspectPermissions?: (
    home: string,
    mode: PublishMode,
  ) => Promise<{ pending: string[] | null; satisfied?: PermissionsResult }>;
  /** The retraction-only pass `review` runs; defaults to the real writer. */
  retractModeGated?: (home: string) => Promise<PermissionsResult>;
  /** "Create a wallet now?"; defaults to the clack confirm (default yes). */
  confirmWallet?: ConfirmFn;
  /** Prompt-sequence chrome. A seam so tests never load the renderer. */
  intro?: (message: string) => Promise<void>;
  /** Whether the human walkthrough runs (TTY, no --json, stdin is a TTY). Injected in tests. */
  isInteractive?: boolean;
  /** Does a wallet already exist? Defaults to walletFileExists(dataDir). */
  walletExists?: (dataDir: string) => Promise<boolean>;
  /** An existing wallet's address, for the "(existing)" line. Defaults to the local provider. */
  walletAddress?: (ctx: CommandContext) => Promise<string>;
  /** Create a wallet and return its address. Defaults to runWalletCreate. */
  createWallet?: (ctx: CommandContext) => Promise<string>;
  /**
   * Passphrase-resolution seam forwarded to `wallet create` (OS-store exec, TTY
   * prompt, platform). Tests MUST set it: without it a headless install now
   * creates a real wallet, and on macOS that writes to the developer's own login
   * keychain under the `tenjin-cli` service.
   */
  walletPassphrase?: PassphraseOverrides;
  /** Steps 1-3 of the hook cutover: bundles, token, a healthy daemon. */
  startDaemon?: WriteClaudeHooksOptions['start'];
}

/**
 * `tenjin install`: detect the installed harness(es), copy the packaged skills
 * into each one's skills directory, ask TWO questions (publishing, wallet), then
 * run the doctor checks over the machine those answers just produced and print
 * ten rows. Everything else is a flag.
 *
 * ONE PROMPT CARRIES ONE CONSENT. The publish-mode select is the consent moment
 * for the harness allowlist too, because `auto` is what puts `tenjin publish` and
 * `tenjin edit` in it, and two prompts asking about one grant is a menu rather
 * than a decision. The rules, the hook entries and the keystore are described in
 * docs/agent-permissions.md and in the `--json` envelope, not in the middle of a
 * setup flow.
 *
 * A NON-INTERACTIVE RUN IS A USABLE INSTALL, not a stripped one. The permission
 * allowlist, the search hooks and the wallet are all settled by default when
 * there is no one to ask, because the machine that most needs them is exactly the
 * one running headless. Each has an opt-out flag.
 *
 * Like every command it is human-first (the global output contract): at a TTY
 * without `--json` it prompts and returns the walkthrough as humanLines, which
 * the dispatcher prints to stdout with no envelope. With `--json` or piped
 * stdout it returns the envelope and asks nothing. Idempotent: a re-run reports
 * up-to-date, never duplicates the AGENTS.md line, adds no permission rule twice,
 * and registers no hook twice. `--dry-run` writes nothing.
 */
export async function runInstall(
  input: InstallInput,
  ctx: CommandContext,
  deps: InstallDeps = {},
): Promise<CommandResult> {
  // Dispatched ABOVE installBody rather than threaded through it as one more
  // flag. A refresh shares none of the decisions, and the guarantee it makes —
  // no prompt, no wallet, no config write, no new surface — is one a reader can
  // only check by there being no path from here into any of them.
  if (input.refresh === true) return runInstallRefresh(ctx, deps, input.dryRun === true);
  return withInterruptGuard((markPhase) => installBody(input, ctx, deps, markPhase));
}

/**
 * `tenjin install --refresh`: bring the surfaces this machine ALREADY has up to
 * the running build, and add none.
 *
 * It exists because `tenjin update` swaps the binary and nothing else, while the
 * skills, the generated hook scripts and their settings entries are all
 * materialized copies of a particular version (tenjin-agent#171). The running
 * process cannot render the NEXT version's copies, so `update` spawns this on
 * the freshly installed entry once the swap succeeds.
 *
 * CONVERGE, NEVER MATERIALIZE. Every step is gated on the surface already
 * existing: a skill not wired stays unwired, a hook script not on disk stays
 * absent, an event with no entry of ours gets none, and no permission rule is
 * written at all. The update nudge is stood down for the same reason (see
 * `runCommand` in cli.ts): it fires after this body returns or throws, and its
 * cache file would be the one file this mode created. That is what makes it safe
 * to run unattended on any machine, including one that never ran
 * `tenjin install`, where it is a stated no-op.
 *
 * PERMISSION RULES ARE REPORTED, NEVER WRITTEN. They carry no version, so there
 * is nothing in one to bring up to date; the only thing a rules pass could do is
 * ADD the rules a newer version's install would write, and widening an agent's
 * allowlist during an unattended upgrade is not a convergence. Those arrive when
 * an operator runs `tenjin install` on purpose, and the run reports which ones
 * are waiting so the choice is visible rather than silent.
 *
 * THE EXIT CODE CARRIES THE VERDICT. `update` reads the child's outcome and
 * nothing else, so a run that refused or found nothing to converge exits
 * non-zero rather than reporting success; see the throw sites below.
 *
 * COMPATIBILITY CONTRACT. `--refresh` must keep working, with this name and this
 * "changes nothing that does not already exist" meaning, from its first release
 * onward: every OLD `update` invokes it on the NEXT version's binary, so this
 * flag's stability is what a version this code has never seen depends on. A
 * rename would not wedge anything (`update` treats a non-zero exit as a warn
 * naming the manual command), but it would silently strand every machine
 * upgrading from before the rename on stale hook scripts. Change the behavior
 * behind it, not the contract.
 */
async function runInstallRefresh(
  ctx: CommandContext,
  deps: InstallDeps,
  dryRun: boolean,
): Promise<CommandResult> {
  const env = deps.env ?? process.env;
  // Refused rather than honoured, because this dispatch sits ABOVE the only
  // place `dryRun` is read: forwarding it would write every script and commit
  // settings.json against the flag's own help text.
  if (dryRun) {
    throw new CliError('USAGE', '`--refresh` and `--dry-run` cannot be combined.', {
      fix: 'Run `tenjin install --dry-run` to preview a full install, or `tenjin install --refresh` to re-materialize what is already there.',
    });
  }
  const home = deps.homeDir ?? homedir();
  if (!isAbsolute(home)) {
    throw new CliError(
      'INTERNAL',
      'The home directory did not resolve to an absolute path, so nothing was refreshed.',
      { fix: 'Set HOME to your home directory (`export HOME=...`), then re-run `tenjin install`.' },
    );
  }

  // Read, never written. A refresh is not a decision about this machine, so what
  // it reads out of config only shapes what it rewrites or reports: which rule
  // set a real install would want, and whether that set was already declined.
  const rawConfig = await loadRawConfig(ctx.dataDir);
  const publishMode = rawConfig.publish?.mode ?? CONFIG_DEFAULTS.publish.mode;

  // The skills pass IS the existing heal writer, not a second one. It already
  // rewrites only the CLI adapters a harness carries, shapes them by the
  // machine's mode, and — the part that matters here — STANDS DOWN when this
  // invocation's data dir is not the machine default. The skills directories are
  // machine-wide, so a per-profile refresh must not decide their contents; the
  // default profile's own heal pass converges them, on this machine's next
  // command. See lib/skill-heal for the full argument.
  const skills = await healWiredSkills({
    io: ctx.io,
    env,
    homeDir: home,
    dataDir: ctx.dataDir,
    ...(deps.skillsSourceDir !== undefined ? { skillsSourceDir: deps.skillsSourceDir } : {}),
  });

  // THE SAME WRITER `install` RUNS, gated on what is already there. There is one
  // converging write now (lib/harness-hooks.ts) and it always writes the whole
  // entry set, so the only thing that keeps a refresh from becoming an install is
  // this question: a machine with no entry of ours has nothing to converge, and
  // an unattended upgrade may not materialize a surface nobody asked for.
  const wired = await hasClaudeHooks(home, ctx.dataDir);
  const hooks = wired
    ? await writeClaudeHooks({
        homeDir: home,
        dataDir: ctx.dataDir,
        ...(deps.startDaemon !== undefined ? { start: deps.startDaemon } : {}),
      })
    : hooksSkipped('claude', home, ctx.dataDir, 'declined');

  // `pending` is exactly the set a real install WOULD add, which is exactly the
  // set this run must not. Reported so the operator can see what an explicit
  // install is holding for them.
  const probe = await (deps.inspectPermissions ?? inspectFreeVerbRules)(home, publishMode);
  // A settled `--no-allow-free-verbs` persists the EXACT rules that were
  // pending at the time in `install.freeVerbsDeclined`
  // (see `resolvePermissions`), and this run subtracts that recorded set from
  // what it would otherwise report — recomputing from the settings file alone,
  // with nothing to distinguish "declined" from "never asked", reported the
  // full set forever (tenjin-agent#234). A per-rule set rather than a
  // suppress-everything flag: a rule that was never offered before — a later
  // version's genuinely new suggestion — is not in this list, so it still
  // surfaces even on a machine sitting on an old decline.
  const declined = new Set(resolveFreeVerbsDeclined(rawConfig.install?.freeVerbsDeclined));
  const permissions = {
    path: probe.satisfied?.path ?? claudeSettingsPath(home),
    alreadyPresent: probe.satisfied?.alreadyPresent ?? [],
    /** Rules a `tenjin install` would write. Never written here; see the header. */
    pending: (probe.pending ?? []).filter((rule) => !declined.has(rule)),
  };

  const touched = skills.ran || wired;
  const data = { refresh: true, dataDir: ctx.dataDir, skills, hooks, permissions, touched };

  // THE EXIT CODE IS THE REPORT. `update` spawns this and reads nothing but the
  // outcome, so a refusal that returned success would reach the operator as
  // "Refreshed the skills and hook scripts for <dir>" over a machine where
  // nothing was refreshed — the exact reassurance this whole path exists to
  // remove (tenjin-agent#171). The two non-success shapes:
  //
  //  - `warning`: the writer declined (a daemon that would not start, an
  //    unreadable settings file, a file that changed underneath).
  //  - `!touched`: nothing of ours is materialized here at all.
  //
  // Both are REFUSED (exit 3) rather than a failure: nothing went wrong, this
  // run simply had nothing it was allowed to converge, and `update`'s warn path
  // already names `tenjin install` and never fails the upgrade.
  //
  // ORDER MATTERS, and it is this way round. A refusal to write leaves every
  // hook counter at zero, so a machine whose hooks directory is a symlink can
  // reach `!touched` on the strength of the refusal itself and report "nothing
  // is installed here" over a machine where plenty is. The specific reason wins.
  if (hooks.warning !== undefined) {
    throw new CliError('REFUSED', hooks.warning, {
      fix: 'Run `tenjin install` to bring the skills and hook scripts up to this version.',
      details: data,
    });
  }
  if (!touched) {
    throw new CliError(
      'REFUSED',
      `Nothing to refresh for ${ctx.dataDir}: no Tenjin skills or hook scripts are materialized here.`,
      { fix: 'Run `tenjin install` to set this machine up.', details: data },
    );
  }
  return { data, humanLines: refreshLines(hooks, skills, permissions, ctx.dataDir) };
}

/**
 * What the refresh did, as lines. Reached only once the run has something to
 * report: the no-op and the refusals leave through {@link CliError} above, so
 * this never has to describe a refresh that did not happen.
 */
function refreshLines(
  hooks: HooksResult,
  skills: HealOutcome,
  permissions: { pending: string[] },
  dataDir: string,
): string[] {
  const lines = [`Refreshed what is already installed for ${dataDir}.`];
  lines.push(
    skills.ran
      ? '- skills: the wired CLI skills match this build'
      : `- skills: left alone (${skills.reason ?? 'nothing to heal'})`,
  );
  lines.push(
    hooks.skipped !== undefined
      ? `- hooks: left alone (${hooks.skipped})`
      : hooks.wrote
        ? `- hooks: rewrote ${hooks.entries} entries in ${hooks.path ?? 'settings'} against port ${hooks.daemon?.port ?? '?'}`
        : `- hooks: ${hooks.entries} entries already current in ${hooks.path ?? 'settings'}`,
  );
  if (permissions.pending.length > 0) {
    lines.push(
      `- permissions: ${permissions.pending.length} rule(s) this version would add were NOT written; run \`tenjin install\` to grant them.`,
    );
  }
  return lines;
}

/** How far the command got, for the interrupt diagnostic. */
type InstallPhase = 'writing-skills' | 'wired';

/**
 * Run `fn` with SIGINT/SIGTERM answered for the WHOLE command, not just the
 * blocks that hold a lock. The default signal action terminates without running
 * `finally`, stranding whichever lock the command holds so every later run times
 * out on it; install takes two (the config lock behind decision 1, and the
 * wallet-create lock behind decision 3, whose scrypt work is the longest
 * interruptible window this command has). Ownership is tracked by the lock
 * itself, so the handler releases exactly what this process holds and a run still
 * QUEUED behind another cannot touch that other run's lock.
 *
 * `markPhase` carries the diagnostic past the states no lock covers: the skills
 * write holds nothing (each file lands by its own atomic rename), so without it an
 * interrupt mid-copy would report that nothing changed.
 */
async function withInterruptGuard(
  fn: (markPhase: (phase: InstallPhase) => void) => Promise<CommandResult>,
): Promise<CommandResult> {
  let phase: InstallPhase | undefined;
  const onSignal = (signal: NodeJS.Signals): void => {
    const wasWriting = ownsAnyLock() || phase === 'writing-skills';
    releaseOwnedLocks();
    // An external SIGINT/SIGTERM can land while a clack prompt has the terminal
    // in raw mode with the cursor hidden; process.exit skips clack's teardown.
    // (Ctrl-C at a prompt is unaffected: raw mode delivers it as a keypress.)
    if (process.stdin.isTTY) process.stdin.setRawMode?.(false);
    if (process.stdout.isTTY) process.stdout.write('\x1b[?25h');
    process.stderr.write(
      wasWriting
        ? `\nInterrupted mid-write. Some files may be half-written; re-run \`tenjin install\` to finish.\n`
        : phase === 'wired'
          ? `\nInterrupted after the skills were written; later setup steps may not have finished. Re-run \`tenjin install\` to finish.\n`
          : '\nInterrupted before anything was written; nothing changed.\n',
    );
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    return await fn((p) => {
      phase = p;
    });
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

async function installBody(
  input: InstallInput,
  ctx: CommandContext,
  deps: InstallDeps,
  markPhase: (phase: InstallPhase) => void,
): Promise<CommandResult> {
  const parsed = InstallInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new CliError('USAGE', 'Invalid install options', {
      fix: 'Run `tenjin install --help`.',
      details: parsed.error.issues,
    });
  }
  const dryRun = parsed.data.dryRun === true;
  const noWallet = parsed.data.noWallet === true;
  const noHooks = parsed.data.noHooks === true;
  const noAllowFreeVerbs = parsed.data.noAllowFreeVerbs === true;
  const bazaarPayFlag = parsed.data.bazaarPay === true;
  // Validate the enum flags UP FRONT so a bad value fails before any wiring.
  const publishModeFlag =
    parsed.data.publishMode !== undefined ? parseModeFlag(parsed.data.publishMode) : undefined;
  const env = deps.env ?? process.env;
  const home = deps.homeDir ?? homedir();
  // An empty or relative HOME (sudo/docker env_reset, systemd units) would make
  // every target below relative, silently installing into the current working
  // directory and reporting success while no harness reads a thing.
  if (!isAbsolute(home)) {
    throw new CliError(
      'INTERNAL',
      'The home directory did not resolve to an absolute path, so nothing was installed.',
      {
        fix: 'Set HOME to your home directory (`export HOME=...`), then re-run `tenjin install`.',
      },
    );
  }
  const which = deps.which ?? ((bin: string) => onPath(bin, env));

  // Human-first is the global output rule (emitSuccess renders humanLines at a TTY
  // without --json and no envelope). `humanOutput` matches that gate so install
  // returns its walkthrough as humanLines; `canPrompt` additionally needs stdin, so
  // a piped-stdin run still renders a walkthrough (with defaults, no wallet prompt).
  const humanOutput = ctx.flags.json === true ? false : (deps.isInteractive ?? ctx.io.isTTY);
  const canPrompt = humanOutput && (deps.isInteractive ?? Boolean(process.stdin.isTTY));

  const skillsSource =
    deps.skillsSourceDir ?? resolveSkillsSource(fileURLToPath(new URL('.', import.meta.url)));
  await assertSkillsSource(skillsSource);

  const plans = resolvePlans(parsed.data.harness, home, which);
  // Same condition resolvePlans treats as an override, so what gets recorded below is
  // exactly what overrode detection.
  const explicitHarness = parsed.data.harness !== undefined && parsed.data.harness.length > 0;
  const harnesses: HarnessResult[] = [];
  // Unlocked. What makes concurrent writers safe here is the per-file atomic
  // rename, not serialization: the rm-then-write this used to be had two runs
  // reading each other's half-built trees (7 of 15 concurrent runs failed on raw
  // ENOENT/ENOTEMPTY renames), and 24 concurrent runs pass without a lock. The
  // self-heal is the other writer, and it writes these same bytes to these same
  // paths through the same writer.
  const rawConfig = await loadRawConfig(ctx.dataDir);
  // The machine's configured mode, which is what the skill text is shaped by. Read
  // off the raw config on purpose: a `--base-url` on THIS run must not decide what
  // every later session on this machine reads. See lib/skill-materialize.
  const teamMode = isTeamModeConfig(rawConfig);
  if (!dryRun) markPhase('writing-skills');
  for (const plan of plans) {
    harnesses.push(await applyPlan(plan, skillsSource, dryRun, teamMode));
  }
  await assertSkillsLanded(plans, dryRun);
  if (!dryRun) markPhase('wired');
  // An explicit --harness is REMEMBERED, before the embedded doctor run so this run's
  // own check already honours it. Detection cannot see a harness we do not probe for,
  // so without the record a directory the user named by hand is a target for one run
  // and then invisible to every later doctor — including for the #35 shadowing defect
  // it was chosen to hold. `--dry-run` records nothing, like the publish-mode write.
  if (explicitHarness && !dryRun) {
    await underDataDir(ctx.dataDir, () =>
      persistInstallHarness(
        ctx.dataDir,
        plans.map((p) => p.harness),
      ),
    );
  }
  // The two questions, in order, with everything a flag settles between them.
  if (canPrompt) await (deps.intro ?? clackIntro)('tenjin install');
  const publishMode = await underDataDir(ctx.dataDir, () =>
    resolvePublishMode(publishModeFlag, ctx, deps, dryRun, canPrompt),
  );
  const permissions = await underDataDir(ctx.dataDir, () =>
    resolvePermissions({
      plans,
      home,
      ctx,
      deps,
      declined: noAllowFreeVerbs,
      dryRun,
      publishMode: publishMode.value,
    }),
  );
  const hooks = await underDataDir(ctx.dataDir, () =>
    resolveHooks({ plans, home, ctx, deps, noHooks, dryRun }),
  );

  // On BOTH paths: the loop this command sets up needs a key, so a headless run
  // creates one rather than leaving the operator a setup that stops at the first
  // buy or publish.
  const wallet = await underDataDir(ctx.dataDir, () =>
    resolveWallet(ctx, deps, walletSkip(dryRun, noWallet), canPrompt),
  );
  const bazaarPay = await underDataDir(ctx.dataDir, () =>
    resolveBazaarPay(ctx, bazaarPayFlag, dryRun, rawConfig.bazaarPay),
  );
  // The Bazaar lane's teaching lives in its own OPTIONAL skill, and PRESENCE is
  // the whole mechanism: the tenjin-pay skill is on disk exactly while the
  // toggle is on, so an agent is never taught a lane the operator turned off.
  // Placed after the decisions so this run's own answer is what lands; the
  // doctor snapshot below then sees the final state. Per-plan best-effort like
  // the writer loop above: a placement failure is doctor's to report.
  if (!dryRun) {
    for (const plan of plans) {
      try {
        await placeOptionalSkill(
          OPTIONAL_PAY_SKILL,
          plan.skillsDir,
          skillsSource,
          bazaarPay.enabled,
          teamMode,
        );
      } catch {
        // The skills check in the embedded doctor run reports what remains.
      }
    }
  }

  // AFTER every decision, never before (#101). The snapshot used to be taken
  // straight after the skills were written, so a run that created a wallet
  // reported "No wallet" in both the walkthrough and `data.doctor` — the checks
  // described a machine that had stopped existing three steps earlier. Collecting
  // here costs nothing extra (it is still one run) and is what makes the embedded
  // report describe the install it is reporting on: the wallet just created, and
  // the config `publish.mode` just written.
  //
  // It still inspects the same `home` install wrote into, so its skill-wiring
  // check reports THIS run's result rather than os.homedir()'s. `which` goes with
  // it: the check gates its verdicts on harness detection, and a different probe
  // there would judge directories this run never targeted.
  const doctorDeps: DoctorDeps = { ...(deps.doctorDeps ?? {}) };
  doctorDeps.homeDir ??= home;
  doctorDeps.which ??= which;
  const collect = deps.collectChecks ?? ((c) => collectDoctorChecks(c, doctorDeps));
  const doctor = await collect(ctx);

  const data = {
    dryRun,
    skillsSource,
    harnesses,
    doctor: { status: doctor.failure !== undefined ? 'fail' : 'pass', checks: doctor.checks },
    publishMode,
    bazaarPay,
    // Shipped with the install rather than left for the operator to discover after
    // their first auto-mode denial (#33). Static constants, no config key: see
    // lib/permissions.ts for why this is deliberately not operator-editable state.
    // `wired` is the outcome of THIS run's settings.json write; the three
    // recommendation tiers beside it are unchanged, so a machine consumer that
    // read `alwaysSafe` / `optIn` / `neverAllowlisted` before still does.
    permissions: { ...recommendedPermissions(publishMode.value), wired: permissions },
    hooks,
    wallet,
  };

  // Machine path (--json or piped stdout): the envelope, no prompts.
  if (!humanOutput) return { data };

  // Human path: the walkthrough as humanLines (the global emitSuccess prints them
  // to stdout at a TTY and never an envelope).
  const humanLines = buildWalkthrough(ctx.io, {
    dryRun,
    harnesses,
    publishMode,
    permissions,
    hooks,
    hooksEnabled: enabledArms(rawConfig),
    wallet,
    doctor,
  });
  return { data, humanLines };
}

/**
 * Why no wallet is being created at all, or undefined when one is. Being unable
 * to prompt is NOT on this list any more: a headless run creates by default.
 */
function walletSkip(dryRun: boolean, noWallet: boolean): 'dry-run' | 'flag' | undefined {
  if (dryRun) return 'dry-run';
  if (noWallet) return 'flag';
  return undefined;
}

/**
 * The two steps that write to the Tenjin data dir, with a denial there reported as
 * the directory it is rather than as a raw errno under INTERNAL. The skills are
 * already on disk by now, so the message says what failed, not that nothing
 * happened.
 */
async function underDataDir<T>(dataDir: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!hasCode(err, 'EACCES') && !hasCode(err, 'EPERM')) throw err;
    throw new CliError('INTERNAL', `Could not use the Tenjin data directory ${dataDir}.`, {
      fix: `Permission denied. Check that you can write to it (\`ls -ld ${dataDir}\`), then re-run \`tenjin install\`.`,
      cause: err,
    });
  }
}

interface WalkthroughState {
  dryRun: boolean;
  harnesses: HarnessResult[];
  publishMode: PublishModeSelection;
  permissions: PermissionsResult;
  hooks: HooksResult;
  /** Arms answering after this run; every one is on unless config turned it off. */
  hooksEnabled: number;
  wallet: WalletOutcome;
  doctor: DoctorChecks;
}

/**
 * The human surface: one headline, five aligned facts, the way back out, and the
 * doctor's verdict. Ten rows on a clean install, and no paragraph anywhere.
 *
 * What the rows do NOT carry is the consent and disclosure prose this command
 * used to print: what the eleven entries are, what leaves the machine, where the
 * keystore lives, an undo per item. That is reference material an operator meets
 * once and cannot act on mid-install, so it lives in docs/agent-permissions.md
 * and, for a machine reader, unchanged in this command's `--json` envelope.
 *
 * The dry-run banner stays on top: it qualifies every line below it.
 */
function buildWalkthrough(io: Io, s: WalkthroughState): string[] {
  const lines: string[] = [];
  if (s.dryRun) lines.push(paint(io, 'yellow', 'Dry run: nothing was written.'), '');
  lines.push(paint(io, 'bold', `tenjin is wired for ${harnessNames(s.harnesses)}.`), '');
  lines.push(...rows(io, s), '');
  lines.push(undoLine(s.hooks));
  lines.push(doctorSummary(s.doctor));
  lines.push(...problemLines(io, s));
  return lines;
}

/** One subject per row, each label padded to the same column so the facts line up. */
function rows(io: Io, s: WalkthroughState): string[] {
  const entries: [string, string][] = [
    ['skills', skillsValue(s.harnesses)],
    ['permissions', permissionsValue(s.permissions)],
    ['hooks', hooksValue(s.hooks, s.hooksEnabled)],
    ['publishing', `${s.publishMode.value} - ${modeBlurb(s.publishMode.value)}`],
    ['wallet', walletValue(s.wallet)],
  ];
  const width = Math.max(...entries.map(([label]) => label.length));
  return entries.map(([label, value]) => `  ${paint(io, 'bold', label.padEnd(width))}  ${value}`);
}

/** Arms not turned off in config; install writes no hook key, so this is the
 *  machine's own answer rather than anything this run decided. */
function enabledArms(config: PartialConfig): number {
  return HOOK_ARMS.filter((arm) => config.hooks?.[arm] !== false).length;
}

function harnessNames(harnesses: HarnessResult[]): string {
  return harnesses.map((h) => harnessLabel(h.harness)).join(' and ');
}

/**
 * The restart and the one undo. Hooks are read once at session start, so an
 * operator who does not restart gets no hook activity at all and nothing telling
 * them why; a run that registered none has nothing to restart for.
 */
function undoLine(h: HooksResult): string {
  const restart = h.entries > 0 ? 'Restart Claude Code to load the hooks. ' : '';
  return `${restart}Undo everything: tenjin uninstall`;
}

/**
 * The embedded doctor run, in one line. A clean machine says so and stops; one
 * with a warn or a fail gets the tally and the command that explains it, rather
 * than a second copy of every check install has just run.
 */
function doctorSummary(d: DoctorChecks): string {
  const count = (status: CheckResult['status']): number =>
    d.checks.filter((c) => c.status === status).length;
  const ok = count('ok');
  if (ok === d.checks.length) return `tenjin doctor: ${d.checks.length} checks, all pass.`;
  const parts = [
    `${ok} ok`,
    ...(count('warn') > 0 ? [`${count('warn')} warn`] : []),
    ...(count('fail') > 0 ? [`${count('fail')} fail`] : []),
  ];
  return `${d.checks.length} checks: ${parts.join(', ')}; run tenjin doctor`;
}

/** `3 in ~/.claude/skills`, once per target. */
function skillsValue(harnesses: HarnessResult[]): string {
  return harnesses.map((h) => `${h.skills.length} in ${h.skillsDir}`).join('; ');
}

/**
 * What is in the harness allowlist after this run, or why nothing is. A skip is
 * never silent, because the operator's next auto-mode session is where they would
 * otherwise find out (#33).
 *
 * `removed` is counted rather than recited: it is two things at once — a rule an
 * older version wrote, and the pair a move back to `review` takes away — and the
 * envelope carries which. A skip whose own words name no file names one here,
 * because this run did change that file, and "not wired (Claude Code only)" over
 * a settings file two rules were just deleted from is the opposite of true.
 */
function permissionsValue(p: PermissionsResult): string {
  const allowed = p.added.length + p.alreadyPresent.length;
  const removed = (named: boolean): string => {
    if (p.removed.length === 0) return '';
    const what = p.planned === true ? 'to remove' : 'removed';
    return named ? `, ${p.removed.length} ${what}` : `, ${p.removed.length} ${what} from ${p.path}`;
  };
  if (p.skipped === 'harness-not-claude') return `not wired (Claude Code only)${removed(false)}`;
  if (p.skipped === 'declined' || p.skipped === 'not-requested') {
    return `none written (--no-allow-free-verbs)${removed(false)}`;
  }
  if (p.skipped === 'changed-since-read') {
    return `${p.path} changed mid-write, nothing written; re-run: tenjin install`;
  }
  if (p.skipped !== undefined && p.skipped !== 'dry-run') {
    return `${p.path} was left untouched; fix it, then re-run: tenjin install`;
  }
  if (p.planned === true) {
    return p.added.length > 0
      ? `would allow ${allowed} tenjin commands in ${p.path}${removed(true)}`
      : `${allowed} tenjin commands already in ${p.path}${removed(true)}`;
  }
  return `${allowed} tenjin commands in ${p.path}${removed(true)}`;
}

/**
 * What the operator can act on: how many arms are answering, and the one command
 * that changes that. The entry count and the port the daemon bound are wiring
 * facts nobody tunes — `tenjin doctor` reports both, under Hooks — so the row
 * spends its width on the state instead.
 */
function hooksValue(h: HooksResult, enabled: number): string {
  if (h.skipped === undefined) {
    return `${enabled} enabled; change: tenjin hooks disable <arm>`;
  }
  if (h.skipped === 'harness-not-claude') return 'not wired (Claude Code only)';
  if (h.skipped === 'dry-run') return `${h.entries} entries unchanged (dry run)`;
  if (h.skipped === 'declined') return 'none registered (--no-hooks)';
  if (h.skipped === 'daemon-down') {
    return 'the loop daemon did not start, so nothing was registered; start it: tenjin daemon start';
  }
  if (h.skipped === 'changed-since-read') {
    return `${h.path} changed mid-write, nothing written; re-run: tenjin install`;
  }
  return `${h.path} was left untouched; fix it, then re-run: tenjin install`;
}

function walletValue(w: WalletOutcome): string {
  if (w.status === 'existing') return `${w.address} (existing)`;
  if (w.status === 'created') return `${w.address}, $0 - fund with: tenjin wallet fund`;
  if (w.status === 'skipped') return `none (${w.reason}) - ${w.fix}`;
  return 'none - create with: tenjin wallet create';
}

/**
 * Below the rows, and only when something needs a person: a skill copy that
 * warned, the Codex sandbox rule the operator has to add by hand, and any writer
 * that refused. A clean install reaches none of them and stays ten rows.
 */
function problemLines(io: Io, s: WalkthroughState): string[] {
  const lines: string[] = [];
  for (const h of s.harnesses) {
    for (const w of h.warnings) lines.push(paint(io, 'yellow', `! ${w}`));
    if (h.codexNetworkRule !== undefined) {
      lines.push(paint(io, 'dim', 'Codex blocks network by default; add to ~/.codex/config.toml:'));
      for (const rl of h.codexNetworkRule.split('\n')) lines.push(paint(io, 'dim', `  ${rl}`));
    }
  }
  // Sanitized for the same reason doctor sanitizes its own detail: these strings
  // embed a V8 JSON parse error, and V8 quotes the offending input, so bytes out
  // of the operator's settings file reach the terminal through them.
  for (const w of [s.hooks.warning, s.wallet.warning, s.permissions.warning]) {
    if (w !== undefined) lines.push(paint(io, 'yellow', `! ${sanitizeForTerminal(w)}`));
  }
  return lines;
}

function harnessLabel(h: Harness): string {
  return h === 'claude' ? 'Claude Code' : h === 'codex' ? 'Codex' : 'Agent Skills';
}

/**
 * The single line of consequence attached to a mode. One row wide: what the
 * operator needs at this moment is that publishing happens without them, under
 * their name.
 */
function modeBlurb(v: PublishMode): string {
  return v === 'auto'
    ? 'your agent publishes under your identity'
    : v === 'review'
      ? 'your agent asks you in chat first'
      : 'your agent publishes unattended, and only a hard block stops it';
}

/**
 * The wallet decision. A wallet is now created BY DEFAULT on both paths, because
 * the loop this command exists to set up does not close without one: `buy` needs
 * a funded key and publish-on-MISS needs a key to sign the write, so a walletless
 * install is a setup that stops at the first useful thing the agent tries.
 *
 * The headless path is the change. It creates without asking, using the
 * passphrase policy `resolvePassphraseForCreate` already enforces: an explicit
 * `TENJIN_WALLET_PASSPHRASE`, else a strong generated passphrase written to the
 * platform's OS credential store and verified by reading it back. When neither is
 * available it creates NOTHING and reports `skipped: no-passphrase-store` with
 * both remedies. There is deliberately no plain-file fallback: a passphrase
 * sitting next to the keystore it unlocks protects nothing, and an install is
 * never the right place to invent one.
 *
 * A creation failure never fails the install. The skills, hooks and permissions
 * this run just wired are all useful without a wallet, so the failure is reported
 * loudly and the command still succeeds.
 */
async function resolveWallet(
  ctx: CommandContext,
  deps: InstallDeps,
  skipReason: 'dry-run' | 'flag' | undefined,
  canPrompt: boolean,
): Promise<WalletOutcome> {
  const exists = await (deps.walletExists ?? walletFileExists)(ctx.dataDir);
  if (exists) {
    return {
      status: 'existing',
      address: await (deps.walletAddress ?? existingWalletAddress)(ctx),
    };
  }
  if (skipReason !== undefined) {
    return { status: 'skipped', reason: skipReason, fix: walletFix(skipReason) };
  }

  // Interactive keeps the question (default yes); headless has nobody to ask and
  // takes the default rather than treating silence as a no.
  if (canPrompt) {
    const confirm = deps.confirmWallet ?? defaultConfirm;
    if (!(await confirm(WALLET_QUESTION))) return { status: 'declined' };
  }

  try {
    const create =
      deps.createWallet ??
      ((c: CommandContext) => defaultCreateWallet(c, deps.walletPassphrase, deps.env));
    return { status: 'created', address: await create(ctx) };
  } catch (err) {
    // The one failure with a real remedy: no env passphrase and no OS store, so
    // resolvePassphraseForCreate refused rather than encrypt with a passphrase
    // that has no durable copy. Anything else is reported as itself.
    const reason: WalletSkipReason = isNoPassphraseError(err)
      ? 'no-passphrase-store'
      : 'create-failed';
    return {
      status: 'skipped',
      reason,
      fix: walletFix(reason),
      ...(reason === 'create-failed'
        ? { warning: `The wallet could not be created: ${errorText(err)}` }
        : {}),
    };
  }
}

/** Is this the passphrase layer refusing because no durable store could serve? */
function isNoPassphraseError(err: unknown): boolean {
  return (
    err instanceof CliError &&
    err.code === 'USAGE' &&
    err.message.includes('No wallet passphrase is available')
  );
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function existingWalletAddress(ctx: CommandContext): Promise<string> {
  return (await describeWallet(resolveWalletProvider(ctx))).address;
}

async function defaultCreateWallet(
  ctx: CommandContext,
  passphrase?: PassphraseOverrides,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  const result = await runWalletCreate(ctx, {
    ...(passphrase !== undefined ? { passphrase } : {}),
    ...(env !== undefined ? { env } : {}),
  });
  return (result.data as { address: string }).address;
}

/** The shared confirm, defaulting to YES (setup ergonomics); cancel reads as no. */
function defaultConfirm(label: string): Promise<boolean> {
  return confirmChoice(label, true);
}

interface BazaarPayOutcome {
  enabled: boolean;
  /** enabled = this run's flag; kept = the config already says; unset = neither. */
  status: 'enabled' | 'kept' | 'unset';
}

/**
 * The Bazaar pay lane (plan: tenjin-notes cli-x402-pay), and a flag rather than a
 * question: paying non-Tenjin sellers is an opt-in nobody should be able to give
 * by pressing return at a prompt they did not come for. `--bazaar-pay` turns it
 * on and remembers it. Without the flag an install reads what the config already
 * says and writes nothing, so `tenjin config set bazaarPay <on|off>` is the one
 * way to change it and a re-install never overrides it.
 */
async function resolveBazaarPay(
  ctx: CommandContext,
  flag: boolean,
  dryRun: boolean,
  existing: boolean | undefined,
): Promise<BazaarPayOutcome> {
  if (!flag) {
    return { enabled: existing === true, status: existing === undefined ? 'unset' : 'kept' };
  }
  if (!dryRun) await persistBazaarPay(ctx.dataDir, true);
  return { enabled: true, status: 'enabled' };
}

// --- Publish-mode selection (D38 setup) ------------------------------------------

/**
 * The STORED default: what a `--dry-run` or a cancelled question leaves
 * `publish.mode` at, which is to say unset. A NON-INTERACTIVE run no longer lands
 * here; it settles RECOMMENDED_MODE below, because leaving the key unset made a
 * headless install the one path where the agent's publishing consent silently
 * differed from what the operator would have been shown. This value is now the
 * "nobody chose anything and nothing was written" answer only.
 */
const DEFAULT_MODE: PublishMode = CONFIG_DEFAULTS.publish.mode;

/**
 * What a headless run settles on, and it is the SAME answer the interactive
 * select recommends (PUBLISH_MODE_CHOICES' initialValue), not the stored default.
 * That equality is the point: "non-interactive is an interactive all-yes" has to
 * be true of publishing too, or the sentence is wrong about the one decision
 * that governs what the agent puts on a public marketplace.
 */
const RECOMMENDED_MODE: PublishMode = 'auto';

/**
 * The one consent moment's literal copy: one line of consequence per option,
 * `auto` first.
 *
 * The `auto` hint carries the harness grant too, because `auto` is what puts
 * `tenjin publish` and `tenjin edit` in the allowlist. That used to be a second
 * yes/no of its own, which asked for the same consent twice and left an operator
 * meeting a rule string mid-install with nothing they could act on. One prompt,
 * one consent; the exact rules are in docs/agent-permissions.md and in the
 * `--json` envelope.
 */
export const PUBLISH_MODE_CHOICES = [
  {
    value: 'auto',
    label: 'Auto (recommended)',
    hint: 'your agent publishes and updates pieces on its own, under your identity; it also allows `tenjin publish` and `tenjin edit` in the harness',
  },
  { value: 'review', label: 'Ask me in chat first' },
  { value: 'full-auto', label: 'Fully unattended', hint: 'only a hard block stops it' },
] as const satisfies readonly { value: PublishMode; label: string; hint?: string }[];

export const PUBLISH_MODE_QUESTION = 'When your agent has something worth publishing:';

/**
 * Resolve (and, for an explicit choice, persist) the publish consent mode at
 * install time. Precedence: `--publish-mode` flag > an already-configured global
 * mode > the interactive select > the headless settle > the untouched default.
 * A cancelled select and `--dry-run` write nothing and leave `publish.mode` unset
 * so its provenance stays `default`; a non-interactive run SETTLES the
 * recommended mode, which is the one case that writes without being asked.
 */
async function resolvePublishMode(
  flag: PublishMode | undefined,
  ctx: CommandContext,
  deps: InstallDeps,
  dryRun: boolean,
  interactive: boolean,
): Promise<PublishModeSelection> {
  if (flag !== undefined) {
    if (!dryRun) await persistPublishMode(ctx.dataDir, flag); // --dry-run: would-set only
    return { value: flag, source: 'flag' };
  }

  // Only the GLOBAL config file counts as "already configured" for setup: env/flag
  // are per-run and a project `.tenjin.json` is not this machine's global choice.
  const config = await loadRawConfig(ctx.dataDir);
  if (config.publish?.mode !== undefined) {
    return { value: config.publish.mode, source: 'existing' };
  }

  // A dry run asks nothing and writes nothing, so it reports the untouched
  // default rather than the mode a real run would settle.
  if (dryRun) return { value: DEFAULT_MODE, source: 'default-skipped' };

  // `interactive` is the walkthrough gate (already false under --json or off a
  // TTY), so a machine consumer never sits behind a prompt. It SETTLES the
  // recommended mode rather than leaving the key unset: every other decision this
  // command makes headlessly lands on what an interactive yes would have chosen,
  // and leaving this one alone made a headless install the only path where the
  // agent's publishing consent silently differed from the one the operator was
  // shown. An already-configured mode was returned above, so this only ever
  // writes where nothing was set.
  if (!interactive) {
    await persistPublishMode(ctx.dataDir, RECOMMENDED_MODE);
    return { value: RECOMMENDED_MODE, source: 'headless-default' };
  }

  const answer = await (deps.promptPublishMode ?? defaultPromptPublishMode)();
  if (answer === null) return { value: DEFAULT_MODE, source: 'default-skipped' }; // cancelled: no write
  // The seam is injectable, so an answer is validated rather than trusted; an
  // unparseable one is a cancel, not a write of something unknown.
  const parsed = PublishModeSchema.safeParse(answer);
  if (!parsed.success) return { value: DEFAULT_MODE, source: 'default-skipped' };
  await persistPublishMode(ctx.dataDir, parsed.data);
  return { value: parsed.data, source: 'prompt' };
}

function defaultPromptPublishMode(): Promise<PublishMode | null> {
  return selectOne<PublishMode>({
    message: PUBLISH_MODE_QUESTION,
    choices: PUBLISH_MODE_CHOICES.map((c) => ({ ...c })),
    initialValue: 'auto',
  });
}

function parseModeFlag(value: string): PublishMode {
  return parsePublishModeFlag(value, '--publish-mode');
}

// --- Harness permissions ----------------------------------------------------------

/** The wallet question's literal copy. */
export const WALLET_QUESTION = 'Create a wallet now?';

/**
 * Settle the harness allowlist. The write itself is free-verb only and cannot
 * widen (see lib/harness-permissions.ts); this decides ONLY whether to call it.
 *
 * Precedence: `--no-allow-free-verbs` refuses outright, and every other run
 * wires it. There is no question here any more: the publish-mode select is the
 * consent moment for this write too, since `auto` is what adds the publish and
 * edit rules and its hint says so.
 *
 * INSTALLING TENJIN IS THE CONSENT for the mode-gated rules (owner call, PR #164
 * review round). The allowlist is written for the mode this run settles, on every
 * path including the headless one, and the FIRST install writes it — there is no
 * "chosen vs defaulted" distinction. What makes that defensible is that it is
 * DOCUMENTED, on the surface each reader is actually using: the publishing row
 * says what the agent will now do, the `--json` envelope carries `modeGrant`
 * with both rule strings and all three undos, and docs/agent-permissions.md
 * carries the rest. The bare CLI, with no install ever run, still defaults to
 * `review` — install is the consent anchor, so nothing is granted to someone who
 * never ran it.
 *
 * The probe runs on EVERY path that might write. Nothing left to grant is not a
 * write: it is the ordinary state of a re-run, and returning the SNAPSHOT's own
 * result is what makes a re-run report `alreadyPresent` accurately instead of an
 * empty pair. It also keeps the write honest, because calling the writer after a
 * zero-pending probe would re-read the file and silently re-add a rule revoked in
 * between. An unreadable file is "unknown", never "already allowed", so it falls
 * through.
 */
async function resolvePermissions(args: {
  plans: HarnessPlan[];
  home: string;
  ctx: CommandContext;
  deps: InstallDeps;
  /** `--no-allow-free-verbs`: write nothing, and record what was pending. */
  declined: boolean;
  dryRun: boolean;
  /**
   * The mode the publish-mode select just settled, never a raw flag or a project
   * file: the rule set follows what this install is putting the machine on, so
   * the two cannot disagree.
   */
  publishMode: PublishMode;
}): Promise<PermissionsResult> {
  const { plans, home, ctx, deps, declined, dryRun, publishMode } = args;

  // A dry run writes nothing, so it settles before the retraction rather than
  // after it: what it owes the operator is the plan, not a revocation.
  if (dryRun) return (deps.planPermissions ?? planFreeVerbAllowlist)(home, publishMode);

  /**
   * TIGHTENING FIRST, above every guard below, because none of them is about a
   * retraction. `--no-allow-free-verbs` declines a WRITE OF OURS; it is not a
   * request to keep a grant the operator just revoked by moving to `review`, and
   * ordering it first let `install --publish-mode review --no-allow-free-verbs`
   * write `mode: review` to config.json, leave both mode-gated rules allowed, and
   * report `skipped: declined` with a fix telling the operator to ADD rules on the
   * run where they asked to revoke. The `--harness` guard is the same shape: it
   * scopes a write to the harnesses this run targets, and a Claude rule this CLI
   * wrote is ours to reclaim whichever harness is being installed today.
   *
   * The one thing that CANNOT fall through is a file we could not read: the
   * additive writer refuses it for the same reason, so there is nothing to fall
   * through to, and the retraction's own `fix` names the pair where the writer's
   * does not.
   */
  let retractedRules: string[] = [];
  let retractedFrom: string | undefined;
  if (publishMode === 'review') {
    const retracted = await (deps.retractModeGated ?? retractModeGatedRules)(home);
    if (retracted.skipped !== undefined) return retracted;
    retractedRules = retracted.removed;
    retractedFrom = retracted.path;
  }

  /**
   * Carry what the retraction took back onto whatever the rest of this function
   * returns. It used to RETURN the retraction, which jumped the additive pass and
   * the legacy sweep both: a review-install on a machine holding only the pair
   * retracted them, reported "the 9 free tenjin commands were already allowed"
   * over a file holding none of them, left a stranded legacy rule in place, and
   * made the operator run install twice to get the tier.
   */
  const withRetraction = (result: PermissionsResult): PermissionsResult =>
    retractedRules.length === 0
      ? result
      : {
          ...result,
          removed: [...retractedRules, ...result.removed],
          // A non-Claude skip carries no `path`, deliberately: naming a Claude
          // file to a Codex-only operator points them at a file that is nothing
          // to do with their harness. Once we have RETRACTED from that file, the
          // reverse is true, and the operator needs to know which file changed.
          ...(result.path === undefined ? { path: retractedFrom } : {}),
        };

  // Only Claude Code has a settings file with this shape. Codex and the shared
  // Agent Skills location gate permissions elsewhere, so there is nothing here to
  // write for them, and guessing at another harness's config would be the kind of
  // uninvited write this whole module is careful about.
  const hasClaude = plans.some((p) => p.harness === 'claude');
  if (!hasClaude) {
    return withRetraction(
      permissionsSkipped(plans[0]?.harness ?? 'shared', home, 'harness-not-claude'),
    );
  }

  // Read ahead of the decline guard (rather than only on the branches that go
  // on to grant) so a decline has the EXACT rule set that was actually pending
  // to persist. `--refresh` subtracts this from what it recomputes, per rule
  // (tenjin-agent#234); a `null` probe (unreadable/unparsable file) means there
  // is nothing concrete to record, so a decline there persists an empty list
  // rather than guessing.
  const probe = await (deps.inspectPermissions ?? inspectFreeVerbRules)(home, publishMode);

  if (declined) {
    await persistFreeVerbsDeclined(ctx.dataDir, probe.pending ?? []);
    return withRetraction(permissionsSkipped('claude', home, 'declined'));
  }
  if (probe.satisfied !== undefined) {
    // Fully satisfied: nothing pending, nothing to retire. Clear any decline
    // recorded on an earlier run so a satisfied state never leaves a stale
    // suppression sitting in config.json for a future rule to inherit.
    await persistFreeVerbsDeclined(ctx.dataDir, []);
    return withRetraction(probe.satisfied);
  }
  // Nothing to GRANT, but something of ours to retract: an older version's rule
  // for a command that no longer exists, or the publish rule under a mode that
  // no longer carries it. That only ever removes a rule this CLI wrote.
  if (probe.pending !== null && probe.pending.length === 0) {
    return withRetraction(await wireFreeVerbAllowlist(home, publishMode));
  }

  // A decline recorded on some earlier run is stale as of now IF the write
  // lands. Greptile P1 (tenjin-agent#272): clearing before the write returns
  // meant a refused settings write (unreadable file, changed underneath us) left
  // the rules absent but erased the very record that told the next refresh they
  // were still pending. Wire first, and only clear the decline once
  // `wireFreeVerbAllowlist` reports it actually wrote (no `skipped`).
  const wired = await wireFreeVerbAllowlist(home, publishMode);
  if (wired.skipped === undefined) {
    await persistFreeVerbsDeclined(ctx.dataDir, []);
  }
  return withRetraction(wired);
}

// --- Search hooks -----------------------------------------------------------------

/**
 * Settle the harness hooks: every run installs the whole entry set, and writes
 * no hook key. The seven `hooks.*` arms are on by default and each is one
 * `tenjin config set hooks.<arm> false` away, read out of config.json per fire,
 * so there is nothing for install to ask or persist here.
 */
async function resolveHooks(args: {
  plans: HarnessPlan[];
  home: string;
  ctx: CommandContext;
  deps: InstallDeps;
  noHooks: boolean;
  dryRun: boolean;
}): Promise<HooksResult> {
  const { plans, home, ctx, deps, noHooks, dryRun } = args;
  const dataDir = ctx.dataDir;

  if (!plans.some((p) => p.harness === 'claude')) {
    const harness = plans[0]?.harness ?? 'shared';
    return hooksSkipped(harness, home, dataDir, 'harness-not-claude');
  }
  // `--no-hooks` is a decision about THIS RUN and writes no config, so a later
  // bare re-run wires them.
  if (noHooks) return hooksSkipped('claude', home, dataDir, 'declined');
  if (dryRun) return hooksSkipped('claude', home, dataDir, 'dry-run');

  return writeClaudeHooks({
    homeDir: home,
    dataDir,
    ...(deps.startDaemon !== undefined ? { start: deps.startDaemon } : {}),
  });
}

// --- Detection + planning --------------------------------------------------------

interface HarnessPlan {
  harness: Harness;
  detected: boolean;
  detectedBy: string[];
  skillsDir: string;
  wiresAgentsMd: boolean;
  home: string;
}

/**
 * Turn detection (or an explicit --harness override) into the ordered, de-duped
 * list of targets to write. Codex and the shared fallback both land in
 * ~/.agents/skills (the harness-shared Agent Skills location), so a request for
 * both collapses to one target keyed by that directory.
 */
function resolvePlans(
  override: string[] | undefined,
  home: string,
  which: (bin: string) => boolean,
): HarnessPlan[] {
  if (override !== undefined && override.length > 0) {
    const plans = override.map((v) => planFor(validateHarness(v), ['override'], true, home));
    return dedupeBySkillsDir(plans);
  }

  const plans: HarnessPlan[] = [];
  // Same two probes doctor's skills check gates its per-directory verdicts on.
  const claudeBy = harnessDetectedBy(home, 'claude', which);
  const codexBy = harnessDetectedBy(home, 'codex', which);
  if (claudeBy.length > 0) plans.push(planFor('claude', claudeBy, true, home));
  if (codexBy.length > 0) plans.push(planFor('codex', codexBy, true, home));
  if (plans.length === 0) {
    // Nothing detected: the shared Agent Skills location is the fallback target, so
    // a harness installed later still finds the skills.
    plans.push(planFor('shared', ['fallback'], false, home));
  }
  return dedupeBySkillsDir(plans);
}

function planFor(
  harness: Harness,
  detectedBy: string[],
  detected: boolean,
  home: string,
): HarnessPlan {
  const skillsDir = harnessTargetDir(home, harness);
  return {
    harness,
    detected,
    detectedBy,
    skillsDir,
    wiresAgentsMd: harness !== 'claude',
    home,
  };
}

function dedupeBySkillsDir(plans: HarnessPlan[]): HarnessPlan[] {
  const seen = new Set<string>();
  const out: HarnessPlan[] = [];
  for (const p of plans) {
    if (seen.has(p.skillsDir)) continue;
    seen.add(p.skillsDir);
    out.push(p);
  }
  return out;
}

function validateHarness(value: string): Harness {
  if ((HARNESSES as readonly string[]).includes(value)) return value as Harness;
  throw new CliError('USAGE', `Unknown harness "${value}"`, {
    fix: `--harness must be one of: ${HARNESSES.join(', ')}.`,
  });
}

// --- Applying a plan -------------------------------------------------------------

/**
 * Wire one harness target. EVERY packaged skill is written on every run,
 * unconditionally: an existing Tenjin skill in the target (typically the hosted
 * zero-install one from tenjin.blog/skills.md) is never a reason to skip, because
 * install on such a machine is the UPGRADE path (#35). The hosted mirror is kept
 * and refreshed rather than removed (roadmap G4: it is the permanent zero-install
 * curriculum); the two CLI adapter skills land beside it and supersede it while
 * the CLI is present.
 */
async function applyPlan(
  plan: HarnessPlan,
  skillsSource: string,
  dryRun: boolean,
  teamMode: boolean,
): Promise<HarnessResult> {
  const skills: SkillResult[] = [];
  const warnings: string[] = [];
  const materialize = skillMaterialize({ teamMode });
  for (const name of SKILL_NAMES) {
    const { status, warning, preexisting } = await installSkill(
      join(skillsSource, name),
      join(plan.skillsDir, name),
      dryRun,
      name,
      { materialize },
    );
    skills.push({
      name,
      status,
      preexisting,
      cli: (CLI_SKILL_NAMES as readonly string[]).includes(name),
      modelInvocable: await landedInvocable(plan.skillsDir, skillsSource, name, dryRun),
    });
    if (warning !== undefined) warnings.push(warning);
  }

  const hostedPreexisting = skills.some((s) => s.name === HOSTED_SKILL_NAME && s.preexisting);
  // The notice is about arriving through the hosted skill, which is only news when
  // the CLI adapters were NOT already wired: after an earlier install the mirror on
  // disk is one we wrote, and announcing it is the CLI reporting its own footprint.
  const hostedArrivedFirst = hostedPreexisting && !skills.some((s) => s.cli && s.preexisting);
  const result: HarnessResult = {
    harness: plan.harness,
    detected: plan.detected,
    detectedBy: plan.detectedBy,
    skillsDir: plan.skillsDir,
    skills,
    hostedPreexisting,
    hostedArrivedFirst,
    notes: notesFor(plan, hostedArrivedFirst),
    warnings,
  };

  if (plan.wiresAgentsMd) result.codexNetworkRule = CODEX_NETWORK_RULE;
  return result;
}

function notesFor(plan: HarnessPlan, hostedArrivedFirst: boolean): string[] {
  const notes =
    plan.harness === 'claude'
      ? [
          'Installed at the user level (~/.claude/skills). A Claude Code plugin will later make this automatic.',
        ]
      : [
          'Copied into the shared Agent Skills location (~/.agents/skills). Codex and any Agent-Skills-compatible harness read it there.',
        ];
  if (hostedArrivedFirst) {
    // "The skill stays", never "your copy is untouched": the FILE is replaced by
    // this package's mirror, and a note reading as preservation beside a warning
    // saying replacement is worse than either alone.
    notes.push(
      `The hosted ${HOSTED_SKILL_NAME} skill was already here; the skill stays as the zero-install fallback (its file is replaced by this package's mirror) and the CLI skills (${CLI_SKILL_NAMES.join(', ')}) take precedence while the CLI is installed.`,
    );
  }
  return notes;
}

/**
 * Did the skill actually land model-invocable? Read back from the target so the
 * reported value is the file a harness will read, not what we intended to write.
 * A dry run wrote nothing, so it READS THE PACKAGED SOURCE — the file that would
 * land. Hardcoding `true` there was wrong for the one skill whose value can
 * legitimately be false: `assertSkillsSource` exempts the hosted mirror from the
 * invocability assertion, so a shadowed mirror ships and must report as shadowed on
 * both paths.
 */
async function landedInvocable(
  skillsDir: string,
  skillsSource: string,
  name: string,
  dryRun: boolean,
): Promise<boolean> {
  // Guarded like every other read of this path. It is read back AFTER the write, so
  // an external writer can have swapped it for a pipe or a device in between, and a
  // raw read there would hang the command that just finished its work.
  const read = await readSkillFile(join(dryRun ? skillsSource : skillsDir, name, 'SKILL.md'));
  if (read.kind !== 'ok') return false;
  return !isModelInvocationDisabled(read.bytes.toString('utf8'));
}

/**
 * Every packaged skill landed in every target. Runs after ALL targets are written,
 * never mid-loop: a throw between two targets would leave target 1 rewritten and
 * target 2 untouched. (It still sits ahead of the doctor run, the publish-mode
 * question and the wallet step, so a throw here skips those either way.)
 *
 * Presence only. Whether a skill is model-invocable is a property of the PACKAGED
 * source, checked up front by `assertSkillsSource` before anything is written.
 */
async function assertSkillsLanded(plans: HarnessPlan[], dryRun: boolean): Promise<void> {
  if (dryRun) return;
  const missing: string[] = [];
  for (const plan of plans) {
    for (const name of SKILL_NAMES) {
      if (!existsSync(join(plan.skillsDir, name, 'SKILL.md'))) {
        missing.push(join(plan.skillsDir, name));
      }
    }
  }
  if (missing.length === 0) return;
  throw new CliError('INTERNAL', `Skills were not written: ${missing.join(', ')}`, {
    // Safe to point at permissions because nothing removes a landed file any more:
    // each shipped file arrives by its own atomic rename. When this was a
    // rm-then-write it also fired on a lost race, and sent people to chmod a
    // directory that was fine.
    fix: `Check that you can write to the skills directory (\`ls -ld ${dirname(missing[0] ?? '')}\`), then re-run \`tenjin install\`.`,
  });
}

// --- Human rendering -------------------------------------------------------------

function paint(io: Io, format: Parameters<typeof styleText>[0], text: string): string {
  if (io.stdout instanceof Stream) return styleText(format, text, { stream: io.stdout });
  return styleText(format, text);
}

// --- Skills source guard ---------------------------------------------------------

/**
 * Guard the packaged source BEFORE any target is touched, so a bad package aborts
 * with nothing written rather than mid-copy.
 *
 * The model-invocable assertion covers only CLI_SKILL_NAMES. The hosted `tenjin`
 * mirror is written verbatim from tenjin.blog/skills.md by scripts/sync-skill.mjs
 * and its frontmatter is not authored here: if upstream ever adds
 * `disable-model-invocation: true` (a plausible way to say "prefer the CLI
 * skills"), asserting on it would hard-fail every install with a fix that cannot
 * work, and skill-drift.yml would stay green because the mirror still matches
 * upstream. Doctor warns about the mirror instead.
 */
async function assertSkillsSource(dir: string): Promise<void> {
  for (const name of SKILL_NAMES) {
    if (!existsSync(join(dir, name, 'SKILL.md'))) {
      throw new CliError('INTERNAL', `Packaged skill "${name}" is missing under ${dir}`, {
        fix: 'Reinstall tenjin-cli; the published package must ship every skill under skills/.',
      });
    }
  }
  for (const name of CLI_SKILL_NAMES) {
    const text = await readFile(join(dir, name, 'SKILL.md'), 'utf8');
    if (isModelInvocationDisabled(text)) {
      throw new CliError(
        'INTERNAL',
        `Packaged skill "${name}" carries disable-model-invocation: true, so no harness would surface it`,
        {
          fix: 'Reinstall tenjin-cli; the published CLI skills must be model-invocable.',
        },
      );
    }
  }
}
