import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  claudeWorkspaceWorktrees,
  modelClaudeRepositories,
  resolveClaudeWorkspace,
  sameClaudeWorkspace,
  withholdDroppedDirectories,
} from './claude-workspace';
import type { ModelSettings } from './model-settings';

let dir: string;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

it('native-workspace consent follows exact native roots and exceptions without granting an additional directory', async () => {
  const f = await fixture();
  const scope = await resolveClaudeWorkspace(
    f.root,
    {
      permissions: { additionalDirectories: [f.sibling] },
      sandbox: { filesystem: { allowRead: [f.read], allowWrite: [f.write] } },
    },
    'native-workspace',
  );
  expect(scope).toMatchObject({
    workingDirectories: [f.root, f.sibling],
    readExceptions: [f.read],
    writeExceptions: [f.write],
  });
  expect(modelClaudeRepositories(scope!, { scope: 'native-workspace' } as ModelSettings)).toEqual([
    f.root,
    f.sibling,
    f.read,
    f.write,
  ]);
  const removed = await resolveClaudeWorkspace(f.root, {}, 'native-workspace');
  expect(removed?.workingDirectories).toEqual([f.root]);
  expect(sameClaudeWorkspace(scope!, removed!)).toBe(false);
  // A missing native directory no longer costs the offer; the worker is denied it.
  expect(
    await resolveClaudeWorkspace(
      f.root,
      { permissions: { additionalDirectories: [join(dir, 'missing')] } },
      'native-workspace',
    ),
  ).toMatchObject({ workingDirectories: [f.root], droppedDirectories: [join(dir, 'missing')] });
});
async function fixture() {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'claude-workspace-')));
  const paths = await Promise.all(
    ['repo', 'sibling', 'read-only', 'write-only'].map(async (name) => {
      const path = join(dir, name);
      await mkdir(path);
      return path;
    }),
  );
  return { root: paths[0]!, sibling: paths[1]!, read: paths[2]!, write: paths[3]! };
}

it('preserves distinct native working, read and write scopes without deriving grants from disclosure', async () => {
  const f = await fixture();
  const scope = await resolveClaudeWorkspace(
    f.root,
    {
      permissions: { additionalDirectories: [f.sibling] },
      sandbox: { filesystem: { allowRead: [f.read], allowWrite: [f.write] } },
    },
    [dir],
  );
  expect(scope).toEqual({
    version: 1,
    root: f.root,
    workingDirectories: [f.root, dir, f.sibling],
    workingDirectorySpellings: [f.root, dir, f.sibling].sort(),
    readExceptions: [f.read],
    writeExceptions: [f.write],
    droppedDirectories: [],
  });
  expect(await resolveClaudeWorkspace(f.root, {}, [dir])).toMatchObject({
    workingDirectories: [f.root, dir],
    readExceptions: [],
    writeExceptions: [],
  });
  // Outside consent: dropped and named for the offer, instead of losing the offer.
  expect(
    await resolveClaudeWorkspace(f.root, { permissions: { additionalDirectories: [f.sibling] } }, [
      f.root,
    ]),
  ).toMatchObject({ workingDirectories: [f.root], droppedDirectories: [f.sibling] });
  // A read exception outside consent still refuses: the sandbox lets allowRead beat a deny.
  expect(
    await resolveClaudeWorkspace(f.root, { sandbox: { filesystem: { allowRead: [f.read] } } }, [
      f.root,
    ]),
  ).toBeNull();
});

it('makes every consented repository a working directory, so a session reaches its workspace siblings', async () => {
  const f = await fixture();
  const scope = await resolveClaudeWorkspace(f.root, {}, [dir, f.sibling]);
  expect(scope?.workingDirectories).toEqual([f.root, dir, f.sibling]);
  // A consented root that is gone is skipped; it cannot become a working directory.
  expect(
    (await resolveClaudeWorkspace(f.root, {}, [f.root, join(dir, 'gone')]))?.workingDirectories,
  ).toEqual([f.root]);
});

