import { readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/**
 * Derive the deterministic publish-time scan context from the source project:
 * the git remote `org/repo` slugs of the repository containing `cwd` (the
 * open-questions publishing-safety "private repository/org names" check). A
 * draft written while working in a project routinely quotes that project's own
 * remote or slug; the scan treats those as private-by-default and warns.
 *
 * Offline and best-effort by design: a plain filesystem read of `.git/config`
 * (including the worktree `.git`-file indirection), no `git` subprocess, no
 * network. Anything unreadable or unparseable yields `[]` — the scan must never
 * fail a publish because the source dir is not a git checkout.
 */
export async function deriveProjectMarkers(cwd: string): Promise<string[]> {
  try {
    const configPath = await findGitConfig(resolve(cwd));
    if (configPath === undefined) return [];
    const config = await readFile(configPath, 'utf8');
    return extractRemoteSlugs(config);
  } catch {
    return [];
  }
}

/** Walk up from `dir` to the filesystem root looking for a `.git` dir or file. */
async function findGitConfig(dir: string): Promise<string | undefined> {
  for (let current = dir; ; current = dirname(current)) {
    const dotGit = join(current, '.git');
    const s = await stat(dotGit).catch(() => undefined);
    if (s?.isDirectory() === true) return join(dotGit, 'config');
    if (s?.isFile() === true) {
      const resolved = await resolveGitFile(dotGit, current);
      if (resolved !== undefined) return resolved;
    }
    if (dirname(current) === current) return undefined;
  }
}

/**
 * A `.git` FILE is a worktree/submodule indirection: `gitdir: <path>`. The
 * shared config lives in the common dir (a `commondir` file inside the gitdir
 * points at it); a submodule's gitdir carries its own `config` directly.
 */
async function resolveGitFile(
  dotGitFile: string,
  containingDir: string,
): Promise<string | undefined> {
  const content = await readFile(dotGitFile, 'utf8');
  const m = /^gitdir:\s*(.+)\s*$/m.exec(content);
  if (m?.[1] === undefined) return undefined;
  const gitdir = isAbsolute(m[1]) ? m[1] : resolve(containingDir, m[1]);
  const commondirFile = await readFile(join(gitdir, 'commondir'), 'utf8').catch(() => undefined);
  if (commondirFile !== undefined) {
    const common = commondirFile.trim();
    return join(isAbsolute(common) ? common : resolve(gitdir, common), 'config');
  }
  return join(gitdir, 'config');
}

// `url = <value>` lines; git config keys are case-insensitive.
const URL_LINE = /^\s*url\s*=\s*(.+?)\s*$/gim;

/**
 * Reduce each remote URL to its repository path slug (`org/repo`, or the full
 * `group/sub/repo` path on deep hosts), handling both scp-like
 * (`git@host:org/repo.git`) and URL (`https://host/org/repo.git`,
 * `ssh://git@host/org/repo`) forms. The slug — not the bare repo name — is the
 * marker: a bare name is too collision-prone against ordinary prose.
 */
export function extractRemoteSlugs(gitConfig: string): string[] {
  const slugs = new Set<string>();
  URL_LINE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_LINE.exec(gitConfig)) !== null) {
    const slug = slugFromRemoteUrl(m[1] ?? '');
    if (slug !== undefined) slugs.add(slug);
  }
  return [...slugs];
}

function slugFromRemoteUrl(url: string): string | undefined {
  let path: string | undefined;
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/@\s]+@)?[^/\s]+\/(.+)$/i.exec(url);
  const scp = /^[^/@\s]+@[^:/\s]+:(.+)$/.exec(url);
  if (scheme !== null) path = scheme[1];
  else if (scp !== null) path = scp[1];
  if (path === undefined) return undefined;
  const slug = path
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '');
  // A slug needs at least org/name to be a meaningful private-reference marker.
  return slug.includes('/') && slug.length >= 3 ? slug : undefined;
}
