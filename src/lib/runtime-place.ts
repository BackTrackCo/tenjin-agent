import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import {
  chmod,
  cp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import { hasCode } from './errno';
import { CliError } from './errors';
import { withRuntimeLock, type RuntimeLockOptions } from './lock';
import {
  download,
  downloadViaCurl,
  extract,
  nodeArtifact,
  nodeKey,
  runningGlibc,
} from './runtime-fetch';
import { nodeBinPath, versionDir } from './runtime-layout';
import { checkReleaseProvenance } from './runtime-provenance';
import { parseVersion } from './version-order';

// ---------------------------------------------------------------------------
// The pin and the package
// ---------------------------------------------------------------------------

/** The Node a build runs on, from its `package.json` `tenjinRuntime.node`. */
export interface NodePin {
  version: string;
  /** Release-archive sha256 by `nodeKey`, from a signature-checked `SHASUMS256.txt`. */
  sha256: Record<string, string>;
}

export const NODE_VERSION_RE = /^\d+\.\d+\.\d+$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

/**
 * The Node pin a package carries, or null when it has none or it does not
 * hold. It is read from `package.json` so an older build can read a newer
 * version's pin as data, from a tarball whose integrity it already checked.
 */
export function readNodePin(packageRoot: string): NodePin | null {
  try {
    const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      tenjinRuntime?: { node?: { version?: unknown; sha256?: unknown } };
    };
    const node = pkg.tenjinRuntime?.node;
    if (typeof node?.version !== 'string' || !NODE_VERSION_RE.test(node.version)) return null;
    if (typeof node.sha256 !== 'object' || node.sha256 === null) return null;
    const sha256: Record<string, string> = {};
    for (const [key, value] of Object.entries(node.sha256)) {
      if (typeof value === 'string' && SHA256_RE.test(value)) sha256[key] = value;
    }
    return { version: node.version, sha256 };
  } catch {
    return null;
  }
}

/** The nearest folder above `moduleDir` whose `package.json` is tenjin-cli's. */
export function packageRootOf(moduleDir: string): string | null {
  let dir = moduleDir;
  for (let i = 0; i < 8; i += 1) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: unknown };
      if (pkg.name === 'tenjin-cli') return dir;
    } catch {
      // No package.json here, or not one this code reads: keep walking.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Placing Node and the CLI
// ---------------------------------------------------------------------------

const NODE_MAX_BYTES = 100 * 1024 * 1024;
const TARBALL_MAX_BYTES = 50 * 1024 * 1024;
const NODE_FIX = 'Check access to nodejs.org and run `tenjin install` again.';

export const rand = (): string => randomBytes(6).toString('hex');
export const tmpOf = (root: string): string => join(root, 'tmp');

/** Is `dir/.complete` present and naming `dir` itself? Anything else is a half copy. */
export function completeValid(dir: string): boolean {
  try {
    const marker = JSON.parse(readFileSync(join(dir, '.complete'), 'utf8')) as {
      version?: unknown;
    };
    return marker.version === basename(dir);
  } catch {
    return false;
  }
}

async function markComplete(dir: string, version: string): Promise<void> {
  await writeFile(join(dir, '.complete'), `${JSON.stringify({ version })}\n`);
}

/**
 * Mark a folder already in place as just placed (its `.complete` touched), so
 * a `collect` before the activation it is kept for spares it.
 */
async function touchComplete(dir: string): Promise<void> {
  const now = new Date();
  await utimes(join(dir, '.complete'), now, now).catch(() => undefined);
}

/** How long a Windows rename of a fresh folder is retried. */
const RENAME_RETRY_MS = 2_000;

/**
 * Rename a folder. On Windows, antivirus and the indexer briefly hold a file
 * just written inside it open, and the rename fails with EPERM, EACCES or
 * EBUSY meanwhile, so it is retried there for up to 2 s with backoff, as npm's
 * graceful-fs does. A failure that outlasts that (a running `node.exe`) stands.
 */
export async function renameDir(
  from: string,
  to: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const deadline = Date.now() + RENAME_RETRY_MS;
  for (let wait = 20; ; wait = Math.min(wait * 2, 400)) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const transient =
        platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].some((c) => hasCode(err, c));
      if (!transient || Date.now() + wait > deadline) throw err;
      await new Promise((done) => setTimeout(done, wait));
    }
  }
}

/** Move whatever sits at `path` into `tmp/trash-*`, so nothing half-removed is ever at a live path. */
async function trash(root: string, path: string, platform?: NodeJS.Platform): Promise<void> {
  if (!existsSync(path)) return;
  await mkdir(tmpOf(root), { recursive: true });
  const to = join(tmpOf(root), `trash-${rand()}`);
  await renameDir(path, to, platform);
  await rm(to, { recursive: true, force: true }).catch(() => undefined);
}

