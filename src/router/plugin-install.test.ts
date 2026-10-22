import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pkg from '../../package.json';
import { CliError } from '../lib/errors';
import type { CommandContext } from '../context';
import { aliveDir, runAliveHook } from './alive';
import { fakeClaude, listed, type FakeClaude } from './claude-test-utils';
import { hookToolInput, type HookKind } from './hook-tool';
import { runRouterInstall } from './install';
import { PLUGIN_FILES, renderHostFiles, renderPluginFiles } from './plugin-files';
import { runRouterUninstall } from './uninstall';

/**
 * THE PLUGIN INSTALL, END TO END THROUGH A FAKE `claude`: what `install`,
 * `install --refresh` (which `tenjin update` runs), `uninstall` and `doctor`
 * ask Claude Code to do, in order, and what they write themselves, which is
 * nothing in Claude Code's config except the folder fallback and the guarded
 * removal of a settings install.
 */

let root: string;
let home: string;
let data: string;
let cfg: string;
let work: string;
let hosts: string;
let fake: FakeClaude;

const ADDRESS = '0x3c0D84055994c3062819Ce8730869D0aDeA4c3Bf';
const probe400 = (async () =>
  new Response('{}', {
    status: 400,
    headers: { 'content-type': 'application/json' },
  })) as typeof fetch;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'plugin-install-'));
  home = join(root, 'home');
  data = join(root, 'data');
  cfg = join(root, 'cfg');
  work = join(root, 'work');
  hosts = join(root, 'pkg', 'dist', 'hosts', 'claude');
  await mkdir(join(work, '.git'), { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(data, { recursive: true });
  for (const [path, body] of Object.entries(renderHostFiles(pkg.version))) {
    await mkdir(dirname(join(hosts, path)), { recursive: true });
    await writeFile(join(hosts, path), body);
  }
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

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...fake.env, CLAUDE_CONFIG_DIR: cfg, ...extra };
}

/** An empty PATH: no `claude` anywhere. */
async function emptyPath(): Promise<string> {
  const dir = join(root, 'empty-path');
  await mkdir(dir, { recursive: true });
  return dir;
}

function deps(over: Record<string, unknown> = {}) {
  return {
    homeDir: home,
    cwd: work,
    env: env(),
    hostsDir: hosts,
    cliEntry: join(root, 'pkg', 'dist', 'index.js'),
    walletExists: async () => true,
    walletAddress: async () => ADDRESS,
    createWallet: vi.fn(async () => ADDRESS),
    walletSigning: async () => ({
      signing: { status: 'ready' as const, source: 'keychain' as const },
    }),
    listMcpProcesses: async () => [],
    ...over,
  };
}

async function exists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null)) !== null;
}

/** One settings-install leg, as alpha.26 wrote it. */
const legacyLeg = (kind: HookKind, timeout = 5) => [
  { type: 'mcp_tool', server: 'x402', tool: 'hook', input: hookToolInput(kind), timeout },
];

/** A settings file as an alpha.26 install left it, with the user's own entries beside ours. */
function legacySettings(): Record<string, unknown> {
  return {
    model: 'opus',
    hooks: {
      UserPromptSubmit: [{ hooks: legacyLeg('prompt') }],
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'my-bash-guard' }] },
        {
          matcher: 'WebSearch|WebFetch',
          hooks: [...legacyLeg('native'), { type: 'command', command: 'my-fetch-logger' }],
        },
        { matcher: 'Agent|Task', hooks: legacyLeg('agent') },
        { matcher: 'AskUserQuestion', hooks: legacyLeg('ask') },
        {
          matcher: 'Read',
          hooks: [{ type: 'command', command: '~/bin/notify.sh; tenjin hook prompt' }],
        },
      ],
      PostToolUse: [
        { matcher: 'WebSearch|WebFetch', hooks: legacyLeg('shortfall', 15) },
        { matcher: 'AskUserQuestion', hooks: legacyLeg('answer') },
      ],
      PostToolUseFailure: [{ matcher: 'WebSearch|WebFetch', hooks: legacyLeg('shortfall', 15) }],
    },
    permissions: {
      allow: ['mcp__x402__request', 'Bash(git status)'],
      deny: ['mcp__x402__hook', 'Bash(rm:*)'],
    },
    statusLine: { type: 'command', command: 'tenjin status-line', refreshInterval: 1 },
  };
}

async function writeLegacy(mcpCommand = 'tenjin'): Promise<void> {
  await mkdir(cfg, { recursive: true });
  await writeFile(join(cfg, 'settings.json'), `${JSON.stringify(legacySettings(), null, 2)}\n`);
  await writeFile(
    join(cfg, '.claude.json'),
    `${JSON.stringify({ mcpServers: { x402: { command: mcpCommand, args: ['mcp'] } } }, null, 2)}\n`,
  );
}

const pluginOf = (result: { data: unknown }) =>
  (result.data as { plugin: Record<string, unknown> }).plugin;
const migrationOf = (result: { data: unknown }) =>
  (result.data as { migration: Record<string, unknown> }).migration;

