import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LockTimeoutError } from './lock';
import { renderCodexHostFiles, renderHostFiles, RUNTIME_MISSING_FIX } from '../router/plugin-files';
import {
  activate,
  collect,
  ensureNode,
  NewerRuntime,
  pathLine,
  placeVersion,
  readNodePin,
  removeLaunchers,
  removeRuntime,
  setupRuntime,
  stageSelf,
  stageTarball,
  verifyBuild,
  withRuntimeLock,
  writeLaunchers,
  type NodePin,
  type VerifySpawn,
} from './runtime';
import {
  nodeBinPath,
  readRuntimeState,
  runtimeStatePath,
  versionDir,
  versionEntry,
} from './runtime-layout';

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return { ...real, rename: vi.fn(real.rename) };
});

const POSIX = process.platform !== 'win32';
const KEY = 'darwin-arm64';
const PLATFORM = { platform: 'darwin' as const, arch: 'arm64' };

let base: string;
let home: string;
let dataDir: string;
let root: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'runtime-'));
  home = join(base, 'home');
  dataDir = join(home, '.tenjin');
  root = join(dataDir, 'runtime');
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(fsp.rename).mockReset();
  vi.mocked(fsp.rename).mockImplementation((async (...args: Parameters<typeof fsp.rename>) => {
    const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    return real.rename(...args);
  }) as typeof fsp.rename);
  rmSync(base, { recursive: true, force: true });
});

/** Every file under `dir`, by relative path, with its bytes. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else out[relative(dir, path).split(sep).join('/')] = readFileSync(path, 'utf8');
    }
  };
  walk(dir);
  return out;
}

/** A Node release archive holding a `node` that prints `v<version>`, and its sha256. */
function nodeArchive(version: string, key = KEY): { bytes: Buffer; sha256: string } {
  const dir = mkdtempSync(join(base, 'archive-'));
  const top = `node-v${version}-${key}`;
  mkdirSync(join(dir, top, 'bin'), { recursive: true });
  writeFileSync(join(dir, top, 'bin', 'node'), `#!/bin/sh\necho v${version}\n`, { mode: 0o755 });
  writeFileSync(join(dir, top, 'README.md'), 'not kept');
  const bytes = execFileSync('tar', ['-czf', '-', '-C', dir, top]);
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/** A fetch that serves fixed bodies by URL and records what was asked. */
function server(routes: Record<string, () => Response>): typeof fetch & { urls: string[] } {
  const urls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    const route = routes[url];
    return route !== undefined ? route() : new Response('missing', { status: 404 });
  }) as typeof fetch & { urls: string[] };
  impl.urls = urls;
  return impl;
}

const nodeUrl = (v: string, key = KEY) =>
  `https://nodejs.org/dist/v${v}/node-v${v}-${key}.${key.startsWith('win') ? 'zip' : 'tar.gz'}`;

/** An installed tenjin-cli package (npm's global folder), carrying a pin. */
function npmPackage(
  version: string,
  pin: NodePin | null,
  extra: Record<string, string> = {},
): string {
  const pkg = join(
    base,
    `npm-${version}-${Math.random().toString(36).slice(2)}`,
    'node_modules',
    'tenjin-cli',
  );
  const files: Record<string, string> = {
    'package.json': JSON.stringify({
      name: 'tenjin-cli',
      version,
      ...(pin !== null ? { tenjinRuntime: { node: pin } } : {}),
    }),
    'dist/index.js': `// tenjin-cli ${version}\n`,
    'dist/hosts/claude/.claude-plugin/marketplace.json': '{}',
    'docs/troubleshooting.md': '# docs\n',
    'README.md': '# tenjin\n',
    ...extra,
  };
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(pkg, path)), { recursive: true });
    writeFileSync(join(pkg, path), body);
  }
  return pkg;
}

const ok = (async () => ({ ok: true })) as unknown as typeof verifyBuild;

describe('readNodePin', () => {
  it('reads a pin and drops hashes that are not sha256', () => {
    const pkg = npmPackage('0.1.0-alpha.32', {
      version: '24.14.1',
      sha256: { [KEY]: 'a'.repeat(64), 'linux-x64': 'nope' },
    });
    expect(readNodePin(pkg)).toEqual({ version: '24.14.1', sha256: { [KEY]: 'a'.repeat(64) } });
  });

  it('is null with no pin or a version that is not digits', () => {
    expect(readNodePin(npmPackage('0.1.0-alpha.32', null))).toBeNull();
    const bad = npmPackage('0.1.0-alpha.32', { version: '../24', sha256: {} });
    expect(readNodePin(bad)).toBeNull();
  });
});

