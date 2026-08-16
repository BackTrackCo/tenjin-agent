import { execFile } from 'node:child_process';

/**
 * Open a URL in the platform's default browser, best-effort. Follows the
 * passphrase.ts subprocess rules: an argv array (never a shell), a hard
 * timeout, and failure as a return value rather than a throw — callers print
 * the URL first, so a machine without an opener degrades to copy/paste.
 * Windows uses rundll32's FileProtocolHandler because `start` exists only
 * inside cmd.exe, and spawning a shell around an attacker-influenced string is
 * the injection shape this module exists to avoid.
 */

export interface OpenUrlOptions {
  platform?: NodeJS.Platform;
  execFileImpl?: typeof execFile;
}

const OPEN_TIMEOUT_MS = 5000;

export function openerFor(platform: NodeJS.Platform): { cmd: string; args: string[] } {
  if (platform === 'darwin') return { cmd: 'open', args: [] };
  if (platform === 'win32') return { cmd: 'rundll32', args: ['url.dll,FileProtocolHandler'] };
  return { cmd: 'xdg-open', args: [] };
}

export async function openInBrowser(url: string, opts: OpenUrlOptions = {}): Promise<boolean> {
  const { cmd, args } = openerFor(opts.platform ?? process.platform);
  const run = opts.execFileImpl ?? execFile;
  return await new Promise((resolve) => {
    run(cmd, [...args, url], { timeout: OPEN_TIMEOUT_MS, windowsHide: true }, (err) =>
      resolve(err === null),
    );
  });
}
