import type { Stats } from 'node:fs';
import { access, lstat, realpath, stat } from 'node:fs/promises';
import { win32 } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadRawConfig } from '../lib/config';
import { nativeWorkspaceModelConsent } from './model-settings';
import {
  loadWindowsWorkerConfig,
  validateWindowsWorkerConfig,
  type WindowsWorkerConfig,
} from './windows-worker-config';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  access: vi.fn(),
  lstat: vi.fn(),
  realpath: vi.fn(),
  stat: vi.fn(),
}));
vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  homedir: () => 'C:\\Controller',
}));
vi.mock('../lib/config', async (original) => ({
  ...(await original<typeof import('../lib/config')>()),
  loadRawConfig: vi.fn(),
}));

const controllerData = 'C:\\Controller\\.tenjin';
const launcherPath = 'C:\\Shared\\tenjin.exe';
const claudePath = 'D:\\Claude\\claude.exe';
const configDir = 'C:\\Shared\\ClaudeProfile';
const record: WindowsWorkerConfig = {
  version: 1,
  workerSid: 'S-1-5-21-123-456-789-1011',
  launcherPath,
  claudePath,
  configDir,
  routerOrigin: 'https://tenjin.test',
  shellAccess: 'native-windows',
};
const consent = nativeWorkspaceModelConsent({ routerOrigin: record.routerOrigin });

describe('native Windows worker opt-in', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    vi.stubEnv('CLAUDE_CONFIG_DIR', 'C:\\Controller\\.claude');
    vi.resetAllMocks();
    vi.mocked(realpath).mockImplementation(async (path) => win32.normalize(String(path)));
    vi.mocked(stat).mockImplementation(
      async (path) =>
        ({
          isFile: () => win32.extname(String(path)).toLowerCase() === '.exe',
          isDirectory: () => win32.extname(String(path)) === '',
        }) as Stats,
    );
    vi.mocked(access).mockResolvedValue(undefined);
    vi.mocked(lstat).mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', platform);
    vi.unstubAllEnvs();
  });

  it('does not activate Windows from the ordinary install or an obsolete or revoked grant', async () => {
    for (const router of [
      { subagents: true, subagentConsent: consent },
      { subagents: false, subagentConsent: consent, windowsWorker: record },
      { subagents: true, subagentConsent: consent, windowsWorker: { ...record, version: 0 } },
      {
        subagents: true,
        subagentConsent: consent,
        windowsWorker: { ...record, routerOrigin: 'invalid' },
      },
      {
        subagents: true,
        subagentConsent: { ...consent, routerOrigin: 'https://changed.test' },
        windowsWorker: record,
      },
    ]) {
      vi.mocked(loadRawConfig).mockResolvedValue({ router });
      expect(await loadWindowsWorkerConfig(controllerData)).toBeNull();
    }
    expect(access).not.toHaveBeenCalled();
  });

  it('loads a current grant and rejects a path that started resolving to a different executable', async () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', configDir);
    vi.mocked(loadRawConfig).mockResolvedValue({
      router: { subagents: true, subagentConsent: consent, windowsWorker: record },
    });
    expect(await loadWindowsWorkerConfig(controllerData)).toEqual(record);
    vi.mocked(realpath).mockImplementation(async (path) =>
      path === launcherPath ? 'C:\\Shared\\different.exe' : win32.normalize(String(path)),
    );
    expect(await loadWindowsWorkerConfig(controllerData)).toBeNull();
  });

  it.each([
    { launcherPath: 'tenjin.exe' },
    { launcherPath: '\\\\server\\tools\\tenjin.exe' },
    { launcherPath: 'C:\\Shared\\launcher.cmd' },
    { launcherPath: 'C:\\Controller\\.tenjin\\launcher.exe' },
    { claudePath: 'c:\\shared\\TENJIN.EXE' },
    { configDir: 'c:\\controller' },
    { configDir: 'C:\\Controller\\.claude' },
  ])('rejects incomplete or incompatible paths %j', async (change) => {
    expect(await validateWindowsWorkerConfig({ ...record, ...change }, controllerData)).toBeNull();
  });

  it('rejects inaccessible assets and a shared profile with a login credential file', async () => {
    vi.mocked(access).mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }));
    expect(await validateWindowsWorkerConfig(record, controllerData)).toBeNull();
    vi.mocked(lstat).mockResolvedValueOnce({} as Stats);
    expect(await validateWindowsWorkerConfig(record, controllerData)).toBeNull();
  });
});
