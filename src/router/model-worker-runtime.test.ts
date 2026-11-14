import { beforeEach, expect, it, vi } from 'vitest';
import { query, resolveSettings } from '@anthropic-ai/claude-agent-sdk/core';
import { getSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import { readClaudeCode, meetsFloor } from './claude-cli';
import { runModelWorker } from './model-worker';
import { workerStop } from './model-worker-control';
import type { ModelJob } from './model-job';
import type { ModelTransport } from './model-transport';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const native = vi.hoisted(() => ({ close: vi.fn(), bridgeClose: vi.fn(), createServer: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk/core', () => ({
  query: vi.fn(),
  resolveSettings: vi.fn(),
}));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ getSessionInfo: vi.fn() }));
vi.mock('./claude-cli', () => ({ readClaudeCode: vi.fn(), meetsFloor: vi.fn() }));
vi.mock('./agent-tools', () => ({ findDefinition: vi.fn(async () => null) }));
vi.mock('./model-settings', () => ({ modelSettings: vi.fn(async () => ({})) }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  realpath: async (path: unknown) => String(path),
}));
vi.mock('node:http', async (original) => ({
  ...(await original<typeof import('node:http')>()),
  createServer: (handle: unknown) => {
    native.createServer(handle);
    return {
      once: vi.fn(),
      listen: (_port: number, _host: string, ready: () => void) => ready(),
      address: () => ({ port: 12345 }),
      closeAllConnections: vi.fn(),
      close: (done: () => void) => {
        native.bridgeClose();
        done();
      },
    };
  },
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
function sdkResult(result: Record<string, unknown>, sessionId?: string) {
  vi.mocked(query).mockReturnValue({
    async *[Symbol.asyncIterator]() {
      yield {
        type: 'system',
        subtype: 'init',
        permissionMode: 'default',
        cwd: '/repo',
        session_id: sessionId,
      };
      yield { type: 'result', session_id: sessionId, ...result };
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

it('persists and resumes an exact owned SDK identity without changing the string result contract', async () => {
  const sessionId = '11111111-2222-4333-8444-555555555555';
  const observed = vi.fn(async () => {});
  sdkResult({ subtype: 'success', result: 'first result' }, sessionId);
  await expect(
    runModelWorker(job, {
      ...options(),
      claudeSession: { sessionId, onSession: observed },
    }),
  ).resolves.toBe('first result');
  expect(vi.mocked(query).mock.calls[0]![0].options).toMatchObject({
    persistSession: true,
    sessionId,
    systemPrompt: { type: 'preset', preset: 'claude_code' },
  });
  expect(observed).toHaveBeenCalledWith(sessionId);
  vi.mocked(getSessionInfo).mockResolvedValue({ sessionId, cwd: '/repo' } as never);
  sdkResult({ subtype: 'success', result: 'continued result' }, sessionId);
  await expect(
    runModelWorker(
      { ...job, task: 'Continue the selected check.' },
      {
        ...options(),
        claudeSession: { resume: sessionId, onSession: observed },
      },
    ),
  ).resolves.toBe('continued result');
  const resumed = vi.mocked(query).mock.calls[1]![0];
  expect(resumed.prompt).toBe('Continue the selected check.');
  expect(resumed.options).toMatchObject({ persistSession: true, resume: sessionId, maxTurns: 500 });
  expect(resumed.options).not.toHaveProperty('sessionId');
});

it('never dispatches a missing-history resume or binds a foreign SDK session', async () => {
  const sessionId = '11111111-2222-4333-8444-555555555555';
  const onSession = vi.fn(async () => {});
  vi.mocked(getSessionInfo).mockResolvedValue(undefined);
  await expect(
    runModelWorker(job, {
      ...options(),
      claudeSession: { resume: sessionId, onSession },
    }),
  ).rejects.toThrow(/history is missing/);
  expect(query).not.toHaveBeenCalled();
  expect(native.bridgeClose).not.toHaveBeenCalled();
  sdkResult({ subtype: 'success', result: 'foreign' }, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  await expect(
    runModelWorker(job, {
      ...options(),
      claudeSession: { sessionId, onSession },
    }),
  ).rejects.toThrow(/session/);
  expect(onSession).not.toHaveBeenCalled();
  expect(native.close).toHaveBeenCalled();
});

it('drains the native process when the owned session cannot be recorded', async () => {
  const sessionId = '11111111-2222-4333-8444-555555555555';
  sdkResult({ subtype: 'success', result: 'not safe to report' }, sessionId);
  await expect(
    runModelWorker(job, {
      ...options(),
      claudeSession: {
        sessionId,
        onSession: async () => {
          throw new Error('Store unavailable');
        },
      },
    }),
  ).rejects.toThrow(/Store unavailable/);
  expect(native.close).toHaveBeenCalled();
  expect(native.bridgeClose).toHaveBeenCalled();
});

it('admits no inference until the owned session observer has durably accepted the native identity', async () => {
  const sessionId = '11111111-2222-4333-8444-555555555555';
  let startBinding!: () => void;
  let finishBinding!: () => void;
  const bindingStarted = new Promise<void>((resolve) => {
    startBinding = resolve;
  });
  const bindingFinished = new Promise<void>((resolve) => {
    finishBinding = resolve;
  });
  const messages = vi.fn(async () => ({ fixture: true }));
  vi.mocked(query).mockImplementation((call) => {
    let complete!: () => void;
    const responseComplete = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const handle = native.createServer.mock.calls[0]![0] as (
      request: unknown,
      response: unknown,
    ) => void;
    const response = {
      headersSent: false,
      destroyed: false,
      writeHead() {
        this.headersSent = true;
        return this;
      },
      end(_body: string, done?: () => void) {
        done?.();
        complete();
        return this;
      },
    };
    handle(
      {
        method: 'POST',
        url: '/v1/messages',
        headers: { 'x-api-key': call.options?.env?.ANTHROPIC_API_KEY },
        async *[Symbol.asyncIterator]() {
          yield Buffer.from(
            JSON.stringify({ model: 'deepseek-flash', messages: [], max_tokens: 32000 }),
          );
        },
      },
      response,
    );
    return {
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'system',
          subtype: 'init',
          permissionMode: 'default',
          cwd: '/repo',
          session_id: sessionId,
        };
        await responseComplete;
        yield { type: 'result', subtype: 'success', session_id: sessionId, result: 'done' };
      },
      mcpServerStatus: async () => [],
      close: native.close,
    } as unknown as ReturnType<typeof query>;
  });
  const run = runModelWorker(job, {
    ...options(),
    transport: { messages } as unknown as ModelTransport,
    claudeSession: {
      sessionId,
      onSession: async () => {
        startBinding();
        await bindingFinished;
      },
    },
  });
  await bindingStarted;
  expect(messages).not.toHaveBeenCalled();
  finishBinding();
  await expect(run).resolves.toBe('done');
  expect(messages).toHaveBeenCalledOnce();
});

it('does not return a completed worker while its native process has exited but stdio is still draining', async () => {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 42,
    exitCode: 0,
    signalCode: null,
    killed: false,
    kill: vi.fn(() => true),
  });
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  let sdkCleanup!: () => void;
  const cleanup = new Promise<void>((resolve) => {
    sdkCleanup = resolve;
  });
  vi.mocked(query).mockImplementation((call) => {
    call.options?.spawnClaudeCodeProcess?.({
      command: '/fixture/claude',
      args: ['--fixture'],
      cwd: '/repo',
      env: {},
      signal: new AbortController().signal,
    });
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init', permissionMode: 'default' };
        yield { type: 'result', subtype: 'success', result: 'done' };
      },
      mcpServerStatus: async () => [],
      close: native.close,
      return: async () => {
        sdkCleanup();
        return { done: true };
      },
    } as unknown as ReturnType<typeof query>;
  });
  let returned = false;
  const run = runModelWorker(job, options()).then((value) => {
    returned = true;
    return value;
  });
  await cleanup;
  child.emit('exit', 0, null);
  await Promise.resolve();
  expect(returned).toBe(false);
  child.emit('close', 0, null);
  await expect(run).resolves.toBe('done');
  expect(returned).toBe(true);
});

it.each([
  { subtype: 'error_max_turns', reason: 'turn_guard' },
  { subtype: 'error_max_budget_usd', reason: 'budget_guard' },
  { subtype: 'success', reason: undefined },
])(
  'preserves $subtype after a confirmed signalled close without accepting a clean result from a bad exit',
  async ({ subtype, reason }) => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      pid: 42,
      exitCode: null,
      signalCode: 'SIGTERM',
      killed: false,
      kill: vi.fn(() => true),
    });
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    vi.mocked(query).mockImplementation((call) => {
      call.options?.spawnClaudeCodeProcess?.({
        command: '/fixture/claude',
        args: ['--fixture'],
        cwd: '/repo',
        env: {},
        signal: new AbortController().signal,
      });
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'system', subtype: 'init', permissionMode: 'default' };
          yield { type: 'result', subtype, result: 'not a confirmed success', num_turns: 500 };
        },
        mcpServerStatus: async () => [],
        close: native.close,
        return: async () => {
          child.emit('close', null, 'SIGTERM');
          return { done: true };
        },
      } as unknown as ReturnType<typeof query>;
    });
    const error = await runModelWorker(job, options()).catch((error) => error);
    if (reason) expect(workerStop(error)).toMatchObject({ kind: 'harness_limit', reason });
    else {
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain('did not close successfully');
    }
  },
);

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
