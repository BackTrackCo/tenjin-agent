import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { qualifiedModelWorker, runModelWorker } from './model-worker';
import { qualifyNativeCodexWorker, runNativeCodexWorker } from './codex-native-worker';
import { query, resolveSettings } from '@anthropic-ai/claude-agent-sdk/core';
import { readClaudeCodeCached, meetsFloor } from './claude-cli';
import { modelSettings } from './model-settings';
import type { ModelJob } from './model-job';
import type { ModelTransport } from './model-transport';
import { workerStop } from './model-worker-control';
vi.mock('./codex-native-worker', () => ({
  qualifyNativeCodexWorker: vi.fn(),
  runNativeCodexWorker: vi.fn(),
}));
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
const policy = { approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandbox: {} };
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
it('qualifies genuine Codex independently of Claude installation or permission settings', async () => {
  vi.mocked(qualifyNativeCodexWorker).mockResolvedValue({
    path: '/native/codex',
    instructionContext: {} as never,
    nativeSnapshot: {} as never,
    disclosureRepositories: ['/repo'],
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
  expect(readClaudeCodeCached).not.toHaveBeenCalled();
  expect(query).not.toHaveBeenCalled();
});
it('an unsupported Codex authority stays native instead of silently using the Claude tool broker', async () => {
  vi.mocked(qualifyNativeCodexWorker).mockResolvedValue(null);
  expect(await qualifiedModelWorker('/repo', 'general-purpose', policy, '/data')).toBeNull();
  expect(readClaudeCodeCached).not.toHaveBeenCalled();
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
  const { permission, ...rest } = options;
  expect(runNativeCodexWorker).toHaveBeenCalledWith(
    job,
    expect.objectContaining({
      ...rest,
      signal: expect.any(AbortSignal),
      permission: expect.any(Function),
    }),
  );
  // Codex keeps no job-wide allow: a person's answer allows this one call only.
  const passed = vi.mocked(runNativeCodexWorker).mock.calls.at(-1)![1].permission;
  permission.mockResolvedValueOnce('job');
  expect(await passed('Bash', {}, new AbortController().signal)).toBe(true);
  permission.mockResolvedValueOnce(false);
  expect(await passed('Bash', {}, new AbortController().signal)).toBe(false);
  expect(query).not.toHaveBeenCalled();
  expect(readClaudeCodeCached).not.toHaveBeenCalled();
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

it('applies the shared wall guard to an accepted native Codex worker', async () => {
  vi.useFakeTimers();
  let nativeSignal: AbortSignal | undefined;
  vi.mocked(runNativeCodexWorker).mockImplementation(async (_job, options) => {
    nativeSignal = options.signal;
    await new Promise<void>((resolve) =>
      options.signal.addEventListener('abort', () => resolve(), { once: true }),
    );
    throw options.signal.reason;
  });
  const run = runModelWorker({ id: 'owned', root: '/repo' } as ModelJob, {
    dataDir: '/data',
    transport: {} as ModelTransport,
    signal: new AbortController().signal,
    codexPolicy: policy,
    permission: vi.fn(),
  });
  const outcome = run.catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(39 * 60 * 1000);
  expect(nativeSignal?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(60 * 1000);
  expect(workerStop(await outcome)).toEqual({ kind: 'harness_limit', reason: 'wall_time' });
  expect(nativeSignal?.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
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
