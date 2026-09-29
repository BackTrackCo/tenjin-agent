import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createJevgrepSnapshot, isSnapshotSourcePath, SNAPSHOT_LIMITS } from './snapshot.js';
const directories: string[] = [];
function git(root: string, ...args: string[]) {
  return execFileSync(
    '/usr/bin/git',
    [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-C',
      root,
      ...args,
    ],
    {
      env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
      stdio: 'pipe',
    },
  );
}
async function repository() {
  const dir = await mkdtemp(join(tmpdir(), 'jev-snapshot-test-'));
  directories.push(dir);
  const root = join(dir, 'repo');
  await mkdir(root);
  git(root, 'init', '-q');
  return { dir, root };
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
describe('immutable committed source snapshot', () => {
  it('rejects a subdirectory root instead of losing ancestor ignore policy', async () => {
    const { dir, root } = await repository();
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src/good.ts'), 'public source');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'fixture');
    await expect(
      createJevgrepSnapshot({
        root: join(root, 'src'),
        destination: join(dir, 'snapshot'),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('repository root');
  });
  it('copies committed regular text and omits mutable, secret, binary and symlink content', async () => {
    const { dir, root } = await repository();
    await writeFile(join(root, 'good.ts'), 'export const committed = true;');
    await writeFile(join(root, '.env'), 'API_KEY=not-for-upload');
    await writeFile(join(root, 'binary.ts'), Buffer.from([0, 1, 2]));
    await writeFile(join(root, 'private.ts'), '-----BEGIN PRIVATE KEY-----\nDO NOT DISCLOSE');
    await writeFile(join(dir, 'outside.txt'), 'private outside root');
    await symlink(join(dir, 'outside.txt'), join(root, 'escaped.txt'));
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'fixture');
    await writeFile(join(root, 'good.ts'), 'dirty replacement not authorized');
    await writeFile(join(root, 'untracked.ts'), 'untracked not authorized');
    const destination = join(dir, 'snapshot');
    const result = await createJevgrepSnapshot({
      root,
      destination,
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ files: 1, omitted: 4, source: 'git-head-committed-only' });
    expect(await readFile(join(destination, 'good.ts'), 'utf8')).toBe(
      'export const committed = true;',
    );
    for (const name of ['.env', 'escaped.txt', 'private.ts', 'binary.ts', 'untracked.ts'])
      await expect(readFile(join(destination, name))).rejects.toThrow();
  });
  it('does not follow a working-tree source path swapped to an outside symlink', async () => {
    const { dir, root } = await repository();
    await writeFile(join(root, 'good.ts'), 'public committed source');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'fixture');
    await rm(join(root, 'good.ts'));
    await writeFile(join(dir, 'outside.ts'), 'private source');
    await symlink(join(dir, 'outside.ts'), join(root, 'good.ts'));
    const destination = join(dir, 'snapshot');
    await createJevgrepSnapshot({ root, destination, signal: new AbortController().signal });
    expect(await readFile(join(destination, 'good.ts'), 'utf8')).toBe('public committed source');
  });
  it('fails closed on excessive file count and observes cancellation', async () => {
    const { dir, root } = await repository();
    await Promise.all(
      Array.from({ length: SNAPSHOT_LIMITS.files + 1 }, (_, i) =>
        writeFile(join(root, `f${i}.ts`), 'x'),
      ),
    );
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'fixture');
    await expect(
      createJevgrepSnapshot({
        root,
        destination: join(dir, 'snapshot'),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('exceeds');
    const controller = new AbortController();
    controller.abort();
    await expect(
      createJevgrepSnapshot({
        root,
        destination: join(dir, 'cancelled'),
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  });
  it('preserves hierarchical ignore rules and prevents rescue beneath an excluded parent', async () => {
    const { dir, root } = await repository();
    await mkdir(join(root, 'blocked'));
    await writeFile(join(root, '.gitignore'), 'git-hidden.ts\n');
    await writeFile(join(root, '.ignore'), 'blocked/\nsearch-hidden.ts\n');
    await writeFile(join(root, 'blocked/.ignore'), '!inside.ts\n');
    for (const name of ['good.ts', 'git-hidden.ts', 'search-hidden.ts', 'blocked/inside.ts'])
      await writeFile(join(root, name), 'public fixture');
    git(root, 'add', '--force', '.');
    git(root, 'commit', '-qm', 'fixture');
    const destination = join(dir, 'snapshot');
    const result = await createJevgrepSnapshot({
      root,
      destination,
      signal: new AbortController().signal,
    });
    expect(result.files).toBe(1);
    expect(await readFile(join(destination, 'good.ts'), 'utf8')).toBe('public fixture');
    for (const name of [
      'git-hidden.ts',
      'search-hidden.ts',
      'blocked/inside.ts',
      '.gitignore',
      '.ignore',
    ])
      await expect(readFile(join(destination, name))).rejects.toThrow();
  });
  it.each(['modified', 'untracked', 'symlink'])(
    'fails closed on %s live ignore policy',
    async (kind) => {
      const { dir, root } = await repository();
      await writeFile(join(root, 'good.ts'), 'public source');
      if (kind === 'modified') await writeFile(join(root, '.ignore'), '# committed policy\n');
      git(root, 'add', '.');
      git(root, 'commit', '-qm', 'fixture');
      if (kind === 'symlink') await symlink(join(dir, 'outside.ignore'), join(root, '.ignore'));
      else await writeFile(join(root, '.ignore'), 'good.ts\n');
      await expect(
        createJevgrepSnapshot({
          root,
          destination: join(dir, 'snapshot'),
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow('Current ignore rules');
      await expect(readFile(join(dir, 'snapshot/good.ts'))).rejects.toThrow();
    },
  );
  it.each([
    '../outside.ts',
    '.git/config',
    '.env',
    'node_modules/pkg/a.ts',
    'private-key.json',
    'wallet.json',
    'a\\b.ts',
    'a\nb.ts',
    'package-lock.json',
  ])('excludes unsafe or sensitive path %s', (path) => {
    expect(isSnapshotSourcePath(path)).toBe(false);
  });
});

it('copies a 160 KiB file only with extended policy without changing aggregate limits', async () => {
  const { dir, root } = await repository();
  await writeFile(join(root, 'small.ts'), 'export const small = true;');
  await writeFile(join(root, 'large.ts'), 'x'.repeat(160 * 1024));
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'fixture');
  const signal = new AbortController().signal;
  expect(
    await createJevgrepSnapshot({ root, destination: join(dir, 'standard'), signal }),
  ).toMatchObject({ files: 1, omitted: 1 });
  expect(
    await createJevgrepSnapshot({
      root,
      destination: join(dir, 'extended'),
      signal,
      profile: 'extended-v1',
    }),
  ).toMatchObject({ files: 2, omitted: 0 });
});
