import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, posix, relative, resolve, sep, win32 } from 'node:path';
import { handlersIn } from '../router/hook-form';
import {
  LAUNCHER_MARKER,
  PLUGIN_DIR,
  renderCodexHostFiles,
  renderHostFiles,
  renderLauncherCmd,
  renderLauncherSh,
  renderPluginHooks,
  renderPluginMcp,
  type ModSources,
  type RuntimeLaunch,
} from '../router/plugin-files';
import { readModSources } from '../router/plugin-folder';
import { writeFileAtomic } from './atomic-json';
import { proxyNodeStep, proxySkipped } from './env-proxy';
import { hasCode } from './errno';
import { CliError } from './errors';
import { isSourceCheckout } from './install-location';
import { LockTimeoutError } from './lock';
import { defaultDataDir, launcherDir, runtimeDir } from './paths';
import {
  download,
  downloadViaCurl,
  extract,
  nodeArtifact,
  nodeKey,
  runningGlibc,
  unpinnedPlatform,
} from './runtime-fetch';
import {
  nodeBinPath,
  readRuntimeState,
  runtimeBuild,
  runtimeStatePath,
  versionDir,
  versionEntry,
  type RuntimePointer,
} from './runtime-layout';
import { isNewer, parseVersion } from './version-order';

/**
 * TENJIN'S OWN RUNTIME, `~/.tenjin/runtime`: a copy of each CLI version, the
 * pinned Node that runs it, and the plugin folder Claude Code loads, so that
 * neither a Node upgrade nor `npm rm -g tenjin-cli` can take the plugin away.
 * Only the default data dir has one (see `setupRuntime`).
 *
 * Every change runs under one lock (`withRuntimeLock`), and every step that
 * puts something in place stages it under `tmp/`, marks it `.complete` last and
 * renames it in, so a crash never leaves a half copy at a live path. The switch
 * itself is `activate`: `state.json` records the version as `pending` before
 * the plugin folder is rendered, and the same write that makes it `current`
 * clears it. Nothing here reads or writes the wallet, the passphrase store, the
 * config or the spend ledger.
 */

// ---------------------------------------------------------------------------
// The pin and the package
// ---------------------------------------------------------------------------

/** The Node a build runs on, from its `package.json` `tenjinRuntime.node`. */
export interface NodePin {
  version: string;
  /** Release-archive sha256 by `nodeKey`, from a signature-checked `SHASUMS256.txt`. */
  sha256: Record<string, string>;
}

const NODE_VERSION_RE = /^\d+\.\d+\.\d+$/;
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
// The runtime lock
// ---------------------------------------------------------------------------

export interface LockOptions {
  /** How long to wait for another holder. Default 300 s, longer than any holder runs. */
  lockWaitMs?: number;
  /** Is this pid running? Defaults to `process.kill(pid, 0)`, where EPERM is alive. */
  isAlive?: (pid: number) => boolean;
  now?: () => number;
}

/** No holder runs this long: the Node download, the longest step, is capped at 300 s. */
const LOCK_STALE_MS = 10 * 60_000;
/** A lock with no readable owner this old was left by a holder killed between mkdir and write. */
const OWNERLESS_STALE_MS = 10_000;
/** The takeover lock is held for one rename; one this old was left by a killed waiter. */
const TAKEOVER_STALE_MS = 60_000;
const LOCK_POLL_MS = 50;

/**
 * Runtime locks this process holds, by path and the inode it created, removed
 * at exit as `lock.ts` does for its own: the default signal action skips
 * `finally`, and a lock left by a live pid would make every later run wait.
 */
const held = new Map<string, number>();
let exitHookInstalled = false;

function releaseHeld(): void {
  for (const [path, ino] of held) releaseIfOurs(path, ino);
  held.clear();
}

/** Remove the lock only when it is still the directory this process made: a waiter may have taken over a holder it judged stale, and the successor's lock is not ours to remove. */
function releaseIfOurs(path: string, ino: number): void {
  try {
    if (statSync(path).ino === ino) rmSync(path, { recursive: true, force: true });
  } catch {
    // Gone already (removeRuntime takes the lock dir with the root), or not removable: a dead pid is stale for the next waiter.
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return hasCode(err, 'EPERM');
  }
}

/**
 * The lock's identity when it is stale, or null when its holder may still be
 * running. The identity is its inode plus its `owner.json` bytes, so a takeover
 * renames only the exact lock it judged, never one a new holder made since.
 */
function staleLock(lock: string, isAlive: (pid: number) => boolean, now: number): string | null {
  let info;
  try {
    info = statSync(lock);
  } catch {
    return null;
  }
  let text: string;
  try {
    text = readFileSync(join(lock, 'owner.json'), 'utf8');
  } catch {
    return now - info.mtimeMs > OWNERLESS_STALE_MS ? `${info.ino}:` : null;
  }
  let owner: { pid?: unknown; startedAt?: unknown };
  try {
    owner = JSON.parse(text) as typeof owner;
  } catch {
    return now - info.mtimeMs > OWNERLESS_STALE_MS ? `${info.ino}:${text}` : null;
  }
  const started = typeof owner.startedAt === 'string' ? Date.parse(owner.startedAt) : NaN;
  const dead = typeof owner.pid === 'number' && !isAlive(owner.pid);
  const old = Number.isNaN(started) || now - started > LOCK_STALE_MS;
  return dead || old ? `${info.ino}:${text}` : null;
}

