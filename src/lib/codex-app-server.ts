import { spawn } from 'node:child_process';
import { resolveCodex } from './codex-bin';
import { codexHome } from './codex-home';
import { isRecord } from './guards';

export type CodexAppRequest = (
  method: string,
  params: unknown,
  timeoutMs?: number,
) => Promise<unknown>;
export interface CodexAppOptions {
  cwd?: string;
  experimentalApi?: boolean;
  expectedVersion?: string;
  /** Internal, trusted argv overrides; never written to user configuration. */
  configOverrides?: string[];
  signal?: AbortSignal;
  onServerRequest?: (method: string, params: unknown) => Promise<unknown>;
}

/** One owned stdio connection. No generation is started by this helper. */
export async function withAppServer<T>(
  home: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  fn: (request: CodexAppRequest) => Promise<T>,
  options: CodexAppOptions = {},
): Promise<T | null> {
  const codex = resolveCodex(env);
  if (codex === null || options.signal?.aborted) return null;
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(
      codex.cmd,
      [
        ...codex.prefix,
        ...(options.configOverrides ?? []).flatMap((value) => ['-c', value]),
        'app-server',
      ],
      {
        cwd: options.cwd,
        env: { ...env, CODEX_HOME: codexHome(home, env) },
        stdio: ['pipe', 'pipe', 'ignore'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      },
    );
  } catch {
    return null;
  }
  let dead = false;
  let exited = false;
  const pending = new Map<number, (value: unknown) => void>();
  const fail = (): void => {
    dead = true;
    for (const resolve of pending.values()) resolve(undefined);
    pending.clear();
  };
  const send = (payload: unknown): boolean => {
    if (dead) return false;
    try {
      child.stdin?.write(`${JSON.stringify(payload)}\n`);
      return true;
    } catch {
      return false;
    }
  };
  const stop = (signal: NodeJS.Signals) => {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      // The owned process group has already stopped.
    }
  };
  const onAbort = () => {
    fail();
    stop('SIGTERM');
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  child.stdin?.on('error', fail);
  const closed = new Promise<void>((resolve) => {
    child.once('error', () => {
      fail();
      exited = true;
      resolve();
    });
    child.once('close', () => {
      fail();
      exited = true;
      resolve();
    });
  });
  let buffered = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    buffered += chunk;
    if (Buffer.byteLength(buffered) > 8 * 1024 * 1024) {
      fail();
      stop('SIGTERM');
      return;
    }
    let cut = buffered.indexOf('\n');
    while (cut !== -1) {
      const line = buffered.slice(0, cut);
      buffered = buffered.slice(cut + 1);
      cut = buffered.indexOf('\n');
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(msg)) continue;
      if (
        typeof msg.method === 'string' &&
        (typeof msg.id === 'number' || typeof msg.id === 'string')
      ) {
        const id = msg.id;
        // A server request never means consent. Unsupported requests are refused.
        void (
          options.onServerRequest?.(msg.method, msg.params) ??
          Promise.reject(new Error('unsupported request'))
        ).then(
          (result) => send({ id, result }),
          () =>
            send({
              id,
              error: { code: -32601, message: 'Tenjin cannot authorize this server request' },
            }),
        );
        continue;
      }
      if (typeof msg.id !== 'number') continue;
      const waiting = pending.get(msg.id);
      if (waiting === undefined) continue;
      pending.delete(msg.id);
      waiting(msg.error !== undefined ? undefined : msg.result);
    }
  });
  let nextId = 0;
  const request: CodexAppRequest = async (method, params, limit = timeoutMs) => {
    if (dead || options.signal?.aborted) return undefined;
    const id = ++nextId;
    return new Promise<unknown>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve(undefined);
      }, limit);
      pending.set(id, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
      if (!send({ id, method, params })) {
        pending.delete(id);
        clearTimeout(timer);
        resolve(undefined);
      }
    });
  };
  try {
    const initialized = await request('initialize', {
      clientInfo: { name: 'tenjin', title: 'tenjin', version: '1' },
      ...(options.experimentalApi ? { capabilities: { experimentalApi: true } } : {}),
    });
    if (!isRecord(initialized)) return null;
    if (
      options.expectedVersion &&
      (typeof initialized.userAgent !== 'string' ||
        /^tenjin\/([0-9]+\.[0-9]+\.[0-9]+)(?:\s|$)/.exec(initialized.userAgent)?.[1] !==
          options.expectedVersion)
    )
      return null;
    send({ method: 'initialized', params: {} });
    return await fn(request);
  } catch {
    return null;
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
    child.stdin?.end();
    // Allow Codex to close its MCP clients before terminating its owned group.
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      closed,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 500);
      }),
    ]);
    clearTimeout(timer);
    if (!exited) stop('SIGTERM');
    await Promise.race([
      closed,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 500);
      }),
    ]);
    clearTimeout(timer);
    // Also stop children whose stdio server outlived its leader.
    stop('SIGKILL');
    await closed;
  }
}
