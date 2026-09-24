import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * THE ONE WALK UP FROM A WORKING DIRECTORY to a project file, shared by the
 * shelf's `.tenjin.json` and the router's `.tenjin/config.json` pair.
 *
 * It stops at the first directory holding a `.git` (inclusive), never crosses
 * above $HOME, and skips a file another user owns with a stderr line, because a
 * planted file on a shared host must not become the honored layer.
 *
 * No zod and no config import: the router's status line runs this once a
 * second, and parsing a schema library per tick would cost more than the walk.
 */

export interface ProjectWalkDeps {
  /** Ownership seam; defaults to stat().uid vs process uid. Gates a planted file. */
  isForeignOwned?: (filePath: string) => Promise<boolean>;
  /** One-line stderr warning sink; defaults to process.stderr. */
  warn?: (message: string) => void;
  /** Upper bound of the walk; defaults to the user's home directory. */
  homeDir?: string;
}

export interface ProjectWalkHit {
  /** The directory the walk stopped in. */
  dir: string;
  /** Every candidate present there and owned by this user, in `names` order. */
  found: string[];
}

/**
 * The nearest directory, walking up from `cwd`, that holds at least one of
 * `names` (paths relative to that directory). `homeIsProject: false` stops
 * before looking in $HOME itself, for a file whose home copy is the global one.
 */
export async function findNearestProjectFiles(
  cwd: string,
  names: readonly string[],
  deps: ProjectWalkDeps & { homeIsProject?: boolean } = {},
): Promise<ProjectWalkHit | null> {
  const homeDir = deps.homeDir ?? homedir();
  const isForeignOwned = deps.isForeignOwned ?? defaultIsForeignOwned;
  const warn = deps.warn ?? ((message: string) => process.stderr.write(`${message}\n`));

  let dir = cwd;
  // Bounded by $HOME (a shared-host trust boundary) and the filesystem root
  // (dirname('/') === '/'), whichever comes first.
  for (;;) {
    if (dir === homeDir && deps.homeIsProject === false) return null;
    const found: string[] = [];
    for (const name of names) {
      const candidate = join(dir, name);
      if (!(await pathExists(candidate))) continue;
      if (await isForeignOwned(candidate)) {
        // A file owned by another user (e.g. /tmp/.tenjin.json on a shared box)
        // must never become the honored layer; skip it and keep walking.
        warn(`Ignoring ${candidate}: not owned by the current user.`);
      } else {
        found.push(candidate);
      }
    }
    if (found.length > 0) return { dir, found };
    if (await pathExists(join(dir, '.git'))) return null; // repo root, no file
    if (dir === homeDir) return null; // never cross above $HOME
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The directory a project file belongs in when none exists yet: the git root
 * above `cwd`, or `cwd` itself outside a repository. Same bounds as the walk.
 */
export async function projectRoot(cwd: string, homeDir: string = homedir()): Promise<string> {
  let dir = cwd;
  for (;;) {
    if (await pathExists(join(dir, '.git'))) return dir;
    if (dir === homeDir) return cwd;
    const parent = dirname(dir);
    if (parent === dir) return cwd;
    dir = parent;
  }
}

/**
 * True when the file is owned by a different uid than the process. On a platform
 * without a uid model (Windows: process.getuid is undefined) this is always
 * false — the ownership gate is a POSIX shared-host protection.
 */
async function defaultIsForeignOwned(filePath: string): Promise<boolean> {
  const uid = process.getuid?.();
  if (uid === undefined) return false;
  try {
    return (await stat(filePath)).uid !== uid;
  } catch {
    return false;
  }
}

/** True when a path exists (of any type). */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