describe('withRuntimeLock', () => {
  const DEAD = 999_999;
  const lockAt = (pid: number, startedAt: Date): void => {
    mkdirSync(join(root, '.lock'), { recursive: true });
    writeFileSync(join(root, '.lock', 'owner.json'), JSON.stringify({ pid, startedAt }));
  };
  const trashLocks = () =>
    readdirSync(join(root, 'tmp')).filter((name) => name.startsWith('trash-lock-'));

  it('writes owner.json while held and removes the lock after', async () => {
    const seen = await withRuntimeLock(root, async () =>
      JSON.parse(readFileSync(join(root, '.lock', 'owner.json'), 'utf8')),
    );
    expect(seen.pid).toBe(process.pid);
    expect(Number.isNaN(Date.parse(seen.startedAt))).toBe(false);
    expect(existsSync(join(root, '.lock'))).toBe(false);
  });

  it('takes over a lock whose owner pid is dead', async () => {
    lockAt(DEAD, new Date());
    const ran = await withRuntimeLock(root, async () => 'ran', {
      isAlive: (pid) => pid !== DEAD,
      lockWaitMs: 1_000,
    });
    expect(ran).toBe('ran');
    expect(trashLocks()).toHaveLength(1);
  });

  it('takes over a live owner whose startedAt is 11 minutes old', async () => {
    lockAt(process.pid, new Date(Date.now() - 11 * 60_000));
    await expect(
      withRuntimeLock(root, async () => 'ran', { isAlive: () => true, lockWaitMs: 1_000 }),
    ).resolves.toBe('ran');
  });

  it('waits, then times out, on a live owner under 10 minutes', async () => {
    lockAt(process.pid, new Date(Date.now() - 9 * 60_000));
    const started = Date.now();
    const err = await withRuntimeLock(root, async () => 'ran', {
      isAlive: () => true,
      lockWaitMs: 200,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LockTimeoutError);
    expect((err as Error).message).toContain(join(root, '.lock'));
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
    expect(existsSync(join(root, '.lock', 'owner.json'))).toBe(true);
  });

  it('takes over an ownerless lock only once it is older than 10 s', async () => {
    mkdirSync(join(root, '.lock'), { recursive: true });
    await expect(
      withRuntimeLock(root, async () => 'ran', { lockWaitMs: 100 }),
    ).rejects.toBeInstanceOf(LockTimeoutError);
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(root, '.lock'), old, old);
    await expect(withRuntimeLock(root, async () => 'ran', { lockWaitMs: 100 })).resolves.toBe(
      'ran',
    );
  });

  /**
   * Both waiters judge the SAME dead holder's lock stale: the second arrives
   * inside the first's judgement, before the first moves anything, takes the
   * lock over and is running its body when the first gets to its takeover.
   * The first must find a different lock there and wait, not move the live one.
   */
  it('lets exactly one of two waiters take over a stale lock, and never overlaps the bodies', async () => {
    lockAt(DEAD, new Date());
    let inside = 0;
    let overlapped = false;
    const body = async () => {
      inside += 1;
      if (inside > 1) overlapped = true;
      await new Promise((done) => setTimeout(done, 80));
      inside -= 1;
    };
    const alive = (pid: number) => pid !== DEAD;
    let second: Promise<void> | undefined;
    const first = withRuntimeLock(root, body, {
      lockWaitMs: 5_000,
      isAlive: (pid) => {
        second ??= withRuntimeLock(root, body, { isAlive: alive, lockWaitMs: 5_000 });
        return alive(pid);
      },
    });
    await Promise.all([first, second]);
    expect(second).toBeDefined();
    expect(overlapped).toBe(false);
    expect(trashLocks()).toHaveLength(1);
  });

  it('releases on a throw, and tolerates its directory going with the root', async () => {
    await expect(
      withRuntimeLock(root, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(existsSync(join(root, '.lock'))).toBe(false);
    await withRuntimeLock(root, async () => rmSync(root, { recursive: true, force: true }));
    expect(existsSync(root)).toBe(false);
  });
});

describe.skipIf(!POSIX)('ensureNode', () => {
  const V = '24.0.0';
  const opts = (fetchImpl: typeof fetch) => ({ timeoutMs: 5_000, fetchImpl, ...PLATFORM });

  it('downloads, checks and places the pinned Node, then reuses it', async () => {
    const archive = nodeArchive(V);
    const fetchImpl = server({ [nodeUrl(V)]: () => new Response(archive.bytes) });
    const pin = { version: V, sha256: { [KEY]: archive.sha256 } };
    const bin = await ensureNode(root, pin, opts(fetchImpl));
    expect(bin).toBe(nodeBinPath(root, V, 'darwin'));
    expect(execFileSync(bin, ['-p', 'process.version'], { encoding: 'utf8' }).trim()).toBe(`v${V}`);
    expect(JSON.parse(readFileSync(join(root, 'node', V, '.complete'), 'utf8'))).toEqual({
      version: V,
    });
    expect(existsSync(join(root, 'node', V, 'README.md'))).toBe(false);
    expect(readdirSync(join(root, 'tmp'))).toEqual([]);
    await ensureNode(root, pin, opts(fetchImpl));
    expect(fetchImpl.urls).toHaveLength(1);
  });

  it('rehashes a bootstrap archive and refuses corruption without fetching', async () => {
    const archive = nodeArchive(V);
    const file = join(base, 'bootstrap-node.tar.gz');
    writeFileSync(file, archive.bytes);
    const fetchImpl = server({});
    const pin = { version: V, sha256: { [KEY]: archive.sha256 } };
    await ensureNode(root, pin, { ...opts(fetchImpl), archivePath: file });
    expect(fetchImpl.urls).toEqual([]);
    rmSync(join(root, 'node'), { recursive: true });
    writeFileSync(file, Buffer.concat([archive.bytes, Buffer.from('corrupt')]));
    await expect(ensureNode(root, pin, { ...opts(fetchImpl), archivePath: file })).rejects.toThrow(
      'pinned checksum',
    );
    expect(existsSync(nodeBinPath(root, V, 'darwin'))).toBe(false);
    expect(readFileSync(file).length).toBeGreaterThan(archive.bytes.length);
  });

  it('leaves no node/<V> and an empty tmp/ when the download does not match the pin', async () => {
    const archive = nodeArchive(V);
    const fetchImpl = server({ [nodeUrl(V)]: () => new Response(archive.bytes) });
    const err = await ensureNode(
      root,
      { version: V, sha256: { [KEY]: 'f'.repeat(64) } },
      opts(fetchImpl),
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: 'UPDATE_FAILED',
      message: `the Node ${V} download did not match its pinned checksum`,
    });
    expect(existsSync(join(root, 'node', V))).toBe(false);
    expect(readdirSync(join(root, 'tmp'))).toEqual([]);
  });

  it('replaces a node/<V> with no valid .complete', async () => {
    const half = join(root, 'node', V);
    mkdirSync(join(half, 'bin'), { recursive: true });
    writeFileSync(join(half, 'bin', 'node'), 'half');
    writeFileSync(join(half, '.complete'), JSON.stringify({ version: '24.0.1' }));
    const archive = nodeArchive(V);
    const fetchImpl = server({ [nodeUrl(V)]: () => new Response(archive.bytes) });
    await ensureNode(root, { version: V, sha256: { [KEY]: archive.sha256 } }, opts(fetchImpl));
    expect(fetchImpl.urls).toHaveLength(1);
    expect(readFileSync(join(half, 'bin', 'node'), 'utf8')).toContain(`echo v${V}`);
    expect(readdirSync(join(root, 'tmp')).filter((n) => !n.startsWith('trash-'))).toEqual([]);
  });

  it('marks complete again, with no download, a node/<V> whose .complete is gone but whose binary runs', async () => {
    // What uninstall leaves on Windows while a session runs node.exe: the
    // folder cannot be renamed away, and needs not be.
    const dir = join(root, 'node', V);
    mkdirSync(join(dir, 'bin'), { recursive: true });
    writeFileSync(join(dir, 'bin', 'node'), `#!/bin/sh\necho v${V}\n`, { mode: 0o755 });
    const fetchImpl = server({});
    const renames = vi.mocked(fsp.rename);
    renames.mockClear();
    const bin = await ensureNode(
      root,
      { version: V, sha256: { [KEY]: 'a'.repeat(64) } },
      opts(fetchImpl),
    );
    expect(bin).toBe(nodeBinPath(root, V, 'darwin'));
    expect(fetchImpl.urls).toEqual([]);
    expect(renames).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join(dir, '.complete'), 'utf8'))).toEqual({ version: V });
  });

  it('is a NETWORK_ERROR that says to check nodejs.org when the download fails', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    await expect(
      ensureNode(root, { version: V, sha256: { [KEY]: 'a'.repeat(64) } }, opts(fetchImpl)),
    ).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
      fix: 'Check access to nodejs.org and run `tenjin install` again.',
    });
  });

  it('refuses a platform with no pinned Node before any download', async () => {
    const fetchImpl = server({});
    await expect(
      ensureNode(
        root,
        { version: V, sha256: { [KEY]: 'a'.repeat(64) } },
        {
          timeoutMs: 5_000,
          fetchImpl,
          platform: 'linux',
          arch: 'x64',
          glibc: undefined,
        },
      ),
    ).rejects.toThrow(/no pinned Node for linux-x64/);
    expect(fetchImpl.urls).toEqual([]);
  });
});

describe('stageSelf and placeVersion', () => {
  it('copies the package without node_modules or src', async () => {
    const pkg = npmPackage('0.1.0-alpha.32', null, {
      'node_modules/dep/index.js': 'dep',
      'src/index.ts': 'source',
      '.git/HEAD': 'ref',
    });
    const stage = await stageSelf(root, pkg);
    expect(Object.keys(snapshot(stage)).sort()).toEqual([
      'README.md',
      'dist/hosts/claude/.claude-plugin/marketplace.json',
      'dist/index.js',
      'docs/troubleshooting.md',
      'package.json',
    ]);
  });

  it('places a stage marked complete, and reuses only a complete version', async () => {
    const v = '0.1.0-alpha.32';
    const first = await stageSelf(root, npmPackage(v, null));
    const dir = await placeVersion(root, first, v);
    expect(dir).toBe(versionDir(root, v));
    expect(JSON.parse(readFileSync(join(dir, '.complete'), 'utf8'))).toEqual({ version: v });
    expect(existsSync(first)).toBe(false);

    writeFileSync(join(dir, 'dist', 'index.js'), 'kept');
    const second = await stageSelf(root, npmPackage(v, null));
    await placeVersion(root, second, v);
    expect(readFileSync(join(dir, 'dist', 'index.js'), 'utf8')).toBe('kept');
    expect(existsSync(second)).toBe(false);

    rmSync(join(dir, '.complete'));
    const third = await stageSelf(root, npmPackage(v, null));
    await placeVersion(root, third, v);
    expect(readFileSync(join(dir, 'dist', 'index.js'), 'utf8')).toBe(`// tenjin-cli ${v}\n`);
    expect(existsSync(join(dir, '.complete'))).toBe(true);
  });
});

