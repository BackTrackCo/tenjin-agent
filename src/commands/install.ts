import { existsSync, statSync } from 'node:fs';
import { readFile, readdir, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { delimiter, join, relative } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import { styleText } from 'node:util';
import { Stream } from 'node:stream';
import { CliError } from '../lib/errors';
import { writeFileAtomic } from '../lib/atomic-json';
import { resolveSkillsSource, SKILL_NAMES } from '../lib/skills-source';
import {
  CONFIG_DEFAULTS,
  loadRawConfig,
  PublishModeSchema,
  parsePublishModeFlag,
} from '../lib/config';
import type { PublishMode } from '../lib/config';
import { persistPublishMode } from './config';
import { runWalletCreate } from './wallet';
import { collectDoctorChecks } from './doctor';
import type { DoctorDeps, DoctorChecks } from './doctor';
import { describeWallet, resolveWalletProvider } from '../lib/wallet';
import { walletFileExists } from '../lib/wallet/store';
import type { Io } from '../lib/output';
import type { CommandContext, CommandResult } from '../context';

const HARNESSES = ['claude', 'codex', 'shared'] as const;
type Harness = (typeof HARNESSES)[number];

const InstallInputSchema = z.object({
  harness: z.array(z.string()).optional(),
  dryRun: z.boolean().optional(),
  publishMode: z.string().optional(),
  noWallet: z.boolean().optional(),
  /** Tri-state opt-in for the ~/.claude/CLAUDE.md nudge: true (--claude-md), false
   * (--no-claude-md), or undefined (ask interactively, else skip). */
  claudeMd: z.boolean().optional(),
});
export type InstallInput = z.infer<typeof InstallInputSchema>;

/** A visible text-prompt seam (like passphrase's PromptFn); injected in tests. */
export type PromptFn = (label: string) => Promise<string>;

type PublishModeSource = 'flag' | 'existing' | 'prompt' | 'default-skipped';
interface PublishModeSelection {
  value: PublishMode;
  source: PublishModeSource;
}

/**
 * The one line `install` keeps in an AGENTS.md (and, opt-in, in a CLAUDE.md) so the
 * harness reads it as global guidance, not the raw ~/.agents/skills scan. It is an
 * instinct nudge: run a free `tenjin lookup` before regenerating public research,
 * then a pointer to where the skills live. The HTML-comment marker keeps re-runs
 * idempotent: a matching line is left untouched, a drifted line (an older install's
 * copy) is rewritten in place, and an absent line is appended, so we never duplicate.
 */
const SKILLS_MARKER = '<!-- tenjin-cli:skills -->';

/**
 * The instinct nudge line, pointed at `skillsDir`. One line, no em dashes: the
 * marker, the lookup-before-regenerating nudge, then where the skills live.
 */
function nudgeLine(skillsDir: string): string {
  return `${SKILLS_MARKER} Tenjin: before regenerating public research (version-specific compatibility, integration gotchas, benchmarks, dated probes), run a free anonymous 'tenjin lookup "<question>"' first. Skills (tenjin-search, tenjin-publish, tenjin) are installed at ${skillsDir}; read the relevant SKILL.md before using the CLI.`;
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
  /** Interactive text-prompt seam for the publish-mode question; defaults to a stdin reader. */
  promptMode?: PromptFn;
  /** Whether the human walkthrough runs (TTY, no --json, stdin is a TTY). Injected in tests. */
  isInteractive?: boolean;
  /** Does a wallet already exist? Defaults to walletFileExists(dataDir). */
  walletExists?: (dataDir: string) => Promise<boolean>;
  /** An existing wallet's address, for the "(existing)" line. Defaults to the local provider. */
  walletAddress?: (ctx: CommandContext) => Promise<string>;
  /** Create a wallet and return its address. Defaults to runWalletCreate. */
  createWallet?: (ctx: CommandContext) => Promise<string>;
  /** Yes/no confirm for "Create a wallet now?"; defaults to a TTY y/n reader (default yes). */
  confirmWallet?: (label: string) => Promise<boolean>;
  /** Yes/no confirm for the CLAUDE.md nudge; defaults to a TTY y/n reader (default yes). */
  confirmClaudeMd?: (label: string) => Promise<boolean>;
}

/**
 * `tenjin install`: detect the installed harness(es), copy the packaged skills into
 * each one's skills directory, wire the AGENTS.md pointer, then settle the publish
 * consent mode and (interactively) the wallet, and finish with the doctor checks.
 *
 * Like every command it is human-first (the global output contract): at a TTY
 * without `--json` it prompts and returns a plain onboarding walkthrough as
 * humanLines, which the dispatcher prints to stdout with no envelope. With
 * `--json` or piped stdout it returns today's envelope, no prompts, no wallet
 * step. Idempotent: a re-run reports up-to-date and never duplicates the AGENTS.md
 * line. `--dry-run` writes nothing.
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
  // The CLAUDE.md nudge is opt-in and only relevant when a Claude target exists.
  // Resolve it once (may prompt) so the loop just writes the settled decision.
  const claudeMdWrite = plans.some((p) => p.harness === 'claude')
    ? await decideClaudeMd(claudeMdFlag, canPrompt, dryRun, deps)
    : false;
  const harnesses: HarnessResult[] = [];
  for (const plan of plans) {
    harnesses.push(await applyPlan(plan, skillsSource, dryRun, claudeMdWrite));
  }
  const collect = deps.collectChecks ?? ((c) => collectDoctorChecks(c, deps.doctorDeps ?? {}));
  const doctor = await collect(ctx);
  const publishMode = await selectPublishMode(publishModeFlag, ctx, deps, dryRun, canPrompt);

  const data = {
    dryRun,
    skillsSource,
    harnesses,
    doctor: { status: doctor.failure !== undefined ? 'fail' : 'pass', checks: doctor.checks },
    publishMode,
  };

  // Machine path (--json or piped stdout): today's envelope, no wallet step.
  if (!humanOutput) return { data };

  // Human path: the onboarding walkthrough as humanLines (the global emitSuccess
  // prints them to stdout at a TTY and never an envelope). A wallet prompt happens
  // only when we can actually read stdin.
  const humanLines = await buildWalkthrough(ctx, deps, {
    dryRun,
    noWallet,
    canPrompt,
    harnesses,
    publishMode,
    doctor,
  });
  return { data, humanLines };
}

const EXAMPLE_QUESTION = "what actually changed in <library> v3's public API";

interface WalkthroughState {
  dryRun: boolean;
  noWallet: boolean;
  canPrompt: boolean;
  harnesses: HarnessResult[];
  publishMode: PublishModeSelection;
  doctor: DoctorChecks;
}

/**
 * Build the onboarding walkthrough lines: skills, the resolved consent mode,
 * wallet setup (creating one in-flow only when we can prompt), a one-line doctor
 * verdict, and a next step. Any prompt reads stdin and writes its label to stderr;
 * the returned lines are the human stdout surface.
 */
async function buildWalkthrough(
  ctx: CommandContext,
  deps: InstallDeps,
  s: WalkthroughState,
): Promise<string[]> {
  const io = ctx.io;
  const lines: string[] = [];
  if (s.dryRun) lines.push(paint(io, 'yellow', 'Dry run: nothing was written.'));
  lines.push(...skillsWalkthrough(io, s.harnesses, s.dryRun), '');
  lines.push(
    `${paint(io, 'bold', `publish mode: ${s.publishMode.value}`)}  ${paint(io, 'dim', modeBlurb(s.publishMode.value))}`,
    '',
  );
  lines.push(...(await walletWalkthrough(ctx, deps, s.dryRun || !s.canPrompt, s.noWallet, io)), '');
  lines.push(...doctorSummary(io, s.doctor), '');
  lines.push(`Done. Try: tenjin lookup "${EXAMPLE_QUESTION}"`);
  return lines;
}

function harnessLabel(h: Harness): string {
  return h === 'claude' ? 'Claude Code' : h === 'codex' ? 'Codex' : 'Agent Skills';
}

function skillsWalkthrough(io: Io, harnesses: HarnessResult[], dryRun: boolean): string[] {
  const lines: string[] = [];
  for (const h of harnesses) {
    const n = h.skills.length;
    const changed = h.skills.some((s) => s.status !== 'up-to-date');
    const verb = dryRun ? 'would install' : changed ? 'installed' : 'up to date';
    const wired: string[] = [];
    if (h.agentsMd !== undefined) wired.push('AGENTS.md nudge');
    if (h.claudeMd !== undefined && h.claudeMd.status !== 'skipped') wired.push('CLAUDE.md nudge');
    const suffix = wired.length > 0 ? ` + ${wired.join(' + ')}` : '';
    lines.push(
      `${paint(io, 'green', '✓')} ${harnessLabel(h.harness)}: ${n} skills ${verb}${suffix}`,
    );
    if (h.claudeMd?.status === 'skipped') {
      lines.push(
        paint(
          io,
          'dim',
          '  Add a Tenjin lookup nudge to ~/.claude/CLAUDE.md later: tenjin install --harness claude --claude-md',
        ),
      );
    }
    if (h.codexNetworkRule !== undefined) {
      lines.push(
        paint(io, 'dim', '  Codex blocks network by default; add to ~/.codex/config.toml:'),
      );
      for (const rl of h.codexNetworkRule.split('\n')) lines.push(paint(io, 'dim', `    ${rl}`));
    }
    for (const w of h.warnings) lines.push(paint(io, 'yellow', `  ! ${w}`));
  }
  return lines;
}

function modeBlurb(v: PublishMode): string {
  return v === 'review'
    ? 'asks before every publish'
    : v === 'auto'
      ? 'publishes clean scans automatically'
      : 'only detected secrets stop a publish';
}

async function walletWalkthrough(
  ctx: CommandContext,
  deps: InstallDeps,
  skipCreate: boolean,
  noWallet: boolean,
  io: Io,
): Promise<string[]> {
  const exists = await (deps.walletExists ?? walletFileExists)(ctx.dataDir);
  if (exists) {
    const address = await (deps.walletAddress ?? existingWalletAddress)(ctx);
    return [`${paint(io, 'bold', 'Wallet:')} ${address} (existing)`];
  }
  const later = `${paint(io, 'bold', 'Wallet:')} none. Create one later with: tenjin wallet create`;
  if (skipCreate || noWallet) return [later];

  const confirm = deps.confirmWallet ?? defaultConfirmYesNo;
  if (!(await confirm('Create a wallet now? [Y/n] '))) return [later];

  const address = await (deps.createWallet ?? defaultCreateWallet)(ctx);
  return [
    paint(io, 'bold', 'Wallet created:'),
    `  ${address}`,
    '  Fund it: send a few dollars of USDC on Base to that address (this is a pocket-money wallet; keep it small).',
    '  Check with: tenjin wallet balance',
  ];
}

async function existingWalletAddress(ctx: CommandContext): Promise<string> {
  return (await describeWallet(resolveWalletProvider(ctx))).address;
}

async function defaultCreateWallet(ctx: CommandContext): Promise<string> {
  const result = await runWalletCreate(ctx);
  return (result.data as { address: string }).address;
}

/** A visible y/n reader defaulting to yes (empty input); label + echo on stderr. */
function defaultConfirmYesNo(label: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    let settled = false;
    const settle = (value: boolean): void => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(value);
    };
    rl.once('close', () => settle(false));
    rl.question(label, (answer) => {
      const a = answer.trim().toLowerCase();
      settle(a === '' || a === 'y' || a === 'yes');
    });
  });
}

