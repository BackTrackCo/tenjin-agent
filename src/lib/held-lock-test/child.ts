import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Helper children for tests of locks across processes. Not a test file. */
const dir = fileURLToPath(new URL('.', import.meta.url));
const children = new Set<ChildProcess>();

/** A child that runs a helper from this folder, with the lines it prints. */
export function child(file: string, ...args: string[]) {
  const proc = spawn(
    process.execPath,
    [
      '--experimental-strip-types',
      '--no-warnings',
      '--import',
      join(dir, 'register.mjs'),
      join(dir, file),
      ...args,
    ],
    { stdio: ['pipe', 'pipe', 'inherit'] },
  );
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
export async function holder(lockPath: string) {
  const held = child('holder.ts', lockPath, 'hold');
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

/** Whether a zero-wait attempt in another process finds `lockPath` held. */
export async function probe(lockPath: string): Promise<'held' | 'free' | string> {
  const probing = child('holder.ts', lockPath, 'probe');
  await probing.exited;
  return (await probing.line('').catch(() => '')) || 'error';
}

export function killChildren() {
  for (const proc of children) proc.kill('SIGKILL');
  children.clear();
}
