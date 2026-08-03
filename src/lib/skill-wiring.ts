import { existsSync, statSync } from 'node:fs';
import { constants, open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { hasCode } from './errno';
import { delimiter, join } from 'node:path';
import { SKILL_NAMES } from './skills-source';
import type { SkillName } from './skills-source';

/**
 * CLI_SKILL_NAMES are the thin adapter skills (roadmap C1), both required for the
 * CLI to be usable from a harness; HOSTED_SKILL_NAME is the zero-install
 * curriculum mirror (roadmap G4), typed as their complement so a rename in
 * skills-source.ts is a compile error here rather than a silently-always-false
 * `cliSkillsWired`.
 */
export const CLI_SKILL_NAMES = [
  'tenjin-search',
  'tenjin-publish',
] as const satisfies readonly SkillName[];
export type CliSkillName = (typeof CLI_SKILL_NAMES)[number];
export type HostedSkillName = Exclude<SkillName, CliSkillName>;
export const HOSTED_SKILL_NAME: HostedSkillName = 'tenjin';

export type NotInvocableReason = 'disabled' | 'unreadable';

export interface SkillWiring {
  name: string;
  present: boolean;
  /** Undefined when absent. False means on disk yet never surfaced to the model. */
  modelInvocable?: boolean;
  reason?: NotInvocableReason;
}

/**
 * One directory's verdict. `shadowed` and `partial` are actionable; `hosted-only`
 * is a working zero-install machine, not a defect; `empty` is not a Tenjin dir.
 */
export type DirState = 'empty' | 'hosted-only' | 'partial' | 'shadowed' | 'wired';

export interface HarnessWiring {
  dir: string;
  exists: boolean;
  skills: SkillWiring[];
  state: DirState;
}

export function skillsDirsFor(home: string): string[] {
  return [join(home, '.claude', 'skills'), join(home, '.agents', 'skills')];
}

/**
 * Every value `install --harness` accepts: the two detectable harnesses plus the
 * `shared` fallback. It lives beside the detection probes because `doctor` has to map
 * a PERSISTED choice back to a directory using the same rules `install` targeted it
 * with, and a second copy of that mapping is exactly the drift this module exists to
 * prevent.
 */
export const HARNESS_TARGETS = ['claude', 'codex', 'shared'] as const;
export type HarnessTarget = (typeof HARNESS_TARGETS)[number];

/** The skills directory a target writes to. `codex` and `shared` share ~/.agents/skills. */
export function harnessTargetDir(home: string, harness: HarnessTarget): string {
  return harness === 'claude' ? join(home, '.claude', 'skills') : join(home, '.agents', 'skills');
}

/**
 * The `--harness` value that targets `dir`. A Claude-only machine never targets
 * ~/.agents/skills by default, so a bare `tenjin install` cannot clear a problem
 * found there.
 */
export function harnessFlagFor(home: string, dir: string): string {
  return dir === join(home, '.claude', 'skills') ? 'claude' : 'shared';
}

/** The harnesses `install` probes for. `shared` is a fallback target, never detected. */
export type DetectableHarness = Exclude<HarnessTarget, 'shared'>;

/**
 * Why we think `harness` is on this machine: its home dir (~/.claude, ~/.codex) and
 * its binary on PATH. Single-sourced so `install` picks its targets and `doctor`
 * decides which directories MUST be wired from the same two probes — a directory no
 * harness here reads is a leftover, not a defect.
 */
export function harnessDetectedBy(
  home: string,
  harness: DetectableHarness,
  which: (bin: string) => boolean,
): string[] {
  const reasons: string[] = [];
  if (existsSync(join(home, `.${harness}`))) reasons.push('home-dir');
  if (which(harness)) reasons.push('binary');
  return reasons;
}

export interface HarnessPresence {
  claude: boolean;
  codex: boolean;
}

export function detectHarnesses(home: string, which: (bin: string) => boolean): HarnessPresence {
  return {
    claude: harnessDetectedBy(home, 'claude', which).length > 0,
    codex: harnessDetectedBy(home, 'codex', which).length > 0,
  };
}

/**
 * Does a harness ON THIS MACHINE read `dir`? Claude Code reads ~/.claude/skills and
 * Codex reads ~/.agents/skills, so a wired .agents does NOT make Claude Code wired:
 * the question has to be asked per directory. When neither harness is detected the
 * shared directory is still in play, because that is the fallback target `install`
 * writes to, so a half-written fallback install is still reported.
 */
export function harnessReads(home: string, dir: string, present: HarnessPresence): boolean {
  return harnessFlagFor(home, dir) === 'claude' ? present.claude : present.codex || !present.claude;
}

/**
 * Did a past `tenjin install --harness ...` name `dir` on purpose? Detection only sees
 * the harnesses this CLI probes for, and ~/.agents/skills is the cross-harness Agent
 * Skills convention, so "no Codex here" is not "nothing reads it". `requested` is the
 * user's own answer to that question and outranks the probes.
 */
export function harnessRequested(
  home: string,
  dir: string,
  requested: readonly HarnessTarget[],
): boolean {
  return requested.some((h) => harnessTargetDir(home, h) === dir);
}

/**
 * Is `dir` this machine's business at all: read by a detected harness, or explicitly
 * requested. The union is kept separate from `harnessReads` so the reported
 * `harnessPresent` stays a detection fact and does not quietly absorb a config value.
 */
export function harnessInPlay(
  home: string,
  dir: string,
  present: HarnessPresence,
  requested: readonly HarnessTarget[],
): boolean {
  return harnessReads(home, dir, present) || harnessRequested(home, dir, requested);
}

/**
 * Is `bin` a real executable file on PATH? Gates on statSync().isFile() so a
 * same-named DIRECTORY on PATH never false-positives as the binary, and probes the
 * PATHEXT extensions on win32 where the real binary is `claude.cmd`/`claude.exe`
 * rather than a bare `claude`.
 */
export function onPath(bin: string, env: NodeJS.ProcessEnv): boolean {
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

export async function readHarnessWiring(dir: string): Promise<HarnessWiring> {
  const exists = existsSync(dir);
  const skills: SkillWiring[] = [];
  for (const name of SKILL_NAMES) skills.push(await readSkillWiring(dir, name));
  return { dir, exists, skills, state: classify(skills) };
}

export async function readAllWiring(home: string): Promise<HarnessWiring[]> {
  const out: HarnessWiring[] = [];
  for (const dir of skillsDirsFor(home)) out.push(await readHarnessWiring(dir));
  return out;
}

function classify(skills: SkillWiring[]): DirState {
  const cli = CLI_SKILL_NAMES.map((n) => skills.find((s) => s.name === n)).filter(
    (s) => s?.present === true,
  );
  if (cli.length === 0) return skills.some((s) => s.present) ? 'hosted-only' : 'empty';
  if (cli.some((s) => s?.modelInvocable === false)) return 'shadowed';
  return cli.length === CLI_SKILL_NAMES.length ? 'wired' : 'partial';
}

/**
 * What reading a SKILL.md found. A skill path is operator-controlled, so it is not
 * necessarily a file at all.
 */
export type SkillFileRead =
  | { kind: 'ok'; bytes: Buffer }
  | { kind: 'absent' }
  | { kind: 'not-regular' }
  | { kind: 'unreadable'; err: unknown };

/**
 * Read a SKILL.md through ONE descriptor, and only when it is a regular file.
 *
 * `readFile` on a FIFO blocks until a writer appears, and on a character device it
 * streams without end; neither call fails, so no error handling reaches them. A
 * pipe at a wired SKILL.md path hung `tenjin doctor` and `tenjin install` past
 * SIGTERM. Opening non-blocking returns immediately whatever the node type is,
 * `fstat` on that descriptor says what it actually is, and only a regular file is
 * read. Checking the pathname and then reading the pathname would let the two
 * answer about different files.
 *
 * O_NONBLOCK does not exist on Windows, where it degrades to 0; FIFOs are not a
 * meaningful case there.
 */
export async function readSkillFile(path: string): Promise<SkillFileRead> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch (err) {
    if (hasCode(err, 'ENOENT')) return { kind: 'absent' };
    return { kind: 'unreadable', err };
  }
  try {
    if (!(await handle.stat()).isFile()) return { kind: 'not-regular' };
    return { kind: 'ok', bytes: await handle.readFile() };
  } catch (err) {
    return { kind: 'unreadable', err };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function readSkillWiring(dir: string, name: string): Promise<SkillWiring> {
  const read = await readSkillFile(join(dir, name, 'SKILL.md'));
  if (read.kind === 'absent') return { name, present: false };
  // A pipe or a device is there, but it is not a skill and must never be read as
  // one; `unreadable` is the state that already describes "present, unusable".
  if (read.kind !== 'ok')
    return { name, present: true, modelInvocable: false, reason: 'unreadable' };
  const text = read.bytes.toString('utf8');
  if (isModelInvocationDisabled(text)) {
    return { name, present: true, modelInvocable: false, reason: 'disabled' };
  }
  return { name, present: true, modelInvocable: true };
}

/** YAML 1.1 truthy spellings a harness frontmatter parser may accept. */
const YAML_TRUE = /^(?:true|yes|on)$/i;

/**
 * Deliberately not a general YAML parse: only the leading `---` block is read,
 * because this repo's own skills discuss the key in prose and a whole-file match
 * would call a working skill disabled.
 */
export function isModelInvocationDisabled(skillMd: string): boolean {
  const frontmatter = extractFrontmatter(skillMd);
  if (frontmatter === null) return false;
  return frontmatter.some((line) => {
    const m = /^disable-model-invocation:\s*(.+?)\s*$/.exec(line.trim());
    if (m === null) return false;
    // Strip an inline `# comment` and optional quotes before testing truthiness.
    const value = (m[1] ?? '').replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '');
    return YAML_TRUE.test(value);
  });
}

function extractFrontmatter(text: string): string[] | null {
  // Tolerate a UTF-8 BOM, CRLF, and leading blank lines before the opening fence.
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const open = lines.findIndex((l) => l.trim().length > 0);
  if (open === -1 || lines[open]?.trim() !== '---') return null;
  const end = lines.findIndex((l, i) => i > open && l.trim() === '---');
  if (end === -1) return null;
  return lines.slice(open + 1, end);
}

export function cliSkillsWired(wiring: HarnessWiring): boolean {
  return wiring.state === 'wired';
}

export function missingCliSkills(wiring: HarnessWiring): string[] {
  return CLI_SKILL_NAMES.filter(
    (name) => wiring.skills.find((x) => x.name === name)?.present !== true,
  );
}

export function shadowedCliSkills(wiring: HarnessWiring): string[] {
  return CLI_SKILL_NAMES.filter((name) => {
    const s = wiring.skills.find((x) => x.name === name);
    return s?.present === true && s.modelInvocable === false;
  });
}

export function anyTenjinSkill(wiring: HarnessWiring): boolean {
  return wiring.state !== 'empty';
}
