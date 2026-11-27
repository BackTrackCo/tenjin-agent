import { mkdir, mkdtemp, readFile, realpath, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { persist } from '../commands/config';
import { loadConfig, loadRawConfig } from '../lib/config';
import { ModelHandoff, type ModelSession } from './model-handoff';
import { modelSettings } from './model-settings';
import type { ModelTransport } from './model-transport';
import { routerSettings } from './settings';

// A person who turned DeepSeek subagents on with an earlier build still has the setting and
// its consent in config.json. This build never reads them: it holds no Agent call, makes no
// offer, charges nothing, fails nowhere and leaves the file as it is. This test uses the real
// reader, never the saved-consent stand-in of the offer tests.
let dir: string;
let repo: string;
let before: string;
const saved = {
  enabled: true,
  subagents: true,
  subagentConsent: {
    version: 2,
    instructions: 'applicable',
    reads: 'claude-home',
    recipients: ['Tenjin', 'DeepSeek', 'Exa'],
    routerOrigin: 'http://localhost:3939',
    maxJobAtomic: '1000000',
  },
  windowsWorker: { version: 1, shellAccess: 'native-windows' },
};
const file = () => join(dir, 'config.json');

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'saved-subagents-')));
  repo = join(dir, 'repo');
  await mkdir(join(repo, '.git'), { recursive: true });
  before = JSON.stringify({ router: saved }, null, 2) + '\n';
  await writeFile(file(), before);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

it('loads a saved subagent setting and consent without an error, and reads neither', async () => {
  await expect(loadRawConfig(dir)).resolves.toMatchObject({ router: saved });
  const config = await loadConfig(dir);
  expect(config.router).toEqual({ enabled: true, context: 'session', improve: false });
  const settings = await routerSettings({ cwd: repo, dataDir: dir });
  expect(settings).not.toHaveProperty('subagents');
  expect(await modelSettings(dir, repo)).toBeNull();
  expect(await readFile(file(), 'utf8')).toBe(before);
});

it('holds no Agent call and makes no offer, so nothing is sent or charged', async () => {
  const route = vi.fn();
  const model = new ModelHandoff({
    dataDir: dir,
    transport: { origin: 'http://localhost:3939', route } as unknown as ModelTransport,
  });
  const session: ModelSession = {
    sessionId: 'saved-setting',
    turnId: 'turn',
    cwd: repo,
    transcript: '',
    claudePermissionMode: 'default',
  };
  const call = {
    description: 'Read the selected file',
    prompt: 'Read src/example.ts and report the exported names verbatim.',
    subagent_type: 'general-purpose',
  };
  for (const tool of ['Agent', 'Task'] as const)
    expect(await model.capture(session, `call-${tool}`, call, undefined, tool)).toEqual({
      action: 'native',
    });
  expect(route).not.toHaveBeenCalled();
  // No held call and no job record: only a diagnostic note of why a call got no offer may exist.
  const records = await readdir(join(dir, 'model-jobs')).catch(() => [] as string[]);
  expect(records.filter((name) => /^(call-.*|[0-9a-f-]{36})\.json$/.test(name))).toEqual([]);
  expect(await readFile(file(), 'utf8')).toBe(before);
});

it('keeps the saved setting and consent through a change of another setting', async () => {
  await persist(dir, (config) => ({ ...config, maxAutoSpend: '250000' }));
  const after = await loadRawConfig(dir);
  expect(after.maxAutoSpend).toBe('250000');
  expect(after.router).toMatchObject(saved);
});
