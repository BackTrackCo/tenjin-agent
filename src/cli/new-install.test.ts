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
  expect(config.router).toMatchObject({
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
  });
  expect(config.router?.subagentConsent).not.toHaveProperty('repositories');
  expect(config.install?.pendingDeepSeekSetup).toBeUndefined();
}

it.each([['claude'], ['codex'], ['claude', 'codex']] as ('claude' | 'codex')[][])(
  'offers one explicit subagent choice after spending on %j',
  async (...hosts) => {
    seams.hosts = hosts;
    const first = await install();
    expect(first.code).toBe(0);
    expect(first.config.router?.subagents).not.toBe(true);
    expect(first.config.router?.subagentConsent).toBeUndefined();
    expect(first.config.install?.pendingDeepSeekSetup).toBeDefined();
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
        question: expect.stringContaining('Turn on DeepSeek subagents?'),
        options: [
          { id: 'off', recommended: true, command: expect.stringMatching(/ --subagents off$/) },
          { id: 'on', recommended: false, command: expect.stringMatching(/ --subagents on$/) },
        ],
      },
    ]);
    const optedIn = await install(['--subagents', 'on']);
    expect(optedIn.code).toBe(0);
    expectEnabled(optedIn.config);
    expect(optedIn.output).not.toContain('Turn on DeepSeek subagents?');
  },
);

it('saves off without consent and does not ask again on reinstall', async () => {
  const off = await install(['--yes', '--subagents', 'off']);
  expect(off.code).toBe(0);
  expect(off.config.router).toEqual({ subagents: false });
  expect(off.config.install?.pendingDeepSeekSetup).toBeUndefined();
  expect(JSON.parse(off.output).data.subagents).toEqual({ enabled: false });
  const repeated = await install();
  expect(repeated.config.router).toEqual({ subagents: false });
  expect(repeated.output).not.toContain('Turn on DeepSeek subagents?');
});

it('accepts custom limits on continuation without changing the DeepSeek job ceiling', async () => {
  await install();
  const out = await install(['--max-auto-spend', '0', '--session-budget', 'none']);
  expect(out.code).toBe(0);
  expect(out.config.router?.subagentConsent).toBeUndefined();
  expectEnabled((await install(['--subagents', 'on'])).config);
  expect(out.config.maxAutoSpend).toBe('0');
  expect(out.config.sessionBudget).toBe('none');
});

it.each(['claude', 'codex'] as const)(
  'supports the standalone %s installer entrypoint',
  async (host) => {
    const out = await (host === 'claude'
      ? runRouterInstall({ yes: true, subagents: 'on' }, testCtx(seams.data))
      : runCodexInstall({ yes: true, subagents: 'on' }, testCtx(seams.data)));
    expectEnabled(await loadRawConfig(seams.data));
    expect(out.data).toMatchObject({ subagents: { enabled: true, maxJobAtomic: '1000000' } });
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
  expect(out.config.install?.pendingDeepSeekSetup).toBeUndefined();
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
  expect(out.config.install?.pendingDeepSeekSetup).toBeUndefined();
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
  expect(out.config.install?.pendingDeepSeekSetup).toBeUndefined();
});

it('does not consume a pending claim on refresh', async () => {
  await install();
  const pending = (await loadRawConfig(seams.data)).install?.pendingDeepSeekSetup;
  await install(['--refresh', '--harness', 'claude']);
  const config = await loadRawConfig(seams.data);
  expect(config.router?.subagentConsent).toBeUndefined();
  expect(config.install?.pendingDeepSeekSetup).toEqual(pending);
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
    expect(first.config.install?.pendingDeepSeekSetup).toBeUndefined();
    const second = await install(['--yes']);
    expect(second.config.router?.subagentConsent).toBeUndefined();
  },
);
