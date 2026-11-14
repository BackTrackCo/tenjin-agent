import { beforeEach, expect, it, vi } from 'vitest';
import { query, resolveSettings } from '@anthropic-ai/claude-agent-sdk/core';
import { readClaudeCode, meetsFloor } from './claude-cli';
import { runModelWorker } from './model-worker';
import { workerStop } from './model-worker-control';
import type { ModelJob } from './model-job';
import type { ModelTransport } from './model-transport';

const native = vi.hoisted(() => ({ close: vi.fn(), bridgeClose: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk/core', () => ({
  query: vi.fn(),
  resolveSettings: vi.fn(),
}));
vi.mock('./claude-cli', () => ({ readClaudeCode: vi.fn(), meetsFloor: vi.fn() }));
vi.mock('./agent-tools', () => ({ findDefinition: vi.fn(async () => null) }));
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  realpath: async (path: unknown) => String(path),
}));
vi.mock('node:http', async (original) => ({
  ...(await original<typeof import('node:http')>()),
  createServer: () => ({
    once: vi.fn(),
    listen: (_port: number, _host: string, ready: () => void) => ready(),
    address: () => ({ port: 12345 }),
    closeAllConnections: vi.fn(),
    close: (done: () => void) => {
      native.bridgeClose();
      done();
    },
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readClaudeCode).mockResolvedValue({
    binary: { path: '/fixture/claude' },
    version: '2.1.325',
  } as never);
  vi.mocked(meetsFloor).mockReturnValue(true);
  vi.mocked(resolveSettings).mockResolvedValue({ effective: {} } as never);
});

const job = {
  id: 'owned',
  root: '/repo',
  native: {},
  task: 'Check the selected function.',
  decision: { claudePermissionMode: 'default' },
} as unknown as ModelJob;
const options = () => ({
  dataDir: '/data',
  transport: {} as ModelTransport,
  signal: new AbortController().signal,
  claudePermissionMode: 'default' as const,
  currentClaudePermissionMode: () => 'default',
  permission: vi.fn(async () => false),
});
function sdkResult(result: Record<string, unknown>) {
  vi.mocked(query).mockReturnValue({
    async *[Symbol.asyncIterator]() {
      yield { type: 'system', subtype: 'init', permissionMode: 'default' };
      yield { type: 'result', ...result };
    },
    mcpServerStatus: async () => [],
    close: native.close,
  } as unknown as ReturnType<typeof query>);
}

it('uses the native emergency guard beyond the old forty-turn cutoff while retaining its evaluated model profile', async () => {
  sdkResult({ subtype: 'success', result: 'finished after 114 turns', num_turns: 114 });
  expect(await runModelWorker(job, options())).toBe('finished after 114 turns');
  const call = vi.mocked(query).mock.calls[0]![0];
  expect(call.options).toMatchObject({
    maxTurns: 500,
    effort: 'high',
    model: 'deepseek-flash[1m]',
    cwd: '/repo',
    persistSession: false,
  });
  expect(call.options?.settings).toMatchObject({
    env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '786432' },
  });
  expect(native.close).toHaveBeenCalled();
  expect(native.bridgeClose).toHaveBeenCalled();
});

it('routes successful and failed identical calls through soft native hook context without changing permissions or outputs', async () => {
  sdkResult({ subtype: 'success', result: 'done', num_turns: 1 });
  await runModelWorker(job, options());
  const hooks = vi.mocked(query).mock.calls[0]![0].options?.hooks;
  const success = hooks?.PostToolUse?.[0]?.hooks[0];
  const failure = hooks?.PostToolUseFailure?.[0]?.hooks[0];
  expect(success).toBeTypeOf('function');
  expect(failure).toBeTypeOf('function');
  const contexts = [];
  for (let i = 1; i <= 8; i++) {
    const failed = i % 2 === 0;
    const hook = failed ? failure! : success!;
    contexts.push(
      await hook(
        {
          hook_event_name: failed ? 'PostToolUseFailure' : 'PostToolUse',
          tool_name: 'Read',
          tool_input: i % 2 ? { path: 'a', offset: 1 } : { offset: 1, path: 'a' },
          tool_use_id: `call-${i}`,
        } as never,
        undefined,
        { signal: new AbortController().signal },
      ),
    );
  }
  expect(
    contexts.map((value, i) => ('hookSpecificOutput' in value ? i + 1 : null)).filter(Boolean),
  ).toEqual([3, 5, 8]);
  for (const value of contexts) {
    expect(JSON.stringify(value)).not.toMatch(
      /permissionDecision|updatedToolOutput|classifierContext/,
    );
  }
});

it('keeps native turn-limit diagnostics separate from model capability and never exposes SDK error text', async () => {
  sdkResult({
    subtype: 'error_max_turns',
    num_turns: 500,
    errors: ['secret-key=private'],
    stop_reason: 'max_turns',
  });
  const error = await runModelWorker(job, options()).catch((error: unknown) => error);
  expect(workerStop(error)).toEqual({ kind: 'harness_limit', reason: 'turn_guard', turns: 500 });
  expect(JSON.stringify(error)).not.toContain('secret-key');
  expect(native.close).toHaveBeenCalled();
  expect(native.bridgeClose).toHaveBeenCalled();
});
