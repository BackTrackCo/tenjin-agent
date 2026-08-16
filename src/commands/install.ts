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
import { installSkill } from '../lib/skill-writer';
import type { SkillInstallStatus } from '../lib/skill-writer';
import { resolveSkillsSource, SKILL_NAMES } from '../lib/skills-source';
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
  SearchHookModeSchema,
  parsePublishModeFlag,
  parseSearchHookModeFlag,
} from '../lib/config';
import type { PublishMode, SearchHookMode } from '../lib/config';
import { persistInstallHarness, persistPublishMode, persistSearchHookMode } from './config';
import { runWalletCreate } from './wallet';
import { collectDoctorChecks, isNoWalletCheck } from './doctor';
import type { DoctorDeps, DoctorChecks } from './doctor';
import { describeWallet, resolveWalletProvider } from '../lib/wallet';
import type { PassphraseOverrides } from '../lib/wallet/local';
import { walletFileExists } from '../lib/wallet/store';
import { walletPath } from '../lib/paths';
import { PERMISSIONS_DOC_URL, recommendedPermissions } from '../lib/permissions';
import {
  FREE_VERB_RULES,
  inspectFreeVerbRules,
  permissionsSkipped,
  planFreeVerbAllowlist,
  retractModeGatedRules,
  rulesForPublishMode,
  wireFreeVerbAllowlist,
} from '../lib/harness-permissions';
import type { PermissionsResult } from '../lib/harness-permissions';
import { hooksSkipped, hooksUndo, wireSearchHooks } from '../lib/harness-hooks';
import { removeMarkerLines } from '../lib/uninstall';
import type { HooksResult } from '../lib/harness-hooks';
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
   * statement about behavior and writes `hooks.searchMode: off` to config.
   */
  noHooks: z.boolean().optional(),
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
  promptSearchHooks?: () => Promise<SearchHookMode | null>;
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
}

