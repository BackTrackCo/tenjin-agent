import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { GIT_WALK_MAX, repoSlug } from '../../lib/state-store';

/**
 * The repo slug the coarse keys are salted with: the `url` under
 * `[remote "origin"]` in `.git/config`, found by walking up from `cwd`,
 * reduced to `host/full/path` by `repoSlug` (tenjin-agent#249). A worktree's
 * `.git` is a file naming its gitdir, whose `commondir` holds the shared
 * config, so a worktree salts the same as its main checkout.
 *
 * '' WHEN THERE IS NO ORIGIN, and that is not a salt: the arm sends no coarse
 * key at all rather than pool every origin-less checkout into one bucket
 * (decision 13). A FILE READ, NO GIT SPAWN: a hook does not start a process
 * in front of a tool call. `fs.promises`, because this runs on the hook path
 * of a daemon that serves every session and a stalled mount must cost a
 * `deadline` row, never a hung daemon.
 */
export async function repoSlugOf(cwd: string): Promise<string> {
  if (cwd.length === 0) return '';
  let dir = cwd;
  for (let i = 0; i < GIT_WALK_MAX; i += 1) {
    const config = await gitConfigPath(dir);
    if (config !== null) return repoSlug(await originUrl(config));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '';
}

/** The config file of the repository whose `.git` sits in `dir`, or null. */
async function gitConfigPath(dir: string): Promise<string | null> {
  const dotGit = join(dir, '.git');
  let st;
  try {
    st = await stat(dotGit);
  } catch {
    return null;
  }
  if (st.isDirectory()) return join(dotGit, 'config');
  let text: string;
  try {
    text = await readFile(dotGit, 'utf8');
  } catch {
    return null;
  }
  const m = /^gitdir:\s*(.+)$/m.exec(text);
  if (m === null) return null;
  const gitdir = resolve(dir, (m[1] ?? '').trim());
  let common = gitdir;
  try {
    common = resolve(gitdir, (await readFile(join(gitdir, 'commondir'), 'utf8')).trim());
  } catch {
    // Not a worktree: the gitdir is the repository itself.
  }
  return join(common, 'config');
}

/** `url` under `[remote "origin"]`, or ''. A line scan, not an INI parser:
 *  the two shapes git writes are all it has to read. */
async function originUrl(configPath: string): Promise<string> {
  let text: string;
  try {
    text = await readFile(configPath, 'utf8');
  } catch {
    return '';
  }
  let inOrigin = false;
  for (const line of text.split('\n')) {
    const section = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (section !== null) {
      inOrigin = /^remote\s+"origin"$/.test((section[1] ?? '').trim());
      continue;
    }
    if (!inOrigin) continue;
    const m = /^\s*url\s*=\s*(.+?)\s*$/.exec(line);
    if (m !== null) return m[1] ?? '';
  }
  return '';
}
