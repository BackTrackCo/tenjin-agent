import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathExists, projectRoot } from '../lib/settings';
import type { Packet } from './context';
import type { Harness } from './names';

/**
 * THE USER'S OWN LINKS, which the host opens with its own tools: a pull
 * request on the forge this repository pushes to, a claude.ai artifact. A
 * paid page reader is never the answer to one, so the packet names them
 * (`ownUrls`) and the server keeps page reading off them.
 *
 * Two sources. The hosts of the git remotes of the repository the hook's
 * working directory is in, read from its git config file and nothing else (no
 * `git` process): an ssh alias or an `insteadOf` rewrite is not resolved, and
 * a repository with no remote has none. And the harness's own link hosts:
 * claude.ai for Claude Code. Codex has none listed: no host is clearly its own
 * and open to its own tools.
 *
 * READ ONLY WHEN THE TURN HAS A LINK, and silent on any failure: a turn with
 * no literal URL costs nothing, and one that cannot be read names none.
 */

const HARNESS_HOSTS: Record<Harness, readonly string[]> = { claude: ['claude.ai'], codex: [] };

/** Past this a git config is not one this reader trusts to be small. */
const MAX_CONFIG_BYTES = 64 * 1024;

/** The hosts `seal` lists links on in `ownUrls`, for this packet. */
export async function ownHostsFor(
  packet: Packet,
  cwd: string,
  harness: Harness,
  homeDir: string = homedir(),
): Promise<string[]> {
  if (packet.literalUrls.length === 0) return [];
  return [...(await remoteHosts(cwd, homeDir)), ...HARNESS_HOSTS[harness]];
}

/** The hosts of every remote of the repository `cwd` is in; none outside one. Never throws. */
export async function remoteHosts(cwd: string, homeDir: string = homedir()): Promise<string[]> {
  try {
    const root = await projectRoot(cwd, homeDir);
    const dotGit = join(root, '.git');
    if (!(await pathExists(dotGit))) return [];
    const path = await configPath(dotGit);
    if ((await stat(path)).size > MAX_CONFIG_BYTES) return [];
    return remoteHostsIn(await readFile(path, 'utf8'));
  } catch {
    return [];
  }
}

/**
 * The config file behind a `.git`: in it for a checkout, and for a linked
 * worktree or a submodule (a `.git` file naming its gitdir) in the shared
 * repository its `commondir` names, else in that gitdir.
 */
async function configPath(dotGit: string): Promise<string> {
  if ((await stat(dotGit)).isDirectory()) return join(dotGit, 'config');
  const line = /^gitdir:\s*(.+?)\s*$/m.exec(await readFile(dotGit, 'utf8'));
  if (line === null) throw new Error('not a gitdir file');
  const gitdir = resolve(dotGit, '..', line[1]!);
  const common = await readFile(join(gitdir, 'commondir'), 'utf8').then(
    (text) => resolve(gitdir, text.trim()),
    () => gitdir,
  );
  return join(common, 'config');
}

/** Each `url` under a `[remote "…"]` section, as the host it names. */
export function remoteHostsIn(config: string): string[] {
  const hosts = new Set<string>();
  let inRemote = false;
  for (const raw of config.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inRemote = /^\[remote\s+"[^"]*"\]$/.test(line);
      continue;
    }
    const url = inRemote ? /^url\s*=\s*"?([^"]+?)"?\s*$/.exec(line)?.[1] : undefined;
    const host = url === undefined ? null : hostOfRemote(url);
    if (host !== null) hosts.add(host);
  }
  return [...hosts];
}

/** `scheme://[user@]host[:port]/path`, or git's scp form `[user@]host:path`. */
function hostOfRemote(remote: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(remote)) {
    try {
      const host = new URL(remote).hostname.toLowerCase();
      return host.length > 0 ? host : null;
    } catch {
      return null;
    }
  }
  const scp = /^(?:[^@/]+@)?([^:/\\]+):(?!\/\/)/.exec(remote);
  return scp?.[1] !== undefined && scp[1].includes('.') ? scp[1].toLowerCase() : null;
}
