import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { open, rm } from 'node:fs/promises';
import { join, posix, win32 } from 'node:path';
import { CliError } from './errors';

/**
 * WHAT THE RUNTIME DOWNLOADS, AND HOW: Node's own release archive and the npm
 * tarball of a tenjin-cli version, over https only, streamed to disk while
 * hashed, capped in size and time, and unpacked by the system's `tar` in exec
 * form. The checksums themselves are the caller's: the pin in `package.json`
 * for Node, the registry's `dist.integrity` for a tarball.
 */

/** The oldest glibc Node 24's prebuilt Linux binaries run on. */
const MIN_GLIBC = [2, 28] as const;

/** Node's release archives, by `nodeKey`. Anything else has no pinned build. */
const KEYS = new Set([
  'darwin-arm64',
  'darwin-x64',
  'linux-x64',
  'linux-arm64',
  'win-x64',
  'win-arm64',
]);

function glibcAtLeast(glibc: string, min: readonly [number, number]): boolean {
  const m = /^(\d+)\.(\d+)/.exec(glibc);
  if (m === null) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > min[0] || (major === min[0] && minor >= min[1]);
}

/**
 * The release-archive key for this machine, or null where Tenjin pins no Node:
 * musl (no glibc version at all), a glibc older than 2.28, and every platform
 * and architecture outside the six keys. A Rosetta x64 Node asks for
 * `darwin-x64`, which runs under Rosetta too.
 */
export function nodeKey(
  platform: NodeJS.Platform,
  arch: string,
  glibc: string | null | undefined,
): string | null {
  const os = platform === 'win32' ? 'win' : platform;
  const key = `${os}-${arch}`;
  if (!KEYS.has(key)) return null;
  if (platform === 'linux' && (typeof glibc !== 'string' || !glibcAtLeast(glibc, MIN_GLIBC))) {
    return null;
  }
  return key;
}

/**
 * Why Tenjin pins no Node for this machine, or null when it pins one: the
 * platform and architecture, and on Linux the C library that rules it out.
 * Said by install and doctor so the cause is named, never a pinned key.
 */
export function unpinnedPlatform(
  platform: NodeJS.Platform,
  arch: string,
  glibc: string | null | undefined,
): string | null {
  if (nodeKey(platform, arch, glibc) !== null) return null;
  const key = `${platform === 'win32' ? 'win' : platform}-${arch}`;
  if (platform !== 'linux' || !KEYS.has(key)) return key;
  return typeof glibc === 'string'
    ? `${key} with glibc ${glibc}, older than ${MIN_GLIBC.join('.')}`
    : `${key} with musl, not glibc`;
}

/** The glibc this Node runs on, or null: musl, or a report that cannot be read. */
export function runningGlibc(): string | null {
  try {
    const report = process.report.getReport() as { header?: { glibcVersionRuntime?: string } };
    return report.header?.glibcVersionRuntime ?? null;
  } catch {
    return null;
  }
}

export interface NodeArtifact {
  key: string;
  url: string;
  /** The archive's name in the release, the name `SHASUMS256.txt` lists. */
  file: string;
  /** The one archive member the runtime keeps: the `node` binary. */
  member: string;
}

export function nodeArtifact(version: string, key: string): NodeArtifact {
  const base = `node-v${version}-${key}`;
  const windows = key.startsWith('win-');
  const file = `${base}.${windows ? 'zip' : 'tar.gz'}`;
  return {
    key,
    url: `https://nodejs.org/dist/v${version}/${file}`,
    file,
    member: windows ? `${base}/node.exe` : `${base}/bin/node`,
  };
}