/** What `<node> -p process.version` prints, or null when it does not run. */
function nodeVersionOf(bin: string): Promise<string | null> {
  return new Promise((done) => {
    const child = spawn(bin, ['-p', 'process.version'], {
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 15_000,
    });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (out += chunk));
    child.on('error', () => done(null));
    child.on('close', (code) => done(code === 0 ? out.trim() : null));
  });
}

/**
 * The pinned Node, in `node/<V>`, downloaded once. The archive must match the
 * pin's sha256 before anything is unpacked, and the binary must say it is
 * `v<V>` before it is marked complete. A `node/<V>` whose `.complete` is gone
 * but whose binary still says `v<V>` is marked complete again rather than
 * replaced: uninstall leaves exactly that behind on Windows while a session
 * runs it, and a folder whose `node.exe` runs cannot be renamed away. Returns
 * the binary's path.
 */
export async function ensureNode(
  root: string,
  pin: NodePin,
  o: RuntimeLockOptions & {
    timeoutMs: number;
    fetchImpl?: typeof fetch;
    platform?: NodeJS.Platform;
    arch?: string;
    glibc?: string | null;
    archivePath?: string;
    proxyEnv?: NodeJS.ProcessEnv;
  },
): Promise<string> {
  const platform = o.platform ?? process.platform;
  const arch = o.arch ?? process.arch;
  const glibc = o.glibc !== undefined ? o.glibc : platform === 'linux' ? runningGlibc() : null;
  const key = nodeKey(platform, arch, glibc);
  const expected = key === null ? undefined : pin.sha256[key];
  if (key === null || expected === undefined) {
    throw new CliError('UPDATE_FAILED', `no pinned Node for ${key ?? `${platform}-${arch}`}`);
  }
  return withRuntimeLock(
    root,
    async () => {
      const dir = join(root, 'node', pin.version);
      const bin = nodeBinPath(root, pin.version, platform);
      if (completeValid(dir) && existsSync(bin)) {
        await touchComplete(dir);
        return bin;
      }
      if (existsSync(bin) && (await nodeVersionOf(bin)) === `v${pin.version}`) {
        await markComplete(dir, pin.version);
        return bin;
      }
      const made: string[] = [];
      try {
        await mkdir(tmpOf(root), { recursive: true });
        const artifact = nodeArtifact(pin.version, key);
        let got;
        try {
          if (o.archivePath !== undefined) {
            if ((await stat(o.archivePath)).size > NODE_MAX_BYTES) {
              throw new CliError('UPDATE_FAILED', 'The bootstrap Node archive is too large.');
            }
            const archive = await readFile(o.archivePath);
            const file = join(tmpOf(root), `dl-${rand()}`);
            await writeFile(file, archive, { mode: 0o600 });
            got = { file, digest: createHash('sha256').update(archive).digest() };
          } else if (o.proxyEnv !== undefined) {
            got = await downloadViaCurl(artifact.url, {
              dir: tmpOf(root),
              maxBytes: NODE_MAX_BYTES,
              timeoutMs: o.timeoutMs,
              env: o.proxyEnv,
            });
          } else {
            got = await download(artifact.url, {
              dir: tmpOf(root),
              maxBytes: NODE_MAX_BYTES,
              timeoutMs: o.timeoutMs,
              hash: 'sha256',
              fetchImpl: o.fetchImpl,
            });
          }
        } catch (err) {
          if (err instanceof CliError && err.code === 'NETWORK_ERROR') {
            throw new CliError('NETWORK_ERROR', err.message, { fix: NODE_FIX, cause: err });
          }
          throw err;
        }
        made.push(got.file);
        if (got.digest.toString('hex') !== expected) {
          throw new CliError(
            'UPDATE_FAILED',
            `the Node ${pin.version} download did not match its pinned checksum`,
          );
        }
        const stage = join(tmpOf(root), `node-${rand()}`);
        made.push(stage);
        await mkdir(stage);
        await extract(got.file, stage, { member: artifact.member, strip: 1, platform });
        const staged = join(stage, relative(dir, bin));
        if (platform !== 'win32') await chmod(staged, 0o755);
        const said = await nodeVersionOf(staged);
        if (said !== `v${pin.version}`) {
          throw new CliError(
            'UPDATE_FAILED',
            `the downloaded Node ${pin.version} did not run (it printed ${said ?? 'nothing'})`,
          );
        }
        await markComplete(stage, pin.version);
        await trash(root, dir, platform);
        await mkdir(dirname(dir), { recursive: true });
        await renameDir(stage, dir, platform);
        return bin;
      } finally {
        for (const path of made)
          await rm(path, { recursive: true, force: true }).catch(() => undefined);
      }
    },
    o,
  );
}

/** Top-level entries a package copy never carries: a checkout's, or a data dir's. */
const NOT_COPIED = new Set(['src', '.git', 'runtime']);