describe('tenjin install registers the plugin through Claude Code', () => {
  it('runs the plugin commands in order and writes no settings of its own', async () => {
    const result = await runRouterInstall({}, ctx(), deps());
    expect(await fake.calls()).toEqual([
      '--version',
      'plugin marketplace list --json',
      `plugin marketplace add ${hosts} --json`,
      'plugin install tenjin@tenjin --scope user --json',
    ]);
    expect(pluginOf(result)).toMatchObject({
      method: 'plugin',
      id: 'tenjin@tenjin',
      state: 'installed',
      path: hosts,
      version: pkg.version,
    });
    // Claude's commands write enabledPlugins; this CLI writes nothing there itself.
    expect(await exists(join(cfg, 'settings.json'))).toBe(false);
    expect(await exists(join(cfg, '.claude.json'))).toBe(false);
    expect(await exists(join(home, '.claude'))).toBe(false);
    expect(await exists(join(home, '.claude.json'))).toBe(false);
    expect((await fake.configDirs()).every((d) => d === cfg)).toBe(true);
  });

  it('ends with a step taken in the session, never a command run elsewhere', async () => {
    const result = await runRouterInstall({}, ctx(), deps());
    const next = (result.data as { next: string }).next;
    expect(next).toContain('/reload-plugins');
    const text = [next, ...(result.humanLines ?? [])].join('\n');
    expect(text).not.toMatch(/terminal|restart Claude Code|run the command above|by hand/i);
    expect(result.humanLines).toContain(
      `✓ Tenjin is set up for Claude Code (plugin tenjin@tenjin)`,
    );
  });

  it('updates the plugin when Claude Code holds an older version of it', async () => {
    await fake.respond(
      'install',
      `${JSON.stringify({ command: 'install', outcome: 'ok', installedVersion: '0.0.1', availableVersion: pkg.version })}\n`,
    );
    const result = await runRouterInstall({}, ctx(), deps());
    expect((await fake.calls()).at(-1)).toBe('plugin update tenjin@tenjin --scope user --json');
    expect(pluginOf(result)).toMatchObject({ state: 'updated' });
  });

  it('runs nothing more when Claude Code already holds this version', async () => {
    await fake.respond(
      'install',
      `${JSON.stringify({ command: 'install', outcome: 'ok', installedVersion: pkg.version, availableVersion: pkg.version })}\n`,
    );
    const result = await runRouterInstall({}, ctx(), deps());
    expect(await fake.calls()).not.toContain('plugin update tenjin@tenjin --scope user --json');
    expect(pluginOf(result)).toMatchObject({ state: 'current' });
  });

  it('finds claude through CLAUDE_CODE_EXECPATH when PATH has none', async () => {
    const result = await runRouterInstall(
      {},
      ctx(),
      deps({ env: env({ PATH: await emptyPath(), CLAUDE_CODE_EXECPATH: fake.bin }) }),
    );
    expect(await fake.calls()).toContain('plugin install tenjin@tenjin --scope user --json');
    expect(result.data).toMatchObject({
      claudeCode: { binary: fake.bin, source: 'execpath' },
      plugin: { method: 'plugin' },
    });
  });

  it('writes the plugin folder under CLAUDE_CONFIG_DIR when there is no claude at all', async () => {
    const hosted = join(cfg, 'skills', 'tenjin');
    await mkdir(hosted, { recursive: true });
    await writeFile(join(hosted, 'SKILL.md'), 'the hosted skill');
    const result = await runRouterInstall(
      {},
      ctx(),
      deps({ env: env({ PATH: await emptyPath() }) }),
    );
    const folder = join(cfg, 'skills', 'tenjin-router');
    expect(pluginOf(result)).toMatchObject({
      method: 'skills-dir',
      id: 'tenjin@skills-dir',
      state: 'written',
      path: folder,
    });
    // Outside the package, so its commands carry the absolute entry install resolved.
    const files = renderPluginFiles(pkg.version, join(root, 'pkg', 'dist', 'index.js'));
    expect(JSON.parse(files['.mcp.json']!)).toEqual({
      mcpServers: {
        router: {
          command: 'node',
          args: [join(root, 'pkg', 'dist', 'index.js'), 'mcp', '--plugin'],
        },
      },
    });
    for (const path of PLUGIN_FILES) {
      expect(await readFile(join(folder, path), 'utf8')).toBe(files[path]);
    }
    expect(await readFile(join(hosted, 'SKILL.md'), 'utf8')).toBe('the hosted skill');
    expect(await exists(join(home, '.claude'))).toBe(false);
    expect(await fake.calls()).toEqual([]);
  });

  it('falls back to the folder when a plugin command fails', async () => {
    await fake.respond(
      'mkt-add',
      '{"command":"marketplace-add","outcome":"failed","message":"denied by policy"}\n',
      1,
    );
    const result = await runRouterInstall({}, ctx(), deps());
    expect(pluginOf(result)).toMatchObject({ method: 'skills-dir', state: 'written' });
    expect(String(pluginOf(result).fallbackReason)).toContain('denied by policy');
    expect(await fake.calls()).not.toContain('plugin install tenjin@tenjin --scope user --json');
  });

  it('removes a folder an earlier fallback wrote once the commands register the plugin', async () => {
    await runRouterInstall({}, ctx(), deps({ env: env({ PATH: await emptyPath() }) }));
    const folder = join(cfg, 'skills', 'tenjin-router');
    await mkdir(join(folder, 'skills'), { recursive: true });
    await writeFile(join(folder, 'skills', 'mine.md'), 'mine');
    const result = await runRouterInstall({}, ctx(), deps());
    expect(pluginOf(result)).toMatchObject({
      method: 'plugin',
      supersededFolder: { removed: true, left: ['skills/mine.md'] },
    });
    expect(await exists(join(folder, '.claude-plugin', 'plugin.json'))).toBe(false);
    expect(await readFile(join(folder, 'skills', 'mine.md'), 'utf8')).toBe('mine');
  });

  it('refuses a plugin folder it did not write, and says what to do in the session', async () => {
    const folder = join(cfg, 'skills', 'tenjin-router');
    await mkdir(join(folder, '.claude-plugin'), { recursive: true });
    await writeFile(join(folder, '.claude-plugin', 'plugin.json'), '{"name":"tenjin"}');
    const result = await runRouterInstall(
      {},
      ctx(),
      deps({ env: env({ PATH: await emptyPath() }) }),
    );
    expect(pluginOf(result)).toMatchObject({ method: 'none', state: 'failed' });
    expect((result.data as { next: string }).next).toBe(
      `Move ${folder} aside, then run \`tenjin install\` again.`,
    );
    expect(await readFile(join(folder, '.claude-plugin', 'plugin.json'), 'utf8')).toBe(
      '{"name":"tenjin"}',
    );
  });

  it('leaves a marketplace named tenjin that it did not add, and writes no second copy', async () => {
    await fake.respond(
      'mkt-list',
      `${JSON.stringify([{ name: 'tenjin', source: 'github', repo: 'someone/else' }])}\n`,
    );
    await fake.respond('list', listed('tenjin@tenjin', '0.9.0'));
    const result = await runRouterInstall({}, ctx(), deps());
    expect((await fake.calls()).some((c) => c.startsWith('plugin marketplace add'))).toBe(false);
    expect(pluginOf(result)).toMatchObject({ method: 'none', id: 'tenjin@tenjin' });
    expect(await exists(join(cfg, 'skills', 'tenjin-router'))).toBe(false);
  });

  it('writes no second copy when a refresh cannot update the plugin Claude Code already has', async () => {
    await fake.respond('list', listed('tenjin@tenjin', '0.0.1'));
    await fake.respond(
      'install',
      `${JSON.stringify({ command: 'install', outcome: 'ok', installedVersion: '0.0.1', availableVersion: pkg.version })}\n`,
    );
    await fake.respond(
      'update',
      '{"command":"update","outcome":"failed","message":"network down"}\n',
      1,
    );
    const out = await runRouterInstall({ refresh: true }, ctx(), deps()).catch((e: unknown) => e);
    expect(out).toBeInstanceOf(CliError);
    expect((out as CliError).message).toContain('claude plugin update failed: network down');
    expect((out as CliError).message).toContain('no second copy was written');
    expect(await exists(join(cfg, 'skills', 'tenjin-router'))).toBe(false);
  });

  it('writes no second copy when the list cannot be read but Claude Code recorded the plugin', async () => {
    await fake.respond(
      'install',
      '{"command":"install","outcome":"failed","message":"denied"}\n',
      1,
    );
    await fake.respond('list', 'not json', 1);
    await mkdir(join(cfg, 'plugins'), { recursive: true });
    await writeFile(
      join(cfg, 'plugins', 'installed_plugins.json'),
      JSON.stringify({ version: 2, plugins: { 'tenjin@tenjin': [{ scope: 'user' }] } }),
    );
    const result = await runRouterInstall({}, ctx(), deps());
    expect(pluginOf(result)).toMatchObject({
      method: 'none',
      id: 'tenjin@tenjin',
      state: 'failed',
    });
    expect(await exists(join(cfg, 'skills', 'tenjin-router'))).toBe(false);
  });

  it('still refreshes its own folder when a command fails and only that folder is loaded', async () => {
    await runRouterInstall({}, ctx(), deps({ env: env({ PATH: await emptyPath() }) }));
    await fake.respond('list', listed('tenjin@skills-dir', '0.0.1'));
    await fake.respond(
      'mkt-add',
      '{"command":"marketplace-add","outcome":"failed","message":"denied by policy"}\n',
      1,
    );
    const result = await runRouterInstall({ refresh: true }, ctx(), deps());
    expect(pluginOf(result)).toMatchObject({ method: 'skills-dir', state: 'written' });
  });

  it.each([
    ['exits non-zero', 'boom', 1],
    ['prints something that is not a list', 'Checking marketplaces...\n{"oops":true}', 0],
  ] as const)(
    'adds and repoints no marketplace when the marketplace list %s',
    async (_label, out, code) => {
      await fake.respond('mkt-list', out, code);
      const result = await runRouterInstall({}, ctx(), deps());
      const calls = await fake.calls();
      expect(calls.some((c) => c.startsWith('plugin marketplace add'))).toBe(false);
      expect(calls.some((c) => c.startsWith('plugin install'))).toBe(false);
      expect(String(pluginOf(result).fallbackReason)).toContain(
        'claude plugin marketplace list could not be read',
      );
      // Nothing of Claude Code's holds a Tenjin plugin, so the folder is the registration.
      expect(pluginOf(result)).toMatchObject({ method: 'skills-dir', state: 'written' });
    },
  );

  it('changes nothing when the marketplace list is unreadable and the plugin is already enabled', async () => {
    await fake.respond('mkt-list', 'garbage', 0);
    await fake.respond('list', listed('tenjin@tenjin', pkg.version));
    const result = await runRouterInstall({}, ctx(), deps());
    expect((await fake.calls()).some((c) => c.startsWith('plugin marketplace add'))).toBe(false);
    expect(pluginOf(result)).toMatchObject({
      method: 'none',
      id: 'tenjin@tenjin',
      state: 'failed',
    });
    expect(await exists(join(cfg, 'skills', 'tenjin-router'))).toBe(false);
  });

  it('repoints its own marketplace after the package moved', async () => {
    await fake.respond(
      'mkt-list',
      `${JSON.stringify([{ name: 'tenjin', source: 'directory', path: '/gone/node_modules/tenjin-cli/dist/hosts/claude' }])}\n`,
    );
    await runRouterInstall({}, ctx(), deps());
    expect(await fake.calls()).toContain(`plugin marketplace add ${hosts} --json`);
  });

  it('registers below the Claude Code floor, and the fix is `claude update` in the session', async () => {
    await fake.respond('version', '2.1.200 (Claude Code)\n');
    const result = await runRouterInstall({}, ctx(), deps());
    expect(result.data).toMatchObject({
      claudeCode: { version: '2.1.200', meetsFloor: false },
      plugin: { method: 'plugin' },
    });
    expect((result.data as { next: string }).next).toMatch(
      /^run `claude update`, then type \/reload-plugins/,
    );
  });

  it('registers the plugin for this project only with --project', async () => {
    const result = await runRouterInstall({ project: true }, ctx(), deps());
    expect(await fake.calls()).toEqual([
      '--version',
      'plugin marketplace list --json',
      `plugin marketplace add ${hosts} --json --scope local`,
      'plugin install tenjin@tenjin --scope local --json',
    ]);
    expect(result.data).toMatchObject({
      plugin: { scope: 'local' },
      doctor: 'tenjin doctor --project',
    });
    expect(result.humanLines).toContain(
      '  For this project only; check it with: tenjin doctor --project',
    );
    // Recorded, so `tenjin update`, which refreshes from home, reaches it.
    const config = JSON.parse(await readFile(join(data, 'config.json'), 'utf8')) as {
      install?: { routerProjects?: string[] };
    };
    expect(config.install?.routerProjects).toEqual([work]);
  });
});

