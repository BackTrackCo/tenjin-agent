import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runUpdate, type UpdateDeps, type UpdateSpawn } from './update';
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

/** Records every spawn; optionally emits output and picks the exit code. */
function spawnRecorder(opts: { code?: number; output?: string; startError?: Error } = {}) {
  const calls: { cmd: string; args: string[] }[] = [];
  const impl: UpdateSpawn = async (cmd, args, onOutput) => {
    calls.push({ cmd, args });
    if (opts.startError !== undefined) throw opts.startError;
    if (opts.output !== undefined) onOutput(opts.output);
    return opts.code ?? 0;
  };
  return { impl, calls };
}

const forbiddenSpawn: UpdateSpawn = async () => {
  throw new Error('this path must not spawn anything');
};

/** An installed-package tree: package.json with dist/ beside it and no src/. */
async function installedTree(...prefix: string[]): Promise<string> {
  const root = join(dir, ...prefix, 'node_modules', 'tenjin-cli');
  await mkdir(join(root, 'dist'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{"name":"tenjin-cli"}');
  return join(root, 'dist');
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
    fetchImpl: registry({ latest: '0.9.0', alpha: '0.1.0-alpha.7' }).fetchImpl,
    spawnImpl: forbiddenSpawn,
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
  it('installs the exact alpha version npm just named, never the tag', async () => {
    const { ctx } = makeCtx();
    const spawned = spawnRecorder();
    const result = await runUpdate({ check: false }, ctx, await deps({ spawnImpl: spawned.impl }));
    expect(spawned.calls).toEqual([
      { cmd: 'npm', args: ['install', '-g', 'tenjin-cli@0.1.0-alpha.7'] },
    ]);
    expect(result.data).toEqual({
      current: '0.1.0-alpha.6',
      latest: '0.1.0-alpha.7',
      channel: 'alpha',
      updateAvailable: true,
      updated: true,
    });
    expect(result.humanLines?.join(' ')).toContain('0.1.0-alpha.6 -> 0.1.0-alpha.7');
  });

  it('follows the stable channel from a release build', async () => {
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
    expect(spawned.calls[0]?.args).toEqual(['install', '-g', 'tenjin-cli@1.1.0']);
    expect(result.data).toMatchObject({ channel: 'latest', updated: true });
  });

  it('reports up to date without spawning, on either surface', async () => {
    const { ctx } = makeCtx();
    const result = await runUpdate(
      { check: false },
      ctx,
      await deps({ fetchImpl: registry({ alpha: '0.1.0-alpha.6' }).fetchImpl }),
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
      channel: 'alpha',
      updateAvailable: true,
      updated: false,
    });
    expect(result.humanLines?.join(' ')).toContain('Run tenjin update');
  });

  it('refuses a source checkout before touching the network', async () => {
    const { ctx } = makeCtx();
    const err = await caught(async () =>
      runUpdate(
        { check: false },
        ctx,
        await deps({ moduleDir: await checkoutTree(), fetchImpl: forbiddenFetch }),
      ),
    );
    expect(err.code).toBe('REFUSED');
    expect(err.exitCode).toBe(3);
    expect(err.fix).toContain('git pull');
  });

  it('refuses a pnpm-store install and pins the pnpm command in the fix', async () => {
    const { ctx } = makeCtx();
    const err = await caught(async () =>
      runUpdate({ check: false }, ctx, await deps({ moduleDir: await installedTree('.pnpm') })),
    );
    expect(err.code).toBe('REFUSED');
    expect(err.fix).toBe('pnpm add -g tenjin-cli@0.1.0-alpha.7');
  });

  it('a pnpm-store install that is already current is simply up to date', async () => {
    const { ctx } = makeCtx();
    const result = await runUpdate(
      { check: false },
      ctx,
      await deps({
        moduleDir: await installedTree('.pnpm'),
        fetchImpl: registry({ alpha: '0.1.0-alpha.6' }).fetchImpl,
      }),
    );
    expect(result.data).toMatchObject({ updateAvailable: false });
  });

  it('surfaces an unreachable registry as NETWORK_ERROR', async () => {
    const { ctx } = makeCtx();
    const failures: (typeof fetch)[] = [
      async () => {
        throw new Error('ENOTFOUND registry.npmjs.org');
      },
      async () => new Response('', { status: 503 }),
      async () => new Response(JSON.stringify({ latest: '1.0.0' }), { status: 200 }), // no alpha
    ];
    for (const fetchImpl of failures) {
      const err = await caught(async () =>
        runUpdate({ check: false }, ctx, await deps({ fetchImpl })),
      );
      expect(err.code).toBe('NETWORK_ERROR');
    }
  });

  it('turns a nonzero npm exit into UPDATE_FAILED carrying the output tail', async () => {
    const { ctx, stderr } = makeCtx();
    const spawned = spawnRecorder({ code: 243, output: 'npm ERR! EACCES /usr/lib/node_modules' });
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
    const spawned = spawnRecorder({ startError: new Error('spawn npm ENOENT') });
    const err = await caught(async () =>
      runUpdate({ check: false }, ctx, await deps({ spawnImpl: spawned.impl })),
    );
    expect(err.code).toBe('UPDATE_FAILED');
    expect(err.message).toBe('Could not start npm');
    expect(err.fix).toContain('npm i -g');
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

  it('announces the completed write on stderr on every surface', async () => {
    // emitWriteNotice contract: a write to the operator's own files is announced
    // even to a piped or --json run, and stdout stays untouched.
    const piped = makeCtx({ json: true }, false);
    await runUpdate({ check: false }, piped.ctx, await deps({ spawnImpl: spawnRecorder().impl }));
    expect(piped.stderr()).toContain('replaced the global tenjin-cli with 0.1.0-alpha.7');
    expect(piped.stdout()).toBe('');
  });
});
