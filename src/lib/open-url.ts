import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Open a URL in the user's real default browser, best-effort. Follows the
 * passphrase.ts subprocess rules: an argv array (never a shell), a hard
 * timeout, and failure as a return value rather than a throw — callers print
 * the URL first, so a machine without an opener degrades to copy/paste.
 *
 * The opener is an absolute system path, never a bare name looked up on PATH,
 * and the BROWSER variable and other host-provided hints are dropped from the
 * child's environment. An agent host (Claude Desktop, an IDE) can put a shim on
 * PATH or set BROWSER to route the link into its own embedded view, where Apple
 * Pay and Google Pay cannot complete. On macOS the system's default https
 * handler is looked up and named explicitly with `open -b`. If the default
 * browser is itself an embedded view there is nothing more this can do, and the
 * caller's printed link and QR remain the way out.
 *
 * Windows uses rundll32's FileProtocolHandler because `start` exists only
 * inside cmd.exe, and spawning a shell around an attacker-influenced string is
 * the injection shape this module exists to avoid.
 */

export interface OpenUrlOptions {
  platform?: NodeJS.Platform;
  execFileImpl?: typeof execFile;
  /** Test seam for the Linux opener search. */
  existsImpl?: (path: string) => boolean;
  /** Test seam for the macOS LaunchServices preferences location. */
  homeDir?: string;
  /** Test seam for the environment handed to the child. */
  env?: NodeJS.ProcessEnv;
}

const OPEN_TIMEOUT_MS = 5000;
const MAC_OPEN = '/usr/bin/open';
const XDG_OPEN_CANDIDATES = [
  '/usr/bin/xdg-open',
  '/bin/xdg-open',
  '/usr/local/bin/xdg-open',
] as const;
/** What a bundle id may look like; keeps a hostile preference value from becoming a flag. */
const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;

export function openerFor(
  platform: NodeJS.Platform,
  existsImpl: (path: string) => boolean = existsSync,
): { cmd: string; args: string[] } {
  if (platform === 'darwin') return { cmd: MAC_OPEN, args: [] };
  if (platform === 'win32') return { cmd: 'rundll32', args: ['url.dll,FileProtocolHandler'] };
  const found = XDG_OPEN_CANDIDATES.find((p) => existsImpl(p));
  return { cmd: found ?? XDG_OPEN_CANDIDATES[0], args: [] };
}

/** The child's environment without BROWSER, which xdg-open and others honor over the system default. */
function openerEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base };
  delete env.BROWSER;
  return env;
}

/**
 * The bundle id of the default https handler, read from the user's LaunchServices
 * preferences, or undefined when none is recorded (the OS default then applies)
 * or anything about the read fails.
 */
async function macDefaultBrowserBundleId(
  run: typeof execFile,
  homeDir: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const plist = join(
    homeDir,
    'Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist',
  );
  const out = await new Promise<string | undefined>((resolve) => {
    run(
      '/usr/bin/plutil',
      ['-convert', 'json', '-o', '-', plist],
      { timeout: OPEN_TIMEOUT_MS, env },
      (err, stdout) => resolve(err === null ? String(stdout) : undefined),
    );
  });
  if (out === undefined) return undefined;
  try {
    const parsed = JSON.parse(out) as { LSHandlers?: unknown };
    if (!Array.isArray(parsed.LSHandlers)) return undefined;
    for (const entry of parsed.LSHandlers as Record<string, unknown>[]) {
      const scheme = entry.LSHandlerURLScheme;
      if (typeof scheme !== 'string' || scheme.toLowerCase() !== 'https') continue;
      const id = entry.LSHandlerRoleAll ?? entry.LSHandlerRoleViewer;
      if (typeof id === 'string' && BUNDLE_ID.test(id)) return id;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export async function openInBrowser(url: string, opts: OpenUrlOptions = {}): Promise<boolean> {
  const platform = opts.platform ?? process.platform;
  const run = opts.execFileImpl ?? execFile;
  const env = openerEnv(opts.env ?? process.env);
  const { cmd, args } = openerFor(platform, opts.existsImpl);
  const launch = (extra: string[]): Promise<boolean> =>
    new Promise((resolve) => {
      run(
        cmd,
        [...args, ...extra, url],
        { timeout: OPEN_TIMEOUT_MS, windowsHide: true, env },
        (err) => resolve(err === null),
      );
    });

  if (platform === 'darwin') {
    const bundleId = await macDefaultBrowserBundleId(run, opts.homeDir ?? homedir(), env);
    if (bundleId !== undefined && (await launch(['-b', bundleId]))) return true;
  }
  return await launch([]);
}
