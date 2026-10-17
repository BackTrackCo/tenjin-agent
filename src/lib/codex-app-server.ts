import { spawn } from 'node:child_process';
import { codexHome } from './codex-home';
function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export async function withAppServer<T>(
  home: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  fn: (request: (method: string, params: unknown) => Promise<unknown>) => Promise<T>,
): Promise<T | null> {
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn('codex', ['app-server'], {
      env: { ...env, CODEX_HOME: codexHome(home, env) },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }

  let dead = false;
  const pending = new Map<number, (value: unknown) => void>();
  const fail = (): void => {
    dead = true;
    for (const resolve of pending.values()) resolve(undefined);
    pending.clear();
  };
  child.on('error', fail);
  child.on('exit', fail);

  let buffered = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    buffered += chunk;
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
      if (!isRecord(msg) || typeof msg.id !== 'number') continue;
      const waiting = pending.get(msg.id);
      if (waiting === undefined) continue;
      pending.delete(msg.id);
      waiting(msg.error !== undefined ? undefined : msg.result);
    }
  });

  let nextId = 1;
  const send = (payload: unknown): boolean => {
    try {
      child.stdin?.write(`${JSON.stringify(payload)}\n`);
      return true;
    } catch {
      return false;
    }
  };
  const request = async (method: string, params: unknown): Promise<unknown> => {
    if (dead) return undefined;
    const id = ++nextId;
    return await new Promise<unknown>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve(undefined);
      }, timeoutMs);
      pending.set(id, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
      if (!send({ jsonrpc: '2.0', id, method, params })) {
        pending.delete(id);
        clearTimeout(timer);
        resolve(undefined);
      }
    });
  };

  try {
    // Load-bearing in this order: a request sent before the `initialized`
    // notification is dropped with no reply and no error.
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'tenjin', title: 'tenjin', version: '1' } },
    });
    send({ jsonrpc: '2.0', method: 'initialized', params: {} });
    return await fn(request);
  } catch {
    return null;
  } finally {
    try {
      child.stdin?.end();
    } catch {
      // Already closed.
    }
    child.kill('SIGTERM');
  }
}
