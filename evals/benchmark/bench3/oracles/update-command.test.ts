import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { spawn } from 'node:child_process';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'prior-update-'));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
async function modules() {
  expect(
    existsSync(join(process.cwd(), 'src/commands/update.ts')),
    'explicit update command exists',
  ).toBe(true);
  return {
    command: await import('./commands/update'),
    check: await import('./lib/update-check'),
  };
}
function context(json = true, isTTY = false) {
  const out: string[] = [],
    err: string[] = [];
  const sink = (items: string[]) =>
    new Writable({
      write(chunk, _enc, done) {
        items.push(String(chunk));
        done();
      },
    });
  return {
    out,
    err,
    flags: { json, timeout: 1200 },
    dataDir: root,
    io: { stdout: sink(out), stderr: sink(err), isTTY },
  };
}
const registry = (tags: unknown = { latest: '4.2.0', alpha: '4.3.0-alpha.9' }) =>
  (async () => new Response(JSON.stringify(tags))) as typeof fetch;
async function layout(kind: string) {
  const prefix = join(
    root,
    kind === 'pnpm'
      ? '.pnpm/global'
      : kind === 'bun'
        ? '.bun/install/global'
        : kind === 'yarn'
          ? '.yarn/global'
          : kind === 'npx'
            ? '_npx/opaque'
            : kind,
  );
  const pkg = join(prefix, 'node_modules/tenjin-cli');
  await mkdir(join(pkg, 'dist'), { recursive: true });
  await writeFile(join(pkg, 'package.json'), '{}');
  if (['local', 'pnpm', 'bun'].includes(kind)) await writeFile(join(prefix, 'package.json'), '{}');
  if (kind === 'checkout') await mkdir(join(pkg, 'src'));
  return join(pkg, 'dist');
}
it('shares historical maximum-of-tags policy, validates versions and compares numeric prereleases', async () => {
  const { check } = await modules();
  expect(check.resolveTarget('4.1.0-alpha.2', { latest: '4.2.0', alpha: '4.3.0-alpha.9' })).toBe(
    '4.3.0-alpha.9',
  );
  expect(check.resolveTarget('4.1.0-alpha.2', { latest: '4.4.0', alpha: '4.3.0-alpha.9' })).toBe(
    '4.4.0',
  );
  expect(check.resolveTarget('4.1.0', { latest: '4.2.0', alpha: '9.0.0-alpha.1' })).toBe('4.2.0');
  expect(check.isNewer('4.2.0-alpha.12', '4.2.0-alpha.9')).toBe(true);
  expect(check.isNewer('4.2.0', '4.2.0-alpha.99')).toBe(true);
  for (const bad of ['development', '4.2.0;touch owned', '4.2.0\u001b[2J'])
    expect(check.channelTag(bad)).toBeNull();
});
it.each(['npm', 'pnpm', 'bun'])(
  'delegates %s to its owner with exact argv, bounded execution and no stdout chatter',
  async (kind) => {
    const { command } = await modules();
    const ctx = context();
    const calls: unknown[] = [];
    const result = await command.runUpdate({ check: false }, ctx, {
      moduleDir: await layout(kind),
      currentVersion: '4.1.0',
      fetchImpl: registry(),
      managerScript: null,
      spawnImpl: async (cmd, args, opts, output) => {
        calls.push({ cmd, args, opts });
        output('untrusted manager chatter');
        return { kind: 'exit', code: 0 };
      },
    });
    expect(calls).toEqual([
      {
        cmd: kind,
        args:
          kind === 'npm'
            ? ['install', '-g', '--ignore-scripts', 'tenjin-cli@4.2.0']
            : ['add', '-g', ...(kind === 'pnpm' ? ['--ignore-scripts'] : []), 'tenjin-cli@4.2.0'],
        opts: { cwd: homedir(), timeoutMs: 300000 },
      },
    ]);
    expect(result.data).toMatchObject({ updated: true, latest: '4.2.0', updateAvailable: true });
    expect(ctx.out).toEqual([]);
    expect(ctx.err.join('')).not.toContain('untrusted');
    expect(ctx.err.join('')).toMatch(/4\.2\.0/);
  },
);
it('runs a resolved manager JavaScript shim under the current Node executable', async () => {
  const { command } = await modules();
  const seen: unknown[] = [];
  await command.runUpdate({ check: false }, context(), {
    moduleDir: await layout('npm'),
    currentVersion: '4.1.0',
    fetchImpl: registry(),
    managerScript: join(root, 'npm-cli.js'),
    spawnImpl: async (cmd, args) => {
      seen.push(cmd, args);
      return { kind: 'exit', code: 0 };
    },
  });
  expect(seen).toEqual([
    process.execPath,
    [join(root, 'npm-cli.js'), 'install', '-g', '--ignore-scripts', 'tenjin-cli@4.2.0'],
  ]);
});
it.each(['checkout', 'local', 'npx', 'yarn'])(
  'checks %s without installing and refuses its replacement',
  async (kind) => {
    const { command } = await modules();
    let fetches = 0,
      spawns = 0;
    const deps = {
      moduleDir: await layout(kind),
      currentVersion: '4.1.0',
      fetchImpl: (async () => {
        fetches++;
        return registry()('https://registry.invalid');
      }) as typeof fetch,
      spawnImpl: async () => {
        spawns++;
        return { kind: 'exit' as const, code: 0 };
      },
    };
    expect((await command.runUpdate({ check: true }, context(), deps)).data).toMatchObject({
      updated: false,
      updateAvailable: true,
    });
    fetches = 0;
    await expect(command.runUpdate({ check: false }, context(), deps)).rejects.toMatchObject({
      code: 'REFUSED',
    });
    expect(spawns).toBe(0);
    expect(fetches).toBe(kind === 'checkout' ? 0 : 1);
  },
);
it('refuses an unknown current version before fetching and reports already-current without installation', async () => {
  const { command } = await modules();
  let calls = 0;
  const deps = {
    moduleDir: await layout('yarn'),
    fetchImpl: (async () => {
      calls++;
      return registry()('https://registry.invalid');
    }) as typeof fetch,
    spawnImpl: async () => {
      throw new Error('No install');
    },
  };
  await expect(
    command.runUpdate({ check: false }, context(), { ...deps, currentVersion: 'foreign' }),
  ).rejects.toMatchObject({ code: 'REFUSED' });
  expect(calls).toBe(0);
  expect(
    (await command.runUpdate({ check: false }, context(), { ...deps, currentVersion: '4.2.0' }))
      .data,
  ).toMatchObject({ updated: false, updateAvailable: false });
});
it.each(['reject', 'status', 'json', 'shape', 'empty'])(
  'keeps registry %s errors distinct from absent releases',
  async (mode) => {
    const { command } = await modules();
    const fetchImpl = (async () => {
      if (mode === 'reject') throw new Error('offline');
      if (mode === 'status') return new Response('', { status: 503 });
      if (mode === 'json') return new Response('{');
      return registry()('https://registry.invalid').then(
        () => new Response(JSON.stringify(mode === 'shape' ? { latest: 42 } : {})),
      );
    }) as typeof fetch;
    await expect(
      command.runUpdate({ check: true }, context(), {
        currentVersion: '4.1.0',
        moduleDir: await layout('npm'),
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: mode === 'empty' ? 'RESOURCE_NOT_FOUND' : 'NETWORK_ERROR' });
  },
);
it.each(['exit', 'timeout', 'start-failed'] as const)(
  'reports manager %s failure with bounded evidence and a manual command',
  async (kind) => {
    const { command } = await modules();
    const ctx = context(false, true);
    const result = command.runUpdate({ check: false }, ctx, {
      moduleDir: await layout('npm'),
      currentVersion: '4.1.0',
      fetchImpl: registry(),
      managerScript: null,
      spawnImpl: async (_cmd, _args, _opts, output) => {
        output('x'.repeat(3000) + '\u001b[2Jtail');
        return kind === 'exit'
          ? { kind, code: 7 }
          : kind === 'timeout'
            ? { kind }
            : { kind, cause: new Error('absent executable') };
      },
    });
    await expect(result).rejects.toMatchObject({
      code: 'UPDATE_FAILED',
      fix: expect.stringContaining('npm'),
    });
    if (kind !== 'start-failed') {
      const error = await result.catch((value) => value);
      expect(error.details.output).toEqual(expect.any(String));
      expect(error.details.output.length).toBeLessThanOrEqual(2000);
      expect(error.details.output).toContain('tail');
    }
    expect(ctx.out).toEqual([]);
    expect(ctx.err.join('')).not.toContain('\u001b');
  },
);
it('captures child output, exit and timeout without a shell or package installation', async () => {
  const { command } = await modules();
  const output: string[] = [];
  expect(
    await command.spawnCapture(
      process.execPath,
      [
        '-e',
        "process.stdout.write(process.cwd());process.stderr.write('diagnostic');process.exit(7)",
      ],
      { cwd: root, timeoutMs: 3000 },
      (x) => output.push(x),
    ),
  ).toEqual({ kind: 'exit', code: 7 });
  expect(output.join('')).toContain(root);
  expect(output.join('')).toContain('diagnostic');
  expect(
    await command.spawnCapture(
      process.execPath,
      ['-e', 'setInterval(()=>{},1000)'],
      { cwd: root, timeoutMs: 50 },
      () => {},
    ),
  ).toEqual({ kind: 'timeout' });
});
it('piped and JSON checks cache a signal without consuming the human notification clock', async () => {
  const { check } = await modules();
  const ctx = context();
  let fetches = 0;
  const deps = {
    dir: root,
    io: ctx.io,
    json: true,
    env: {},
    now: () => 100000000,
    currentVersion: '4.1.0-alpha.1',
    fetchImpl: (async () => {
      fetches++;
      return registry()('https://registry.invalid');
    }) as typeof fetch,
  };
  await check.maybeUpdate(deps);
  expect(fetches).toBe(1);
  expect(ctx.out).toEqual([]);
  expect(ctx.err).toEqual([]);
  expect(await check.readUpdateSignal(root, '4.1.0-alpha.1')).toEqual({
    current: '4.1.0-alpha.1',
    latest: '4.3.0-alpha.9',
  });
  const human = context(false, true);
  await check.maybeUpdate({ ...deps, json: false, io: human.io });
  expect(fetches).toBe(1);
  expect(human.err.join('')).toMatch(/tenjin update/);
  human.err.length = 0;
  await check.maybeUpdate({ ...deps, json: false, io: human.io });
  expect(human.err).toEqual([]);
  expect(await check.readUpdateSignal(root, '4.3.0-alpha.9')).toBeNull();
});
it('off mode and CI suppress checks; network failure stays silent and is retried', async () => {
  const { check } = await modules();
  const ctx = context();
  let calls = 0;
  const deps = {
    dir: root,
    io: ctx.io,
    json: true,
    currentVersion: '4.1.0',
    fetchImpl: (async () => {
      calls++;
      throw new Error('offline');
    }) as typeof fetch,
  };
  await check.maybeUpdate({ ...deps, env: { CI: 'false' } });
  await check.maybeUpdate({ ...deps, env: {}, mode: 'off' });
  expect(calls).toBe(0);
  await check.maybeUpdate({ ...deps, env: {} });
  await check.maybeUpdate({ ...deps, env: {} });
  expect(calls).toBe(2);
  expect(ctx.out).toEqual([]);
  expect(ctx.err).toEqual([]);
});
it('update.mode persists only nudge/off and hides cached signals when disabled', async () => {
  await modules();
  const config = await import('./lib/config');
  const commands = await import('./commands/config');
  const ctx = context();
  expect((await config.loadConfig(root)).update.mode).toBe('nudge');
  await commands.runConfigSet({ key: 'update.mode', value: 'off' }, ctx);
  expect((await config.loadConfig(root)).update.mode).toBe('off');
  await expect(
    commands.runConfigSet({ key: 'update.mode', value: 'automatic' }, ctx),
  ).rejects.toThrow();
  await commands.runConfigSet({ key: 'update.mode', value: 'nudge' }, ctx);
  expect((await config.loadConfig(root)).update.mode).toBe('nudge');
  expect(JSON.parse(await readFile(join(root, 'config.json'), 'utf8')).update.mode).toBe('nudge');
});

async function signalFixture() {
  const current = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8'))
    .version as string;
  await writeFile(
    join(root, 'update-check.json'),
    JSON.stringify({
      schemaVersion: 1,
      tags: {
        latest: { latest: '999.1.0', checkedAtMs: Date.now() },
        alpha: { latest: '999.1.0', checkedAtMs: Date.now() },
      },
      signal: { current, latest: '999.1.0' },
    }),
  );
  return current;
}
it('actual CLI registration and ordinary success/failure envelopes carry the cached update signal', async () => {
  await modules();
  vi.stubEnv('TENJIN_DATA_DIR', root);
  vi.stubEnv('HOME', root);
  vi.stubEnv('CI', '1');
  const current = await signalFixture();
  await writeFile(join(root, 'config.json'), JSON.stringify({ update: { mode: 'nudge' } }));
  const { main } = await import('./cli');
  for (const args of [
    ['config', 'get', 'baseUrl', '--json'],
    ['config', 'get', 'not-a-config-key', '--json'],
  ]) {
    const ctx = context();
    const code = await main(args, ctx.io);
    const envelope = JSON.parse(ctx.out.join(''));
    expect(envelope.updateAvailable).toEqual({ current, latest: '999.1.0' });
    expect(code === 0).toBe(args[2] === 'baseUrl');
  }
  vi.stubGlobal('fetch', registry({ latest: '999.1.0', alpha: '999.1.0' }));
  const ctx = context();
  expect(await main(['update', '--check', '--json'], ctx.io)).toBe(0);
  const envelope = JSON.parse(ctx.out.join(''));
  expect(envelope).not.toHaveProperty('updateAvailable');
  expect(JSON.stringify(envelope)).toContain('999.1.0');
});
it('generated WebSearch reminders honor nudge, off and quiet modes without network', async () => {
  await modules();
  await signalFixture();
  const { websearchHookScript } = await import('./lib/hook-scripts');
  const script = join(root, 'websearch.mjs');
  await writeFile(script, websearchHookScript(root));
  const invoke = () =>
    new Promise<string>((resolve, reject) => {
      let out = '';
      const child = spawn(process.execPath, [script], {
        env: { PATH: process.env.PATH ?? '', HOME: root },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.stdout.on('data', (chunk) => {
        out += String(chunk);
      });
      child.on('error', reject);
      child.on('exit', (code) =>
        code === 0 ? resolve(out) : reject(new Error('Hook failed: ' + code)),
      );
      child.stdin.end(
        JSON.stringify({
          session_id: 'fixture',
          hook_event_name: 'PreToolUse',
          tool_name: 'WebSearch',
          tool_input: { query: 'Independent optical calibration' },
        }),
      );
    });
  for (const mode of ['nudge', 'off']) {
    await writeFile(
      join(root, 'config.json'),
      JSON.stringify({ hooks: { searchMode: 'remind' }, update: { mode } }),
    );
    const output = await invoke();
    expect(output).toContain('tenjin');
    expect(output.includes('999.1.0')).toBe(mode === 'nudge');
  }
  await writeFile(
    join(root, 'config.json'),
    JSON.stringify({ hooks: { searchMode: 'off' }, update: { mode: 'nudge' } }),
  );
  expect(await invoke()).toBe('');
});
