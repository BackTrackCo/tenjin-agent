import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pkg from '../../package.json';
import { loadRawConfig } from '../lib/config';
import { CliError } from '../lib/errors';
import type { LauncherResult, RuntimeSetup } from '../lib/runtime';
import { nodeBinPath, readRuntimeState, versionDir, versionEntry } from '../lib/runtime-layout';
import type { CommandContext } from '../context';
import { fakeClaude, listed, type FakeClaude } from './claude-test-utils';
import { hookToolInput } from './hook-tool';
import { continuationCommand, runRouterInstall, runtimeOncePerRun } from './install';
import { renderLauncherSh, renderPluginFiles } from './plugin-files';

/**
 * INSTALL ON TENJIN'S RUNTIME, through a fake `claude` and an injected
 * `setupRuntime`: which folder the plugin is registered from for each runtime
 * outcome, which version it carries, what is put back when registration
 * fails, the lines a person sees, and the project installs Claude Code records
 * that install adds to `install.routerProjects`. The runtime itself is
 * `lib/runtime.test.ts`.
 */

let root: string;
let home: string;
let data: string;
let cfg: string;
let work: string;
let hosts: string;
let runtimeRoot: string;
let fake: FakeClaude;

const ADDRESS = '0x3c0D84055994c3062819Ce8730869D0aDeA4c3Bf';
const NODE_V = '24.15.0';
const probe400 = (async () =>
  new Response('{}', {
    status: 400,
    headers: { 'content-type': 'application/json' },
  })) as typeof fetch;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'runtime-install-')));
  home = join(root, 'home');
  data = join(home, '.tenjin');
  cfg = join(root, 'cfg');
  work = join(root, 'work');
  hosts = join(root, 'pkg', 'dist', 'hosts', 'claude');
  runtimeRoot = join(data, 'runtime');
  await mkdir(join(work, '.git'), { recursive: true });
  await mkdir(data, { recursive: true });
  fake = await fakeClaude(root);
  vi.stubGlobal('fetch', probe400);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});

function ctx(): CommandContext {
  const sink = () => ({ write: () => true }) as unknown as NodeJS.WritableStream;
  return {
    flags: { json: true, timeout: 5000 },
    dataDir: data,
    io: { stdout: sink(), stderr: sink(), isTTY: false },
  };
}

const launcherOk: LauncherResult = {
  paths: ['/h/.local/bin/tenjin'],
  state: 'written',
  onPath: true,
};

/** A `setupRuntime` result, `active` for this build on first activation unless `over` says otherwise. */
function setup(over: Partial<RuntimeSetup> = {}): RuntimeSetup {
  const cli = over.cli ?? pkg.version;
  return {
    state: 'active',
    root: runtimeRoot,
    cli,
    nodeVersion: NODE_V,
    node: join(runtimeRoot, 'node', NODE_V, 'bin', 'node'),
    entry: join(runtimeRoot, 'versions', cli, 'dist', 'index.js'),
    hostsDir: join(runtimeRoot, 'claude'),
    firstTime: true,
    launcher: launcherOk,
    restore: async () => undefined,
    ...over,
  };
}

function deps(
  runtime: ((o: unknown) => Promise<RuntimeSetup>) | undefined,
  over: Record<string, unknown> = {},
) {
  return {
    homeDir: home,
    cwd: work,
    env: { ...fake.env, CLAUDE_CONFIG_DIR: cfg },
    findClaude: () => ({ path: fake.bin, source: 'path' as const }),
    hostsDir: hosts,
    cliEntry: join(root, 'pkg', 'dist', 'index.js'),
    walletExists: async () => true,
    walletAddress: async () => ADDRESS,
    createWallet: vi.fn(async () => ADDRESS),
    walletSigning: async () => ({
      signing: { status: 'ready' as const, source: 'keychain' as const },
    }),
    listMcpProcesses: async () => [],
    ...(runtime !== undefined ? { runtime } : {}),
    ...over,
  };
}

const runtimeOf = (result: { data: unknown }) =>
  (result.data as { runtime: Record<string, unknown> | null }).runtime;
const pluginOf = (result: { data: unknown }) =>
  (result.data as { plugin: Record<string, unknown> }).plugin;
