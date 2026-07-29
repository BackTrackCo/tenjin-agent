import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SKILL_NAMES } from './skills-source';
import {
  CLI_SKILL_NAMES,
  HOSTED_SKILL_NAME,
  anyTenjinSkill,
  cliSkillsWired,
  isModelInvocationDisabled,
  missingCliSkills,
  readAllWiring,
  readHarnessWiring,
  shadowedCliSkills,
  harnessFlagFor,
  detectHarnesses,
  harnessDetectedBy,
  harnessReads,
  harnessRequested,
  harnessInPlay,
  harnessTargetDir,
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

  it('accepts the YAML 1.1 truthy spellings a harness parser may take', () => {
    for (const v of ['true', 'True', 'TRUE', 'yes', 'Yes', 'on', 'ON', '"true"', "'yes'"]) {
      expect(isModelInvocationDisabled(`---\ndisable-model-invocation: ${v}\n---\n`)).toBe(true);
    }
    for (const v of ['false', 'False', 'no', 'off', '0', 'maybe']) {
      expect(isModelInvocationDisabled(`---\ndisable-model-invocation: ${v}\n---\n`)).toBe(false);
    }
  });

  it('strips an inline YAML comment before testing the value', () => {
    expect(isModelInvocationDisabled('---\ndisable-model-invocation: true # why\n---\n')).toBe(
      true,
    );
    expect(
      isModelInvocationDisabled('---\ndisable-model-invocation: false # not true\n---\n'),
    ).toBe(false);
  });

  it('handles a BOM, CRLF, and leading blank lines before the fence', () => {
    expect(isModelInvocationDisabled('\uFEFF---\ndisable-model-invocation: true\n---\n')).toBe(
      true,
    );
    expect(isModelInvocationDisabled('---\r\ndisable-model-invocation: true\r\n---\r\n')).toBe(
      true,
    );
    expect(isModelInvocationDisabled('\n\n---\ndisable-model-invocation: true\n---\n')).toBe(true);
  });
});

describe('skill name constants', () => {
  it('CLI_SKILL_NAMES and HOSTED_SKILL_NAME partition SKILL_NAMES', () => {
    // Two hand-maintained lists that must stay consistent: a rename in one and not
    // the other makes cliSkillsWired silently always false, so doctor would warn
    // "missing" forever on a correctly wired machine. The `satisfies` clause and
    // the Exclude type catch it at compile time; this catches a drifting count.
    expect([...CLI_SKILL_NAMES, HOSTED_SKILL_NAME].sort()).toEqual([...SKILL_NAMES].sort());
    expect(CLI_SKILL_NAMES).not.toContain(HOSTED_SKILL_NAME);
  });
});

