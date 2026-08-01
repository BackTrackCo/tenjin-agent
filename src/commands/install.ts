import { existsSync, rmSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import { styleText } from 'node:util';
import { Stream } from 'node:stream';
import { CliError } from '../lib/errors';
import { hasCode } from '../lib/errno';
import { writeFileAtomic } from '../lib/atomic-json';
import { LockTimeoutError, withFileLock } from '../lib/lock';
import { skillsSyncLockPath } from '../lib/paths';
import { resolveSkillsSource, SKILL_NAMES } from '../lib/skills-source';
import {
  CLI_SKILL_NAMES,
  HARNESS_TARGETS,
  HOSTED_SKILL_NAME,
  harnessDetectedBy,
  harnessTargetDir,
  isModelInvocationDisabled,
  onPath,
} from '../lib/skill-wiring';
import type { HarnessTarget } from '../lib/skill-wiring';
import {
  CONFIG_DEFAULTS,
  loadRawConfig,
  PublishModeSchema,
  parsePublishModeFlag,
} from '../lib/config';
import type { PublishMode } from '../lib/config';
import { persistInstallHarness, persistPublishMode } from './config';
import { runWalletCreate } from './wallet';
import { collectDoctorChecks } from './doctor';
import type { DoctorDeps, DoctorChecks } from './doctor';
import { describeWallet, resolveWalletProvider } from '../lib/wallet';
import { walletFileExists } from '../lib/wallet/store';
import { recommendedPermissions } from '../lib/permissions';
import {
  FREE_VERB_RULES,
  inspectFreeVerbRules,
  permissionsSkipped,
  wireFreeVerbAllowlist,
} from '../lib/harness-permissions';
import type { PermissionsResult } from '../lib/harness-permissions';
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
  /** Opt-in for the ~/.claude/CLAUDE.md nudge: true (--claude-md), false
   * (--no-claude-md), or undefined (skip). Never a question: the walkthrough is
   * capped at three decisions. */
  claudeMd: z.boolean().optional(),
  /** Wire the free-verb harness allowlist without asking (`--allow-free-verbs`). */
  allowFreeVerbs: z.boolean().optional(),
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

type PublishModeSource = 'flag' | 'existing' | 'prompt' | 'default-skipped';
interface PublishModeSelection {
  value: PublishMode;
  source: PublishModeSource;
}

/** How the wallet step resolved, so rendering stays separate from prompting. */
interface WalletOutcome {
  status: 'existing' | 'created' | 'none';
  address?: string;
}

/**
 * The one line `install` keeps in an AGENTS.md (and, opt-in, in a CLAUDE.md) so the
 * harness reads it as global guidance, not the raw ~/.agents/skills scan. It is an
 * instinct nudge: run a free `tenjin search` before regenerating public research,
 * then a pointer to where the skills live. The HTML-comment marker keeps re-runs
 * idempotent: a matching line is left untouched, a drifted line (an older install's
 * copy) is rewritten in place, and an absent line is appended, so we never duplicate.
 */
const SKILLS_MARKER = '<!-- tenjin-cli:skills -->';

/**
 * The instinct nudge line, pointed at `skillsDir`. One line, no em dashes: the
 * marker, the search-before-regenerating nudge, then where the skills live.
 */
function nudgeLine(skillsDir: string): string {
  return `${SKILLS_MARKER} Tenjin: before regenerating public research (version-specific compatibility, integration gotchas, benchmarks, dated probes), run 'tenjin search "<question>" --json' first; it is free and anonymous but sends the generalized question text to tenjin.blog, so strip private identifiers. Skills (tenjin-search, tenjin-publish, tenjin) are installed at ${skillsDir}; read the relevant SKILL.md before using the CLI.`;
}

/**
 * Upsert the marker line into a file's text. Finds the existing marker line by its
 * marker prefix (not exact text) so an older install's drifted copy is recognized:
 * a matching line is `none`, a drifted line is `replace`d in place, an absent marker
 * is `append`ed. `content` is the text to write (null when nothing changes).
 */
function upsertMarkerLine(
  existing: string | null,
  line: string,
): { content: string | null; change: 'append' | 'replace' | 'none' } {
  const text = existing ?? '';
  if (!text.includes(SKILLS_MARKER)) {
    const prefix = text.length === 0 || text.endsWith('\n') ? '' : '\n';
    return { content: `${text}${prefix}${line}\n`, change: 'append' };
  }
  const lines = text.split('\n');
  const idx = lines.findIndex((l) => l.includes(SKILLS_MARKER));
  if (lines[idx] === line) return { content: null, change: 'none' };
  lines[idx] = line;
  return { content: lines.join('\n'), change: 'replace' };
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
  status: 'installed' | 'updated' | 'up-to-date' | 'would-install' | 'would-update';
  /** Was a real copy (a SKILL.md, not just the directory) already on disk before this run? */
  preexisting: boolean;
  /** Is this one of the two CLI adapter skills (as opposed to the hosted mirror)? */
  cli: boolean;
  /** Will a harness surface it to the model after this run? On a --dry-run nothing is
   * written, so it answers for the packaged copy that would land. */
  modelInvocable: boolean;
}

interface AgentsMdResult {
  path: string;
  status: 'appended' | 'already-present' | 'updated' | 'would-append' | 'would-update';
}

interface ClaudeMdResult {
  path: string;
  status: 'written' | 'up-to-date' | 'updated' | 'skipped' | 'would-write' | 'would-update';
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
  agentsMd?: AgentsMdResult;
  claudeMd?: ClaudeMdResult;
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
  /** How long to wait on a held skills lock. Shortened in tests. */
  lockTimeoutMs?: number;
  /** Whether decision 2 has anything left to grant; defaults to reading settings.json. */
  inspectPermissions?: (
    home: string,
  ) => Promise<{ pending: string[] | null; satisfied?: PermissionsResult }>;
  /** Decision 3: "Create a wallet now?"; defaults to the clack confirm (default yes). */
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
}

/**
 * `tenjin install`: detect the installed harness(es), copy the packaged skills
 * into each one's skills directory, wire the AGENTS.md pointer, run the doctor
 * checks, then ask AT MOST THREE questions (publishing, harness permissions,
 * wallet) and print a short summary. Everything that is not one of those three
 * decisions is display: the security reference material lives in `doctor` and
 * the README, not in the middle of a setup flow.
 *
 * Like every command it is human-first (the global output contract): at a TTY
 * without `--json` it prompts and returns the walkthrough as humanLines, which
 * the dispatcher prints to stdout with no envelope. With `--json` or piped
 * stdout it returns the envelope, no prompts, no wallet step. Idempotent: a
 * re-run reports up-to-date, never duplicates the AGENTS.md line, and adds no
 * permission rule twice. `--dry-run` writes nothing.
 */
export async function runInstall(
  input: InstallInput,
  ctx: CommandContext,
  deps: InstallDeps = {},
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
  const claudeMdFlag = parsed.data.claudeMd;
  const allowFreeVerbs = parsed.data.allowFreeVerbs === true;
  // Validate --publish-mode UP FRONT so a bad value fails before any wiring.
  const publishModeFlag =
    parsed.data.publishMode !== undefined ? parseModeFlag(parsed.data.publishMode) : undefined;
  const env = deps.env ?? process.env;
  const home = deps.homeDir ?? homedir();
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
  // The CLAUDE.md nudge is flag-only now: `--claude-md` writes it, `--no-claude-md`
  // and an absent flag skip it. It used to be a fourth interactive question, and
  // the walkthrough's whole point is that there are three.
  const claudeMdWrite = claudeMdFlag === true;
  const harnesses: HarnessResult[] = [];
  // Wiring takes a lock. Each skill is replaced by rm-then-write, so two runs
  // racing the same directory saw each other's half-built trees and died on raw
  // ENOENT/ENOTEMPTY renames: 7 of 15 concurrent runs failed. A dry run writes
  // nothing, so it needs no lock.
  await underSyncLock(
    ctx.dataDir,
    dryRun,
    async () => {
      for (const plan of plans) {
        harnesses.push(await applyPlan(plan, skillsSource, dryRun, claudeMdWrite));
      }
      await assertSkillsLanded(plans, dryRun);
    },
    deps.lockTimeoutMs,
  );
  // An explicit --harness is REMEMBERED, before the embedded doctor run so this run's
  // own check already honours it. Detection cannot see a harness we do not probe for,
  // so without the record a directory the user named by hand is a target for one run
  // and then invisible to every later doctor — including for the #35 shadowing defect
  // it was chosen to hold. `--dry-run` records nothing, like the publish-mode write.
  if (explicitHarness && !dryRun) {
    await persistInstallHarness(
      ctx.dataDir,
      plans.map((p) => p.harness),
    );
  }
  // The embedded doctor run inspects the same `home` install just wrote into, so
  // its skill-wiring check reports THIS run's result rather than os.homedir()'s.
  // `which` goes with it: the check gates its verdicts on harness detection, and a
  // different probe there would judge directories this run never targeted.
  const doctorDeps: DoctorDeps = { ...(deps.doctorDeps ?? {}) };
  doctorDeps.homeDir ??= home;
  doctorDeps.which ??= which;
  const collect = deps.collectChecks ?? ((c) => collectDoctorChecks(c, doctorDeps));
  const doctor = await collect(ctx);

  // The three decisions, in order. Each one is skipped (with its own recorded
  // reason) when a flag already settled it or when there is no one to ask.
  if (canPrompt) await (deps.intro ?? clackIntro)('tenjin install');
  const publishMode = await resolvePublishMode(publishModeFlag, ctx, deps, dryRun, canPrompt);
  const permissions = await resolvePermissions({
    plans,
    home,
    deps,
    flag: allowFreeVerbs,
    dryRun,
    canPrompt,
  });
  // The wallet question belongs to the human walkthrough only: a machine run has
  // never created a key, and that stays true.
  const wallet = humanOutput
    ? await resolveWallet(ctx, deps, dryRun || !canPrompt || noWallet)
    : undefined;
  if (canPrompt) await (deps.outro ?? clackOutro)('Setup complete.');

  const data = {
    dryRun,
    skillsSource,
    harnesses,
    doctor: { status: doctor.failure !== undefined ? 'fail' : 'pass', checks: doctor.checks },
    publishMode,
    // Shipped with the install rather than left for the operator to discover after
    // their first auto-mode denial (#33). Static constants, no config key: see
    // lib/permissions.ts for why this is deliberately not operator-editable state.
    // `wired` is the outcome of THIS run's optional settings.json write; the three
    // recommendation tiers beside it are unchanged, so a machine consumer that
    // read `alwaysSafe` / `optIn` / `neverAllowlisted` before still does.
    permissions: { ...recommendedPermissions(), wired: permissions },
  };

  // Machine path (--json or piped stdout): today's envelope, no wallet step.
  if (!humanOutput) return { data };

  // Human path: the walkthrough as humanLines (the global emitSuccess prints them
  // to stdout at a TTY and never an envelope).
  const humanLines = buildWalkthrough(ctx.io, {
    dryRun,
    harnesses,
    publishMode,
    permissions,
    wallet: wallet ?? { status: 'none' },
    doctor,
  });
  return { data, humanLines };
}

const EXAMPLE_QUESTION = "what actually changed in <library> v3's public API";

interface WalkthroughState {
  dryRun: boolean;
  harnesses: HarnessResult[];
  publishMode: PublishModeSelection;
  permissions: PermissionsResult;
  wallet: WalletOutcome;
  doctor: DoctorChecks;
}

/**
 * The human surface: anything that genuinely needs attention (a dry-run banner,
 * an overwrite warning, a consent disclosure, a failing check) followed by a
 * summary of at most five lines. On a clean install the summary IS the output.
 */
function buildWalkthrough(io: Io, s: WalkthroughState): string[] {
  const lines: string[] = [];
  if (s.dryRun) lines.push(paint(io, 'yellow', 'Dry run: nothing was written.'));
  lines.push(...noticeLines(io, s));
  if (lines.length > 0) lines.push('');
  lines.push(...summaryLines(io, s));
  return lines;
}

/**
 * Everything above the summary: per-harness warnings, the Codex network rule,
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
    // When a nudge line was actually written or refreshed, disclose what it does
    // (question text leaves the machine) and how to undo it. This makes a re-run
    // that silently upgrades an older pointer line visible, not just the first write.
    const nudgePaths = nudgeFilesTouched(h);
    if (nudgePaths.length > 0) {
      lines.push(
        paint(
          io,
          'dim',
          'The nudge tells agents to run a free anonymous `tenjin search` before regenerating research; the generalized question text is sent to tenjin.blog.',
        ),
      );
      lines.push(
        paint(
          io,
          'dim',
          `Undo anytime: delete the ${SKILLS_MARKER} line from ${nudgePaths.join(' and ')}.`,
        ),
      );
    }
    if (h.codexNetworkRule !== undefined) {
      lines.push(paint(io, 'dim', 'Codex blocks network by default; add to ~/.codex/config.toml:'));
      for (const rl of h.codexNetworkRule.split('\n')) lines.push(paint(io, 'dim', `  ${rl}`));
    }
    for (const w of h.warnings) lines.push(paint(io, 'yellow', `! ${w}`));
  }
  if (s.permissions.warning !== undefined) {
    // Sanitized for the same reason doctorNotices sanitizes `detail`/`fix`: this
    // string embeds a V8 JSON parse error, and V8 quotes the offending input, so
    // ~20 bytes of whatever is in settings.json (escapes included) reach the
    // terminal at the moment we tell the operator we left their file alone.
    lines.push(paint(io, 'yellow', `! ${sanitizeForTerminal(s.permissions.warning)}`));
  }
  lines.push(...doctorNotices(io, s.doctor));
  return lines;
}

/**
 * The closing summary, capped at one line per subject: skills, publishing,
 * permissions, wallet, and the command to run next.
 */
function summaryLines(io: Io, s: WalkthroughState): string[] {
  return [
    ...s.harnesses.map((h) => skillsLine(io, h, s.dryRun)),
    publishingLine(io, s.publishMode.value),
    permissionsLine(io, s.permissions),
    walletLine(io, s.wallet),
    `${paint(io, 'bold', 'Next:')} tenjin search "${EXAMPLE_QUESTION}"`,
  ];
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
  const wired: string[] = [];
  if (h.agentsMd !== undefined) wired.push('AGENTS.md nudge');
  if (h.claudeMd !== undefined && h.claudeMd.status !== 'skipped') wired.push('CLAUDE.md nudge');
  const suffix = wired.length > 0 ? ` + ${wired.join(' + ')}` : '';
  const head = `${harnessLabel(h.harness)}: ${h.skills.length} skills ${verb}${suffix}`;
  return `${paint(io, 'green', '✓')} ${paint(io, 'bold', head)} in ${h.skillsDir}. ${skillRoster(h)}.`;
}

/** One line for the settled consent mode, with the same consequence the question showed. */
function publishingLine(io: Io, mode: PublishMode): string {
  return `${paint(io, 'green', '✓')} ${paint(io, 'bold', `Publishing: ${mode}`)}. ${modeBlurb(mode)}`;
}

/**
 * One line for the harness allowlist: what landed, or what to run to get it. A
 * skip is never silent, because the operator's next auto-mode session is where
 * they would otherwise find out (#33).
 *
 * "free", never "read-only": see PERMISSIONS_QUESTION for why this tier cannot
 * honestly be called the latter. The line that reports a WRITE carries the
 * `doctor` pointer too, since that is the other moment an operator learns rules
 * landed without seeing them or the flag caveat that qualifies them.
 */
function permissionsLine(io: Io, p: PermissionsResult): string {
  const label = paint(io, 'bold', 'Permissions:');
  if (p.added.length > 0) {
    return `${paint(io, 'green', '✓')} ${label} ${p.added.length} free tenjin commands added to ${p.path}. Full caveats: tenjin doctor`;
  }
  if (p.skipped === undefined) {
    return `${paint(io, 'green', '✓')} ${label} the ${FREE_VERB_RULES.length} free tenjin commands were already allowed in ${p.path}`;
  }
  if (p.skipped === 'harness-not-claude') {
    return `${paint(io, 'dim', '-')} ${label} not wired (Claude Code only). Run \`tenjin doctor\` for the lines your harness needs.`;
  }
  if (p.skipped === 'dry-run') {
    return `${paint(io, 'dim', '-')} ${label} unchanged (dry run).`;
  }
  if (p.skipped === 'declined') {
    return `${paint(io, 'dim', '-')} ${label} unchanged. Add them anytime: tenjin install --allow-free-verbs`;
  }
  if (p.skipped === 'not-requested') {
    return `${paint(io, 'dim', '-')} ${label} unchanged. Allow the ${FREE_VERB_RULES.length} free tenjin commands with: tenjin install --allow-free-verbs`;
  }
  return `${paint(io, 'yellow', '!')} ${label} ${p.path} was left untouched. Fix it, then: tenjin install --allow-free-verbs`;
}

function walletLine(io: Io, w: WalletOutcome): string {
  const label = paint(io, 'bold', 'Wallet:');
  if (w.status === 'existing') {
    return `${paint(io, 'green', '✓')} ${label} ${w.address} (existing). Check funds with: tenjin wallet balance`;
  }
  if (w.status === 'created') {
    return `${paint(io, 'green', '✓')} ${label} ${w.address}. Fund it with a few dollars of USDC on Base, then: tenjin wallet balance`;
  }
  return `${paint(io, 'dim', '-')} ${label} none. Create one later with: tenjin wallet create`;
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
 * The nudge files whose marker line this run wrote or refreshed (append/update, and
 * their dry-run would-* previews). An untouched line (already-present / up-to-date)
 * or a skipped CLAUDE.md is not included, so the disclosure only fires on a change.
 */
function nudgeFilesTouched(h: HarnessResult): string[] {
  const paths: string[] = [];
  if (
    h.agentsMd !== undefined &&
    ['appended', 'updated', 'would-append', 'would-update'].includes(h.agentsMd.status)
  ) {
    paths.push(h.agentsMd.path);
  }
  if (
    h.claudeMd !== undefined &&
    ['written', 'updated', 'would-write', 'would-update'].includes(h.claudeMd.status)
  ) {
    paths.push(h.claudeMd.path);
  }
  return paths;
}

/** The single line of consequence attached to a mode, wherever it is shown. */
function modeBlurb(v: PublishMode): string {
  return v === 'auto'
    ? 'Your agent publishes clean pieces on its own; your harness still shows each command for approval.'
    : v === 'review'
      ? 'Your agent asks you in chat before every publish.'
      : 'Fully unattended; only hard blocks stop it.';
}

/**
 * Decision 3, unchanged in behavior: ask only when no wallet exists, and never
 * under `--no-wallet`, `--dry-run`, or a run we cannot prompt in.
 */
async function resolveWallet(
  ctx: CommandContext,
  deps: InstallDeps,
  skipCreate: boolean,
): Promise<WalletOutcome> {
  const exists = await (deps.walletExists ?? walletFileExists)(ctx.dataDir);
  if (exists) {
    return {
      status: 'existing',
      address: await (deps.walletAddress ?? existingWalletAddress)(ctx),
    };
  }
  if (skipCreate) return { status: 'none' };

  const confirm = deps.confirmWallet ?? defaultConfirm;
  if (!(await confirm(WALLET_QUESTION))) return { status: 'none' };

  return { status: 'created', address: await (deps.createWallet ?? defaultCreateWallet)(ctx) };
}

async function existingWalletAddress(ctx: CommandContext): Promise<string> {
  return (await describeWallet(resolveWalletProvider(ctx))).address;
}

async function defaultCreateWallet(ctx: CommandContext): Promise<string> {
  const result = await runWalletCreate(ctx);
  return (result.data as { address: string }).address;
}

/** The shared confirm, defaulting to YES (setup ergonomics); cancel reads as no. */
function defaultConfirm(label: string): Promise<boolean> {
  return confirmChoice(label, true);
}

/**
 * Doctor problems only. A fully green run prints nothing here: the summary is
 * the whole output, and "everything checks out" is what an absent warning means.
 */
function doctorNotices(io: Io, doctor: DoctorChecks): string[] {
  const problems = doctor.checks.filter((c) => c.status !== 'ok');
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
 * The STORED default: what a non-interactive run, a cancelled question, or a
 * `--dry-run` leaves `publish.mode` at, which is to say unset. It is deliberately
 * NOT the interactively recommended answer below: recommending `auto` is a thing
 * we do to a human who is looking at the consequence, never a thing that happens
 * to a machine run that was never asked.
 */
const DEFAULT_MODE: PublishMode = CONFIG_DEFAULTS.publish.mode;

/** Decision 1's literal copy: one line of consequence per option, `auto` first. */
export const PUBLISH_MODE_CHOICES = [
  {
    value: 'auto',
    label: 'Auto (recommended)',
    hint: 'your agent publishes clean pieces on its own; your harness still shows each command for approval',
  },
  { value: 'review', label: 'Ask me in chat first' },
  { value: 'full-auto', label: 'Fully unattended', hint: 'only hard blocks stop it' },
] as const satisfies readonly { value: PublishMode; label: string; hint?: string }[];

export const PUBLISH_MODE_QUESTION = 'When your agent has something worth publishing:';

/**
 * Resolve (and, for an explicit choice, persist) the publish consent mode at
 * install time. Precedence: `--publish-mode` flag > an already-configured global
 * mode > the interactive select > the untouched default. Only an explicit choice
 * writes: a cancelled select, a non-interactive run, and `--dry-run` all leave
 * `publish.mode` unset so its provenance stays `default`.
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

  // `interactive` is the walkthrough gate (already false under --json or off a TTY),
  // so a machine consumer never sits behind a prompt.
  if (dryRun || !interactive) return { value: DEFAULT_MODE, source: 'default-skipped' };

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
 * spend and cannot open the keystore, so that is what the question says.
 *
 * The pointer at `tenjin doctor` is how FLAG_CAVEAT's "printed with the rules
 * everywhere they are printed" contract is met at the consent moment. The
 * walkthrough no longer prints the rules or the flag caveat, so the yes/no that
 * replaced them names the one command that prints both, in full, unchanged.
 */
export const PERMISSIONS_QUESTION = [
  'Let your agent search tenjin without permission popups?',
  `Adds ${FREE_VERB_RULES.length} free commands to ~/.claude/settings.json.`,
  'None can spend USDC or open your wallet keystore;',
  'three send or store data (search, outcome, read).',
  'Full caveats: tenjin doctor.',
].join(' ');

/** Decision 3's literal copy. */
export const WALLET_QUESTION = 'Create a wallet now?';

/**
 * Settle the harness allowlist. The write itself is consent-gated and free-verb
 * only (see lib/harness-permissions.ts); this decides ONLY whether to call it.
 * `--allow-free-verbs` wires it headlessly, an interactive run asks, and a
 * non-interactive run without the flag changes nothing and says so.
 */
async function resolvePermissions(args: {
  plans: HarnessPlan[];
  home: string;
  deps: InstallDeps;
  flag: boolean;
  dryRun: boolean;
  canPrompt: boolean;
}): Promise<PermissionsResult> {
  const { plans, home, deps, flag, dryRun, canPrompt } = args;
  // Only Claude Code has a settings file with this shape. Codex and the shared
  // Agent Skills location gate permissions elsewhere, so there is nothing here to
  // write for them, and guessing at another harness's config would be the kind of
  // uninvited write this whole module is careful about.
  if (!plans.some((p) => p.harness === 'claude')) {
    return permissionsSkipped(plans[0]?.harness ?? 'shared', home, 'harness-not-claude');
  }
  if (dryRun) return permissionsSkipped('claude', home, 'dry-run');
  if (flag) return wireFreeVerbAllowlist(home);
  if (!canPrompt) return permissionsSkipped('claude', home, 'not-requested');

  // Nothing left to grant is not a question: every rule already present is the
  // ordinary state of a re-run. The SNAPSHOT's result is returned rather than
  // calling the writer again, because a second read would re-add a rule revoked in
  // between with no prompt. An unreadable file is "unknown", not "already
  // allowed", so it falls through and still asks.
  const probe = await (deps.inspectPermissions ?? inspectFreeVerbRules)(home);
  if (probe.satisfied !== undefined) return probe.satisfied;

  const confirm = deps.confirmPermissions ?? defaultConfirm;
  if (!(await confirm(PERMISSIONS_QUESTION))) {
    return permissionsSkipped('claude', home, 'declined');
  }
  return wireFreeVerbAllowlist(home);
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
  claudeMdWrite: boolean,
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

  if (plan.wiresAgentsMd) {
    result.agentsMd = await wireAgentsMd(plan, dryRun);
    result.codexNetworkRule = CODEX_NETWORK_RULE;
  } else if (plan.harness === 'claude') {
    result.claudeMd = await wireClaudeMd(plan, dryRun, claudeMdWrite);
  }
  return result;
}

/**
 * Write the nudge line into ~/.claude/CLAUDE.md when opted in. Creates the file if
 * absent, rewrites a drifted marker line in place, and leaves a matching line alone.
 * `skipped` means the user opted out (or was never asked).
 */
async function wireClaudeMd(
  plan: HarnessPlan,
  dryRun: boolean,
  write: boolean,
): Promise<ClaudeMdResult> {
  const path = join(plan.home, '.claude', 'CLAUDE.md');
  if (!write) return { path, status: 'skipped' };

  const existing = existsSync(path) ? await readFile(path, 'utf8') : null;
  const { content, change } = upsertMarkerLine(existing, nudgeLine(plan.skillsDir));
  if (change === 'none') return { path, status: 'up-to-date' };
  if (!dryRun && content !== null) await writeFileAtomic(path, content);
  if (change === 'append') return { path, status: dryRun ? 'would-write' : 'written' };
  return { path, status: dryRun ? 'would-update' : 'updated' };
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
  const path = join(dryRun ? skillsSource : skillsDir, name, 'SKILL.md');
  if (!existsSync(path)) return false;
  try {
    return !isModelInvocationDisabled(await readFile(path, 'utf8'));
  } catch {
    return false;
  }
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
    // Says "permissions" only now that the wiring holds a lock. Before that, this
    // fired on a lost race and sent people to chmod a directory that was fine.
    fix: `Check that you can write to the skills directory (\`ls -ld ${dirname(missing[0] ?? '')}\`), then re-run \`tenjin install\`.`,
  });
}

/**
 * Copy one skill directory. The packaged copy is canonical: an absent target is
 * `installed`, an identical target is `up-to-date`, and any local drift is
 * overwritten and reported as `updated` with a warning. On --dry-run nothing is
 * written and the status reads `would-*`.
 */
async function installSkill(
  srcDir: string,
  destDir: string,
  dryRun: boolean,
  name: string,
): Promise<{ status: SkillResult['status']; warning?: string; preexisting: boolean }> {
  const src = await readTree(srcDir);
  const dest = await readTree(destDir);
  if (src === null) {
    // assertSkillsSource already guards SKILL.md; this is defensive for an empty dir.
    throw new CliError('INTERNAL', `Packaged skill source ${srcDir} is empty`);
  }
  // A real prior copy means a SKILL.md, not merely the directory: readTree returns
  // an empty Map for a bare `mkdir`, and an interrupted write leaves a stray file
  // with no SKILL.md. Neither is a skill that "was already here".
  const preexisting = dest?.has('SKILL.md') === true;

  // `change` is keyed off BYTES, not off `preexisting`: the rm below deletes whatever
  // is in the destination, so anything with content in it is an overwrite and must
  // carry the warning, even with no SKILL.md — a hand-saved `skills.md` and a
  // directory of the user's own notes both live here. Only a bare `mkdir` (or a dir
  // that does not exist) is a create, which is what `preexisting` reporting is for.
  const change =
    dest === null || dest.size === 0 ? 'create' : treesEqual(src, dest) ? 'none' : 'update';

  // Entries the wipe takes that the package does not ship, NAMED so a local
  // references/ folder is not lost silently. Includes non-regular entries, which
  // readTree does not carry but the rm still removes.
  const removed = [
    ...(dest === null ? [] : [...dest.keys()].filter((rel) => !src.has(rel))),
    ...(await nonFileEntries(destDir)),
  ].sort();
  // Only the files BOTH sides have: one extra local file is not a copy that
  // "differed".
  const shared =
    dest !== null && [...src.keys()].some((rel) => !bufEquals(src.get(rel), dest.get(rel)));

  if (!dryRun && change !== 'none') {
    await refuseSymlinkedSkillDir(destDir, name);
    try {
      // Overwrite wholesale so the packaged copy is exactly what lands, with no stray
      // local files left behind. rm is a no-op when the dir is absent.
      await rm(destDir, { recursive: true, force: true });
      for (const [rel, content] of src) {
        await writeFileAtomic(join(destDir, rel), content);
      }
    } catch (err) {
      // A raw errno under INTERNAL reads as a CLI bug and carries no fix, which is
      // how an unwritable HOME and a lost directory race both surfaced. Both get a
      // fix naming what to check.
      const denied = hasCode(err, 'EACCES') || hasCode(err, 'EPERM');
      const raced = hasCode(err, 'ENOENT') || hasCode(err, 'ENOTEMPTY') || hasCode(err, 'EEXIST');
      if (!denied && !raced) throw err;
      throw new CliError('INTERNAL', `Could not write the ${name} skill to ${destDir}.`, {
        fix: denied
          ? `Permission denied. Check that you can write to ${dirname(destDir)} (\`ls -ld ${dirname(destDir)}\`), then re-run \`tenjin install\`.`
          : `${destDir} changed underneath this run. Make sure nothing else is writing it, then re-run \`tenjin install\`.`,
        cause: err,
      });
    }
  }

  if (change === 'create') return { status: dryRun ? 'would-install' : 'installed', preexisting };
  if (change === 'none') return { status: 'up-to-date', preexisting };
  return {
    status: dryRun ? 'would-update' : 'updated',
    preexisting,
    // The hosted skill is a MIRROR of tenjin.blog/skills.md (roadmap G4), so a
    // differing local copy is a replacement, not the drift warning the CLI skills
    // get. Neither side carries a version or date, so the wording claims no
    // direction: the local file may well be a newer fetch than this package's copy.
    warning:
      name === HOSTED_SKILL_NAME
        ? `${destDir}: the hosted Tenjin skill differed and ${dryRun ? 'would be' : 'was'} replaced by this package's mirror of tenjin.blog/skills.md, which may be older; it stays as the zero-install fallback. Re-fetch it from tenjin.blog/skills.md if you need the current one.${removedNote(removed, dryRun)}`
        : `${destDir}: ${
            shared
              ? `local skill copy differed and ${dryRun ? 'would be' : 'was'} overwritten (the packaged copy is canonical).`
              : `the packaged copy is canonical and ${dryRun ? 'would be' : 'was'} written over this directory.`
          }${removedNote(removed, dryRun)}`,
  };
}

/** The clause naming local files the wipe takes. Named, not counted: a count does
 *  not tell anyone whether losing them matters. */
function removedNote(removed: readonly string[], dryRun: boolean): string {
  if (removed.length === 0) return '';
  const one = removed.length === 1;
  const noun = one ? '1 local file' : `${removed.length} local files`;
  const verb = dryRun ? 'would also be removed' : one ? 'was also removed' : 'were also removed';
  // A filename is operator data: one carrying newlines or ANSI bytes could forge
  // status lines beside this warning.
  const names = removed.map((r) => sanitizeForTerminal(r)).join(', ');
  return ` ${noun} not shipped with the skill ${verb}: ${names}.`;
}

/**
 * Run `fn` holding the skills lock, or directly when nothing is written.
 *
 * A contended lock is a normal outcome (another `tenjin install` is mid-write),
 * so the timeout is translated rather than escaping as an untyped
 * LockTimeoutError under INTERNAL.
 */
async function underSyncLock(
  dataDir: string,
  dryRun: boolean,
  fn: () => Promise<void>,
  timeoutMs?: number,
): Promise<void> {
  if (dryRun) return fn();
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const lockPath = skillsSyncLockPath(dataDir);
  // Node's default signal action terminates WITHOUT running `finally`, so an
  // interrupt here would strand the lock and make every later install time out on
  // it. Release it and say what state the machine is in: exiting 130 with no
  // output at all left people unable to tell what had been written.
  const onSignal = (signal: NodeJS.Signals): void => {
    rmSync(lockPath, { recursive: true, force: true });
    process.stderr.write(
      `\nInterrupted while writing skills. Some may be half-written and permissions were not changed; re-run \`tenjin install\` to finish.\n`,
    );
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    await withFileLock(lockPath, fn, timeoutMs !== undefined ? { timeoutMs } : {});
  } catch (err) {
    if (!(err instanceof LockTimeoutError)) throw err;
    throw new CliError('REFUSED', 'Another `tenjin install` is writing the skills.', {
      fix: `Wait for it to finish and re-run. If nothing else is running, remove ${err.lockPath} and retry.`,
      cause: err,
    });
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

/**
 * Refuse a symlinked skill directory rather than choosing which data to destroy.
 * Following the link and wiping the TARGET takes whatever the operator manages
 * there; removing the link instead detaches the path they set up. Neither is ours
 * to pick silently, so nothing is written and the operator is told what to change.
 *
 * Not the same call as the settings.json writer, which does resolve its link: that
 * write is additive and never clobbers, and this one is a recursive delete.
 */
async function refuseSymlinkedSkillDir(destDir: string, name: string): Promise<void> {
  // lstat, not existsSync: existsSync follows the link, so a DANGLING link reads
  // as absent and the write below would replace it with a real directory.
  const entry = await lstat(destDir).catch(() => null);
  if (entry === null || !entry.isSymbolicLink()) return;
  throw new CliError('REFUSED', `${destDir} is a symlink, so the ${name} skill was not written.`, {
    fix: `Installing would replace it wholesale, which would either delete whatever the link points at or detach the link. Replace ${destDir} with a real directory (or move it aside), then re-run \`tenjin install\`.`,
  });
}

/**
 * Relative paths of entries readTree does not carry (symlinks, sockets, fifos).
 * They are invisible to tree equality but the wipe still takes them, so the
 * warning has to name them or the "every file it removes" promise is false.
 */
async function nonFileEntries(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => !e.isFile() && !e.isDirectory())
    .map((e) => relative(dir, join(e.parentPath, e.name)));
}

/** Buffer equality that treats "absent on one side" as unequal. */
function bufEquals(a: Buffer | undefined, b: Buffer | undefined): boolean {
  return a !== undefined && b !== undefined && a.equals(b);
}

/**
 * Read a directory tree into a rel-path -> content map, or null when it does not
 * exist. Reads as raw `Buffer`, not `utf8`: today's skills are markdown-only, but
 * this is a general recursive dir-copy, and decoding to a string here would
 * silently corrupt a future non-text asset (an image, a font) on write, or worse,
 * make two different corrupted binaries both decode to U+FFFD and compare equal.
 */
async function readTree(dir: string): Promise<Map<string, Buffer> | null> {
  if (!existsSync(dir)) return null;
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files = new Map<string, Buffer>();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath, entry.name);
    files.set(relative(dir, full), await readFile(full));
  }
  return files;
}

