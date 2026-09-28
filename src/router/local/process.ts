import { execFile, spawn } from 'node:child_process';

export type BoundedCommand = {
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  input?: string;
  signal: AbortSignal;
  outputBytes: number;
};
export type CommandResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  reason?: string;
};

type ProcessIdentity = { pid: number; parent: number; group: number; started: string };
function processTable(): Promise<ProcessIdentity[]> {
  return new Promise((resolve) =>
    execFile(
      '/bin/ps',
      ['-axo', 'pid=,ppid=,pgid=,lstart='],
      { timeout: 1000, maxBuffer: 1024 * 1024, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } },
      (error, stdout) => {
        if (error) {
          resolve([]);
          return;
        }
        resolve(
          stdout.split('\n').flatMap((line) => {
            const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
            return match
              ? [
                  {
                    pid: Number(match[1]),
                    parent: Number(match[2]),
                    group: Number(match[3]),
                    started: match[4]!,
                  },
                ]
              : [];
          }),
        );
      },
    ),
  );
}

/** Only the fixed runtime argv calls this in production. Exported for focused lifecycle tests. */
export async function runBoundedCommand(command: BoundedCommand): Promise<CommandResult> {
  if (!Number.isSafeInteger(command.outputBytes) || command.outputBytes < 1)
    throw new Error('Invalid subprocess output limit');
  command.signal.throwIfAborted();
  const child = spawn('npx', command.argv, {
    cwd: command.cwd,
    env: command.env,
    shell: false,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let reason: string | undefined;
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let closed = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let scan: Promise<void> = Promise.resolve();
  const owned = new Map<number, ProcessIdentity>();
  const observe = async () => {
    if (!child.pid) return;
    const table = await processTable();
    const self = table.find((row) => row.pid === child.pid);
    const previous = owned.get(child.pid);
    const parents = new Set(
      table.filter((row) => owned.get(row.pid)?.started === row.started).map((row) => row.pid),
    );
    if (!closed && self && (!previous || previous.started === self.started)) {
      parents.add(self.pid);
      owned.set(self.pid, self);
    }
    // A child can outlive a fast-exiting leader before the first descendant scan.
    if (!self || !closed || previous?.started === self.started) {
      for (const row of table) {
        if (row.group === child.pid) {
          parents.add(row.pid);
          owned.set(row.pid, row);
        }
      }
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of table)
        if (parents.has(row.parent) && !parents.has(row.pid)) {
          parents.add(row.pid);
          owned.set(row.pid, row);
          changed = true;
        }
    }
  };
  const signalOwned = async (signal: NodeJS.Signals) => {
    await observe();
    const table = await processTable();
    for (const row of table) {
      if (owned.get(row.pid)?.started !== row.started) continue;
      try {
        process.kill(row.pid, signal);
      } catch {
        /* Already stopped. */
      }
    }
    if (!closed && child.pid) {
      try {
        process.kill(-child.pid, signal);
      } catch {
        /* No surviving process group. */
      }
    }
  };
  const stop = (why: string) => {
    if (reason) return;
    reason = why;
    void signalOwned('SIGTERM');
    killTimer ??= setTimeout(() => {
      void signalOwned('SIGKILL');
    }, 100);
  };
  const onAbort = () => stop('cancelled');
  command.signal.addEventListener('abort', onAbort, { once: true });
  if (command.signal.aborted) onAbort();
  let scanning = false;
  const poll = setInterval(() => {
    if (scanning) return;
    scanning = true;
    scan = observe().finally(() => {
      scanning = false;
    });
  }, 100);
  const append = (kind: 'stdout' | 'stderr', chunk: Buffer) => {
    const current = kind === 'stdout' ? stdout : stderr;
    const combined = Buffer.concat([current, chunk]);
    if (kind === 'stdout') stdout = combined.subarray(0, command.outputBytes);
    else stderr = combined.subarray(0, command.outputBytes);
    if (combined.length > command.outputBytes) stop('output-limit');
  };
  child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk));
  child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk));
  child.stdin.on('error', () => {
    /* Auth can reject before consuming input. */
  });
  child.stdin.end(command.input ?? '');
  const result = await new Promise<{ code: number | null }>((resolve) => {
    child.once('error', () => {
      reason ??= 'runtime-start-failed';
      resolve({ code: null });
    });
    child.once('close', (code) => {
      closed = true;
      resolve({ code });
    });
  });
  clearInterval(poll);
  clearTimeout(killTimer);
  command.signal.removeEventListener('abort', onAbort);
  await scan;
  await signalOwned('SIGKILL');
  return {
    ...result,
    stdout: stdout.toString('utf8'),
    stderr: stderr.toString('utf8'),
    ...(reason ? { reason } : {}),
  };
}