function doctorSummary(io: Io, doctor: DoctorChecks): string[] {
  const problems = doctor.checks.filter((c) => c.status !== 'ok');
  if (problems.length === 0) return [`${paint(io, 'green', '✓')} Everything checks out`];
  const lines = [paint(io, 'yellow', 'Some checks need attention:')];
  for (const c of problems) {
    const icon = c.status === 'fail' ? paint(io, 'red', '✗') : paint(io, 'yellow', '!');
    lines.push(`  ${icon} ${c.name}: ${c.detail}`);
    if (c.fix !== undefined) lines.push(paint(io, 'dim', `    fix: ${c.fix}`));
  }
  return lines;
}

// --- Publish-mode selection (D38 setup) ------------------------------------------

/** The default consent mode (also what a plain enter keeps, without writing). */
const DEFAULT_MODE: PublishMode = CONFIG_DEFAULTS.publish.mode;

const PUBLISH_MODE_PROMPT = [
  'Publish consent mode?',
  '  review     - asks a yes/no for every publish',
  '  auto       - publishes automatically when the secret-scan is clean (including answers your agent derives)',
  '  full-auto  - publishes even past warnings; only detected secrets stop it',
  `[${DEFAULT_MODE}]: `,
].join('\n');

/**
 * Resolve (and, for an explicit choice, persist) the publish consent mode at
 * install time. Precedence: `--publish-mode` flag > an already-configured global
 * mode > an interactive prompt > the untouched default. Only an explicit choice
 * writes: a plain enter, a non-interactive run, `--dry-run`, or an unrecognized
 * answer all leave `publish.mode` unset so its provenance stays `default`.
 */
