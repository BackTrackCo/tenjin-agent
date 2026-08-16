import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runUpdate,
  spawnCapture,
  type SpawnResult,
  type UpdateDeps,
  type UpdateSpawn,
} from './update';
import { REFUSALS, resolveNpmCli } from '../lib/install-location';
import { CliError } from '../lib/errors';
import type { CommandContext, GlobalFlags } from '../context';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-update-cmd-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeCtx(flags: Partial<GlobalFlags> = {}, isTTY = false) {
  const out: string[] = [];
  const err: string[] = [];
  const mk = (sink: string[]) =>
    ({
      write: (chunk: string | Uint8Array) => {
        sink.push(chunk.toString());
        return true;
      },
    }) as unknown as NodeJS.WritableStream;
  const ctx: CommandContext = {
    flags: { json: false, timeout: 10000, ...flags },
    dataDir: dir,
    io: { stdout: mk(out), stderr: mk(err), isTTY },
  };
  return { ctx, stdout: () => out.join(''), stderr: () => err.join('') };
}

function registry(tags: Record<string, string>) {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify(tags), { status: 200 });
  };
  return { fetchImpl, calls: () => calls };
}

const forbiddenFetch: typeof fetch = async () => {
  throw new Error('this path must not reach the network');
};

/** Records every spawn; optionally emits output and picks the outcome. */
function spawnRecorder(opts: { result?: SpawnResult; output?: string } = {}) {
  const calls: { cmd: string; args: string[]; cwd: string; timeoutMs: number }[] = [];
  const impl: UpdateSpawn = async (cmd, args, spawnOpts, onOutput) => {
    calls.push({ cmd, args, ...spawnOpts });
    if (opts.output !== undefined) onOutput(opts.output);
    return opts.result ?? { kind: 'exit', code: 0 };
  };
  return { impl, calls };
}

const forbiddenSpawn: UpdateSpawn = async () => {
  throw new Error('this path must not spawn anything');
};

