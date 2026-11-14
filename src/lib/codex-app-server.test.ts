import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { codexAppServerVersion, withAppServer } from './codex-app-server';
import { isQualifiedCodexModelVersion } from './codex-model-version';

it.each([
  'tenjin/0.163.0 (Mac OS26.5.2;arm64)',
  'Codex Desktop/0.163.0 (Mac OS26.5.2;arm64) dumb (tenjin;1)',
])('recognizes the qualified server version with host originator %s', (agent) => {
  expect(codexAppServerVersion(agent)).toBe('0.163.0');
});

it('preserves the complete qualified Desktop prerelease version', () => {
  const version = codexAppServerVersion('Codex Desktop/0.167.0-alpha.4.1 (Mac OS; arm64)');
  expect(version).toBe('0.167.0-alpha.4.1');
  expect(isQualifiedCodexModelVersion(version)).toBe(true);
});

it.each([
  '0.167.0',
  '0.167.0-alpha.4',
  '0.167.0-alpha.4.2',
  '0.167.0-alpha.4.1-dev',
  '0.163.1',
  '0.163.0+build',
])('keeps an unqualified build native: %s', (version) => {
  expect(isQualifiedCodexModelVersion(version)).toBe(false);
});

it.each([
  'Codex Desktop/0.157.1 (tenjin/0.163.0)',
  'Codex Desktop/0.157.1-dev (tenjin/0.163.0)',
  'Codex Desktop/0.157.1-dev tenjin/0.163.0',
  'Codex Desktop/0.163.0-dev',
  'missing version',
  undefined,
])('does not qualify a mismatched or missing first product version: %s', (agent) => {
  expect(codexAppServerVersion(agent)).not.toBe('0.163.0');
});

function fixture({ closeOnEnd = true, closeOnKill = true } = {}) {
  const child = new EventEmitter();
  const stdout = new PassThrough();
  const sent: Record<string, unknown>[] = [];
  const emit = (message: unknown) => stdout.write(`${JSON.stringify(message)}\n`);
  let ended = false;
  const close = (code = 0) => {
    if (ended) return;
    ended = true;
    child.emit('exit', code, null);
    child.emit('close', code, null);
  };
  const stdin = new Writable({
    write(chunk, _encoding, done) {
      const message = JSON.parse(String(chunk)) as Record<string, unknown>;
      sent.push(message);
      if (message.method === 'initialize')
        queueMicrotask(() =>
          emit({ id: message.id, result: { userAgent: 'tenjin/0.167.0-alpha.4.1' } }),
        );
      done();
    },
    final(done) {
      done();
      if (closeOnEnd) queueMicrotask(() => close());
    },
  });
  const kill = vi.fn(() => {
    if (closeOnKill) queueMicrotask(() => close(1));
    return true;
  });
  Object.assign(child, { stdin, stdout, kill });
  const spawnChild = vi.fn(() => child) as unknown as typeof spawn;
  return { child, stdin, stdout, sent, emit, close, kill, spawnChild };
}

const nativeEnv = { CODEX_APP_RUNTIME_CLI_PATH: process.execPath, PATH: '' };

