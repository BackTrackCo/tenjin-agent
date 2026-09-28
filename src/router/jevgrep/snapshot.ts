import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import ignore, { type Ignore } from 'ignore';
import { lstat, mkdir, open, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';

export const SNAPSHOT_LIMITS = {
  files: 512,
  fileBytes: 128 * 1024,
  totalBytes: 8 * 1024 * 1024,
} as const;
export type SnapshotSummary = {
  files: number;
  bytes: number;
  commit: string;
  omitted: number;
  source: 'git-head-committed-only';
};
const sourceExtensions =
  /\.(?:[cm]?[jt]sx?|py|rs|go|java|kt|kts|c|h|cc|cpp|hpp|cs|rb|php|swift|scala|sh|bash|zsh|sql|graphql|gql|proto|md|mdx|rst|txt|json|toml|ya?ml|xml|html?|css|scss|svelte|vue)$/i;
const excludedDirectories = new Set([
  'node_modules',
  'vendor',
  'dist',
  'build',
  'target',
  'coverage',
  '__pycache__',
  'venv',
  'env',
  'credentials',
  'secrets',
  'wallets',
]);
const secretFile =
  /(?:^|[._-])(?:secrets?|credentials?|private[-_]?keys?|keystore|wallet|seed|mnemonic)(?:[._-]|$)/i;
const secretContent = [
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})\b/,
  /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{32,})\b/,
  /\b(?:private[_-]?key|mnemonic|seed[_-]?phrase|api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*["'][^"'\r\n]{24,}["']/i,
];

export function isSnapshotSourcePath(path: string): boolean {
  if (
    !path ||
    isAbsolute(path) ||
    path.includes('\\') ||
    [...path].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    return false;
  const parts = path.split('/');
  if (
    parts.some(
      (part) =>
        !part ||
        part === '..' ||
        part.startsWith('.') ||
        excludedDirectories.has(part.toLowerCase()),
    )
  )
    return false;
  const name = parts.at(-1)!;
  if (
    secretFile.test(name) ||
    /(?:lock|shrinkwrap)\.(?:json|yaml|yml)$|\.lock$|\.(?:pem|key|p12|pfx|crt|cert)$/i.test(name)
  )
    return false;
  return sourceExtensions.test(name) || /^(?:Dockerfile|Makefile|LICENSE|README)$/i.test(name);
}

export class SnapshotPolicyUnavailable extends Error {}
function rulePath(path: string): boolean {
  const parts = path.split('/');
  const name = parts.pop();
  return (
    (name === '.gitignore' || name === '.ignore') &&
    parts.every(
      (part) => part && !part.startsWith('.') && !excludedDirectories.has(part.toLowerCase()),
    )
  );
}
function ignoredByRules(path: string, rules: Map<string, Ignore>): boolean {
  const parts = path.split('/');
  for (let index = 0; index < parts.length; index++) {
    const candidate = parts.slice(0, index + 1).join('/') + (index < parts.length - 1 ? '/' : '');
    let excluded = false;
    for (let depth = 0; depth <= index; depth++) {
      const directory = parts.slice(0, depth).join('/');
      const prefix = directory ? `${directory}/` : '';
      for (const name of ['.gitignore', '.ignore']) {
        const match = rules.get(prefix + name)?.test(candidate.slice(prefix.length));
        if (match?.ignored) excluded = true;
        else if (match?.unignored) excluded = false;
      }
    }
    if (excluded) return true;
  }
  return false;
}

// Only inspect local policy metadata at committed-source ancestor directories.
// Untracked directories cannot contain an ancestor rule for committed source.
async function verifyCurrentRules(
  root: string,
  rules: Map<string, Buffer>,
  directories: Set<string>,
  signal: AbortSignal,
) {
  if (directories.size > 4096) throw new SnapshotPolicyUnavailable('Ignore policy exceeds limits');
  try {
    for (const directory of directories) {
      signal.throwIfAborted();
      const parts = directory ? directory.split('/') : [];
      if (parts.length > 32) throw new Error('Directory depth limit');
      const ancestors = [];
      for (let index = 0; index <= parts.length; index++) {
        const path = join(root, ...parts.slice(0, index));
        const stat = await lstat(path, { bigint: true });
        if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(path)) !== path)
          throw new Error('Unsafe ignore directory');
        ancestors.push({ path, stat });
      }
      for (const name of ['.gitignore', '.ignore']) {
        const path = directory ? `${directory}/${name}` : name;
        const expected = rules.get(path);
        let file;
        try {
          file = await open(
            join(root, path),
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT' && expected === undefined)
            continue;
          throw error;
        }
        try {
          const before = await file.stat({ bigint: true });
          if (!before.isFile() || before.size > 65536n || expected === undefined)
            throw new Error('Changed ignore policy');
          const bytes = Buffer.alloc(Number(before.size) + 1);
          let count = 0;
          while (count < bytes.length) {
            signal.throwIfAborted();
            const result = await file.read(bytes, count, bytes.length - count, count);
            if (!result.bytesRead) break;
            count += result.bytesRead;
          }
          const after = await file.stat({ bigint: true });
          if (
            before.ino !== after.ino ||
            before.dev !== after.dev ||
            before.size !== after.size ||
            before.mtimeNs !== after.mtimeNs ||
            before.ctimeNs !== after.ctimeNs ||
            !bytes.subarray(0, count).equals(expected)
          )
            throw new Error('Changed ignore policy');
        } finally {
          await file.close();
        }
      }
      for (const before of ancestors) {
        const after = await lstat(before.path, { bigint: true });
        if (
          !after.isDirectory() ||
          after.ino !== before.stat.ino ||
          after.dev !== before.stat.dev ||
          after.mtimeNs !== before.stat.mtimeNs ||
          after.ctimeNs !== before.stat.ctimeNs ||
          (await realpath(before.path)) !== before.path
        )
          throw new Error('Ignore directory changed');
      }
    }
  } catch {
    signal.throwIfAborted();
    throw new SnapshotPolicyUnavailable(
      'Current ignore rules differ from committed rules or cannot be safely checked',
    );
  }
}

