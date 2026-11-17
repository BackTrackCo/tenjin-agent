import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { testCtx } from '../context-test-utils';
import { runConfigSubagents } from './config-subagents';
import { modelSettings } from '../router/model-settings';
import { ModelJobStore } from '../router/model-job';
import { currentModelGithubRepositories } from '../router/model-repositories';

let dir: string;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

it('records explicit accepted-worker instruction consent while preserving wallet and account settings', async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'config-subagents-')));
  const repo = join(dir, 'repo');
  await mkdir(join(repo, '.git'), { recursive: true });
  await writeFile(
    join(dir, 'config.json'),
    JSON.stringify({
      maxAutoSpend: '250000',
      sessionBudget: '5000000',
      router: {
        enabled: true,
        accounts: true,
        subagents: true,
        subagentConsent: {
          version: 1,
          recipients: ['Tenjin', 'DeepSeek'],
          repositories: [repo],
          maxJobAtomic: '1000000',
          routerOrigin: 'https://tenjin.test',
        },
      },
    }),
  );
  expect(await modelSettings(dir, repo)).toBeNull();
  const result = await runConfigSubagents('on', { repository: repo, maxJob: '1' }, testCtx(dir));
  const saved = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
  expect(saved).toMatchObject({
    maxAutoSpend: '250000',
    sessionBudget: '5000000',
    router: {
      accounts: true,
      subagentConsent: {
        version: 2,
        instructions: 'applicable',
        reads: 'claude-home',
        repositories: [repo],
        maxJobAtomic: '1000000',
      },
    },
  });
  expect(JSON.stringify(result.data)).toContain('After acceptance');
  // The consent text names what a named directory grants: a Claude worker's working directory.
  expect(JSON.stringify(result.data)).toContain(
    'A Claude worker may read and write in every named directory',
  );
  // And that env files there are readable while their values are withheld from Tenjin and DeepSeek.
  expect(JSON.stringify(result.data)).toContain(
    'Tenjin replaces their values with [env:NAME] before anything reaches Tenjin or DeepSeek',
  );
  expect(JSON.stringify(result.data)).not.toContain(
    'TypeSafe/Jev for routing) to receive this repository’s subagent assignments, bounded parent context and applicable',
  );
  expect(await modelSettings(dir, repo)).not.toBeNull();
  await runConfigSubagents('off', {}, testCtx(dir));
  expect(await modelSettings(dir, repo)).toBeNull();
});

it('adds separately named repositories without losing earlier roots or duplicating canonical aliases', async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'config-subagents-')));
  const first = join(dir, 'first'),
    second = join(dir, 'second'),
    alias = join(dir, 'first-alias');
  await mkdir(first);
  await mkdir(second);
  await symlink(first, alias);
  await runConfigSubagents('on', { repository: first, maxJob: '1' }, testCtx(dir));
  await runConfigSubagents('on', { repository: second, maxJob: '0.50' }, testCtx(dir));
  const result = await runConfigSubagents(
    'on',
    { repository: alias, maxJob: '0.25' },
    testCtx(dir),
  );
  const saved = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
  expect(saved.router.subagentConsent.repositories).toEqual([first, second]);
  expect(saved.router.subagentConsent.maxJobAtomic).toBe('250000');
  expect(result.data).toMatchObject({ repository: first, repositories: [first, second] });
  expect(await modelSettings(dir, first)).toMatchObject({ maxJobAtomic: 250000n });
  expect(await modelSettings(dir, second)).toMatchObject({ maxJobAtomic: 250000n });
  expect(await modelSettings(dir, dir)).toBeNull();
});

