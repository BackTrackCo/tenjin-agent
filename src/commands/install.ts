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
import { loadRawConfig, PublishModeSchema } from '../lib/config';
import type { PublishMode } from '../lib/config';
import { persistPublishMode } from './config';
import { collectDoctorChecks, renderDoctorHuman } from './doctor';
import type { DoctorDeps, DoctorChecks } from './doctor';
import type { Io } from '../lib/output';
import type { CommandContext, CommandResult } from '../context';

const HARNESSES = ['claude', 'codex', 'shared'] as const;
type Harness = (typeof HARNESSES)[number];

const InstallInputSchema = z.object({
  harness: z.array(z.string()).optional(),
  dryRun: z.boolean().optional(),
  publishMode: z.string().optional(),
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
  /** Whether an interactive prompt is possible; defaults to the TTY facts. */
  isInteractive?: boolean;
}

/**
 * `tenjin install`: detect the installed harness(es), copy the packaged skills into
 * each one's skills directory, wire the AGENTS.md pointer + print the Codex sandbox
 * rule where relevant, THEN run the doctor checks as the final step (D39: doctor is
 * diagnostics run last, never a required first hop; a doctor problem is surfaced but
 * never fails the wiring that already succeeded). Idempotent: a re-run reports
 * up-to-date and never duplicates the AGENTS.md line. `--dry-run` writes nothing.
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
  // Validate --publish-mode UP FRONT so a bad value fails before any wiring, even
  // though the mode is only settled (and persisted) after the doctor phase below.
  const publishModeFlag =
    parsed.data.publishMode !== undefined ? parseModeFlag(parsed.data.publishMode) : undefined;
  const env = deps.env ?? process.env;
  const home = deps.homeDir ?? homedir();
  const which = deps.which ?? ((bin: string) => onPath(bin, env));

  const skillsSource =
    deps.skillsSourceDir ?? resolveSkillsSource(fileURLToPath(new URL('.', import.meta.url)));
  await assertSkillsSource(skillsSource);

  const plans = resolvePlans(parsed.data.harness, home, which);

  const harnesses: HarnessResult[] = [];
  for (const plan of plans) {
    harnesses.push(await applyPlan(plan, skillsSource, dryRun));
  }

  const collect = deps.collectChecks ?? ((c) => collectDoctorChecks(c, deps.doctorDeps ?? {}));
  const doctor = await collect(ctx);
  const doctorStatus = doctor.failure !== undefined ? 'fail' : 'pass';

  // After wiring + doctor, settle the publish consent mode: a flag sets it, an
  // already-configured mode is left alone, and an interactive setup asks once
  // (plain enter keeps the default WITHOUT writing, so `config get` stays truthful).
  const publishMode = await selectPublishMode(publishModeFlag, ctx, deps, dryRun);

  const data = {
    dryRun,
    skillsSource,
    harnesses,
    doctor: { status: doctorStatus, checks: doctor.checks },
    publishMode,
  };
  const humanLines = renderHuman(ctx.io, harnesses, doctor, dryRun);
  humanLines.push(publishModeLine(ctx.io, publishMode, dryRun));
  return { data, humanLines };
}

// --- Publish-mode selection (D38 setup) ------------------------------------------

const PUBLISH_MODE_PROMPT =
  'Publish consent mode? review = always ask / auto = ask only on findings / full-auto = only hard blocks stop it [auto]: ';

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

  const interactive = deps.isInteractive ?? (ctx.io.isTTY && Boolean(process.stdin.isTTY));
  if (dryRun || !interactive) return { value: 'auto', source: 'default-skipped' };

  const prompt = deps.promptMode ?? defaultPromptMode;
  // Ask, allow ONE reprompt on an unrecognized answer, then fall back to auto.
  for (let attempt = 0; attempt < 2; attempt++) {
    const answer = (await prompt(PUBLISH_MODE_PROMPT)).trim();
    if (answer.length === 0) return { value: 'auto', source: 'default-skipped' }; // enter: no write
    const parsed = PublishModeSchema.safeParse(answer);
    if (parsed.success) {
      await persistPublishMode(ctx.dataDir, parsed.data);
      return { value: parsed.data, source: 'prompt' };
    }
  }
  ctx.io.stderr.write(
    'Unrecognized mode; keeping the default (auto). Change it with `tenjin config set publish.mode`.\n',
  );
  return { value: 'auto', source: 'default-skipped' };
}

function parseModeFlag(value: string): PublishMode {
  const parsed = PublishModeSchema.safeParse(value);
  if (!parsed.success) {
    throw new CliError('USAGE', `Invalid --publish-mode ${JSON.stringify(value)}`, {
      fix: 'Use "review", "auto", or "full-auto".',
    });
  }
  return parsed.data;
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

function publishModeLine(io: Io, selection: PublishModeSelection, dryRun: boolean): string {
  const detail: Record<PublishModeSource, string> = {
    flag: dryRun ? 'would set from --publish-mode' : 'set from --publish-mode',
    existing: 'already configured',
    prompt: 'saved',
    'default-skipped': 'default; run interactively or pass --publish-mode to change',
  };
  return paint(io, 'bold', `publish mode: ${selection.value} (${detail[selection.source]})`);
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
      'Installed at the user level (~/.claude/skills). The Claude Code plugin marketplace (roadmap C3) will supersede this path for Claude users.',
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

function renderHuman(
  io: Io,
  harnesses: HarnessResult[],
  doctor: DoctorChecks,
  dryRun: boolean,
): string[] {
  const lines: string[] = [];
  if (dryRun) lines.push(paint(io, 'yellow', 'dry run: no files written'));
  for (const h of harnesses) {
    const how = h.detectedBy.length > 0 ? ` (${h.detectedBy.join(', ')})` : '';
    lines.push(paint(io, 'bold', `${h.harness}${how} -> ${h.skillsDir}`));
    for (const s of h.skills) {
      lines.push(`  ${skillIcon(io, s.status)} ${s.name.padEnd(14)} ${paint(io, 'dim', s.status)}`);
    }
    if (h.agentsMd !== undefined) {
      lines.push(`  ${paint(io, 'dim', `AGENTS.md ${h.agentsMd.status}: ${h.agentsMd.path}`)}`);
    }
    for (const w of h.warnings) lines.push(`  ${paint(io, 'yellow', `! ${w}`)}`);
    for (const n of h.notes) lines.push(`  ${paint(io, 'dim', n)}`);
    if (h.codexNetworkRule !== undefined) {
      lines.push(
        paint(
          io,
          'dim',
          "  Codex's default workspace-write sandbox blocks network, which breaks paid x402 calls.",
        ),
      );
      lines.push(paint(io, 'dim', '  Add this to ~/.codex/config.toml:'));
      for (const rl of h.codexNetworkRule.split('\n')) lines.push(`    ${rl}`);
    }
  }
  lines.push('');
  lines.push(paint(io, 'bold', 'doctor (final checks):'));
  lines.push(...renderDoctorHuman(io, doctor.checks));
  if (doctor.failure !== undefined) {
    lines.push(paint(io, 'yellow', 'doctor reported a problem above; the skills are still wired.'));
  }
  return lines;
}

function skillIcon(io: Io, status: SkillResult['status']): string {
  if (status === 'up-to-date') return paint(io, 'green', '=');
  if (status === 'updated' || status === 'would-update') return paint(io, 'yellow', '~');
  return paint(io, 'green', '+');
}

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
