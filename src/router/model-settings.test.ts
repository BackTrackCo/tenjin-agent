import { mkdtemp, mkdir, realpath, symlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { modelConsent, modelSettings } from './model-settings';
let dir: string;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});
const ORIGIN = 'http://localhost:3939';
async function fixture(router: Record<string, unknown>, limits: Record<string, string> = {}) {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'model-consent-')));
  const data = join(dir, 'data'),
    repo = join(dir, 'repo');
  await mkdir(data);
  await mkdir(repo);
  await mkdir(join(repo, '.git'));
  await writeFile(join(data, 'config.json'), JSON.stringify({ ...limits, router }));
  return { data, repo };
}
const save = (data: string, router: Record<string, unknown>, limits = {}) =>
  writeFile(join(data, 'config.json'), JSON.stringify({ ...limits, router }));

it('a consent that names no directory covers a session in any directory and saves no directory grant', async () => {
  const consent = modelConsent({ routerOrigin: ORIGIN });
  expect(consent).toEqual({
    version: 2,
    instructions: 'applicable',
    reads: 'claude-home',
    recipients: ['Tenjin', 'DeepSeek', 'Exa'],
    routerOrigin: ORIGIN,
  });
  const { data, repo } = await fixture({ subagents: true, subagentConsent: consent });
  const other = join(dir, 'other');
  await mkdir(other);
  for (const root of [repo, other])
    expect(await modelSettings(data, root)).toEqual({
      version: 2,
      scope: 'native-workspace',
      root,
      repositories: [root],
      maxJobAtomic: 1000000n,
      routerOrigin: ORIGIN,
      context: 'session',
    });
});

it.each([
  { instructions: undefined },
  { reads: undefined },
  { recipients: ['Tenjin', 'DeepSeek'] },
  { routerOrigin: 'not a url' },
  { version: 1 },
  { repositories: [] },
  { maxJobAtomic: 'not-an-amount' },
])('refuses an incomplete or malformed consent %j', async (change) => {
  const { data, repo } = await fixture({
    subagents: true,
    subagentConsent: { ...modelConsent({ routerOrigin: ORIGIN }), ...change },
  });
  expect(await modelSettings(data, repo)).toBeNull();
});

// Operator ruling 2026-11-18: a saved consent never gets wider without an action by the
// person. At 790acf79 a consent that named directories covered every session's workspace.
it('a consent that names directories is limited to them: a nested repository and a worktree under one are covered, a lookalike, a link out and the parent are not', async () => {
  const { data, repo } = await fixture({});
  const sibling = join(dir, 'sibling');
  const nested = join(repo, 'packages', 'nested');
  const worktree = join(repo, '.worktrees', 'fix');
  const lookalike = `${repo}-other`;
  const outside = join(dir, 'outside');
  for (const path of [sibling, nested, worktree, lookalike, outside])
    await mkdir(path, { recursive: true });
  // A nested Git repository, and a linked worktree's checkout, under a named directory.
  await mkdir(join(nested, '.git'));
  await writeFile(join(worktree, '.git'), 'gitdir: /elsewhere/.git/worktrees/fix\n');
  // A name under the named directory that points outside it.
  await symlink(outside, join(repo, 'link-out'));
  // The record as a build before the ruling saved it, with a key no longer read.
  await save(
    data,
    {
      subagents: true,
      subagentConsent: {
        ...modelConsent({
          routerOrigin: ORIGIN,
          repositories: [repo, sibling],
          maxJobAtomic: '1000000',
        }),
        githubRepositories: ['Acme/repo'],
      },
    },
    { maxAutoSpend: '4000000' },
  );
  for (const root of [repo, nested, worktree, sibling])
    expect(await modelSettings(data, root)).toMatchObject({
      scope: 'repositories',
      root,
      repositories: [repo, sibling],
      // The amount it holds stays a named ceiling, under a higher per-call limit too.
      maxJobAtomic: 1000000n,
    });
  // The real path decides: a sibling with the same prefix, a link that leaves the
  // directory, the parent of a named directory, and any other directory get no consent.
  for (const root of [lookalike, join(repo, 'link-out'), outside, dir])
    expect(await modelSettings(data, root)).toBeNull();
  // A limited consent whose directories are all gone covers nothing, never everything.
  await save(data, {
    subagents: true,
    subagentConsent: modelConsent({ routerOrigin: ORIGIN, repositories: [join(dir, 'gone')] }),
  });
  expect(await modelSettings(data, repo)).toBeNull();
});

it('a repository cannot grant consent, and a global or project stop is immediate', async () => {
  const consent = modelConsent({ routerOrigin: ORIGIN });
  const { data, repo } = await fixture({});
  await mkdir(join(repo, '.tenjin'));
  const project = join(repo, '.tenjin', 'config.json');
  await writeFile(
    project,
    JSON.stringify({ router: { subagents: true, subagentConsent: consent } }),
  );
  expect(await modelSettings(data, repo)).toBeNull();
  await save(data, { subagents: false, subagentConsent: consent });
  expect(await modelSettings(data, repo)).toBeNull();
  await save(data, { subagents: true, subagentConsent: consent });
  expect(await modelSettings(data, repo)).not.toBeNull();
  await writeFile(project, JSON.stringify({ router: { subagents: false } }));
  expect(await modelSettings(data, repo)).toBeNull();
});

// A job is one call to the person. The cap was the consent's own amount, $1 from install,
// whatever the per-call limit said: a $0.25 limit still let a job spend $1.
it.each([
  // [the per-call limit, the ceiling named with --max-job, the cap]
  ['250000', undefined, 250000n],
  ['4000000', undefined, 4000000n],
  ['0', undefined, 0n],
  // A named ceiling lowers the cap and never lifts it.
  ['4000000', '1000000', 1000000n],
  ['250000', '1000000', 250000n],
] as const)(
  'a job cap is the per-call limit %s, under a named ceiling of %s: %s',
  async (maxAutoSpend, maxJobAtomic, cap) => {
    const consent = modelConsent({
      routerOrigin: ORIGIN,
      ...(maxJobAtomic === undefined ? {} : { maxJobAtomic }),
    });
    const { data, repo } = await fixture(
      { subagents: true, subagentConsent: consent },
      { maxAutoSpend },
    );
    expect(await modelSettings(data, repo)).toMatchObject({ maxJobAtomic: cap });
  },
);

it('does not turn legacy tier routing or a boolean into inference/data consent', async () => {
  const { data, repo } = await fixture({ subagents: 'apply' });
  expect(await modelSettings(data, repo)).toBeNull();
  await save(data, { subagents: true });
  expect(await modelSettings(data, repo)).toBeNull();
});
