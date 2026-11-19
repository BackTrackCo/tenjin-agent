import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Settings, SpawnOptions } from '@anthropic-ai/claude-agent-sdk/core';
import { markJobFolder, removeJobFolder } from './job-folders';

export type WindowsWorkerProcess = {
  launcherPath: string;
  workerSid: string;
  configDir: string;
  protectedPaths: readonly string[];
};

/**
 * Observe the maintained SDK's native child without replacing its transport. `secrets`
 * are values that must never be on its command line: a child whose arguments still hold
 * one is not started.
 *
 * A WORKER'S FLAG SETTINGS HOLD ITS BRIDGE TOKEN AND ITS GITHUB ENV. Given to the SDK as an
 * object, they become a `--settings {...}` argument, which other processes read from the
 * process table and which the SDK's own debug log (`DEBUG_CLAUDE_AGENT_SDK`) records with
 * every spawn. So they are written first, by {@link settingsFile}, to a file of its own
 * folder that only this user can open and that is outside every working directory, and
 * the SDK is given only its path. The folder is removed once every child has closed, and a
 * failed delete never fails the job ({@link removeJobFolder}); a kill of this process leaves
 * it to the next `tenjin mcp`'s sweep ({@link markJobFolder}).
 */
export function claudeWorkerProcess(
  o: {
    secrets?: () => readonly string[];
    windows?: WindowsWorkerProcess;
    /**
     * Each start-up checkpoint Claude Code reports before its initialize answer, by name and
     * the time this process saw it. Claude Code writes them as `keep_alive` lines when
     * `CLAUDE_CODE_SDK_READS_STARTUP_MARKS` is set, which the SDK ignores outside its own
     * `startup()`; they hold a checkpoint's name and nothing else.
     */
    onStartupMark?: (name: string, at: number) => void;
  } = {},
) {
  const MARKS = 'CLAUDE_CODE_SDK_READS_STARTUP_MARKS';
  const children: Array<{
    child: ReturnType<typeof spawn>;
    closed: Promise<void>;
    isClosed: () => boolean;
    failed: () => boolean;
  }> = [];
  const folders: string[] = [];
  let closing = false;
  let childExited = false;
  let markExit!: () => void;
  const exited = new Promise<void>((resolve) => {
    markExit = () => {
      childExited = true;
      resolve();
    };
  });
  /**
   * The child's whole process group (it leads one of its own): Claude Code, the MCP
   * servers and the commands it started. Signalled after the child itself, so nothing
   * it started outlives it.
   */
  const group = (child: ReturnType<typeof spawn>, signal: NodeJS.Signals) => {
    if (process.platform === 'win32' || child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      /* The group has gone. */
    }
  };
  const drainChildren = async (now: boolean) => {
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
          group(child, signal);
        };
        // The SDK already gives stdin EOF, then TERM/KILL. These are fallback
        // bounds after its cleanup, for this exact owned child only. A worker stopped
        // before its accept has nothing to finish: it is ended at once.
        if (now) kill('SIGTERM');
        const term = now ? undefined : setTimeout(() => kill('SIGTERM'), 8000);
        const hard = o.windows ? undefined : setTimeout(() => kill('SIGKILL'), now ? 2000 : 10000);
        let deadline: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            closed,
            new Promise<never>((_resolve, reject) => {
              deadline = setTimeout(
                () => reject(new Error('Claude worker process did not drain')),
                o.windows ? 60_000 : 12_000,
              );
            }),
          ]);
          return !failed() && !forced && child.exitCode === 0 && !child.signalCode;
        } finally {
          clearTimeout(term);
          clearTimeout(hard);
          clearTimeout(deadline);
          // A descendant can outlive the child and close its inherited stdio.
          group(child, 'SIGKILL');
        }
      }),
    );
    return { successful: successful.every(Boolean) };
  };
  return {
    /** The native child exited or could not be spawned, before stdio cleanup. */
    exited,
    hasExited: () => childExited,
    /** The settings, in a file only this user can read: its path, for the SDK's `settings`. */
    settingsFile(settings: Settings): string {
      if (closing) throw new Error('Claude worker is already draining');
      // Named under `tenjin-worker-`, which every worker's sandbox denies (`WorkerGithub.others`).
      const folder = mkdtempSync(join(tmpdir(), 'tenjin-worker-settings-'));
      folders.push(folder);
      markJobFolder(folder);
      try {
        const file = join(folder, 'settings.json');
        writeFileSync(file, JSON.stringify(settings), { mode: 0o600, flag: 'wx' });
        return file;
      } catch (error) {
        folders.splice(folders.indexOf(folder), 1);
        try {
          rmSync(folder, { recursive: true, force: true });
        } catch {
          // Left to the sweep; the write's own error is the one that matters.
        }
        throw error;
      }
    },
    spawn(options: SpawnOptions) {
      if (closing) throw new Error('Claude worker is already draining');
      const { args } = options;
      const spawnOptions = o.onStartupMark
        ? { ...options, env: { ...options.env, [MARKS]: '1' } }
        : options;
      const secrets = (o.secrets?.() ?? []).filter((secret) => secret.length > 0);
      if (args.some((arg) => secrets.some((secret) => arg.includes(secret))))
        throw new Error('A Claude worker secret would be on its command line');
      const windows = o.windows;
      const cancelFolder = windows
        ? mkdtempSync(join(tmpdir(), 'tenjin-worker-cancel-'))
        : undefined;
      if (cancelFolder) markJobFolder(cancelFolder);
      const cancelFile = cancelFolder ? join(cancelFolder, 'stop') : undefined;
      let child: ChildProcessWithoutNullStreams;
      try {
        child =
          windows && cancelFile
            ? spawn(
                windows.launcherPath,
                [
                  '--worker-sid',
                  windows.workerSid,
                  '--parent-pid',
                  String(process.pid),
                  '--cwd',
                  options.cwd ?? process.cwd(),
                  '--cancel-file',
                  cancelFile,
                  '--',
                  options.command,
                  ...args,
                ],
                {
                  cwd: options.cwd,
                  env: {
                    ...spawnOptions.env,
                    TENJIN_WINDOWS_PROFILE: windows.configDir,
                    TENJIN_WINDOWS_PROTECTED_PATHS: JSON.stringify(windows.protectedPaths),
                  },
                  stdio: ['pipe', 'pipe', 'pipe'],
                  detached: true,
                  windowsHide: true,
                },
              )
            : spawn(options.command, args, {
                cwd: options.cwd,
                env: spawnOptions.env,
                signal: options.signal,
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true,
                ...(process.platform === 'win32' ? {} : { detached: true }),
              });
      } catch (error) {
        if (cancelFolder) {
          try {
            rmSync(cancelFolder, { recursive: true, force: true });
          } catch {
            // Left to the sweep.
          }
        }
        throw error;
      }
      if (cancelFile) {
        // A cold alternate logon can still be inside Win32 when the SDK stops. Leave
        // the launcher alive to reap the suspended process once that call returns.
        const stop = () => {
          try {
            writeFileSync(cancelFile, '', { mode: 0o600 });
            return true;
          } catch {
            return false;
          }
        };
        child.kill = stop;
        options.signal.addEventListener('abort', stop, { once: true });
        if (options.signal.aborted) stop();
        child.once('close', () => {
          options.signal.removeEventListener('abort', stop);
          if (cancelFolder) void removeJobFolder(cancelFolder);
        });
      }
      if (o.onStartupMark) tapStartupMarks(child, o.onStartupMark);
      // The custom-spawn interface leaves stderr to its caller. Drain it without
      // retaining tool output, credentials or native diagnostic text.
      child.stderr.on('error', () => {});
      child.stderr.resume();
      let isClosed = false,
        failed = false;
      child.once('exit', markExit);
      const closed = new Promise<void>((resolve) => {
        child.once('close', () => {
          isClosed = true;
          resolve();
        });
        child.once('error', () => {
          if (child.pid === undefined) {
            markExit();
            failed = true;
            isClosed = true;
            resolve();
          }
        });
      });
      children.push({ child, closed, isClosed: () => isClosed, failed: () => failed });
      return child;
    },
    /** Ends every child. `now`: at once, a group TERM and a KILL 2 s later, for a worker
     *  stopped before its accept; otherwise after the SDK's own close, as before. */
    async drain({ now = false }: { now?: boolean } = {}) {
      closing = true;
      try {
        return await drainChildren(now);
      } finally {
        // Every child has closed, or was killed: nothing reads its settings any more. A
        // delete that fails is tried again and then left to the sweep: it never changes how
        // the drain, or the job, ended.
        await Promise.all(folders.splice(0).map((folder) => removeJobFolder(folder)));
      }
    },
  };
}

/**
 * Reads the checkpoint lines at the start of a child's output and stops at its first other
 * line: nothing after the initialize answer is looked at, so no model output is scanned.
 */
function tapStartupMarks(
  child: ChildProcessWithoutNullStreams,
  report: (name: string, at: number) => void,
): void {
  let pending = '';
  const read = (chunk: Buffer | string) => {
    pending += String(chunk);
    for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      let name: unknown;
      try {
        const parsed = JSON.parse(line) as { type?: unknown; startup_mark?: unknown };
        if (parsed.type === 'keep_alive') name = parsed.startup_mark;
        else return stop();
      } catch {
        return stop();
      }
      if (typeof name === 'string') report(name.slice(0, 40), Date.now());
    }
    // A line this long is not a checkpoint.
    if (pending.length > 4096) stop();
  };
  const stop = () => {
    child.stdout.off('data', read);
    pending = '';
  };
  child.stdout.on('data', read);
}