describe('placeVersion renames on Windows', () => {
  const busy = (code: string) => Object.assign(new Error(code), { code });
  const stageOf = async (version: string): Promise<string> => {
    const stage = await stageSelf(root, npmPackage(version, null));
    return stage;
  };

  it('retries a rename that antivirus holds for a moment, then places the version', async () => {
    const stage = await stageOf('1.0.0');
    const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let failures = 0;
    vi.mocked(fsp.rename).mockImplementation((async (from, to) => {
      if (from === stage && failures < 2) {
        failures += 1;
        throw busy(failures === 1 ? 'EPERM' : 'EACCES');
      }
      return real.rename(from, to);
    }) as typeof fsp.rename);
    const dir = await placeVersion(root, stage, '1.0.0', { platform: 'win32' });
    expect(failures).toBe(2);
    expect(existsSync(join(dir, '.complete'))).toBe(true);
  });

  it('does not retry anywhere else', async () => {
    const stage = await stageOf('1.0.0');
    const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let calls = 0;
    vi.mocked(fsp.rename).mockImplementation((async (from, to) => {
      if (from === stage) {
        calls += 1;
        throw busy('EPERM');
      }
      return real.rename(from, to);
    }) as typeof fsp.rename);
    await expect(placeVersion(root, stage, '1.0.0', { platform: 'linux' })).rejects.toThrow(
      'EPERM',
    );
    expect(calls).toBe(1);
  });
});

describe.skipIf(!POSIX)('stageTarball', () => {
  const v = '0.1.0-alpha.33';
  const tarballUrl = `https://registry.npmjs.org/tenjin-cli/-/tenjin-cli-${v}.tgz`;
  const tarball = (version: string, name = 'tenjin-cli'): Buffer => {
    const dir = mkdtempSync(join(base, 'tgz-'));
    mkdirSync(join(dir, 'package', 'dist'), { recursive: true });
    writeFileSync(join(dir, 'package', 'package.json'), JSON.stringify({ name, version }));
    writeFileSync(join(dir, 'package', 'dist', 'index.js'), '//');
    return execFileSync('tar', ['-czf', '-', '-C', dir, 'package']);
  };
  const registry = (bytes: Buffer, meta: Record<string, unknown> = {}) =>
    server({
      [`https://registry.npmjs.org/tenjin-cli/${v}`]: () =>
        Response.json({
          dist: {
            tarball: tarballUrl,
            integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
            ...meta,
          },
        }),
      [tarballUrl]: () => new Response(bytes),
    });

  it('stages the release whose integrity matches', async () => {
    const stage = await stageTarball(root, v, {
      timeoutMs: 5_000,
      fetchImpl: registry(tarball(v)),
    });
    expect(JSON.parse(readFileSync(join(stage, 'package.json'), 'utf8')).version).toBe(v);
    expect(readdirSync(join(root, 'tmp')).filter((n) => n.startsWith('dl-'))).toEqual([]);
  });

  it('rejects a tarball outside the registry, an integrity mismatch and a wrong version', async () => {
    const foreign = registry(tarball(v), { tarball: 'https://evil.example/tenjin-cli.tgz' });
    await expect(stageTarball(root, v, { timeoutMs: 5_000, fetchImpl: foreign })).rejects.toThrow(
      /outside the npm registry/,
    );
    expect(foreign.urls).toHaveLength(1);

    const mismatch = registry(tarball(v), { integrity: `sha512-${'A'.repeat(86)}==` });
    await expect(stageTarball(root, v, { timeoutMs: 5_000, fetchImpl: mismatch })).rejects.toThrow(
      /did not match its integrity/,
    );

    const wrong = registry(tarball('0.1.0-alpha.34'));
    await expect(stageTarball(root, v, { timeoutMs: 5_000, fetchImpl: wrong })).rejects.toThrow(
      /holds another package/,
    );
    const other = registry(tarball(v, 'not-tenjin'));
    await expect(stageTarball(root, v, { timeoutMs: 5_000, fetchImpl: other })).rejects.toThrow(
      /holds another package/,
    );
    expect(readdirSync(join(root, 'tmp'))).toEqual([]);
  });
});

describe('verifyBuild', () => {
  const launch = { node: '/rt/node/24.0.0/bin/node', entry: '/rt/versions/1.2.3/dist/index.js' };
  type Run = Awaited<ReturnType<VerifySpawn>>;
  const done = (stdout = '', code: number | null = 0): Run => ({
    code,
    stdout,
    stderr: '',
    matched: false,
  });

  /** A spawn that answers each of the three checks as asked. */
  const fake = (o: {
    version?: () => Promise<Run>;
    hook?: (event: string) => Promise<Run>;
    mcp?: () => Promise<Run>;
  }): VerifySpawn & { calls: string[][] } => {
    const calls: string[][] = [];
    const impl = (async (command, args, opts) => {
      calls.push([command, ...args]);
      if (args.includes('--version')) return (o.version ?? (async () => done('1.2.3\n')))();
      if (args.includes('mcp')) {
        return (
          o.mcp ??
          (async () => ({ ...done('{"jsonrpc":"2.0","id":1,"result":{}}\n'), matched: true }))
        )();
      }
      const event = (JSON.parse(opts.input) as { hook_event_name: string }).hook_event_name;
      return (o.hook ?? (async () => done('')))(event);
    }) as VerifySpawn & { calls: string[][] };
    impl.calls = calls;
    return impl;
  };

  it('passes a build whose three checks pass, with every command run by the runtime node', async () => {
    const spawnImpl = fake({});
    await expect(verifyBuild(launch, '1.2.3', { spawnImpl })).resolves.toEqual({ ok: true });
    expect(spawnImpl.calls).toHaveLength(5);
    for (const call of spawnImpl.calls) expect(call[0]).toBe(launch.node);
  });

  it('fails on (a), a --version that prints another version', async () => {
    const r = await verifyBuild(launch, '1.2.3', {
      spawnImpl: fake({ version: async () => done('1.2.2') }),
    });
    expect(r).toEqual({ ok: false, reason: 'tenjin-cli 1.2.3 did not start (it printed 1.2.2)' });
  });

  it('fails on (b), a hook that exits non-zero or prints something other than JSON', async () => {
    const exits = fake({ hook: async (e) => (e === 'SessionStart' ? done('', 1) : done()) });
    expect(await verifyBuild(launch, '1.2.3', { spawnImpl: exits })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/SessionStart hook failed \(exit 1/),
    });
    const prints = fake({ hook: async (e) => (e === 'PreToolUse' ? done('hello') : done()) });
    expect(await verifyBuild(launch, '1.2.3', { spawnImpl: prints })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/PreToolUse hook printed something other than JSON/),
    });
  });

  it('fails on (c), a server that does not answer initialize', async () => {
    const r = await verifyBuild(launch, '1.2.3', {
      spawnImpl: fake({ mcp: async () => done('', null) }),
    });
    expect(r).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/did not answer initialize/),
    });
  });

  it('runs the hooks in parallel', async () => {
    let running = 0;
    let peak = 0;
    const spawnImpl = fake({
      hook: async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 30));
        running -= 1;
        return done();
      },
    });
    await verifyBuild(launch, '1.2.3', { spawnImpl });
    expect(peak).toBe(3);
  });

  it('stops a step that hangs at a 1 s total deadline', async () => {
    const started = Date.now();
    const spawnImpl = fake({ hook: () => new Promise<Run>(() => undefined) });
    const r = await verifyBuild(launch, '1.2.3', { timeoutMs: 1_000, spawnImpl });
    expect(r.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(2_500);
  });

  it('spawns with a throwaway data dir and no hand-off', async () => {
    const envs: NodeJS.ProcessEnv[] = [];
    const spawnImpl: VerifySpawn = async (_c, args, o) => {
      envs.push(o.env);
      if (args.includes('--version')) return done('1.2.3');
      if (args.includes('mcp')) return { ...done('{"id":1,"result":{}}'), matched: true };
      return done();
    };
    await verifyBuild(launch, '1.2.3', { spawnImpl });
    const data = envs[0]!.TENJIN_DATA_DIR!;
    expect(envs.every((e) => e.TENJIN_DATA_DIR === data && e.TENJIN_HANDOFF === '1')).toBe(true);
    expect(envs[0]!.TENJIN_NO_UPDATE_CHECK).toBe('1');
    expect(existsSync(data)).toBe(false);
  });
});

