import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { testCtx } from '../context-test-utils';
import { runConfigSubagents } from './config-subagents';
import { modelSettings } from '../router/model-settings';
import { ModelJobStore } from '../router/model-job';
import * as windowsWorkerConfig from '../router/windows-worker-config';

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
  // Review of b7974566: the text said the worker can read the skills and plugins under
  // ~/.claude. Claude Code loads them as instructions; the worker's file tools do not.
  expect(JSON.stringify(result.data)).toContain('file tools and commands do not read those files');
  expect(JSON.stringify(result.data)).not.toContain(
    'it can read the skills, plugins, agents, commands and rules under ~/.claude',
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

it('requires explicit Windows shell acknowledgement and clears that grant on off', async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'config-windows-subagents-')));
  const repo = join(dir, 'repo');
  await mkdir(repo);
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  const validate = vi
    .spyOn(windowsWorkerConfig, 'validateWindowsWorkerConfig')
    .mockImplementation(async (candidate) => candidate as windowsWorkerConfig.WindowsWorkerConfig);
  try {
    const flags = {
      repository: repo,
      maxJob: '1',
      windowsWorkerSid: 'S-1-5-21-1-2-3-4',
      windowsLauncher: 'D:\\Tools\\launcher.exe',
      windowsClaude: 'D:\\Tools\\claude.exe',
      windowsConfigDir: 'C:\\SharedClaude',
    };
    const ctx = testCtx(dir);
    await expect(runConfigSubagents('on', flags, ctx)).rejects.toMatchObject({
      fix: expect.stringContaining('--accept-windows-shell-access'),
    });
    // The worker account is given the directories the person names, so one must be named.
    await expect(
      runConfigSubagents(
        'on',
        { ...flags, repository: undefined, acceptWindowsShellAccess: true },
        ctx,
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining('only under the limited scope'),
      fix: expect.stringContaining('--repository'),
    });
    expect(validate).not.toHaveBeenCalled();
    const configured = await runConfigSubagents(
      'on',
      { ...flags, acceptWindowsShellAccess: true },
      ctx,
    );
    expect(configured.data).toMatchObject({ windowsWorker: { enabled: true } });
    const read = async () => JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
    const saved = (await read()).router;
    expect(saved.windowsWorker).toMatchObject({
      version: 1,
      workerSid: flags.windowsWorkerSid,
      shellAccess: 'native-windows',
      routerOrigin: saved.subagentConsent.routerOrigin,
    });
    await runConfigSubagents('off', {}, ctx);
    expect((await read()).router).not.toHaveProperty('windowsWorker');
    await runConfigSubagents('on', { repository: repo, maxJob: '1' }, ctx);
    expect((await read()).router).not.toHaveProperty('windowsWorker');
  } finally {
    validate.mockRestore();
    Object.defineProperty(process, 'platform', platform);
  }
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

// Review of b7974566: `on` required `--repository`, so nobody who had passed the install
// question could reach the install's consent again.
it('a bare on writes the consent the install question writes: every workspace, no directory', async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'config-subagents-')));
  const path = join(dir, 'config.json');
  const bare = await runConfigSubagents('on', {}, testCtx(dir));
  expect(bare.data).toMatchObject({ enabled: true, scope: 'every-workspace' });
  expect(bare.data).not.toHaveProperty('repositories');
  expect(JSON.parse(await readFile(path, 'utf8')).router).toEqual({
    subagents: true,
    subagentConsent: {
      version: 2,
      instructions: 'applicable',
      reads: 'claude-home',
      recipients: ['Tenjin', 'DeepSeek', 'Exa'],
      routerOrigin: 'https://tenjin.sh',
    },
  });
  expect(await modelSettings(dir, dir)).toMatchObject({ scope: 'native-workspace' });
  // Off, then on again: the same consent is back.
  await runConfigSubagents('off', {}, testCtx(dir));
  expect(await modelSettings(dir, dir)).toBeNull();
  await runConfigSubagents('on', {}, testCtx(dir));
  expect(await modelSettings(dir, dir)).not.toBeNull();
});