describe('harnessFlagFor', () => {
  it('maps each skills directory to the --harness value that targets it', () => {
    // A bare `tenjin install` never targets ~/.agents/skills on a Claude-only
    // machine, so a fix line naming it has to say `--harness shared`.
    expect(harnessFlagFor(home, join(home, '.claude', 'skills'))).toBe('claude');
    expect(harnessFlagFor(home, join(home, '.agents', 'skills'))).toBe('shared');
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
    expect(w.state).toBe('hosted-only');
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
    expect(w.state).toBe('shadowed');
    expect(w.skills.find((s) => s.name === 'tenjin-publish')?.reason).toBe('disabled');
  });

  it('classifies each directory with a single verdict', async () => {
    const empty = await readHarnessWiring(join(home, 'gone'));
    expect(empty.state).toBe('empty');

    const hostedOnly = join(home, 'a');
    await seed(hostedOnly, HOSTED_SKILL_NAME);
    expect((await readHarnessWiring(hostedOnly)).state).toBe('hosted-only');

    const partial = join(home, 'b');
    await seed(partial, 'tenjin-search');
    expect((await readHarnessWiring(partial)).state).toBe('partial');
  });

  it('both CLI skills plus the hosted mirror is the fully wired state', async () => {
    const dir = join(home, '.claude', 'skills');
    for (const name of [...CLI_SKILL_NAMES, HOSTED_SKILL_NAME]) await seed(dir, name);
    const w = await readHarnessWiring(dir);
    expect(cliSkillsWired(w)).toBe(true);
    expect(w.state).toBe('wired');
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

describe('harness detection', () => {
  const noBinaries = (): boolean => false;

  it('names both probes: the home dir and the binary', async () => {
    await mkdir(join(home, '.codex'), { recursive: true });
    expect(harnessDetectedBy(home, 'codex', noBinaries)).toEqual(['home-dir']);
    expect(harnessDetectedBy(home, 'claude', (b) => b === 'claude')).toEqual(['binary']);
    expect(harnessDetectedBy(home, 'claude', noBinaries)).toEqual([]);
  });

  it('a directory is only judged when a harness HERE reads it', async () => {
    const [claudeDir, sharedDir] = skillsDirsFor(home) as [string, string];
    await mkdir(join(home, '.claude'), { recursive: true });

    const claudeOnly = detectHarnesses(home, noBinaries);
    expect(claudeOnly).toEqual({ claude: true, codex: false });
    expect(harnessReads(home, claudeDir, claudeOnly)).toBe(true);
    // The leftover-mirror case: nothing here reads ~/.agents/skills.
    expect(harnessReads(home, sharedDir, claudeOnly)).toBe(false);

    const both = detectHarnesses(home, (b) => b === 'codex');
    expect(harnessReads(home, sharedDir, both)).toBe(true);
  });

  it('with NO harness detected the shared dir is still judged: it is the fallback target', () => {
    const [claudeDir, sharedDir] = skillsDirsFor(home) as [string, string];
    const none = detectHarnesses(home, noBinaries);
    expect(none).toEqual({ claude: false, codex: false });
    expect(harnessReads(home, claudeDir, none)).toBe(false);
    expect(harnessReads(home, sharedDir, none)).toBe(true);
  });

  it('harnessTargetDir maps every target the way install writes it', () => {
    const [claudeDir, sharedDir] = skillsDirsFor(home) as [string, string];
    expect(harnessTargetDir(home, 'claude')).toBe(claudeDir);
    // Codex and the shared fallback are the same directory, hence one dir, two flags.
    expect(harnessTargetDir(home, 'codex')).toBe(sharedDir);
    expect(harnessTargetDir(home, 'shared')).toBe(sharedDir);
  });
});

describe('an explicitly requested harness', () => {
  const noBinaries = (): boolean => false;

  it('puts a directory in play that detection alone would skip', async () => {
    const [claudeDir, sharedDir] = skillsDirsFor(home) as [string, string];
    await mkdir(join(home, '.claude'), { recursive: true });
    const claudeOnly = detectHarnesses(home, noBinaries);

    // `tenjin install --harness shared` on this machine: nothing DETECTED reads the
    // shared dir, but the user named it, so it is still this machine's business.
    expect(harnessReads(home, sharedDir, claudeOnly)).toBe(false);
    expect(harnessRequested(home, sharedDir, ['shared'])).toBe(true);
    expect(harnessInPlay(home, sharedDir, claudeOnly, ['shared'])).toBe(true);
    // And the record says nothing about the other directory.
    expect(harnessRequested(home, claudeDir, ['shared'])).toBe(false);
    expect(harnessInPlay(home, claudeDir, claudeOnly, ['shared'])).toBe(true); // detected
  });

  it('a recorded `codex` covers the shared directory it writes to', () => {
    const [claudeDir, sharedDir] = skillsDirsFor(home) as [string, string];
    expect(harnessRequested(home, sharedDir, ['codex'])).toBe(true);
    expect(harnessRequested(home, claudeDir, ['codex'])).toBe(false);
  });

  it('an empty record changes nothing', async () => {
    const [claudeDir, sharedDir] = skillsDirsFor(home) as [string, string];
    await mkdir(join(home, '.claude'), { recursive: true });
    const claudeOnly = detectHarnesses(home, noBinaries);
    for (const dir of [claudeDir, sharedDir]) {
      expect(harnessInPlay(home, dir, claudeOnly, [])).toBe(harnessReads(home, dir, claudeOnly));
    }
  });
});
