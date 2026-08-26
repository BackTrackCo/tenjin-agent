import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installSkill } from './skill-writer';
import { materializeTransform } from './skill-materialize';
import { SHIPPED_SKILL_FILES, SKILL_NAMES, resolveSkillsSource } from './skills-source';

/**
 * The materialize seam on `installSkill`: the source is shaped BEFORE the compare
 * and the write, so "up-to-date" is judged against what the current config state
 * would write, and a flag flip turns the same packaged source into a real update.
 * The copy semantics themselves (symlinks, modes, ownership) stay covered by
 * install.test.ts against the real packaged skills.
 */

const MARKED = [
  '---',
  'name: demo',
  '---',
  'body',
  '<!-- tenjin:when flag -->',
  'conditional line',
  '<!-- /tenjin:when -->',
  '',
].join('\n');

let root: string;
let src: string;
let dest: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tenjin-skill-writer-'));
  src = join(root, 'source', 'demo');
  dest = join(root, 'skills', 'demo');
  await mkdir(src, { recursive: true });
  await mkdir(join(root, 'skills'), { recursive: true });
  await writeFile(join(src, 'SKILL.md'), MARKED);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('installSkill with a materialize transform', () => {
  it('writes the shaped content, never the markers', async () => {
    const result = await installSkill(src, dest, false, 'demo', {
      materialize: materializeTransform({ flag: false }),
    });
    expect(result.status).toBe('installed');
    const written = await readFile(join(dest, 'SKILL.md'), 'utf8');
    expect(written).not.toContain('conditional line');
    expect(written).not.toContain('tenjin:when');
    expect(written).toContain('body');
  });

  it('judges up-to-date against the shaped content, so a flag flip is an update', async () => {
    await installSkill(src, dest, false, 'demo', {
      materialize: materializeTransform({ flag: false }),
    });
    const same = await installSkill(src, dest, false, 'demo', {
      materialize: materializeTransform({ flag: false }),
    });
    expect(same.status).toBe('up-to-date');
    const flipped = await installSkill(src, dest, false, 'demo', {
      materialize: materializeTransform({ flag: true }),
    });
    expect(flipped.status).toBe('updated');
    expect(await readFile(join(dest, 'SKILL.md'), 'utf8')).toContain('conditional line');
  });

  it('a dry run resolves the same shaped content as the real run', async () => {
    const dry = await installSkill(src, dest, true, 'demo', {
      materialize: materializeTransform({ flag: true }),
    });
    expect(dry.status).toBe('would-install');
    await installSkill(src, dest, false, 'demo', {
      materialize: materializeTransform({ flag: true }),
    });
    const again = await installSkill(src, dest, true, 'demo', {
      materialize: materializeTransform({ flag: true }),
    });
    expect(again.status).toBe('up-to-date');
  });

  it('a throwing transform aborts before anything is written', async () => {
    await writeFile(join(src, 'SKILL.md'), '<!-- tenjin:when broken -->\nno close\n');
    await expect(
      installSkill(src, dest, false, 'demo', { materialize: materializeTransform({}) }),
    ).rejects.toThrow(/Malformed skill markers/);
    await expect(readFile(join(dest, 'SKILL.md'), 'utf8')).rejects.toThrow();
  });
});

/**
 * The seam has NO consumer yet: no writer passes `materialize`, so `install`, the
 * self-heal, `doctor` and `scripts/pack-smoke.sh` all still compare packaged bytes
 * directly. That is correct only while no packaged skill carries a marker, and
 * pack-smoke's `cmp` against the raw packaged file is the one comparer that cannot
 * be taught from inside vitest. So this is a tripwire, not a style check: the first
 * marker added to a shipped skill fails here, naming the four comparers that have
 * to learn to materialize through one resolver in that same change. Three of four
 * is how a shaped skill and a raw comparison disagree forever.
 */
describe('packaged skills carry no markers yet', () => {
  /**
   * EVERY packaged markdown file, not every `SKILL.md`. `materializeTransform`
   * gates on `rel.toLowerCase().endsWith('.md')`, so a marker in a reference file
   * is exactly as load-bearing as one in a SKILL.md, and this test is the whole
   * tripwire: `tenjin:when` appears nowhere else in src/, scripts/ or skills/,
   * and pack-smoke has no marker assertion. Iterating SKILL_NAMES alone covered
   * three of the five files the package ships.
   */
  it('every shipped markdown file is marker-free, so raw byte comparison stays valid', async () => {
    const source = resolveSkillsSource(fileURLToPath(new URL('.', import.meta.url)));
    for (const name of SKILL_NAMES) {
      for (const rel of SHIPPED_SKILL_FILES[name]) {
        const text = await readFile(join(source, name, rel), 'utf8');
        expect(text, `${name}/${rel} ships a tenjin:when marker`).not.toContain('tenjin:when');
      }
    }
  });
});
