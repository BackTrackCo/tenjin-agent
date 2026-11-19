import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { main } from '../cli';
import { captureIo, testCtx } from '../context-test-utils';
import { persist } from '../commands/config';
import { loadRawConfig } from '../lib/config';
import type { RuntimeSetup } from '../lib/runtime';
import { runCodexInstall } from '../router/codex-install';
import { runRouterInstall } from '../router/install';
import { SUBAGENT_TERMS } from '../commands/config-subagents';
import { CODEX_PLUGIN } from '../router/codex-host';

// Real core, host installers, config locks, registration files and receipts.
// Only native processes, runtime download, wallet and network are seams.
const seams = vi.hoisted(() => ({
  home: '',
  work: '',
  cfg: '',
  data: '',
  hosts: ['claude'] as ('claude' | 'codex')[],
  nativeConfig: {} as unknown,
  failRuntime: false,
  failCodex: false,
  turnOff: false,
}));
vi.mock('../router/hosts', async (original) => {
  const actual = await original<typeof import('../router/hosts')>();
  return {
    ...actual,
    installHosts: async () => seams.hosts,
    otherHostNote: async () => undefined,
    recordInstalledHost: (dir: string, host: 'claude' | 'codex') =>
      actual.recordInstalledHost(dir, host, async () => false),
  };
});
async function fakeRuntime(): Promise<RuntimeSetup> {
  await mkdir(join(seams.data, 'runtime'), { recursive: true });
  return {
    state: seams.failRuntime ? 'failed' : 'skipped',
    root: join(seams.data, 'runtime'),
    firstTime: false,
    launcher: null,
  };
}
function wallet() {
  return {
    homeDir: seams.home,
    env: { CLAUDE_CONFIG_DIR: seams.cfg, CLAUDECODE: '1' },
    walletExists: async () => false,
    createWallet: async () => '0x1111111111111111111111111111111111111111',
    walletSigning: async () => ({ signing: { status: 'ready' as const, source: 'file' as const } }),
    observedSigning: async () => false,
    walletBalance: async () => 0n,
    listMcpProcesses: async () => [],
  };
}
vi.mock('../router/install', async (original) => {
  const actual = await original<typeof import('../router/install')>();
  return {
    ...actual,
    runtimeOncePerRun: () => {
      let rt: Promise<RuntimeSetup> | undefined;
      return () => (rt ??= fakeRuntime());
    },
    runRouterInstall: (
      args: Parameters<typeof actual.runRouterInstall>[0],
      ctx: Parameters<typeof actual.runRouterInstall>[1],
      deps: Parameters<typeof actual.runRouterInstall>[2] = {},
    ) =>
      actual.runRouterInstall(args, ctx, {
        ...wallet(),
        cwd: seams.work,
        findClaude: () => null,
        runtime: fakeRuntime,
        ...deps,
      }),
  };
});
vi.mock('../router/codex-install', async (original) => {
  const actual = await original<typeof import('../router/codex-install')>();
  return {
    ...actual,
    runCodexInstall: (
      args: Parameters<typeof actual.runCodexInstall>[0],
      ctx: Parameters<typeof actual.runCodexInstall>[1],
      deps: Parameters<typeof actual.runCodexInstall>[2] = {},
    ) =>
      actual.runCodexInstall(args, ctx, {
        ...wallet(),
        runtime: fakeRuntime,
        run: async () => {
          if (seams.turnOff)
            await persist(ctx.dataDir, (config) => ({ ...config, router: { subagents: false } }));
          return {
            code: seams.failCodex ? 1 : 0,
            stdout: '{}',
            stderr: seams.failCodex ? 'synthetic registration failure' : '',
          };
        },
        config: async () => seams.nativeConfig,
        hooks: async () => ({ data: [] }),
        version: async () => '0.157.1',
        hostsDir: '/synthetic/package/codex',
        ...deps,
      }),
  };
});

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tenjin-core-new-install-'));
  Object.assign(seams, {
    home: join(root, 'home'),
    work: join(root, 'work'),
    cfg: join(root, 'claude'),
    data: join(root, 'home', '.tenjin'),
    hosts: ['claude'],
    nativeConfig: {},
    failRuntime: false,
    failCodex: false,
    turnOff: false,
  });
  await mkdir(seams.home);
  await mkdir(join(seams.work, '.git'), { recursive: true });
  vi.stubEnv('CI', '1');
  vi.stubEnv('HOME', seams.home);
  vi.stubEnv('TENJIN_DATA_DIR', seams.data);
  vi.stubEnv('CLAUDE_CONFIG_DIR', seams.cfg);
  for (const key of [
    'CLAUDECODE',
    'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_CODE_EXECPATH',
    'CODEX_SESSION_ID',
    'TENJIN_BASE_URL',
  ])
    vi.stubEnv(key, '');
  vi.stubEnv('CLAUDECODE', '1');
  vi.stubGlobal(
    'fetch',
    async () =>
      new Response('{}', { status: 400, headers: { 'content-type': 'application/json' } }),
  );
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});
async function install(args: string[] = []) {
  const captured = captureIo();
  const code = await main(['install', ...args], captured.io);
  return { code, output: captured.stdout(), config: await loadRawConfig(seams.data) };
}
function expectEnabled(config: Awaited<ReturnType<typeof loadRawConfig>>) {
  expect(config.router).toMatchObject({ subagents: true });
  // The one consent: no directory, and no ceiling, so the cap is the per-call limit.
  expect(config.router?.subagentConsent).toEqual({
    version: 2,
    instructions: 'applicable',
    reads: 'claude-home',
    recipients: ['Tenjin', 'DeepSeek', 'Exa'],
    routerOrigin: 'https://tenjin.sh',
  });
  expect(config.install?.freshSetup).toBeUndefined();
}