function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Stream `url` into a fresh file under `dir`, hashing as it goes. Refuses a URL
 * (or a redirect's final URL) that is not https, aborts past `maxBytes` or
 * `timeoutMs`, and unlinks the file on any failure, so a caller never finds a
 * half download. A transport failure is `NETWORK_ERROR`; the caller adds its fix.
 */
export async function download(
  url: string,
  o: {
    dir: string;
    maxBytes: number;
    timeoutMs: number;
    hash: 'sha256' | 'sha512';
    fetchImpl?: typeof fetch;
  },
): Promise<{ file: string; digest: Buffer }> {
  if (!isHttps(url)) {
    throw new CliError('UPDATE_FAILED', `refused to download ${url}: only https is allowed`);
  }
  const file = join(o.dir, `dl-${randomBytes(6).toString('hex')}`);
  const handle = await open(file, 'wx', 0o600);
  let closed = false;
  try {
    let res: Response;
    try {
      res = await (o.fetchImpl ?? fetch)(url, { signal: AbortSignal.timeout(o.timeoutMs) });
    } catch (err) {
      throw new CliError('NETWORK_ERROR', `could not download ${url}: ${messageOf(err)}`, {
        cause: err,
      });
    }
    if (res.url !== '' && !isHttps(res.url)) {
      throw new CliError('UPDATE_FAILED', `refused ${url}: it redirected to ${res.url}`);
    }
    if (!res.ok || res.body === null) {
      throw new CliError('NETWORK_ERROR', `could not download ${url}: HTTP ${res.status}`);
    }
    const tooLarge = () =>
      new CliError('UPDATE_FAILED', `the download from ${url} is larger than ${o.maxBytes} bytes`);
    if (Number(res.headers.get('content-length') ?? 0) > o.maxBytes) throw tooLarge();
    const hash = createHash(o.hash);
    let size = 0;
    try {
      for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
        size += chunk.byteLength;
        if (size > o.maxBytes) throw tooLarge();
        hash.update(chunk);
        await handle.write(chunk);
      }
    } catch (err) {
      if (err instanceof CliError) throw err;
      throw new CliError('NETWORK_ERROR', `could not download ${url}: ${messageOf(err)}`, {
        cause: err,
      });
    }
    await handle.close();
    closed = true;
    return { file, digest: hash.digest() };
  } catch (err) {
    if (!closed) await handle.close().catch(() => undefined);
    await rm(file, { force: true }).catch(() => undefined);
    throw err;
  }
}

function messageOf(err: unknown): string {
  if (err instanceof Error) {
    return err.name === 'TimeoutError' ? 'it timed out' : err.message;
  }
  return String(err);
}

/** How `extract` runs `tar`: exec form, no shell, in `cwd`. A seam for tests. */
export type ExtractSpawn = (
  command: string,
  args: string[],
  o: { cwd: string },
) => Promise<{ code: number | null; stderr: string }>;

const spawnTar: ExtractSpawn = (command, args, o) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: o.cwd,
      shell: false,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 4096) stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr }));
  });

/**
 * Unpack `archive` into `dest` with the system's `tar`: `tar -xzf` on POSIX,
 * and on Windows `System32\tar.exe -xf`, which is bsdtar and reads a `.zip`
 * (Git's GNU tar, earlier on many PATHs, does not). `member` limits it to one
 * file, `strip` drops leading folders. A non-zero exit throws with what tar said.
 *
 * TAR RUNS IN THE ARCHIVE'S FOLDER and is given names relative to it. bsdtar
 * reads its argv in the ANSI code page, so a user folder named outside it
 * (Cyrillic on cp1252, an emoji) would reach it as `?`; the working directory
 * goes to Windows as a wide string, and the names it is given are the
 * runtime's own ASCII ones.
 */
export async function extract(
  archive: string,
  dest: string,
  o: { member?: string; strip?: number; platform?: NodeJS.Platform; spawnImpl?: ExtractSpawn } = {},
): Promise<void> {
  const windows = (o.platform ?? process.platform) === 'win32';
  const command = windows
    ? win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';
  const path = windows ? win32 : posix;
  const cwd = path.dirname(archive);
  const into = path.relative(cwd, dest);
  const args = [
    windows ? '-xf' : '-xzf',
    path.basename(archive),
    '-C',
    into === '' ? '.' : into.startsWith('..') || path.isAbsolute(into) ? dest : into,
    ...(o.strip !== undefined && o.strip > 0 ? [`--strip-components=${o.strip}`] : []),
    ...(o.member !== undefined ? [o.member] : []),
  ];
  const run = await (o.spawnImpl ?? spawnTar)(command, args, { cwd });
  if (run.code !== 0) {
    const said = run.stderr.trim().slice(0, 300);
    throw new Error(`tar could not unpack ${archive} (exit ${run.code})${said ? `: ${said}` : ''}`);
  }
}
