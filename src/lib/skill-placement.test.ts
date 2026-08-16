import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { placeOptionalSkill, syncBazaarSkill } from './skill-placement';
import { resolveSkillsSource, OPTIONAL_PAY_SKILL } from './skills-source';
import type { Io } from './output';

const SKILLS_SRC = resolveSkillsSource(fileURLToPath(new URL('.', import.meta.url)));

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'tenjin-place-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function io(): Io {
  const sink = () => ({ write: () => true }) as unknown as NodeJS.WritableStream;
  return { stdout: sink(), stderr: sink(), isTTY: false };
}

const claudeSkills = () => join(home, '.claude', 'skills');
const payDir = () => join(claudeSkills(), OPTIONAL_PAY_SKILL);

describe('placeOptionalSkill', () => {
  it('round-trips presence, and removal leaves operator files behind', async () => {
    await mkdir(claudeSkills(), { recursive: true });
    await placeOptionalSkill(OPTIONAL_PAY_SKILL, claudeSkills(), SKILLS_SRC, true);
    expect(await readFile(join(payDir(), 'SKILL.md'), 'utf8')).toContain('name: tenjin-pay');

    await writeFile(join(payDir(), 'notes.md'), 'mine');
    await placeOptionalSkill(OPTIONAL_PAY_SKILL, claudeSkills(), SKILLS_SRC, false);
    expect(existsSync(join(payDir(), 'SKILL.md'))).toBe(false);
    expect(await readFile(join(payDir(), 'notes.md'), 'utf8')).toBe('mine'); // dir survives

    await placeOptionalSkill(OPTIONAL_PAY_SKILL, claudeSkills(), SKILLS_SRC, true);
    await rm(join(payDir(), 'notes.md'));
    await placeOptionalSkill(OPTIONAL_PAY_SKILL, claudeSkills(), SKILLS_SRC, false);
    expect(existsSync(payDir())).toBe(false); // empty dir goes with our file
  });

  it('never deletes a same-named skill that is not ours', async () => {
    await mkdir(payDir(), { recursive: true });
    await writeFile(join(payDir(), 'SKILL.md'), '---\nname: somebody-else\n---\ntheirs\n');
    await placeOptionalSkill(OPTIONAL_PAY_SKILL, claudeSkills(), SKILLS_SRC, false);
    expect(await readFile(join(payDir(), 'SKILL.md'), 'utf8')).toContain('somebody-else');
  });
});

describe('syncBazaarSkill', () => {
  it('converges only directories a tenjin skill is wired into, and never creates one', async () => {
    const wired = join(home, '.claude', 'skills');
    await mkdir(join(wired, 'tenjin-search'), { recursive: true });
    await writeFile(join(wired, 'tenjin-search', 'SKILL.md'), '---\nname: tenjin-search\n---\nx\n');
    // ~/.agents/skills does not exist and must not be created.

    await syncBazaarSkill(true, { io: io(), homeDir: home, skillsSourceDir: SKILLS_SRC });
    expect(existsSync(join(wired, 'tenjin-pay', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(home, '.agents'))).toBe(false);

    await syncBazaarSkill(false, { io: io(), homeDir: home, skillsSourceDir: SKILLS_SRC });
    expect(existsSync(join(wired, 'tenjin-pay'))).toBe(false);
  });
});
