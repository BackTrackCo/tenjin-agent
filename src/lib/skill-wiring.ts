import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SKILL_NAMES } from './skills-source';

/**
 * The two thin CLI adapter skills (roadmap C1). BOTH are wired by every
 * `tenjin install`, unconditionally: they are what makes the CLI usable from a
 * harness, and a machine with only `tenjin-search` can search but never publish
 * (#35).
 */
export const CLI_SKILL_NAMES = ['tenjin-search', 'tenjin-publish'] as const;

/**
 * The zero-install curriculum (the hosted skill mirrored from tenjin.blog/skills.md,
 * roadmap G4). PERMANENT and coexisting: install refreshes it and never removes it,
 * because it is the no-CLI path. The CLI skills supersede it in precedence whenever
 * the CLI is present, which its own description already says.
 */
export const HOSTED_SKILL_NAME = 'tenjin';

/** Wiring state of one skill inside one skills directory. */
export interface SkillWiring {
  name: string;
  present: boolean;
  /**
   * Whether a harness will surface this skill to the model. `undefined` when the
   * skill is absent. `false` when its frontmatter carries
   * `disable-model-invocation: true`, which installs the file but leaves it
   * invisible to the model: on disk yet not wired.
   */
  modelInvocable?: boolean;
}

/** Wiring state of one skills directory (a harness target). */
export interface HarnessWiring {
  dir: string;
  /** Does the directory itself exist? A missing dir means nothing is wired there. */
  exists: boolean;
  skills: SkillWiring[];
}

/**
 * The skills directories a harness reads, in install order: Claude Code's own
 * `~/.claude/skills` and the harness-shared Agent Skills location
 * `~/.agents/skills` that Codex and Agent-Skills-compatible harnesses read.
 * Kept in one place so `install` writes and `doctor` inspects the same set.
 */
export function skillsDirsFor(home: string): string[] {
  return [join(home, '.claude', 'skills'), join(home, '.agents', 'skills')];
}

/** Read the wiring state of every packaged skill inside one skills directory. */
export async function readHarnessWiring(dir: string): Promise<HarnessWiring> {
  const exists = existsSync(dir);
  const skills: SkillWiring[] = [];
  for (const name of SKILL_NAMES) {
    skills.push(await readSkillWiring(dir, name));
  }
  return { dir, exists, skills };
}

/** Read the wiring state of every skills directory under `home`. */
export async function readAllWiring(home: string): Promise<HarnessWiring[]> {
  const out: HarnessWiring[] = [];
  for (const dir of skillsDirsFor(home)) out.push(await readHarnessWiring(dir));
  return out;
}

async function readSkillWiring(dir: string, name: string): Promise<SkillWiring> {
  const path = join(dir, name, 'SKILL.md');
  if (!existsSync(path)) return { name, present: false };
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    // An unreadable file is present-but-unusable; report it as not invocable
    // rather than throwing, because this feeds a diagnostic, never a mutation.
    return { name, present: true, modelInvocable: false };
  }
  return { name, present: true, modelInvocable: !isModelInvocationDisabled(text) };
}

/**
 * Does this SKILL.md's frontmatter disable model invocation? Deliberately NOT a
 * general YAML parse: we only need the one boolean the harnesses key on, read
 * from the leading `---` block so a `disable-model-invocation` mentioned in the
 * body prose (this repo's own skills discuss it) can never be mistaken for the
 * frontmatter setting.
 */
export function isModelInvocationDisabled(skillMd: string): boolean {
  const frontmatter = extractFrontmatter(skillMd);
  if (frontmatter === null) return false;
  return frontmatter.some((line) => /^disable-model-invocation:\s*true\s*$/.test(line.trim()));
}

/** The lines of the leading `---` fenced block, or null when there is no frontmatter. */
function extractFrontmatter(text: string): string[] | null {
  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') return null;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end === -1) return null;
  return lines.slice(1, end);
}

/**
 * Are both CLI adapter skills wired (present AND model-invocable) in this
 * directory? This is the guarantee `tenjin install` owes every target and the
 * thing `tenjin doctor` reports on.
 */
export function cliSkillsWired(wiring: HarnessWiring): boolean {
  return CLI_SKILL_NAMES.every((name) => {
    const s = wiring.skills.find((x) => x.name === name);
    return s !== undefined && s.present && s.modelInvocable === true;
  });
}

/** The CLI skills that are missing from disk entirely in this directory. */
export function missingCliSkills(wiring: HarnessWiring): string[] {
  return CLI_SKILL_NAMES.filter(
    (name) => wiring.skills.find((x) => x.name === name)?.present !== true,
  );
}

/**
 * CLI skills that are on disk but carry `disable-model-invocation: true`, so the
 * harness never surfaces them to the model. This is the exact shape of #35: the
 * file was copied, the skill was never wired.
 */
export function shadowedCliSkills(wiring: HarnessWiring): string[] {
  return CLI_SKILL_NAMES.filter((name) => {
    const s = wiring.skills.find((x) => x.name === name);
    return s?.present === true && s.modelInvocable === false;
  });
}

/** Is the hosted zero-install mirror present in this directory? */
export function hostedPresent(wiring: HarnessWiring): boolean {
  return wiring.skills.find((x) => x.name === HOSTED_SKILL_NAME)?.present === true;
}

/** Any Tenjin skill at all in this directory? Used to decide if a target is "in play". */
export function anyTenjinSkill(wiring: HarnessWiring): boolean {
  return wiring.skills.some((s) => s.present);
}