describe('the settings install of an earlier release', () => {
  it('stays until the plugin has loaded, then only its exact shapes are removed', async () => {
    await writeLegacy();
    const before = await readFile(join(cfg, 'settings.json'), 'utf8');
    const first = await runRouterInstall({}, ctx(), deps());
    expect(migrationOf(first)).toMatchObject({
      state: 'pending',
      reason: 'Claude Code does not list the plugin as enabled yet',
    });
    await fake.respond('list', listed('tenjin@tenjin', pkg.version));
    const second = await runRouterInstall({ refresh: true }, ctx(), deps());
    expect(migrationOf(second)).toMatchObject({
      state: 'pending',
      reason: 'the plugin has not loaded in a Claude Code session on this machine yet',
    });
    expect(await readFile(join(cfg, 'settings.json'), 'utf8')).toBe(before);
    expect(await fake.calls()).not.toContain('mcp remove x402 -s user');

    // A session loads the plugin: its SessionStart leg stamps the machine.
    await runAliveHook({ session_id: 'sess-1' }, { dataDir: data, version: pkg.version });
    const third = await runRouterInstall({ refresh: true }, ctx(), deps());
    expect(migrationOf(third)).toMatchObject({
      state: 'done',
      removed: { allowRule: true, denyRule: true, statusLine: 'removed', mcp: 'removed' },
    });
    expect(await fake.calls()).toContain('mcp remove x402 -s user');
    const settings = JSON.parse(await readFile(join(cfg, 'settings.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(settings).toEqual({
      model: 'opus',
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'my-bash-guard' }] },
          {
            matcher: 'WebSearch|WebFetch',
            hooks: [{ type: 'command', command: 'my-fetch-logger' }],
          },
          {
            matcher: 'Read',
            hooks: [{ type: 'command', command: '~/bin/notify.sh; tenjin hook prompt' }],
          },
        ],
      },
      permissions: { allow: ['Bash(git status)'], deny: ['Bash(rm:*)'] },
    });
  });

  it('is never removed below the Claude Code floor, even with the stamp', async () => {
    await writeLegacy();
    await fake.respond('version', '2.1.200 (Claude Code)\n');
    await fake.respond('list', listed('tenjin@tenjin', pkg.version));
    await runAliveHook({ session_id: 's' }, { dataDir: data, version: pkg.version });
    const result = await runRouterInstall({ refresh: true }, ctx(), deps());
    expect(migrationOf(result)).toMatchObject({ state: 'pending' });
    expect(String(migrationOf(result).reason)).toContain('older than the plugin needs');
  });

  /**
   * BELOW THE FLOOR THE SETTINGS INSTALL KEEPS ROUTING. Registering the plugin
   * there would load its `alive` command leg, which silences the settings
   * install in every session, while its `mcp_tool` legs need 2.1.287: the
   * machine would route nothing. So nothing is registered until `claude update`.
   */
  it('registers nothing below the floor while a settings install routes, and says so', async () => {
    await writeLegacy();
    await fake.respond('version', '2.1.200 (Claude Code)\n');
    const before = await readFile(join(cfg, 'settings.json'), 'utf8');
    const install = await runRouterInstall({}, ctx(), deps());
    const refresh = await runRouterInstall({ refresh: true }, ctx(), deps());
    expect(await fake.calls()).toEqual(['--version', '--version']);
    for (const result of [install, refresh]) {
      expect(pluginOf(result)).toMatchObject({ method: 'none', state: 'deferred' });
      expect(migrationOf(result)).toMatchObject({ state: 'pending' });
    }
    expect(await readFile(join(cfg, 'settings.json'), 'utf8')).toBe(before);
    expect(await exists(join(cfg, 'skills', 'tenjin-router'))).toBe(false);
    expect((install.data as { next: string }).next).toBe(
      'run `claude update`, then run `tenjin install` again; until then the earlier Tenjin setup keeps routing as before',
    );
    expect(install.humanLines![0]).toBe(
      '! Tenjin keeps its earlier Claude Code setup until Claude Code is updated',
    );
    // `tenjin update` prints the refresh's notices, since it shows nothing else of a success.
    expect((refresh.data as { notices: string[] }).notices).toEqual([
      'Claude Code 2.1.200 is older than 2.1.287, so the Tenjin plugin was not registered and the earlier settings setup keeps routing. Run `claude update`, then `tenjin install`.',
    ]);
  });

  /**
   * /reload-plugins RECONNECTS PLUGIN SERVERS ONLY. In the session the upgrade
   * ran in, the settings install's `x402` server still runs the old build,
   * which knows no marker, so loading the plugin beside it would route every
   * event twice. While a settings install stays, the step is a new session.
   */
  it('asks for a new session, never /reload-plugins, while a settings install stays', async () => {
    await writeLegacy();
    const stale = {
      listMcpProcesses: async () => [{ pid: 9044, startedAt: 1 }],
      installedAt: async () => 2,
    };
    const install = await runRouterInstall({}, ctx(), deps(stale));
    const next = (install.data as { next: string }).next;
    expect(next).toBe('start a new Claude Code session so Tenjin loads');
    const text = [next, ...(install.humanLines ?? [])].join('\n');
    expect(text).not.toContain('/reload-plugins in this');
    expect(install.data).toMatchObject({
      mcpServer: {
        status: 'warn',
        fix: 'Start a new Claude Code session: the earlier Tenjin setup is still in this one, and /reload-plugins would run both.',
      },
    });
    const refresh = await runRouterInstall({ refresh: true }, ctx(), deps(stale));
    expect((refresh.data as { notices: string[] }).notices).toEqual([
      'Start a new Claude Code session so the Tenjin plugin loads; the earlier settings setup is removed by the next `tenjin update` or `tenjin install` after that.',
    ]);
    // Once it is gone, /reload-plugins is safe again.
    await fake.respond('list', listed('tenjin@tenjin', pkg.version));
    await runAliveHook({ session_id: 's' }, { dataDir: data, version: pkg.version });
    await runRouterInstall({ refresh: true }, ctx(), deps());
    const after = await runRouterInstall({}, ctx(), deps(stale));
    expect((after.data as { next: string }).next).toContain('/reload-plugins');
  });

  it('names the Tenjin status line it removes, in install and in the notices update prints', async () => {
    await writeLegacy();
    await fake.respond('list', listed('tenjin@tenjin', pkg.version));
    await runAliveHook({ session_id: 's' }, { dataDir: data, version: pkg.version });
    const line =
      'Removed the Tenjin status line (`tenjin status-line`) with the earlier settings setup; the plugin sets none. To keep it, set `tenjin status-line` as your Claude Code status line command.';
    const refresh = await runRouterInstall({ refresh: true }, ctx(), deps());
    expect(migrationOf(refresh)).toMatchObject({
      state: 'done',
      removed: { statusLine: 'removed' },
    });
    expect((refresh.data as { notices: string[] }).notices).toEqual([line]);
    await writeLegacy();
    const install = await runRouterInstall({}, ctx(), deps());
    expect(install.humanLines).toContain(`  ${line}`);
  });

  it('is what `tenjin update` moves to the plugin: a refresh registers it', async () => {
    await writeLegacy();
    const result = await runRouterInstall({ refresh: true }, ctx(), deps());
    expect(await fake.calls()).toContain('plugin install tenjin@tenjin --scope user --json');
    expect(result.data).toMatchObject({ refresh: true, migration: { state: 'pending' } });
  });

  it("leaves an x402 server that is not Tenjin's, and the rules beside it", async () => {
    await mkdir(cfg, { recursive: true });
    const settings = `${JSON.stringify({ permissions: { allow: ['mcp__x402__request'] } }, null, 2)}\n`;
    await writeFile(join(cfg, 'settings.json'), settings);
    await writeFile(
      join(cfg, '.claude.json'),
      JSON.stringify({ mcpServers: { x402: { command: 'my-x402', args: [] } } }),
    );
    await fake.respond('list', listed('tenjin@tenjin', pkg.version));
    await runAliveHook({ session_id: 's' }, { dataDir: data, version: pkg.version });
    const result = await runRouterInstall({ refresh: true }, ctx(), deps()).catch(
      (e: unknown) => e,
    );
    expect(result).not.toBeInstanceOf(Error);
    expect(await readFile(join(cfg, 'settings.json'), 'utf8')).toBe(settings);
    expect(await fake.calls()).not.toContain('mcp remove x402 -s user');
    await runRouterUninstall({}, ctx(), { homeDir: home, cwd: work, env: env() });
    expect(await readFile(join(cfg, 'settings.json'), 'utf8')).toBe(settings);
  });

  it('a refresh refuses on a machine with nothing of ours', async () => {
    const out = await runRouterInstall({ refresh: true }, ctx(), deps()).catch((e: unknown) => e);
    expect(out).toBeInstanceOf(CliError);
    expect((out as CliError).message).toContain('Nothing to refresh');
    expect(await fake.calls()).not.toContain('plugin install tenjin@tenjin --scope user --json');
  });
});

