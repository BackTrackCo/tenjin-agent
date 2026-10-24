import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderPluginFiles } from './plugin-files';
import { removePluginFolder, writePluginFolder } from './plugin-folder';
import { PAY_SKILL_PATH } from './plugin-skill';

describe('the plugin folder with a linked skill directory', () => {
  let root: string;
  let folder: string;
  let external: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tenjin-folder-'));
    folder = join(root, 'skills', 'tenjin-router');
    external = join(root, 'mine');
    expect((await writePluginFolder(folder, renderPluginFiles('1.0.0'))).state).toBe('written');
    const skillDir = join(folder, dirname(PAY_SKILL_PATH));
    await rm(skillDir, { recursive: true });
    await mkdir(external, { recursive: true });
    await writeFile(join(external, 'SKILL.md'), 'mine');
    await symlink(external, skillDir, 'dir');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('refuses a refresh and leaves the linked file as it is', async () => {
    const result = await writePluginFolder(folder, renderPluginFiles('1.0.1'));
    expect(result.state).toBe('refused');
    expect(result.reason).toContain('is a link or not a folder');
    expect(await readFile(join(external, 'SKILL.md'), 'utf8')).toBe('mine');
  });

  it('uninstalls around the link and keeps the file behind it', async () => {
    const result = await removePluginFolder(folder);
    expect(result.removed).toBe(true);
    expect(result.left).toEqual([dirname(PAY_SKILL_PATH)]);
    expect(await readFile(join(external, 'SKILL.md'), 'utf8')).toBe('mine');
  });
});