describe('owned Codex app-server lifecycle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('delivers native notifications without mistaking them for RPC responses', async () => {
    const server = fixture();
    const seen: unknown[] = [];
    const pending = withAppServer(
      '/home/test',
      nativeEnv,
      100,
      async () => {
        server.emit({
          method: 'turn/completed',
          params: { threadId: 'owned', turn: { status: 'completed' } },
        });
        return 'done';
      },
      {
        spawn: server.spawnChild,
        onNotification: (method, params) => {
          seen.push({ method, params });
        },
      },
    );
    await vi.runAllTimersAsync();
    expect(await pending).toBe('done');
    expect(seen).toEqual([
      { method: 'turn/completed', params: { threadId: 'owned', turn: { status: 'completed' } } },
    ]);
  });

  it('orders and drains asynchronous notifications before normal closure', async () => {
    const server = fixture();
    const seen: number[] = [];
    let release!: () => void;
    let began!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    const onExit = vi.fn();
    const pending = withAppServer(
      '/home/test',
      nativeEnv,
      100,
      async () => {
        server.emit({ method: 'progress', params: 1 });
        server.emit({ method: 'progress', params: 2 });
        return 'complete';
      },
      {
        spawn: server.spawnChild,
        onExit,
        onNotification: async (_method, params) => {
          seen.push(params as number);
          if (params === 1) {
            began();
            await waiting;
          }
        },
      },
    );
    await started;
    expect(seen).toEqual([1]);
    expect(server.stdin.writableEnded).toBe(false);
    release();
    await vi.runAllTimersAsync();
    expect(await pending).toBe('complete');
    expect(seen).toEqual([1, 2]);
    expect(onExit).not.toHaveBeenCalled();
  });

  it('notifies leader exit and kills its owned group when descendants keep stdio open', async () => {
    const server = fixture({ closeOnEnd: false, closeOnKill: false });
    Object.assign(server.child, { pid: 424242 });
    const killGroup = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (signal === 'SIGKILL') queueMicrotask(() => server.close(7));
      return true;
    });
    const onExit = vi.fn();
    const pending = withAppServer(
      '/home/test',
      nativeEnv,
      100,
      async () => {
        queueMicrotask(() => server.child.emit('exit', 7, null));
        return new Promise<never>(() => {});
      },
      { spawn: server.spawnChild, onExit },
    );
    await vi.runAllTimersAsync();
    expect(await pending).toBeNull();
    expect(onExit).toHaveBeenCalledOnce();
    expect(onExit.mock.calls[0]?.[0]).toMatchObject({ message: 'Codex app server exited (7)' });
    expect(killGroup).toHaveBeenCalledWith(-424242, 'SIGTERM');
    expect(killGroup).toHaveBeenCalledWith(-424242, 'SIGKILL');
  });

  it.each(['sync', 'async'])('fails closed on a %s notification callback failure', async (kind) => {
    const server = fixture();
    const onExit = vi.fn();
    const pending = withAppServer(
      '/home/test',
      nativeEnv,
      100,
      async () => {
        server.emit({ method: 'turn/completed', params: {} });
        return new Promise<never>(() => {});
      },
      {
        spawn: server.spawnChild,
        onExit,
        onNotification: () => {
          const error = new Error('Instruction snapshot changed');
          if (kind === 'sync') throw error;
          return Promise.reject(error);
        },
      },
    );
    await vi.runAllTimersAsync();
    expect(await pending).toBeNull();
    expect(onExit).toHaveBeenCalledOnce();
    expect(onExit.mock.calls[0]?.[0]).toMatchObject({ message: 'Instruction snapshot changed' });
    expect(server.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it.each(['missing', 'throws'])('refuses an approval when its callback %s', async (kind) => {
    const server = fixture();
    const onExit = vi.fn();
    const pending = withAppServer(
      '/home/test',
      nativeEnv,
      100,
      async () => {
        server.emit({
          id: 'approval-1',
          method: 'item/commandExecution/requestApproval',
          params: { command: 'write' },
        });
        return 'still connected';
      },
      {
        spawn: server.spawnChild,
        onExit,
        ...(kind === 'throws'
          ? {
              onServerRequest: () => {
                throw new Error('No permission');
              },
            }
          : {}),
      },
    );
    await vi.runAllTimersAsync();
    expect(await pending).toBe('still connected');
    expect(server.sent).toContainEqual({
      id: 'approval-1',
      error: { code: -32601, message: 'Tenjin cannot authorize this server request' },
    });
    expect(onExit).not.toHaveBeenCalled();
  });

  it('aborts an in-flight RPC and clears its timer before finishing cleanup', async () => {
    const server = fixture();
    const controller = new AbortController();
    const onExit = vi.fn();
    let response: unknown = 'not drained';
    const pending = withAppServer(
      '/home/test',
      nativeEnv,
      100,
      async (request) => {
        const rpc = request('thread/unanswered', {});
        queueMicrotask(() => controller.abort(new Error('Job canceled')));
        response = await rpc;
        return 'unreachable';
      },
      { spawn: server.spawnChild, signal: controller.signal, onExit },
    );
    await vi.runAllTimersAsync();
    expect(await pending).toBeNull();
    expect(response).toBeUndefined();
    expect(onExit).toHaveBeenCalledOnce();
    expect(onExit.mock.calls[0]?.[0]).toMatchObject({ message: 'Job canceled' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns on disconnect even if an exit observer rejects', async () => {
    const server = fixture();
    const pending = withAppServer(
      '/home/test',
      nativeEnv,
      100,
      async () => {
        queueMicrotask(() => server.stdout.emit('error', new Error('Broken pipe')));
        return new Promise<never>(() => {});
      },
      {
        spawn: server.spawnChild,
        onExit: async () => {
          throw new Error('Observer failed');
        },
      },
    );
    await vi.runAllTimersAsync();
    expect(await pending).toBeNull();
    expect(server.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('stops an oversized unterminated notification instead of buffering forever', async () => {
    const server = fixture();
    const onExit = vi.fn();
    const onNotification = vi.fn();
    const pending = withAppServer(
      '/home/test',
      nativeEnv,
      100,
      async () => {
        server.stdout.write('x'.repeat(8 * 1024 * 1024 + 1));
        return new Promise<never>(() => {});
      },
      { spawn: server.spawnChild, onExit, onNotification },
    );
    await vi.runAllTimersAsync();
    expect(await pending).toBeNull();
    expect(onExit).toHaveBeenCalledOnce();
    expect(onNotification).not.toHaveBeenCalled();
    expect(server.kill).toHaveBeenCalledWith('SIGTERM');
  });
});