describe('tenjin uninstall', () => {
  it('removes the plugin and its marketplace through Claude Code, and the settings install, keeping the wallet', async () => {
    await writeLegacy();
    await writeFile(join(data, 'wallet.json'), '{"keep":true}');
    await runAliveHook({ session_id: 's' }, { dataDir: data, version: pkg.version });
    await fake.respond(
      'mkt-list',
      `${JSON.stringify([{ name: 'tenjin', source: 'directory', path: hosts }])}\n`,
    );
    const result = await runRouterUninstall({}, ctx(), { homeDir: home, cwd: work, env: env() });
    expect(await fake.calls()).toEqual([
      'plugin uninstall tenjin@tenjin --scope user --json',
      'plugin marketplace list --json',
      'plugin marketplace remove tenjin --json',
      'mcp remove x402 -s user',
    ]);
    expect(result.data).toMatchObject({
      plugin: { plugin: 'removed', marketplace: 'removed' },
      settings: { found: true, removed: { allowRule: true, statusLine: 'removed' } },
      aliveRemoved: true,
    });
    expect(await readFile(join(data, 'wallet.json'), 'utf8')).toBe('{"keep":true}');
    expect(await exists(aliveDir(data))).toBe(false);
  });

  it('keeps a marketplace named tenjin that install did not add', async () => {
    await fake.respond(
      'mkt-list',
      `${JSON.stringify([{ name: 'tenjin', source: 'github', repo: 'someone/else' }])}\n`,
    );
    const result = await runRouterUninstall({}, ctx(), { homeDir: home, cwd: work, env: env() });
    expect((await fake.calls()).some((c) => c.startsWith('plugin marketplace remove'))).toBe(false);
    expect(result.data).toMatchObject({ plugin: { marketplace: 'kept' } });
  });

  it('says a bare uninstall left the project install here, with the command that removes it', async () => {
    await mkdir(join(work, '.claude'), { recursive: true });
    await writeFile(
      join(work, '.claude', 'settings.local.json'),
      JSON.stringify({ enabledPlugins: { 'tenjin@tenjin': true } }),
    );
    await fake.respond('uninstall', '{"outcome":"error","failureCode":"not_installed"}\n', 1);
    const result = await runRouterUninstall({}, ctx(), { homeDir: home, cwd: work, env: env() });
    expect(result.data).toMatchObject({
      plugin: { plugin: 'absent' },
      projectInstallLeft: work,
    });
    expect(result.humanLines).toContain(
      'This project has its own Tenjin install, which this left in place; `tenjin uninstall --project` here removes it.',
    );
    const clean = await runRouterUninstall({}, ctx(), { homeDir: home, cwd: root, env: env() });
    expect(clean.data).not.toHaveProperty('projectInstallLeft');
  });

  it("unlinks the plugin folder's listed files and keeps what is not Tenjin's", async () => {
    await runRouterInstall({}, ctx(), deps({ env: env({ PATH: await emptyPath() }) }));
    const folder = join(cfg, 'skills', 'tenjin-router');
    await mkdir(join(folder, 'commands'), { recursive: true });
    await writeFile(join(folder, 'commands', 'mine.md'), 'mine');
    const result = await runRouterUninstall({}, ctx(), {
      homeDir: home,
      cwd: work,
      env: env({ PATH: await emptyPath() }),
    });
    expect(result.data).toMatchObject({
      plugin: { folder: { removed: true, left: ['commands/mine.md'] } },
    });
    expect(await readdir(folder)).toEqual(['commands']);
  });
});