describe('launchers', () => {
  const bin = () => join(home, '.local', 'bin');
  const launch = () => ({
    node: join(base, 'rt node', 'node'),
    entry: join(base, 'rt node', 'index.js'),
  });

  it.skipIf(!POSIX)('passes arguments and the exit code through, written at 0o755', async () => {
    const { node, entry } = launch();
    mkdirSync(dirname(node), { recursive: true });
    writeFileSync(node, '#!/bin/sh\nfor a in "$@"; do printf "[%s]" "$a"; done\nexit 7\n', {
      mode: 0o755,
    });
    writeFileSync(entry, '');
    const r = await writeLaunchers(
      home,
      { node, entry },
      { env: { PATH: bin() }, platform: 'linux' },
    );
    expect(r).toEqual({ paths: [join(bin(), 'tenjin')], state: 'written', onPath: true });
    expect(statSync(join(bin(), 'tenjin')).mode & 0o777).toBe(0o755);
    const run = spawnSync(join(bin(), 'tenjin'), ['a', 'b c', "d'e"], { encoding: 'utf8' });
    expect(run.stdout).toBe(`[${entry}][a][b c][d'e]`);
    expect(run.status).toBe(7);
    expect(
      (await writeLaunchers(home, { node, entry }, { env: {}, platform: 'linux' })).state,
    ).toBe('current');
  });

  it.skipIf(!POSIX)('says the runtime is missing and exits 1 when the node is gone', async () => {
    const { node, entry } = launch();
    await writeLaunchers(home, { node, entry }, { env: {}, platform: 'linux' });
    const run = spawnSync(join(bin(), 'tenjin'), ['--version'], { encoding: 'utf8' });
    expect(run.status).toBe(1);
    expect(run.stderr).toBe(
      `tenjin: Tenjin's runtime is missing (${entry}). Reinstall from ${RUNTIME_MISSING_FIX} (no Node or npm needed), then follow the installer's activation instruction.\n`,
    );
  });

  it('writes through writeFileAtomic, so a reader never sees a half launcher', async () => {
    const renames = vi.mocked(fsp.rename);
    renames.mockClear();
    await writeLaunchers(home, launch(), { env: {}, platform: 'linux' });
    expect(renames.mock.calls.some(([, to]) => to === join(bin(), 'tenjin'))).toBe(true);
  });

  it('leaves a foreign file, and npm’s own link, as they are', async () => {
    mkdirSync(bin(), { recursive: true });
    writeFileSync(join(bin(), 'tenjin'), '#!/bin/sh\necho mine\n');
    const foreign = await writeLaunchers(home, launch(), { env: {}, platform: 'linux' });
    expect(foreign).toMatchObject({
      state: 'foreign',
      reason: `${join(bin(), 'tenjin')} is not Tenjin's`,
    });
    expect(readFileSync(join(bin(), 'tenjin'), 'utf8')).toBe('#!/bin/sh\necho mine\n');
    expect(await removeLaunchers(home, 'linux')).toEqual({
      removed: [],
      left: [join(bin(), 'tenjin')],
    });

    rmSync(join(bin(), 'tenjin'));
    const pkg = npmPackage('0.1.0-alpha.30', null);
    symlinkSync(join(pkg, 'dist', 'index.js'), join(bin(), 'tenjin'));
    const npm = await writeLaunchers(home, launch(), { env: {}, platform: 'linux' });
    expect(npm.state).toBe('npm');
    expect(lstatSync(join(bin(), 'tenjin')).isSymbolicLink()).toBe(true);
  });

  it('treats a shim naming node_modules/tenjin-cli as npm’s', async () => {
    mkdirSync(bin(), { recursive: true });
    writeFileSync(
      join(bin(), 'tenjin'),
      'exec node "$basedir/../lib/node_modules/tenjin-cli/dist/index.js" "$@"',
    );
    expect((await writeLaunchers(home, launch(), { env: {}, platform: 'linux' })).state).toBe(
      'npm',
    );
  });

  it('removes only its own launchers', async () => {
    await writeLaunchers(home, launch(), { env: {}, platform: 'linux' });
    expect(await removeLaunchers(home, 'linux')).toEqual({
      removed: [join(bin(), 'tenjin')],
      left: [],
    });
    expect(existsSync(join(bin(), 'tenjin'))).toBe(false);
  });

  it('is failed, never thrown, when the folder cannot be written', async () => {
    writeFileSync(join(home, '.local'), 'a file where the folder goes');
    const r = await writeLaunchers(home, launch(), { env: {}, platform: 'linux' });
    expect(r.state).toBe('failed');
    expect(r.reason).toBeTruthy();
  });

  it('writes tenjin.cmd beside the sh launcher on win32, and fails a home it cannot express', async () => {
    const winHome = 'C:\\Users\\me';
    const win = {
      node: `${winHome}\\.tenjin\\runtime\\node\\24.0.0\\node.exe`,
      entry: `${winHome}\\.tenjin\\runtime\\versions\\1.2.3\\dist\\index.js`,
      home: winHome,
    };
    const r = await writeLaunchers(
      home,
      { ...win, entry: `${winHome}\\100%\\index.js` },
      {
        env: {},
        platform: 'win32',
      },
    );
    expect(r.state).toBe('failed');
    expect(r.paths).toEqual([join(bin(), 'tenjin'), join(bin(), 'tenjin.cmd')]);
    expect(existsSync(bin())).toBe(false);
  });

  it('knows the launcher folder is on PATH with a trailing slash, and says how to add it when not', async () => {
    const withSlash = await writeLaunchers(home, launch(), {
      env: { PATH: `/usr/bin:${bin()}/` },
      platform: 'linux',
    });
    expect(withSlash.onPath).toBe(true);
    expect(withSlash.pathLine).toBeUndefined();
    const off = await writeLaunchers(home, launch(), {
      env: { PATH: '/usr/bin', SHELL: '/bin/zsh' },
      platform: 'linux',
    });
    expect(off).toMatchObject({
      onPath: false,
      pathLine: `echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc`,
    });
  });

  it('matches PATH case-insensitively on win32, from Path', async () => {
    const r = await writeLaunchers(
      home,
      {
        node: join(home, '.tenjin', 'runtime', 'node', '24.0.0', 'node.exe'),
        entry: join(home, '.tenjin', 'runtime', 'versions', '1.2.3', 'dist', 'index.js'),
      },
      { env: { Path: `C:\\Windows;${bin().toUpperCase()}\\` }, platform: 'win32' },
    );
    expect(r.onPath).toBe(true);
    expect(r.paths).toEqual([join(bin(), 'tenjin'), join(bin(), 'tenjin.cmd')]);
  });

  it('gives pathLine for zsh, bash on darwin and linux, fish, win32 and anything else', () => {
    const add = `echo 'export PATH="$HOME/.local/bin:$PATH"' >>`;
    expect(pathLine({ SHELL: '/bin/zsh' }, home, 'darwin')).toBe(`${add} ~/.zshrc`);
    expect(pathLine({ SHELL: '/bin/bash' }, home, 'darwin')).toBe(`${add} ~/.bash_profile`);
    expect(pathLine({ SHELL: '/usr/bin/bash' }, home, 'linux')).toBe(`${add} ~/.bashrc`);
    expect(pathLine({ SHELL: '/usr/bin/fish' }, home, 'linux')).toBe('fish_add_path ~/.local/bin');
    expect(pathLine({}, home, 'win32')).toBe(
      `[Environment]::SetEnvironmentVariable('Path', "$env:USERPROFILE\\.local\\bin;" + [Environment]::GetEnvironmentVariable('Path','User'), 'User')`,
    );
    expect(pathLine({ SHELL: '/bin/ksh' }, home, 'linux')).toBe(
      'export PATH="$HOME/.local/bin:$PATH"',
    );
  });
});

/** An hour ago: a folder placed then is past collect's grace for one on its way to activation. */
const anHourAgo = () => new Date(Date.now() - 60 * 60_000);