function git(
  root: string,
  args: string[],
  signal: AbortSignal,
  maxBuffer: number,
): Promise<Buffer> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    execFile(
      '/usr/bin/git',
      [
        '--no-pager',
        '--literal-pathspecs',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'protocol.allow=never',
        '-c',
        `safe.directory=${root}`,
        '-C',
        root,
        ...args,
      ],
      {
        encoding: 'buffer',
        maxBuffer,
        timeout: 15_000,
        killSignal: 'SIGKILL',
        signal,
        env: {
          PATH: '/usr/bin:/bin',
          LANG: 'C.UTF-8',
          GIT_TERMINAL_PROMPT: '0',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_NO_REPLACE_OBJECTS: '1',
          GIT_NO_LAZY_FETCH: '1',
          GIT_ALLOW_PROTOCOL: '',
        },
      },
      (error, stdout) => {
        if (error)
          reject(
            new Error(
              signal.aborted
                ? 'Snapshot cancelled'
                : 'Could not read committed repository snapshot',
            ),
          );
        else resolve(stdout);
      },
    );
  });
}

/** Read immutable Git blobs, never mutable working-tree paths or smudge filters. */
export async function createJevgrepSnapshot(options: {
  root: string;
  destination: string;
  signal: AbortSignal;
}): Promise<SnapshotSummary> {
  const { signal } = options;
  signal.throwIfAborted();
  const root = await realpath(options.root);
  const top = await realpath(
    (await git(root, ['rev-parse', '--show-toplevel'], signal, 8192)).toString('utf8').trim(),
  );
  const scope = relative(top, root);
  if (scope !== '')
    throw new SnapshotPolicyUnavailable('Approved root must be the repository root');
  const commit = (await git(root, ['rev-parse', '--verify', 'HEAD^{commit}'], signal, 256))
    .toString('utf8')
    .trim();
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(commit)) throw new Error('Invalid snapshot commit');
  const listing = await git(
    top,
    ['ls-tree', '-r', '-l', '-z', commit, '--'],
    signal,
    2 * 1024 * 1024,
  );
  const entries = new TextDecoder('utf-8', { fatal: true })
    .decode(listing)
    .split('\0')
    .filter(Boolean);
  const summary: SnapshotSummary = {
    files: 0,
    bytes: 0,
    commit,
    omitted: 0,
    source: 'git-head-committed-only',
  };
  const selected: Array<{ path: string; oid: string; size: number }> = [];
  const rules = new Map<string, Ignore>();
  const ruleBytes = new Map<string, Buffer>();
  const ruleEntries: Array<{ path: string; oid: string; size: number }> = [];
  const directories = new Set<string>(['']);
  for (const entry of entries) {
    const match = /^(\d{6}) (\S+) ([a-f0-9]+)\s+(\d+|-)\t([\s\S]+)$/.exec(entry);
    if (!match) throw new Error('Invalid repository tree listing');
    const [, mode, type, oid, rawSize, fullPath] = match;
    const path = fullPath!;
    const size = Number(rawSize);
    if (rulePath(path)) {
      if (
        !['100644', '100755'].includes(mode!) ||
        type !== 'blob' ||
        !Number.isSafeInteger(size) ||
        size > 64 * 1024
      )
        throw new SnapshotPolicyUnavailable('Unsupported committed ignore policy');
      ruleEntries.push({ path, oid: oid!, size });
      if (
        ruleEntries.length > 128 ||
        ruleEntries.reduce((sum, rule) => sum + rule.size, 0) > 512 * 1024
      )
        throw new SnapshotPolicyUnavailable('Committed ignore policy exceeds limits');
      continue;
    }
    if (
      !['100644', '100755'].includes(mode!) ||
      type !== 'blob' ||
      !isSnapshotSourcePath(path) ||
      !Number.isSafeInteger(size) ||
      size > SNAPSHOT_LIMITS.fileBytes
    ) {
      summary.omitted++;
      continue;
    }
    selected.push({ path, oid: oid!, size });
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index++)
      directories.add(parts.slice(0, index).join('/'));
  }
  for (const rule of ruleEntries) {
    const content = await git(top, ['cat-file', 'blob', rule.oid], signal, 64 * 1024 + 1);
    if (content.length !== rule.size || content.includes(0))
      throw new SnapshotPolicyUnavailable('Invalid committed ignore policy');
    rules.set(rule.path, ignore().add(new TextDecoder('utf-8', { fatal: true }).decode(content)));
    ruleBytes.set(rule.path, content);
  }
  await verifyCurrentRules(root, ruleBytes, directories, signal);
  const eligible = selected.filter((file) => {
    if (ignoredByRules(file.path, rules)) {
      summary.omitted++;
      return false;
    }
    return true;
  });
  const selectedBytes = eligible.reduce((sum, file) => sum + file.size, 0);
  if (eligible.length > SNAPSHOT_LIMITS.files || selectedBytes > SNAPSHOT_LIMITS.totalBytes)
    throw new Error('Approved repository exceeds committed snapshot pilot limits');
  signal.throwIfAborted();
  await mkdir(options.destination, { mode: 0o700 });
  for (const entry of eligible) {
    signal.throwIfAborted();
    const content = await git(
      top,
      ['cat-file', 'blob', entry.oid],
      signal,
      SNAPSHOT_LIMITS.fileBytes + 1,
    );
    if (content.length !== entry.size) throw new Error('Snapshot blob size changed');
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(content);
    } catch {
      summary.omitted++;
      continue;
    }
    if (content.includes(0) || secretContent.some((pattern) => pattern.test(text))) {
      summary.omitted++;
      continue;
    }
    signal.throwIfAborted();
    const target = join(options.destination, entry.path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, content, { mode: 0o400, flag: 'wx' });
    summary.files++;
    summary.bytes += content.length;
  }
  await verifyCurrentRules(root, ruleBytes, directories, signal);
  if (!summary.files) throw new Error('No eligible committed text source in approved root');
  return summary;
}
