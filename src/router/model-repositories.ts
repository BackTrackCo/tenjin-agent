import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Informational GitHub names only: these never grant filesystem or disclosure access. */
export function modelGithubRepositories(roots: readonly string[]): string[] {
  const names = new Map<string, string>();
  for (const root of roots) {
    let children: string[] = [];
    try {
      children = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name !== '.git')
        .map((entry) => join(root, entry.name))
        .sort();
    } catch {
      // An unreadable optional root supplies no additional names.
    }
    for (const repository of [root, ...children]) {
      const name = originGithubRepository(repository);
      if (name) names.set(name.toLowerCase(), name);
    }
  }
  return [...names.values()];
}

function boundedText(path: string): string {
  const info = statSync(path);
  if (!info.isFile() || info.size > 64 * 1024) throw new Error('Unsupported Git metadata');
  return readFileSync(path, 'utf8');
}

function originGithubRepository(repository: string): string | null {
  try {
    const dotGit = join(repository, '.git');
    const marker = statSync(dotGit);
    let gitdir = dotGit;
    if (!marker.isDirectory()) {
      const target = /^gitdir:\s*(.+?)\s*$/m.exec(boundedText(dotGit))?.[1];
      if (!target) return null;
      gitdir = resolve(repository, target);
      try {
        gitdir = resolve(gitdir, boundedText(join(gitdir, 'commondir')).trim());
      } catch {
        // A submodule can have no common directory.
      }
    }
    let origin = false;
    for (const raw of boundedText(join(gitdir, 'config')).split('\n')) {
      const line = raw.trim();
      if (line.startsWith('[')) {
        origin = /^\[remote\s+"origin"\]$/.test(line);
        continue;
      }
      const value = origin ? /^url\s*=\s*"?([^"]+?)"?\s*$/.exec(line)?.[1] : undefined;
      if (value) return githubRepository(value);
    }
  } catch {
    // No origin, unsupported Git metadata or an unavailable checkout names nothing.
  }
  return null;
}

export function githubRepository(remote: string): string | null {
  let path: string;
  const scp = /^git@github\.com:([^?#\s]+)$/i.exec(remote);
  if (scp) path = scp[1]!;
  else {
    try {
      const url = new URL(remote);
      if (
        !['https:', 'ssh:'].includes(url.protocol) ||
        url.hostname.toLowerCase() !== 'github.com' ||
        url.search ||
        url.hash
      )
        return null;
      path = url.pathname.slice(1);
    } catch {
      return null;
    }
  }
  const name = path.replace(/\.git\/?$/, '').replace(/\/$/, '');
  return /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/.test(name)
    ? name
    : null;
}
