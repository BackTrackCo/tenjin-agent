import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runModelWorker } from './model-worker';
import { query, resolveSettings } from '@anthropic-ai/claude-agent-sdk/core';
import { readClaudeCodeCached, meetsFloor } from './claude-cli';
import { modelSettings } from './model-settings';
import type { ModelJob } from './model-job';
import type { ModelTransport } from './model-transport';
vi.mock('@anthropic-ai/claude-agent-sdk/core', () => ({
  query: vi.fn(),
  resolveSettings: vi.fn(),
}));
vi.mock('./claude-cli', () => ({ readClaudeCodeCached: vi.fn(), meetsFloor: vi.fn() }));
vi.mock('./agent-tools', async (original) => ({
  ...(await original<typeof import('./agent-tools')>()),
  findDefinition: vi.fn(async () => null),
}));
vi.mock('./model-settings', async (original) => ({
  ...(await original<typeof import('./model-settings')>()),
  modelSettings: vi.fn(),
}));
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.useRealTimers());
it.each([
  'CLAUDE_CODE_REMOTE',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'ANTHROPIC_UNIX_SOCKET',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_GATEWAY',
])('refuses settings-supplied host auth before disclosure or SDK work: %s', async (key) => {
  vi.mocked(readClaudeCodeCached).mockResolvedValue({
    binary: { path: '/native/claude' },
    version: '2.1.325',
  } as never);
  vi.mocked(meetsFloor).mockReturnValue(true);
  vi.mocked(resolveSettings).mockResolvedValue({ effective: { env: { [key]: 'bound' } } } as never);
  const messages = vi.fn();
  const job = {
    id: 'owned',
    root: '/repo',
    native: { subagent_type: 'general-purpose' },
    decision: { claudePermissionMode: 'default' },
  } as unknown as ModelJob;
  await expect(
    runModelWorker(job, {
      dataDir: '/data',
      transport: { messages } as unknown as ModelTransport,
      signal: new AbortController().signal,
      claudePermissionMode: 'default',
      currentClaudePermissionMode: () => 'default',
      permission: vi.fn(),
    }),
  ).rejects.toThrow(/unavailable/);
  expect(modelSettings).not.toHaveBeenCalled();
  expect(query).not.toHaveBeenCalled();
  expect(messages).not.toHaveBeenCalled();
});
it('does not start a worker after cancellation', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    runModelWorker({} as ModelJob, {
      dataDir: '/data',
      transport: {} as ModelTransport,
      signal: controller.signal,
      permission: vi.fn(),
    }),
  ).rejects.toThrow();
  expect(query).not.toHaveBeenCalled();
});

it('keeps managed mandatory auto memory native before SDK or transport work', async () => {
  vi.mocked(readClaudeCodeCached).mockResolvedValue({
    binary: { path: '/native/claude' },
    version: '2.1.325',
  } as never);
  vi.mocked(meetsFloor).mockReturnValue(true);
  vi.mocked(resolveSettings).mockResolvedValue({
    effective: { autoMemoryEnabled: true },
    sources: [{ source: 'managed', settings: { autoMemoryEnabled: true } }],
  } as never);
  const messages = vi.fn();
  await expect(
    runModelWorker(
      {
        id: 'owned',
        root: '/repo',
        native: {},
        decision: { claudePermissionMode: 'default' },
      } as unknown as ModelJob,
      {
        dataDir: '/data',
        transport: { messages } as unknown as ModelTransport,
        signal: new AbortController().signal,
        claudePermissionMode: 'default',
        currentClaudePermissionMode: () => 'default',
        permission: vi.fn(),
      },
    ),
  ).rejects.toThrow(/unavailable/);
  expect(modelSettings).not.toHaveBeenCalled();
  expect(query).not.toHaveBeenCalled();
  expect(messages).not.toHaveBeenCalled();
});
