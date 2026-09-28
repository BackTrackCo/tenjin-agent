import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { writeFileAtomicExclusive } from '../../lib/atomic-json';
import { withFileLock } from '../../lib/lock';

export type NpmRuntime =
  { kind: 'release'; version: string } | { kind: 'local-artifact'; path: string; sha256: string };

async function privateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (process.getuid && info.uid !== process.getuid()) ||
    (info.mode & 0o077) !== 0
  )
    throw new Error('Runtime cache must be a private owned directory');
}

async function verifiedArtifact(path: string, hash: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 64 * 1024 * 1024)
      throw new Error('Invalid reviewed artifact');
    const bytes = Buffer.alloc(info.size + 1);
    let size = 0;
    while (size < bytes.length) {
      signal.throwIfAborted();
      const read = await file.read(bytes, size, bytes.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    const content = bytes.subarray(0, size);
    if (size !== info.size || createHash('sha256').update(content).digest('hex') !== hash)
      throw new Error('Reviewed artifact hash mismatch');
    return content;
  } finally {
    await file.close();
  }
}

/** The caller qualifies releases; remote decisions never supply package names or versions. */
export async function prepareNpmRuntime(options: {
  dataDir: string;
  packageName: string;
  runtime: NpmRuntime;
  signal: AbortSignal;
}) {
  const { runtime, packageName, signal } = options;
  if (
    !isAbsolute(options.dataDir) ||
    !/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(packageName)
  )
    throw new Error('Invalid runtime identity');
  if (
    runtime.kind === 'release'
      ? !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(runtime.version)
      : !isAbsolute(runtime.path) || !/^[a-f0-9]{64}$/.test(runtime.sha256)
  )
    throw new Error('Runtime must name an exact release or reviewed artifact');
  signal.throwIfAborted();
  await mkdir(options.dataDir, { recursive: true, mode: 0o700 });
  const profile = await lstat(options.dataDir);
  if (
    !profile.isDirectory() ||
    profile.isSymbolicLink() ||
    (process.getuid && profile.uid !== process.getuid()) ||
    (profile.mode & 0o022) !== 0
  )
    throw new Error('Invalid runtime profile');
  const root = join(options.dataDir, 'runtimes');
  await privateDirectory(root);
  const key = createHash('sha256')
    .update(
      JSON.stringify([
        packageName,
        runtime.kind,
        runtime.kind === 'release' ? runtime.version : runtime.sha256,
        process.platform,
        process.arch,
        process.versions.node.split('.')[0],
      ]),
    )
    .digest('hex');
  const cached = join(root, key);
  await privateDirectory(cached);
  const npmCache = join(cached, 'npm-cache');
  await privateDirectory(npmCache);
  const packageSpec =
    runtime.kind === 'release' ? `${packageName}@${runtime.version}` : join(cached, 'runtime.tgz');
  if (runtime.kind === 'local-artifact') {
    await withFileLock(join(cached, 'artifact.lock'), async () => {
      signal.throwIfAborted();
      const exists = await lstat(packageSpec).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return false;
          throw error;
        },
      );
      if (!exists)
        await writeFileAtomicExclusive(
          packageSpec,
          await verifiedArtifact(runtime.path, runtime.sha256, signal),
          { mode: 0o400, dirMode: 0o700 },
        );
      await verifiedArtifact(packageSpec, runtime.sha256, signal);
    });
  }
  signal.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), 'tenjin-runtime-'));
  const close = () => rm(directory, { recursive: true, force: true });
  try {
    const home = join(directory, 'home');
    const config = join(directory, 'config');
    const cache = join(directory, 'cache');
    for (const path of [home, config, cache]) await privateDirectory(path);
    const userNpm = join(directory, 'user.npmrc');
    const globalNpm = join(directory, 'global.npmrc');
    for (const path of [userNpm, globalNpm]) await writeFile(path, '', { mode: 0o600 });
    const env: NodeJS.ProcessEnv = {
      PATH: [
        dirname(process.execPath),
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '/usr/bin',
        '/bin',
      ].join(':'),
      HOME: home,
      XDG_CONFIG_HOME: config,
      XDG_CACHE_HOME: cache,
      TMPDIR: directory,
      LANG: 'C.UTF-8',
      NO_COLOR: '1',
      npm_config_cache: npmCache,
      npm_config_userconfig: userNpm,
      npm_config_globalconfig: globalNpm,
      npm_config_ignore_scripts: 'true',
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      npm_config_update_notifier: 'false',
      npm_config_registry: 'https://registry.npmjs.org/',
    };
    signal.throwIfAborted();
    return { directory, packageSpec, env, close };
  } catch (error) {
    await close();
    throw error;
  }
}
