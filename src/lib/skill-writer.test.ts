import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installSkill } from './skill-writer';
import { materializeTransform } from './skill-materialize';

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
