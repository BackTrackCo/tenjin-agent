import { beforeEach, expect, it, vi } from 'vitest';
import { query, resolveSettings } from '@anthropic-ai/claude-agent-sdk/core';
import { readClaudeCode, meetsFloor } from './claude-cli';
import { qualifiedModelWorker, runModelWorker } from './model-worker';
import type { ModelJob } from './model-job';
import type { ModelTransport } from './model-transport';

vi.mock('@anthropic-ai/claude-agent-sdk/core', () => ({
  query: vi.fn(),
  resolveSettings: vi.fn(),
}));
vi.mock('./claude-cli', () => ({ readClaudeCode: vi.fn(), meetsFloor: vi.fn() }));
vi.mock('./agent-tools', () => ({ findDefinition: vi.fn(async () => null) }));
beforeEach(() => vi.clearAllMocks());

it('keeps an auto parent native when managed settings disable native auto mode', async () => {
  vi.mocked(readClaudeCode).mockResolvedValue({
    binary: { path: '/native/claude', source: 'path' },
    version: '2.1.325',
  } as never);
  vi.mocked(meetsFloor).mockReturnValue(true);
  vi.mocked(resolveSettings).mockResolvedValue({
    effective: { permissions: { disableAutoMode: 'disable' } },
  } as never);
  expect(
    await qualifiedModelWorker('/repo', 'general-purpose', undefined, '/data', undefined, 'auto'),
  ).toBeNull();
  expect(query).not.toHaveBeenCalled();
});

it('rejects a changed or unsupported Claude mode before querying a worker or provider', async () => {
  const job = {
    id: 'owned',
    root: '/repo',
    decision: { claudePermissionMode: 'auto' },
  } as unknown as ModelJob;
  const options = {
    dataDir: '/data',
    transport: {} as ModelTransport,
    signal: new AbortController().signal,
    claudePermissionMode: 'auto' as const,
    currentClaudePermissionMode: () => 'default',
    permission: vi.fn(),
  };
  await expect(runModelWorker(job, options)).rejects.toThrow(/changed/);
  expect(query).not.toHaveBeenCalled();
  expect(readClaudeCode).not.toHaveBeenCalled();
});