async function selectPublishMode(
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

  const prompt = deps.promptMode ?? defaultPromptMode;
  // Ask, allow ONE reprompt on an unrecognized answer, then fall back to the default.
  for (let attempt = 0; attempt < 2; attempt++) {
    const answer = (await prompt(PUBLISH_MODE_PROMPT)).trim();
    if (answer.length === 0) return { value: DEFAULT_MODE, source: 'default-skipped' }; // enter: no write
    const parsed = PublishModeSchema.safeParse(answer);
    if (parsed.success) {
      await persistPublishMode(ctx.dataDir, parsed.data);
      return { value: parsed.data, source: 'prompt' };
    }
  }
  ctx.io.stderr.write(
    `Unrecognized mode; keeping the default (${DEFAULT_MODE}). Change it with \`tenjin config set publish.mode\`.\n`,
  );
  return { value: DEFAULT_MODE, source: 'default-skipped' };
}

function parseModeFlag(value: string): PublishMode {
  return parsePublishModeFlag(value, '--publish-mode');
}

/** A visible line-reader (prompt on stderr so stdout stays a single JSON object). */
function defaultPromptMode(label: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    let settled = false;
    const settle = (value: string): void => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(value);
    };
    rl.once('close', () => settle('')); // ctrl-D mid-prompt reads as the default
    rl.question(label, (answer) => settle(answer));
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
  const claudeDir = join(home, '.claude', 'skills');
  const sharedDir = join(home, '.agents', 'skills');

  if (override !== undefined && override.length > 0) {
    const plans = override.map((v) =>
      planFor(validateHarness(v), ['override'], true, home, claudeDir, sharedDir),
    );
    return dedupeBySkillsDir(plans);
  }

  const plans: HarnessPlan[] = [];
  const claudeBy = detectReasons(existsSync(join(home, '.claude')), which('claude'));
  const codexBy = detectReasons(existsSync(join(home, '.codex')), which('codex'));
  if (claudeBy.length > 0)
    plans.push(planFor('claude', claudeBy, true, home, claudeDir, sharedDir));
  if (codexBy.length > 0) plans.push(planFor('codex', codexBy, true, home, claudeDir, sharedDir));
  if (plans.length === 0) {
    // Nothing detected: the shared Agent Skills location is the fallback target, so
    // a harness installed later still finds the skills.
    plans.push(planFor('shared', ['fallback'], false, home, claudeDir, sharedDir));
  }
  return dedupeBySkillsDir(plans);
}

