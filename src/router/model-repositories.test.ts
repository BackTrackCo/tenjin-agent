import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  currentModelGithubRepositories,
  githubRepository,
  modelGithubRepositories,
} from './model-repositories';

let dir: string;
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, readdirSync: vi.fn(actual.readdirSync) };
});
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

it.each([
  ['git@github.com:Acme/repo.git', 'Acme/repo'],
  ['https://secret-token@github.com/Acme/repo.git', 'Acme/repo'],
  ['ssh://git@github.com/Acme/repo.git', 'Acme/repo'],
  ['https://github.com.evil.test/Acme/repo', null],
  ['git@work-alias:Acme/repo.git', null],
  ['https://github.com/Acme/repo?token=secret', null],
  ['https://github.com/Acme/repo/extra', null],
])('extracts a GitHub origin name without credentials or host aliases: %s', (remote, name) => {
  expect(githubRepository(remote)).toBe(name);
});

it('names only selected roots and direct real child repos, without following sibling symlinks or nested repos', async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'model-repositories-')));
  const workspace = join(dir, 'workspace');
  async function repo(path: string, name: string) {
    await mkdir(join(path, '.git'), { recursive: true });
    await writeFile(
      join(path, '.git/config'),
      `[remote "origin"]\nurl = https://secret@github.com/${name}.git\n`,
    );
  }
  await repo(workspace, 'Acme/workspace');
  await repo(join(workspace, 'first'), 'Acme/first');
  await repo(join(workspace, '.hidden'), 'Acme/hidden');
  await repo(join(workspace, 'nested/deep'), 'Acme/too-deep');
  await repo(join(dir, 'foreign'), 'Acme/foreign');
  await symlink(join(dir, 'foreign'), join(workspace, 'alias'));
  expect(modelGithubRepositories([workspace])).toEqual([
    'Acme/workspace',
    'Acme/hidden',
    'Acme/first',
  ]);
  expect(JSON.stringify(modelGithubRepositories([workspace]))).not.toContain('secret');
  await writeFile(
    join(workspace, 'first/.git/config'),
    '[remote "origin"]\nurl = git@github.com:Acme/changed.git\n',
  );
  expect(modelGithubRepositories([workspace])).toContain('Acme/changed');
  expect(modelGithubRepositories([workspace])).not.toContain('Acme/first');
});

it('reads a linked worktree common origin, ignores other remotes and refuses oversized metadata', async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'model-repositories-')));
  const root = join(dir, 'worktree'),
    common = join(dir, 'common'),
    gitdir = join(common, 'worktrees/wt');
  await mkdir(root);
  await mkdir(gitdir, { recursive: true });
  await writeFile(join(root, '.git'), `gitdir: ${gitdir}\n`);
  await writeFile(join(gitdir, 'commondir'), '../..\n');
  await writeFile(
    join(common, 'config'),
    '[remote "other"]\nurl = https://github.com/Acme/other\n[remote "origin"]\nurl = git@github.com:Acme/owned.git\n',
  );
  expect(modelGithubRepositories([root])).toEqual(['Acme/owned']);
  await writeFile(join(common, 'config'), 'x'.repeat(65_537));
  expect(modelGithubRepositories([root])).toEqual([]);
});

it('offer aliases discard stale saved names without discovering new names into consent', async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'model-offer-alias-')));
  await mkdir(join(dir, '.git'));
  const config = join(dir, '.git/config');
  await writeFile(config, '[remote "origin"]\nurl = https://github.com/Acme/original.git\n');
  const settings = { repositories: [dir], githubRepositories: ['Acme/original'] };
  expect(currentModelGithubRepositories(settings)).toEqual(['Acme/original']);
  await writeFile(config, '[remote "origin"]\nurl = https://github.com/Acme/changed.git\n');
  expect(currentModelGithubRepositories(settings)).toEqual([]);
  vi.mocked(readdirSync).mockClear();
  expect(currentModelGithubRepositories({ ...settings, githubRepositories: [] })).toEqual([]);
  expect(readdirSync).not.toHaveBeenCalled();
});
