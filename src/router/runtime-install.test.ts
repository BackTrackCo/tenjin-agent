import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pkg from '../../package.json';
import { loadRawConfig } from '../lib/config';
import { CliError } from '../lib/errors';
import type { LauncherResult, RuntimeSetup } from '../lib/runtime';
import type { CommandContext } from '../context';
import { fakeClaude, listed, type FakeClaude } from './claude-test-utils';
import { hookToolInput } from './hook-tool';
import { runRouterInstall } from './install';

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
const FALLBACK = (reason: string) =>
  `Tenjin's own runtime could not be set up (${reason}), so the plugin still runs on the Node on your PATH; run \`tenjin install\` again to retry.`;

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

  it('fallback: registers this package’s folder, with one ! line and the refresh notice', async () => {
    const reason = 'no pinned Node for linux-ia32';
    const fallback = async () =>
      ({ state: 'fallback', root: runtimeRoot, firstTime: true, launcher: null, reason }) as const;
    const result = await runRouterInstall({}, ctx(), deps(fallback));
    expect(await fake.calls()).toContain(`plugin marketplace add ${hosts} --json`);
    expect(result.humanLines!.filter((l) => l.includes('could not be set up'))).toEqual([
      `! ${FALLBACK(reason)}`,
    ]);
    // A refresh with a fallback still succeeds, and update's parent prints the sentence.
    await fake.respond('list', listed('tenjin@tenjin', pkg.version));
    const refreshed = await runRouterInstall({ refresh: true }, ctx(), deps(fallback));
    expect((refreshed.data as { notices: string[] }).notices).toContain(FALLBACK(reason));
    expect(runtimeOf(refreshed)).toMatchObject({ state: 'fallback', reason });
  });

  it('a platform with no pinned Node says so once, with no retry that cannot work', async () => {
    const unpinned = 'linux-x64 with musl, not glibc';
    const fallback = async () =>
      ({
        state: 'fallback',
        root: runtimeRoot,
        firstTime: true,
        launcher: null,
        reason: `no pinned Node for this platform, ${unpinned}`,
        unpinned,
      }) as const;
    const result = await runRouterInstall({}, ctx(), deps(fallback));
    const line = `Tenjin pins no Node for this platform (${unpinned}), so the plugin runs from npm's copy on the Node on your PATH, as before.`;
    expect(result.humanLines!.filter((l) => l.includes('pins no Node'))).toEqual([`! ${line}`]);
    expect(result.humanLines!.join('\n')).not.toContain('again to retry');
    await fake.respond('list', listed('tenjin@tenjin', pkg.version));
    const refreshed = await runRouterInstall({ refresh: true }, ctx(), deps(fallback));
    expect((refreshed.data as { notices: string[] }).notices).toContain(line);
  });

  it('fallback with a step that works: names that step, never the retry, in lines and notices', async () => {
    const reason = 'this shell sets HTTPS_PROXY, which Node 22.12.0 cannot send downloads through';
    const fix =
      "run `tenjin install` once with Node 24.14 or newer, which uses the proxy; Tenjin's own Node does from then on";
    const fallback = async () =>
      ({
        state: 'fallback',
        root: runtimeRoot,
        firstTime: true,
        launcher: null,
        reason,
        fix,
      }) as const;
    const line = `Tenjin's own runtime could not be set up (${reason}), so the plugin still runs on the Node on your PATH; ${fix}.`;
    const result = await runRouterInstall({}, ctx(), deps(fallback));
    expect(result.humanLines!.filter((l) => l.includes('could not be set up'))).toEqual([
      `! ${line}`,
    ]);
    expect(result.humanLines!.join('\n')).not.toContain('again to retry');
    expect(runtimeOf(result)).toMatchObject({ reason, fix });
    await fake.respond('list', listed('tenjin@tenjin', pkg.version));
    const refreshed = await runRouterInstall({ refresh: true }, ctx(), deps(fallback));
    expect((refreshed.data as { notices: string[] }).notices).toContain(line);
  });

  it('kept after this build failed its checks: names both versions and the retry, in lines and notices', async () => {
    const reason = 'tenjin --version printed nothing';
    const kept = async () =>
      setup({ state: 'kept', cli: '0.1.0-alpha.31', launcher: null, reason });
    const line = `tenjin-cli ${pkg.version} could not be set up (${reason}), so Tenjin keeps running 0.1.0-alpha.31; run \`tenjin install\` again to retry.`;
    const result = await runRouterInstall({}, ctx(), deps(kept));
    expect(result.humanLines!.filter((l) => l.includes('could not be set up'))).toEqual([
      `! ${line}`,
    ]);
    await fake.respond('list', listed('tenjin@tenjin', pkg.version));
    const refreshed = await runRouterInstall({ refresh: true }, ctx(), deps(kept));
    expect((refreshed.data as { notices: string[] }).notices).toContain(line);
    // A refresh that found a newer runtime tried nothing, so there is nothing to say.
    const newer = await runRouterInstall(
      { refresh: true },
      ctx(),
      deps(async () =>
        setup({
          state: 'kept',
          cli: '0.1.0-alpha.99',
          launcher: null,
          reason: `Tenjin 0.1.0-alpha.99 is already set up here; this ${pkg.version} did not replace it`,
          newer: true,
        }),
      ),
    );
    expect((newer.data as { notices: string[] }).notices).toEqual([]);
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

  it('a plain install that rolled back says so in exactly one line', async () => {
    const result = await runRouterInstall(
      {},
      ctx(),
      deps(async () => setup({ replaced: '0.1.0-alpha.99', firstTime: false })),
    );
    expect(result.humanLines!.filter((l) => l.startsWith('Replacing tenjin-cli'))).toEqual([
      `Replacing tenjin-cli 0.1.0-alpha.99 with ${pkg.version}.`,
    ]);
    expect(runtimeOf(result)).toMatchObject({ replaced: '0.1.0-alpha.99' });
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
