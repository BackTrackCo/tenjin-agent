import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  modelClaudeRepositories,
  resolveClaudeWorkspace,
  sameClaudeWorkspace,
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
  expect(
    await resolveClaudeWorkspace(
      f.root,
      { permissions: { additionalDirectories: [join(dir, 'missing')] } },
      'native-workspace',
    ),
  ).toBeNull();
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
    workingDirectories: [f.root, f.sibling],
    workingDirectorySpellings: [f.root, f.sibling].sort(),
    readExceptions: [f.read],
    writeExceptions: [f.write],
  });
  expect(await resolveClaudeWorkspace(f.root, {}, [dir])).toMatchObject({
    workingDirectories: [f.root],
    readExceptions: [],
    writeExceptions: [],
  });
  expect(
    await resolveClaudeWorkspace(f.root, { permissions: { additionalDirectories: [f.sibling] } }, [
      f.root,
    ]),
  ).toBeNull();
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
  expect(first?.workingDirectories).toEqual([f.root, f.sibling]);
  expect(first?.workingDirectorySpellings).toEqual([f.root, f.sibling, alias].sort());
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