/** A global npm tree: the dir above `node_modules` is a prefix, not a package. */
async function installedTree(...prefix: string[]): Promise<string> {
  const root = join(dir, ...prefix, 'node_modules', 'tenjin-cli');
  await mkdir(join(root, 'dist'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{"name":"tenjin-cli"}');
  return join(root, 'dist');
}

/** A project-local dependency: the dir above `node_modules` is a project root. */
async function localTree(): Promise<string> {
  const moduleDir = await installedTree('project');
  await writeFile(join(dir, 'project', 'package.json'), '{"name":"someone-elses-app"}');
  return moduleDir;
}

/** A source checkout: package.json with src/ beside it. */
async function checkoutTree(): Promise<string> {
  await mkdir(join(dir, 'checkout', 'src', 'commands'), { recursive: true });
  await writeFile(join(dir, 'checkout', 'package.json'), '{"name":"tenjin-cli"}');
  return join(dir, 'checkout', 'src', 'commands');
}

async function deps(overrides: Partial<UpdateDeps> = {}): Promise<UpdateDeps> {
  return {
    moduleDir: await installedTree(),
    currentVersion: '0.1.0-alpha.6',
    fetchImpl: registry({ latest: '0.1.0-alpha.7', alpha: '0.1.0-alpha.5' }).fetchImpl,
    spawnImpl: forbiddenSpawn,
    managerScript: null,
    ...overrides,
  };
}

async function caught(fn: () => Promise<unknown>): Promise<CliError> {
  try {
    await fn();
  } catch (e) {
    return e as CliError;
  }
  throw new Error('expected the call to throw');
}

describe('runUpdate', () => {
  it('installs the exact version npm just named, never the tag', async () => {
    const { ctx } = makeCtx();
    const spawned = spawnRecorder();
    const result = await runUpdate({ check: false }, ctx, await deps({ spawnImpl: spawned.impl }));
    expect(spawned.calls[0]?.args).toEqual([
      'install',
      '-g',
      '--ignore-scripts',
      'tenjin-cli@0.1.0-alpha.7',
    ]);
    expect(result.data).toEqual({
      current: '0.1.0-alpha.6',
      latest: '0.1.0-alpha.7',
      channel: 'latest',
      updateAvailable: true,
      updated: true,
    });
    expect(result.humanLines?.join(' ')).toContain('0.1.0-alpha.6 -> 0.1.0-alpha.7');
  });

  // The live-registry regression this command has to survive: `alpha` sat on
  // 0.1.0-alpha.7 from 2026-07-31 while every later build shipped on `latest`,
  // and `next` never moved off the first one. A prerelease build reads `latest`
  // and installs from there, whatever the other tags say.
  it('installs from latest for a prerelease build, ignoring the other tags', async () => {
    const { ctx } = makeCtx();
    const spawned = spawnRecorder();
    const result = await runUpdate(
      { check: false },
      ctx,
      await deps({
        currentVersion: '0.1.0-alpha.10',
        fetchImpl: registry({
          next: '0.1.0-alpha.1',
          alpha: '0.1.0-alpha.99',
          latest: '0.1.0-alpha.11',
        }).fetchImpl,
        spawnImpl: spawned.impl,
      }),
    );
    expect(spawned.calls[0]?.args).toContain('tenjin-cli@0.1.0-alpha.11');
    expect(result.data).toMatchObject({ latest: '0.1.0-alpha.11', updateAvailable: true });
  });

  it('moves a prerelease build onto a newer stable release', async () => {
    const { ctx } = makeCtx();
    const spawned = spawnRecorder();
    const result = await runUpdate(
      { check: false },
      ctx,
      await deps({
        fetchImpl: registry({ latest: '0.9.0', alpha: '0.1.0-alpha.7' }).fetchImpl,
        spawnImpl: spawned.impl,
      }),
    );
    expect(spawned.calls[0]?.args).toContain('tenjin-cli@0.9.0');
    expect(result.data).toMatchObject({ latest: '0.9.0' });
  });

  it('never drags a stable build back onto an alpha', async () => {
    const { ctx } = makeCtx();
    const spawned = spawnRecorder();
    const result = await runUpdate(
      { check: false },
      ctx,
      await deps({
        currentVersion: '1.0.0',
        fetchImpl: registry({ latest: '1.1.0', alpha: '2.0.0-alpha.1' }).fetchImpl,
        spawnImpl: spawned.impl,
      }),
    );
    expect(spawned.calls[0]?.args).toContain('tenjin-cli@1.1.0');
    expect(result.data).toMatchObject({ channel: 'latest', updated: true });
  });

  it('reports up to date without spawning, on either surface', async () => {
    const { ctx } = makeCtx();
    const result = await runUpdate(
      { check: false },
      ctx,
      await deps({ fetchImpl: registry({ latest: '0.1.0-alpha.6' }).fetchImpl }),
    );
    expect(result.data).toMatchObject({ updateAvailable: false, updated: false });
    expect(result.humanLines?.[0]).toContain('is up to date');
  });

  it('--check reports the newer version and never installs', async () => {
    const { ctx } = makeCtx();
    const result = await runUpdate({ check: true }, ctx, await deps());
    expect(result.data).toEqual({
      current: '0.1.0-alpha.6',
      latest: '0.1.0-alpha.7',
      channel: 'latest',
      updateAvailable: true,
      updated: false,
    });
    expect(result.humanLines?.join(' ')).toContain('Run tenjin update');
  });

  // Every refusal is about writing, so the read-only question is answerable
  // from a place the write would be refused.
  it('--check answers inside a source checkout', async () => {
    const { ctx } = makeCtx();
    const result = await runUpdate(
      { check: true },
      ctx,
      await deps({ moduleDir: await checkoutTree() }),
    );
    expect(result.data).toMatchObject({ latest: '0.1.0-alpha.7', updateAvailable: true });
  });

  it('refuses to install over a source checkout', async () => {
    const { ctx } = makeCtx();
    const err = await caught(async () =>
      runUpdate({ check: false }, ctx, await deps({ moduleDir: await checkoutTree() })),
    );
    expect(err.code).toBe('REFUSED');
    expect(err.exitCode).toBe(3);
    expect(err.fix).toContain('git pull');
  });

  // Pure filesystem, so it answers before the network: an offline contributor
  // gets "you are in a checkout", not "check your registry access".
  it('refuses an install in a checkout before touching the network', async () => {
    const { ctx } = makeCtx();
    const err = await caught(async () =>
      runUpdate(
        { check: false },
        ctx,
        await deps({ moduleDir: await checkoutTree(), fetchImpl: forbiddenFetch }),
      ),
    );
    expect(err.code).toBe('REFUSED');
    expect(err.fix).toContain('git pull');
  });

  // npx never had a global to replace, and writing one would silently change
  // nothing about what the next `npx tenjin` runs.
  it('refuses an npx run rather than installing a global the user never had', async () => {
    const { ctx } = makeCtx();
    const err = await caught(async () =>
      runUpdate(
        { check: false },
        ctx,
        await deps({ moduleDir: await installedTree('.npm', '_npx', 'a1b2c3') }),
      ),
    );
    expect(err.code).toBe('REFUSED');
    expect(err.message).toContain('npx cache');
    expect(err.fix).toContain('npm i -g tenjin-cli@0.1.0-alpha.7');
  });

  it('refuses a project-local dependency and points at the project', async () => {
    const { ctx } = makeCtx();
    const err = await caught(async () =>
      runUpdate({ check: false }, ctx, await deps({ moduleDir: await localTree() })),
    );
    expect(err.code).toBe('REFUSED');
    expect(err.message).toContain('project-local');
    expect(err.fix).toBe('Update it where it is declared: npm i tenjin-cli@0.1.0-alpha.7');
  });

  // Delegation, not refusal: the PATH race only bites on CROSS-manager writes,
  // and invoking the owner is what the old refusal told the user to type.
  it('delegates a pnpm-store install to pnpm', async () => {
    const { ctx } = makeCtx();
    const spawned = spawnRecorder();
    const result = await runUpdate(
      { check: false },
      ctx,
      await deps({ moduleDir: await installedTree('.pnpm'), spawnImpl: spawned.impl }),
    );
    expect(spawned.calls[0]?.cmd).toBe('pnpm');
    expect(spawned.calls[0]?.args).toEqual([
      'add',
      '-g',
      '--ignore-scripts',
      'tenjin-cli@0.1.0-alpha.7',
    ]);
    expect(result.data).toMatchObject({ updated: true });
  });

  it('delegates a bun install to bun, without a flag bun may not have', async () => {
    const { ctx } = makeCtx();
    const spawned = spawnRecorder();
    await runUpdate(
      { check: false },
      ctx,
      await deps({ moduleDir: await installedTree('.bun'), spawnImpl: spawned.impl }),
    );
    expect(spawned.calls[0]?.cmd).toBe('bun');
    expect(spawned.calls[0]?.args).toEqual(['add', '-g', 'tenjin-cli@0.1.0-alpha.7']);
  });

  // bun's global dir keeps a package.json beside node_modules, so an unscoped
  // project-local test would refuse the very install we just delegated.
  it('does not mistake a bun global for a project-local dependency', async () => {
    const { ctx } = makeCtx();
    const spawned = spawnRecorder();
    const moduleDir = await installedTree('.bun', 'install', 'global');
    await writeFile(
      join(dir, '.bun', 'install', 'global', 'package.json'),
      '{"name":"bun-global"}',
    );
    await runUpdate({ check: false }, ctx, await deps({ moduleDir, spawnImpl: spawned.impl }));
    expect(spawned.calls[0]?.cmd).toBe('bun');
  });

  it('names the delegated manager in a failure, not npm', async () => {
    const { ctx } = makeCtx();
    const spawned = spawnRecorder({ result: { kind: 'exit', code: 1 } });
    const err = await caught(async () =>
      runUpdate(
        { check: false },
        ctx,
        await deps({ moduleDir: await installedTree('.pnpm'), spawnImpl: spawned.impl }),
      ),
    );
    expect(err.message).toContain('pnpm add -g');
    expect(err.fix).toBe('Run it yourself: pnpm add -g tenjin-cli@0.1.0-alpha.7');
  });

  // yarn stays a refusal: `yarn global add` is yarn-1 only and berry dropped
  // globals, so there is no one command this can drive.
  it('still refuses yarn, whose global install exists only in yarn 1', async () => {
    const { ctx } = makeCtx();
    const err = await caught(async () =>
      runUpdate({ check: false }, ctx, await deps({ moduleDir: await installedTree('.yarn') })),
    );
    expect(err.code).toBe('REFUSED');
    expect(err.fix).toBe('yarn global add tenjin-cli@0.1.0-alpha.7');
  });

  it('a yarn install that is already current is simply up to date', async () => {
    const { ctx } = makeCtx();
    const result = await runUpdate(
      { check: false },
      ctx,
      await deps({
        moduleDir: await installedTree('.yarn'),
        fetchImpl: registry({ latest: '0.1.0-alpha.6' }).fetchImpl,
      }),
    );
    expect(result.data).toMatchObject({ updateAvailable: false });
  });

  it('refuses a version it cannot place on a release line', async () => {
    const { ctx } = makeCtx();
    const err = await caught(async () =>
      runUpdate(
        { check: false },
        ctx,
        await deps({ currentVersion: '1.0.0-rc.1', fetchImpl: forbiddenFetch }),
      ),
    );
    expect(err.code).toBe('REFUSED');
    expect(err.message).toContain('1.0.0-rc.1');
  });

  it('surfaces an unreachable registry as NETWORK_ERROR', async () => {
    const { ctx } = makeCtx();
    const failures: (typeof fetch)[] = [
      async () => {
        throw new Error('ENOTFOUND registry.npmjs.org');
      },
      async () => new Response('', { status: 503 }),
      async () => new Response('not json', { status: 200 }),
    ];
    for (const fetchImpl of failures) {
      const err = await caught(async () =>
        runUpdate({ check: false }, ctx, await deps({ fetchImpl })),
      );
      expect(err.code).toBe('NETWORK_ERROR');
    }
  });

  // A registry that answered is not a registry that could not be reached, and
  // sending the user to check their network access would be a wrong diagnosis.
  it('separates a tag that does not exist from a network failure', async () => {
    const { ctx } = makeCtx();
    const err = await caught(async () =>
      runUpdate(
        { check: false },
        ctx,
        await deps({ fetchImpl: registry({ next: 'nonsense' }).fetchImpl }),
      ),
    );
    expect(err.code).toBe('RESOURCE_NOT_FOUND');
    expect(err.message).toContain('on the latest tag');
    expect(err.fix).not.toContain('registry.npmjs.org');
  });

  it('turns a nonzero npm exit into UPDATE_FAILED carrying the output tail', async () => {
    const { ctx, stderr } = makeCtx();
    const spawned = spawnRecorder({
      result: { kind: 'exit', code: 243 },
      output: 'npm ERR! EACCES /usr/lib/node_modules',
    });
    const err = await caught(async () =>
      runUpdate({ check: false }, ctx, await deps({ spawnImpl: spawned.impl })),
    );
    expect(err.code).toBe('UPDATE_FAILED');
    expect(err.exitCode).toBe(1);
    expect(err.message).toContain('exited 243');
    expect(err.fix).toContain('npm i -g tenjin-cli@0.1.0-alpha.7');
    expect(err.details).toEqual({ output: 'npm ERR! EACCES /usr/lib/node_modules' });
    // Off a TTY the chatter belongs to the envelope only, never the stream.
    expect(stderr()).toBe('');
  });

  it('turns npm failing to start into UPDATE_FAILED with the manual command', async () => {
    const { ctx } = makeCtx();
    const spawned = spawnRecorder({
      result: { kind: 'start-failed', cause: new Error('spawn npm ENOENT') },
    });
    const err = await caught(async () =>
      runUpdate({ check: false }, ctx, await deps({ spawnImpl: spawned.impl })),
    );
    expect(err.code).toBe('UPDATE_FAILED');
    expect(err.message).toBe('Could not start npm');
    expect(err.fix).toContain('npm i -g');
  });

  it('turns a wedged npm into UPDATE_FAILED naming the budget it blew', async () => {
    const { ctx } = makeCtx();
    const spawned = spawnRecorder({ result: { kind: 'timeout' }, output: 'npm WARN retrying' });
    const err = await caught(async () =>
      runUpdate({ check: false }, ctx, await deps({ spawnImpl: spawned.impl })),
    );
    expect(err.code).toBe('UPDATE_FAILED');
    expect(err.message).toBe('npm did not finish in 300s');
    expect(err.details).toEqual({ output: 'npm WARN retrying' });
    expect(spawned.calls[0]?.timeoutMs).toBe(300_000);
  });

  it('runs npm as a node child, from the home directory, never a shell', async () => {
    const { ctx } = makeCtx();
    const spawned = spawnRecorder();
    await runUpdate(
      { check: false },
      ctx,
      await deps({
        spawnImpl: spawned.impl,
        managerScript: '/n/lib/node_modules/npm/bin/npm-cli.js',
      }),
    );
    expect(spawned.calls[0]?.cmd).toBe(process.execPath);
    expect(spawned.calls[0]?.args[0]).toBe('/n/lib/node_modules/npm/bin/npm-cli.js');
    expect(spawned.calls[0]?.cwd).toBe(homedir());
  });

  it('falls back to the npm shim when npm-cli.js cannot be found', async () => {
    const { ctx } = makeCtx();
    const spawned = spawnRecorder();
    await runUpdate(
      { check: false },
      ctx,
      await deps({ spawnImpl: spawned.impl, managerScript: null }),
    );
    expect(spawned.calls[0]?.cmd).toBe('npm');
    expect(spawned.calls[0]?.args[0]).toBe('install');
  });

  it('forwards npm chatter to stderr live at a TTY, but not under --json', async () => {
    const human = makeCtx({}, true);
    await runUpdate(
      { check: false },
      human.ctx,
      await deps({ spawnImpl: spawnRecorder({ output: 'added 1 package' }).impl }),
    );
    expect(human.stderr()).toContain('added 1 package');
    expect(human.stdout()).toBe('');

    const json = makeCtx({ json: true }, true);
    await runUpdate(
      { check: false },
      json.ctx,
      await deps({ spawnImpl: spawnRecorder({ output: 'added 1 package' }).impl }),
    );
    expect(json.stderr()).not.toContain('added 1 package');
  });

  // npm relays publisher-controlled text (deprecation notices), so the escapes
  // go but the line breaks that make the output readable stay.
  it('strips terminal escapes from npm chatter without flattening it', async () => {
    const human = makeCtx({}, true);
    await runUpdate(
      { check: false },
      human.ctx,
      await deps({ spawnImpl: spawnRecorder({ output: 'npm \x1b[2Kwarn\ndeprecated\n' }).impl }),
    );
    expect(human.stderr()).toContain('npm warn\ndeprecated\n');
    expect(human.stderr()).not.toContain('\x1b');
  });

  it('announces the completed write on stderr on every surface', async () => {
    // emitWriteNotice contract: a write to the operator's own files is announced
    // even to a piped or --json run, and stdout stays untouched.
    const piped = makeCtx({ json: true }, false);
    await runUpdate({ check: false }, piped.ctx, await deps({ spawnImpl: spawnRecorder().impl }));
    expect(piped.stderr()).toContain('replaced the global tenjin-cli with 0.1.0-alpha.7');
    expect(piped.stdout()).toBe('');
  });
});

// The default spawn path, against real children rather than an injected stub:
// it is the one mechanism this command adds, and the platform bug it can carry
// (a win32 `.cmd` that Node will not spawn without a shell) lives here.
describe('spawnCapture', () => {
  const budget = { cwd: homedir(), timeoutMs: 10_000 };

  it('returns the child exit code', async () => {
    const result = await spawnCapture(
      process.execPath,
      ['-e', 'process.exit(3)'],
      budget,
      () => {},
    );
    expect(result).toEqual({ kind: 'exit', code: 3 });
  });

  it('merges stdout and stderr into the output callback', async () => {
    let seen = '';
    const result = await spawnCapture(
      process.execPath,
      ['-e', 'process.stdout.write("out;");process.stderr.write("err;")'],
      budget,
      (chunk) => {
        seen += chunk;
      },
    );
    expect(result).toEqual({ kind: 'exit', code: 0 });
    expect(seen).toContain('out;');
    expect(seen).toContain('err;');
  });

  it('runs the child in the cwd it is given, not the caller"s', async () => {
    let seen = '';
    await spawnCapture(
      process.execPath,
      ['-e', 'process.stdout.write(process.cwd())'],
      { ...budget, cwd: dir },
      (chunk) => {
        seen += chunk;
      },
    );
    // macOS resolves the tmpdir through /private; compare on the leaf.
    expect(seen.endsWith(dir.split('/').pop() ?? '')).toBe(true);
  });

  it('reports a binary that cannot be started rather than throwing', async () => {
    const result = await spawnCapture('tenjin-no-such-binary-xyz', [], budget, () => {});
    expect(result.kind).toBe('start-failed');
  });

  it('kills a child that outlives its budget and says so', async () => {
    const result = await spawnCapture(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 30000)'],
      { ...budget, timeoutMs: 250 },
      () => {},
    );
    expect(result).toEqual({ kind: 'timeout' });
  });
});

// The set that got re-cut in three consecutive rounds. These enumerate it, so
// an added refusal cannot quietly skip declaring the properties that decide
// when it is evaluated.
describe('REFUSALS', () => {
  const SENTINEL = 'tenjin-cli@9.9.9-sentinel';
  const anyDir = join('x', 'node_modules', 'tenjin-cli', 'dist');

  it('is non-empty and every entry is fully declared', () => {
    expect(REFUSALS.length).toBeGreaterThan(0);
    for (const entry of REFUSALS) {
      expect(typeof entry.test).toBe('function');
      expect(typeof entry.needsVersion).toBe('boolean');
      expect(typeof entry.appliesToCheck).toBe('boolean');
    }
  });

  // The declaration has to match the fix string, because needsVersion is what
  // decides whether the entry may run before the fetch. One that says no but
  // interpolates the spec would emit a fix naming an empty version; one that
  // says yes without using it waits for a network round trip it does not need,
  // which is the round-2 bug.
  it('needsVersion agrees with whether the fix string names the version', () => {
    for (const entry of REFUSALS) {
      const fix = entry.error(SENTINEL, anyDir).fix ?? '';
      expect(fix.includes(SENTINEL)).toBe(entry.needsVersion);
    }
  });

  it('every entry refuses with REFUSED and a fix', () => {
    for (const entry of REFUSALS) {
      const err = entry.error(SENTINEL, anyDir);
      expect(err.code).toBe('REFUSED');
      expect(err.exitCode).toBe(3);
      expect(err.fix).toBeTruthy();
    }
  });

  // Everything here is a reason not to WRITE, and --check writes nothing. Pins
  // the property rather than a count: an entry that ever needs to stop a
  // --check has to say so.
  it('no entry claims --check, which only reports', () => {
    expect(REFUSALS.filter((e) => e.appliesToCheck)).toEqual([]);
  });
});

describe('resolveNpmCli', () => {
  /** Writes an npm install tree under `prefix` and returns its npm-cli.js. */
  async function npmTree(prefix: string, layout: 'posix' | 'win32'): Promise<string> {
    const root =
      layout === 'posix'
        ? join(prefix, 'lib', 'node_modules', 'npm', 'bin')
        : join(prefix, 'node_modules', 'npm', 'bin');
    await mkdir(root, { recursive: true });
    const cli = join(root, 'npm-cli.js');
    await writeFile(cli, '// npm');
    return cli;
  }

  it('finds npm beside the running binary', async () => {
    const prefix = join(dir, 'tarball');
    const cli = await npmTree(prefix, 'posix');
    expect(resolveNpmCli(join(prefix, 'bin', 'node'), {})).toBe(cli);
  });

  it('finds npm beside node.exe in the win32 layout', async () => {
    const prefix = join(dir, 'winnode');
    const cli = await npmTree(prefix, 'win32');
    expect(resolveNpmCli(join(prefix, 'node.exe'), {})).toBe(cli);
  });

  // Homebrew's plain `node` formula keeps only corepack in the keg and puts npm
  // at the brew prefix, so nothing sits beside the running binary and the PATH
  // shim, a symlink straight at the script, is the only way through.
  it('follows a PATH shim that is a symlink to the script', async () => {
    const brew = join(dir, 'brew');
    const cli = await npmTree(brew, 'posix');
    const keg = join(brew, 'Cellar', 'node', '23.9.0', 'bin');
    await mkdir(join(brew, 'Cellar', 'node', '23.9.0', 'lib', 'node_modules', 'corepack'), {
      recursive: true,
    });
    await mkdir(join(brew, 'bin'), { recursive: true });
    await mkdir(keg, { recursive: true });
    await symlink(cli, join(brew, 'bin', 'npm'));
    // The precondition the old resolution rested on, absent here.
    expect(existsSync(join(brew, 'Cellar', 'node', '23.9.0', 'lib', 'node_modules', 'npm'))).toBe(
      false,
    );
    // Compared against the resolved path: following a symlink is the point, and
    // macOS resolves the tmpdir through /private on the way.
    expect(resolveNpmCli(join(keg, 'node'), { PATH: join(brew, 'bin') })).toBe(realpathSync(cli));
  });

  // A shim that is a real file rather than a symlink: win32 npm.cmd, and the
  // POSIX wrapper scripts some managers write.
  it('finds npm relative to a PATH shim that is not a symlink', async () => {
    const prefix = join(dir, 'shimdir');
    const cli = await npmTree(prefix, 'posix');
    await mkdir(join(prefix, 'bin'), { recursive: true });
    await writeFile(join(prefix, 'bin', 'npm'), '#!/bin/sh\n');
    expect(resolveNpmCli(join(dir, 'nowhere', 'node'), { PATH: join(prefix, 'bin') })).toBe(cli);
  });

  it('returns null when npm is neither beside the binary nor on PATH', () => {
    expect(resolveNpmCli(join(dir, 'nowhere', 'node'), { PATH: join(dir, 'empty') })).toBeNull();
  });

  // The declared contract, not this runner's layout. Asserting a hit here would
  // assert the machine, which is what made the suite red on Homebrew.
  it('returns a script or null on this machine, never anything else', () => {
    const found = resolveNpmCli(process.execPath);
    expect(found === null || found.endsWith('npm-cli.js')).toBe(true);
  });
});
