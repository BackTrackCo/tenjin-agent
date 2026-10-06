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
  versionFreeEntry,
} from './update';
import { REFUSALS, resolveNpmCli } from '../lib/install-location';
import { CliError } from '../lib/errors';
import { buildFailureEnvelope } from '../lib/output';
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
  const calls: {
    cmd: string;
    args: string[];
    cwd: string;
    timeoutMs: number;
    env?: Record<string, string>;
  }[] = [];
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
    // The refresh names a manual fix per profile, and that string is built from
    // the home; pinned so no assertion here depends on the developer's own.
    homeDir: dir,
    refreshCommand: join(dir, 'bin', 'tenjin.js'),
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
      updateAvailable: true,
      updated: true,
      refresh: { profiles: [dir], failed: [] },
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
    expect(result.data).toMatchObject({ latest: '1.1.0', updated: true });
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
    expect(err.message).toContain('no published tenjin-cli on the latest tag');
    expect(err.fix).not.toContain('registry.npmjs.org');
  });

  // The other half of that same null, and the opposite instruction. npm HAS a
  // build on `latest`; this copy is too old to parse its version, so "no
  // published tenjin-cli" would be the wrong diagnosis one door further in.
  // VERSION_RE admits only `-alpha.N`, so the first `-beta.N`, `-rc.N`, or
  // `+build` published on `latest` lands here.
  it('separates a latest it cannot parse from a latest that is not there', async () => {
    const { ctx } = makeCtx();
    const err = await caught(async () =>
      runUpdate(
        { check: false },
        ctx,
        await deps({ fetchImpl: registry({ latest: '0.2.0-beta.1' }).fetchImpl }),
      ),
    );
    expect(err.code).toBe('RESOURCE_NOT_FOUND');
    expect(err.message).toContain('0.2.0-beta.1');
    expect(err.message).toContain('is not a version this build can read');
    expect(err.message).not.toContain('no published tenjin-cli');
    // Retrying cannot fix a version this build cannot read; naming one can.
    expect(err.fix).toContain('npm i -g tenjin-cli@<version>');
  });

  // The dist-tag map is untrusted input, so the quoted value is bounded before
  // it reaches an error the emitter will print or serialize.
  it('truncates a registry version before quoting it back', async () => {
    const { ctx } = makeCtx();
    const err = await caught(async () =>
      runUpdate(
        { check: false },
        ctx,
        await deps({ fetchImpl: registry({ latest: 'x'.repeat(500) }).fetchImpl }),
      ),
    );
    expect(err.code).toBe('RESOURCE_NOT_FOUND');
    expect(err.message).toContain('x'.repeat(40));
    expect(err.message).not.toContain('x'.repeat(41));
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

/**
 * `update` swapped the binary and nothing else, so the skills and the generated
 * hook scripts stayed at the previous version until someone re-ran `install` by
 * hand (tenjin-agent#171). It now re-materializes them by spawning the FRESHLY
 * INSTALLED entry, which is the only code that can render the new version's
 * copies.
 */
describe('runUpdate: the post-swap refresh', () => {
  const ENTRY = '/usr/local/lib/node_modules/tenjin-cli/dist/index.js';

  /** A profile directory that actually EXISTS: the refresh skips a detected data
   *  dir that is not already a directory rather than creating it. */
  const profileDir = async (name: string): Promise<string> => {
    const path = join(dir, name);
    await mkdir(path, { recursive: true });
    return path;
  };

  /** A spawn seam that answers per call, so the manager can succeed while the
   *  refresh fails — the case the whole warn path exists for. `outputs` is what
   *  each child writes to the merged pipe, indexed the same way. */
  function scriptedSpawn(outcomes: SpawnResult[], outputs: (string | undefined)[] = []) {
    const calls: {
      cmd: string;
      args: string[];
      env?: Record<string, string>;
      timeoutMs: number;
    }[] = [];
    const impl: UpdateSpawn = async (cmd, args, spawnOpts, onOutput) => {
      calls.push({
        cmd,
        args,
        timeoutMs: spawnOpts.timeoutMs,
        ...(spawnOpts.env !== undefined ? { env: spawnOpts.env } : {}),
      });
      const output = outputs[calls.length - 1];
      if (output !== undefined) onOutput(output);
      return outcomes[calls.length - 1] ?? { kind: 'exit', code: 0 };
    };
    return { impl, calls, refreshes: () => calls.slice(1) };
  }

  /** What `install --refresh` prints when it refuses: one failure envelope on
   *  stdout, which is the only place its four refusals differ.
   *
   *  Built through the REAL builder and the real writer's spacing. Hand-rolling
   *  it with a compact `JSON.stringify` produced the one shape the CLI never
   *  writes, so the parser could pass this fixture and fail on every real
   *  refusal; going through `buildFailureEnvelope` means a change to the
   *  envelope breaks this test instead of hiding behind it. */
  const refusalEnvelope = (message: string): string =>
    `${JSON.stringify(
      buildFailureEnvelope('install', new CliError('REFUSED', message)),
      null,
      2,
    )}\n`;

  type FailureData = {
    refresh: { profiles: string[]; failed: { dataDir: string; reason: string; fix: string }[] };
  };

  /**
   * THE INVOKING PROFILE, AND ONLY IT. Nothing is baked into a per-profile file
   * any more — the two bundles are the same bytes for every profile — so there
   * is no settings file to read other profiles out of, and a shelf converges
   * the next time its own `tenjin` command runs.
   */
  it('runs the new entry once, for the data dir this invocation resolved', async () => {
    const shelf = await profileDir('.tenjin-shelf');
    const { ctx } = makeCtx();
    ctx.dataDir = shelf;
    const spawned = scriptedSpawn([]);
    const result = await runUpdate(
      { check: false },
      ctx,
      await deps({ spawnImpl: spawned.impl, refreshCommand: ENTRY }),
    );
    // The manager first, then exactly one refresh.
    expect(spawned.calls.length).toBe(2);
    const call = spawned.refreshes()[0];
    expect(call?.cmd).toBe(process.execPath);
    expect(call?.args).toEqual([ENTRY, 'install', '--refresh']);
    // A minute of local file writes, and the update-check switch: a refresh must
    // not gain a tree and a cache file just because it was pointed at a dir.
    expect(call?.timeoutMs).toBe(60_000);
    expect(call?.env?.TENJIN_NO_UPDATE_CHECK).toBe('1');
    expect(call?.env?.TENJIN_DATA_DIR).toBe(shelf);
    expect((result.data as { refresh: { profiles: string[] } }).refresh.profiles).toEqual([shelf]);
  });

  /**
   * `install --refresh` converges surfaces rather than creating them — but the
   * process around it would mkdir the tree on its way out. So a data dir that is
   * not already a directory is reported, never visited.
   */
  it('never visits a data dir that is not an existing directory', async () => {
    const planted = join(dir, 'never-created');
    const { ctx } = makeCtx();
    ctx.dataDir = planted;
    const spawned = scriptedSpawn([]);
    const result = await runUpdate(
      { check: false },
      ctx,
      await deps({ spawnImpl: spawned.impl, refreshCommand: ENTRY }),
    );
    expect(spawned.refreshes()).toEqual([]);
    expect(existsSync(planted)).toBe(false);
    const data = result.data as FailureData;
    expect(data.refresh.profiles).toEqual([]);
    expect(data.refresh.failed.map((f) => f.dataDir)).toEqual([planted]);
    // The skip's own reason, not the generic "could not refresh": this profile
    // was never visited, and why is the operator's next move.
    expect(data.refresh.failed[0]?.reason).toContain('not a directory');
    expect(data.refresh.failed[0]?.fix).toContain(`TENJIN_DATA_DIR=${planted} tenjin install`);
  });

  it('never spawns a refresh when the swap itself failed', async () => {
    const { ctx } = makeCtx();
    // Every reason the manager can end badly. None may reach the refresh: there
    // is no new binary to run, and the old one would rewrite hooks with the
    // version the operator was trying to leave.
    for (const outcome of [
      { kind: 'exit', code: 1 },
      { kind: 'timeout' },
      { kind: 'start-failed', cause: new Error('ENOENT') },
    ] as SpawnResult[]) {
      const spawned = scriptedSpawn([outcome]);
      await caught(async () =>
        runUpdate(
          { check: false },
          ctx,
          await deps({ spawnImpl: spawned.impl, refreshCommand: ENTRY }),
        ),
      );
      expect(spawned.calls.length).toBe(1);
    }
  });

  /**
   * The swap is what the operator asked for and it already happened, so a failed
   * refresh is a nag, not a failure. That is also the compatibility contract for
   * `--refresh`: an old `update` runs it on a NEWER binary, so a future rename
   * lands here as "unknown option" and costs a warn rather than a wedge.
   */
  it('warns and names the manual command when a refresh fails, and still reports updated', async () => {
    const shelf = await profileDir('.tenjin-shelf');
    for (const outcome of [
      { kind: 'exit', code: 1 },
      { kind: 'timeout' },
      { kind: 'start-failed', cause: new Error('unknown option --refresh') },
    ] as SpawnResult[]) {
      const { ctx } = makeCtx();
      ctx.dataDir = shelf;
      const result = await runUpdate(
        { check: false },
        ctx,
        await deps({
          spawnImpl: scriptedSpawn([{ kind: 'exit', code: 0 }, outcome]).impl,
          refreshCommand: ENTRY,
        }),
      );
      const data = result.data as { updated: boolean } & FailureData;
      expect(data.updated).toBe(true);
      expect(data.refresh.failed.map((f) => f.dataDir)).toEqual([shelf]);
      // A bare `tenjin install` converges the DEFAULT profile, so it is not the
      // command that repairs a shelf; this is the whole point of the per-profile
      // fix string.
      expect(data.refresh.failed[0]?.fix).toContain(`TENJIN_DATA_DIR=${shelf} tenjin install`);
      const lines = result.humanLines?.join(' ') ?? '';
      expect(lines).toContain('Could not refresh');
      expect(lines).toContain(shelf);
      expect(lines).toContain(`TENJIN_DATA_DIR=${shelf} tenjin install`);
    }
  });

  /**
   * Four refusals share one exit code, so without the child's own message the
   * dir that is not a directory, the settings file that changed underneath and
   * the machine that never ran `install` all reach the operator as the same
   * line and none of them as itself.
   */
  it("carries the child's own refusal message into the parent's report", async () => {
    const shelf = await profileDir('.tenjin-shelf');
    const message = 'The hooks directory changed while it was being refreshed.';
    const { ctx } = makeCtx();
    ctx.dataDir = shelf;
    const result = await runUpdate(
      { check: false },
      ctx,
      await deps({
        spawnImpl: scriptedSpawn(
          [
            { kind: 'exit', code: 0 },
            { kind: 'exit', code: 3 },
          ],
          [undefined, refusalEnvelope(message)],
        ).impl,
        refreshCommand: ENTRY,
      }),
    );
    const data = result.data as FailureData;
    expect(data.refresh.failed[0]?.reason).toBe(message);
    expect(result.humanLines?.join('\n')).toContain(message);
  });

  /** A child that died before printing an envelope still has to say something
   *  the operator can act on, and it must not be the previous child's message. */
  it('falls back to how the child died when it printed no envelope', async () => {
    const shelf = await profileDir('.tenjin-shelf');
    for (const [outcome, expected] of [
      [{ kind: 'timeout' }, 'did not finish in 60s'],
      [{ kind: 'start-failed', cause: new Error('ENOENT') }, 'could not be started'],
      [{ kind: 'exit', code: 1 }, 'exited 1 without reporting a reason'],
    ] as [SpawnResult, string][]) {
      const { ctx } = makeCtx();
      ctx.dataDir = shelf;
      const result = await runUpdate(
        { check: false },
        ctx,
        await deps({
          spawnImpl: scriptedSpawn(
            [{ kind: 'exit', code: 0 }, outcome],
            // An older binary rejecting `--refresh` writes commander's usage
            // error, which is not an envelope of ours and must not be mined.
            [undefined, 'error: unknown option --refresh\n'],
          ).impl,
          refreshCommand: ENTRY,
        }),
      );
      expect((result.data as FailureData).refresh.failed[0]?.reason).toContain(expected);
    }
  });

  /**
   * The refresh child's envelope is a report to THIS process, not to the
   * operator's terminal; the manager's live echo exists because npm's chatter is
   * minutes of progress a human wants to watch, and this is one JSON line.
   */
  it('never echoes the refresh child output to the operator', async () => {
    const shelf = await profileDir('.tenjin-shelf');
    const { ctx, stdout, stderr } = makeCtx({}, true);
    ctx.dataDir = shelf;
    await runUpdate(
      { check: false },
      ctx,
      await deps({
        spawnImpl: scriptedSpawn(
          [
            { kind: 'exit', code: 0 },
            { kind: 'exit', code: 3 },
          ],
          [undefined, refusalEnvelope('Nothing to refresh.')],
        ).impl,
        refreshCommand: ENTRY,
      }),
    );
    expect(stdout()).not.toContain('schemaVersion');
    expect(stderr()).not.toContain('schemaVersion');
  });

  /**
   * The bare form is right only where a bare `tenjin install` would land, which
   * is the default dir under this home AND the dir this invocation resolved.
   */
  it('names the bare install only for the default profile', async () => {
    const home = await mkdtemp(join(dir, 'home-'));
    const def = join(home, '.tenjin');
    await mkdir(def, { recursive: true });
    const { ctx } = makeCtx();
    ctx.dataDir = def;
    const result = await runUpdate(
      { check: false },
      ctx,
      await deps({
        homeDir: home,
        spawnImpl: scriptedSpawn([
          { kind: 'exit', code: 0 },
          { kind: 'exit', code: 3 },
        ]).impl,
        refreshCommand: ENTRY,
      }),
    );
    const fix = (result.data as FailureData).refresh.failed[0]?.fix ?? '';
    expect(fix).toContain('Run `tenjin install`');
    expect(fix).not.toContain('TENJIN_DATA_DIR=');
  });

  /**
   * The line it replaces was true of the binary and false of everything install
   * had written, so it read as reassurance about exactly the thing that was not
   * handled.
   */
  it('reports what the refresh did instead of the old immediacy claim', async () => {
    const { ctx } = makeCtx();
    const result = await runUpdate(
      { check: false },
      ctx,
      await deps({ spawnImpl: scriptedSpawn([]).impl, refreshCommand: ENTRY }),
    );
    const lines = result.humanLines?.join(' ') ?? '';
    expect(lines).not.toContain('pick it up immediately');
    expect(lines).toContain('Refreshed the skills and hook scripts');
  });

  it('reports every profile as unrefreshed when there is no entry to re-exec', async () => {
    const { ctx } = makeCtx();
    const spawned = scriptedSpawn([]);
    const result = await runUpdate(
      { check: false },
      ctx,
      await deps({ spawnImpl: spawned.impl, refreshCommand: '' }),
    );
    // Guessing at a command is how a hook script gets rewritten by the wrong binary.
    expect(spawned.refreshes().length).toBe(0);
    const data = result.data as { updated: boolean } & FailureData;
    expect(data.updated).toBe(true);
    expect(data.refresh.failed.map((f) => f.dataDir)).toEqual([dir]);
    expect(data.refresh.failed[0]?.reason).toContain('re-execute');
  });
});

/**
 * Which path the post-swap refresh may re-execute.
 *
 * `process.argv[1]` is the path Node resolved through the bin symlink, so under
 * pnpm it points into the virtual store, whose directory names pin a version.
 * Re-running that after the swap would execute the build the update just
 * replaced and report a successful refresh over the previous version's bytes.
 */
describe('versionFreeEntry', () => {
  const npmEntry = '/usr/local/lib/node_modules/tenjin-cli/dist/index.js';

  it('passes through a path that names no version', () => {
    expect(versionFreeEntry(npmEntry)).toBe(npmEntry);
    expect(
      versionFreeEntry('/home/u/.bun/install/global/node_modules/tenjin-cli/dist/index.js'),
    ).toBe('/home/u/.bun/install/global/node_modules/tenjin-cli/dist/index.js');
  });

  it('has nothing to run without an argv', () => {
    expect(versionFreeEntry(undefined)).toBeNull();
    expect(versionFreeEntry('')).toBeNull();
  });

  it('derives the version-free link out of the pnpm virtual store', async () => {
    // The real layout: the store entry names the version, and the link beside
    // `.pnpm` does not. The swap repoints that link, so it is the new build.
    const root = join(dir, 'pnpm', 'global', '5', 'node_modules');
    const stored = join(
      root,
      '.pnpm',
      'tenjin-cli@0.1.0-alpha.6',
      'node_modules',
      'tenjin-cli',
      'dist',
    );
    const linked = join(root, 'tenjin-cli', 'dist');
    await mkdir(stored, { recursive: true });
    await mkdir(linked, { recursive: true });
    await writeFile(join(linked, 'index.js'), '');
    expect(versionFreeEntry(join(stored, 'index.js'))).toBe(join(linked, 'index.js'));
  });

  it('refuses rather than running a store path whose link is not there', async () => {
    const stored = join(
      dir,
      'nm',
      '.pnpm',
      'tenjin-cli@0.1.0-alpha.6',
      'node_modules',
      'tenjin-cli',
    );
    await mkdir(stored, { recursive: true });
    // Nothing at the derived path, so there is no new build to name: a warn
    // beats running the version the update just replaced.
    expect(versionFreeEntry(join(stored, 'dist', 'index.js'))).toBeNull();
    expect(versionFreeEntry(join(dir, 'nm', '.pnpm', 'weird'))).toBeNull();
  });

  it('keeps a pnpm machine off the old build, reporting it unrefreshed', async () => {
    const { ctx } = makeCtx();
    const spawned = spawnRecorder();
    const result = await runUpdate(
      { check: false },
      ctx,
      await deps({
        spawnImpl: spawned.impl,
        moduleDir: await installedTree('.pnpm'),
        refreshCommand: join(
          dir,
          'nm',
          '.pnpm',
          'tenjin-cli@0.1.0-alpha.6',
          'node_modules',
          'tenjin-cli',
          'dist',
          'index.js',
        ),
      }),
    );
    // The manager ran; nothing else did.
    expect(spawned.calls.length).toBe(1);
    const data = result.data as {
      updated: boolean;
      refresh: { failed: { dataDir: string; reason: string; fix: string }[] };
    };
    expect(data.updated).toBe(true);
    expect(data.refresh.failed.map((f) => f.dataDir)).toEqual([dir]);
    expect(result.humanLines?.join(' ')).toContain('tenjin install');
  });
});
