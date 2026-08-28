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
import { PRODUCTION_HOST } from '../lib/production-origin';
import { removeRetiredState } from '../lib/state-store';
import {
  hookFallthroughAsked,
  hookFallthroughHost,
  hookRecipientHost,
  isTeamModeConfig,
} from '../lib/settings';
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
  loadRawConfig,
  PublishModeSchema,
  WebSearchModeSchema,
  parsePublishModeFlag,
  parseWebSearchHookModeFlag,
} from '../lib/config';
import type { PartialConfig, PublishMode, WebSearchMode } from '../lib/config';
import {
  persistAgentDispatchHookMode,
  persistBazaarPay,
  persistInstallHarness,
  persistPublishMode,
  persistWebSearchHookMode,
} from './config';
import { runWalletCreate } from './wallet';
import { collectDoctorChecks, isNoWalletCheck } from './doctor';
import type { DoctorDeps, DoctorChecks } from './doctor';
import { describeWallet, resolveWalletProvider } from '../lib/wallet';
import type { PassphraseOverrides } from '../lib/wallet/local';
import { walletFileExists } from '../lib/wallet/store';
import { walletPath } from '../lib/paths';
import { PERMISSIONS_DOC_URL, recommendedPermissions } from '../lib/permissions';
import {
  claudeSettingsPath,
  FREE_VERB_RULES,
  inspectFreeVerbRules,
  MODE_GATED_RULES,
  permissionsSkipped,
  planFreeVerbAllowlist,
  retractModeGatedRules,
  rulesForPublishMode,
  wireFreeVerbAllowlist,
} from '../lib/harness-permissions';
import type { PermissionsResult } from '../lib/harness-permissions';
import { hooksSkipped, hooksUndo, refreshHooks, wireSearchHooks } from '../lib/harness-hooks';
import type { HookRefreshResult } from '../lib/harness-hooks';
import { healWiredSkills } from '../lib/skill-heal';
import type { HealOutcome } from '../lib/skill-heal';
import { removeMarkerLines } from '../lib/uninstall';
import type { HooksResult } from '../lib/harness-hooks';
import { resolveHermesHome, resolveHermesHomeLenient, wireHermesIntegration } from '../lib/hermes';
import type { HermesIntegrationResult } from '../lib/hermes';
import { confirmChoice, intro as clackIntro, outro as clackOutro, selectOne } from '../lib/clack';
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
   * ACCEPTED AND IGNORED. `install` writes no CLAUDE.md/AGENTS.md line any more —
   * a skill's own frontmatter description is the trigger surface the harness reads
   * at session start, so the line only duplicated it. Both spellings still parse so
   * a script or a released doc that passes one does not fail; neither does anything.
   */
  claudeMd: z.boolean().optional(),
  /**
   * Tri-state. `true` (`--allow-free-verbs`) wires the free-verb
   * allowlist without asking, which is now also what an unanswered non-interactive
   * run does, so the flag is kept for compatibility and as an explicit statement of
   * intent. `false` (`--no-allow-free-verbs`) is the opt-out and is the only way to
   * get a run that writes no permission rule. `undefined` asks when it can, and
   * writes when it cannot ask.
   */
  allowFreeVerbs: z.boolean().optional(),
  /** The harness search-hook behavior to install (`--search-hooks auto|remind|off`). */
  searchHooks: z.string().optional(),
  /**
   * `--no-hooks`: register no hooks THIS RUN, changing nothing persistent. It is
   * deliberately not the same as `--search-hooks off`, which is a durable
   * statement about behavior and writes `hooks.webSearch: off` (and
   * `hooks.agentDispatch: off`) to config.
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
  /** Native Hermes MCP/plugin wiring; present only for the Hermes target. */
  hermes?: HermesIntegrationResult;
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
  /** Decision 1: the publish-mode select; defaults to the clack list. */
  promptPublishMode?: PromptPublishModeFn;
  /** Decision 2: the permissions confirm (default yes); defaults to the clack confirm. */
  confirmPermissions?: ConfirmFn;
  /** What a real run WOULD write, for `--dry-run`; defaults to the read-only plan pass. */
  planPermissions?: (home: string, mode: PublishMode) => Promise<PermissionsResult>;
  /** Whether decision 2 has anything left to grant; defaults to reading settings.json. */
  inspectPermissions?: (
    home: string,
    mode: PublishMode,
  ) => Promise<{ pending: string[] | null; satisfied?: PermissionsResult }>;
  /** The retraction-only pass `review` runs; defaults to the real writer. */
  retractModeGated?: (home: string) => Promise<PermissionsResult>;
  /** Decision 3: the search-hook mode select; defaults to the clack list. */
  promptSearchHooks?: () => Promise<WebSearchMode | null>;
  /** Decision 5: the Bazaar pay lane opt-in; defaults to the clack confirm (default no). */
  confirmBazaarPay?: (question: string) => Promise<boolean>;
  /** Decision 4: "Create a wallet now?"; defaults to the clack confirm (default yes). */
  confirmWallet?: ConfirmFn;
  /** Prompt-sequence chrome. Seams so tests never load the renderer. */
  intro?: (message: string) => Promise<void>;
  outro?: (message: string) => Promise<void>;
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
  /** Absolute CLI entrypoint embedded in Hermes' MCP config. */
  tenjinCommand?: string;
  /** Absolute Node executable embedded in the Hermes native plugin. */
  nodeCommand?: string;
}