/**
 * Move a stale lock aside, serialised by `.lock-takeover` so two waiters that
 * judged the same lock stale cannot both take it: the second finds a different
 * identity (or no lock) once the first has renamed it. True when this call
 * moved it.
 */
function takeOver(root: string, lock: string, judged: string, o: Required<LockOptions>): boolean {
  const gate = join(root, '.lock-takeover');
  try {
    mkdirSync(gate);
  } catch (err) {
    if (!hasCode(err, 'EEXIST')) return false;
    try {
      if (o.now() - statSync(gate).mtimeMs > TAKEOVER_STALE_MS) {
        rmSync(gate, { recursive: true, force: true });
      }
    } catch {
      // Released meanwhile.
    }
    return false;
  }
  try {
    if (staleLock(lock, o.isAlive, o.now()) !== judged) return false;
    mkdirSync(join(root, 'tmp'), { recursive: true });
    renameSync(lock, join(root, 'tmp', `trash-lock-${randomBytes(6).toString('hex')}`));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(gate, { recursive: true, force: true });
  }
}

/**
 * Run `fn` holding `runtime/.lock`. The lock is a directory (mkdir is atomic)
 * holding `owner.json` `{pid, startedAt}`. Unlike `lock.ts`, a stale lock is
 * taken over: its owner's pid is dead, or it is older than any holder runs, so
 * an update killed mid-download does not block every later install.
 */
export async function withRuntimeLock<T>(
  root: string,
  fn: () => Promise<T>,
  o: LockOptions = {},
): Promise<T> {
  const opts: Required<LockOptions> = {
    lockWaitMs: o.lockWaitMs ?? 300_000,
    isAlive: o.isAlive ?? pidAlive,
    now: o.now ?? Date.now,
  };
  const lock = join(root, '.lock');
  const deadline = opts.now() + opts.lockWaitMs;
  mkdirSync(root, { recursive: true });
  let ino: number;
  for (;;) {
    try {
      mkdirSync(lock);
      ino = statSync(lock).ino;
      held.set(lock, ino);
      break;
    } catch (err) {
      if (!hasCode(err, 'EEXIST')) throw err;
      const judged = staleLock(lock, opts.isAlive, opts.now());
      if (judged !== null && takeOver(root, lock, judged, opts)) continue;
      if (opts.now() >= deadline) throw new LockTimeoutError(lock, opts.lockWaitMs);
      await new Promise((done) => setTimeout(done, LOCK_POLL_MS));
    }
  }
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once('exit', releaseHeld);
  }
  try {
    writeFileSync(
      join(lock, 'owner.json'),
      JSON.stringify({ pid: process.pid, startedAt: new Date(opts.now()).toISOString() }),
    );
    return await fn();
  } finally {
    held.delete(lock);
    releaseIfOurs(lock, ino);
  }
}

// ---------------------------------------------------------------------------
// Placing Node and the CLI
// ---------------------------------------------------------------------------

const NODE_MAX_BYTES = 100 * 1024 * 1024;
const TARBALL_MAX_BYTES = 50 * 1024 * 1024;
const NODE_FIX = 'Check access to nodejs.org and run `tenjin install` again.';

const rand = (): string => randomBytes(6).toString('hex');
const tmpOf = (root: string): string => join(root, 'tmp');