describe('tenjin doctor', () => {
  async function checks(over: Record<string, unknown> = {}) {
    const { runRouterDoctor } = await import('./doctor');
    const out = await runRouterDoctor(ctx(), {
      homeDir: home,
      cwd: work,
      env: env(),
      fetchImpl: probe400,
      listMcpProcesses: async () => [],
      ...over,
    }).catch((e: unknown) => e);
    const list =
      out instanceof CliError
        ? (
            out.details as {
              checks: { name: string; status: string; detail: string; fix?: string }[];
            }
          ).checks
        : (
            out as {
              data: {
                checks: {
                  name: string;
                  status: string;
                  detail: string;
                  fix?: string;
                  checked?: false;
                }[];
              };
            }
          ).data.checks;
    return Object.fromEntries(list.map((c) => [c.name, c]));
  }

  async function snapshot(dir: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const walk = async (current: string): Promise<void> => {
      for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
        const path = join(current, entry.name);
        if (entry.isDirectory()) await walk(path);
        else out[path] = await readFile(path, 'utf8');
      }
    };
    await walk(dir);
    return out;
  }

  it('passes an enabled plugin at this version whose server connects, and writes nothing', async () => {
    await fake.respond('list', listed('tenjin@tenjin', pkg.version));
    await runAliveHook({ session_id: 's' }, { dataDir: data, version: pkg.version });
    await mkdir(cfg, { recursive: true });
    const before = await snapshot(root);
    const c = await checks();
    expect(c['claude code']).toMatchObject({ status: 'ok', detail: '2.1.296' });
    expect(c['plugin']).toMatchObject({
      status: 'ok',
      detail: `tenjin@tenjin ${pkg.version} enabled, and a session has started it`,
    });
    expect(c['router server']).toMatchObject({ status: 'ok' });
    expect(c['settings install']).toBeUndefined();
    const after = await snapshot(root);
    // Only the fake's own logs changed.
    const changed = Object.keys(after).filter(
      (p) => after[p] !== before[p] && !p.includes('fake-claude'),
    );
    expect(changed).toEqual([]);
    expect(
      (await fake.calls()).filter((call) => /add|install|update|remove|enable/.test(call)),
    ).toEqual([]);
  });

  describe('whether a session has started the plugin, with a claude binary present', () => {
    const STAMP_FIX =
      "Start a new Claude Code session and run `tenjin doctor` again: `/reload-plugins` does not run the plugin's `SessionStart`, so only a new session writes the stamp. If it still warns, run `node --version` in that session's shell: Claude Code starts the plugin with the Node on its own PATH, and it must be 22 or newer. Restart Claude Code after installing or updating Node.";
    const NODE_FIX =
      'Claude Code starts the plugin with the `node` on its own PATH, which must be 22 or newer: run `node --version` in the shell it starts from, then restart Claude Code.';
    const INSTALLED = 1_800_000_000_000;
    /** A process list: Claude Code sessions and routers, started at these times. */
    const processes = (claude: number[], routers: { startedAt: number; kind?: string }[] = []) => ({
      installedAt: async () => INSTALLED,
      listProcesses: async () => ({
        claude: claude.map((startedAt, i) => ({ pid: 100 + i, startedAt })),
        routers: routers.map((r, i) => ({
          pid: 200 + i,
          startedAt: r.startedAt,
          kind: r.kind ?? 'plugin',
          underClaude: true,
        })),
      }),
    });

    it('passes as pending when nothing has started since the install', async () => {
      await fake.respond('list', listed('tenjin@tenjin', pkg.version));
      const c = await checks(processes([INSTALLED - 60_000]));
      expect(c['plugin']).toMatchObject({
        status: 'ok',
        detail: `tenjin@tenjin ${pkg.version} enabled; the next Claude Code session starts it`,
      });
      expect(c['router server']).toMatchObject({ status: 'ok' });
    });

    it('warns, with the Node fix, when a Claude Code started since did not start it', async () => {
      await fake.respond('list', listed('tenjin@tenjin', pkg.version));
      await runAliveHook({ session_id: 's' }, { dataDir: data, version: '0.0.1' });
      const c = await checks(processes([INSTALLED + 60_000]));
      expect(c['plugin']).toMatchObject({ status: 'warn', fix: NODE_FIX });
      expect(c['plugin']?.detail).toContain('(last 0.0.1, at ');
    });

    it('passes when a plugin router under Claude Code started since the install', async () => {
      await fake.respond('list', listed('tenjin@tenjin', pkg.version));
      const c = await checks(processes([INSTALLED + 1], [{ startedAt: INSTALLED + 2 }]));
      expect(c['plugin']).toMatchObject({
        status: 'ok',
        detail: `tenjin@tenjin ${pkg.version} enabled, and a session has started it`,
      });
    });

    it('says not checked, never ok, with no stamp and no process list', async () => {
      await fake.respond('list', listed('tenjin@tenjin', pkg.version));
      const c = await checks({ listMcpProcesses: async () => null });
      expect(c['plugin']).toMatchObject({ status: 'warn', checked: false, fix: STAMP_FIX });
    });

    it('passes when a session started this version', async () => {
      await fake.respond('list', listed('tenjin@tenjin', pkg.version));
      await runAliveHook({ session_id: 's' }, { dataDir: data, version: pkg.version });
      const c = await checks(processes([INSTALLED + 60_000]));
      expect(c['plugin']).toMatchObject({
        status: 'ok',
        detail: `tenjin@tenjin ${pkg.version} enabled, and a session has started it`,
      });
    });
  });

  it('fails a machine with no plugin, with the install to run', async () => {
    const c = await checks();
    expect(c['plugin']).toMatchObject({ status: 'fail', fix: 'Run `tenjin install`.' });
  });

  it('checks a project install it finds here without --project', async () => {
    await runRouterInstall(
      { project: true },
      ctx(),
      deps({ env: env({ PATH: await emptyPath() }) }),
    );
    const c = await checks({ env: env({ PATH: await emptyPath() }) });
    expect(c['plugin']?.detail).toContain(join(work, '.claude'));
    // Elsewhere, user scope: no plugin there.
    const away = await checks({ cwd: root, env: env({ PATH: await emptyPath() }) });
    expect(away['plugin']?.status).toBe('fail');
  });

  it('fails a disabled plugin, with the command that enables it at its scope', async () => {
    await fake.respond('list', listed('tenjin@tenjin', pkg.version, false));
    const c = await checks();
    expect(c['plugin']?.status).toBe('fail');
    expect(c['plugin']?.fix).toContain('claude plugin enable tenjin@tenjin --scope user');
  });

  it('names the project a local install was made for, and enables nothing from elsewhere', async () => {
    const other = join(root, 'p');
    await mkdir(other, { recursive: true });
    await fake.respond(
      'list',
      listed('tenjin@tenjin', pkg.version, false, { scope: 'local', projectPath: other }),
    );
    const c = await checks();
    expect(c['plugin']).toMatchObject({
      status: 'fail',
      detail: `tenjin@tenjin is installed for ${other} only, so nothing is routed from ${work}`,
      fix: `To check that install, run \`tenjin doctor\` from ${other}.`,
    });
    for (const check of Object.values(c)) {
      expect(check.fix ?? '', check.name).not.toContain('claude plugin enable');
    }
  });

  it('enables a local install disabled in its own project at its own scope', async () => {
    await fake.respond(
      'list',
      listed('tenjin@tenjin', pkg.version, false, { scope: 'local', projectPath: work }),
    );
    const c = await checks();
    expect(c['plugin']?.status).toBe('fail');
    expect(c['plugin']?.fix).toContain('claude plugin enable tenjin@tenjin --scope local');
  });

  it('warns about a plugin registered at another version', async () => {
    await fake.respond('list', listed('tenjin@tenjin', '0.0.1'));
    const c = await checks();
    expect(c['plugin']).toMatchObject({
      status: 'warn',
      fix: 'Run `tenjin install --refresh` to register this version.',
    });
  });

  it('fails Claude Code below the floor, with `claude update` in the session', async () => {
    await fake.respond('version', '2.1.100 (Claude Code)\n');
    const c = await checks();
    expect(c['claude code']?.status).toBe('fail');
    expect(c['claude code']?.fix).toContain('claude update');
  });

  it('fails a router server that does not connect', async () => {
    await fake.respond('list', listed('tenjin@tenjin', pkg.version));
    await fake.respond('mcp-get', 'plugin:tenjin:router:\n  Status: ✘ Failed to connect\n');
    const c = await checks();
    expect(c['router server']).toMatchObject({ status: 'fail' });
    expect(c['router server']?.detail).toContain('Failed to connect');
  });

  it('reports a pending settings install, and warns rather than fails while it still routes', async () => {
    await writeLegacy();
    const c = await checks();
    expect(c['plugin']?.status).toBe('warn');
    expect(c['settings install']).toMatchObject({ status: 'warn' });
    expect(c['settings install']?.detail).toContain('kept until the plugin loads');
    expect(c['settings install']?.detail).toContain("not Tenjin's and left alone");
  });

  it('checks the folder and its stamp when there is no claude to ask', async () => {
    await runRouterInstall({}, ctx(), deps({ env: env({ PATH: await emptyPath() }) }));
    const c = await checks({ env: env({ PATH: await emptyPath() }) });
    expect(c['claude code']?.status).toBe('warn');
    expect(c['plugin']).toMatchObject({ status: 'ok' });
    expect(c['plugin']?.detail).toContain('the next Claude Code session starts it');
    // With no process list either, it could not check, and says how to load it.
    const unknown = await checks({
      env: env({ PATH: await emptyPath() }),
      listMcpProcesses: async () => null,
    });
    expect(unknown['plugin']).toMatchObject({ status: 'warn', checked: false });
    expect(unknown['plugin']?.fix).toContain('/reload-plugins');
  });

  /** Leaving the session to run a command; restarting Claude Code is not that. */
  const OUT_OF_SESSION = /terminal|by hand/i;

  it('never sends anyone out of the session to fix a check', async () => {
    await writeLegacy();
    await fake.respond('version', '2.1.100 (Claude Code)\n');
    const c = await checks();
    for (const check of Object.values(c)) {
      expect(check.fix ?? '', check.name).not.toMatch(OUT_OF_SESSION);
    }
  });

  it('keeps the plugin and router server fixes inside the session', async () => {
    await fake.respond('list', listed('tenjin@tenjin', pkg.version));
    await fake.respond('mcp-get', 'plugin:tenjin:router:\n  Status: ✘ Failed to connect\n');
    const c = await checks({
      env: env({ CLAUDECODE: '1' }),
      installedAt: async () => 1_000,
      listProcesses: async () => ({ routers: [], claude: [{ pid: 9, startedAt: 2_000 }] }),
    });
    expect(c['plugin']?.detail).toContain('has not started it');
    expect(c['PATH']).toBeUndefined();
    expect(c['router server']?.status).toBe('fail');
    for (const row of ['plugin', 'router server']) {
      expect(c[row]?.fix, row).toMatch(/restart Claude Code/i);
      expect(c[row]?.fix, row).not.toMatch(OUT_OF_SESSION);
    }
  });
});

describe('packageCliEntry', () => {
  it('is the bundle entry beside the running chunk, version-free under pnpm', async () => {
    const { packageCliEntry } = await import('./plugin-registration');
    expect(packageCliEntry(join(root, 'pkg', 'dist'))).toBe(join(root, 'pkg', 'dist', 'index.js'));
    const modules = join(root, 'global', 'node_modules');
    const pinned = join(modules, '.pnpm', 'tenjin-cli@1.0.0', 'node_modules', 'tenjin-cli', 'dist');
    await mkdir(join(modules, 'tenjin-cli', 'dist'), { recursive: true });
    await writeFile(join(modules, 'tenjin-cli', 'dist', 'index.js'), '');
    expect(packageCliEntry(pinned)).toBe(join(modules, 'tenjin-cli', 'dist', 'index.js'));
  });
});
