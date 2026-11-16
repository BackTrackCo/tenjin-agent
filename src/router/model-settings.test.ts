import { mkdtemp, mkdir, realpath, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { modelSettings, nativeWorkspaceModelConsent } from './model-settings';
import * as repositories from './model-repositories';
let dir: string;
afterEach(async () => {
  vi.restoreAllMocks();
  if (dir) await rm(dir, { recursive: true, force: true });
});

it('uses fresh-install native-workspace disclosure in separate current workspaces without saving directory grants', async () => {
  const { data, repo } = await fixture({
    subagents: true,
    subagentConsent: nativeWorkspaceModelConsent({ routerOrigin: 'http://localhost:3939' }),
  });
  const sibling = join(dir, 'another-project');
  await mkdir(sibling);
  for (const root of [repo, sibling])
    expect(await modelSettings(data, root)).toMatchObject({
      version: 3,
      scope: 'native-workspace',
      root,
      repositories: [root],
      maxJobAtomic: 1000000n,
    });
  const { readFile } = await import('node:fs/promises');
  const saved = await readFile(join(data, 'config.json'), 'utf8');
  expect(saved).not.toContain(repo);
  expect(saved).not.toContain(sibling);
  expect(saved).not.toContain('repositories');
});

it.each([
  { scope: undefined },
  { scope: 'all' },
  { repositories: ['/'] },
  { maxJobAtomic: '0' },
  { recipients: ['Tenjin'] },
])('refuses incomplete or widened native-workspace consent %j', async (change) => {
  const consent = nativeWorkspaceModelConsent({ routerOrigin: 'http://localhost:3939' });
  const { data, repo } = await fixture({
    subagents: true,
    subagentConsent: { ...consent, ...change },
  });
  expect(await modelSettings(data, repo)).toBeNull();
});

it('a repository cannot create native-workspace disclosure, or override a global/project stop', async () => {
  const consent = nativeWorkspaceModelConsent({ routerOrigin: 'http://localhost:3939' });
  const { data, repo } = await fixture({});
  await mkdir(join(repo, '.tenjin'));
  const project = join(repo, '.tenjin', 'config.json');
  await writeFile(
    project,
    JSON.stringify({ router: { subagents: true, subagentConsent: consent } }),
  );
  expect(await modelSettings(data, repo)).toBeNull();
  await writeFile(
    join(data, 'config.json'),
    JSON.stringify({ router: { subagents: false, subagentConsent: consent } }),
  );
  expect(await modelSettings(data, repo)).toBeNull();
  await writeFile(
    join(data, 'config.json'),
    JSON.stringify({ router: { subagents: true, subagentConsent: consent } }),
  );
  await writeFile(project, JSON.stringify({ router: { subagents: false } }));
  expect(await modelSettings(data, repo)).toBeNull();
});
async function fixture(router: Record<string, unknown>) {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'model-consent-')));
  const data = join(dir, 'data'),
    repo = join(dir, 'repo');
  await mkdir(data);
  await mkdir(repo);
  await mkdir(join(repo, '.git'));
  await writeFile(join(data, 'config.json'), JSON.stringify({ router }));
  return { data, repo };
}
it('does not turn legacy tier routing or a boolean into inference/data consent', async () => {
  const { data, repo } = await fixture({ subagents: 'apply' });
  expect(await modelSettings(data, repo)).toBeNull();
  await writeFile(
    join(data, 'config.json'),
    JSON.stringify({
      router: {
        subagents: true,
        subagentConsent: {
          version: 1,
          recipients: ['Tenjin', 'DeepSeek'],
          repositories: [repo],
          maxJobAtomic: '1000000',
          routerOrigin: 'http://localhost:3939',
        },
      },
    }),
  );
  expect(await modelSettings(data, repo)).toBeNull();
  await writeFile(join(data, 'config.json'), JSON.stringify({ router: { subagents: true } }));
  expect(await modelSettings(data, repo)).toBeNull();
});
it('keeps the actual cwd beneath an explicitly selected workspace and lets a project revoke access immediately', async () => {
  const { data, repo } = await fixture({});
  await writeFile(
    join(data, 'config.json'),
    JSON.stringify({
      router: {
        subagents: true,
        subagentConsent: {
          version: 2,
          instructions: 'applicable',
          recipients: ['Tenjin', 'DeepSeek'],
          repositories: [repo],
          maxJobAtomic: '1000000',
          routerOrigin: 'http://localhost:3939',
        },
      },
    }),
  );
  const discover = vi.spyOn(repositories, 'modelGithubRepositories');
  const nested = join(repo, 'nested');
  await mkdir(nested);
  expect(await modelSettings(data, nested)).toMatchObject({
    root: nested,
    repositories: [repo],
    maxJobAtomic: 1000000n,
  });
  expect(await modelSettings(data, dir)).toBeNull();
  const sibling = `${repo}-other`;
  await mkdir(sibling);
  expect(await modelSettings(data, sibling)).toBeNull();
  await mkdir(join(repo, '.tenjin'));
  await writeFile(
    join(repo, '.tenjin', 'config.json'),
    JSON.stringify({ router: { subagents: false } }),
  );
  expect(await modelSettings(data, repo)).toBeNull();
  expect(await modelSettings(data, nested)).toBeNull();
  expect(discover).not.toHaveBeenCalled();
});
