import { beforeEach, expect, it, vi } from 'vitest';
import { qualifiedModelWorker, runModelWorker } from './model-worker';
import { qualifyNativeCodexWorker, runNativeCodexWorker } from './codex-native-worker';
import { query } from '@anthropic-ai/claude-agent-sdk/core';
import { readClaudeCode } from './claude-cli';
import type { ModelJob } from './model-job';
import type { ModelTransport } from './model-transport';
vi.mock('./codex-native-worker', () => ({
  qualifyNativeCodexWorker: vi.fn(),
  runNativeCodexWorker: vi.fn(),
}));
vi.mock('@anthropic-ai/claude-agent-sdk/core', () => ({
  query: vi.fn(),
  resolveSettings: vi.fn(),
}));
vi.mock('./claude-cli', () => ({ readClaudeCode: vi.fn(), meetsFloor: vi.fn() }));
const policy = { approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandbox: {} };
beforeEach(() => vi.clearAllMocks());
it('qualifies genuine Codex independently of Claude installation or permission settings', async () => {
  vi.mocked(qualifyNativeCodexWorker).mockResolvedValue({
    path: '/native/codex',
    instructionContext: {} as never,
    nativeSnapshot: {} as never,
  });
  expect(await qualifiedModelWorker('/repo', 'general-purpose', policy, '/data')).toMatchObject({
    path: '/native/codex',
  });
  expect(qualifyNativeCodexWorker).toHaveBeenCalledWith({
    cwd: '/repo',
    policy,
    dataDir: '/data',
    signal: undefined,
  });
  expect(readClaudeCode).not.toHaveBeenCalled();
  expect(query).not.toHaveBeenCalled();
});
it('an unsupported Codex authority stays native instead of silently using the Claude tool broker', async () => {
  vi.mocked(qualifyNativeCodexWorker).mockResolvedValue(null);
  expect(await qualifiedModelWorker('/repo', 'general-purpose', policy, '/data')).toBeNull();
  expect(readClaudeCode).not.toHaveBeenCalled();
});
it('executes an accepted Codex job only through the genuine native runner', async () => {
  vi.mocked(runNativeCodexWorker).mockResolvedValue('native completed result');
  const job = { id: 'owned', root: '/repo' } as ModelJob;
  const options = {
    dataDir: '/data',
    transport: {} as ModelTransport,
    signal: new AbortController().signal,
    codexPolicy: policy,
    permission: vi.fn(),
  };
  expect(await runModelWorker(job, options)).toBe('native completed result');
  expect(runNativeCodexWorker).toHaveBeenCalledWith(job, options);
  expect(query).not.toHaveBeenCalled();
  expect(readClaudeCode).not.toHaveBeenCalled();
});
it('does not start a native or SDK worker after cancellation', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    runModelWorker({} as ModelJob, {
      dataDir: '/data',
      transport: {} as ModelTransport,
      signal: controller.signal,
      codexPolicy: policy,
      permission: vi.fn(),
    }),
  ).rejects.toThrow();
  expect(runNativeCodexWorker).not.toHaveBeenCalled();
  expect(query).not.toHaveBeenCalled();
});