it('refuses rather than deny a dropped native directory that holds the session', async () => {
  const f = await fixture();
  // Denying the parent would deny the repository too, so no worker can be scoped.
  expect(
    await resolveClaudeWorkspace(f.root, { permissions: { additionalDirectories: [dir] } }, [
      f.root,
    ]),
  ).toBeNull();
});

it('names consented linked worktrees, including a checkout outside the repository, and skips others', async () => {
  const f = await fixture();
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    });
  const child = join(dir, 'child');
  await mkdir(child);
  git(child, 'init', '-q');
  git(
    child,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'i',
  );
  git(child, 'worktree', 'add', '-q', '-b', 'inside', join(dir, '.worktrees', 'inside'));
  git(child, 'worktree', 'add', '-q', '-b', 'loop', join(f.sibling, 'loop'));
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'claude-worktree-outside-')));
  try {
    git(child, 'worktree', 'add', '-q', '-b', 'outside', join(outside, 'wt'));
    // A forged administrative entry whose checkout does not point back is ignored.
    await mkdir(join(child, '.git', 'worktrees', 'forged'));
    await writeFile(join(child, '.git', 'worktrees', 'forged', 'gitdir'), `${f.write}/.git\n`);
    await writeFile(join(f.write, '.git'), 'gitdir: /elsewhere\n');
    const scope = await resolveClaudeWorkspace(f.root, {}, [dir]);
    expect(await claudeWorkspaceWorktrees(scope!)).toEqual(
      [join(dir, '.worktrees', 'inside'), join(f.sibling, 'loop')].sort(),
    );
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

it('canonicalizes explicitly configured aliases and rejects unavailable or changed native scopes', async () => {
  const f = await fixture();
  const alias = join(dir, 'alias');
  await symlink(f.sibling, alias);
  const first = await resolveClaudeWorkspace(
    f.root,
    { permissions: { additionalDirectories: [alias, f.sibling] } },
    [dir],
  );
  expect(first?.workingDirectories).toEqual([f.root, dir, f.sibling]);
  expect(first?.workingDirectorySpellings).toEqual([f.root, dir, f.sibling, alias].sort());
  const changed = await resolveClaudeWorkspace(
    f.root,
    { permissions: { additionalDirectories: [f.read] } },
    [dir],
  );
  expect(sameClaudeWorkspace(first!, changed!)).toBe(false);
  expect(
    await resolveClaudeWorkspace(
      f.root,
      { sandbox: { filesystem: { allowRead: [join(dir, 'missing')] } } },
      [dir],
    ),
  ).toBeNull();
});

it('native-workspace disclosure cannot retain a raw native alias after its target changes', async () => {
  const f = await fixture();
  const alias = join(dir, 'native-alias');
  await symlink(f.sibling, alias);
  const settings = { permissions: { additionalDirectories: [alias] } };
  const first = await resolveClaudeWorkspace(f.root, settings, 'native-workspace');
  await rm(alias);
  await symlink(f.read, alias);
  const changed = await resolveClaudeWorkspace(f.root, settings, 'native-workspace');
  expect(first?.workingDirectorySpellings).toContain(alias);
  expect(changed?.workingDirectorySpellings).toContain(alias);
  expect(sameClaudeWorkspace(first!, changed!)).toBe(false);
  expect(await resolveClaudeWorkspace(f.root, {}, undefined as never)).toBeNull();
  expect(await resolveClaudeWorkspace(f.root, {}, 'all' as never)).toBeNull();
});

it('withholds a dropped directory as a whole path, in plain and JSON-escaped text', () => {
  const text = JSON.stringify({
    system: 'Additional working directories:\n  - /x/out\n  - /x/out-kept\n  - /y/x/out',
    read: '/x/out/secret.txt',
    quoted: '/x/"q"',
  });
  const withheld = withholdDroppedDirectories(text, ['/x/out', '/x/"q"']);
  expect(JSON.parse(withheld)).toEqual({
    system:
      'Additional working directories:\n  - [withheld directory]\n  - /x/out-kept\n  - /y/x/out',
    read: '[withheld directory]/secret.txt',
    quoted: '[withheld directory]',
  });
});