it.each([['claude'], ['codex'], ['claude', 'codex']] as ('claude' | 'codex')[][])(
  'offers one explicit subagent choice after spending on %j',
  async (...hosts) => {
    seams.hosts = hosts;
    const first = await install();
    expect(first.code).toBe(0);
    expect(first.config.router?.subagents).not.toBe(true);
    expect(first.config.router?.subagentConsent).toBeUndefined();
    expect(first.config.install?.freshSetup).toBeDefined();
    const data = JSON.parse(first.output).data;
    for (const installed of data.hosts ? data.hosts.map((host: string) => data[host]) : [data])
      expect(installed.nextSteps).toMatchObject([{ id: 'spend' }]);
    const spending = await install(['--yes']);
    expect(spending.code).toBe(0);
    expect(spending.config.router?.subagentConsent).toBeUndefined();
    expect(spending.config.maxAutoSpend).toBe('1000000');
    expect(spending.config.sessionBudget).toBe('5000000');
    const acceptedData = JSON.parse(spending.output).data;
    const subagentSteps = (
      acceptedData.hosts
        ? acceptedData.hosts.map((host: string) => acceptedData[host])
        : [acceptedData]
    ).flatMap((receipt: { nextSteps: { id: string }[] }) =>
      receipt.nextSteps.filter(({ id }) => id === 'subagents'),
    );
    expect(subagentSteps).toMatchObject([
      {
        // The consent question, whole: an agent relays it word for word.
        question: [
          'Use a cheap model for eligible subagent jobs?',
          'Claude accepts or declines each offer. DeepSeek sees accepted work and tool results.',
          'Each job costs up to your per-call spend limit. Details: https://github.com/BackTrackCo/tenjin-agent/blob/main/docs/subagents.md',
        ].join('\n'),
        options: [
          { id: 'off', recommended: true, command: expect.stringMatching(/ --subagents off$/) },
          { id: 'on', recommended: false, command: expect.stringMatching(/ --subagents on$/) },
        ],
      },
    ]);
    const optedIn = await install(['--subagents', 'on']);
    expect(optedIn.code).toBe(0);
    expectEnabled(optedIn.config);
    expect(optedIn.output).not.toContain('Use a cheap model for eligible subagent jobs?');
  },
);