function treesEqual(a: Map<string, Buffer>, b: Map<string, Buffer> | null): boolean {
  if (b === null) return false;
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    const other = b.get(k);
    if (other === undefined || !v.equals(other)) return false;
  }
  return true;
}

/**
 * Ensure the AGENTS.md pointer line is present exactly once. Append-once is GLOBAL
 * across both locations Codex/harnesses read (~/.agents/AGENTS.md and Codex's own
 * ~/.codex/AGENTS.md): if either already carries the marker we stop, so a pointer
 * already in ~/.codex/AGENTS.md is never duplicated into a later-created
 * ~/.agents/AGENTS.md. When neither has it, target selection follows what Codex
 * actually reads: prefer an existing ~/.agents/AGENTS.md, else an existing
 * ~/.codex/AGENTS.md, else create the one whose home dir exists, else fall back to
 * ~/.agents/AGENTS.md alongside the shared skills.
 */
async function wireAgentsMd(plan: HarnessPlan, dryRun: boolean): Promise<AgentsMdResult> {
  const shared = join(plan.home, '.agents', 'AGENTS.md');
  const codex = join(plan.home, '.codex', 'AGENTS.md');
  const line = nudgeLine(plan.skillsDir);

  // If either file Codex reads already carries the marker, that file owns the line:
  // refresh it in place when an older install's text drifted, else leave it. This
  // keeps append-once global while still upgrading a stale line.
  for (const path of [shared, codex]) {
    if (existsSync(path) && (await readFile(path, 'utf8')).includes(SKILLS_MARKER)) {
      return upsertAgentsMd(path, line, dryRun);
    }
  }

  return upsertAgentsMd(chooseAgentsMdPath(plan.home), line, dryRun);
}

async function upsertAgentsMd(
  path: string,
  line: string,
  dryRun: boolean,
): Promise<AgentsMdResult> {
  const existing = existsSync(path) ? await readFile(path, 'utf8') : null;
  const { content, change } = upsertMarkerLine(existing, line);
  if (change === 'none') return { path, status: 'already-present' };
  if (!dryRun && content !== null) await writeFileAtomic(path, content);
  if (change === 'append') return { path, status: dryRun ? 'would-append' : 'appended' };
  return { path, status: dryRun ? 'would-update' : 'updated' };
}

function chooseAgentsMdPath(home: string): string {
  const shared = join(home, '.agents', 'AGENTS.md');
  const codex = join(home, '.codex', 'AGENTS.md');
  if (existsSync(shared)) return shared;
  if (existsSync(codex)) return codex;
  if (existsSync(join(home, '.codex'))) return codex;
  return shared;
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