/** Is `dir/.complete` present and naming `dir` itself? Anything else is a half copy. */
function completeValid(dir: string): boolean {
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
async function renameDir(
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
  o: LockOptions & {
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
            const archive = await readFile(o.archivePath);
            if (archive.byteLength > NODE_MAX_BYTES) {
              throw new CliError('UPDATE_FAILED', 'The bootstrap Node archive is too large.');
            }
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

const REGISTRY = 'https://registry.npmjs.org/tenjin-cli';

/**
 * A released version, staged from npm's registry with no npm: its metadata
 * names the tarball and its sha512, the tarball must come from the registry
 * itself and match that sha512, and the unpacked `package.json` must be
 * tenjin-cli at exactly `version`.
 */
export async function stageTarball(
  root: string,
  version: string,
  o: { timeoutMs: number; fetchImpl?: typeof fetch },
): Promise<string> {
  const fetchImpl = o.fetchImpl ?? fetch;
  let meta: { dist?: { tarball?: unknown; integrity?: unknown } };
  try {
    const res = await fetchImpl(`${REGISTRY}/${version}`, {
      signal: AbortSignal.timeout(o.timeoutMs),
      headers: { accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    meta = (await res.json()) as typeof meta;
  } catch (err) {
    throw new CliError(
      'NETWORK_ERROR',
      `could not read tenjin-cli ${version} from the npm registry: ${err instanceof Error ? err.message : String(err)}`,
      { fix: 'Check access to registry.npmjs.org and run `tenjin update` again.', cause: err },
    );
  }
  const tarball = meta.dist?.tarball;
  const integrity =
    typeof meta.dist?.integrity === 'string'
      ? meta.dist.integrity.split(/\s+/).find((h) => h.startsWith('sha512-'))
      : undefined;
  if (typeof tarball !== 'string' || !tarball.startsWith(`${REGISTRY}/-/`)) {
    throw new CliError(
      'UPDATE_FAILED',
      `tenjin-cli ${version} names a tarball outside the npm registry`,
    );
  }
  if (integrity === undefined) {
    throw new CliError('UPDATE_FAILED', `tenjin-cli ${version} carries no sha512 integrity`);
  }
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
    if (got.digest.toString('base64') !== integrity.slice('sha512-'.length)) {
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
  o: LockOptions & { platform?: NodeJS.Platform } = {},
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

// ---------------------------------------------------------------------------
// Verifying a build before anything points at it
// ---------------------------------------------------------------------------

/** One process run the way Claude Code runs it: exec form, no shell. A seam for tests. */
export type VerifySpawn = (
  command: string,
  args: string[],
  o: {
    env: NodeJS.ProcessEnv;
    input: string;
    timeoutMs: number;
    /** Keep stdin open and stop (killing it) once stdout satisfies this. */
    until?: (stdout: string) => boolean;
  },
) => Promise<{ code: number | null; stdout: string; stderr: string; matched: boolean }>;

const spawnVerify: VerifySpawn = (command, args, o) =>
  new Promise((done) => {
    const child = spawn(command, args, {
      env: o.env,
      shell: false,
      stdio: 'pipe',
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (code: number | null, matched: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null) child.kill();
      done({ code, stdout, stderr, matched });
    };
    const timer = setTimeout(() => finish(null, false), o.timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (o.until?.(stdout) === true) finish(0, true);
    });
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 4096) stderr += chunk;
    });
    child.stdin.on('error', () => undefined);
    child.on('error', (err) => {
      stderr += err.message;
      finish(null, false);
    });
    child.on('close', (code) => finish(code, false));
    child.stdin.write(o.input);
    if (o.until === undefined) child.stdin.end();
  });

const VERIFY_VERSION_MS = 10_000;
const VERIFY_HOOKS_MS = 10_000;
const VERIFY_MCP_MS = 15_000;

const said = (run: { code: number | null; stderr: string }): string => {
  const text = run.stderr.trim().slice(0, 200);
  return `${run.code === null ? 'no exit in time' : `exit ${run.code}`}${text ? `: ${text}` : ''}`;
};

/**
 * DOES THIS BUILD RUN, THE WAY CLAUDE CODE WILL RUN IT? Before anything points
 * at a version: (a) `--version` prints it, (b) every command hook of its
 * runtime render exits 0 with empty or JSON output, all at once, and (c) its
 * MCP server answers `initialize`. The same checks as
 * `scripts/plugin-spawn-smoke.mjs`, against a throwaway data dir.
 * `timeoutMs` bounds all three together.
 */
export async function verifyBuild(
  launch: RuntimeLaunch,
  version: string,
  o: { timeoutMs?: number; spawnImpl?: VerifySpawn } = {},
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const run = o.spawnImpl ?? spawnVerify;
  const deadline =
    Date.now() + (o.timeoutMs ?? VERIFY_VERSION_MS + VERIFY_HOOKS_MS + VERIFY_MCP_MS);
  const budget = (own: number) => Math.min(own, deadline - Date.now());
  const outOfTime = { ok: false as const, reason: `tenjin-cli ${version} was not checked in time` };
  const data = await mkdtemp(join(tmpdir(), 'tenjin-verify-'));
  const env = {
    ...process.env,
    TENJIN_DATA_DIR: data,
    TENJIN_NO_UPDATE_CHECK: '1',
    TENJIN_HANDOFF: '1',
  };
  /** A spawn bounded by the step's time even when the spawn itself never returns. */
  const bounded = (
    command: string,
    args: string[],
    input: string,
    ms: number,
    until?: (s: string) => boolean,
  ) => {
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([
      run(command, args, { env, input, timeoutMs: ms, until }),
      new Promise<null>((done) => (timer = setTimeout(() => done(null), ms + 250))),
    ]).finally(() => clearTimeout(timer));
  };
  try {
    let ms = budget(VERIFY_VERSION_MS);
    if (ms <= 0) return outOfTime;
    const shown = await bounded(launch.node, [launch.entry, '--version'], '', ms);
    if (shown === null) return outOfTime;
    if (shown.code !== 0 || shown.stdout.trim() !== version) {
      return {
        ok: false,
        reason: `tenjin-cli ${version} did not start (${shown.code === 0 ? `it printed ${shown.stdout.trim().slice(0, 50) || 'nothing'}` : said(shown)})`,
      };
    }

    ms = budget(VERIFY_HOOKS_MS);
    if (ms <= 0) return outOfTime;
    const { hooks } = renderPluginHooks(launch.entry, { node: launch.node });
    const commands = Object.entries(hooks).flatMap(([event, groups]) =>
      (
        handlersIn({ hooks: { [event]: groups } }) as {
          type: string;
          command: string;
          args: string[];
        }[]
      )
        .filter((h) => h.type === 'command')
        .map((h) => ({ event, command: h.command, args: h.args })),
    );
    const results = await Promise.all(
      commands.map(async (c) => ({
        ...c,
        out: await bounded(
          c.command,
          c.args,
          JSON.stringify({ session_id: 'verify', hook_event_name: c.event }),
          ms,
        ),
      })),
    );
    for (const { event, out } of results) {
      if (out === null) return outOfTime;
      if (out.code !== 0) return { ok: false, reason: `its ${event} hook failed (${said(out)})` };
      if (out.stdout.trim().length > 0) {
        try {
          JSON.parse(out.stdout);
        } catch {
          return { ok: false, reason: `its ${event} hook printed something other than JSON` };
        }
      }
    }

    ms = budget(VERIFY_MCP_MS);
    if (ms <= 0) return outOfTime;
    const server = renderPluginMcp(launch.entry, { node: launch.node }).mcpServers.router as {
      command: string;
      args: string[];
    };
    const initialize = `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'tenjin-verify', version },
      },
    })}\n`;
    const answered = await bounded(server.command, server.args, initialize, ms, (stdout) =>
      stdout.split('\n').some((line) => line.includes('"id":1') && line.includes('"result"')),
    );
    if (answered === null || !answered.matched) {
      return {
        ok: false,
        reason: `its MCP server did not answer initialize (${answered === null ? 'no answer in time' : said(answered)})`,
      };
    }
    return { ok: true };
  } finally {
    await rm(data, { recursive: true, force: true }).catch(() => undefined);
  }
}

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

const launcherNames = (platform: NodeJS.Platform): string[] =>
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

async function inspectLauncher(path: string): Promise<LauncherFile> {
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

// ---------------------------------------------------------------------------
// Activation, collection, removal
// ---------------------------------------------------------------------------

interface RawState {
  current: RuntimePointer | null;
  previous: RuntimePointer | null;
  pending: RuntimePointer | null;
  /**
   * The id of the activation whose final write this is, so its `restore()`
   * can tell whether a later activation has written since. Unset before the
   * first activation that carried one.
   */
  activation?: string;
}

function pointerOf(raw: unknown): RuntimePointer | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { cli, node } = raw as { cli?: unknown; node?: unknown };
  if (typeof cli !== 'string' || parseVersion(cli) === null) return null;
  if (typeof node !== 'string' || !NODE_VERSION_RE.test(node)) return null;
  return { cli, node };
}

/**
 * Every pointer in `state.json`, a `current` of null included: during a first
 * activation only `pending` is set, and GC must keep that version too.
 */
function readRawState(root: string): RawState {
  try {
    const raw = JSON.parse(readFileSync(runtimeStatePath(root), 'utf8')) as Record<string, unknown>;
    return {
      current: pointerOf(raw.current),
      previous: pointerOf(raw.previous),
      pending: pointerOf(raw.pending),
      ...(typeof raw.activation === 'string' ? { activation: raw.activation } : {}),
    };
  } catch {
    return { current: null, previous: null, pending: null };
  }
}

async function writeState(root: string, state: RawState): Promise<void> {
  await writeFileAtomic(
    runtimeStatePath(root),
    `${JSON.stringify({ schemaVersion: 1, ...state }, null, 2)}\n`,
  );
}

const readOrNull = (path: string): Promise<string | null> =>
  readFile(path, 'utf8').catch(() => null);

/** Put back a file's earlier body, or remove it when there was none. */
async function putBack(path: string, body: string | null, mode: number): Promise<void> {
  if (body === null) await rm(path, { force: true });
  else await writeFileAtomic(path, body, { mode });
}

/**
 * The marketplaces' files in the order a reader can never see a half render:
 * the parts (the mod's files before the hooks file that names its module), then
 * the manifests, then both catalogs.
 */
function renderOrder(files: Record<string, string>): string[] {
  const rank = (path: string): number => {
    const inHost = path.slice(path.indexOf('/') + 1);
    if (inHost === 'tenjin/hooks/hooks.json') return 1;
    if (inHost.startsWith('tenjin/bin/')) return 2;
    if (/^tenjin\/\.(claude|codex)-plugin\/plugin\.json$/.test(inHost)) return 3;
    if (['.claude-plugin/marketplace.json', '.agents/plugins/marketplace.json'].includes(inHost)) {
      return 4;
    }
    return 0;
  };
  return Object.keys(files).sort((a, b) => rank(a) - rank(b));
}

/**
 * THE MOD THE BUILD AT `launch.entry` SHIPS, as written in its own
 * `dist/hosts/claude/tenjin`, so the runtime render carries the mod of the
 * version it runs, never the running package's. Undefined when that build
 * carries none: the render then names no module.
 */
function runtimeMod(launch: RuntimeLaunch): Promise<ModSources | undefined> {
  return readModSources(join(dirname(launch.entry), 'hosts', 'claude', PLUGIN_DIR));
}

/**
 * Everything the runtime renders for `launch`, by path under the root: the
 * Claude Code marketplace in `claude/` and the Codex one in `codex/`.
 */
function runtimeHostFiles(
  root: string,
  version: string,
  launch: RuntimeLaunch,
  mod: ModSources | undefined,
): Record<string, string> {
  const under = (host: string, files: Record<string, string>) =>
    Object.entries(files).map(([path, body]) => [`${host}/${path}`, body] as const);
  return Object.fromEntries([
    ...under('claude', renderHostFiles(version, { launch, mod })),
    ...under(
      'codex',
      renderCodexHostFiles({ launch, binDir: join(root, 'codex', PLUGIN_DIR, 'bin') }),
    ),
  ]);
}

const modeFor = (path: string): number => (path.includes('/tenjin/bin/') ? 0o755 : 0o644);

export interface Activation {
  previous: RuntimePointer | null;
  launcher: LauncherResult;
  restore: () => Promise<void>;
}

/** Are `p`'s Node and entry both in place, so the runtime can run it? */
function runnable(root: string, p: RuntimePointer, platform: NodeJS.Platform): boolean {
  return existsSync(nodeBinPath(root, p.node, platform)) && existsSync(versionEntry(root, p.cli));
}

/**
 * `activate` refused, writing nothing: the runtime already runs `current`, a
 * newer build than the one it was asked to switch to.
 */
export class NewerRuntime extends Error {
  constructor(readonly current: RuntimePointer) {
    super(`Tenjin ${current.cli} is already set up here`);
  }
}

/**
 * SWITCH THE RUNTIME TO `next`, under the lock: record it as `pending`, render
 * `runtime/claude` and `runtime/codex` for it, write the launchers, then make it `current` and
 * clear `pending` in one write. It throws {@link NewerRuntime}, writing
 * nothing, when `current` is already a newer build that runs. A crash in
 * between leaves `pending` set, which GC keeps and the next install
 * re-renders; a render that throws puts the old files back and leaves
 * `pending`. `restore()` undoes the whole switch, for a caller whose
 * registration then failed, and does nothing once a later activation has
 * written `state.json` (its random `activation` id is gone).
 */
export async function activate(
  root: string,
  next: RuntimePointer,
  o: LockOptions & { home: string; env: NodeJS.ProcessEnv; platform?: NodeJS.Platform },
): Promise<Activation> {
  const platform = o.platform ?? process.platform;
  const launch: RuntimeLaunch = {
    node: nodeBinPath(root, next.node, platform),
    entry: versionEntry(root, next.cli),
    platform,
    home: o.home,
  };
  return withRuntimeLock(
    root,
    async () => {
      // AN OLDER BUILD NEVER REPLACES A NEWER ONE, checked again here: the
      // caller read `current` before staging, without the lock, and a newer
      // install may have switched to its own build since. Writing `next` now
      // would silently roll every scope back.
      const old = readRawState(root);
      if (
        old.current !== null &&
        isNewer(old.current.cli, next.cli) &&
        runnable(root, old.current, platform)
      ) {
        throw new NewerRuntime(old.current);
      }
      // THE BUILD MUST STILL BE THERE: it was placed under an earlier hold of
      // the lock, and a collect may have run since. A switch to a folder that
      // is gone would leave Claude Code starting nothing.
      if (
        !completeValid(versionDir(root, next.cli)) ||
        !existsSync(launch.entry) ||
        !completeValid(join(root, 'node', next.node)) ||
        !existsSync(launch.node)
      ) {
        throw new CliError(
          'UPDATE_FAILED',
          `tenjin-cli ${next.cli} or its Node ${next.node} is no longer in place in ${root}, so the runtime was not switched to it`,
        );
      }
      const oldStateText = await readOrNull(runtimeStatePath(root));
      await writeState(root, { ...old, pending: next });

      const files = runtimeHostFiles(root, next.cli, launch, await runtimeMod(launch));
      const order = renderOrder(files);
      const oldBodies = new Map<string, string | null>();
      try {
        for (const path of order) {
          const target = join(root, path);
          oldBodies.set(path, await readOrNull(target));
          await writeFileAtomic(target, files[path]!, { mode: modeFor(path) });
        }
      } catch (err) {
        for (const [path, body] of [...oldBodies].reverse()) {
          await putBack(join(root, path), body, modeFor(path)).catch(() => undefined);
        }
        throw err;
      }

      const launcherPaths = launcherNames(platform).map((n) => join(launcherDir(o.home), n));
      const oldLaunchers = await Promise.all(launcherPaths.map(inspectLauncher));
      const launcher = await writeLaunchers(o.home, launch, { env: o.env, platform });

      const previous =
        old.current !== null && old.current.cli !== next.cli ? old.current : old.previous;
      const activation = rand();
      await writeState(root, { current: next, previous, pending: null, activation });

      const restore = () =>
        withRuntimeLock(
          root,
          async () => {
            // ONLY WHILE THIS ACTIVATION IS STILL THE LAST ONE. The lock is
            // released between this switch and the caller's registration, so
            // another install may have activated (and registered) since;
            // putting back what was here before this one would overwrite its
            // switch, or, on a first activation, delete its files.
            if (readRawState(root).activation !== activation) return;
            for (const path of [...order].reverse()) {
              await putBack(join(root, path), oldBodies.get(path) ?? null, modeFor(path));
            }
            if (oldStateText === null) await rm(runtimeStatePath(root), { force: true });
            else await writeFileAtomic(runtimeStatePath(root), oldStateText);
            // Only launchers this activation could have written: ours before, or absent.
            for (const [i, path] of launcherPaths.entries()) {
              const before = oldLaunchers[i]!;
              if (before.state === 'ours') await putBack(path, before.body, 0o755);
              else if (
                before.state === 'absent' &&
                (await inspectLauncher(path)).state === 'ours'
              ) {
                await rm(path, { force: true });
              }
            }
          },
          o,
        );
      return { previous: old.current, launcher, restore };
    },
    o,
  );
}

const IN_USE = 'in use; removed by a later install';
const PLACED = 'placed for an activation still on its way';
const TMP_MAX_AGE_MS = 60 * 60_000;
/**
 * How long a folder no state names is spared after it was placed: longer than
 * any install runs from `placeVersion` or `ensureNode` to `activate` (update's
 * child, verify included, is killed at 60 s).
 */
const PLACED_GRACE_MS = 15 * 60_000;

/** Why `collect` keeps a version a `keep` pointer names. */
const KEPT_FOR_FOLDER = 'a plugin folder runs it';

/**
 * GC, under the lock. Keeps the current, previous and pending versions, every
 * version in `keep` (a plugin folder that runs it by absolute path, which
 * `state.json` does not name), every version a running `tenjin mcp` marked
 * live, the Node versions they pin, and any version or Node placed in the
 * last 15 minutes (by its `.complete`): the lock is held per step, so one
 * placed for an activation still on its way (update's child verifying it) has
 * no role yet. Removes the rest by renaming each into `tmp/trash-*` first. A
 * folder held open (Windows: a running `node.exe`) is kept for a later
 * install. Then sweeps `tmp/` of trash and of anything older than an hour.
 */
export async function collect(
  root: string,
  o: LockOptions & { platform?: NodeJS.Platform; keep?: readonly RuntimePointer[] } = {},
): Promise<{ removed: string[]; kept: { path: string; reason: string }[] }> {
  const isAlive = o.isAlive ?? pidAlive;
  const now = o.now ?? Date.now;
  return withRuntimeLock(
    root,
    async () => {
      const state = readRawState(root);
      const removed: string[] = [];
      const kept: { path: string; reason: string }[] = [];
      const keepNode = new Set<string>();
      const roles = new Map<string, string>();
      for (const role of ['current', 'previous', 'pending'] as const) {
        const p = state[role];
        if (p === null) continue;
        if (!roles.has(p.cli)) roles.set(p.cli, role);
        keepNode.add(p.node);
      }
      for (const p of o.keep ?? []) {
        if (!roles.has(p.cli)) roles.set(p.cli, KEPT_FOR_FOLDER);
        keepNode.add(p.node);
      }
      const remove = async (path: string): Promise<void> => {
        const to = join(tmpOf(root), `trash-${rand()}`);
        try {
          await mkdir(tmpOf(root), { recursive: true });
          await renameDir(path, to, o.platform);
        } catch (err) {
          kept.push({
            path,
            reason: ['EBUSY', 'EPERM', 'ENOTEMPTY'].some((c) => hasCode(err, c))
              ? IN_USE
              : `not removed: ${err instanceof Error ? err.message : String(err)}`,
          });
          return;
        }
        removed.push(path);
        await rm(to, { recursive: true, force: true }).catch(() => undefined);
      };
      const placedJustNow = async (dir: string): Promise<boolean> =>
        completeValid(dir) &&
        (await stat(join(dir, '.complete')).then(
          (s) => now() - s.mtimeMs < PLACED_GRACE_MS,
          () => false,
        ));

      const versions = join(root, 'versions');
      for (const name of await readdir(versions).catch(() => [] as string[])) {
        const dir = join(versions, name);
        const liveDir = join(dir, '.live');
        let live = false;
        for (const pid of await readdir(liveDir).catch(() => [] as string[])) {
          if (/^\d+$/.test(pid) && isAlive(Number(pid))) live = true;
          else await rm(join(liveDir, pid), { force: true }).catch(() => undefined);
        }
        const role = roles.get(name);
        if (role !== undefined) {
          kept.push({ path: dir, reason: role });
        } else if (live) {
          kept.push({ path: dir, reason: 'a running tenjin mcp uses it' });
          const pin = readNodePin(dir);
          if (pin !== null) keepNode.add(pin.version);
        } else if (await placedJustNow(dir)) {
          kept.push({ path: dir, reason: PLACED });
          const pin = readNodePin(dir);
          if (pin !== null) keepNode.add(pin.version);
        } else {
          await remove(dir);
        }
      }

      const nodes = join(root, 'node');
      for (const name of await readdir(nodes).catch(() => [] as string[])) {
        const dir = join(nodes, name);
        if (keepNode.has(name)) kept.push({ path: dir, reason: 'pinned by a kept version' });
        else if (await placedJustNow(dir)) kept.push({ path: dir, reason: PLACED });
        else await remove(dir);
      }

      for (const name of await readdir(tmpOf(root)).catch(() => [] as string[])) {
        const path = join(tmpOf(root), name);
        const age = await stat(path).then(
          (s) => now() - s.mtimeMs,
          () => 0,
        );
        if (name.startsWith('trash-') || age > TMP_MAX_AGE_MS) {
          await rm(path, { recursive: true, force: true }).catch(() => undefined);
        }
      }
      return { removed, kept };
    },
    o,
  );
}

/** Every path under `dir` that could not be removed; removes the rest. */
async function removeWhatCan(dir: string): Promise<string[]> {
  try {
    await rm(dir, { recursive: true, force: true });
    return [];
  } catch (err) {
    if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].some((c) => hasCode(err, c))) throw err;
  }
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (entries === null) return [dir];
  const left: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) left.push(...(await removeWhatCan(path)));
    else await rm(path, { force: true }).catch(() => left.push(path));
  }
  if (left.length === 0)
    await rm(dir, { recursive: true, force: true }).catch(() => left.push(dir));
  return left;
}

/** Uninstall's last step: the whole runtime, under its lock (whose directory goes with it). */
export async function removeRuntime(
  root: string,
  o: LockOptions = {},
): Promise<{ removed: boolean; left: string[] }> {
  if (!existsSync(root)) return { removed: false, left: [] };
  return withRuntimeLock(
    root,
    async () => {
      const left = await removeWhatCan(root);
      return { removed: left.length === 0, left };
    },
    o,
  );
}

// ---------------------------------------------------------------------------
// setupRuntime: what install runs
// ---------------------------------------------------------------------------

export interface RuntimeSetup {
  state: 'active' | 'current' | 'kept' | 'failed' | 'skipped';
  root: string;
  cli?: string;
  nodeVersion?: string;
  /** Set for active, current and kept. */
  node?: string;
  entry?: string;
  hostsDir?: string;
  /** No state.json existed before this run. */
  firstTime: boolean;
  launcher: LauncherResult | null;
  reason?: string;
  /**
   * This machine's platform when Tenjin pins no Node for it (musl, glibc below
   * 2.28, another architecture): no install here can set the runtime up, so
   * nothing tells the person to retry.
   */
  unpinned?: string;
  /** The step that works, said in place of a retry that would fail the same way. */
  fix?: string;
  /** `kept` because the runtime already runs a newer build: no failure to report. */
  newer?: true;
  /** Set only for 'active'. */
  restore?: () => Promise<void>;
}

/** Under `install --refresh`, update's child, killed at 60 s: the runtime work gets 35 s, registration the rest. */
const REFRESH_BUDGET_MS = 35_000;
const REFRESH_LOCK_MS = 5_000;
const REFRESH_NODE_MS = 20_000;
const REFRESH_VERIFY_MS = 18_000;
const BUDGET_GONE = 'the 35 s refresh budget ran out';

class BudgetGone extends Error {
  constructor() {
    super(BUDGET_GONE);
  }
}

/**
 * `work`, abandoned (not cancelled) once `ms` pass, so a step that ignores its
 * own timeout cannot hold a refresh past its budget. An infinite `ms` (a plain
 * install, where each step keeps its own default) just waits.
 */
async function within<T>(work: Promise<T>, ms: number): Promise<T> {
  if (!Number.isFinite(ms)) return work;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, fail) => (timer = setTimeout(() => fail(new BudgetGone()), ms))),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Do `runtime/claude` and `runtime/codex` hold, byte for byte, the runtime render for this launch? */