/** A version and its node in place, as an earlier ensureNode and placeVersion left them. */
function placed(cli: string, node: string, pin?: NodePin): void {
  const dir = versionDir(root, cli);
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'dist', 'index.js'), `// ${cli}`);
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: 'tenjin-cli',
      version: cli,
      ...(pin ? { tenjinRuntime: { node: pin } } : {}),
    }),
  );
  writeFileSync(join(dir, '.complete'), JSON.stringify({ version: cli }));
  const bin = nodeBinPath(root, node, 'darwin');
  mkdirSync(dirname(bin), { recursive: true });
  writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
  writeFileSync(join(root, 'node', node, '.complete'), JSON.stringify({ version: node }));
  utimesSync(join(dir, '.complete'), anHourAgo(), anHourAgo());
  utimesSync(join(root, 'node', node, '.complete'), anHourAgo(), anHourAgo());
}

const actOpts = () => ({ home, env: {}, platform: 'darwin' as const });

describe('activate', () => {
  it('records pending before the first plugin file and switches current in the last write', async () => {
    placed('1.0.0', '24.0.0');
    placed('1.1.0', '24.0.0');
    await activate(root, { cli: '1.0.0', node: '24.0.0' }, actOpts());
    const statesAtRender: unknown[] = [];
    const renames = vi.mocked(fsp.rename);
    const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    renames.mockImplementation((async (from, to) => {
      if (String(to).startsWith(join(root, 'claude'))) {
        statesAtRender.push(JSON.parse(readFileSync(runtimeStatePath(root), 'utf8')));
      }
      return real.rename(from, to);
    }) as typeof fsp.rename);
    const act = await activate(root, { cli: '1.1.0', node: '24.0.0' }, actOpts());
    expect(statesAtRender.length).toBeGreaterThan(0);
    for (const s of statesAtRender) {
      expect(s).toMatchObject({ current: { cli: '1.0.0' }, pending: { cli: '1.1.0' } });
    }
    expect(readRuntimeState(root)).toEqual({
      current: { cli: '1.1.0', node: '24.0.0' },
      previous: { cli: '1.0.0', node: '24.0.0' },
      pending: null,
    });
    expect(act.previous).toEqual({ cli: '1.0.0', node: '24.0.0' });
  });

  it('renders runtime/claude for the version, bin/tenjin at 0o755, and writes the launcher', async () => {
    placed('1.0.0', '24.0.0');
    const act = await activate(root, { cli: '1.0.0', node: '24.0.0' }, actOpts());
    const launch = {
      node: nodeBinPath(root, '24.0.0', 'darwin'),
      entry: versionEntry(root, '1.0.0'),
      platform: 'darwin' as const,
      home,
    };
    expect(snapshot(join(root, 'claude'))).toEqual(renderHostFiles('1.0.0', { launch }));
    if (POSIX)
      expect(statSync(join(root, 'claude', 'tenjin', 'bin', 'tenjin')).mode & 0o777).toBe(0o755);
    expect(act.launcher.state).toBe('written');
    expect(existsSync(join(home, '.local', 'bin', 'tenjin'))).toBe(true);
  });

  it('renders runtime/codex beside it, its launchers at 0o755, and a restore of a first activation removes it', async () => {
    placed('1.0.0', '24.0.0');
    const act = await activate(root, { cli: '1.0.0', node: '24.0.0' }, actOpts());
    const launch = {
      node: nodeBinPath(root, '24.0.0', 'darwin'),
      entry: versionEntry(root, '1.0.0'),
      platform: 'darwin' as const,
      home,
    };
    const binDir = join(root, 'codex', 'tenjin', 'bin');
    expect(snapshot(join(root, 'codex'))).toEqual(renderCodexHostFiles({ launch, binDir }));
    if (POSIX) expect(statSync(join(binDir, 'tenjin')).mode & 0o777).toBe(0o755);
    await act.restore();
    expect(snapshot(join(root, 'codex'))).toEqual({});
  });

  it('keeps the earlier previous when the same version is activated again', async () => {
    placed('1.0.0', '24.0.0');
    placed('1.1.0', '24.0.0');
    await activate(root, { cli: '1.0.0', node: '24.0.0' }, actOpts());
    await activate(root, { cli: '1.1.0', node: '24.0.0' }, actOpts());
    await activate(root, { cli: '1.1.0', node: '24.0.0' }, actOpts());
    expect(readRuntimeState(root)?.previous).toEqual({ cli: '1.0.0', node: '24.0.0' });
  });

  it('restore() puts back the exact bytes, the state and the launchers', async () => {
    placed('1.0.0', '24.0.0');
    placed('1.1.0', '24.0.0');
    await activate(root, { cli: '1.0.0', node: '24.0.0' }, actOpts());
    const before = {
      claude: snapshot(join(root, 'claude')),
      state: readFileSync(runtimeStatePath(root), 'utf8'),
      bin: snapshot(join(home, '.local', 'bin')),
    };
    const act = await activate(root, { cli: '1.1.0', node: '24.0.0' }, actOpts());
    expect(snapshot(join(root, 'claude'))).not.toEqual(before.claude);
    await act.restore();
    expect(snapshot(join(root, 'claude'))).toEqual(before.claude);
    expect(readFileSync(runtimeStatePath(root), 'utf8')).toBe(before.state);
    expect(snapshot(join(home, '.local', 'bin'))).toEqual(before.bin);
  });

  it('restore() of a first activation leaves no state, no plugin files and no launcher', async () => {
    placed('1.0.0', '24.0.0');
    const act = await activate(root, { cli: '1.0.0', node: '24.0.0' }, actOpts());
    await act.restore();
    expect(existsSync(runtimeStatePath(root))).toBe(false);
    expect(snapshot(join(root, 'claude'))).toEqual({});
    expect(existsSync(join(home, '.local', 'bin', 'tenjin'))).toBe(false);
  });

  /**
   * The lock is released between an activation and its caller's registration,
   * so install A's restore can run after install B activated and registered.
   */
  it('restore() changes nothing once a later activation has written, and still restores while it is the last', async () => {
    placed('1.0.0', '24.0.0');
    placed('1.1.0', '24.0.0');
    const a = await activate(root, { cli: '1.0.0', node: '24.0.0' }, actOpts());
    const afterA = {
      claude: snapshot(join(root, 'claude')),
      state: readFileSync(runtimeStatePath(root), 'utf8'),
      bin: snapshot(join(home, '.local', 'bin')),
    };
    const b = await activate(root, { cli: '1.1.0', node: '24.0.0' }, actOpts());
    const afterB = {
      claude: snapshot(join(root, 'claude')),
      state: readFileSync(runtimeStatePath(root), 'utf8'),
      bin: snapshot(join(home, '.local', 'bin')),
    };
    // A was a first activation: its restore would delete every file B rendered.
    await a.restore();
    expect(snapshot(join(root, 'claude'))).toEqual(afterB.claude);
    expect(readFileSync(runtimeStatePath(root), 'utf8')).toBe(afterB.state);
    expect(snapshot(join(home, '.local', 'bin'))).toEqual(afterB.bin);
    expect(readRuntimeState(root)?.current).toEqual({ cli: '1.1.0', node: '24.0.0' });
    // B is still the last activation, so its restore puts A's switch back.
    await b.restore();
    expect(snapshot(join(root, 'claude'))).toEqual(afterA.claude);
    expect(readFileSync(runtimeStatePath(root), 'utf8')).toBe(afterA.state);
    expect(snapshot(join(home, '.local', 'bin'))).toEqual(afterA.bin);
  });

  it('refuses, writing nothing, an older build once a newer one is current', async () => {
    placed('1.0.0', '24.0.0');
    placed('1.1.0', '24.0.0');
    await activate(root, { cli: '1.1.0', node: '24.0.0' }, actOpts());
    const before = {
      claude: snapshot(join(root, 'claude')),
      state: readFileSync(runtimeStatePath(root), 'utf8'),
      bin: snapshot(join(home, '.local', 'bin')),
    };
    const refused = activate(root, { cli: '1.0.0', node: '24.0.0' }, actOpts());
    await expect(refused).rejects.toBeInstanceOf(NewerRuntime);
    await expect(refused).rejects.toMatchObject({ current: { cli: '1.1.0', node: '24.0.0' } });
    expect(snapshot(join(root, 'claude'))).toEqual(before.claude);
    expect(readFileSync(runtimeStatePath(root), 'utf8')).toBe(before.state);
    expect(snapshot(join(home, '.local', 'bin'))).toEqual(before.bin);
  });

  it('refuses, changing nothing, a version or Node a collect removed since it was placed', async () => {
    placed('1.0.0', '24.0.0');
    placed('1.1.0', '24.1.0');
    await activate(root, { cli: '1.0.0', node: '24.0.0' }, actOpts());
    const state = readFileSync(runtimeStatePath(root), 'utf8');
    const claude = snapshot(join(root, 'claude'));
    rmSync(versionDir(root, '1.1.0'), { recursive: true });
    await expect(activate(root, { cli: '1.1.0', node: '24.1.0' }, actOpts())).rejects.toThrow(
      /no longer in place/,
    );
    placed('1.1.0', '24.1.0');
    rmSync(join(root, 'node', '24.1.0', '.complete'));
    await expect(activate(root, { cli: '1.1.0', node: '24.1.0' }, actOpts())).rejects.toThrow(
      /no longer in place/,
    );
    expect(readFileSync(runtimeStatePath(root), 'utf8')).toBe(state);
    expect(snapshot(join(root, 'claude'))).toEqual(claude);
  });

  it('leaves current unchanged and pending set when the render throws mid-way', async () => {
    placed('1.0.0', '24.0.0');
    placed('1.1.0', '24.0.0');
    await activate(root, { cli: '1.0.0', node: '24.0.0' }, actOpts());
    const before = snapshot(join(root, 'claude'));
    const hooks = join(root, 'claude', 'tenjin', 'hooks', 'hooks.json');
    rmSync(hooks);
    mkdirSync(join(hooks, 'blocker'), { recursive: true });
    delete before['tenjin/hooks/hooks.json'];
    await expect(activate(root, { cli: '1.1.0', node: '24.0.0' }, actOpts())).rejects.toThrow();
    expect(readRuntimeState(root)).toEqual({
      current: { cli: '1.0.0', node: '24.0.0' },
      previous: null,
      pending: { cli: '1.1.0', node: '24.0.0' },
    });
    const after = snapshot(join(root, 'claude'));
    delete after['tenjin/hooks/hooks.json/blocker'];
    expect(after).toEqual(before);
  });
});