/**
 * `tenjin install`: detect the installed harness(es), copy the packaged skills
 * into each one's skills directory, wire the AGENTS.md pointer, ask AT MOST FIVE
 * questions (publishing, harness permissions, search hooks, wallet, the Bazaar pay
 * lane), then run the doctor checks over the machine those answers just produced
 * and print a short summary. Everything that is not one of those decisions is display: the
 * security reference material lives in docs/agent-permissions.md, not in the
 * middle of a setup flow.
 *
 * A NON-INTERACTIVE RUN IS A USABLE INSTALL, not a stripped one. The permission
 * allowlist, the search hooks, the CLAUDE.md nudge and the wallet are all settled
 * by default when there is no one to ask, because the machine that most needs
 * them is exactly the one running headless. Each is disclosed in the output with
 * its undo and each has an opt-out flag.
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
  // Dispatched ABOVE installBody rather than threaded through it as a sixth
  // flag. A refresh shares none of the five decisions, and the guarantee it
  // makes — no prompt, no wallet, no config write, no new surface — is one a
  // reader can only check by there being no path from here into any of them.
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

  // Read, never written. A refresh is not a decision about this machine, so the
  // two things it reads out of config are the two that shape what it rewrites:
  // whether the push arms are armed (the WebSearch matcher follows it) and which
  // rule set a real install would want.
  const rawConfig = await loadRawConfig(ctx.dataDir);
  const pushOn = rawConfig.hooks?.push === 'on';
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

  const hooks = await refreshHooks({ homeDir: home, dataDir: ctx.dataDir, push: pushOn });

  // `pending` is exactly the set a real install WOULD add, which is exactly the
  // set this run must not. Reported so the operator can see what an explicit
  // install is holding for them.
  const probe = await (deps.inspectPermissions ?? inspectFreeVerbRules)(home, publishMode);
  const permissions = {
    path: probe.satisfied?.path ?? claudeSettingsPath(home),
    alreadyPresent: probe.satisfied?.alreadyPresent ?? [],
    /**
     * Rules a `tenjin install` would write. Never written here; see the header.
     *
     * KNOWN GAP, deliberately left: this is recomputed from the settings file
     * alone and nothing persists a decline, so a machine installed with
     * `--no-allow-free-verbs` reports the full set on every refresh. Answering it
     * properly needs persisted per-rule state, which is a decision about consent
     * and not part of a re-materialize. Tracked as tenjin-agent#234.
     */
    pending: probe.pending ?? [],
  };

  const touched =
    skills.ran ||
    hooks.scripts.length > 0 ||
    hooks.updated.length > 0 ||
    hooks.alreadyPresent.length > 0;
  const data = { refresh: true, dataDir: ctx.dataDir, skills, hooks, permissions, touched };

  // THE EXIT CODE IS THE REPORT. `update` spawns this and reads nothing but the
  // outcome, so a refusal that returned success would reach the operator as
  // "Refreshed the skills and hook scripts for <dir>" over a machine where
  // nothing was refreshed — the exact reassurance this whole path exists to
  // remove (tenjin-agent#171). The two non-success shapes:
  //
  //  - `warning`: `refreshHooks` declined to write (a link where the hooks dir
  //    belongs, an unreadable settings file, a file that changed underneath).
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
  hooks: HookRefreshResult,
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
    hooks.scripts.length > 0
      ? `- hook scripts: rewrote ${hooks.scripts.length} of them under ${hooks.scriptsDir}`
      : `- hook scripts: already current under ${hooks.scriptsDir}`,
  );
  if (hooks.updated.length > 0) {
    lines.push(
      `- hook entries: updated ${hooks.updated.join(', ')} in ${hooks.path ?? 'settings'}`,
    );
  }
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
  const allowFreeVerbs = parsed.data.allowFreeVerbs;
  // Validate the enum flags UP FRONT so a bad value fails before any wiring.
  const publishModeFlag =
    parsed.data.publishMode !== undefined ? parseModeFlag(parsed.data.publishMode) : undefined;
  const searchHooksFlag =
    parsed.data.searchHooks !== undefined
      ? parseWebSearchHookModeFlag(parsed.data.searchHooks, '--search-hooks')
      : undefined;
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
  // A relative HERMES_HOME is only fatal when the operator asked for Hermes. On any
  // other run it is a stray env var belonging to something else, and taking the
  // whole install down over it punishes the wrong machine.
  const targetsHermes = parsed.data.harness?.includes('hermes') === true;
  const hermesTarget = targetsHermes
    ? { home: resolveHermesHome(home, env), warning: undefined }
    : resolveHermesHomeLenient(home, env);
  const hermesHome = hermesTarget.home;

  // Human-first is the global output rule (emitSuccess renders humanLines at a TTY
  // without --json and no envelope). `humanOutput` matches that gate so install
  // returns its walkthrough as humanLines; `canPrompt` additionally needs stdin, so
  // a piped-stdin run still renders a walkthrough (with defaults, no wallet prompt).
  const humanOutput = ctx.flags.json === true ? false : (deps.isInteractive ?? ctx.io.isTTY);
  const canPrompt = humanOutput && (deps.isInteractive ?? Boolean(process.stdin.isTTY));

  const skillsSource =
    deps.skillsSourceDir ?? resolveSkillsSource(fileURLToPath(new URL('.', import.meta.url)));
  await assertSkillsSource(skillsSource);

  const plans = resolvePlans(parsed.data.harness, home, hermesHome, which);
  // Same condition resolvePlans treats as an override, so what gets recorded below is
  // exactly what overrode detection.
  const explicitHarness = parsed.data.harness !== undefined && parsed.data.harness.length > 0;
  // The CLAUDE.md nudge is written BY DEFAULT, on both paths, only
  // `--no-claude-md` suppresses it. Codex already got the same line in its
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
  // One-time cleanup of the pointer line older versions wrote into the operator's
  // CLAUDE.md / AGENTS.md. `install` writes no such line now: a skill's own
  // frontmatter description is the trigger surface the harness loads at session
  // start, so the line only duplicated it. Removing it here is what gets the
  // footprint off machines that already have one, since most people re-run
  // `install` far more often than they would run a cleanup command.
  const pointerCleanup = dryRun ? [] : await removeMarkerLines(home);

  // The five decisions, in order. Each one is skipped (with its own recorded
  // reason) when a flag already settled it or when there is no one to ask.
  if (canPrompt) await (deps.intro ?? clackIntro)('tenjin install');
  const publishMode = await underDataDir(ctx.dataDir, () =>
    resolvePublishMode(publishModeFlag, ctx, deps, dryRun, canPrompt),
  );
  const permissions = await resolvePermissions({
    plans,
    home,
    deps,
    flag: allowFreeVerbs,
    dryRun,
    canPrompt,
    publishMode: publishMode.value,
  });
  const hooks = await underDataDir(ctx.dataDir, () =>
    resolveHooks({ plans, home, ctx, deps, flag: searchHooksFlag, noHooks, dryRun, canPrompt }),
  );

  // One-time cleanup of the files the state store replaced (tenjin-agent#209:
  // push-ledger.jsonl, the push/ working directory and its markers,
  // searches.json and its lock directory, and the long-dead candidates/). There
  // is deliberately no import path — plan 03, owner decision 3 — so the sidecar
  // starts clean. Reported rather than silent: it is the operator's data dir.
  //
  // AFTER THE SCRIPTS ARE REWRITTEN, not before. Until `resolveHooks` has
  // replaced them, the scripts on disk are the OLD ones and the harness may
  // still fire them — so a cleanup that ran first could have `push/` or
  // `searches.json` recreated behind it seconds later, and since this runs once
  // per install, nothing would ever remove them again.
  const retiredState = dryRun ? [] : await removeRetiredState(ctx.dataDir);
  const hermesResult = harnesses.find((result) => result.harness === 'hermes');
  if (hermesResult !== undefined) {
    const tenjinCommand = deps.tenjinCommand ?? process.argv[1];
    const nodeCommand = deps.nodeCommand ?? process.execPath;
    if (tenjinCommand === undefined || !isAbsolute(tenjinCommand) || !isAbsolute(nodeCommand)) {
      throw new CliError(
        'INTERNAL',
        'Hermes integration requires absolute Tenjin and Node executable paths.',
        { fix: 'Run `tenjin install --harness hermes` through the installed Tenjin CLI.' },
      );
    }
    hermesResult.hermes = await wireHermesIntegration({
      hermesHome,
      dataDir: ctx.dataDir,
      tenjinCommand,
      nodeCommand,
      dryRun,
      // Activation consent: the operator named Hermes on the command line.
      explicit: explicitHarness && targetsHermes,
      // Write consent, read off the SAME hooks decision that gates Claude's
      // settings.json, because `--no-hooks` promises "writes no config" in the
      // README and that promise cannot hold on only one of the two harnesses.
      hooks: { enabled: hermesHooksEnabled(hooks), fix: hooks.fix, mode: hooks.mode },
    });
    for (const part of [
      hermesResult.hermes.mcp,
      hermesResult.hermes.plugin,
      hermesResult.hermes.activation,
    ]) {
      if (part.warning !== undefined) hermesResult.warnings.push(part.warning);
    }
    if (hermesTarget.warning !== undefined) hermesResult.warnings.push(hermesTarget.warning);
  }
  // On BOTH paths now: the loop this command sets up needs a key, so a headless
  // run creates one rather than leaving the operator a setup that stops at the
  // first buy or publish.
  const wallet = await underDataDir(ctx.dataDir, () =>
    resolveWallet(ctx, deps, walletSkip(dryRun, noWallet), canPrompt),
  );
  // Decision five, the Bazaar pay lane (plan: tenjin-notes cli-x402-pay). Asked
  // once: a key already in the config (either answer) is remembered and never
  // re-asked, and a headless run never enables it, because paying non-Tenjin
  // sellers is an opt-in only a human makes.
  const bazaarPay = await underDataDir(ctx.dataDir, () =>
    resolveBazaarPay(ctx, deps, dryRun, canPrompt, rawConfig.bazaarPay),
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

  if (canPrompt) await (deps.outro ?? clackOutro)('Setup complete.');

  const data = {
    dryRun,
    skillsSource,
    harnesses,
    // One-time cleanup, reported because it edits a file the operator owns. Older
    // versions wrote a pointer line into CLAUDE.md/AGENTS.md; nothing writes one
    // now, so an install that finds one removes it and says which file it touched.
    pointerCleanup,
    // Same reason as the pointer line: files under the operator's data dir were
    // deleted, so the run says which ones.
    retiredState,
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
    pointerCleanup,
    retiredState,
    dryRun,
    dataDir: ctx.dataDir,
    harnesses,
    publishMode,
    permissions,
    hooks,
    wallet,
    doctor,
    shelfHost: hookRecipientHost(rawConfig),
    fallthroughHost: hookFallthroughHost(rawConfig),
    fallthroughAsked: hookFallthroughAsked(rawConfig),
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

const EXAMPLE_QUESTION = "what actually changed in <library> v3's public API";

interface WalkthroughState {
  dryRun: boolean;
  /** Legacy pointer files this run cleaned; disclosed because they are the
   *  operator's own notes and we edited them. */
  pointerCleanup: string[];
  /** Retired sidecar state this run deleted; disclosed for the same reason. */
  retiredState: string[];
  /** Where the wallet keystore lives, for the create disclosure. */
  dataDir: string;
  harnesses: HarnessResult[];
  publishMode: PublishModeSelection;
  permissions: PermissionsResult;
  hooks: HooksResult;
  wallet: WalletOutcome;
  doctor: DoctorChecks;
  /** The host the generated hooks will ask; see {@link hookRecipientHost}. */
  shelfHost: string;
  /** The host they fall through to; see {@link hookFallthroughHost}. */
  fallthroughHost: string;
  /** Whether that fallthrough leg actually fires; see {@link hookFallthroughAsked}. */
  fallthroughAsked: boolean;
}

/**
 * The human surface: what happened, then what still needs you (#80). The summary
 * of at most five lines comes FIRST — it used to sit under the warnings, so a
 * first-time reader met "Some checks need attention" before learning anything had
 * succeeded and the whole run read as failure-then-success. On a clean install
 * the summary IS the output.
 *
 * The dry-run banner stays on top: it qualifies every line below it, so it is not
 * an attention item but a statement about what the rest of the output means.
 */
function buildWalkthrough(io: Io, s: WalkthroughState): string[] {
  const lines: string[] = [];
  if (s.dryRun) {
    lines.push(paint(io, 'yellow', 'Dry run: nothing was written.'));
    lines.push('');
  }
  lines.push(...summaryLines(io, s));
  const notices = noticeLines(io, s);
  if (notices.length > 0) lines.push('', ...notices);
  return lines;
}

/**
 * Everything below the summary: per-harness warnings, the Codex network rule,
 * the nudge disclosure and its undo, and any doctor check that is not ok. A
 * green doctor says nothing at all, so a clean run stays five lines.
 */
function noticeLines(io: Io, s: WalkthroughState): string[] {
  const lines: string[] = [];
  for (const h of s.harnesses) {
    if (h.hostedArrivedFirst) {
      // Named by DIRECTORY: one line per harness, and the funnel puts the mirror
      // in both, so an unqualified line appears twice and reads as a stutter.
      lines.push(
        paint(
          io,
          'dim',
          `The hosted ${HOSTED_SKILL_NAME} skill was already in ${h.skillsDir}: kept as the zero-install fallback, and the CLI skills now take precedence.`,
        ),
      );
    }
    if (h.codexNetworkRule !== undefined) {
      lines.push(paint(io, 'dim', 'Codex blocks network by default; add to ~/.codex/config.toml:'));
      for (const rl of h.codexNetworkRule.split('\n')) lines.push(paint(io, 'dim', `  ${rl}`));
    }
    for (const w of h.warnings) lines.push(paint(io, 'yellow', `! ${w}`));
  }
  // Not dim: we edited a file the operator writes their own notes in, and a line
  // saying so is the only way they learn it happened.
  if (s.pointerCleanup.length > 0) {
    lines.push(
      `Removed the old Tenjin pointer line from ${s.pointerCleanup.join(' and ')}; the skills carry their own triggers now.`,
    );
  }
  // Same again: files under ~/.tenjin were deleted, and the operator learns it
  // here or not at all. Named individually because "old sidecar state" could
  // mean anything, and one of them is the push experiment's own record.
  if (s.retiredState.length > 0) {
    lines.push(
      `Removed ${s.retiredState.join(', ')}: the hook sidecar keeps its state in ~/.tenjin/state.db now, and starts fresh.`,
    );
  }
  // Same reason as the pointer line above: we edited the operator's settings.json
  // to REMOVE something, and the only way they learn it happened is a line here.
  // Two different removals, and calling them one thing made the honest half a lie:
  // `publish` and `edit` are current commands whose RULES the mode no longer
  // carries, and reporting them as "commands that no longer exist" told the
  // operator their publish verb had been retired.
  const stale = s.permissions.removed.filter((r) => !MODE_GATED_RULES.includes(r));
  if (stale.length > 0) {
    lines.push(
      `Removed ${stale.length} permission rule(s) an older tenjin left in ${s.permissions.path ?? 'your settings'} for commands that no longer exist.`,
    );
  }
  // A run that wired permissions without being asked has to say so, and say how to
  // take it back. This is the disclosure that makes the non-interactive default
  // defensible: nothing lands silently, whether it was answered or defaulted.
  if (s.permissions.planned !== true && s.permissions.added.length > 0) {
    // The undo only. The count, the file and the link are already on the
    // Permissions line above, and saying them twice in one screen is the noise
    // this walkthrough keeps getting trimmed of. The exact rules stay out of the
    // terminal entirely; the envelope carries them in `permissions.wired.added`.
    lines.push(paint(io, 'dim', `Undo anytime: remove those lines from ${s.permissions.path}.`));
  }
  if (s.hooks.added.length > 0 || s.hooks.updated.length > 0) {
    lines.push(
      paint(
        io,
        'dim',
        hooksDisclosure(s.hooks, s.shelfHost, s.fallthroughHost, s.fallthroughAsked),
      ),
    );
    lines.push(
      paint(
        io,
        'dim',
        hooksUndo(
          s.hooks.path ?? '~/.claude/settings.json',
          s.hooks.scriptsDir,
          pushArmed(s.hooks),
        ),
      ),
    );
    // NOT dim, unlike the disclosure above it: settings.json hooks are read once
    // at session start, so an operator who does not restart gets no hook activity
    // at all and nothing telling them why. That silence is the whole reason this
    // line exists, so it must not read as fine print.
    lines.push(
      `${paint(io, 'bold', 'Restart Claude Code')} to load them; hooks are read once at session start.`,
    );
  }
  if (s.hooks.warning !== undefined) {
    lines.push(paint(io, 'yellow', `! ${sanitizeForTerminal(s.hooks.warning)}`));
  }
  for (const line of walletDisclosure(s.wallet, s.dataDir)) lines.push(paint(io, 'dim', line));
  if (s.wallet.warning !== undefined) {
    lines.push(paint(io, 'yellow', `! ${sanitizeForTerminal(s.wallet.warning)}`));
  }
  if (s.permissions.warning !== undefined) {
    // Sanitized for the same reason doctorNotices sanitizes `detail`/`fix`: this
    // string embeds a V8 JSON parse error, and V8 quotes the offending input, so
    // ~20 bytes of whatever is in settings.json (escapes included) reach the
    // terminal at the moment we tell the operator we left their file alone.
    lines.push(paint(io, 'yellow', `! ${sanitizeForTerminal(s.permissions.warning)}`));
  }
  lines.push(...doctorNotices(io, s.doctor, s.wallet));
  return lines;
}

/**
 * The closing summary, capped at one line per subject: skills, publishing,
 * permissions, wallet, and the command to run next.
 */
function summaryLines(io: Io, s: WalkthroughState): string[] {
  return [
    ...s.harnesses.map((h) => skillsLine(io, h, s.dryRun)),
    publishingLine(io, s.publishMode.value, s.permissions),
    permissionsLine(io, s.permissions),
    hooksLine(io, s.hooks),
    walletLine(io, s.wallet),
    `${paint(io, 'bold', 'Next:')} tenjin search "${EXAMPLE_QUESTION}"`,
  ];
}

/**
 * What the hooks do, in one line each, at the moment they are written.
 *
 * THE PUSH SENTENCE IS THE WHOLE POINT OF THE SPLIT. The arms are advisory
 * either way — none of them can block or change a tool call — but with the
 * experiment on there are five more hook entries reading five more kinds of
 * event, and an operator wiring them into their own home has to be told what
 * fires them and how to turn them off.
 *
 * Read off the result rather than a flag, so what is disclosed is what was
 * actually wired.
 */
export function hooksDisclosure(
  h: HooksResult,
  shelfHost: string = PRODUCTION_HOST,
  fallthroughHost: string = PRODUCTION_HOST,
  fallthroughAsked: boolean = false,
): string {
  const shared =
    'A Stop hook reminds you locally when a MISS you searched for is still unpublished, and a SessionStart hook prints one paragraph on when to search first; neither makes a network call.';
  // `pushArms` counts entries wired with `arm: 'push'`. The WebSearch entry is
  // NOT one of them: it keeps `arm: 'search'` and is instead WIDENED in place to
  // WebSearch|WebFetch when push is planned (harness-hooks.ts, WEBSEARCH_PUSH_MATCHER).
  // So it is one of the arms, not something they run beside, and the count
  // excludes it.
  const push = pushArmed(h)
    ? ` The push experiment is on, so ${h.pushArms} more hook entries are wired and the WebSearch entry above is widened to cover WebFetch and becomes one of the arms itself: they look a question up on ${shelfHost} first and then, in team mode, on ${fallthroughHost}, on your prompts, failed commands, subagent dispatches, and the files you read and re-edit. Every arm only adds context beside the call; none can block or change it. Turn it off: tenjin push off`
    : '';
  if (h.mode === 'remind') {
    // `remind` IS OUTRANKED BY THE PUSH ARM, so this branch needs the same
    // correction the `auto` branch got. In the generated WebSearch script the
    // push lookup runs BEFORE the reminder line is reached (hook-scripts.ts:
    // return on `off`, then pushDecide, which reads no mode at all, then the
    // remind line). Driven against a stub, `remind` with push on makes the same
    // one request `auto` does. "They send nothing off-machine" would therefore
    // be false on exactly the arm that reaches the network, and it is the
    // string `tenjin push on` prints too, to an operator who answered a prompt
    // reading "a one-line reminder, nothing sent off-machine".
    const remindBase = pushArmed(h)
      ? `The WebSearch and dispatch hooks only print a one-line reminder that Tenjin may have an answer, rather than looking one up for you — but the armed push arm shares the WebSearch and WebFetch entry and runs ahead of that reminder, so on a web search the query text does leave the machine for ${shelfHost}. What comes back is added beside the search; the search itself still runs.`
      : 'The WebSearch and dispatch hooks print a one-line reminder that Tenjin may have an answer; they send nothing off-machine.';
    return `${remindBase} ${shared}${push}`;
  }
  // WHO IS ACTUALLY ASKED, which on a machine with a configured shelf is that
  // shelf and not the marketplace: the scripts resolve their target from
  // `config.baseUrl` and attach the team's bypass key to it. Naming
  // tenjin.blog here would disclose a recipient that, in team mode, is never
  // asked on this arm at all. The dispatch arm asks the shelf first too, and
  // reaches the marketplace only on a team miss, so that fallthrough is named
  // rather than implied.
  //
  // GATED ON TEAM MODE, NOT ON HOST DIFFERENCE. The scripts gate that second leg
  // on `shelf === 'team'`, and their `teamShelfOrigin` is null on an empty
  // `shelfBypassSecret` — so a custom `baseUrl` with no secret runs as ordinary
  // public mode and asks nobody a second time. That half-set state is both the
  // documented two-command setup's intermediate step and the terminal state for a
  // shelf with no Deployment Protection, and this sentence used to promise it a
  // recipient it never has. Over-disclosure sends nothing extra, but it is a
  // false statement in the one text an operator cannot check later without
  // reading the generated scripts. See {@link hookFallthroughAsked}.
  const fallthrough = fallthroughAsked
    ? ` A subagent dispatch ${shelfHost} has nothing for is then asked of ${fallthroughHost} as well.`
    : '';
  return `Before a web search or a subagent dispatch, the hooks ask ${shelfHost} the same question (free and anonymous, ~2s budget, 5s harness kill) and mention a tested answer if one exists; the query text, or at most 400 characters of the subagent prompt, leaves the machine.${fallthrough}${pushArmed(h) ? '' : ' They can never block or change the tool call.'} ${shared}${push}`;
}

/** Whether the push experiment's arms are registered in the outcome disclosed. */
function pushArmed(h: HooksResult): boolean {
  return (h.pushArms ?? 0) > 0;
}

/**
 * One line for the harness hooks. A skip is never silent, for the same reason the
 * permissions line is never silent: the operator would otherwise find out by
 * noticing that nothing ever happens.
 */
function hooksLine(io: Io, h: HooksResult): string {
  const label = paint(io, 'bold', 'Search hooks:');
  const wrote = h.added.length + h.updated.length;
  // SEARCH EVENTS ONLY where the split is known. `added` and `updated` are
  // per-event and the push bundle shares PreToolUse with the search bundle, so
  // the combined count reports push arms as search hooks — which is the one
  // number an operator would use to decide the experiment did nothing.
  const searchWrote = h.searchWrote ?? wrote;
  // Its own clause, never folded into the count above: the push arms are the
  // half the experiment adds, and the half `tenjin push off` takes away.
  const arms = pushArmed(h)
    ? ` ${paint(io, 'bold', 'Push arms:')} ${h.pushArms}, from tenjin push on (off: tenjin push off).`
    : '';
  if (searchWrote > 0) {
    return `${paint(io, 'green', '✓')} ${label} ${h.mode} mode, ${searchWrote} hook event(s) registered in ${h.path}.${arms} Change: tenjin config set hooks.webSearch <auto|remind|off> (or hooks.agentDispatch)`;
  }
  // Something WAS registered, but none of it was a search event: `hooks.push`
  // flipped on by `config set` while the search entries were already current.
  // Branching on the combined count here printed "0 hook event(s) registered"
  // on exactly the run that wired the experiment.
  if (wrote > 0) {
    return `${paint(io, 'green', '✓')} ${label} ${h.mode} mode, already registered in ${h.path}.${arms} Change: tenjin config set hooks.webSearch <auto|remind|off> (or hooks.agentDispatch)`;
  }
  if (h.skipped === undefined) {
    return `${paint(io, 'green', '✓')} ${label} ${h.mode} mode, already registered in ${h.path}${arms}`;
  }
  if (h.skipped === 'harness-not-claude') {
    return `${paint(io, 'dim', '-')} ${label} not wired (Claude Code only).`;
  }
  if (h.skipped === 'native-harness') {
    return `${paint(io, 'green', '✓')} ${label} ${h.mode} mode through the native Hermes plugin. Change: tenjin config set hooks.webSearch <auto|remind|off> (or hooks.agentDispatch)`;
  }
  if (h.skipped === 'dry-run') {
    return `${paint(io, 'dim', '-')} ${label} unchanged (dry run).`;
  }
  if (h.skipped === 'mode-off') {
    return `${paint(io, 'dim', '-')} ${label} off (hooks.webSearch). Turn them on: tenjin config set hooks.webSearch auto, then tenjin install`;
  }
  if (h.skipped === 'declined') {
    return `${paint(io, 'dim', '-')} ${label} not registered this run; nothing was configured. Register them: tenjin install`;
  }
  if (h.skipped === 'changed-since-read') {
    return `${paint(io, 'yellow', '!')} ${label} ${h.path} changed while it was being updated, so nothing was written. Re-run: tenjin install`;
  }
  return `${paint(io, 'yellow', '!')} ${label} ${h.path} was left untouched. Fix it, then: tenjin install`;
}

function harnessLabel(h: Harness): string {
  return h === 'claude'
    ? 'Claude Code'
    : h === 'codex'
      ? 'Codex'
      : h === 'hermes'
        ? 'Hermes'
        : 'Agent Skills';
}

/**
 * One line per harness. It names the skills rather than counting them: #35
 * shipped as "search worked, publish was simply absent" on a machine that
 * already had the hosted skill, and a bare "3 skills installed" cannot tell you
 * publish is wired.
 */
function skillsLine(io: Io, h: HarnessResult, dryRun: boolean): string {
  const changed = h.skills.some((s) => s.status !== 'up-to-date');
  const verb = dryRun ? 'would install' : changed ? 'installed' : 'up to date';
  const head = `${harnessLabel(h.harness)}: ${h.skills.length} skills ${verb}`;
  return `${paint(io, 'green', '✓')} ${paint(io, 'bold', head)} in ${h.skillsDir}. ${skillRoster(h)}.`;
}

/**
 * One line for the settled consent mode, with the same consequence the question
 * showed, and the way back out when this run actually granted something.
 *
 * The grant used to get two more lines of its own, reciting both rule strings and
 * all three undos. An operator meeting `Bash(tenjin publish:*)` for the first time
 * mid-install cannot act on it, and three undos for one decision is a menu, not a
 * disclosure. The full story (exact rules, keystore, session mint, flag caveats,
 * all three undos) is unchanged in docs/agent-permissions.md, `doctor --json`, and
 * this command's own `--json` envelope; the terminal gets the one command that
 * turns it off.
 */
function publishingLine(io: Io, mode: PublishMode, wired: PermissionsResult): string {
  const undo =
    wired.modeGrant === undefined
      ? ''
      : ` ${paint(io, 'dim', wired.planned === true ? 'Would turn off:' : 'Turn off:')} tenjin config set publish.mode review`;
  return `${paint(io, 'green', '✓')} ${paint(io, 'bold', `Publishing: ${mode}`)}. ${modeBlurb(mode)}${undo}`;
}

/**
 * One line for the harness allowlist: what landed, or what to run to get it. A
 * skip is never silent, because the operator's next auto-mode session is where
 * they would otherwise find out (#33).
 *
 * The count is every rule of ours now in the file, and the word "free" is gone
 * with it: it was there to keep `publish` and `edit` out of a total that called
 * them free verbs, and a line that just says how many tenjin commands are allowed
 * needs no such qualifier. What the rules ARE, and what they clear, is one link
 * away rather than recited here.
 */
function permissionsLine(io: Io, p: PermissionsResult): string {
  const label = paint(io, 'bold', 'Permissions:');
  const allowed = p.added.length + p.alreadyPresent.length;
  /**
   * What a `review` install took back, said on EVERY branch rather than on the
   * two that happened to be written first.
   *
   * The retraction runs above the guards that decline a write, so a run can
   * retract and then skip: `--no-allow-free-verbs` said "unchanged" and
   * `--harness shared` said "not wired (Claude Code only)", both over a
   * settings.json the same run had just deleted two rules from. The second was
   * the worse of the two, since it tells the operator their Claude settings were
   * left alone. Hoisted, so a branch that forgets it reads wrong at review time
   * rather than shipping.
   */
  const retracted = p.removed.filter((r) => MODE_GATED_RULES.includes(r));
  /**
   * PAST TENSE FOR A RUN, FUTURE FOR A PLAN. `planFreeVerbAllowlist` fills
   * `removed` with what a real run WOULD take back, so a dry run reaching the
   * past-tense sentence reports a deletion that never happened.
   */
  const gaveBack =
    retracted.length === 0
      ? ''
      : p.planned === true
        ? ` A real run would remove ${retracted.length} rule(s) for publish and edit from ${p.path ?? 'your settings'}.`
        : ` Publishing is back to asking first, so ${retracted.length} rule(s) for publish and edit were removed from ${p.path ?? 'your settings'}.`;
  /**
   * Nothing was written AND nothing was taken back: only then is "unchanged" the
   * honest word. Gated on `planned` too, because a dry run changes nothing by
   * definition, and "otherwise unchanged" there qualified against a retraction the
   * line never named.
   */
  const unchanged =
    retracted.length === 0 || p.planned === true ? 'unchanged' : 'otherwise unchanged';

  // A dry run reports the PLAN in the same fields, so it takes this branch and
  // says "would allow". An operator dry-running to find out whether publish and
  // edit get granted was previously told only "unchanged (dry run)".
  if (p.planned === true && p.added.length > 0) {
    return `${paint(io, 'dim', '-')} ${label} would allow ${allowed} tenjin commands in ${p.path}. Details: ${PERMISSIONS_DOC_URL}`;
  }
  if (p.added.length > 0) {
    return `${paint(io, 'green', '✓')} ${label} ${allowed} tenjin commands allowed in ${p.path}.${gaveBack} Details: ${PERMISSIONS_DOC_URL}`;
  }
  if (p.skipped === undefined) {
    return `${paint(io, 'green', '✓')} ${label} the ${FREE_VERB_RULES.length} free tenjin commands were already allowed in ${p.path}.${gaveBack}`;
  }
  if (p.skipped === 'harness-not-claude') {
    return `${paint(io, 'dim', '-')} ${label} not wired for this harness (Claude Code only).${gaveBack} The lines your harness needs: ${PERMISSIONS_DOC_URL}`;
  }
  if (p.skipped === 'dry-run') {
    return `${paint(io, 'dim', '-')} ${label} ${unchanged} (dry run); the ${FREE_VERB_RULES.length} rules a real run needs are already there.${gaveBack}`;
  }
  if (p.skipped === 'declined' || p.skipped === 'not-requested') {
    return `${paint(io, 'dim', '-')} ${label} ${unchanged}.${gaveBack} Allow the ${FREE_VERB_RULES.length} free tenjin commands with: tenjin install --allow-free-verbs`;
  }
  if (p.skipped === 'changed-since-read') {
    // Nothing is wrong with the file and the flag is not the remedy: another
    // writer touched it mid-run, so the merge has to be recomputed against what
    // is there now. The catch-all below says "fix it", which is wrong here.
    return `${paint(io, 'yellow', '!')} ${label} ${p.path} changed while it was being updated, so nothing was written.${gaveBack} Re-run: tenjin install`;
  }
  return `${paint(io, 'yellow', '!')} ${label} ${p.path} was left untouched.${gaveBack} Fix it, then: tenjin install --allow-free-verbs`;
}

function walletLine(io: Io, w: WalletOutcome): string {
  const label = paint(io, 'bold', 'Wallet:');
  if (w.status === 'existing') {
    return `${paint(io, 'green', '✓')} ${label} ${w.address} (existing). Check funds with: tenjin wallet balance`;
  }
  if (w.status === 'created') {
    return `${paint(io, 'green', '✓')} ${label} ${w.address}, holding $0. Fund it with a few dollars of USDC on Base, then: tenjin wallet balance`;
  }
  if (w.status === 'skipped') {
    const icon = w.reason === 'no-passphrase-store' || w.reason === 'create-failed' ? '!' : '-';
    const color = icon === '!' ? 'yellow' : 'dim';
    return `${paint(io, color, icon)} ${label} none (${w.reason}). ${w.fix}`;
  }
  return `${paint(io, 'dim', '-')} ${label} none. Create one later with: tenjin wallet create`;
}

/**
 * What a freshly created wallet means, at the moment it is created. Three things
 * an operator has to know and would otherwise learn the hard way: it is empty,
 * only a human can fund it, and where the key lives.
 */
function walletDisclosure(w: WalletOutcome, dataDir: string): string[] {
  if (w.status !== 'created') return [];
  return [
    `A wallet was created at ${walletPath(dataDir)}: the key is encrypted at rest (keystore v3, scrypt, mode 0600) and never leaves this machine.`,
    'It holds $0. Funding it is a human step: run `tenjin wallet fund` (card checkout via Coinbase, opened in your browser), or send USDC on Base to that address.',
  ];
}

/** `tenjin-search, tenjin-publish (CLI); tenjin (hosted, zero-install fallback)`. */
function skillRoster(h: HarnessResult): string {
  const cli = h.skills.filter((s) => s.cli).map((s) => s.name);
  const hosted = h.skills.filter((s) => !s.cli).map((s) => s.name);
  const parts: string[] = [];
  if (cli.length > 0) parts.push(`${cli.join(', ')} (CLI)`);
  if (hosted.length > 0) parts.push(`${hosted.join(', ')} (hosted, zero-install fallback)`);
  return parts.join('; ');
}

/**
 * The single line of consequence attached to a mode, wherever it is shown.
 *
 * `auto` used to end "your harness still shows each command for approval", which
 * stopped being true the moment the mode started writing its own harness rules.
 * The clause is gone rather than reworded: the thing an operator needs at this
 * moment is that publishing happens without them, under their name.
 */
function modeBlurb(v: PublishMode): string {
  return v === 'auto'
    ? 'Your agent publishes and updates pieces on its own, under your identity.'
    : v === 'review'
      ? 'Your agent asks you in chat before every publish.'
      : 'Your agent publishes on its own, under your identity, and only a hard block stops it.';
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

export const BAZAAR_QUESTION =
  'Enable the Bazaar pay lane? x402 lets this wallet pay HTTP endpoints that answer with a priced 402, and the Bazaar (https://docs.cdp.coinbase.com/x402/bazaar) is the public catalog of them. When on, `tenjin pay` may pay Bazaar-listed non-Tenjin endpoints under your spend policy. More: https://x402.org';

interface BazaarPayOutcome {
  enabled: boolean;
  /** kept = the config already answered (never re-asked); not-asked = headless or dry run. */
  status: 'kept' | 'enabled' | 'declined' | 'not-asked';
}

/**
 * The one decision that is remembered in BOTH directions: a prompted yes or no
 * is persisted (`bazaarPay: true|false`), so the question is asked at most once
 * per machine. A headless run persists nothing, leaving the question for the
 * first interactive install. Default no: this gate opens spending at sellers
 * Tenjin does not operate.
 */
async function resolveBazaarPay(
  ctx: CommandContext,
  deps: InstallDeps,
  dryRun: boolean,
  canPrompt: boolean,
  existing: boolean | undefined,
): Promise<BazaarPayOutcome> {
  if (existing !== undefined) return { enabled: existing, status: 'kept' };
  if (dryRun || !canPrompt) return { enabled: false, status: 'not-asked' };
  const confirm = deps.confirmBazaarPay ?? ((label: string) => confirmChoice(label, false));
  const yes = await confirm(BAZAAR_QUESTION);
  await persistBazaarPay(ctx.dataDir, yes);
  return { enabled: yes, status: yes ? 'enabled' : 'declined' };
}

/**
 * Doctor problems only. A fully green run prints nothing here: the summary is
 * the whole output, and "everything checks out" is what an absent warning means.
 *
 * The "no wallet" warn is dropped when the summary already carries it (#80): the
 * summary's own wallet line says `none` and names the same `tenjin wallet create`,
 * and someone who only wants `tenjin search` does not need it twice, in yellow,
 * for a wallet they were just told is optional. Every other wallet warn — a
 * keystore that will not open, an invalid TENJIN_WALLET_KEY, loose file
 * permissions — still prints, because nothing else in the output says it.
 *
 * Hence `isNoWalletCheck` rather than the check's NAME. `resolveWallet` probes for
 * a wallet FILE, so it reports no wallet for a machine whose credential is a
 * broken env key; matching on the name suppressed doctor's warning about it and
 * left the run silent about the only wallet state install cannot describe itself.
 *
 * `summaryAlreadySaysNoWallet` covers BOTH ways this run can end without one, and
 * both print the same `tenjin wallet create` pointer: `declined` (the operator
 * said no) and `skipped` (never asked, or the passphrase had nowhere to live).
 * `created` and `existing` never suppress, since there IS a wallet and any warn
 * about it is news.
 */
function summaryAlreadySaysNoWallet(wallet: WalletOutcome): boolean {
  return wallet.status === 'declined' || wallet.status === 'skipped';
}

function doctorNotices(io: Io, doctor: DoctorChecks, wallet: WalletOutcome): string[] {
  const problems = doctor.checks.filter(
    (c) => c.status !== 'ok' && !(summaryAlreadySaysNoWallet(wallet) && isNoWalletCheck(c)),
  );
  if (problems.length === 0) return [];
  const lines = [paint(io, 'yellow', 'Some checks need attention:')];
  for (const c of problems) {
    const icon = c.status === 'fail' ? paint(io, 'red', '✗') : paint(io, 'yellow', '!');
    // Same seam as renderDoctorHuman: `detail`/`fix` carry server-sourced substrings.
    lines.push(`  ${icon} ${c.name}: ${sanitizeForTerminal(c.detail)}`);
    if (c.fix !== undefined) {
      lines.push(paint(io, 'dim', `    fix: ${sanitizeForTerminal(c.fix)}`));
    }
  }
  return lines;
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

/** Decision 1's literal copy: one line of consequence per option, `auto` first. */
export const PUBLISH_MODE_CHOICES = [
  {
    value: 'auto',
    label: 'Auto (recommended)',
    hint: 'your agent publishes and updates pieces on its own, under your identity',
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

// --- Harness permissions (decision 2) ---------------------------------------------

/**
 * Decision 2's literal copy: one question, and a consequence that lib/permissions.ts
 * would agree with. NOT "read-only" and NOT "never touches your wallet" — that
 * module refuses both claims in as many words (`search` and `outcome` POST
 * off-machine, `read` saves to the library and can present a cached
 * wallet-derived delegation, and two of the nine rules are `wallet show` /
 * `wallet balance`). What is actually true of the whole tier is that it cannot
 * spend and cannot move your keys, so that is what the question says.
 *
 * The pointer is how FLAG_CAVEAT reaches the consent moment: the walkthrough
 * prints neither the rules nor the flag caveat, so the yes/no that replaced them
 * names where both live in full. It used to point at `tenjin doctor`, which
 * printed them; doctor now points at the same page (#81).
 */
/**
 * The consent moment, in two sentences and a link.
 *
 * This question used to recite the tier: a count of "free" commands, which of
 * them send data, what `doctor` does to the wallet, and (once the pair started
 * landing here) both rule strings verbatim. An operator meeting `Bash(tenjin
 * publish:*)` for the first time at a yes/no prompt cannot act on any of it, and
 * a prompt nobody finishes reading is not consent.
 *
 * Two facts survive, because they are the two a human can actually decide on:
 * this cannot spend their money, and on an auto mode their agent will publish
 * under their name without being asked. Everything else (the exact rules, the
 * keystore, the read+write session mint, the `--base-url` and `--yes` caveats,
 * all three undos) is unchanged one link away in docs/agent-permissions.md, and
 * in `doctor --json` and this command's `--json` envelope for an agent reading it.
 *
 * Counts come from the rule sets, so a verb added to either tier cannot make the
 * question lie.
 */
function permissionsQuestionHead(mode: PublishMode): string {
  const count = rulesForPublishMode(mode).length;
  return `Let your agent use tenjin without permission popups? Adds ${count} command rules to ~/.claude/settings.json.`;
}

export const PERMISSIONS_QUESTION = `${permissionsQuestionHead('review')} None of them can spend your money. Details: ${PERMISSIONS_DOC_URL}`;

/** The same question, plus the one thing an auto mode changes about the answer. */
export function permissionsQuestion(mode: PublishMode): string {
  if (mode === 'review') return PERMISSIONS_QUESTION;
  return `${permissionsQuestionHead(mode)} None of them can spend your money, and on publish.mode ${mode} your agent will publish under your identity on its own. Details: ${PERMISSIONS_DOC_URL}`;
}

/** The wallet decision's literal copy. */
export const WALLET_QUESTION = 'Create a wallet now?';

/**
 * Settle the harness allowlist. The write itself is free-verb only and cannot
 * widen (see lib/harness-permissions.ts); this decides ONLY whether to call it.
 *
 * Precedence: `--no-allow-free-verbs` refuses outright, `--allow-free-verbs`
 * wires it, an interactive run asks, and a NON-INTERACTIVE run wires it. That
 * last arm is the change #33 was really asking for: the machine most likely to be
 * denied mid-task is the headless one, and leaving it unwired because nobody was
 * there to say yes made a bare `tenjin install` produce an install that does not
 * work. The disclosure and the undo ride the output on both paths.
 *
 * INSTALLING TENJIN IS THE CONSENT for the mode-gated rules (owner call, PR #164
 * review round). The allowlist is written for the mode this run settles, on every
 * path including the headless one, and the FIRST install writes it — there is no
 * "chosen vs defaulted" distinction. What makes that defensible is that it is
 * DOCUMENTED, on the surface each reader is actually using. A human gets
 * `publishingLine`: what the agent will now do, in plain words, plus the one
 * command that turns it off. An agent, and any headless run, gets `modeGrant` on
 * the `--json` envelope, carrying both rule strings, the keystore sentence and
 * all three undos. docs/agent-permissions.md carries the rest. The terminal is
 * deliberately the leanest of the three (owner call): a rule string an operator
 * is meeting for the first time mid-install is not disclosure they can act on.
 * The bare CLI, with no install ever run, still defaults to `review` — install is
 * the consent anchor, so nothing is granted to someone who never ran it.
 *
 * The probe runs on EVERY path that might write, including the headless ones.
 * Nothing left to grant is not a question and not a write: it is the ordinary
 * state of a re-run, and returning the SNAPSHOT's own result is what makes a
 * re-run report `alreadyPresent` accurately instead of an empty pair. It also
 * keeps the consent gate honest, because calling the writer after a zero-pending
 * probe would re-read the file and silently re-add a rule revoked in between. An
 * unreadable file is "unknown", never "already allowed", so it falls through.
 */
async function resolvePermissions(args: {
  plans: HarnessPlan[];
  home: string;
  deps: InstallDeps;
  flag: boolean | undefined;
  dryRun: boolean;
  canPrompt: boolean;
  /**
   * The mode decision 1 just settled, never a raw flag or a project file: the
   * rule set follows what this install is putting the machine on, so the two
   * decisions cannot disagree.
   */
  publishMode: PublishMode;
}): Promise<PermissionsResult> {
  const { plans, home, deps, flag, dryRun, canPrompt, publishMode } = args;

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
  if (flag === false) return withRetraction(permissionsSkipped('claude', home, 'declined'));

  const probe = await (deps.inspectPermissions ?? inspectFreeVerbRules)(home, publishMode);
  if (probe.satisfied !== undefined) return withRetraction(probe.satisfied);
  // Nothing to GRANT, but something of ours to retract: an older version's rule
  // for a command that no longer exists, or the publish rule under a mode that
  // no longer carries it. That needs no consent — it only ever removes a rule
  // this CLI wrote — so it runs without the prompt.
  if (probe.pending !== null && probe.pending.length === 0) {
    return withRetraction(await wireFreeVerbAllowlist(home, publishMode));
  }

  if (flag === true || !canPrompt) {
    return withRetraction(await wireFreeVerbAllowlist(home, publishMode));
  }

  const confirm = deps.confirmPermissions ?? defaultConfirm;
  if (!(await confirm(permissionsQuestion(publishMode)))) {
    return withRetraction(permissionsSkipped('claude', home, 'declined'));
  }
  return withRetraction(await wireFreeVerbAllowlist(home, publishMode));
}

// --- Search hooks (decision 3) ----------------------------------------------------

/**
 * The search-hook question's literal copy. It names both hooks, because they are
 * installed together and the second one is the surprising half: an operator who
 * agreed to "check Tenjin before a web search" has not thereby agreed to a
 * reminder at the end of every turn, so the question says both out loud.
 */
export const SEARCH_HOOKS_QUESTION = 'Let Tenjin ride along with your web searches?';

export function searchHooksChoices(
  shelfHost: string = PRODUCTION_HOST,
): readonly { value: WebSearchMode; label: string; hint?: string }[] {
  return [
    {
      value: 'auto',
      label: 'Yes, check Tenjin first (recommended)',
      // The host the scripts will actually ask; see {@link hooksDisclosure}. A
      // consent prompt naming the wrong recipient is consent to something else.
      hint: `before a WebSearch or a subagent dispatch, ask ${shelfHost} the same question (free, anonymous, 2s budget) and mention a tested answer; the query or the first 400 chars of the prompt leaves the machine`,
    },
    {
      value: 'remind',
      label: 'Just remind me',
      hint: 'a one-line reminder, nothing sent off-machine',
    },
    { value: 'off', label: 'No hooks', hint: 'nothing is registered' },
  ];
}

/**
 * Settle the harness hooks. Same shape as the allowlist decision and the same
 * default posture: a flag settles it, an interactive run asks, and a
 * non-interactive run wires `auto` with the disclosure and undo in its output.
 *
 * The chosen mode is PERSISTED to config as BOTH `hooks.webSearch` and
 * `hooks.agentDispatch` (disjoint, both `auto` by default). One flag sets both
 * for the one-step install; `tenjin config set hooks.webSearch` or
 * `hooks.agentDispatch` can split them later without re-installing. A `--dry-run`
 * persists nothing, like the publish mode.
 */
async function resolveHooks(args: {
  plans: HarnessPlan[];
  home: string;
  ctx: CommandContext;
  deps: InstallDeps;
  flag: WebSearchMode | undefined;
  noHooks: boolean;
  dryRun: boolean;
  canPrompt: boolean;
}): Promise<HooksResult> {
  const { plans, home, ctx, deps, flag, noHooks, dryRun, canPrompt } = args;
  const dataDir = ctx.dataDir;
  const rawConfig = await loadRawConfig(dataDir);
  const rawHooks = rawConfig.hooks as
    | {
        webSearch?: WebSearchMode;
        searchMode?: WebSearchMode;
        agentDispatch?: WebSearchMode;
        dispatchMode?: string;
      }
    | undefined;
  const stored = rawHooks?.webSearch ?? rawHooks?.searchMode;
  const storedWebSearch = rawHooks?.webSearch ?? rawHooks?.searchMode;
  const storedAgentDispatchRaw =
    rawHooks?.agentDispatch ??
    (rawHooks?.dispatchMode === 'inherit'
      ? storedWebSearch
      : (rawHooks?.dispatchMode as WebSearchMode | undefined));
  const storedAgentDispatch =
    storedAgentDispatchRaw ?? (rawHooks?.searchMode !== undefined ? storedWebSearch : undefined);
  const storedWebSearchEff = storedWebSearch ?? DEFAULT_HOOK_MODE;
  const storedAgentDispatchEff = storedAgentDispatch ?? storedWebSearch ?? DEFAULT_HOOK_MODE;
  // Whether a past `tenjin push on` armed the push experiment (docs/command-reference.md#push-experimental): a
  // durable config key, read here rather than passed in, so this run's hooks
  // stay in step with it with no separate flag to remember.
  const pushOn = rawConfig.hooks?.push === 'on';
  const hasClaude = plans.some((p) => p.harness === 'claude');
  const hasHermes = plans.some((p) => p.harness === 'hermes');

  if (!hasClaude && !hasHermes) {
    const harness = plans[0]?.harness ?? 'shared';
    return hooksSkipped(
      harness,
      home,
      dataDir,
      flag ?? stored ?? DEFAULT_HOOK_MODE,
      'harness-not-claude',
    );
  }
  // `--no-hooks` is a decision about THIS RUN and writes no config, so the stored
  // mode is reported unchanged and a later bare re-run wires them. That is the
  // difference from `--search-hooks off`, which is a durable statement.
  if (noHooks) {
    return hooksSkipped(
      hasHermes ? 'hermes' : 'claude',
      home,
      dataDir,
      stored ?? DEFAULT_HOOK_MODE,
      'declined',
    );
  }

  const mode = await chooseHookMode(flag, stored, deps, dryRun, canPrompt, rawConfig);
  // Cancelling the select is a decision NOT to decide, so it behaves exactly like
  // `--no-hooks`: nothing registered, nothing written. Every other decision in
  // this walkthrough already treats Escape that way, and this one used to be the
  // single prompt where backing out still wired and persisted a mode.
  if (mode === null) {
    return hooksSkipped(
      hasHermes ? 'hermes' : 'claude',
      home,
      dataDir,
      stored ?? DEFAULT_HOOK_MODE,
      'declined',
    );
  }
  const resultHarness = hasHermes && !hasClaude ? 'hermes' : 'claude';
  if (dryRun) return hooksSkipped(resultHarness, home, dataDir, mode, 'dry-run');
  // Only sync agentDispatch on an explicit choice this run (flag or interactive
  // prompt). A flagless, non-interactive reinstall is just `mode = stored ?? DEFAULT`
  // and must never clobber a diverged agentDispatch (e.g. webSearch auto + agentDispatch off
  // -> flagless reinstall would otherwise silently re-enable dispatch). See A1igator R2 review.
  const isExplicitChoice = flag !== undefined || (canPrompt && !dryRun);
  const hasAnyHookKey =
    rawHooks?.webSearch !== undefined ||
    rawHooks?.agentDispatch !== undefined ||
    rawHooks?.searchMode !== undefined ||
    rawHooks?.dispatchMode !== undefined;
  const needsSync = isExplicitChoice
    ? rawHooks?.webSearch === undefined ||
      rawHooks?.agentDispatch === undefined ||
      mode !== storedWebSearchEff ||
      mode !== storedAgentDispatchEff
    : !hasAnyHookKey;
  if (needsSync) {
    await persistWebSearchHookMode(dataDir, mode);
    await persistAgentDispatchHookMode(dataDir, mode);
  }
  // `off` is a decision not to register anything, so settings.json is not touched
  // at all. It is NOT the same as an inert script: an operator who later sets the
  // mode back to `auto` re-runs install, which is what the fix string says.
  if (mode === 'off') return hooksSkipped(resultHarness, home, dataDir, mode, 'mode-off');
  if (!hasClaude) return hooksSkipped('hermes', home, dataDir, mode, 'native-harness');
  return wireSearchHooks({ homeDir: home, dataDir, mode, push: pushOn });
}

/**
 * Whether THIS run may write Hermes hook code, read off the single hooks decision
 * so the native path can never be more permissive than Claude's.
 *
 * Only the three reasons that are an operator choice withhold it. A Claude
 * settings.json that could not be read or parsed is a Claude problem: on a machine
 * running both, it must not silently cancel the Hermes wiring as well.
 */
function hermesHooksEnabled(hooks: HooksResult): boolean {
  return (
    hooks.skipped !== 'declined' &&
    hooks.skipped !== 'mode-off' &&
    hooks.skipped !== 'harness-not-claude'
  );
}

/** The stored default for a run that was never asked. */
const DEFAULT_HOOK_MODE: WebSearchMode = CONFIG_DEFAULTS.hooks.webSearch;

/**
 * Precedence for the hook mode: `--search-hooks` > the interactive select > an
 * already-configured mode > the default.
 *
 * NULL means the operator cancelled (Escape, ctrl-C, or an answer the schema does
 * not recognize). That is not a mode and must not be resolved into one: the
 * caller treats it as `--no-hooks` for this run, registering nothing and writing
 * no config, which is what every other cancel in this walkthrough does.
 */
async function chooseHookMode(
  flag: WebSearchMode | undefined,
  stored: WebSearchMode | undefined,
  deps: InstallDeps,
  dryRun: boolean,
  canPrompt: boolean,
  config: PartialConfig,
): Promise<WebSearchMode | null> {
  if (flag !== undefined) return flag;
  if (dryRun || !canPrompt) return stored ?? DEFAULT_HOOK_MODE;
  const shelfHost = hookRecipientHost(config);
  const answer = await (
    deps.promptSearchHooks ??
    ((): Promise<WebSearchMode | null> => defaultPromptSearchHooks(shelfHost))
  )();
  if (answer === null) return null;
  // The seam is injectable, so an answer is validated rather than trusted; an
  // unrecognized one is a cancel, not a write of something unknown.
  const parsed = WebSearchModeSchema.safeParse(answer);
  return parsed.success ? parsed.data : null;
}

function defaultPromptSearchHooks(shelfHost: string): Promise<WebSearchMode | null> {
  return selectOne<WebSearchMode>({
    message: SEARCH_HOOKS_QUESTION,
    // The recipient the hint names is the one the scripts will ask, not the
    // marketplace literal; see {@link hookRecipientHost}.
    choices: searchHooksChoices(shelfHost).map((c) => ({ ...c })),
    initialValue: 'auto',
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
  hermesHome: string,
  which: (bin: string) => boolean,
): HarnessPlan[] {
  if (override !== undefined && override.length > 0) {
    const plans = override.map((v) =>
      planFor(validateHarness(v), ['override'], true, home, hermesHome),
    );
    return dedupeBySkillsDir(plans);
  }

  const plans: HarnessPlan[] = [];
  // Same two probes doctor's skills check gates its per-directory verdicts on.
  const claudeBy = harnessDetectedBy(home, 'claude', which, hermesHome);
  const codexBy = harnessDetectedBy(home, 'codex', which, hermesHome);
  const hermesBy = harnessDetectedBy(home, 'hermes', which, hermesHome);
  if (claudeBy.length > 0) plans.push(planFor('claude', claudeBy, true, home, hermesHome));
  if (codexBy.length > 0) plans.push(planFor('codex', codexBy, true, home, hermesHome));
  if (hermesBy.length > 0) plans.push(planFor('hermes', hermesBy, true, home, hermesHome));
  if (plans.length === 0) {
    // Nothing detected: the shared Agent Skills location is the fallback target, so
    // a harness installed later still finds the skills.
    plans.push(planFor('shared', ['fallback'], false, home, hermesHome));
  }
  return dedupeBySkillsDir(plans);
}

function planFor(
  harness: Harness,
  detectedBy: string[],
  detected: boolean,
  home: string,
  hermesHome: string,
): HarnessPlan {
  const skillsDir = harnessTargetDir(home, harness, hermesHome);
  return {
    harness,
    detected,
    detectedBy,
    skillsDir,
    wiresAgentsMd: harness !== 'claude' && harness !== 'hermes',
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