const runsLines = (lines: string[]) => lines.filter((l) => l.startsWith('  Runs from '));
/** Claude Code's `installed_plugins.json`, with these `tenjin@tenjin` entries. */
async function recordInstalls(entries: Record<string, unknown>[] | string): Promise<void> {
  await mkdir(join(cfg, 'plugins'), { recursive: true });
  await writeFile(
    join(cfg, 'plugins', 'installed_plugins.json'),
    typeof entries === 'string'
      ? entries
      : JSON.stringify({ version: 2, plugins: { 'tenjin@tenjin': entries } }),
  );
}

async function routerProjects(): Promise<string[]> {
  return (await loadRawConfig(data)).install?.routerProjects ?? [];
}

describe('install registers the plugin from Tenjin’s runtime', () => {
  it('active: adds the runtime’s folder, says where it runs from once, and passes this build to setupRuntime', async () => {
    const runtime = vi.fn(async () => setup());
    const result = await runRouterInstall({}, ctx(), deps(runtime));
    expect(await fake.calls()).toContain(
      `plugin marketplace add ${join(runtimeRoot, 'claude')} --json`,
    );
    expect(runtimeOf(result)).toEqual({
      state: 'active',
      root: runtimeRoot,
      cli: pkg.version,
      nodeVersion: NODE_V,
    });
    expect((result.data as { launcher: unknown }).launcher).toEqual(launcherOk);
    expect(pluginOf(result)).toMatchObject({
      path: join(runtimeRoot, 'claude'),
      version: pkg.version,
    });
    expect(runsLines(result.humanLines!)).toEqual([
      `  Runs from ~/.tenjin/runtime on its own Node ${NODE_V}, so a Node upgrade or \`npm rm -g tenjin-cli\` no longer stops it.`,
    ]);
    expect(runtime).toHaveBeenCalledWith(
      expect.objectContaining({ dataDir: data, home, version: pkg.version, refresh: false }),
    );
  });

  it.each([
    [{}, ['install', '--yes'], false],
    [{ yes: true }, ['wallet', 'fund', '5'], false],
    [{}, ['install', '--yes'], true],
  ] as const)(
    'executes a continuation with a minimal or shadowed PATH: %j %j %j',
    async (args, expected, onPath) => {
      const entry = join(root, "runner's folder", 'index.mjs');
      const receipt = join(root, 'continued.json');
      const launcher = join(home, '.local', 'bin', 'tenjin');
      await mkdir(dirname(entry), { recursive: true });
      await mkdir(dirname(launcher), { recursive: true });
      await writeFile(
        entry,
        `import { writeFileSync } from 'node:fs'; writeFileSync(process.env.CONTINUATION_RECEIPT, JSON.stringify(process.argv.slice(2)));`,
      );
      await writeFile(launcher, renderLauncherSh({ node: process.execPath, entry }), {
        mode: 0o755,
      });
      const runtime = async () =>
        setup({
          node: process.execPath,
          entry,
          launcher: { paths: [launcher], state: 'written', onPath },
        });
      const foreignBin = join(root, 'earlier-bin');
      await mkdir(foreignBin);
      await writeFile(join(foreignBin, 'tenjin'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
      const path = onPath ? `${foreignBin}:${dirname(launcher)}:/usr/bin:/bin` : '/usr/bin:/bin';
      const env = { ...fake.env, CLAUDE_CONFIG_DIR: cfg, CLAUDECODE: '1', PATH: path };
      const run = async (args: { yes?: boolean }) =>
        runRouterInstall(args, ctx(), deps(runtime, { env, walletBalance: async () => 0n }));
      const result = await run(args);
      const step = (result.data as { nextSteps: { options: { command: string | null }[] }[] })
        .nextSteps[0]!;
      const command = step.options[0]!.command!;
      execFileSync('sh', ['-c', command], {
        env: { PATH: path, CONTINUATION_RECEIPT: receipt },
      });
      expect(JSON.parse(await readFile(receipt, 'utf8'))).toEqual(expected);
    },
  );

  it('executes terminal funding and project-check instructions with a minimal PATH', async () => {
    const entry = join(root, 'terminal-entry.mjs');
    const receipt = join(root, 'continued.json');
    const launcher = join(home, '.local', 'bin', 'tenjin');
    await mkdir(dirname(launcher), { recursive: true });
    await writeFile(
      entry,
      `import { writeFileSync } from 'node:fs'; writeFileSync(process.env.CONTINUATION_RECEIPT, JSON.stringify(process.argv.slice(2)));`,
    );
    await writeFile(launcher, renderLauncherSh({ node: process.execPath, entry }), { mode: 0o755 });
    const runtime = async () =>
      setup({
        node: process.execPath,
        entry,
        launcher: { paths: [launcher], state: 'written', onPath: false },
      });
    const context = ctx();
    context.flags.json = false;
    context.io.isTTY = true;
    const result = await runRouterInstall(
      { yes: true, project: true },
      context,
      deps(runtime, { isInteractive: true, walletExists: async () => false }),
    );
    const funding = (result.data as { next: string }).next.match(
      /fund the wallet with `([^`]+)`/,
    )?.[1];
    const project = result
      .humanLines!.find((line) => line.startsWith('  For this project only; check it with: '))
      ?.split('check it with: ')[1];
    for (const [command, expected] of [
      [funding, ['wallet', 'fund']],
      [project, ['doctor', '--project']],
    ] as const) {
      expect(command).toBeDefined();
      execFileSync('sh', ['-c', command!], {
        env: { PATH: '/usr/bin:/bin', CONTINUATION_RECEIPT: receipt },
      });
      expect(JSON.parse(await readFile(receipt, 'utf8'))).toEqual(expected);
    }
  });

  it.each(['failed', 'foreign'] as const)(
    'uses verified Node and entry when the launcher is %s',
    async (state) => {
      const entry = join(root, "runner's folder", 'index.mjs');
      const receipt = join(root, 'continued.json');
      await mkdir(dirname(entry), { recursive: true });
      await writeFile(
        entry,
        `import { writeFileSync } from 'node:fs'; writeFileSync(process.env.CONTINUATION_RECEIPT, JSON.stringify(process.argv.slice(2)));`,
      );
      const runtime = async () =>
        setup({
          node: process.execPath,
          entry,
          launcher: { paths: ['/foreign/tenjin'], state, onPath: true },
        });
      const result = await runRouterInstall({}, ctx(), deps(runtime));
      const command = (result.data as { nextSteps: { options: { command: string }[] }[] })
        .nextSteps[0]!.options[0]!.command;
      execFileSync('sh', ['-c', command], {
        env: { PATH: '/usr/bin:/bin', CONTINUATION_RECEIPT: receipt },
      });
      expect(JSON.parse(await readFile(receipt, 'utf8'))).toEqual(['install', '--yes']);
      expect(command).not.toContain('/foreign/tenjin');
    },
  );

  it('quotes a Windows fallback as a literal PowerShell invocation', () => {
    const rt = setup({
      node: "C:\\Users\\O'Neil\\node.exe",
      entry: "C:\\Users\\O'Neil\\index.js",
      launcher: { paths: [], state: 'failed', onPath: false },
    });
    expect(continuationCommand(rt, 'win32')).toBe(
      "& 'C:\\Users\\O''Neil\\node.exe' 'C:\\Users\\O''Neil\\index.js'",
    );
  });

  it('says nothing about the runtime when it is already current, or active again', async () => {
    for (const over of [{ state: 'current' as const, firstTime: false }, { firstTime: false }]) {
      const result = await runRouterInstall(
        {},
        ctx(),
        deps(async () => setup(over)),
      );
      expect(runsLines(result.humanLines!)).toEqual([]);
      expect(pluginOf(result)).toMatchObject({ path: join(runtimeRoot, 'claude') });
    }
  });

  it.each([
    { state: 'failed' as const, reason: 'download checksum mismatch' },
    { state: 'failed' as const, reason: 'unsupported Linux', unpinned: 'musl' },
    { state: 'kept' as const, reason: 'new build failed verification' },
  ])(
    'keeps registration and settings untouched when runtime is $state: $reason',
    async (outcome) => {
      const before = await loadRawConfig(data);
      await expect(
        runRouterInstall(
          {},
          ctx(),
          deps(async () => setup(outcome)),
        ),
      ).rejects.toThrow(outcome.reason);
      expect(await fake.calls()).not.toContainEqual(
        expect.stringContaining('plugin marketplace add'),
      );
      expect(await loadRawConfig(data)).toEqual(before);
    },
  );

  it('refuses a custom data directory before invoking the runtime or changing registration', async () => {
    const runtime = vi.fn(async () => setup());
    await expect(
      runRouterInstall(
        {},
        ctx(),
        deps(runtime, {
          env: { ...fake.env, TENJIN_DATA_DIR: join(root, 'profile') },
          homeDir: join(root, 'different-home'),
        }),
      ),
    ).rejects.toThrow('default data directory');
    expect(runtime).not.toHaveBeenCalled();
    expect(await fake.calls()).toEqual([]);
  });

  it('skipped: the same lines as today’s install, from this package’s folder', async () => {
    const skipped = await runRouterInstall(
      {},
      ctx(),
      deps(async () => ({ state: 'skipped', root: runtimeRoot, firstTime: false, launcher: null })),
    );
    // Without the seam this source checkout is skipped by the real setupRuntime.
    const today = await runRouterInstall({}, ctx(), deps(undefined));
    expect(skipped.humanLines).toEqual(today.humanLines);
    expect(runtimeOf(today)).toMatchObject({ state: 'skipped' });
    expect(pluginOf(skipped)).toMatchObject({ path: hosts, version: pkg.version });
  });

  it('a registration that fails after activation restores the runtime', async () => {
    await fake.respond('mkt-add', 'boom', 1);
    // An enabled copy already in Claude Code: no folder fallback, so the run fails.
    await fake.respond('list', listed('tenjin@tenjin', '0.0.1'));
    const restore = vi.fn(async () => undefined);
    const result = await runRouterInstall(
      {},
      ctx(),
      deps(async () => setup({ restore })),
    );
    expect(pluginOf(result)).toMatchObject({ state: 'failed' });
    expect(restore).toHaveBeenCalledTimes(1);
  });

  /**
   * Claude Code reads `runtime/claude` in place once `add` repointed its one
   * `tenjin` row there. On a first activation the restore would delete every
   * file in it, leaving the row on an empty folder and no router at all.
   */
  it('keeps the activated render when `add` repointed the marketplace and install or update then fails', async () => {
    await fake.respond('list', listed('tenjin@tenjin', '0.0.1'));
    await fake.respond('install', '{"outcome":"error","message":"timed out"}\n', 1);
    const restore = vi.fn(async () => undefined);
    const failedInstall = await runRouterInstall(
      {},
      ctx(),
      deps(async () => setup({ restore })),
    );
    expect(pluginOf(failedInstall)).toMatchObject({ state: 'failed' });
    expect(await fake.calls()).toContain(
      `plugin marketplace add ${join(runtimeRoot, 'claude')} --json`,
    );
    await fake.respond(
      'install',
      `${JSON.stringify({ outcome: 'ok', installedVersion: '0.0.1', availableVersion: pkg.version })}\n`,
    );
    await fake.respond('update', '{"outcome":"error","message":"timed out"}\n', 1);
    const failedUpdate = await runRouterInstall(
      {},
      ctx(),
      deps(async () => setup({ restore })),
    );
    expect(pluginOf(failedUpdate)).toMatchObject({ state: 'failed' });
    expect((await fake.calls()).some((c) => c.startsWith('plugin update'))).toBe(true);
    expect(restore).not.toHaveBeenCalled();
  });

  it('a registration that succeeds does not restore', async () => {
    const restore = vi.fn(async () => undefined);
    await runRouterInstall(
      {},
      ctx(),
      deps(async () => setup({ restore })),
    );
    expect(restore).not.toHaveBeenCalled();
  });

  it('--refresh from an alpha.30 install moves the marketplace to the runtime', async () => {
    await fake.respond(
      'mkt-list',
      `${JSON.stringify([{ name: 'tenjin', source: 'directory', path: '/gone/lib/node_modules/tenjin-cli/dist/hosts/claude' }])}\n`,
    );
    await fake.respond('list', listed('tenjin@tenjin', '0.1.0-alpha.30'));
    const runtime = vi.fn(async () => setup({ state: 'current', firstTime: false }));
    const result = await runRouterInstall({ refresh: true }, ctx(), deps(runtime));
    expect(await fake.calls()).toContain(
      `plugin marketplace add ${join(runtimeRoot, 'claude')} --json`,
    );
    expect(runtimeOf(result)).toMatchObject({ state: 'current' });
    expect(runtime).toHaveBeenCalledWith(expect.objectContaining({ refresh: true }));
  });

  it('kept: registers the runtime build’s own version, not this one', async () => {
    const result = await runRouterInstall(
      {},
      ctx(),
      deps(async () => setup({ state: 'kept', cli: '0.1.0-alpha.99', launcher: null })),
    );
    expect(pluginOf(result)).toMatchObject({
      path: join(runtimeRoot, 'claude'),
      version: '0.1.0-alpha.99',
    });
  });

  /**
   * Where no `claude` binary could be run, a project's plugin folder runs a
   * runtime version and its Node by absolute path, and `state.json` names
   * neither once later activations moved on. GC must not take them from it.
   */
  it('GC keeps the version and Node a recorded project’s plugin folder runs', async () => {
    const anHourAgo = new Date(Date.now() - 60 * 60_000);
    const place = async (cli: string, node: string) => {
      for (const [dir, version, file] of [
        [versionDir(runtimeRoot, cli), cli, versionEntry(runtimeRoot, cli)],
        [join(runtimeRoot, 'node', node), node, nodeBinPath(runtimeRoot, node)],
      ] as const) {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, '');
        await writeFile(join(dir, '.complete'), JSON.stringify({ version }));
        await utimes(join(dir, '.complete'), anHourAgo, anHourAgo);
      }
    };
    await place('0.1.0-alpha.20', '22.0.0');
    await place('0.1.0-alpha.10', '21.0.0');
    await writeFile(
      join(runtimeRoot, 'state.json'),
      JSON.stringify({ schemaVersion: 1, current: { cli: pkg.version, node: NODE_V } }),
    );
    const project = join(root, 'proj');
    const folder = join(project, '.claude', 'skills', 'tenjin-router');
    const files = renderPluginFiles('0.1.0-alpha.20', versionEntry(runtimeRoot, '0.1.0-alpha.20'), {
      node: nodeBinPath(runtimeRoot, '22.0.0'),
    });
    for (const [path, body] of Object.entries(files)) {
      await mkdir(dirname(join(folder, path)), { recursive: true });
      await writeFile(join(folder, path), body);
    }
    await writeFile(
      join(data, 'config.json'),
      JSON.stringify({ install: { routerProjects: [project] } }),
    );
    await runRouterInstall(
      {},
      ctx(),
      deps(async () => setup()),
    );
    expect(existsSync(versionDir(runtimeRoot, '0.1.0-alpha.20'))).toBe(true);
    expect(existsSync(join(runtimeRoot, 'node', '22.0.0'))).toBe(true);
    // What nothing runs is still collected.
    expect(existsSync(versionDir(runtimeRoot, '0.1.0-alpha.10'))).toBe(false);
    expect(existsSync(join(runtimeRoot, 'node', '21.0.0'))).toBe(false);
  });

  it('a project install uses the same runtime at local scope', async () => {
    await runRouterInstall(
      { project: true },
      ctx(),
      deps(async () => setup()),
    );
    expect(await fake.calls()).toContain(
      `plugin marketplace add ${join(runtimeRoot, 'claude')} --json --scope local`,
    );
  });

  it('below the Claude Code floor with a settings install routing, no runtime is set up', async () => {
    await fake.respond('version', '2.1.200 (Claude Code)\n');
    await mkdir(cfg, { recursive: true });
    await writeFile(
      join(cfg, 'settings.json'),
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [
                {
                  type: 'mcp_tool',
                  server: 'x402',
                  tool: 'hook',
                  input: hookToolInput('prompt'),
                  timeout: 5,
                },
              ],
            },
          ],
        },
      }),
    );
    const runtime = vi.fn(async () => setup());
    const result = await runRouterInstall({}, ctx(), deps(runtime));
    expect(pluginOf(result)).toMatchObject({ state: 'deferred' });
    expect(runtime).not.toHaveBeenCalled();
    expect(runtimeOf(result)).toBeNull();
  });
});

/**
 * `tenjin uninstall --harness claude` keeps the runtime and its launcher while
 * Codex still runs them, and `tenjin update` refreshes that runtime through
 * the new build's `install --refresh`. With no Claude Code install to refresh,
 * the refresh runs the runtime step alone instead of refusing.
 */
describe('a refresh where only Tenjin’s runtime is left (Codex kept it)', () => {
  const state = (cli: string, previous: string | null) =>
    writeFile(
      join(runtimeRoot, 'state.json'),
      JSON.stringify({
        schemaVersion: 1,
        current: { cli, node: NODE_V },
        previous: previous === null ? null : { cli: previous, node: NODE_V },
        pending: null,
      }),
    );

  it('switches the runtime and creates nothing for Claude Code', async () => {
    await mkdir(runtimeRoot, { recursive: true });
    await state('0.1.0-alpha.30', null);
    const runtime = vi.fn(async () => {
      await state(pkg.version, '0.1.0-alpha.30');
      return setup({ firstTime: false });
    });
    const result = await runRouterInstall({ refresh: true }, ctx(), deps(runtime));
    expect(runtime).toHaveBeenCalledWith(
      expect.objectContaining({ dataDir: data, home, version: pkg.version, refresh: true }),
    );
    expect(readRuntimeState(runtimeRoot)?.current.cli).toBe(pkg.version);
    expect(result.data).toMatchObject({
      plugin: null,
      refresh: true,
      runtime: { state: 'active', cli: pkg.version, nodeVersion: NODE_V },
      launcher: launcherOk,
    });
    // No plugin command, no plugin folder, no settings, no spend write.
    const calls = await fake.calls();
    expect(calls.filter((c) => /^plugin (marketplace add|install|update)/.test(c))).toEqual([]);
    expect(existsSync(join(cfg, 'skills', 'tenjin-router'))).toBe(false);
    expect(existsSync(join(cfg, 'settings.json'))).toBe(false);
    expect(existsSync(join(data, 'config.json'))).toBe(false);
  });

  it('still refuses when there is no runtime either', async () => {
    const runtime = vi.fn(async () => setup());
    const out = await runRouterInstall({ refresh: true }, ctx(), deps(runtime)).catch(
      (e: unknown) => e,
    );
    expect(out).toMatchObject({
      code: 'REFUSED',
      message: expect.stringMatching(/^Nothing to refresh/),
    });
    expect(runtime).not.toHaveBeenCalled();
  });
});

describe('install records the project installs Claude Code lists', () => {
  let project: string;
  beforeEach(async () => {
    project = join(root, 'proj');
    await mkdir(project, { recursive: true });
  });

  it('adds a recorded project missing from routerProjects', async () => {
    await recordInstalls([
      { projectPath: project, scope: 'local', installPath: '/stale', version: '0.0.1' },
      { scope: 'user', installPath: '/stale' },
      { scope: 'local', projectPath: join(root, 'gone') },
    ]);
    await runRouterInstall(
      {},
      ctx(),
      deps(async () => setup()),
    );
    expect(await routerProjects()).toEqual([project]);
    // One user-scope `marketplace add` repoints every project install too.
    expect(
      (await fake.calls()).some(
        (c) => c.includes('marketplace add') && c.includes('--scope local'),
      ),
    ).toBe(false);
  });

  it('adds it on a refresh too, even one that then finds nothing to refresh', async () => {
    await recordInstalls([{ scope: 'local', projectPath: project }]);
    const out = await runRouterInstall(
      { refresh: true },
      ctx(),
      deps(async () => setup()),
    ).catch((e: unknown) => e);
    expect(out).toBeInstanceOf(CliError);
    expect((out as CliError).message).toMatch(/^Nothing to refresh/);
    expect(await routerProjects()).toEqual([project]);
  });

  it('a --project run adds nothing it did not install', async () => {
    await recordInstalls([{ scope: 'local', projectPath: project }]);
    await runRouterInstall(
      { project: true },
      ctx(),
      deps(async () => setup()),
    );
    expect(await routerProjects()).not.toContain(project);
  });

  it('an unreadable record adds nothing, and install goes on', async () => {
    await recordInstalls('{not json');
    const result = await runRouterInstall(
      {},
      ctx(),
      deps(async () => setup()),
    );
    expect(await routerProjects()).toEqual([]);
    expect(pluginOf(result)).toMatchObject({ method: 'plugin' });
  });
});

describe('the launcher lines', () => {
  const run = (launcher: LauncherResult) =>
    runRouterInstall(
      {},
      ctx(),
      deps(async () => setup({ launcher, firstTime: false })),
    );
  const warnings = (lines: string[]) => lines.filter((l) => l.startsWith('! '));

  it('names a launcher folder off PATH, with the line that adds it', async () => {
    const result = await run({
      ...launcherOk,
      onPath: false,
      pathLine: 'fish_add_path ~/.local/bin',
    });
    expect(warnings(result.humanLines!)).toEqual([
      "! ~/.local/bin is not on your PATH, so a terminal will not find `tenjin` once npm's copy is gone (inside Claude Code the plugin's own `tenjin` is on the Bash tool's PATH). Add it: fish_add_path ~/.local/bin",
    ]);
  });

  it('names a file in its place that is not Tenjin’s', async () => {
    const result = await run({
      ...launcherOk,
      state: 'foreign',
      reason: "/h/.local/bin/tenjin is not Tenjin's",
    });
    expect(warnings(result.humanLines!)).toEqual([
      "! /h/.local/bin/tenjin is not Tenjin's, so it was left as it is, and `tenjin` there runs that file instead of Tenjin's runtime. Move it aside and run `tenjin install` again to put Tenjin's there.",
    ]);
  });

  it('names a launcher that could not be written', async () => {
    const result = await run({ ...launcherOk, state: 'failed', reason: 'EACCES' });
    expect(warnings(result.humanLines!)).toHaveLength(1);
    expect(warnings(result.humanLines!)[0]).toContain('could not be written');
    expect(warnings(result.humanLines!)[0]).toContain('(EACCES)');
  });

  it('says nothing for npm’s own link, even off PATH', async () => {
    const result = await run({ ...launcherOk, state: 'npm', onPath: false, pathLine: 'x' });
    expect(warnings(result.humanLines!)).toEqual([]);
  });

  it('a refresh hands the launcher line to update’s parent as a notice', async () => {
    await fake.respond('list', listed('tenjin@tenjin', pkg.version));
    const result = await runRouterInstall(
      { refresh: true },
      ctx(),
      deps(async () =>
        setup({ launcher: { ...launcherOk, state: 'failed', reason: 'EACCES' }, firstTime: true }),
      ),
    );
    const notices = (result.data as { notices: string[] }).notices;
    expect(notices.filter((n) => n.includes('could not be written'))).toHaveLength(1);
    expect(notices).toContain(
      `Tenjin runs from ~/.tenjin/runtime on its own Node ${NODE_V}, so a Node upgrade or \`npm rm -g tenjin-cli\` no longer stops it.`,
    );
  });
});

describe('an install run over two hosts', () => {
  it('sets the runtime up once, and says its warnings under the first host only', async () => {
    const setUp = vi.fn(async (): Promise<RuntimeSetup> => ({
      state: 'current',
      root: runtimeRoot,
      firstTime: true,
      launcher: { ...launcherOk, onPath: false, pathLine: 'fish_add_path ~/.local/bin' },
    }));
    const once = runtimeOncePerRun(setUp);
    const runtime = (o: unknown) => once(o as Parameters<typeof once>[0]);
    const warnings = (lines: string[]) => lines.filter((l) => l.startsWith('! '));
    const first = await runRouterInstall({}, ctx(), deps(runtime));
    const second = await runRouterInstall({}, ctx(), deps(runtime));
    expect(setUp).toHaveBeenCalledTimes(1);
    expect(warnings(first.humanLines!)).toHaveLength(1);
    expect(warnings(second.humanLines!)).toEqual([]);
    expect(runtimeOf(second)).toEqual(runtimeOf(first));
  });
});