/**
 * `tenjin install`: detect the installed harness(es), copy the packaged skills
 * into each one's skills directory, wire the AGENTS.md pointer, ask AT MOST FOUR
 * questions (publishing, harness permissions, search hooks, wallet), then run the
 * doctor checks over the machine those answers just produced and print a short
 * summary. Everything that is not one of those four decisions is display: the
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
  return withInterruptGuard((markPhase) => installBody(input, ctx, deps, markPhase));
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
      ? parseSearchHookModeFlag(parsed.data.searchHooks, '--search-hooks')
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
  // The CLAUDE.md nudge is written BY DEFAULT, on both paths, only
  // `--no-claude-md` suppresses it. Codex already got the same line in its
  const harnesses: HarnessResult[] = [];
  // Unlocked. What makes concurrent writers safe here is the per-file atomic
  // rename, not serialization: the rm-then-write this used to be had two runs
  // reading each other's half-built trees (7 of 15 concurrent runs failed on raw
  // ENOENT/ENOTEMPTY renames), and 24 concurrent runs pass without a lock. The
  // self-heal is the other writer, and it writes these same bytes to these same
  // paths through the same writer.
  if (!dryRun) markPhase('writing-skills');
  for (const plan of plans) {
    harnesses.push(await applyPlan(plan, skillsSource, dryRun));
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

  // The four decisions, in order. Each one is skipped (with its own recorded
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
  // On BOTH paths now: the loop this command sets up needs a key, so a headless
  // run creates one rather than leaving the operator a setup that stops at the
  // first buy or publish.
  const wallet = await underDataDir(ctx.dataDir, () =>
    resolveWallet(ctx, deps, walletSkip(dryRun, noWallet), canPrompt),
  );

  // AFTER all four decisions, never before (#101). The snapshot used to be taken
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
    doctor: { status: doctor.failure !== undefined ? 'fail' : 'pass', checks: doctor.checks },
    publishMode,
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
    dryRun,
    dataDir: ctx.dataDir,
    harnesses,
    publishMode,
    permissions,
    hooks,
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

const EXAMPLE_QUESTION = "what actually changed in <library> v3's public API";

interface WalkthroughState {
  dryRun: boolean;
  /** Legacy pointer files this run cleaned; disclosed because they are the
   *  operator's own notes and we edited them. */
  pointerCleanup: string[];
  /** Where the wallet keystore lives, for the create disclosure. */
  dataDir: string;
  harnesses: HarnessResult[];
  publishMode: PublishModeSelection;
  permissions: PermissionsResult;
  hooks: HooksResult;
  wallet: WalletOutcome;
  doctor: DoctorChecks;
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
  // Same reason as the pointer line above: we edited the operator's settings.json
  // to REMOVE something, and the only way they learn it happened is a line here.
  if (s.permissions.removed.length > 0) {
    lines.push(
      `Removed ${s.permissions.removed.length} permission rule(s) an older tenjin left in ${s.permissions.path ?? 'your settings'} for commands that no longer exist.`,
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
    lines.push(paint(io, 'dim', hooksDisclosure(s.hooks)));
    lines.push(
      paint(io, 'dim', hooksUndo(s.hooks.path ?? '~/.claude/settings.json', s.hooks.scriptsDir)),
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

/** What the hooks do, in one line, at the moment they are written. */
function hooksDisclosure(h: HooksResult): string {
  const shared =
    'A Stop hook reminds you locally when a MISS you searched for is still unpublished; it makes no network call.';
  if (h.mode === 'remind') {
    return `The WebSearch hook prints a one-line reminder that Tenjin may have an answer; it sends nothing off-machine. ${shared}`;
  }
  return `Before a web search, the WebSearch hook asks tenjin.blog the same question (free and anonymous, ~2s budget, 5s harness kill) and mentions a tested answer if one exists; the query text leaves the machine. It can never block or change the search. ${shared}`;
}

/**
 * One line for the harness hooks. A skip is never silent, for the same reason the
 * permissions line is never silent: the operator would otherwise find out by
 * noticing that nothing ever happens.
 */
function hooksLine(io: Io, h: HooksResult): string {
  const label = paint(io, 'bold', 'Search hooks:');
  const wrote = h.added.length + h.updated.length;
  if (wrote > 0) {
    return `${paint(io, 'green', '✓')} ${label} ${h.mode} mode, ${wrote} hook(s) registered in ${h.path}. Change: tenjin config set hooks.searchMode <auto|remind|off>`;
  }
  if (h.skipped === undefined) {
    return `${paint(io, 'green', '✓')} ${label} ${h.mode} mode, already registered in ${h.path}`;
  }
  if (h.skipped === 'harness-not-claude') {
    return `${paint(io, 'dim', '-')} ${label} not wired (Claude Code only).`;
  }
  if (h.skipped === 'dry-run') {
    return `${paint(io, 'dim', '-')} ${label} unchanged (dry run).`;
  }
  if (h.skipped === 'mode-off') {
    return `${paint(io, 'dim', '-')} ${label} off (hooks.searchMode). Turn them on: tenjin config set hooks.searchMode auto, then tenjin install`;
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
  return h === 'claude' ? 'Claude Code' : h === 'codex' ? 'Codex' : 'Agent Skills';
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
  // A dry run reports the PLAN in the same fields, so it takes this branch and
  // says "would allow". An operator dry-running to find out whether publish and
  // edit get granted was previously told only "unchanged (dry run)".
  if (p.planned === true && p.added.length > 0) {
    return `${paint(io, 'dim', '-')} ${label} would allow ${allowed} tenjin commands in ${p.path}. Details: ${PERMISSIONS_DOC_URL}`;
  }
  if (p.added.length > 0) {
    return `${paint(io, 'green', '✓')} ${label} ${allowed} tenjin commands allowed in ${p.path}. Details: ${PERMISSIONS_DOC_URL}`;
  }
  if (p.skipped === undefined) {
    return `${paint(io, 'green', '✓')} ${label} the ${FREE_VERB_RULES.length} free tenjin commands were already allowed in ${p.path}`;
  }
  if (p.skipped === 'harness-not-claude') {
    return `${paint(io, 'dim', '-')} ${label} not wired (Claude Code only). The lines your harness needs: ${PERMISSIONS_DOC_URL}`;
  }
  if (p.skipped === 'dry-run') {
    return `${paint(io, 'dim', '-')} ${label} unchanged (dry run); the ${FREE_VERB_RULES.length} rules a real run needs are already there.`;
  }
  if (p.skipped === 'declined' || p.skipped === 'not-requested') {
    return `${paint(io, 'dim', '-')} ${label} unchanged. Allow the ${FREE_VERB_RULES.length} free tenjin commands with: tenjin install --allow-free-verbs`;
  }
  if (p.skipped === 'changed-since-read') {
    // Nothing is wrong with the file and the flag is not the remedy: another
    // writer touched it mid-run, so the merge has to be recomputed against what
    // is there now. The catch-all below says "fix it", which is wrong here.
    return `${paint(io, 'yellow', '!')} ${label} ${p.path} changed while it was being updated, so nothing was written. Re-run: tenjin install`;
  }
  return `${paint(io, 'yellow', '!')} ${label} ${p.path} was left untouched. Fix it, then: tenjin install --allow-free-verbs`;
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
    'It holds $0. Funding it is a human step: run `tenjin fund` (card checkout via Coinbase, opened in your browser), or send USDC on Base to that address.',
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
 * DOCUMENTED AND LOUD: `publishGrantLines` names the rules and the three ways out
 * in the walkthrough, and `modeGrant` carries the same strings on the `--json`
 * envelope, which is the only disclosure a headless run has. The bare CLI, with
 * no install ever run, still defaults to `review` — install is the consent
 * anchor, so nothing is granted to someone who never ran it.
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
  // Only Claude Code has a settings file with this shape. Codex and the shared
  // Agent Skills location gate permissions elsewhere, so there is nothing here to
  // write for them, and guessing at another harness's config would be the kind of
  // uninvited write this whole module is careful about.
  if (!plans.some((p) => p.harness === 'claude')) {
    return permissionsSkipped(plans[0]?.harness ?? 'shared', home, 'harness-not-claude');
  }
  if (dryRun) return (deps.planPermissions ?? planFreeVerbAllowlist)(home, publishMode);
  if (flag === false) return permissionsSkipped('claude', home, 'declined');

  // TIGHTENING FIRST, and unconditionally. `review` retracts through a pass that
  // only ever removes, so it cannot inherit the additive writer's complete-tier
  // precondition and silently decline — which is what made two of the three
  // documented undos fail on a machine whose free tier was merely incomplete.
  if (publishMode === 'review') {
    const retracted = await (deps.retractModeGated ?? retractModeGatedRules)(home);
    if (retracted.removed.length > 0 || retracted.skipped !== undefined) return retracted;
  }

  const probe = await (deps.inspectPermissions ?? inspectFreeVerbRules)(home, publishMode);
  if (probe.satisfied !== undefined) return probe.satisfied;
  // Nothing to GRANT, but something of ours to retract: an older version's rule
  // for a command that no longer exists, or the publish rule under a mode that
  // no longer carries it. That needs no consent — it only ever removes a rule
  // this CLI wrote — so it runs without the prompt.
  if (probe.pending !== null && probe.pending.length === 0) {
    return wireFreeVerbAllowlist(home, publishMode);
  }

  if (flag === true || !canPrompt) return wireFreeVerbAllowlist(home, publishMode);

  const confirm = deps.confirmPermissions ?? defaultConfirm;
  if (!(await confirm(permissionsQuestion(publishMode)))) {
    return permissionsSkipped('claude', home, 'declined');
  }
  return wireFreeVerbAllowlist(home, publishMode);
}

// --- Search hooks (decision 3) ----------------------------------------------------

/**
 * The search-hook question's literal copy. It names both hooks, because they are
 * installed together and the second one is the surprising half: an operator who
 * agreed to "check Tenjin before a web search" has not thereby agreed to a
 * reminder at the end of every turn, so the question says both out loud.
 */
export const SEARCH_HOOKS_QUESTION = 'Let Tenjin ride along with your web searches?';

export const SEARCH_HOOKS_CHOICES = [
  {
    value: 'auto',
    label: 'Yes, check Tenjin first (recommended)',
    hint: 'before a WebSearch, ask tenjin.blog the same question (free, anonymous, 2s budget) and mention a tested answer; the query text leaves the machine',
  },
  {
    value: 'remind',
    label: 'Just remind me',
    hint: 'a one-line reminder, nothing sent off-machine',
  },
  { value: 'off', label: 'No hooks', hint: 'nothing is registered' },
] as const satisfies readonly { value: SearchHookMode; label: string; hint?: string }[];

/**
 * Settle the harness hooks. Same shape as the allowlist decision and the same
 * default posture: a flag settles it, an interactive run asks, and a
 * non-interactive run wires `auto` with the disclosure and undo in its output.
 *
 * The chosen mode is PERSISTED to config, so it is the script's behavior from
 * then on and `tenjin config set hooks.searchMode` is enough to change it later
 * without re-installing. A `--dry-run` persists nothing, like the publish mode.
 */
async function resolveHooks(args: {
  plans: HarnessPlan[];
  home: string;
  ctx: CommandContext;
  deps: InstallDeps;
  flag: SearchHookMode | undefined;
  noHooks: boolean;
  dryRun: boolean;
  canPrompt: boolean;
}): Promise<HooksResult> {
  const { plans, home, ctx, deps, flag, noHooks, dryRun, canPrompt } = args;
  const dataDir = ctx.dataDir;
  const stored = (await loadRawConfig(dataDir)).hooks?.searchMode;

  if (!plans.some((p) => p.harness === 'claude')) {
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
    return hooksSkipped('claude', home, dataDir, stored ?? DEFAULT_HOOK_MODE, 'declined');
  }

  const mode = await chooseHookMode(flag, stored, deps, dryRun, canPrompt);
  // Cancelling the select is a decision NOT to decide, so it behaves exactly like
  // `--no-hooks`: nothing registered, nothing written. Every other decision in
  // this walkthrough already treats Escape that way, and this one used to be the
  // single prompt where backing out still wired and persisted a mode.
  if (mode === null) {
    return hooksSkipped('claude', home, dataDir, stored ?? DEFAULT_HOOK_MODE, 'declined');
  }
  if (dryRun) return hooksSkipped('claude', home, dataDir, mode, 'dry-run');
  if (mode !== (stored ?? DEFAULT_HOOK_MODE) || stored === undefined) {
    await persistSearchHookMode(dataDir, mode);
  }
  // `off` is a decision not to register anything, so settings.json is not touched
  // at all. It is NOT the same as an inert script: an operator who later sets the
  // mode back to `auto` re-runs install, which is what the fix string says.
  if (mode === 'off') return hooksSkipped('claude', home, dataDir, mode, 'mode-off');
  return wireSearchHooks({ homeDir: home, dataDir, mode });
}

/** The stored default for a run that was never asked. */
const DEFAULT_HOOK_MODE: SearchHookMode = CONFIG_DEFAULTS.hooks.searchMode;

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
  flag: SearchHookMode | undefined,
  stored: SearchHookMode | undefined,
  deps: InstallDeps,
  dryRun: boolean,
  canPrompt: boolean,
): Promise<SearchHookMode | null> {
  if (flag !== undefined) return flag;
  if (dryRun || !canPrompt) return stored ?? DEFAULT_HOOK_MODE;
  const answer = await (deps.promptSearchHooks ?? defaultPromptSearchHooks)();
  if (answer === null) return null;
  // The seam is injectable, so an answer is validated rather than trusted; an
  // unrecognized one is a cancel, not a write of something unknown.
  const parsed = SearchHookModeSchema.safeParse(answer);
  return parsed.success ? parsed.data : null;
}

function defaultPromptSearchHooks(): Promise<SearchHookMode | null> {
  return selectOne<SearchHookMode>({
    message: SEARCH_HOOKS_QUESTION,
    choices: SEARCH_HOOKS_CHOICES.map((c) => ({ ...c })),
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
  return { harness, detected, detectedBy, skillsDir, wiresAgentsMd: harness !== 'claude', home };
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
): Promise<HarnessResult> {
  const skills: SkillResult[] = [];
  const warnings: string[] = [];
  for (const name of SKILL_NAMES) {
    const { status, warning, preexisting } = await installSkill(
      join(skillsSource, name),
      join(plan.skillsDir, name),
      dryRun,
      name,
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