it('saves off without consent and does not ask again on reinstall', async () => {
  const off = await install(['--yes', '--subagents', 'off']);
  expect(off.code).toBe(0);
  expect(off.config.router).toEqual({ subagents: false });
  expect(off.config.install?.freshSetup).toBeUndefined();
  expect(JSON.parse(off.output).data.subagents).toEqual({ enabled: false });
  const repeated = await install();
  expect(repeated.config.router).toEqual({ subagents: false });
  expect(repeated.output).not.toContain('Use a cheap model for eligible subagent jobs?');
});

// The job cap was a separate $1, whatever per-call limit the person had just chosen.
it.each([
  ['0', '0'],
  ['0.50', '500000'],
  ['3', '3000000'],
])(
  'turns subagents on at the per-call limit %s the person chose on continuation',
  async (usd, atomic) => {
    await install();
    const out = await install(['--max-auto-spend', usd, '--session-budget', 'none']);
    expect(out.code).toBe(0);
    expect(out.config.router?.subagentConsent).toBeUndefined();
    const on = await install(['--subagents', 'on']);
    expectEnabled(on.config);
    expect(JSON.parse(on.output).data.subagents).toMatchObject({
      enabled: true,
      jobCapAtomic: atomic,
    });
    expect(on.config.maxAutoSpend).toBe(atomic);
    expect(on.config.sessionBudget).toBe('none');
  },
);

// The terms paragraph was in every receipt's disclosure, so it came back after Keep off
// and a second time after the question that held it.
it.each(['claude', 'codex'] as const)(
  'says the DeepSeek terms once after on, and not at all after off, on %s',
  async (host) => {
    const run = host === 'claude' ? runRouterInstall : runCodexInstall;
    const count = (text: string) => text.split(SUBAGENT_TERMS[0]!).length - 1;
    const said = async (subagents: 'on' | 'off') => {
      await rm(seams.data, { recursive: true, force: true });
      const out = await run({ yes: true, subagents }, testCtx(seams.data, { json: false }));
      const human = [...(out.humanLines ?? []), ...(out.humanTail ?? [])].join('\n');
      return count(human) + count(JSON.stringify(out.data));
    };
    // Once for a person and once in the data an agent reads.
    expect(await said('on')).toBe(2);
    expect(await said('off')).toBe(0);
  },
);

it.each(['claude', 'codex'] as const)(
  'supports the standalone %s installer entrypoint',
  async (host) => {
    const out = await (host === 'claude'
      ? runRouterInstall({ yes: true, subagents: 'on' }, testCtx(seams.data))
      : runCodexInstall({ yes: true, subagents: 'on' }, testCtx(seams.data)));
    expectEnabled(await loadRawConfig(seams.data));
    expect(out.data).toMatchObject({ subagents: { enabled: true, jobCapAtomic: '1000000' } });
  },
);

it.each([
  {},
  { router: { subagents: false } },
  { router: { subagents: true, subagentConsent: { version: 2, repositories: ['/kept'] } } },
])('keeps a preexisting profile choice without manufacturing a fresh claim: %j', async (config) => {
  await mkdir(seams.data);
  await persist(seams.data, () => config);
  const out = await install(['--yes']);
  expect(out.code).toBe(0);
  expect(out.config.router).toEqual(config.router);
  expect(out.config.install?.freshSetup).toBeUndefined();
});

