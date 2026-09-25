import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeOwnedSkill, removeRetiredSkills } from './skill-placement';

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'tenjin-place-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});
const skills = () => join(home, '.claude', 'skills');
const payDir = () => join(skills(), 'tenjin-pay');
async function writeSkill(name = 'tenjin-pay') {
  await mkdir(payDir(), { recursive: true });
  await writeFile(join(payDir(), 'SKILL.md'), `---\nname: ${name}\n---\nlegacy instructions\n`);
}

describe('retired skill cleanup', () => {
  it('removes only our skill file and preserves neighboring operator files', async () => {
    await writeSkill();
    await writeFile(join(payDir(), 'notes.md'), 'mine');
    await removeRetiredSkills(home);
    expect(existsSync(join(payDir(), 'SKILL.md'))).toBe(false);
    expect(await readFile(join(payDir(), 'notes.md'), 'utf8')).toBe('mine');
  });
  it('removes an empty owned directory and is idempotent without packaged source', async () => {
    await writeSkill();
    expect(await removeRetiredSkills(home)).toEqual([payDir()]);
    expect(existsSync(payDir())).toBe(false);
    expect(await removeRetiredSkills(home)).toEqual([]);
    expect(existsSync(join(home, '.agents'))).toBe(false);
  });
  it('preserves a foreign skill at the obsolete path', async () => {
    await writeSkill('somebody-else');
    expect(await removeOwnedSkill('tenjin-pay', skills())).toEqual({ changed: false });
    expect(await readFile(join(payDir(), 'SKILL.md'), 'utf8')).toContain('somebody-else');
  });
  it('does not traverse a symlinked skills directory', async () => {
    const foreign = join(home, 'foreign');
    await mkdir(join(foreign, 'tenjin-pay'), { recursive: true });
    await writeFile(
      join(foreign, 'tenjin-pay', 'SKILL.md'),
      '---\nname: tenjin-pay\n---\nforeign directory',
    );
    await mkdir(join(home, '.claude'), { recursive: true });
    await symlink(foreign, skills());
    expect(await removeRetiredSkills(home)).toEqual([]);
    expect(await readFile(join(foreign, 'tenjin-pay', 'SKILL.md'), 'utf8')).toContain(
      'foreign directory',
    );
  });
  it('cleans the explicitly refreshed project too', async () => {
    const project = join(home, 'project');
    const path = join(project, '.agents', 'skills', 'tenjin-pay');
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'SKILL.md'), '---\nname: tenjin-pay\n---\nold');
    expect(await removeRetiredSkills(home, project)).toEqual([path]);
  });
});