describe('collect', () => {
  const state = (s: Record<string, unknown>) =>
    writeFileSync(runtimeStatePath(root), JSON.stringify({ schemaVersion: 1, ...s }));

  it('keeps current, previous, pending and a live version, with the Node they pin, and removes the rest', async () => {
    placed('1.0.0', '24.0.0');
    placed('1.1.0', '24.0.0');
    placed('1.2.0', '24.1.0');
    placed('1.3.0', '24.2.0', { version: '24.2.0', sha256: {} });
    placed('0.9.0', '22.0.0');
    placed('0.8.0', '22.0.0');
    state({
      current: { cli: '1.1.0', node: '24.0.0' },
      previous: { cli: '1.0.0', node: '24.0.0' },
      pending: { cli: '1.2.0', node: '24.1.0' },
    });
    mkdirSync(join(versionDir(root, '1.3.0'), '.live'), { recursive: true });
    writeFileSync(join(versionDir(root, '1.3.0'), '.live', '111'), '');
    writeFileSync(join(versionDir(root, '1.3.0'), '.live', '222'), '');
    mkdirSync(join(versionDir(root, '0.9.0'), '.live'), { recursive: true });
    writeFileSync(join(versionDir(root, '0.9.0'), '.live', '333'), '');
    const renames = vi.mocked(fsp.rename);
    renames.mockClear();
    const r = await collect(root, { isAlive: (pid) => pid === 111 });
    expect(readdirSync(join(root, 'versions')).sort()).toEqual([
      '1.0.0',
      '1.1.0',
      '1.2.0',
      '1.3.0',
    ]);
    expect(readdirSync(join(root, 'node')).sort()).toEqual(['24.0.0', '24.1.0', '24.2.0']);
    expect(r.removed.sort()).toEqual(
      [versionDir(root, '0.8.0'), versionDir(root, '0.9.0'), join(root, 'node', '22.0.0')].sort(),
    );
    // Removed by renaming into tmp/trash-* first.
    for (const path of r.removed) {
      expect(
        renames.mock.calls.some(
          ([from, to]) => from === path && String(to).includes(`${sep}tmp${sep}trash-`),
        ),
      ).toBe(true);
    }
    expect(readdirSync(join(versionDir(root, '1.3.0'), '.live'))).toEqual(['111']);
    expect(readdirSync(join(root, 'tmp'))).toEqual([]);
  });

  it('spares a version and Node placed in the last 15 minutes that no state names yet', async () => {
    // Update's parent placed 1.1.0 on Node 24.1.0 and its child is verifying
    // it; another install's collect runs meanwhile.
    placed('1.0.0', '24.0.0');
    placed('1.1.0', '24.1.0', { version: '24.1.0', sha256: {} });
    placed('0.9.0', '22.0.0');
    const now = new Date();
    utimesSync(join(versionDir(root, '1.1.0'), '.complete'), now, now);
    utimesSync(join(root, 'node', '24.1.0', '.complete'), now, now);
    state({ current: { cli: '1.0.0', node: '24.0.0' } });
    const r = await collect(root);
    expect(readdirSync(join(root, 'versions')).sort()).toEqual(['1.0.0', '1.1.0']);
    expect(readdirSync(join(root, 'node')).sort()).toEqual(['24.0.0', '24.1.0']);
    expect(r.kept).toContainEqual({
      path: versionDir(root, '1.1.0'),
      reason: 'placed for an activation still on its way',
    });
    // Once the grace has passed, nothing keeps them.
    const later = await collect(root, { now: () => Date.now() + 16 * 60_000 });
    expect(later.removed.sort()).toEqual(
      [versionDir(root, '1.1.0'), join(root, 'node', '24.1.0')].sort(),
    );
  });

  it('refreshes the grace of a complete version placeVersion finds already there', async () => {
    placed('1.0.0', '24.0.0');
    placed('1.1.0', '24.0.0');
    state({ current: { cli: '1.0.0', node: '24.0.0' } });
    await placeVersion(root, await stageSelf(root, npmPackage('1.1.0', null)), '1.1.0');
    await collect(root);
    expect(existsSync(versionDir(root, '1.1.0'))).toBe(true);
  });

  it('keeps a version a plugin folder runs, and the Node it names, though no state names them', async () => {
    placed('1.0.0', '24.0.0');
    placed('0.9.0', '22.0.0');
    placed('0.8.0', '21.0.0');
    state({ current: { cli: '1.0.0', node: '24.0.0' } });
    const r = await collect(root, { keep: [{ cli: '0.9.0', node: '22.0.0' }] });
    expect(readdirSync(join(root, 'versions')).sort()).toEqual(['0.9.0', '1.0.0']);
    expect(readdirSync(join(root, 'node')).sort()).toEqual(['22.0.0', '24.0.0']);
    expect(r.kept).toContainEqual({
      path: versionDir(root, '0.9.0'),
      reason: 'a plugin folder runs it',
    });
    expect(r.removed.sort()).toEqual(
      [versionDir(root, '0.8.0'), join(root, 'node', '21.0.0')].sort(),
    );
  });

  it('keeps a pending version when there is no current yet', async () => {
    placed('1.0.0', '24.0.0');
    state({ current: null, previous: null, pending: { cli: '1.0.0', node: '24.0.0' } });
    expect((await collect(root)).removed).toEqual([]);
  });

  it('keeps a version whose rename fails with EBUSY, for a later install', async () => {
    placed('1.0.0', '24.0.0');
    placed('0.9.0', '24.0.0');
    state({ current: { cli: '1.0.0', node: '24.0.0' } });
    const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(fsp.rename).mockImplementation((async (from, to) => {
      if (from === versionDir(root, '0.9.0')) {
        throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      }
      return real.rename(from, to);
    }) as typeof fsp.rename);
    const r = await collect(root);
    expect(r.removed).toEqual([]);
    expect(r.kept).toContainEqual({
      path: versionDir(root, '0.9.0'),
      reason: 'in use; removed by a later install',
    });
    expect(existsSync(versionDir(root, '0.9.0'))).toBe(true);
  });

  it('sweeps tmp/ of trash and of entries older than an hour only', async () => {
    placed('1.0.0', '24.0.0');
    state({ current: { cli: '1.0.0', node: '24.0.0' } });
    const tmp = join(root, 'tmp');
    mkdirSync(join(tmp, 'trash-abc'), { recursive: true });
    mkdirSync(join(tmp, 'stage-1.1.0-old'), { recursive: true });
    mkdirSync(join(tmp, 'stage-1.1.0-new'), { recursive: true });
    writeFileSync(join(tmp, 'dl-fresh'), '');
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    utimesSync(join(tmp, 'stage-1.1.0-old'), old, old);
    await collect(root);
    expect(readdirSync(tmp).sort()).toEqual(['dl-fresh', 'stage-1.1.0-new']);
  });
});

