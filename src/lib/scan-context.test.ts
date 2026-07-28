import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveProjectMarkers, extractRemoteSlugs } from './scan-context';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-scan-context-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const CONFIG = [
  '[core]',
  '\trepositoryformatversion = 0',
  '[remote "origin"]',
  '\turl = git@github.com:AcmeCorp/secret-svc.git',
  '\tfetch = +refs/heads/*:refs/remotes/origin/*',
  '[remote "mirror"]',
  '\turl = https://gitlab.example.com/platform/infra/secret-svc.git',
].join('\n');

describe('extractRemoteSlugs', () => {
  it('extracts slugs from scp-like and URL remotes, .git-stripped', () => {
    expect(extractRemoteSlugs(CONFIG)).toEqual([
      'AcmeCorp/secret-svc',
      'platform/infra/secret-svc',
    ]);
  });

  it('handles ssh:// with credentials and dedupes', () => {
    const config = [
      '[remote "origin"]',
      '\turl = ssh://git@github.com/Org/repo.git',
      '[remote "backup"]',
      '\turl = ssh://git@github.com/Org/repo.git',
    ].join('\n');
    expect(extractRemoteSlugs(config)).toEqual(['Org/repo']);
  });

  it('ignores slugless remotes (bare host, local path)', () => {
    const config = ['[remote "origin"]', '\turl = /srv/git/repo'].join('\n');
    expect(extractRemoteSlugs(config)).toEqual([]);
  });
});

describe('deriveProjectMarkers', () => {
  it('reads .git/config from an ancestor of cwd', async () => {
    await mkdir(join(dir, '.git'), { recursive: true });
    await writeFile(join(dir, '.git', 'config'), CONFIG);
    const nested = join(dir, 'src', 'lib');
    await mkdir(nested, { recursive: true });
    expect(await deriveProjectMarkers(nested)).toEqual([
      'AcmeCorp/secret-svc',
      'platform/infra/secret-svc',
    ]);
  });

  it('follows a worktree .git file through gitdir + commondir', async () => {
    // Layout: main/.git/{config,worktrees/wt/{commondir}} and wt/.git -> gitdir.
    const gitdir = join(dir, 'main', '.git', 'worktrees', 'wt');
    await mkdir(gitdir, { recursive: true });
    await writeFile(join(dir, 'main', '.git', 'config'), CONFIG);
    await writeFile(join(gitdir, 'commondir'), '../..\n');
    const wt = join(dir, 'wt');
    await mkdir(wt, { recursive: true });
    await writeFile(join(wt, '.git'), `gitdir: ${gitdir}\n`);
    expect(await deriveProjectMarkers(wt)).toEqual([
      'AcmeCorp/secret-svc',
      'platform/infra/secret-svc',
    ]);
  });

  it('returns [] outside a git checkout and never throws', async () => {
    expect(await deriveProjectMarkers(dir)).toEqual([]);
    expect(await deriveProjectMarkers(join(dir, 'does', 'not', 'exist'))).toEqual([]);
  });
});