// Review of b7974566: the flag was refused on every profile that already existed, so a
// scripted `install --yes --subagents off` failed on its second run, and a person who had
// passed the question could not reach the install's consent again.
it.each(['on', 'off'] as const)(
  'applies --subagents %s on a profile that already exists and has no answer saved',
  async (choice) => {
    await mkdir(seams.data);
    await persist(seams.data, () => ({ maxAutoSpend: '1000000' }));
    const out = await install(['--yes', '--subagents', choice]);
    expect(out.code).toBe(0);
    expect(out.config.router?.subagents).toBe(choice === 'on');
    if (choice === 'on') expectEnabled(out.config);
    else expect(out.config.router).toEqual({ subagents: false });
  },
);

it('a scripted --yes --subagents off succeeds on its second run, and a later on changes nothing', async () => {
  expect((await install(['--yes', '--subagents', 'off'])).code).toBe(0);
  const second = await install(['--yes', '--subagents', 'off']);
  expect(second.code).toBe(0);
  expect(second.config.router).toEqual({ subagents: false });
  expect(JSON.parse(second.output).data.subagents).toEqual({ enabled: false, changed: false });
  // Nothing turns subagents on over a saved off but the config command.
  const on = await install(['--yes', '--subagents', 'on']);
  expect(on.code).toBe(0);
  expect(on.config.router).toEqual({ subagents: false });
  expect(JSON.parse(on.output).data.subagents).toEqual({ enabled: false, changed: false });
});

it('does not enable after runtime failure or a failed second host', async () => {
  seams.failRuntime = true;
  expect((await install(['--yes', '--subagents', 'on'])).code).not.toBe(0);
  expect((await loadRawConfig(seams.data)).router?.subagentConsent).toBeUndefined();
  seams.failRuntime = false;
  seams.hosts = ['claude', 'codex'];
  seams.failCodex = true;
  expect((await install(['--yes', '--subagents', 'on'])).code).not.toBe(0);
  expect((await loadRawConfig(seams.data)).router?.subagentConsent).toBeUndefined();
});

it('preserves an explicit off written during native registration', async () => {
  seams.hosts = ['codex'];
  seams.turnOff = true;
  const out = await install(['--yes', '--subagents', 'on']);
  expect(out.code).toBe(0);
  expect(out.config.router).toEqual({ subagents: false });
  expect(out.config.install?.freshSetup).toBeUndefined();
  // The receipt says the answer changed nothing.
  expect(JSON.parse(out.output).data.subagents).toEqual({ enabled: false, changed: false });
});

it.each([
  undefined,
  null,
  [],
  1,
  { plugins: { [CODEX_PLUGIN]: { enabled: false } } },
  { marketplaces: { tenjin: { source: '/legacy' } } },
])('does not grant a fresh default from unknown or preexisting Codex state: %j', async (config) => {
  seams.hosts = ['codex'];
  seams.nativeConfig = config;
  const out = await install(['--yes']);
  expect(out.code).toBe(0);
  expect(out.config.router?.subagentConsent).toBeUndefined();
  expect(out.config.install?.freshSetup).toBeUndefined();
});

it('does not consume a pending claim on refresh', async () => {
  await install();
  const pending = (await loadRawConfig(seams.data)).install?.freshSetup;
  await install(['--refresh', '--harness', 'claude']);
  const config = await loadRawConfig(seams.data);
  expect(config.router?.subagentConsent).toBeUndefined();
  expect(config.install?.freshSetup).toEqual(pending);
});

it.each([
  ['claude', 'codex'],
  ['codex', 'claude'],
] as ('claude' | 'codex')[][])(
  'a preexisting host disqualifies a shared %j setup and its continuation',
  async (...hosts) => {
    seams.hosts = hosts;
    seams.nativeConfig = { plugins: { [CODEX_PLUGIN]: { enabled: false } } };
    const first = await install(['--yes']);
    expect(first.code).toBe(0);
    expect(first.config.router?.subagentConsent).toBeUndefined();
    expect(first.config.install?.freshSetup).toBeUndefined();
    const second = await install(['--yes']);
    expect(second.config.router?.subagentConsent).toBeUndefined();
  },
);
