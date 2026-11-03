import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
import { buildFailureEnvelope, buildSuccessEnvelope } from '../lib/output';
import { PLUGIN_ID } from '../router/names';
import { runRouterInstall } from '../router/install';
import { RECONNECT_FIX } from '../router/mcp-processes';
import { ROUTING_FEE_TERMS } from '../router/spend-question';
import { attestationsFor } from '../lib/fixtures/npm-attestations';
import { nodeBinPath, versionEntry } from '../lib/runtime-layout';
import type { NodePin } from '../lib/runtime';
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

const RELEASE_DOC = /^https:\/\/registry\.npmjs\.org\/tenjin-cli\/([^/]+)$/;
const ATTESTATIONS = /^https:\/\/registry\.npmjs\.org\/-\/npm\/v1\/attestations\/tenjin-cli@(.+)$/;

/**
 * npm's answer about one release, as the provenance check reads it: the
 * per-version document, and attestations that name that version and sha512,
 * built by Tenjin's release workflow (`attested: false`: a 404, none at all).
 * Null for any other URL.
 */
function releaseAnswer(url: string, o: { attested?: boolean } = {}): Response | null {
  const sha512 = (v: string) => createHash('sha512').update(v);
  const doc = RELEASE_DOC.exec(url);
  if (doc !== null) {
    const v = doc[1]!;
    return Response.json({
      dist: {
        tarball: `https://registry.npmjs.org/tenjin-cli/-/tenjin-cli-${v}.tgz`,
        integrity: `sha512-${sha512(v).digest('base64')}`,
      },
    });
  }
  const att = ATTESTATIONS.exec(url);
  if (att === null) return null;
  if (o.attested === false) return new Response('{}', { status: 404 });
  return Response.json(attestationsFor(att[1]!, sha512(att[1]!).digest('hex')));
}

