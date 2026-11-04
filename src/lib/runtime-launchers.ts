import { lstat, readFile, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join, posix, win32 } from 'node:path';
import {
  LAUNCHER_MARKER,
  renderLauncherCmd,
  renderLauncherSh,
  type RuntimeLaunch,
} from '../router/launcher-files';
import { writeFileAtomic } from './atomic-json';
import { launcherDir } from './paths';
import { packageRootOf } from './runtime-place';

// ---------------------------------------------------------------------------
// Launchers
// ---------------------------------------------------------------------------

export interface LauncherResult {
  paths: string[];
  /**
   * `written` or `current` (ours, now right), `foreign` (a file that is not
   * ours, left as it is), `npm` (npm's own link with prefix `~/.local`, left),
   * `failed` (not written), `skipped` (no launcher for this run).
   */
  state: 'written' | 'current' | 'foreign' | 'npm' | 'failed' | 'skipped';
  /** Is the launcher folder on this environment's PATH? */
  onPath: boolean;
  /** The line that puts it there, when it is not. */
  pathLine?: string;
  reason?: string;
}

export const launcherNames = (platform: NodeJS.Platform): string[] =>
  platform === 'win32' ? ['tenjin', 'tenjin.cmd'] : ['tenjin'];

/** The line that adds `~/.local/bin` to PATH for the shell this environment runs. Install prints it; it never edits a shell file. */
export function pathLine(env: NodeJS.ProcessEnv, _home: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    return `[Environment]::SetEnvironmentVariable('Path', "$env:USERPROFILE\\.local\\bin;" + [Environment]::GetEnvironmentVariable('Path','User'), 'User')`;
  }
  const add = `echo 'export PATH="$HOME/.local/bin:$PATH"' >>`;
  const shell = basename(env.SHELL ?? '');
  if (shell === 'zsh') return `${add} ~/.zshrc`;
  if (shell === 'bash') return `${add} ${platform === 'darwin' ? '~/.bash_profile' : '~/.bashrc'}`;
  if (shell === 'fish') return 'fish_add_path ~/.local/bin';
  return 'export PATH="$HOME/.local/bin:$PATH"';
}

function onPath(dir: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  const p = platform === 'win32' ? win32 : posix;
  const raw = (platform === 'win32' ? (env.Path ?? env.PATH) : env.PATH) ?? '';
  const norm = (value: string) => {
    const full = p.resolve(value).replace(/[\\/]+$/, '');
    return platform === 'win32' ? full.toLowerCase() : full;
  };
  const want = norm(dir);
  return raw
    .split(p.delimiter)
    .filter((entry) => entry.length > 0)
    .some((entry) => norm(entry) === want);
}

/** npm's own `tenjin` (npm prefix `~/.local`): a link into a tenjin-cli package, or its shim naming one. */
async function npmsOwn(path: string, isLink: boolean, body: string | null): Promise<boolean> {
  if (isLink) {
    try {
      return packageRootOf(dirname(await realpath(path))) !== null;
    } catch {
      return false;
    }
  }
  return body !== null && /node_modules[\\/]tenjin-cli[\\/]/.test(body);
}

type LauncherFile = { state: 'absent' | 'ours' | 'npm' | 'foreign'; body: string | null };

export async function inspectLauncher(path: string): Promise<LauncherFile> {
  let link;
  try {
    link = await lstat(path);
  } catch {
    return { state: 'absent', body: null };
  }
  const body = await readFile(path, 'utf8').catch(() => null);
  if (await npmsOwn(path, link.isSymbolicLink(), body)) return { state: 'npm', body };
  if (!link.isSymbolicLink() && body !== null && body.includes(LAUNCHER_MARKER)) {
    return { state: 'ours', body };
  }
  return { state: 'foreign', body };
}

/**
 * THE `tenjin` LAUNCHER IN `~/.local/bin` (and `tenjin.cmd` beside it on
 * Windows), written atomically at 0o755, so a terminal finds Tenjin with no npm
 * folder and no `node` on PATH. Only a file carrying {@link LAUNCHER_MARKER} is
 * ever replaced: npm's own link is left as `npm` and anything else as
 * `foreign`. Never throws; a write that fails is `failed`, and the runtime
 * works without it.
 */
export async function writeLaunchers(
  home: string,
  launch: RuntimeLaunch,
  o: { env: NodeJS.ProcessEnv; platform?: NodeJS.Platform },
): Promise<LauncherResult> {
  const platform = o.platform ?? launch.platform ?? process.platform;
  const dir = launcherDir(home);
  const paths = launcherNames(platform).map((name) => join(dir, name));
  const found = onPath(dir, o.env, platform);
  const where = { onPath: found, ...(found ? {} : { pathLine: pathLine(o.env, home, platform) }) };
  let bodies: string[];
  try {
    const full = { ...launch, platform, home: launch.home ?? home };
    bodies = [renderLauncherSh(full), ...(platform === 'win32' ? [renderLauncherCmd(full)] : [])];
  } catch (err) {
    return {
      paths,
      state: 'failed',
      ...where,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  const existing = await Promise.all(paths.map(inspectLauncher));
  const foreign = paths.filter((_, i) => existing[i]!.state === 'foreign');
  if (foreign.length > 0) {
    return { paths, state: 'foreign', ...where, reason: `${foreign.join(', ')} is not Tenjin's` };
  }
  if (existing.some((f) => f.state === 'npm')) return { paths, state: 'npm', ...where };
  if (existing.every((f, i) => f.body === bodies[i])) return { paths, state: 'current', ...where };
  try {
    for (const [i, path] of paths.entries()) {
      if (existing[i]!.body !== bodies[i]) {
        await writeFileAtomic(path, bodies[i]!, { mode: 0o755, dirMode: 0o755 });
      }
    }
  } catch (err) {
    return {
      paths,
      state: 'failed',
      ...where,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  return { paths, state: 'written', ...where };
}

/** Remove the launchers this CLI wrote; anything without the marker is left and named. */
export async function removeLaunchers(
  home: string,
  platform: NodeJS.Platform = process.platform,
): Promise<{ removed: string[]; left: string[] }> {
  const removed: string[] = [];
  const left: string[] = [];
  for (const name of ['tenjin', 'tenjin.cmd']) {
    const path = join(launcherDir(home), name);
    const found = await inspectLauncher(path);
    if (found.state === 'absent') continue;
    if (found.state !== 'ours') {
      if (name === 'tenjin' || platform === 'win32') left.push(path);
      continue;
    }
    try {
      await rm(path, { force: true });
      removed.push(path);
    } catch {
      left.push(path);
    }
  }
  return { removed, left };
}