// Operator ruling 2026-11-18: a saved consent never gets wider without an action by the
// person. At 790acf79 `--repository` only added directories to a consent for every
// workspace, so a consent saved for three directories covered every session.
it("--repository limits the consent to the named directories, and each change of scope is the command's own word, said in its readback", async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'config-subagents-')));
  const first = join(dir, 'first'),
    second = join(dir, 'second');
  await mkdir(first);
  await mkdir(second);
  const said = (result: { humanLines?: string[] }) => result.humanLines?.join('\n') ?? '';
  const wide = await runConfigSubagents('on', {}, testCtx(dir));
  expect(said(wide)).toContain('Scope: every workspace.');
  expect(said(wide)).not.toMatch(/narrows|widens/);
  // Over a wide consent: narrowed, and said. A session elsewhere gets no offer any more.
  const narrowed = await runConfigSubagents('on', { repository: [first, second] }, testCtx(dir));
  expect(narrowed.data).toMatchObject({ scope: 'directories', repositories: [first, second] });
  expect(said(narrowed)).toContain(
    `Scope: only these directories, each with its subfolders: ${first}, ${second}. A session outside them gets no offer. This narrows a consent that covered every workspace.`,
  );
  expect(await modelSettings(dir, dir)).toBeNull();
  expect(await modelSettings(dir, first)).toMatchObject({ scope: 'repositories' });
  // The status says the same scope, and changes nothing.
  const before = await readFile(join(dir, 'config.json'), 'utf8');
  const status = await runConfigSubagents(undefined, {}, testCtx(dir));
  expect(status.data).toMatchObject({ scope: 'directories', repositories: [first, second] });
  expect(said(status)).toContain(
    `Scope: only these directories, each with its subfolders: ${first}, ${second}.`,
  );
  expect(await readFile(join(dir, 'config.json'), 'utf8')).toBe(before);
  // Only a bare on widens it, and it says what became of the directories.
  const widened = await runConfigSubagents('on', {}, testCtx(dir));
  expect(widened.data).toMatchObject({ scope: 'every-workspace' });
  expect(said(widened)).toContain(
    `Scope: every workspace. A session in any directory can be offered DeepSeek, and its worker gets that session’s own workspace. This widens a consent that was limited to: ${first}, ${second}. Those directories are no longer named.`,
  );
  expect(await modelSettings(dir, dir)).toMatchObject({ scope: 'native-workspace' });
  expect(said(await runConfigSubagents('status', {}, testCtx(dir)))).toContain(
    'Scope: every workspace.',
  );
  await runConfigSubagents('off', {}, testCtx(dir));
  expect(said(await runConfigSubagents(undefined, {}, testCtx(dir)))).toContain('routing is off');
});

// `--max-job` was required, and the cap was that amount whatever the per-call limit said.
it('takes the per-call limit as the cap where no ceiling is named, and says the cap in force', async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'config-subagents-')));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify({ maxAutoSpend: '500000' }));
  const followed = await runConfigSubagents('on', { repository: dir }, testCtx(dir));
  expect(followed.data).toMatchObject({ jobCapAtomic: '500000' });
  expect(followed.data).not.toHaveProperty('maxJobAtomic');
  // The consent holds no amount: no ceiling means the per-call limit.
  expect(JSON.parse(await readFile(path, 'utf8')).router.subagentConsent).not.toHaveProperty(
    'maxJobAtomic',
  );
  expect(await modelSettings(dir, dir)).toMatchObject({ maxJobAtomic: 500000n });
  // The next offer follows a changed limit, up as well as down.
  const saved = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, JSON.stringify({ ...saved, maxAutoSpend: '2000000' }));
  expect(await modelSettings(dir, dir)).toMatchObject({ maxJobAtomic: 2000000n });
  // A named ceiling above the limit is kept as named and does not lift the cap.
  const named = await runConfigSubagents('on', { repository: dir, maxJob: '5' }, testCtx(dir));
  expect(named.data).toMatchObject({ maxJobAtomic: '5000000', jobCapAtomic: '2000000' });
  expect(await modelSettings(dir, dir)).toMatchObject({ maxJobAtomic: 2000000n });
  // The same command without --max-job drops the ceiling again.
  const dropped = await runConfigSubagents('on', {}, testCtx(dir));
  expect(dropped.data).not.toHaveProperty('maxJobAtomic');
});

it('refuses to turn subagents on while the per-call limit is under one model call, and says so', async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'config-subagents-')));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify({ maxAutoSpend: '50000' }));
  await expect(runConfigSubagents('on', { repository: dir }, testCtx(dir))).rejects.toMatchObject({
    code: 'USAGE',
    message: expect.stringContaining('per-call spend limit, $0.05'),
    fix: expect.stringContaining('tenjin config set maxAutoSpend'),
  });
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ maxAutoSpend: '50000' });
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
