import { spawn } from 'node:child_process';
import type { SpawnOptions } from '@anthropic-ai/claude-agent-sdk/core';

/** Observe the maintained SDK's native child without replacing its transport. */
export function claudeWorkerProcess() {
  const children: Array<{
    child: ReturnType<typeof spawn>;
    closed: Promise<void>;
    isClosed: () => boolean;
    failed: () => boolean;
  }> = [];
  let closing = false;
  return {
    spawn(options: SpawnOptions) {
      if (closing) throw new Error('Claude worker is already draining');
      const child = spawn(options.command, options.args, {
        cwd: options.cwd,
        env: options.env,
        signal: options.signal,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      // The custom-spawn interface leaves stderr to its caller. Drain it without
      // retaining tool output, credentials or native diagnostic text.
      child.stderr.on('error', () => {});
      child.stderr.resume();
      let isClosed = false,
        failed = false;
      const closed = new Promise<void>((resolve) => {
        child.once('close', () => {
          isClosed = true;
          resolve();
        });
        child.once('error', () => {
          if (child.pid === undefined) {
            failed = true;
            isClosed = true;
            resolve();
          }
        });
      });
      children.push({ child, closed, isClosed: () => isClosed, failed: () => failed });
      return child;
    },
    async drain() {
      closing = true;
      const successful = await Promise.all(
        children.map(async ({ child, closed, isClosed, failed }) => {
          let forced = false;
          const kill = (signal: NodeJS.Signals) => {
            if (!isClosed()) {
              forced = true;
              try {
                child.kill(signal);
              } catch {
                /* The close deadline still fails closed. */
              }
            }
          };
          // The SDK already gives stdin EOF, then TERM/KILL. These are fallback
          // bounds after its cleanup, for this exact owned child only.
          const term = setTimeout(() => kill('SIGTERM'), 8000);
          const hard = setTimeout(() => kill('SIGKILL'), 10000);
          let deadline: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              closed,
              new Promise<never>((_resolve, reject) => {
                deadline = setTimeout(
                  () => reject(new Error('Claude worker process did not drain')),
                  12000,
                );
              }),
            ]);
            return !failed() && !forced && child.exitCode === 0 && !child.signalCode;
          } finally {
            clearTimeout(term);
            clearTimeout(hard);
            clearTimeout(deadline);
          }
        }),
      );
      return { successful: successful.every(Boolean) };
    },
  };
}
