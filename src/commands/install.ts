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
 * The one line `install` keeps in an AGENTS.md so Codex (which reads AGENTS.md as
 * global guidance, not the raw ~/.agents/skills scan) knows the skills are there.
 * The HTML-comment marker is how re-runs stay idempotent: its presence means the
 * line is already written, so we never append a second copy.
 */
const AGENTS_MARKER = '<!-- tenjin-cli:skills -->';

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
  status: 'appended' | 'already-present' | 'would-append';
}

interface HarnessResult {
  harness: Harness;
  detected: boolean;
  detectedBy: string[];
  skillsDir: string;
  skills: SkillResult[];
  agentsMd?: AgentsMdResult;
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
}

/**
 * `tenjin install`: detect the installed harness(es), copy the packaged skills into
 * each one's skills directory, wire the AGENTS.md pointer, then settle the publish
 * consent mode and (interactively) the wallet, and finish with the doctor checks.
 *
 * OUTPUT is mode-dependent, the one documented exception to the "exactly one JSON
 * envelope" contract: on an interactive TTY without `--json` this is HUMAN-FIRST.
 * It prompts and prints a plain onboarding walkthrough to stdout, and emits NO
 * envelope (returns `suppressEnvelope`). With `--json` or off a TTY it is the
 * machine path: exactly today's envelope, no prompts, no wallet step. Idempotent:
 * a re-run reports up-to-date and never duplicates the AGENTS.md line. `--dry-run`
 * writes nothing.
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
  // Validate --publish-mode UP FRONT so a bad value fails before any wiring.
  const publishModeFlag =
    parsed.data.publishMode !== undefined ? parseModeFlag(parsed.data.publishMode) : undefined;
  const env = deps.env ?? process.env;
  const home = deps.homeDir ?? homedir();
  const which = deps.which ?? ((bin: string) => onPath(bin, env));

  // The human walkthrough runs only on a real interactive terminal without --json;
  // every machine path (piped, --json) takes the envelope branch below. --json
  // forces non-interactive even when a test injects isInteractive, so a machine
  // consumer never sits behind a prompt.
  const interactive =
    ctx.flags.json === true
      ? false
      : (deps.isInteractive ?? (ctx.io.isTTY && Boolean(process.stdin.isTTY)));

  const skillsSource =
    deps.skillsSourceDir ?? resolveSkillsSource(fileURLToPath(new URL('.', import.meta.url)));
  await assertSkillsSource(skillsSource);

  const plans = resolvePlans(parsed.data.harness, home, which);
  const harnesses: HarnessResult[] = [];
  for (const plan of plans) {
    harnesses.push(await applyPlan(plan, skillsSource, dryRun));
  }
  const collect = deps.collectChecks ?? ((c) => collectDoctorChecks(c, deps.doctorDeps ?? {}));

  if (interactive) {
    return runWalkthrough({ ctx, deps, dryRun, noWallet, harnesses, publishModeFlag, collect });
  }

  // Machine path (--json or non-TTY): today's envelope, no prompts, no wallet step.
  const doctor = await collect(ctx);
  const publishMode = await selectPublishMode(publishModeFlag, ctx, deps, dryRun, false);
  return {
    data: {
      dryRun,
      skillsSource,
      harnesses,
      doctor: { status: doctor.failure !== undefined ? 'fail' : 'pass', checks: doctor.checks },
      publishMode,
    },
  };
}

const EXAMPLE_QUESTION = "what actually changed in <library> v3's public API";

interface WalkthroughArgs {
  ctx: CommandContext;
  deps: InstallDeps;
  dryRun: boolean;
  noWallet: boolean;
  harnesses: HarnessResult[];
  publishModeFlag: PublishMode | undefined;
  collect: (ctx: CommandContext) => Promise<DoctorChecks>;
}

/**
 * The interactive onboarding: skills, the consent-mode question, wallet setup, a
 * one-line doctor verdict, and a next step. Rendered to stdout as a compact
 * walkthrough (no JSON envelope); prompts read stdin and write their labels to
 * stderr. Returns `suppressEnvelope` so the dispatcher emits nothing.
 */
async function runWalkthrough(a: WalkthroughArgs): Promise<CommandResult> {
  const { ctx, deps, dryRun, noWallet, harnesses, publishModeFlag, collect } = a;
  const io = ctx.io;
  const out = (line = ''): void => void io.stdout.write(`${line}\n`);

  // a. Skills.
  if (dryRun) out(paint(io, 'yellow', 'Dry run: nothing was written.'));
  for (const line of skillsWalkthrough(io, harnesses, dryRun)) out(line);
  out();

  // b. Publish consent mode.
  const publishMode = await selectPublishMode(publishModeFlag, ctx, deps, dryRun, true);
  out(
    `${paint(io, 'bold', `publish mode: ${publishMode.value}`)}  ${paint(io, 'dim', modeBlurb(publishMode.value))}`,
  );
  out();

  // c. Wallet.
  for (const line of await walletWalkthrough(ctx, deps, dryRun, noWallet, io)) out(line);
  out();

  // d. Doctor: only what needs action, else one green line.
  for (const line of doctorSummary(io, await collect(ctx))) out(line);
  out();

  // e. Next step.
  out(`Done. Try: tenjin lookup "${EXAMPLE_QUESTION}"`);

  return { data: { dryRun, harnesses, publishMode }, suppressEnvelope: true };
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
    const pointer = h.agentsMd !== undefined ? ' + AGENTS.md pointer' : '';
    lines.push(
      `${paint(io, 'green', '✓')} ${harnessLabel(h.harness)}: ${n} skills ${verb}${pointer}`,
    );
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
  dryRun: boolean,
  noWallet: boolean,
  io: Io,
): Promise<string[]> {
  const exists = await (deps.walletExists ?? walletFileExists)(ctx.dataDir);
  if (exists) {
    const address = await (deps.walletAddress ?? existingWalletAddress)(ctx);
    return [`${paint(io, 'bold', 'Wallet:')} ${address} (existing)`];
  }
  const later = `${paint(io, 'bold', 'Wallet:')} none. Create one later with: tenjin wallet create`;
  if (dryRun || noWallet) return [later];

  const confirm = deps.confirmWallet ?? defaultConfirmWallet;
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
function defaultConfirmWallet(label: string): Promise<boolean> {
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
  }
  return result;
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
  const line = `${AGENTS_MARKER} Tenjin agent skills are installed at ${plan.skillsDir} (tenjin-search, tenjin-publish, tenjin). Read the relevant SKILL.md before using the tenjin CLI.`;

  for (const path of [shared, codex]) {
    if (existsSync(path) && (await readFile(path, 'utf8')).includes(AGENTS_MARKER)) {
      return { path, status: 'already-present' };
    }
  }

  const path = chooseAgentsMdPath(plan.home);
  if (dryRun) return { path, status: 'would-append' };

  const existing = existsSync(path) ? await readFile(path, 'utf8') : null;
  const prefix = existing === null || existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
  await writeFileAtomic(path, `${existing ?? ''}${prefix}${line}\n`);
  return { path, status: 'appended' };
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
  if (io.stderr instanceof Stream) return styleText(format, text, { stream: io.stderr });
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
