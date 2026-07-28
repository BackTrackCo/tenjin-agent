import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLI_SKILL_NAMES,
  HOSTED_SKILL_NAME,
  anyTenjinSkill,
  cliSkillsWired,
  hostedPresent,
  isModelInvocationDisabled,
  missingCliSkills,
  readAllWiring,
  readHarnessWiring,
  shadowedCliSkills,
  skillsDirsFor,
} from './skill-wiring';

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'tenjin-wiring-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function seed(dir: string, name: string, extra = ''): Promise<void> {
  await mkdir(join(dir, name), { recursive: true });
  await writeFile(
    join(dir, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: test\n${extra}---\n\n# ${name}\n`,
  );
}

describe('isModelInvocationDisabled', () => {
  it('true only when the frontmatter sets the flag', () => {
    expect(isModelInvocationDisabled('---\nname: x\ndisable-model-invocation: true\n---\n')).toBe(
      true,
    );
    expect(isModelInvocationDisabled('---\nname: x\ndisable-model-invocation: false\n---\n')).toBe(
      false,
    );
    expect(isModelInvocationDisabled('---\nname: x\n---\n')).toBe(false);
  });

  it('ignores the flag mentioned in the BODY, not the frontmatter', () => {
    // This repo's own skills discuss `disable-model-invocation` in prose; reading
    // the whole file (or grepping it) would misread a documented skill as disabled.
    const text = [
      '---',
      'name: tenjin-publish',
      'description: publish things',
      '---',
      '',
      'This skill is no longer `disable-model-invocation: true`, so it is invocable.',
      'disable-model-invocation: true',
      '',
    ].join('\n');
    expect(isModelInvocationDisabled(text)).toBe(false);
  });

  it('no frontmatter at all reads as invocable', () => {
    expect(isModelInvocationDisabled('# Just a heading\n')).toBe(false);
    expect(isModelInvocationDisabled('---\nunterminated: true\n')).toBe(false);
  });

  it('tolerates trailing whitespace on the flag line', () => {
    expect(isModelInvocationDisabled('---\ndisable-model-invocation:  true  \n---\n')).toBe(true);
  });
});

describe('skillsDirsFor', () => {
  it('covers Claude Code and the shared Agent Skills location, in install order', () => {
    expect(skillsDirsFor(home)).toEqual([
      join(home, '.claude', 'skills'),
      join(home, '.agents', 'skills'),
    ]);
  });
});

describe('readHarnessWiring', () => {
  it('a missing directory reports nothing present', async () => {
    const w = await readHarnessWiring(join(home, 'nope'));
    expect(w.exists).toBe(false);
    expect(w.skills.every((s) => !s.present)).toBe(true);
    expect(anyTenjinSkill(w)).toBe(false);
    expect(missingCliSkills(w)).toEqual([...CLI_SKILL_NAMES]);
  });

  it('hosted skill alone: present, but no CLI skills wired', async () => {
    const dir = join(home, '.claude', 'skills');
    await seed(dir, HOSTED_SKILL_NAME);
    const w = await readHarnessWiring(dir);
    expect(hostedPresent(w)).toBe(true);
    expect(cliSkillsWired(w)).toBe(false);
    expect(missingCliSkills(w)).toEqual([...CLI_SKILL_NAMES]);
    expect(shadowedCliSkills(w)).toEqual([]);
  });

  it('publish on disk with the flag set is shadowed, not wired', async () => {
    const dir = join(home, '.claude', 'skills');
    await seed(dir, 'tenjin-search');
    await seed(dir, 'tenjin-publish', 'disable-model-invocation: true\n');
    const w = await readHarnessWiring(dir);
    expect(missingCliSkills(w)).toEqual([]); // it IS on disk
    expect(shadowedCliSkills(w)).toEqual(['tenjin-publish']); // and still not wired
    expect(cliSkillsWired(w)).toBe(false);
  });

  it('both CLI skills plus the hosted mirror is the fully wired state', async () => {
    const dir = join(home, '.claude', 'skills');
    for (const name of [...CLI_SKILL_NAMES, HOSTED_SKILL_NAME]) await seed(dir, name);
    const w = await readHarnessWiring(dir);
    expect(cliSkillsWired(w)).toBe(true);
    expect(hostedPresent(w)).toBe(true);
    expect(shadowedCliSkills(w)).toEqual([]);
  });
});

describe('readAllWiring', () => {
  it('reads both harness targets independently', async () => {
    await seed(join(home, '.claude', 'skills'), HOSTED_SKILL_NAME);
    for (const name of [...CLI_SKILL_NAMES, HOSTED_SKILL_NAME]) {
      await seed(join(home, '.agents', 'skills'), name);
    }
    const [claude, shared] = await readAllWiring(home);
    expect(cliSkillsWired(claude!)).toBe(false);
    expect(cliSkillsWired(shared!)).toBe(true);
  });
});