describe('removeRuntime', () => {
  it('removes the whole root, lock included, and is a no-op when there is none', async () => {
    placed('1.0.0', '24.0.0');
    expect(await removeRuntime(root)).toEqual({ removed: true, left: [] });
    expect(existsSync(root)).toBe(false);
    expect(await removeRuntime(root)).toEqual({ removed: false, left: [] });
  });
});

describe('setupRuntime', () => {
  const V = '24.0.0';
  let archive: { bytes: Buffer; sha256: string };
  let pin: NodePin;
  const nodeServer = () => server({ [nodeUrl(V)]: () => new Response(archive.bytes) });
  const failing = () => server({});

  beforeEach(() => {
    archive = POSIX ? nodeArchive(V) : { bytes: Buffer.alloc(0), sha256: 'a'.repeat(64) };
    pin = { version: V, sha256: { [KEY]: archive.sha256 } };
  });

  const setup = (
    version: string,
    o: Partial<Parameters<typeof setupRuntime>[0]> & { pkgPin?: NodePin | null } = {},
  ) => {
    const { pkgPin, ...rest } = o;
    const pkg = npmPackage(version, pkgPin === undefined ? pin : pkgPin);
    return setupRuntime({
      dataDir,
      home,
      env: {},
      version,
      moduleDir: join(pkg, 'dist'),
      refresh: false,
      fetchImpl: nodeServer(),
      verify: ok,
      ...PLATFORM,
      ...rest,
    });
  };

  it('skips a source checkout but refuses a non-default data dir, touching nothing', async () => {
    const checkout = npmPackage('0.1.0-alpha.32', pin, { 'src/index.ts': '' });
    const fromCheckout = await setupRuntime({
      dataDir,
      home,
      env: {},
      version: '0.1.0-alpha.32',
      moduleDir: join(checkout, 'dist'),
      refresh: false,
      verify: ok,
      ...PLATFORM,
    });
    expect(fromCheckout).toMatchObject({ state: 'skipped', launcher: null });
    const profile = await setup('0.1.0-alpha.32', { dataDir: join(home, 'profile') });
    expect(profile).toMatchObject({ state: 'failed', root: join(home, 'profile', 'runtime') });
    expect(existsSync(root)).toBe(false);
    expect(existsSync(join(home, '.local'))).toBe(false);
  });

  it.skipIf(!POSIX)(
    'activates a first runtime, then reports it current on the next run',
    async () => {
      const first = await setup('0.1.0-alpha.32');
      expect(first).toMatchObject({
        state: 'active',
        cli: '0.1.0-alpha.32',
        nodeVersion: V,
        node: nodeBinPath(root, V, 'darwin'),
        entry: versionEntry(root, '0.1.0-alpha.32'),
        hostsDir: join(root, 'claude'),
        firstTime: true,
      });
      expect(first.restore).toBeTypeOf('function');
      expect(readRuntimeState(root)?.current).toEqual({ cli: '0.1.0-alpha.32', node: V });

      const fetchImpl = nodeServer();
      const again = await setup('0.1.0-alpha.32', { fetchImpl });
      expect(again).toMatchObject({ state: 'current', firstTime: false, cli: '0.1.0-alpha.32' });
      expect(again.launcher?.state).toBe('current');
      expect(fetchImpl.urls).toEqual([]);
    },
  );

  it.skipIf(!POSIX)(
    'renders the mod the build ships into runtime/claude, then reports it current',
    async () => {
      const mod = {
        'types/index.d.ts': 'export interface State {}\n',
        'hooks/register.tsx': 'export default function register() {}\n',
      };
      const pkg = npmPackage(
        '0.1.0-alpha.32',
        pin,
        Object.fromEntries(
          Object.entries(mod).map(([path, body]) => [`dist/hosts/claude/tenjin/${path}`, body]),
        ),
      );
      const run = () =>
        setupRuntime({
          dataDir,
          home,
          env: {},
          version: '0.1.0-alpha.32',
          moduleDir: join(pkg, 'dist'),
          refresh: false,
          fetchImpl: nodeServer(),
          verify: ok,
          ...PLATFORM,
        });
      expect((await run()).state).toBe('active');
      const launch = {
        node: nodeBinPath(root, V, 'darwin'),
        entry: versionEntry(root, '0.1.0-alpha.32'),
        platform: 'darwin' as const,
        home,
      };
      const claude = snapshot(join(root, 'claude'));
      expect(claude).toEqual(renderHostFiles('0.1.0-alpha.32', { launch, mod }));
      expect(claude['tenjin/hooks/register.tsx']).toBe(mod['hooks/register.tsx']);
      expect(JSON.parse(claude['tenjin/hooks/hooks.json']!)).toMatchObject({
        modules: ['./register.tsx'],
      });
      expect((await run()).state).toBe('current');
    },
  );

  it.skipIf(!POSIX)('re-renders a runtime set up before it carried runtime/codex', async () => {
    await setup('0.1.0-alpha.32');
    rmSync(join(root, 'codex'), { recursive: true });
    expect((await setup('0.1.0-alpha.32')).state).toBe('active');
    expect(existsSync(join(root, 'codex', '.agents', 'plugins', 'marketplace.json'))).toBe(true);
  });

  it.skipIf(!POSIX)('re-renders when pending is left set by a crash', async () => {
    await setup('0.1.0-alpha.32');
    const s = JSON.parse(readFileSync(runtimeStatePath(root), 'utf8'));
    writeFileSync(runtimeStatePath(root), JSON.stringify({ ...s, pending: s.current }));
    expect((await setup('0.1.0-alpha.32')).state).toBe('active');
  });

  it.skipIf(!POSIX)(
    'never lets an older build replace a newer current, with or without refresh',
    async () => {
      await setup('0.1.0-alpha.40');
      for (const opts of [{ refresh: true }, {}]) {
        const kept = await setup('0.1.0-alpha.32', opts);
        expect(kept).toMatchObject({
          state: 'kept',
          newer: true,
          cli: '0.1.0-alpha.40',
          entry: versionEntry(root, '0.1.0-alpha.40'),
          reason:
            'Tenjin 0.1.0-alpha.40 is already set up here; this 0.1.0-alpha.32 did not replace it',
        });
        expect(readRuntimeState(root)?.current.cli).toBe('0.1.0-alpha.40');
      }
    },
  );

  it.skipIf(!POSIX)(
    'never switches back to an older build when a newer install finished while it staged',
    async () => {
      let afterNewer: {
        state: string;
        claude: Record<string, string>;
        bin: Record<string, string>;
      };
      // The older install read no runtime, staged, and verifies while the newer one runs whole.
      const verify = (async () => {
        expect((await setup('0.1.0-alpha.40')).state).toBe('active');
        afterNewer = {
          state: readFileSync(runtimeStatePath(root), 'utf8'),
          claude: snapshot(join(root, 'claude')),
          bin: snapshot(join(home, '.local', 'bin')),
        };
        return { ok: true };
      }) as unknown as typeof verifyBuild;
      const older = await setup('0.1.0-alpha.32', { verify });
      expect(older).toMatchObject({
        state: 'kept',
        newer: true,
        cli: '0.1.0-alpha.40',
        reason:
          'Tenjin 0.1.0-alpha.40 is already set up here; this 0.1.0-alpha.32 did not replace it',
      });
      expect(older.restore).toBeUndefined();
      expect(readFileSync(runtimeStatePath(root), 'utf8')).toBe(afterNewer!.state);
      expect(snapshot(join(root, 'claude'))).toEqual(afterNewer!.claude);
      expect(snapshot(join(home, '.local', 'bin'))).toEqual(afterNewer!.bin);
    },
  );

  it.skipIf(!POSIX)(
    'writes no launcher for a build already current once a newer install has switched since',
    async () => {
      await setup('0.1.0-alpha.32');
      const newer = await setup('0.1.0-alpha.40');
      const afterNewer = {
        state: readFileSync(runtimeStatePath(root), 'utf8'),
        claude: snapshot(join(root, 'claude')),
        bin: snapshot(join(home, '.local', 'bin')),
      };
      // Back to alpha.32 as current, alpha.40 still placed.
      await newer.restore!();
      expect(readRuntimeState(root)?.current.cli).toBe('0.1.0-alpha.32');
      // Hold the lock, so this install reads alpha.32 as current and then waits for it.
      mkdirSync(join(root, '.lock'));
      writeFileSync(
        join(root, '.lock', 'owner.json'),
        JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
      );
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      let settled: Awaited<ReturnType<typeof setupRuntime>> | undefined;
      const again = setup('0.1.0-alpha.32').then((r) => (settled = r));
      const waitUntil = performance.now() + 10_000;
      while (vi.getTimerCount() === 0 && settled === undefined && performance.now() < waitUntil) {
        await new Promise((r) => setImmediate(r));
      }
      expect(settled).toBeUndefined();
      // The newer install switches while this one waits, then lets the lock go.
      writeFileSync(runtimeStatePath(root), afterNewer.state);
      for (const [path, body] of Object.entries(afterNewer.claude)) {
        writeFileSync(join(root, 'claude', path), body);
      }
      for (const [path, body] of Object.entries(afterNewer.bin)) {
        writeFileSync(join(home, '.local', 'bin', path), body, { mode: 0o755 });
      }
      rmSync(join(root, '.lock'), { recursive: true });
      await vi.advanceTimersByTimeAsync(100);
      await again;
      expect(settled).toMatchObject({ state: 'kept', newer: true, cli: '0.1.0-alpha.40' });
      expect(snapshot(join(home, '.local', 'bin'))).toEqual(afterNewer.bin);
      expect(readFileSync(runtimeStatePath(root), 'utf8')).toBe(afterNewer.state);
    },
    20_000,
  );

  it('falls back with no runtime and a failed download', async () => {
    const r = await setup('0.1.0-alpha.32', { fetchImpl: failing() });
    expect(r).toMatchObject({ state: 'failed', launcher: null, firstTime: true });
    expect(r.reason).toMatch(/could not download/);
    expect(r.reason!.length).toBeLessThanOrEqual(200);
    expect(readRuntimeState(root)).toBeNull();
  });

  it('names the proxy, and the step that works, when the download skipped the shell’s proxy (#470)', async () => {
    const env = { HTTPS_PROXY: 'http://proxy.corp:3128' };
    const r = await setup('0.1.0-alpha.32', { fetchImpl: failing(), env, proxySupported: false });
    expect(r).toMatchObject({ state: 'failed' });
    expect(r.reason).toMatch(
      new RegExp(
        `^this shell sets HTTPS_PROXY, which Node ${process.versions.node.replace(/\./g, '\\.')} cannot send downloads through: could not download`,
      ),
    );
    expect(r.reason!.length).toBeLessThanOrEqual(200);
    expect(r.fix).toBe(
      "run `tenjin install` once with Node 24.14 or newer, which uses the proxy; Tenjin's own Node does from then on",
    );
    // A Node that uses the proxy, or no proxy at all: an ordinary failure, retried as one.
    for (const o of [
      { env, proxySupported: true },
      { env: {}, proxySupported: false },
    ]) {
      const plain = await setup('0.1.0-alpha.32', { fetchImpl: failing(), ...o });
      expect(plain.reason).toMatch(/^could not download/);
      expect(plain.fix).toBeUndefined();
    }
  });

  it('falls back with no pinned Node for this platform, naming the platform as unpinned', async () => {
    const r = await setup('0.1.0-alpha.32', { platform: 'freebsd', arch: 'x64' });
    expect(r).toMatchObject({
      state: 'failed',
      reason: 'no pinned Node for this platform, freebsd-x64',
      unpinned: 'freebsd-x64',
    });
    // A build without a pin is not the platform's fault: a later build may carry one.
    const unpinned = await setup('0.1.0-alpha.32', { pkgPin: null });
    expect(unpinned).toMatchObject({ state: 'failed', reason: `no pinned Node for ${KEY}` });
    expect(unpinned.unpinned).toBeUndefined();
  });

  it.skipIf(!POSIX)(
    'keeps an older runtime when the newer build cannot download its Node',
    async () => {
      await setup('0.1.0-alpha.31');
      const r = await setup('0.1.0-alpha.32', {
        pkgPin: { version: '24.1.0', sha256: { [KEY]: 'a'.repeat(64) } },
        fetchImpl: failing(),
      });
      expect(r).toMatchObject({
        state: 'kept',
        cli: '0.1.0-alpha.31',
        hostsDir: join(root, 'claude'),
      });
      expect(r.restore).toBeUndefined();
      expect(readRuntimeState(root)?.current.cli).toBe('0.1.0-alpha.31');
    },
  );

  it.skipIf(!POSIX)(
    'leaves state.json and runtime/claude byte-identical when verify fails',
    async () => {
      await setup('0.1.0-alpha.31');
      const state = readFileSync(runtimeStatePath(root), 'utf8');
      const claude = snapshot(join(root, 'claude'));
      const verify = (async () => ({
        ok: false,
        reason: 'its MCP server did not answer initialize',
      })) as typeof verifyBuild;
      const r = await setup('0.1.0-alpha.32', { verify });
      expect(r).toMatchObject({
        state: 'kept',
        cli: '0.1.0-alpha.31',
        reason: 'its MCP server did not answer initialize',
      });
      expect(readFileSync(runtimeStatePath(root), 'utf8')).toBe(state);
      expect(snapshot(join(root, 'claude'))).toEqual(claude);
    },
  );

  it('returns within the 35 s refresh budget when the Node download never ends', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let asked = false;
    const fetchImpl = (async () => {
      asked = true;
      return new Promise<Response>(() => undefined);
    }) as typeof fetch;
    let settled: Awaited<ReturnType<typeof setupRuntime>> | undefined;
    const started = Date.now();
    void setup('0.1.0-alpha.32', { refresh: true, fetchImpl }).then((r) => (settled = r));
    // Staging copies the package on real disk I/O before the download starts,
    // which a slow runner stretches past any fixed tick count. Wait for the
    // fetch on the wall clock: these fake timers leave `performance` alone.
    const waitUntil = performance.now() + 20_000;
    while (!asked && performance.now() < waitUntil) await new Promise((r) => setImmediate(r));
    expect(asked).toBe(true);
    for (let i = 0; i < 40 && settled === undefined; i += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      await new Promise((r) => setImmediate(r));
    }
    expect(settled).toMatchObject({ state: 'failed', reason: 'the 35 s refresh budget ran out' });
    expect(Date.now() - started).toBeLessThanOrEqual(35_000);
  }, 30_000);
});
