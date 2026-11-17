import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpawnOptions } from '@anthropic-ai/claude-agent-sdk/core';

/**
 * THE SDK PASSES ITS FLAG SETTINGS AS A JSON ARGUMENT, `--settings {...}`, which other
 * processes can read from the process table, and a worker's hold its bridge token and its
 * GitHub env. Claude Code takes a path there as well: the JSON goes in a file of its own
 * folder, which only this user can open and which is outside every working directory, so
 * the worker cannot change it. The folder is removed once the child has closed.
 */
function settingsOffCommandLine(args: readonly string[], folders: string[]): string[] {
  const out = [...args];
  for (let at = 0; at + 1 < out.length; at++) {
    if (out[at] !== '--settings' || !out[at + 1]!.trimStart().startsWith('{')) continue;
    const folder = mkdtempSync(join(tmpdir(), 'tenjin-worker-settings-'));
    folders.push(folder);
    const file = join(folder, 'settings.json');
    writeFileSync(file, out[at + 1]!, { mode: 0o600, flag: 'wx' });
    out[at + 1] = file;
  }
  return out;
}

/**
 * Observe the maintained SDK's native child without replacing its transport. `secrets`
 * are values that must never be on its command line: a child whose arguments still hold
 * one is not started.
 */
export function claudeWorkerProcess(o: { secrets?: () => readonly string[] } = {}) {
  const children: Array<{
    child: ReturnType<typeof spawn>;
    closed: Promise<void>;
    isClosed: () => boolean;
    failed: () => boolean;
  }> = [];
  const folders: string[] = [];
  let closing = false;
  const drainChildren = async () => {
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
  };
  return {
    spawn(options: SpawnOptions) {
      if (closing) throw new Error('Claude worker is already draining');
      const before = folders.length;
      let args: string[];
      try {
        args = settingsOffCommandLine(options.args, folders);
        const secrets = (o.secrets?.() ?? []).filter((secret) => secret.length > 0);
        if (args.some((arg) => secrets.some((secret) => arg.includes(secret))))
          throw new Error('A Claude worker secret would be on its command line');
      } catch (error) {
        for (const folder of folders.splice(before))
          rmSync(folder, { recursive: true, force: true });
        throw error;
      }
      const child = spawn(options.command, args, {
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
      try {
        return await drainChildren();
      } finally {
        // Every child has closed, or was killed: nothing reads its settings any more.
        await Promise.all(
          folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
        );
      }
    },
  };
}