/** npm with these dist-tags, whose releases all carry Tenjin's provenance unless `attested` is false. */
function registry(tags: Record<string, string>, o: { attested?: boolean } = {}) {
  const fetchImpl: typeof fetch = async (input) =>
    releaseAnswer(String(input), o) ?? new Response(JSON.stringify(tags), { status: 200 });
  return { fetchImpl };
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
    listMcpProcesses: async () => [],
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
      refresh: {
        profiles: [dir],
        failed: [],
        notices: [],
        settingsInstallPending: false,
        projects: [],
        projectsFailed: [],
      },
      mcpServer: {
        name: 'mcp server',
        status: 'ok',
        required: false,
        detail: 'none running (starts with the next session)',
      },
    });
    expect(result.humanLines?.join(' ')).toContain('0.1.0-alpha.6 -> 0.1.0-alpha.7');
    // The install question names the routing fee; update stays silent about it.
    expect(result.humanLines?.join(' ')).not.toContain(ROUTING_FEE_TERMS);
  });

  it('spawns no package manager for a release without Tenjin’s provenance', async () => {
    const spawned = spawnRecorder();
    const err = await caught(async () =>
      runUpdate(
        { check: false },
        makeCtx().ctx,
        await deps({
          fetchImpl: registry({ latest: '0.1.0-alpha.7' }, { attested: false }).fetchImpl,
          spawnImpl: spawned.impl,
        }),
      ),
    );
    expect(err.code).toBe('UPDATE_FAILED');
    expect(err.message).toContain('has no valid build provenance');
    expect(spawned.calls).toEqual([]);
  });

  it('never re-adds the Codex plugin: it carries no version, so nothing changes between builds', async () => {
    const { ctx } = makeCtx();
    const spawned = spawnRecorder();
    const result = await runUpdate({ check: false }, ctx, await deps({ spawnImpl: spawned.impl }));
    expect(spawned.calls.some((call) => call.args.includes('--harness'))).toBe(false);
    expect(spawned.calls.some((call) => call.cmd === 'codex')).toBe(false);
    expect(result.data).not.toHaveProperty('codex');
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

  /** A project directory holding a `--project` install, as Claude Code's local
   *  scope records it: the refresh forgets a recorded project that holds none. */
  const projectDir = async (name: string): Promise<string> => {
    const path = await profileDir(join(name, '.claude'));
    await writeFile(
      join(path, 'settings.local.json'),
      JSON.stringify({ enabledPlugins: { [PLUGIN_ID]: true } }),
    );
    return join(dir, name);
  };

  /** A spawn seam that answers per call, so the manager can succeed while the
   *  refresh fails — the case the whole warn path exists for. `outputs` is what
   *  each child writes to the merged pipe, indexed the same way. */
  function scriptedSpawn(outcomes: SpawnResult[], outputs: (string | undefined)[] = []) {
    const calls: {
      cmd: string;
      args: string[];
      cwd: string;
      env?: Record<string, string>;
      timeoutMs: number;
    }[] = [];
    const impl: UpdateSpawn = async (cmd, args, spawnOpts, onOutput) => {
      calls.push({
        cmd,
        args,
        cwd: spawnOpts.cwd,
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
    expect(lines).toContain('Refreshed the Claude Code plugin');
  });

  it('names a running tenjin mcp that predates the update, with the reconnect fix', async () => {
    const { ctx } = makeCtx();
    const result = await runUpdate(
      { check: false },
      ctx,
      await deps({
        spawnImpl: scriptedSpawn([]).impl,
        refreshCommand: ENTRY,
        listMcpProcesses: async () => [{ pid: 9044, startedAt: 1 }],
        installedAt: async () => 2,
      }),
    );
    const lines = result.humanLines?.join('\n') ?? '';
    expect(lines).toContain('1 running `tenjin mcp` process started before this install');
    expect(lines).toContain(RECONNECT_FIX);
    expect(lines).not.toContain('/reload-plugins');
    expect(result.data).toMatchObject({ mcpServer: { status: 'warn' } });
  });

  /**
   * A REFRESH THAT SUCCEEDED CAN STILL HAVE SOMETHING TO SAY: a plugin left for
   * a newer Claude Code, a status line the migration took out. The child puts
   * it in `data.notices` and update prints it, since it shows nothing else of a
   * successful child. Either way the stale-server fix is a new session, since
   * `/reload-plugins` does not run the plugin's `SessionStart`.
   */
  it("prints the refresh's notices and asks for a new session while a settings install stays", async () => {
    const { ctx } = makeCtx();
    const child = `${JSON.stringify(
      buildSuccessEnvelope('install', {
        refresh: true,
        migration: { state: 'pending' },
        notices: [
          'Removed the Tenjin status line (`tenjin status-line`) with the earlier settings setup; the plugin sets none.',
        ],
      }),
      null,
      2,
    )}\n`;
    const result = await runUpdate(
      { check: false },
      ctx,
      await deps({
        spawnImpl: scriptedSpawn([], [undefined, child]).impl,
        refreshCommand: ENTRY,
        listMcpProcesses: async () => [{ pid: 9044, startedAt: 1 }],
        installedAt: async () => 2,
      }),
    );
    const lines = result.humanLines ?? [];
    expect(lines).toContain(
      'Removed the Tenjin status line (`tenjin status-line`) with the earlier settings setup; the plugin sets none.',
    );
    const text = lines.join('\n');
    expect(text).toContain('Start a new Claude Code session');
    expect(text).not.toContain('/reload-plugins');
    expect(result.data).toMatchObject({
      refresh: { settingsInstallPending: true },
      mcpServer: { fix: expect.stringContaining('Start a new Claude Code session') },
    });
  });

  /**
   * A `--project` INSTALL IS CLAUDE CODE'S LOCAL SCOPE, which the refresh from
   * home cannot see. Each project `install --project` recorded is refreshed from
   * its own directory, as `--project`; one that is gone is forgotten.
   */
  it('refreshes each recorded project install from its own directory', async () => {
    const profile = await profileDir('.tenjin');
    const kept = await projectDir('app');
    const gone = join(dir, 'deleted-app');
    await writeFile(
      join(profile, 'config.json'),
      JSON.stringify({ install: { routerProjects: [kept, gone] } }),
    );
    const said = (scope: string) =>
      `${JSON.stringify(buildSuccessEnvelope('install', { refresh: true, scope }), null, 2)}\n`;
    const { ctx } = makeCtx();
    ctx.dataDir = profile;
    const spawned = scriptedSpawn([], [undefined, said('user'), said('local')]);
    const result = await runUpdate(
      { check: false },
      ctx,
      await deps({ spawnImpl: spawned.impl, refreshCommand: ENTRY }),
    );
    expect(spawned.refreshes().map((c) => c.cwd)).toEqual([homedir(), kept]);
    expect(spawned.refreshes().map((c) => c.args)).toEqual([
      [ENTRY, 'install', '--refresh'],
      [ENTRY, 'install', '--refresh', '--project'],
    ]);
    for (const call of spawned.refreshes()) expect(call.env?.TENJIN_DATA_DIR).toBe(profile);
    expect(result.data).toMatchObject({ refresh: { projects: [kept], projectsFailed: [] } });
    expect(result.humanLines).toContain(`Refreshed the project install in ${kept}.`);
    const config = JSON.parse(await readFile(join(profile, 'config.json'), 'utf8')) as {
      install: { routerProjects: string[] };
    };
    expect(config.install.routerProjects).toEqual([kept]);
  });

  /**
   * A `--project` INSTALL AT HOME shares the user install's plugin folder and
   * settings file, so only its `settings.local.json` proves it. It is kept and
   * refreshed from home as `--project`, never taken for the user install.
   */
  it('keeps and refreshes a recorded project install at home', async () => {
    const profile = await profileDir('.tenjin');
    const home = await projectDir('home');
    await writeFile(
      join(profile, 'config.json'),
      JSON.stringify({ install: { routerProjects: [home] } }),
    );
    const { ctx } = makeCtx();
    ctx.dataDir = profile;
    const spawned = scriptedSpawn([]);
    const result = await runUpdate(
      { check: false },
      ctx,
      await deps({ spawnImpl: spawned.impl, refreshCommand: ENTRY, homeDir: home }),
    );
    expect(spawned.refreshes().at(-1)).toMatchObject({
      cwd: home,
      args: [ENTRY, 'install', '--refresh', '--project'],
    });
    expect(result.data).toMatchObject({ refresh: { projects: [home], projectsFailed: [] } });
    const config = JSON.parse(await readFile(join(profile, 'config.json'), 'utf8')) as {
      install: { routerProjects: string[] };
    };
    expect(config.install.routerProjects).toEqual([home]);
  });

  it('names the project and its own fix when a project refresh fails', async () => {
    const profile = await profileDir('.tenjin');
    const app = await projectDir('app');
    await writeFile(
      join(profile, 'config.json'),
      JSON.stringify({ install: { routerProjects: [app] } }),
    );
    const { ctx } = makeCtx();
    ctx.dataDir = profile;
    const result = await runUpdate(
      { check: false },
      ctx,
      await deps({
        spawnImpl: scriptedSpawn([
          { kind: 'exit', code: 0 },
          { kind: 'exit', code: 0 },
          { kind: 'timeout' },
        ]).impl,
        refreshCommand: ENTRY,
      }),
    );
    expect(result.data).toMatchObject({
      refresh: {
        failed: [],
        projects: [],
        projectsFailed: [
          {
            project: app,
            reason: 'It did not finish in 60s.',
            fix: `Run \`tenjin install --project\` in ${app}.`,
          },
        ],
      },
    });
    expect(result.humanLines?.join('\n')).toContain('Could not refresh the project install in 1:');
  });

  /**
   * AN INSTALL REMOVED WITHOUT `uninstall --project` (a `git clean -fdx` took
   * `.claude/settings.local.json`) leaves its record behind. Refreshed, it
   * would fail as "nothing to refresh" on every update; it is forgotten
   * instead, with no child spawned there.
   */
  it('forgets a recorded project that no longer holds an install', async () => {
    const profile = await profileDir('.tenjin');
    const cleaned = await profileDir('app');
    await writeFile(
      join(profile, 'config.json'),
      JSON.stringify({ install: { routerProjects: [cleaned] } }),
    );
    const { ctx } = makeCtx();
    ctx.dataDir = profile;
    const spawned = scriptedSpawn([]);
    const result = await runUpdate(
      { check: false },
      ctx,
      await deps({ spawnImpl: spawned.impl, refreshCommand: ENTRY }),
    );
    expect(spawned.refreshes().map((c) => c.cwd)).toEqual([homedir()]);
    expect(result.data).toMatchObject({ refresh: { projects: [], projectsFailed: [] } });
    const config = JSON.parse(await readFile(join(profile, 'config.json'), 'utf8')) as {
      install: { routerProjects: string[] };
    };
    expect(config.install.routerProjects).toEqual([]);
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

/**
 * THE RUNTIME BRANCH. With Tenjin's runtime under the default data dir, this
 * OLD build stages the release, ensures its Node and places it; the NEW build,
 * spawned on that Node, checks and switches itself. No package manager runs,
 * and the verdict is read back from `state.json`.
 */
describe('runUpdate: the runtime branch', () => {
  const PIN: NodePin = { version: '24.15.0', sha256: { 'darwin-arm64': 'a'.repeat(64) } };
  let home: string;
  let dataDir: string;
  let root: string;
  beforeEach(async () => {
    home = join(dir, 'home');
    dataDir = join(home, '.tenjin');
    root = join(dataDir, 'runtime');
    await mkdir(root, { recursive: true });
  });

  const pointer = (cli: string) => ({ cli, node: PIN.version });
  /** `state.json` as `activate` writes it. No node or entry files are made for
   *  it: a runtime whose current is missing files still updates. */
  const writeState = (current: string, previous: string | null = null) =>
    writeFile(
      join(root, 'state.json'),
      JSON.stringify({
        schemaVersion: 1,
        current: pointer(current),
        previous: previous === null ? null : pointer(previous),
        pending: null,
      }),
    );
  const readState = () => readFile(join(root, 'state.json'), 'utf8');

  /** A release as `stageTarball` leaves it: a checked package in `tmp/`. */
  async function stagedPackage(version: string, pin: NodePin | null = PIN): Promise<string> {
    const stage = join(root, 'tmp', `stage-${version}-fixture`);
    await mkdir(join(stage, 'dist'), { recursive: true });
    await writeFile(join(stage, 'dist', 'index.js'), '');
    await writeFile(
      join(stage, 'package.json'),
      JSON.stringify({
        name: 'tenjin-cli',
        version,
        ...(pin === null ? {} : { tenjinRuntime: { node: pin } }),
      }),
    );
    return stage;
  }

  /** The download and the Node, recorded; never the network. */
  function seams(pin: NodePin | null = PIN) {
    const staged: { root: string; version: string; timeoutMs: number }[] = [];
    const ensured: { root: string; pin: NodePin; timeoutMs: number }[] = [];
    const stage: UpdateDeps['stage'] = async (r, version, o) => {
      staged.push({ root: r, version, timeoutMs: o.timeoutMs });
      return stagedPackage(version, pin);
    };
    const ensure: UpdateDeps['ensure'] = async (r, p, o) => {
      ensured.push({ root: r, pin: p, timeoutMs: o.timeoutMs });
      return nodeBinPath(r, p.version);
    };
    return { stage, ensure, staged, ensured };
  }

  const forbiddenStage: UpdateDeps['stage'] = async () => {
    throw new Error('this path must not download a release');
  };
  const forbiddenEnsure: UpdateDeps['ensure'] = async () => {
    throw new Error('this path must not download a Node');
  };

  /** The new build's `install --refresh`, one answer per call. */
  function children(
    answer: (index: number) => Promise<{ result?: SpawnResult; output?: string } | void>,
  ) {
    const calls: { cmd: string; args: string[]; cwd: string; env?: Record<string, string> }[] = [];
    const impl: UpdateSpawn = async (cmd, args, o, onOutput) => {
      calls.push({ cmd, args, cwd: o.cwd, ...(o.env !== undefined ? { env: o.env } : {}) });
      const said = (await answer(calls.length - 1)) ?? {};
      if (said.output !== undefined) onOutput(said.output);
      return said.result ?? { kind: 'exit', code: 0 };
    };
    return { impl, calls };
  }

  const envelope = (data: Record<string, unknown>): string =>
    `${JSON.stringify(buildSuccessEnvelope('install', data), null, 2)}\n`;
  const refusal = (message: string): string =>
    `${JSON.stringify(buildFailureEnvelope('install', new CliError('REFUSED', message)), null, 2)}\n`;

  it('updates with no package manager, from an npx run too, and holds no lock while the child runs', async () => {
    await writeState('0.1.0-alpha.6');
    const { ctx, stderr } = makeCtx();
    ctx.dataDir = dataDir;
    const s = seams();
    let lockHeld: boolean | undefined;
    const spawned = children(async () => {
      lockHeld = existsSync(join(root, '.lock'));
      await writeState('0.1.0-alpha.7', '0.1.0-alpha.6');
    });
    const result = await runUpdate(
      { check: false },
      ctx,
      await deps({
        // The npx cache: the stage-2 refusal would stop the npm branch here.
        moduleDir: await installedTree('_npx', 'f00d'),
        currentVersion: '0.1.0-alpha.5',
        homeDir: home,
        spawnImpl: spawned.impl,
        stage: s.stage,
        ensure: s.ensure,
        // A session still running the version just replaced.
        listMcpProcesses: async () => [{ pid: 9044, startedAt: 1, version: '0.1.0-alpha.6' }],
      }),
    );

    expect(s.staged).toEqual([{ root, version: '0.1.0-alpha.7', timeoutMs: 120_000 }]);
    expect(s.ensured).toEqual([{ root, pin: PIN, timeoutMs: 300_000 }]);
    // Placed for real: complete, and the stage moved in rather than copied.
    expect(existsSync(join(root, 'versions', '0.1.0-alpha.7', '.complete'))).toBe(true);
    expect(existsSync(join(root, 'tmp', 'stage-0.1.0-alpha.7-fixture'))).toBe(false);

    // One child, the new build on the Node it pins, and no manager at all.
    expect(spawned.calls).toEqual([
      {
        cmd: nodeBinPath(root, PIN.version),
        args: [versionEntry(root, '0.1.0-alpha.7'), 'install', '--refresh'],
        cwd: homedir(),
        env: { TENJIN_DATA_DIR: dataDir, TENJIN_NO_UPDATE_CHECK: '1' },
      },
    ]);
    expect(lockHeld).toBe(false);

    expect(result.data).toMatchObject({
      current: '0.1.0-alpha.6',
      latest: '0.1.0-alpha.7',
      updated: true,
      mcpServer: { status: 'warn', fix: RECONNECT_FIX },
    });
    const lines = result.humanLines ?? [];
    expect(lines.slice(0, 2)).toEqual([
      'Updated tenjin-cli 0.1.0-alpha.6 -> 0.1.0-alpha.7.',
      'The previous version (0.1.0-alpha.6) stays as the fallback.',
    ]);
    expect(lines.join('\n')).toContain(RECONNECT_FIX);
    expect(stderr()).toContain(
      'tenjin update: staged tenjin-cli 0.1.0-alpha.7 in ~/.tenjin/runtime',
    );
  });

  it('names the proxy, and a Node that uses it, when the download skipped the shell’s proxy (#470)', async () => {
    await writeState('0.1.0-alpha.6');
    const { ctx } = makeCtx();
    ctx.dataDir = dataDir;
    const s = seams();
    const offline: UpdateDeps['ensure'] = async () => {
      throw new CliError('NETWORK_ERROR', 'could not download https://nodejs.org/x: fetch failed');
    };
    vi.stubEnv('HTTPS_PROXY', 'http://proxy.corp:3128');
    try {
      const run = async (proxySupported: boolean) =>
        runUpdate(
          { check: false },
          ctx,
          await deps({
            moduleDir: await installedTree('_npx', 'f00d'),
            currentVersion: '0.1.0-alpha.5',
            homeDir: home,
            spawnImpl: children(async () => undefined).impl,
            stage: s.stage,
            ensure: offline,
            proxySupported,
          }),
        ).catch((e: unknown) => e);
      const err = await run(false);
      expect(err).toMatchObject({
        code: 'NETWORK_ERROR',
        message: `could not download https://nodejs.org/x: fetch failed: this shell sets HTTPS_PROXY, which Node ${process.versions.node} cannot send downloads through`,
        fix: "Run `tenjin update` once with Node 24.14 or newer, which uses the proxy; Tenjin's own Node does from then on.",
      });
      // The stage goes either way; nothing points at it.
      expect(existsSync(join(root, 'tmp', 'stage-0.1.0-alpha.7-fixture'))).toBe(false);
      expect(await run(true)).toMatchObject({
        message: 'could not download https://nodejs.org/x: fetch failed',
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('copies this npm build when it is the release, and downloads no tarball', async () => {
    await writeState('0.1.0-alpha.6');
    const { ctx } = makeCtx();
    ctx.dataDir = dataDir;
    const s = seams();
    const spawned = children(() => writeState('0.1.0-alpha.7', '0.1.0-alpha.6'));
    // Built before the package is written: the default `deps` tree is this same folder.
    const d = await deps({
      currentVersion: '0.1.0-alpha.7',
      homeDir: home,
      spawnImpl: spawned.impl,
      stage: forbiddenStage,
      ensure: s.ensure,
    });
    const moduleDir = d.moduleDir!;
    await writeFile(
      join(moduleDir, '..', 'package.json'),
      JSON.stringify({
        name: 'tenjin-cli',
        version: '0.1.0-alpha.7',
        tenjinRuntime: { node: PIN },
      }),
    );
    await writeFile(join(moduleDir, 'index.js'), '// this build');
    await runUpdate({ check: false }, ctx, d);
    expect(await readFile(versionEntry(root, '0.1.0-alpha.7'), 'utf8')).toBe('// this build');
    expect(s.ensured.map((e) => e.pin)).toEqual([PIN]);
    expect(spawned.calls[0]?.args[0]).toBe(versionEntry(root, '0.1.0-alpha.7'));
  });

  it('offers Node-free official recovery when this release cannot find its package', async () => {
    await writeState('0.1.0-alpha.6');
    const before = await readState();
    const { ctx } = makeCtx();
    ctx.dataDir = dataDir;
    const moduleDir = join(dir, 'missing-package', 'dist');
    await mkdir(moduleDir, { recursive: true });
    const err = await caught(async () =>
      runUpdate(
        { check: false },
        ctx,
        await deps({
          moduleDir,
          currentVersion: '0.1.0-alpha.7',
          homeDir: home,
          spawnImpl: forbiddenSpawn,
          stage: forbiddenStage,
          ensure: forbiddenEnsure,
        }),
      ),
    );
    expect(err).toMatchObject({
      code: 'UPDATE_FAILED',
      message: 'tenjin-cli 0.1.0-alpha.7 cannot find its own package, so 0.1.0-alpha.6 stays',
      fix: "Reinstall from https://tenjin.sh/agents (no Node or npm needed), then follow the installer's activation instruction.",
    });
    expect(await readState()).toBe(before);
  });

  it('refuses a release that carries no Node pin, before any child or Node', async () => {
    await writeState('0.1.0-alpha.6');
    const before = await readState();
    const { ctx } = makeCtx();
    ctx.dataDir = dataDir;
    const err = await caught(async () =>
      runUpdate(
        { check: false },
        ctx,
        await deps({
          homeDir: home,
          spawnImpl: forbiddenSpawn,
          stage: seams(null).stage,
          ensure: forbiddenEnsure,
        }),
      ),
    );
    expect(err.code).toBe('UPDATE_FAILED');
    expect(err.message).toBe(
      'tenjin-cli 0.1.0-alpha.7 carries no Node pin, so 0.1.0-alpha.6 stays',
    );
    expect(err.fix).toBeDefined();
    expect(existsSync(join(root, 'tmp', 'stage-0.1.0-alpha.7-fixture'))).toBe(false);
    expect(await readState()).toBe(before);
  });

  /**
   * The child's exit code is not the verdict: a new build whose own checks
   * failed keeps the previous version and can still exit 0. Either way the
   * state did not move, so the update failed and says what stays.
   */
  it('fails naming what stays when the new build did not switch the runtime', async () => {
    for (const [said, reason] of [
      [
        { result: { kind: 'exit', code: 3 }, output: refusal('the hooks did not answer') },
        'the hooks did not answer',
      ],
      [
        {
          output: envelope({
            refresh: true,
            runtime: { state: 'kept', reason: 'the router did not answer initialize' },
          }),
        },
        'the router did not answer initialize',
      ],
    ] as [{ result?: SpawnResult; output?: string }, string][]) {
      await writeState('0.1.0-alpha.6');
      const before = await readState();
      const { ctx } = makeCtx();
      ctx.dataDir = dataDir;
      const s = seams();
      const err = await caught(async () =>
        runUpdate(
          { check: false },
          ctx,
          await deps({
            homeDir: home,
            spawnImpl: children(async () => said).impl,
            stage: s.stage,
            ensure: s.ensure,
          }),
        ),
      );
      expect(err.code).toBe('UPDATE_FAILED');
      expect(err.message).toBe(
        'tenjin-cli 0.1.0-alpha.7 did not pass its checks, so 0.1.0-alpha.6 stays',
      );
      expect(err.fix).toBe('Run `tenjin update` again; if it fails again, run `tenjin doctor`');
      expect(err.details).toMatchObject({ reason });
      expect(await readState()).toBe(before);
    }
  });

  it('answers --check and up to date against the runtime, not this copy', async () => {
    await writeState('0.1.0-alpha.6');
    const { ctx } = makeCtx();
    ctx.dataDir = dataDir;
    const check = await runUpdate(
      { check: true },
      ctx,
      await deps({
        currentVersion: '0.1.0-alpha.4',
        homeDir: home,
        stage: forbiddenStage,
        ensure: forbiddenEnsure,
      }),
    );
    expect(check.data).toMatchObject({ current: '0.1.0-alpha.6', updateAvailable: true });
    expect(check.humanLines?.[0]).toBe(
      'tenjin-cli 0.1.0-alpha.7 is available (you have 0.1.0-alpha.6).',
    );

    // This copy is older than npm's latest, but the runtime already runs it.
    const current = await runUpdate(
      { check: false },
      ctx,
      await deps({
        currentVersion: '0.1.0-alpha.4',
        fetchImpl: registry({ latest: '0.1.0-alpha.6' }).fetchImpl,
        homeDir: home,
        stage: forbiddenStage,
        ensure: forbiddenEnsure,
      }),
    );
    expect(current.humanLines).toEqual(['tenjin-cli 0.1.0-alpha.6 is up to date']);
  });

  it('takes the npm branch under a non-default data dir, whatever the default holds', async () => {
    await writeState('0.1.0-alpha.6');
    const shelf = join(home, 'shelf');
    await mkdir(shelf, { recursive: true });
    const { ctx } = makeCtx();
    ctx.dataDir = shelf;
    const spawned = spawnRecorder();
    await runUpdate(
      { check: false },
      ctx,
      await deps({
        homeDir: home,
        spawnImpl: spawned.impl,
        stage: forbiddenStage,
        ensure: forbiddenEnsure,
      }),
    );
    expect(spawned.calls[0]?.args).toContain('tenjin-cli@0.1.0-alpha.7');
    expect(spawned.calls[1]).toMatchObject({
      cmd: process.execPath,
      args: [join(dir, 'bin', 'tenjin.js'), 'install', '--refresh'],
    });
  });

  it('refuses a runtime build under a non-default data dir as that, not as a project-local copy', async () => {
    await writeState('0.1.0-alpha.6');
    const build = join(root, 'versions', '0.1.0-alpha.6', 'dist');
    await mkdir(build, { recursive: true });
    const shelf = join(home, 'shelf');
    await mkdir(shelf, { recursive: true });
    const { ctx } = makeCtx();
    ctx.dataDir = shelf;
    const spawned = spawnRecorder();
    const err = await runUpdate(
      { check: false },
      ctx,
      await deps({
        moduleDir: build,
        currentVersion: '0.1.0-alpha.6',
        homeDir: home,
        spawnImpl: spawned.impl,
        stage: forbiddenStage,
        ensure: forbiddenEnsure,
      }),
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: 'REFUSED',
      message:
        "This tenjin runs from Tenjin's runtime, which only the default data dir (~/.tenjin) uses, and TENJIN_DATA_DIR is ~/shelf, so nothing was updated",
    });
    expect((err as CliError).fix).toMatch(/^Run `tenjin update` with TENJIN_DATA_DIR unset/);
    expect((err as CliError).message).not.toContain('project-local');
    expect(spawned.calls).toEqual([]);
  });

  /**
   * `tenjin uninstall --harness claude` with Codex kept leaves the runtime and
   * its launcher and no Claude Code install. The child is the real
   * `install --refresh`, run in-process on that machine, with only the
   * runtime step injected: it switches the runtime, as the new build's would.
   */
  it('updates a runtime Codex kept after Claude Code’s install was removed', async () => {
    await writeState('0.1.0-alpha.6');
    const { ctx } = makeCtx();
    ctx.dataDir = dataDir;
    const s = seams();
    const cfg = join(dir, 'claude-config');
    const child: UpdateSpawn = async (_cmd, _args, o, onOutput) => {
      const sink = { write: () => true } as unknown as NodeJS.WritableStream;
      const childCtx: CommandContext = {
        flags: { json: true, timeout: 5000 },
        dataDir: o.env?.TENJIN_DATA_DIR ?? '',
        io: { stdout: sink, stderr: sink, isTTY: false },
      };
      try {
        const out = await runRouterInstall({ refresh: true }, childCtx, {
          homeDir: home,
          cwd: home,
          env: { CLAUDE_CONFIG_DIR: cfg },
          findClaude: () => null,
          listMcpProcesses: async () => [],
          runtime: async () => {
            await writeState('0.1.0-alpha.7', '0.1.0-alpha.6');
            return {
              state: 'active',
              root,
              cli: '0.1.0-alpha.7',
              nodeVersion: PIN.version,
              node: nodeBinPath(root, PIN.version),
              entry: versionEntry(root, '0.1.0-alpha.7'),
              hostsDir: join(root, 'claude'),
              firstTime: false,
              launcher: null,
            };
          },
        });
        onOutput(`${JSON.stringify(buildSuccessEnvelope('install', out.data), null, 2)}\n`);
        return { kind: 'exit', code: 0 };
      } catch (err) {
        onOutput(`${JSON.stringify(buildFailureEnvelope('install', err as CliError), null, 2)}\n`);
        return { kind: 'exit', code: (err as CliError).exitCode };
      }
    };
    const result = await runUpdate(
      { check: false },
      ctx,
      await deps({ homeDir: home, spawnImpl: child, stage: s.stage, ensure: s.ensure }),
    );
    expect(result.data).toMatchObject({
      current: '0.1.0-alpha.6',
      latest: '0.1.0-alpha.7',
      updated: true,
    });
    expect(result.humanLines?.[0]).toBe('Updated tenjin-cli 0.1.0-alpha.6 -> 0.1.0-alpha.7.');
    // Nothing for Claude Code was created.
    expect(existsSync(join(cfg, 'skills', 'tenjin-router'))).toBe(false);
  });

  /**
   * The home child records Claude Code's project installs an older release
   * never did, so the list is read after it; each project runs the same new
   * build, from exactly its own folder.
   */
  it('refreshes a project the home child recorded, with the same launch', async () => {
    await writeState('0.1.0-alpha.6');
    const project = join(dir, 'app');
    await mkdir(join(project, '.claude'), { recursive: true });
    await writeFile(
      join(project, '.claude', 'settings.local.json'),
      JSON.stringify({ enabledPlugins: { [PLUGIN_ID]: true } }),
    );
    const { ctx } = makeCtx();
    ctx.dataDir = dataDir;
    const s = seams();
    const spawned = children(async (i) => {
      if (i > 0) return { output: envelope({ refresh: true, scope: 'local' }) };
      await writeFile(
        join(dataDir, 'config.json'),
        JSON.stringify({ install: { routerProjects: [project] } }),
      );
      await writeState('0.1.0-alpha.7', '0.1.0-alpha.6');
      return { output: envelope({ refresh: true, scope: 'user' }) };
    });
    const result = await runUpdate(
      { check: false },
      ctx,
      await deps({ homeDir: home, spawnImpl: spawned.impl, stage: s.stage, ensure: s.ensure }),
    );
    expect(spawned.calls[1]).toEqual({
      cmd: nodeBinPath(root, PIN.version),
      args: [versionEntry(root, '0.1.0-alpha.7'), 'install', '--refresh', '--project'],
      cwd: project,
      env: { TENJIN_DATA_DIR: dataDir, TENJIN_NO_UPDATE_CHECK: '1' },
    });
    expect(result.humanLines).toContain(`Refreshed the project install in ${project}.`);
  });

  describe('--background, as lib/auto-update starts it', () => {
    const record = async () =>
      JSON.parse(await readFile(join(root, 'auto-update.json'), 'utf8')) as Record<string, unknown>;
    const STARTED = '2026-10-01T00:00:00.000Z';
    const started = () =>
      writeFile(join(root, 'auto-update.json'), JSON.stringify({ startedAt: STARTED }));
    const NOW = Date.parse('2026-10-02T00:00:00.000Z');
    const HOUR = 3_600_000;
    const PACKUMENT = 'https://registry.npmjs.org/tenjin-cli';
    /**
     * npm as the background run reads it: the dist-tags, and the packument's
     * `time`, which names when each version was published.
     */
    function npm(published: string) {
      const urls: string[] = [];
      const fetchImpl: typeof fetch = async (input) => {
        const url = String(input);
        urls.push(url);
        const tags = { latest: '0.1.0-alpha.7' };
        return url === PACKUMENT
          ? Response.json({
              'dist-tags': tags,
              time: { '0.1.0-alpha.7': published },
            })
          : Response.json(tags);
      };
      return { fetchImpl, urls };
    }
    const dayOld = new Date(NOW - 25 * HOUR).toISOString();

    it('with no runtime, never reaches npm and records skipped', async () => {
      await started();
      const { ctx } = makeCtx();
      ctx.dataDir = dataDir;
      const result = await runUpdate(
        { check: false, background: true },
        ctx,
        await deps({
          homeDir: home,
          spawnImpl: forbiddenSpawn,
          stage: forbiddenStage,
          ensure: forbiddenEnsure,
        }),
      );
      expect(result.data).toEqual({ skipped: 'no runtime' });
      expect(await record()).toMatchObject({
        startedAt: STARTED,
        outcome: 'skipped',
        reason: 'no runtime',
      });
    });

    it('records updated after the runtime branch switched, keeping when it started', async () => {
      await writeState('0.1.0-alpha.6');
      await writeFile(
        join(root, 'auto-update.json'),
        JSON.stringify({ startedAt: STARTED, outcome: 'failed', reason: 'yesterday' }),
      );
      const { ctx } = makeCtx();
      ctx.dataDir = dataDir;
      const s = seams();
      const spawned = children(() => writeState('0.1.0-alpha.7', '0.1.0-alpha.6'));
      await runUpdate(
        { check: false, background: true },
        ctx,
        await deps({
          homeDir: home,
          spawnImpl: spawned.impl,
          stage: s.stage,
          ensure: s.ensure,
          fetchImpl: npm(dayOld).fetchImpl,
          now: () => NOW,
        }),
      );
      // The same child the foreground update runs: the new build checks itself.
      expect(spawned.calls.map((c) => c.args.slice(1))).toEqual([['install', '--refresh']]);
      const r = await record();
      expect(r).toMatchObject({
        startedAt: STARTED,
        outcome: 'updated',
        from: '0.1.0-alpha.6',
        to: '0.1.0-alpha.7',
      });
      expect(r.reason).toBeUndefined();
      expect(typeof r.finishedAt).toBe('string');
    });

    it('records current when up to date, and never moves to an older version', async () => {
      for (const running of ['0.1.0-alpha.7', '0.1.0-alpha.8']) {
        await writeState(running);
        const before = await readState();
        const { ctx } = makeCtx();
        ctx.dataDir = dataDir;
        await runUpdate(
          { check: false, background: true },
          ctx,
          await deps({
            homeDir: home,
            spawnImpl: forbiddenSpawn,
            stage: forbiddenStage,
            ensure: forbiddenEnsure,
          }),
        );
        expect(await record()).toMatchObject({ outcome: 'current', to: running });
        expect(await readState()).toBe(before);
      }
    });

    it('records failed with the reason, rethrows, and keeps the current version', async () => {
      await writeState('0.1.0-alpha.6');
      const before = await readState();
      const { ctx } = makeCtx();
      ctx.dataDir = dataDir;
      const err = await caught(async () =>
        runUpdate(
          { check: false, background: true },
          ctx,
          await deps({
            homeDir: home,
            spawnImpl: forbiddenSpawn,
            stage: seams(null).stage,
            ensure: forbiddenEnsure,
            fetchImpl: npm(dayOld).fetchImpl,
            now: () => NOW,
          }),
        ),
      );
      expect(err.code).toBe('UPDATE_FAILED');
      expect(await record()).toMatchObject({
        outcome: 'failed',
        from: '0.1.0-alpha.6',
        reason: 'tenjin-cli 0.1.0-alpha.7 carries no Node pin, so 0.1.0-alpha.6 stays',
      });
      expect(await readState()).toBe(before);
    });

    it('waits a day after a release is published, switching nothing until then', async () => {
      await writeState('0.1.0-alpha.6');
      await started();
      const before = await readState();
      const { ctx } = makeCtx();
      ctx.dataDir = dataDir;
      const reason = 'tenjin-cli 0.1.0-alpha.7 was published under 24 hours ago';
      const result = await runUpdate(
        { check: false, background: true },
        ctx,
        await deps({
          homeDir: home,
          spawnImpl: forbiddenSpawn,
          stage: forbiddenStage,
          ensure: forbiddenEnsure,
          fetchImpl: npm(new Date(NOW - 24 * HOUR + 1).toISOString()).fetchImpl,
          now: () => NOW,
        }),
      );
      expect(result.data).toMatchObject({
        current: '0.1.0-alpha.6',
        latest: '0.1.0-alpha.7',
        updated: false,
        skipped: reason,
      });
      expect(await record()).toMatchObject({ startedAt: STARTED, outcome: 'skipped', reason });
      expect(await readState()).toBe(before);
    });

    it('takes a release published exactly a day ago', async () => {
      await writeState('0.1.0-alpha.6');
      const { ctx } = makeCtx();
      ctx.dataDir = dataDir;
      const s = seams();
      await runUpdate(
        { check: false, background: true },
        ctx,
        await deps({
          homeDir: home,
          spawnImpl: children(() => writeState('0.1.0-alpha.7', '0.1.0-alpha.6')).impl,
          stage: s.stage,
          ensure: s.ensure,
          fetchImpl: npm(new Date(NOW - 24 * HOUR).toISOString()).fetchImpl,
          now: () => NOW,
        }),
      );
      expect(s.staged.map((x) => x.version)).toEqual(['0.1.0-alpha.7']);
      expect(await record()).toMatchObject({ outcome: 'updated', to: '0.1.0-alpha.7' });
    });

    it('waits only in the background: a manual update takes a release published an hour ago', async () => {
      await writeState('0.1.0-alpha.6');
      const { ctx } = makeCtx();
      ctx.dataDir = dataDir;
      const s = seams();
      const registryRead = npm(new Date(NOW - HOUR).toISOString());
      const result = await runUpdate(
        { check: false },
        ctx,
        await deps({
          homeDir: home,
          spawnImpl: children(() => writeState('0.1.0-alpha.7', '0.1.0-alpha.6')).impl,
          stage: s.stage,
          ensure: s.ensure,
          fetchImpl: registryRead.fetchImpl,
          now: () => NOW,
        }),
      );
      expect(result.data).toMatchObject({ latest: '0.1.0-alpha.7', updated: true });
      expect(s.staged.map((x) => x.version)).toEqual(['0.1.0-alpha.7']);
      expect(registryRead.urls).not.toContain(PACKUMENT);
    });
  });
});
