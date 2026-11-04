import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ownHostsFor, remoteHosts, remoteHostsIn } from './own-urls';
import type { Packet } from './context';

/**
 * The user's own hosts: the current repository's git remotes, read from its
 * config file alone, and the harness's own (claude.ai for Claude Code).
 */

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'router-own-urls-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const CONFIG = [
  '[core]',
  '\trepositoryformatversion = 0',
  '[remote "origin"]',
  '\turl = git@github.com:acme/widgets.git',
  '\tfetch = +refs/heads/*:refs/remotes/origin/*',
  '[remote "mirror"]',
  '\turl = https://GitLab.example.org/acme/widgets.git',
  '[remote "fork"]',
  '\turl = "ssh://git@codeberg.org:2222/me/widgets.git"',
  '[submodule "docs"]',
  '\turl = https://not-a-remote.example/docs.git',
  '[remote "alias"]',
  '\turl = work:acme/widgets.git',
].join('\n');

const packet = (literalUrls: string[]): Packet => ({
  current: { role: 'user', text: 'see these' },
  history: [],
  literalUrls,
  historyStatus: 'ok',
});

describe("the repository's remote hosts", () => {
  it('reads each remote url as its host, in scp, https and ssh form, and nothing else', () => {
    expect(remoteHostsIn(CONFIG)).toEqual(['github.com', 'gitlab.example.org', 'codeberg.org']);
  });

  it('reads them from the repository the directory is in, and a linked worktree', async () => {
    const repo = join(home, 'repo');
    await mkdir(join(repo, '.git', 'worktrees', 'wt'), { recursive: true });
    await writeFile(join(repo, '.git', 'config'), CONFIG);
    await mkdir(join(repo, 'src', 'deep'), { recursive: true });
    expect(await remoteHosts(join(repo, 'src', 'deep'), home)).toContain('github.com');
    const wt = join(home, 'wt');
    await mkdir(wt);
    await writeFile(join(wt, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'wt')}\n`);
    await writeFile(join(repo, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
    expect(await remoteHosts(wt, home)).toContain('github.com');
  });

  it('names none for a repository with no remote, or a directory in none', async () => {
    const bare = join(home, 'bare');
    await mkdir(join(bare, '.git'), { recursive: true });
    await writeFile(join(bare, '.git', 'config'), '[core]\n\tbare = false\n');
    expect(await remoteHosts(bare, home)).toEqual([]);
    expect(await remoteHosts(join(home, 'nowhere'), home)).toEqual([]);
  });

  it("adds the harness's own hosts, and reads nothing for a turn with no link", async () => {
    const repo = join(home, 'repo');
    await mkdir(join(repo, '.git'), { recursive: true });
    await writeFile(join(repo, '.git', 'config'), CONFIG);
    expect(await ownHostsFor(packet(['https://x.test/']), repo, 'claude', home)).toEqual([
      'github.com',
      'gitlab.example.org',
      'codeberg.org',
      'claude.ai',
    ]);
    expect(await ownHostsFor(packet(['https://x.test/']), repo, 'codex', home)).not.toContain(
      'claude.ai',
    );
    expect(await ownHostsFor(packet([]), repo, 'claude', home)).toEqual([]);
  });
});