function copied(packageRoot: string, src: string): boolean {
  const rel = relative(packageRoot, src);
  if (rel === '') return true;
  const parts = rel.split(sep);
  if (parts.includes('node_modules')) return false;
  return !NOT_COPIED.has(parts[0]!);
}

async function tally(
  dir: string,
  keep: (path: string) => boolean,
): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (!keep(path)) continue;
      if (entry.isDirectory()) await walk(path);
      else {
        files += 1;
        bytes += (await stat(path)).size;
      }
    }
  };
  await walk(dir);
  return { files, bytes };
}

async function packageVersion(dir: string): Promise<{ name?: unknown; version?: unknown }> {
  return JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as {
    name?: unknown;
    version?: unknown;
  };
}

/**
 * A copy of the running package under `tmp/`, for `placeVersion`: what npm
 * shipped (`package.json`, `dist/`, `docs/` and the notices), never
 * `node_modules`, `src` or `.git`. The copy must hold as many files and bytes
 * as the source, and the version the source names.
 */
export async function stageSelf(root: string, packageRoot: string): Promise<string> {
  const { version } = await packageVersion(packageRoot);
  if (typeof version !== 'string' || parseVersion(version) === null) {
    throw new CliError('UPDATE_FAILED', `${packageRoot} names no tenjin-cli version`);
  }
  const stage = join(tmpOf(root), `stage-${version}-${rand()}`);
  try {
    await mkdir(tmpOf(root), { recursive: true });
    await cp(packageRoot, stage, { recursive: true, filter: (src) => copied(packageRoot, src) });
    const want = await tally(packageRoot, (p) => copied(packageRoot, p));
    const got = await tally(stage, () => true);
    if (want.files !== got.files || want.bytes !== got.bytes) {
      throw new CliError(
        'UPDATE_FAILED',
        `the copy of tenjin-cli ${version} is incomplete (${got.files} of ${want.files} files)`,
      );
    }
    if ((await packageVersion(stage)).version !== version) {
      throw new CliError(
        'UPDATE_FAILED',
        `the copy of tenjin-cli ${version} names another version`,
      );
    }
    return stage;
  } catch (err) {
    await rm(stage, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}

/**
 * A released version, staged from npm's registry with no npm: it must pass
 * {@link checkReleaseProvenance} before anything is downloaded, the tarball
 * must then match the sha512 that check let through, and the unpacked
 * `package.json` must be tenjin-cli at exactly `version`.
 */
export async function stageTarball(
  root: string,
  version: string,
  o: { timeoutMs: number; fetchImpl?: typeof fetch },
): Promise<string> {
  const fetchImpl = o.fetchImpl ?? fetch;
  const { tarball, integrity, sha512Hex } = await checkReleaseProvenance(version, {
    timeoutMs: o.timeoutMs,
    fetchImpl,
  });
  await mkdir(tmpOf(root), { recursive: true });
  const got = await download(tarball, {
    dir: tmpOf(root),
    maxBytes: TARBALL_MAX_BYTES,
    timeoutMs: o.timeoutMs,
    hash: 'sha512',
    fetchImpl,
  });
  const stage = join(tmpOf(root), `stage-${version}-${rand()}`);
  try {
    // The bytes themselves, against the registry's sha512 and so against the
    // one the provenance names: nothing is unpacked from anything else.
    if (
      got.digest.toString('base64') !== integrity.slice('sha512-'.length) ||
      got.digest.toString('hex') !== sha512Hex
    ) {
      throw new CliError(
        'UPDATE_FAILED',
        `the tenjin-cli ${version} tarball did not match its integrity`,
      );
    }
    await mkdir(stage);
    await extract(got.file, stage, { strip: 1 });
    const pkg = await packageVersion(stage);
    if (pkg.name !== 'tenjin-cli' || pkg.version !== version) {
      throw new CliError(
        'UPDATE_FAILED',
        `the tarball for tenjin-cli ${version} holds another package`,
      );
    }
    return stage;
  } catch (err) {
    await rm(stage, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  } finally {
    await rm(got.file, { force: true }).catch(() => undefined);
  }
}

/**
 * Put a staged version at `versions/<version>`, marked complete last. One
 * already there and complete is kept (its `.complete` touched, so a `collect`
 * before its activation spares it) and the stage dropped; anything else there
 * (a crash mid-copy) is moved to trash and replaced.
 */
export async function placeVersion(
  root: string,
  stageDir: string,
  version: string,
  o: RuntimeLockOptions & { platform?: NodeJS.Platform } = {},
): Promise<string> {
  return withRuntimeLock(
    root,
    async () => {
      const dir = versionDir(root, version);
      if (completeValid(dir)) {
        await touchComplete(dir);
        await rm(stageDir, { recursive: true, force: true });
        return dir;
      }
      await markComplete(stageDir, version);
      await trash(root, dir, o.platform);
      await mkdir(dirname(dir), { recursive: true });
      await renameDir(stageDir, dir, o.platform);
      return dir;
    },
    o,
  );
}