async function hostsMatch(root: string, version: string, launch: RuntimeLaunch): Promise<boolean> {
  const mod = await runtimeMod(launch);
  try {
    return Object.entries(runtimeHostFiles(root, version, launch, mod)).every(
      ([path, body]) => readFileSync(join(root, path), 'utf8') === body,
    );
  } catch {
    return false;
  }
}

/**
 * SET UP TENJIN'S RUNTIME FOR THIS BUILD, as install runs it. `skipped` for a
 * source checkout. Non-default plugin data directories are refused.
 * Otherwise: `current` when this version is already in place, `active` once it
 * was placed, verified and switched to, `kept` when it could not be and a
 * usable runtime stays (or, under `refresh`, a newer one is already there),
 * and `failed` when there is no runtime to register. Only `active` changed
 * anything Claude Code reads, and only after `verify` passed.
 */
export async function setupRuntime(o: {
  dataDir: string;
  home: string;
  env: NodeJS.ProcessEnv;
  version: string;
  moduleDir: string;
  refresh: boolean;
  fetchImpl?: typeof fetch;
  platform?: NodeJS.Platform;
  arch?: string;
  verify?: typeof verifyBuild;
  /** Test seam; production asks this Node whether it can use the shell's proxy. */
  proxySupported?: boolean;
}): Promise<RuntimeSetup> {
  const root = runtimeDir(o.dataDir);
  if (isSourceCheckout(o.moduleDir)) {
    return { state: 'skipped', root, firstTime: false, launcher: null };
  }
  if (resolve(o.dataDir) !== resolve(defaultDataDir(o.home))) {
    return {
      state: 'failed',
      root,
      firstTime: false,
      launcher: null,
      reason: 'Plugin installation needs the default data directory.',
      fix: 'Run without TENJIN_DATA_DIR.',
    };
  }
  const platform = o.platform ?? process.platform;
  const arch = o.arch ?? process.arch;
  const deadline = o.refresh ? Date.now() + REFRESH_BUDGET_MS : Infinity;
  /** What a step may take: its cap or what is left of the refresh budget, or no bound for a plain install. */
  const left = (cap: number): number => {
    if (!o.refresh) return Infinity;
    const ms = Math.min(cap, deadline - Date.now());
    if (ms <= 0) throw new BudgetGone();
    return ms;
  };
  const lockOpts = (): LockOptions => (o.refresh ? { lockWaitMs: left(REFRESH_LOCK_MS) } : {});
  const firstTime = !existsSync(runtimeStatePath(root));
  const hostsDir = join(root, 'claude');
  const launchOf = (p: RuntimePointer): RuntimeLaunch => ({
    node: nodeBinPath(root, p.node, platform),
    entry: versionEntry(root, p.cli),
    platform,
    home: o.home,
  });
  const runs = (p: RuntimePointer): RuntimeSetup => ({
    state: 'kept',
    root,
    cli: p.cli,
    nodeVersion: p.node,
    node: launchOf(p).node,
    entry: launchOf(p).entry,
    hostsDir,
    firstTime,
    launcher: null,
  });

  const keptNewer = (p: RuntimePointer): RuntimeSetup => ({
    ...runs(p),
    reason: `Tenjin ${p.cli} is already set up here; this ${o.version} did not replace it`,
    newer: true,
  });

  const state = readRuntimeState(root);
  const usable = state !== null && runnable(root, state.current, platform) ? state.current : null;
  // AN OLDER BUILD NEVER REPLACES A NEWER ONE, refresh or not: npm's copy can
  // outlive an update and still answer `tenjin`, and an install run from it must
  // not silently roll every scope back. Going back is `tenjin uninstall`, then
  // installing the older version. `activate` checks again under the lock.
  if (usable !== null && isNewer(usable.cli, o.version)) return keptNewer(usable);
  const alreadyCurrent =
    usable !== null &&
    state !== null &&
    usable.cli === o.version &&
    state.pending === null &&
    completeValid(versionDir(root, usable.cli)) &&
    completeValid(join(root, 'node', usable.node)) &&
    (await hostsMatch(root, o.version, launchOf(usable)));

  /**
   * THE LAUNCHERS OF A BUILD ALREADY CURRENT, written under the lock and only
   * while it still is: a newer install may have switched the runtime since
   * `state` was read, and this build's launchers would then point every
   * terminal back at it. Null when the state moved some other way, so the
   * whole setup runs and re-renders.
   */
  const stillCurrent = (p: RuntimePointer): Promise<RuntimeSetup | null> =>
    withRuntimeLock(
      root,
      async () => {
        const now = readRawState(root);
        if (
          now.current !== null &&
          isNewer(now.current.cli, p.cli) &&
          runnable(root, now.current, platform)
        ) {
          return keptNewer(now.current);
        }
        if (now.pending !== null || now.current?.cli !== p.cli || now.current.node !== p.node) {
          return null;
        }
        const launcher = await writeLaunchers(o.home, launchOf(p), { env: o.env, platform });
        return { ...runs(p), state: 'current', launcher };
      },
      lockOpts(),
    );

  const failed = (reason: string): RuntimeSetup =>
    usable !== null
      ? { ...runs(usable), reason }
      : { state: 'failed', root, firstTime, launcher: null, reason };

  // Set while the pinned Node downloads: a failure then, on a Node that skips
  // the shell's proxy, is the proxy's (#470), which no retry on that Node fixes.
  let downloading = false;
  try {
    if (alreadyCurrent) {
      const current = await stillCurrent(usable);
      if (current !== null) return current;
    }
    const glibc = platform === 'linux' ? runningGlibc() : null;
    const key = nodeKey(platform, arch, glibc);
    const unpinned = unpinnedPlatform(platform, arch, glibc);
    if (unpinned !== null) {
      return { ...failed(`no pinned Node for this platform, ${unpinned}`), unpinned };
    }
    const build = runtimeBuild(o.moduleDir);
    const packageRoot =
      build !== null ? versionDir(build.root, build.cli) : packageRootOf(o.moduleDir);
    const pin = packageRoot === null ? null : readNodePin(packageRoot);
    if (key === null || pin === null || pin.sha256[key] === undefined) {
      return failed(`no pinned Node for ${key ?? `${platform}-${arch}`}`);
    }
    const next = { cli: o.version, node: pin.version };

    // A runtime build setting itself up is already in place.
    if (build === null || build.cli !== o.version || resolve(build.root) !== resolve(root)) {
      const stage = await within(stageSelf(root, packageRoot!), left(REFRESH_BUDGET_MS));
      await within(
        placeVersion(root, stage, o.version, { ...lockOpts(), platform }),
        left(REFRESH_BUDGET_MS),
      );
    }
    const nodeMs = left(REFRESH_NODE_MS);
    downloading = true;
    await within(
      ensureNode(root, pin, {
        ...lockOpts(),
        timeoutMs: Number.isFinite(nodeMs) ? nodeMs : 300_000,
        fetchImpl: o.fetchImpl,
        platform,
        arch,
        glibc,
        archivePath: o.env.TENJIN_BOOTSTRAP_NODE_ARCHIVE,
        proxyEnv:
          o.fetchImpl === undefined && proxySkipped(o.env, o.proxySupported) !== null
            ? o.env
            : undefined,
      }),
      nodeMs,
    );
    downloading = false;
    const launch = launchOf(next);
    const verified = await (o.verify ?? verifyBuild)(
      launch,
      o.version,
      o.refresh ? { timeoutMs: left(REFRESH_VERIFY_MS) } : {},
    );
    if (!verified.ok) return failed(verified.reason.slice(0, 200));
    const activation = await activate(root, next, {
      ...lockOpts(),
      home: o.home,
      env: o.env,
      platform,
    });
    return {
      state: 'active',
      root,
      cli: next.cli,
      nodeVersion: next.node,
      node: launch.node,
      entry: launch.entry,
      hostsDir,
      firstTime,
      launcher: activation.launcher,
      restore: activation.restore,
    };
  } catch (err) {
    if (err instanceof NewerRuntime) return keptNewer(err.current);
    const message = err instanceof Error ? err.message : String(err);
    const network =
      (err instanceof CliError && err.code === 'NETWORK_ERROR') || err instanceof BudgetGone;
    const skipped = downloading && network ? proxySkipped(o.env, o.proxySupported) : null;
    if (skipped !== null) {
      return {
        ...failed(`${skipped}: ${message}`.slice(0, 200)),
        fix: proxyNodeStep('tenjin install'),
      };
    }
    return failed(message.slice(0, 200));
  }
}
