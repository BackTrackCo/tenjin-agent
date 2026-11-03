import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { SEND_MAX_UNSET, loadRawConfig, resolveSettings } from './config';
import type { SpendPolicy } from './policy';
import type { CommandContext } from '../context';

/**
 * The effective runtime settings a command needs, resolved once through the
 * same precedence (flag > env > file > default) `config` uses. Spend values
 * arrive atomic from config and are handed on as bigint for the policy layer.
 */
export interface ResolvedSettings {
  /** The router's base URL. */
  baseUrl: string;
  rpcUrl: string;
  policy: SpendPolicy;
  /** x402 discovery registries the direct pay lane verifies against. */
  bazaarRegistries: string[];
  /** `experimental.bazaar`: whether the router may also offer the open Bazaar's
   *  unreviewed sellers. Tenjin's reviewed list is always requested; only
   *  `router.enabled false` stops every offer. */
  experimentalBazaar: boolean;
  /**
   * Hard per-send cap for `tenjin wallet send`: SEND_MAX_UNSET = never configured
   * (send refuses until `config set sendMaxAmount`), null = explicit "none"
   * (uncapped opt-in), 0n = disabled, otherwise the atomic cap.
   */
  sendMaxAmountAtomic: bigint | null | typeof SEND_MAX_UNSET;
}

export async function resolveContextSettings(ctx: CommandContext): Promise<ResolvedSettings> {
  const config = await loadRawConfig(ctx.dataDir);
  const s = resolveSettings({ config, flags: { baseUrl: ctx.flags.baseUrl }, env: process.env });
  return {
    baseUrl: s.baseUrl.value,
    rpcUrl: s.rpcUrl.value,
    bazaarRegistries: s.bazaarRegistries.value,
    experimentalBazaar: s.experimentalBazaar.value === 'on',
    sendMaxAmountAtomic:
      s.sendMaxAmount.value === SEND_MAX_UNSET
        ? SEND_MAX_UNSET
        : s.sendMaxAmount.value === 'none'
          ? null
          : BigInt(s.sendMaxAmount.value),
    policy: {
      maxAutoSpendAtomic: BigInt(s.maxAutoSpend.value),
      sessionBudgetAtomic: s.sessionBudget.value === 'none' ? null : BigInt(s.sessionBudget.value),
      allowlistCreators: s.allowlistCreators.value,
    },
  };
}

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
 * THE ONE WALK UP FROM A WORKING DIRECTORY to the router's `.tenjin/config.json`
 * pair: the nearest directory, walking up from `cwd`, that holds at least one of
 * `names` (paths relative to that directory). `homeIsProject: false` stops
 * before looking in $HOME itself, for a file whose home copy is the global one.
 */
export async function findNearestProjectFiles(
  cwd: string,
  names: readonly string[],
  deps: ProjectWalkDeps & { homeIsProject?: boolean } = {},
): Promise<ProjectWalkHit | null> {
  const homeDir = deps.homeDir ?? homedir();

  let dir = cwd;
  // Bounded by $HOME (a shared-host trust boundary) and the filesystem root
  // (dirname('/') === '/'), whichever comes first.
  for (;;) {
    if (dir === homeDir && deps.homeIsProject === false) return null;
    const found = await ownedCandidates(dir, names, deps);
    if (found.length > 0) return { dir, found };
    if (await pathExists(join(dir, '.git'))) return null; // repo root, no file
    if (dir === homeDir) return null; // never cross above $HOME
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * EVERY directory from `cwd` up to the git root (inclusive) that holds one of
 * `names`, nearest first, under the same bounds as
 * {@link findNearestProjectFiles}; `gitRoot` is null outside a repository.
 * For layers that each only tighten, where reading one more can never loosen.
 */
export async function findAllProjectFiles(
  cwd: string,
  names: readonly string[],
  deps: ProjectWalkDeps & { homeIsProject?: boolean } = {},
): Promise<{ levels: ProjectWalkHit[]; gitRoot: string | null }> {
  const homeDir = deps.homeDir ?? homedir();
  const levels: ProjectWalkHit[] = [];
  let dir = cwd;
  for (;;) {
    if (dir === homeDir && deps.homeIsProject === false) return { levels, gitRoot: null };
    const found = await ownedCandidates(dir, names, deps);
    if (found.length > 0) levels.push({ dir, found });
    if (await pathExists(join(dir, '.git'))) return { levels, gitRoot: dir };
    if (dir === homeDir) return { levels, gitRoot: null };
    const parent = dirname(dir);
    if (parent === dir) return { levels, gitRoot: null };
    dir = parent;
  }
}

/**
 * The main working tree behind a git worktree whose root is `gitRoot`, or null
 * when `gitRoot` is not a linked worktree. Filesystem only, no `git` process:
 * the worktree's `.git` FILE names its gitdir, whose `commondir` names the
 * main repository's `.git`. A bare common dir, one that resolves outside
 * $HOME, and a submodule (a gitdir with no `commondir`) all give null.
 */
export async function mainWorktreeOf(
  gitRoot: string,
  homeDir: string = homedir(),
): Promise<string | null> {
  try {
    const dotGit = join(gitRoot, '.git');
    if (!(await stat(dotGit)).isFile()) return null;
    const line = /^gitdir:\s*(.+?)\s*$/m.exec(await readFile(dotGit, 'utf8'));
    if (line === null) return null;
    const gitdir = resolve(gitRoot, line[1]!);
    const commonDir = resolve(gitdir, (await readFile(join(gitdir, 'commondir'), 'utf8')).trim());
    if (basename(commonDir) !== '.git' || !(await stat(commonDir)).isDirectory()) return null;
    const main = dirname(commonDir);
    if (main === gitRoot || !main.startsWith(`${homeDir}${sep}`)) return null;
    return main;
  } catch {
    return null;
  }
}

/** The candidates present in `dir` and owned by this user, in `names` order. */
export async function ownedCandidates(
  dir: string,
  names: readonly string[],
  deps: ProjectWalkDeps = {},
): Promise<string[]> {
  const isForeignOwned = deps.isForeignOwned ?? defaultIsForeignOwned;
  const warn = deps.warn ?? ((message: string) => process.stderr.write(`${message}\n`));
  const found: string[] = [];
  for (const name of names) {
    const candidate = join(dir, name);
    if (!(await pathExists(candidate))) continue;
    if (await isForeignOwned(candidate)) {
      // A file owned by another user (e.g. /tmp/.tenjin/config.json on a shared box)
      // must never become the honored layer; skip it and keep walking.
      warn(`Ignoring ${candidate}: not owned by the current user.`);
    } else {
      found.push(candidate);
    }
  }
  return found;
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
