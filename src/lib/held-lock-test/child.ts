import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Helper children for tests of locks across processes. Not a test file. */
const dir = fileURLToPath(new URL('.', import.meta.url));
const children = new Set<ChildProcess>();

const helperArgs = (file: string, args: string[]) => [
  '--experimental-strip-types',
  '--no-warnings',
  '--import',
  pathToFileURL(join(dir, 'register.mjs')).href,
  join(dir, file),
  ...args,
];

/** A child that runs a helper from this folder, with the lines it prints. */
export function child(file: string, ...args: string[]) {
  const proc = spawn(process.execPath, helperArgs(file, args), {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  children.add(proc);
  let text = '';
  const waiters: Array<() => void> = [];
  proc.stdout.on('data', (chunk: Buffer) => {
    text += chunk.toString();
    for (const wake of waiters.splice(0)) wake();
  });
  const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
  return {
    proc,
    exited,
    /** Resolves once the child printed a line that starts with `prefix`. */
    async line(prefix: string) {
      for (;;) {
        const found = text.split('\n').find((line) => line.startsWith(prefix));
        if (found !== undefined) return found;
        if (proc.exitCode !== null) throw new Error(`child ended: ${text}`);
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
          void exited.then(resolve);
        });
      }
    },
  };
}

/** Starts a child that holds `lockPath` and waits until it does. */
export async function holder(lockPath: string, primitive?: 'sqlite') {
  const held = child('holder.ts', lockPath, 'hold', ...(primitive ? [primitive] : []));
  await held.line('held');
  return {
    ...held,
    /** Releases and lets the child exit. */
    async release() {
      held.proc.stdin.write('go\n');
      await held.exited;
    },
    /** SIGKILL (TerminateProcess on Windows), and waits for it to end. */
    async kill() {
      held.proc.kill('SIGKILL');
      await held.exited;
    },
  };
}

/** A child that takes the lock, drops its release and forces garbage collection. */
export async function forgetter(lockPath: string, primitive?: 'sqlite') {
  const held = child('holder.ts', lockPath, 'forget', ...(primitive ? [primitive] : []));
  await held.line('held');
  return held;
}

/** Whether a zero-wait attempt in another process finds `lockPath` held. */
export async function probe(
  lockPath: string,
  primitive?: 'sqlite',
): Promise<'held' | 'free' | string> {
  const probing = child('holder.ts', lockPath, 'probe', ...(primitive ? [primitive] : []));
  await probing.exited;
  return (await probing.line('').catch(() => '')) || 'error';
}

/**
 * The job sweep's cleanup of `lockPath`, run in another process while this one waits: what a
 * sweep in another Tenjin process does between two steps of a taker here. True when it deleted.
 */
export function discardElsewhere(lockPath: string, primitive?: 'sqlite'): boolean {
  const run = spawnSync(
    process.execPath,
    helperArgs('holder.ts', [lockPath, 'discard', ...(primitive ? [primitive] : [])]),
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: 20_000 },
  );
  if (run.status !== 0) throw new Error(`discard child failed: ${run.status} ${run.stdout}`);
  return run.stdout.trim() === 'true';
}

export function killChildren() {
  for (const proc of children) proc.kill('SIGKILL');
  children.clear();
}
