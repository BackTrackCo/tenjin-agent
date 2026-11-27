import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { main } from '../cli';
import { captureIo } from '../context-test-utils';
import { loadRawConfig } from '../lib/config';
import type { RuntimeSetup } from '../lib/runtime';

// What a person meets on a fresh setup and in `tenjin config`: no subagent question, no
// subagent command. Real core, host installers, config locks, registration files and receipts.
// Only native processes, runtime download, wallet and network are seams.
const seams = vi.hoisted(() => ({
  home: '',
  work: '',
  cfg: '',
  data: '',
  hosts: ['claude'] as ('claude' | 'codex')[],
  nativeConfig: {} as unknown,
  failRuntime: false,
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
        run: async () => ({ code: 0, stdout: '{}', stderr: '' }),
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
async function run(args: string[]) {
  const captured = captureIo();
  const code = await main(args, captured.io);
  return { code, stdout: captured.stdout(), stderr: captured.stderr() };
}
async function install(args: string[] = []) {
  const out = await run(['install', ...args]);
  return { ...out, config: await loadRawConfig(seams.data) };
}
const receipts = (output: string) => {
  const { data } = JSON.parse(output);
  return (data.hosts ? data.hosts.map((host: string) => data[host]) : [data]) as {
    nextSteps?: { id: string }[];
  }[];
};

it.each([[['claude']], [['claude', 'codex']]] as ('claude' | 'codex')[][][])(
  'a fresh setup on %j asks no subagent question and saves no subagent setting',
  async (hosts) => {
    seams.hosts = hosts;
    for (const args of [[], ['--yes']]) {
      const out = await install(args);
      expect(out.code).toBe(0);
      for (const receipt of receipts(out.stdout))
        expect(receipt.nextSteps?.map(({ id }) => id) ?? []).not.toContain('subagents');
      expect(out.stdout).not.toMatch(/cheap model|DeepSeek|--subagents/i);
      expect(out.config.router ?? {}).not.toHaveProperty('subagents');
      expect(out.config.router ?? {}).not.toHaveProperty('subagentConsent');
      expect(out.config.install ?? {}).not.toHaveProperty('freshSetup');
    }
  },
);

it('refuses `tenjin install --subagents`: the flag is gone', async () => {
  const out = await install(['--yes', '--subagents', 'on']);
  expect(out.code).not.toBe(0);
  expect(out.stderr + out.stdout).toMatch(/unknown option/i);
  expect(out.config.router ?? {}).not.toHaveProperty('subagents');
});

it('`tenjin config subagents` is gone from the help and from the commands', async () => {
  const help = await run(['config', '--help']);
  expect(help.code).toBe(0);
  expect(help.stdout).not.toMatch(/subagent/i);
  const gone = await run(['config', 'subagents', 'on']);
  expect(gone.code).not.toBe(0);
  expect((await run(['install', '--help'])).stdout).not.toMatch(/subagent/i);
});

it('an install and a config change leave a saved subagent setting and its consent in the file', async () => {
  const saved = {
    enabled: true,
    subagents: true,
    subagentConsent: {
      version: 2,
      instructions: 'applicable',
      reads: 'claude-home',
      recipients: ['Tenjin', 'DeepSeek', 'Exa'],
      routerOrigin: 'https://tenjin.sh',
      repositories: ['/somewhere/else'],
      maxJobAtomic: '500000',
    },
    windowsWorker: { version: 1 },
  };
  await mkdir(seams.data, { recursive: true });
  await writeFile(join(seams.data, 'config.json'), JSON.stringify({ router: saved }));
  expect((await install(['--yes'])).code).toBe(0);
  expect((await run(['config', 'set', 'router.context', 'turn'])).code).toBe(0);
  const router = JSON.parse(await readFile(join(seams.data, 'config.json'), 'utf8')).router;
  expect(router).toMatchObject({ ...saved, context: 'turn' });
});
