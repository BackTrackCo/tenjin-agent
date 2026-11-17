import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { win32 } from 'node:path';

/**
 * COPY A SHORT TEXT TO THIS COMPUTER'S CLIPBOARD, best-effort: `tenjin
 * redeem` copies the GitHub sign-in code so the person can paste it on the
 * device page. The code is always printed too, so a copy that fails costs
 * nothing but the paste.
 *
 * The subprocess rules of `open-url.ts` hold: an absolute binary, an argv
 * array, never a shell, a hard timeout, and failure as `false`, never a throw.
 * The text goes in on stdin, never on the command line.
 *
 * `spawn` rather than `execFile`: xclip, xsel and wl-copy fork a process that
 * keeps serving the clipboard after the command returns, and that process
 * holds any stdout it inherited. `execFile` waits for its output pipes to
 * close, so it would sit out the whole timeout. Here the child's output goes
 * nowhere and the copy is done when the command itself exits.
 *
 * Over SSH the clipboard these commands reach is the remote machine's, not the
 * one the person is sitting at, so nothing is copied there.
 */

const COPY_TIMEOUT_MS = 2_000;
const BIN_DIRS = ['/usr/bin', '/bin', '/usr/local/bin'] as const;

export interface ClipboardDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  spawnImpl?: typeof spawn;
  /** Test seam for the Linux binary search. */
  existsImpl?: (path: string) => boolean;
}

/** The command that writes its stdin to the clipboard here, or undefined when there is none. */
export function copierFor(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  existsImpl: (path: string) => boolean = existsSync,
): { cmd: string; args: string[] } | undefined {
  if (platform === 'darwin') return { cmd: '/usr/bin/pbcopy', args: [] };
  if (platform === 'win32') {
    return { cmd: win32.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'clip.exe'), args: [] };
  }
  if (platform !== 'linux') return undefined;
  const find = (name: string) =>
    BIN_DIRS.map((dir) => `${dir}/${name}`).find((path) => existsImpl(path));
  const candidates: { name: string; args: string[]; when: boolean }[] = [
    { name: 'wl-copy', args: [], when: set(env.WAYLAND_DISPLAY) },
    { name: 'xclip', args: ['-selection', 'clipboard'], when: true },
    { name: 'xsel', args: ['--clipboard', '--input'], when: true },
  ];
  for (const c of candidates) {
    if (!c.when) continue;
    const cmd = find(c.name);
    if (cmd !== undefined) return { cmd, args: c.args };
  }
  return undefined;
}

export async function copyText(text: string, deps: ClipboardDeps = {}): Promise<boolean> {
  const env = deps.env ?? process.env;
  if (set(env.SSH_CONNECTION) || set(env.SSH_CLIENT) || set(env.SSH_TTY)) return false;
  const platform = deps.platform ?? process.platform;
  // A Linux session with no display server has no clipboard to write to.
  if (platform === 'linux' && !set(env.DISPLAY) && !set(env.WAYLAND_DISPLAY)) return false;
  const copier = copierFor(platform, env, deps.existsImpl);
  if (copier === undefined) return false;
  const run = deps.spawnImpl ?? spawn;
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn> | undefined;
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => {
      try {
        child?.kill();
      } catch {
        // Already gone.
      }
      finish(false);
    }, COPY_TIMEOUT_MS);
    timer.unref();
    try {
      child = run(copier.cmd, copier.args, {
        stdio: ['pipe', 'ignore', 'ignore'],
        windowsHide: true,
        env,
      });
      child.once('error', () => finish(false));
      child.once('exit', (code) => finish(code === 0));
      child.stdin?.once('error', () => finish(false));
      child.stdin?.end(text);
    } catch {
      finish(false);
    }
  });
}

function set(v: string | undefined): boolean {
  return typeof v === 'string' && v.length > 0;
}
