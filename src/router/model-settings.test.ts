import { mkdtemp, mkdir, realpath, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  modelConsentOutdated,
  modelSettings,
  nativeWorkspaceModelConsent,
  outdatedModelConsent,
} from './model-settings';
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
  // A named ceiling of zero. With the rule (`maxJob`), the amount is not the cap.
  { maxJobAtomic: '0', maxJob: undefined },
  { recipients: ['Tenjin'] },
])('refuses incomplete or widened native-workspace consent %j', async (change) => {
  const consent = nativeWorkspaceModelConsent({ routerOrigin: 'http://localhost:3939' });
  const { data, repo } = await fixture({
    subagents: true,
    subagentConsent: { ...consent, ...change },
  });
  expect(await modelSettings(data, repo)).toBeNull();
});

it('stops qualifying a consent given before a worker could read the global Claude Code folder, until it is renewed', async () => {
  // Agreed to under the earlier disclosure: the named or current workspace, nothing of ~/.claude.
  const earlier: Record<string, unknown> = {
    ...nativeWorkspaceModelConsent({ routerOrigin: 'http://localhost:3939' }),
  };
  delete earlier.reads;
  const { data, repo } = await fixture({ subagents: true, subagentConsent: earlier });
  expect(await modelSettings(data, repo)).toBeNull();
  expect(await modelConsentOutdated(data)).toBe(true);
  expect(outdatedModelConsent(earlier)).toMatchObject({ version: 3 });
  // Renewed, it qualifies again and is no longer out of date.
  await writeFile(
    join(data, 'config.json'),
    JSON.stringify({
      router: { subagents: true, subagentConsent: { ...earlier, reads: 'claude-home' } },
    }),
  );
  expect(await modelSettings(data, repo)).toMatchObject({ version: 3 });
  expect(await modelConsentOutdated(data)).toBe(false);
  // A record that is wrong in another way is not an earlier consent.
  expect(outdatedModelConsent({ ...earlier, recipients: ['Tenjin'] })).toBeNull();
});

it('stops qualifying a consent that names Tenjin and DeepSeek but not Exa, until it is renewed', async () => {
  // The failure: a consent given before a worker's web searches went to Exa kept
  // qualifying, so Exa received queries under terms that never named it.
  const withoutExa: Record<string, unknown> = {
    ...nativeWorkspaceModelConsent({ routerOrigin: 'http://localhost:3939' }),
    recipients: ['Tenjin', 'DeepSeek'],
  };
  const { data, repo } = await fixture({ subagents: true, subagentConsent: withoutExa });
  expect(await modelSettings(data, repo)).toBeNull();
  expect(await modelConsentOutdated(data)).toBe(true);
  // The earliest record, from before ~/.claude was named as well, is renewed the same way.
  const earliest = { ...withoutExa };
  delete earliest.reads;
  expect(outdatedModelConsent(earliest)).toMatchObject({
    reads: 'claude-home',
    recipients: ['Tenjin', 'DeepSeek', 'Exa'],
  });
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

// A job is one call to the person. The cap was the consent's own amount, $1 from install,
// whatever the per-call limit said: a $0.25 limit still let a job spend $1.
it.each([
  // [the per-call limit, the consent's amount, whether it names the rule, the cap]
  ['250000', '1000000', true, 250000n],
  ['3000000', '1000000', true, 3000000n],
  ['0', '1000000', true, 0n],
  // A named ceiling, or a consent from before the rule: the smaller of the two.
  ['250000', '1000000', false, 250000n],
  ['3000000', '1000000', false, 1000000n],
  ['3000000', '500000', false, 500000n],
] as const)(
  'caps a job at the per-call limit %s with a consent amount of %s (rule: %s)',
  async (maxAutoSpend, maxJobAtomic, rule, cap) => {
    const consent: Record<string, unknown> = {
      ...nativeWorkspaceModelConsent({ routerOrigin: 'http://localhost:3939', maxJobAtomic }),
    };
    if (!rule) delete consent.maxJob;
    const { data, repo } = await fixture(
      { subagents: true, subagentConsent: consent },
      { maxAutoSpend },
    );
    expect(await modelSettings(data, repo)).toMatchObject({ maxJobAtomic: cap });
  },
);

it('caps a job at the default per-call limit where none is saved', async () => {
  const consent = nativeWorkspaceModelConsent({
    routerOrigin: 'http://localhost:3939',
    maxJobAtomic: '4000000',
  });
  const { data, repo } = await fixture({ subagents: true, subagentConsent: consent });
  expect(await modelSettings(data, repo)).toMatchObject({ maxJobAtomic: 1000000n });
});
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
          reads: 'claude-home',
          recipients: ['Tenjin', 'DeepSeek', 'Exa'],
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
