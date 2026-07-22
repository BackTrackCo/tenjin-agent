import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveSkillsSource, SKILL_NAMES } from './skills-source';
import { CliError } from './errors';

describe('resolveSkillsSource', () => {
  it('finds the packaged skills dir by walking up from a source module', () => {
    // From this test's own location (src/lib) it must walk up to the repo root
    // skills/ (the same walk the built dist/ module does to its sibling skills/).
    const here = fileURLToPath(new URL('.', import.meta.url));
    const dir = resolveSkillsSource(here);
    expect(basename(dir)).toBe('skills');
    for (const name of SKILL_NAMES) {
      expect(existsSync(join(dir, name, 'SKILL.md'))).toBe(true);
    }
  });

  it('resolves a fabricated skills/ tree without reaching the real repo', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenjin-skills-src-'));
    try {
      await mkdir(join(root, 'pkg', 'dist'), { recursive: true });
      await mkdir(join(root, 'pkg', 'skills', 'tenjin'), { recursive: true });
      await writeFile(join(root, 'pkg', 'skills', 'tenjin', 'SKILL.md'), '# fixture');
      const dir = resolveSkillsSource(join(root, 'pkg', 'dist'));
      expect(dir).toBe(join(root, 'pkg', 'skills'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('throws INTERNAL when no skills dir exists up the tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenjin-skills-none-'));
    try {
      let caught: unknown;
      try {
        resolveSkillsSource(root);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(CliError);
      expect((caught as CliError).code).toBe('INTERNAL');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