it.each([
  { version: 1 },
  { routerOrigin: 'https://another-router.test' },
  { instructions: 'none' },
  { recipients: ['Tenjin'] },
  { maxJobAtomic: 'not-an-amount' },
])('does not carry forward incompatible disclosure roots: %j', async (change) => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'config-subagents-')));
  const old = join(dir, 'old'),
    selected = join(dir, 'selected');
  await mkdir(old);
  await mkdir(selected);
  await runConfigSubagents('on', { repository: old, maxJob: '1' }, testCtx(dir));
  const config = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
  Object.assign(config.router.subagentConsent, change);
  await writeFile(join(dir, 'config.json'), JSON.stringify(config));
  await runConfigSubagents('on', { repository: selected, maxJob: '1' }, testCtx(dir));
  const saved = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
  expect(saved.router.subagentConsent.repositories).toEqual([selected]);
  expect(await modelSettings(dir, old)).toBeNull();
});

it('canonicalizes only previously named available roots without inferring their parent', async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'config-subagents-')));
  const old = join(dir, 'old'),
    selected = join(dir, 'selected'),
    alias = join(dir, 'old-alias');
  await mkdir(old);
  await mkdir(selected);
  await symlink(old, alias);
  await runConfigSubagents('on', { repository: old, maxJob: '1' }, testCtx(dir));
  const config = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
  config.router.subagentConsent.repositories = [alias, old, join(dir, 'missing')];
  await writeFile(join(dir, 'config.json'), JSON.stringify(config));
  await runConfigSubagents('on', { repository: selected, maxJob: '1' }, testCtx(dir));
  const saved = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
  expect(saved.router.subagentConsent.repositories).toEqual([old, selected]);
});

it('records current GitHub origins for selected folders and refreshes aliases without broadening disclosure', async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'config-subagents-')));
  const workspace = join(dir, 'workspace'),
    repo = join(workspace, 'repo');
  await mkdir(join(repo, '.git'), { recursive: true });
  await writeFile(
    join(repo, '.git/config'),
    '[remote "origin"]\nurl = https://private-token@github.com/Acme/repo.git\n',
  );
  await runConfigSubagents('on', { repository: workspace, maxJob: '1' }, testCtx(dir));
  expect(await modelSettings(dir, repo)).toMatchObject({
    repositories: [workspace],
    githubRepositories: ['Acme/repo'],
  });
  await writeFile(
    join(repo, '.git/config'),
    '[remote "origin"]\nurl = git@github.com:Acme/changed.git\n',
  );
  const current = (await modelSettings(dir, repo))!;
  expect(current.repositories).toEqual([workspace]);
  expect(currentModelGithubRepositories(current)).toEqual([]);
  await runConfigSubagents('on', { repository: workspace, maxJob: '1' }, testCtx(dir));
  expect(await modelSettings(dir, repo)).toMatchObject({ githubRepositories: ['Acme/changed'] });
  const saved = await readFile(join(dir, 'config.json'), 'utf8');
  expect(saved).not.toContain('private-token');
  expect(JSON.parse(saved).router.subagentConsent.repositories).toEqual([workspace]);
});