function detectReasons(homeDirPresent: boolean, onPathPresent: boolean): string[] {
  const reasons: string[] = [];
  if (homeDirPresent) reasons.push('home-dir');
  if (onPathPresent) reasons.push('binary');
  return reasons;
}

function planFor(
  harness: Harness,
  detectedBy: string[],
  detected: boolean,
  home: string,
  claudeDir: string,
  sharedDir: string,
): HarnessPlan {
  const skillsDir = harness === 'claude' ? claudeDir : sharedDir;
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

async function applyPlan(
  plan: HarnessPlan,
  skillsSource: string,
  dryRun: boolean,
  claudeMdWrite: boolean,
): Promise<HarnessResult> {
  const skills: SkillResult[] = [];
  const warnings: string[] = [];
  for (const name of SKILL_NAMES) {
    const { status, warning } = await installSkill(
      join(skillsSource, name),
      join(plan.skillsDir, name),
      dryRun,
    );
    skills.push({ name, status });
    if (warning !== undefined) warnings.push(warning);
  }

  const result: HarnessResult = {
    harness: plan.harness,
    detected: plan.detected,
    detectedBy: plan.detectedBy,
    skillsDir: plan.skillsDir,
    skills,
    notes: notesFor(plan),
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
 * Decide whether to write the ~/.claude/CLAUDE.md nudge. `--claude-md` forces it on
 * and `--no-claude-md` off; otherwise ask at an interactive TTY (default yes), and
 * on a non-interactive run (or --dry-run without the flag) skip it.
 */
async function decideClaudeMd(
  flag: boolean | undefined,
  canPrompt: boolean,
  dryRun: boolean,
  deps: InstallDeps,
): Promise<boolean> {
  if (flag !== undefined) return flag;
  if (dryRun || !canPrompt) return false;
  const confirm = deps.confirmClaudeMd ?? defaultConfirmYesNo;
  return confirm('Add a one-line Tenjin lookup nudge to ~/.claude/CLAUDE.md? [Y/n] ');
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

function notesFor(plan: HarnessPlan): string[] {
  if (plan.harness === 'claude') {
    return [
      'Installed at the user level (~/.claude/skills). A Claude Code plugin will later make this automatic.',
    ];
  }
  return [
    'Copied into the shared Agent Skills location (~/.agents/skills). Codex and any Agent-Skills-compatible harness read it there.',
  ];
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
): Promise<{ status: SkillResult['status']; warning?: string }> {
  const src = await readTree(srcDir);
  const dest = await readTree(destDir);
  if (src === null) {
    // assertSkillsSource already guards SKILL.md; this is defensive for an empty dir.
    throw new CliError('INTERNAL', `Packaged skill source ${srcDir} is empty`);
  }

  const change = dest === null ? 'create' : treesEqual(src, dest) ? 'none' : 'update';

  if (!dryRun && change !== 'none') {
    // Overwrite wholesale so the packaged copy is exactly what lands, with no stray
    // local files left behind. rm is a no-op when the dir is absent.
    await rm(destDir, { recursive: true, force: true });
    for (const [rel, content] of src) {
      await writeFileAtomic(join(destDir, rel), content);
    }
  }

  if (change === 'create') return { status: dryRun ? 'would-install' : 'installed' };
  if (change === 'none') return { status: 'up-to-date' };
  return {
    status: dryRun ? 'would-update' : 'updated',
    warning: `${destDir}: local skill copy differed and was ${dryRun ? 'would be ' : ''}overwritten (the packaged copy is canonical).`,
  };
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

// --- PATH probe ------------------------------------------------------------------

/**
 * Is `bin` a real executable file on PATH? Gates on statSync().isFile() so a
 * same-named DIRECTORY on PATH never false-positives as the binary, and probes the
 * PATHEXT extensions on win32 where the real binary is `claude.cmd`/`claude.exe`
 * rather than a bare `claude`.
 */
function onPath(bin: string, env: NodeJS.ProcessEnv): boolean {
  const raw = env.PATH ?? '';
  const exts =
    process.platform === 'win32'
      ? ['', ...(env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter((e) => e.length > 0)]
      : [''];
  for (const part of raw.split(delimiter)) {
    if (part.length === 0) continue;
    for (const ext of exts) {
      if (isFile(join(part, bin + ext))) return true;
    }
  }
  return false;
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

// --- Human rendering -------------------------------------------------------------

function paint(io: Io, format: Parameters<typeof styleText>[0], text: string): string {
  if (io.stdout instanceof Stream) return styleText(format, text, { stream: io.stdout });
  return styleText(format, text);
}

// --- Skills source guard ---------------------------------------------------------

async function assertSkillsSource(dir: string): Promise<void> {
  for (const name of SKILL_NAMES) {
    if (!existsSync(join(dir, name, 'SKILL.md'))) {
      throw new CliError('INTERNAL', `Packaged skill "${name}" is missing under ${dir}`, {
        fix: 'Reinstall tenjin-cli; the published package must ship every skill under skills/.',
      });
    }
  }
}
