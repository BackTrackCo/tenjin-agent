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
  expectedVersion?: string | readonly string[];
  /** Internal, trusted argv overrides; never written to user configuration. */
  configOverrides?: string[];
  signal?: AbortSignal;
  onServerRequest?: (method: string, params: unknown) => Promise<unknown>;
  onNotification?: (method: string, params: unknown) => void | Promise<void>;
  /** Unexpected disconnect only; ordinary callback completion does not fire it. */
  onExit?: (error: Error) => void | Promise<void>;
  /** Internal process seam; production always uses Node's child-process spawn. */
  spawn?: typeof spawn;
}

/** Originator names vary by host; the first product/version identifies the server. */
export function codexAppServerVersion(userAgent: unknown): string | null {
  return typeof userAgent === 'string'
    ? (/^[^/]+\/([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)(?:\s|$)/.exec(userAgent)?.[1] ?? null)
    : null;
}

/** One owned stdio connection. No generation is started by this helper. */
export async function withAppServer<T>(
  home: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  fn: (request: CodexAppRequest, serverVersion?: string | null) => Promise<T>,
  options: CodexAppOptions = {},
): Promise<T | null> {
  const codex = resolveCodex(env);
  if (codex === null || options.signal?.aborted) return null;
  let child: ReturnType<typeof spawn>;
  try {
    child = (options.spawn ?? spawn)(
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
  let closing = false;
  const pending = new Map<number, (value: unknown) => void>();
  const callbacks = new Set<Promise<void>>();
  let notifications = Promise.resolve();
  let disconnected!: (value: null) => void;
  const connectionLost = new Promise<null>((resolve) => {
    disconnected = resolve;
  });
  const track = (work: Promise<void>) => {
    callbacks.add(work);
    void work.then(
      () => callbacks.delete(work),
      () => callbacks.delete(work),
    );
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
  const fail = (cause: unknown = new Error('Codex app server disconnected')): void => {
    if (dead) return;
    dead = true;
    disconnected(null);
    for (const resolve of pending.values()) resolve(undefined);
    pending.clear();
    if (!closing) {
      const error =
        cause instanceof Error ? cause : new Error('Codex app server disconnected', { cause });
      track(
        Promise.resolve()
          .then(() => options.onExit?.(error))
          .catch(() => undefined),
      );
      stop('SIGTERM');
    }
  };
  const onAbort = () => {
    fail(options.signal?.reason);
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  child.stdin?.on('error', fail);
  const closed = new Promise<void>((resolve) => {
    child.once('error', (error) => {
      fail(error);
      exited = true;
      resolve();
    });
    child.once('exit', (code, signal) => {
      exited = true;
      fail(new Error(`Codex app server exited (${signal ?? code ?? 'unknown'})`));
    });
    child.once('close', () => {
      fail();
      exited = true;
      resolve();
    });
  });
  let buffered = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('error', fail);
  child.stdout?.once('end', () => fail());
  child.stdout?.on('data', (chunk: string) => {
    if (dead || closing) return;
    buffered += chunk;
    if (Buffer.byteLength(buffered) > 8 * 1024 * 1024) {
      fail();
      return;
    }
    let cut = buffered.indexOf('\n');
    while (cut !== -1) {
      if (dead || closing) return;
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
        track(
          Promise.resolve()
            .then(() => {
              if (!options.onServerRequest) throw new Error('unsupported request');
              return options.onServerRequest(msg.method as string, msg.params);
            })
            .then(
              (result) => {
                send({ id, result });
              },
              () => {
                send({
                  id,
                  error: { code: -32601, message: 'Tenjin cannot authorize this server request' },
                });
              },
            ),
        );
        continue;
      }
      if (typeof msg.method === 'string') {
        if (msg.id === undefined && options.onNotification) {
          const { method, params } = msg;
          notifications = notifications
            .then(async () => {
              if (!dead) await options.onNotification?.(method, params);
            })
            .catch(fail);
          track(notifications);
        }
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
    if (options.expectedVersion) {
      const versions =
        typeof options.expectedVersion === 'string'
          ? [options.expectedVersion]
          : options.expectedVersion;
      const version = codexAppServerVersion(initialized.userAgent);
      if (version === null || !versions.includes(version)) return null;
    }
    send({ method: 'initialized', params: {} });
    const result = await Promise.race([
      Promise.resolve().then(() => fn(request, codexAppServerVersion(initialized.userAgent))),
      connectionLost,
    ]);
    while (callbacks.size > 0 && !dead)
      await Promise.race([Promise.allSettled([...callbacks]), connectionLost]);
    return dead ? null : result;
  } catch {
    return null;
  } finally {
    closing = true;
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
    await Promise.race([
      Promise.allSettled([...callbacks]),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 500);
      }),
    ]);
    clearTimeout(timer);
  }
}