it('refuses a job ceiling below the useful reservation floor before saving consent', async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'config-subagents-')));
  await expect(
    runConfigSubagents('on', { repository: dir, maxJob: '0.04' }, testCtx(dir)),
  ).rejects.toMatchObject({ code: 'USAGE' });
  // Above the old 32K floor ($0.044611), under one call at the 65,536 cap and the fee.
  await expect(
    runConfigSubagents('on', { repository: dir, maxJob: '0.08' }, testCtx(dir)),
  ).rejects.toThrow('at least $0.086866');
  await expect(readFile(join(dir, 'config.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('an explicit repository command narrows native-workspace disclosure to the named v2 scope', async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'config-subagents-')));
  const repository = join(dir, 'selected');
  await mkdir(repository);
  await writeFile(
    join(dir, 'config.json'),
    JSON.stringify({
      router: {
        subagents: true,
        subagentConsent: {
          version: 3,
          scope: 'native-workspace',
          instructions: 'applicable',
          reads: 'claude-home',
          recipients: ['Tenjin', 'DeepSeek', 'Exa'],
          routerOrigin: 'https://tenjin.sh',
          maxJobAtomic: '1000000',
        },
      },
    }),
  );
  await runConfigSubagents('on', { repository, maxJob: '1' }, testCtx(dir));
  const saved = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
  expect(saved.router.subagentConsent).toMatchObject({ version: 2, repositories: [repository] });
  expect(saved.router.subagentConsent).not.toHaveProperty('scope');
  expect(await modelSettings(dir, dir)).toBeNull();
});

it('lists why recent subagent calls got no offer, newest first, without changing any setting', async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'config-subagents-')));
  expect((await runConfigSubagents('why', {}, testCtx(dir))).data).toEqual({ noOffers: [] });
  const store = new ModelJobStore(dir);
  await store.noOffer({ sessionId: 's', tool: 'Agent', code: 'input_filter', detail: 'name' });
  await store.noOffer({
    sessionId: 's',
    tool: 'Task',
    code: 'over_size_limit',
    bytes: 17_203,
    limit: 16_384,
  });
  const result = await runConfigSubagents('why', {}, testCtx(dir));
  expect(result.data).toMatchObject({
    noOffers: [{ code: 'over_size_limit', bytes: 17_203 }, { code: 'input_filter' }],
  });
  expect(result.humanLines?.[1]).toMatch(/Task {2}over_size_limit \(17203 of 16384 bytes\)/);
  expect(result.humanLines?.[2]).toContain('Agent  input_filter:name');
  await expect(stat(join(dir, 'config.json'))).rejects.toThrow();
});

it('says which recent calls without an offer a native subagent made, and why it could not take one', async () => {
  // Catches: a subagent's call listed as the main loop's, so a person reading the list
  // could not tell which agent's calls stay native, nor that its tools are the reason.
  dir = await realpath(await mkdtemp(join(tmpdir(), 'config-subagents-')));
  const store = new ModelJobStore(dir);
  await store.noOffer({ sessionId: 's', tool: 'Agent', code: 'input_filter', detail: 'name' });
  await store.noOffer({
    sessionId: 's',
    tool: 'Agent',
    code: 'caller_unqualified',
    detail: 'tools',
    from: 'subagent',
  });
  const result = await runConfigSubagents('why', {}, testCtx(dir));
  expect(result.data).toMatchObject({
    noOffers: [{ code: 'caller_unqualified', from: 'subagent' }, { code: 'input_filter' }],
  });
  expect(result.humanLines?.[1]).toContain('Agent from a subagent  caller_unqualified:tools');
  expect(result.humanLines?.[2]).toContain('Z  Agent  input_filter:name');
});

it.each([
  ['before a worker could read ~/.claude', true],
  ['before Exa was named', false],
])('renews a consent from %s, keeping the directories it named', async (_when, noReads) => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'config-subagents-')));
  const first = join(dir, 'first'),
    second = join(dir, 'second');
  await mkdir(first);
  await mkdir(second);
  await runConfigSubagents('on', { repository: first, maxJob: '1' }, testCtx(dir));
  const path = join(dir, 'config.json');
  const earlier = JSON.parse(await readFile(path, 'utf8'));
  expect(earlier.router.subagentConsent).toMatchObject({
    reads: 'claude-home',
    recipients: ['Tenjin', 'DeepSeek', 'Exa'],
  });
  // The record as the earlier terms wrote it.
  if (noReads) delete earlier.router.subagentConsent.reads;
  earlier.router.subagentConsent.recipients = ['Tenjin', 'DeepSeek'];
  await writeFile(path, JSON.stringify(earlier));
  expect(await modelSettings(dir, first)).toBeNull();
  const renewed = await runConfigSubagents('on', { repository: second, maxJob: '1' }, testCtx(dir));
  // The person reads what a worker can read now and who receives what, and both
  // directories stand.
  expect(JSON.stringify(renewed.data)).toContain('every session transcript');
  expect(JSON.stringify(renewed.data)).toContain('Exa receives');
  expect(await modelSettings(dir, first)).not.toBeNull();
  expect(await modelSettings(dir, second)).not.toBeNull();
});
