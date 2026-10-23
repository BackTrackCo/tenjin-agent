import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hookToolInput } from './hook-tool';
import { PLUGIN_HOOK_TOOL, PLUGIN_SERVER, REQUEST_TOOL } from './names';
import { commandForm, handlersIn, shellDependence } from './hook-form';
import {
  ALIVE_ARGS,
  ALLOW_HOOK,
  cliLaunch,
  DENY_HOOK,
  MOD_FILES,
  PLUGIN_DIR,
  PLUGIN_FILES,
  PLUGIN_ROOT_ENTRY,
  LAUNCHER_MARKER,
  RUNTIME_MISSING_FIX,
  renderHostFiles,
  renderLauncherCmd,
  renderLauncherSh,
  renderMarketplace,
  renderPluginFiles,
  renderPluginHooks,
  renderPluginManifest,
  renderPluginMcp,
  type ExecLaunch,
  CODEX_ALLOW_HOOK_COMMAND,
  CODEX_ALLOW_HOOK_COMMAND_WINDOWS,
  renderCodexHooks,
  renderCodexHostFiles,
  renderCodexManifest,
  renderCodexMarketplace,
  renderCodexMcp,
  codexHookCommand,
  renderPluginBin,
  type CodexRuntime,
  type ModSources,
} from './plugin-files';
import { readModSources } from './plugin-folder';

const HOSTS = fileURLToPath(new URL('../../hosts/claude', import.meta.url));

/**
 * Not shipped: the mod's tests (`claude plugin test`), and what Claude Code
 * writes beside a mod it loads from this folder (its API types and a
 * tsconfig extending them), which the folder's `.gitignore` keeps out.
 */
const NOT_SHIPPED = /^(\.gitignore$|tenjin\/(tests\/|\.claude-plugin\/types\/|tsconfig\.json$))/;

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.push(relative(dir, path).split(sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

/** The mod as written, from the checked-in plugin folder. */
async function checkedInMod(): Promise<ModSources> {
  const mod = await readModSources(join(HOSTS, PLUGIN_DIR));
  if (mod === undefined) throw new Error('the checked-in plugin folder carries no mod');
  return mod;
}

/** One routing leg as the plugin carries it. */
const leg = (kind: Parameters<typeof hookToolInput>[0], timeout = 5) => [
  {
    type: 'mcp_tool',
    server: 'plugin:tenjin:router',
    tool: 'hook',
    input: hookToolInput(kind),
    timeout,
  },
];
const command = (launch: ExecLaunch) => [{ type: 'command', ...launch, timeout: 5 }];

describe('the checked-in hosts/claude templates', () => {
  it('are exactly what the renderer writes, file for file', async () => {
    const rendered = renderHostFiles(undefined, { mod: await checkedInMod() });
    const shipped = filesUnder(HOSTS).filter((path) => !NOT_SHIPPED.test(path));
    expect(shipped).toEqual(Object.keys(rendered).sort());
    for (const [path, body] of Object.entries(rendered)) {
      const checkedIn = readFileSync(join(HOSTS, path), 'utf8');
      // JSON is parsed, so prettier's formatting of the checked-in copy is not
      // drift; the mod's own files and the skill ship as written.
      if (path.endsWith('.json')) expect(JSON.parse(checkedIn), path).toEqual(JSON.parse(body));
      else expect(checkedIn, path).toBe(body);
    }
  });

  it('list every plugin file the folder fallback and uninstall act on', () => {
    const shipped = filesUnder(join(HOSTS, PLUGIN_DIR)).filter(
      (path) => !NOT_SHIPPED.test(`tenjin/${path}`),
    );
    expect(shipped).toEqual([...PLUGIN_FILES].sort());
    for (const path of MOD_FILES) expect(PLUGIN_FILES).toContain(path);
    // The module and its contract land before the hooks file that names them,
    // and the manifest last, so a crash never leaves a part named but not there.
    expect(PLUGIN_FILES.indexOf('hooks/register.tsx')).toBeLessThan(
      PLUGIN_FILES.indexOf('hooks/hooks.json'),
    );
    expect(PLUGIN_FILES.at(-1)).toBe('.claude-plugin/plugin.json');
  });
});

describe('the mod', () => {
  it('is named by the hooks file and its contract by the manifest, only when shipped', async () => {
    const mod = await checkedInMod();
    const withMod = renderPluginFiles('1.2.3', undefined, { mod });
    expect(JSON.parse(withMod['hooks/hooks.json']!)).toMatchObject({
      modules: ['./register.tsx'],
    });
    expect(JSON.parse(withMod['.claude-plugin/plugin.json']!)).toMatchObject({
      types: './types/index.d.ts',
    });
    expect(withMod['hooks/register.tsx']).toBe(mod['hooks/register.tsx']);
    // A folder written without the mod's sources names no module that is not there.
    const bare = renderPluginFiles('1.2.3');
    expect(Object.keys(bare)).not.toContain('hooks/register.tsx');
    expect(JSON.parse(bare['hooks/hooks.json']!)).not.toHaveProperty('modules');
    expect(JSON.parse(bare['.claude-plugin/plugin.json']!)).not.toHaveProperty('types');
  });

  it('hooks our request tool by its plugin name and writes nothing under the data dir', async () => {
    const source = (await checkedInMod())['hooks/register.tsx'];
    expect(source).toContain(`const REQUEST_TOOL = '${REQUEST_TOOL}';`);
    // Reads only: the module never calls a write, a process or a config change.
    expect(source).not.toMatch(
      /\$\.fs\.(write|mkdir|rm|unlink)|\$\.process\.|\$\.config\.set|\$\.settings/,
    );
    expect(source).not.toMatch(/on\('prompt\.(submit|compose)'/);
  });
});

describe("the plugin's hooks", () => {
  it('carry the seven routing legs as mcp_tool calls on the plugin server, with the same inputs and timeouts', () => {
    const { hooks } = renderPluginHooks();
    expect(hooks.UserPromptSubmit).toEqual([{ hooks: leg('prompt') }]);
    expect(hooks.PreToolUse).toEqual([
      { matcher: 'WebSearch|WebFetch', hooks: leg('native') },
      { matcher: 'Agent|Task', hooks: leg('agent') },
      { matcher: 'AskUserQuestion', hooks: leg('ask') },
      { matcher: 'mcp__plugin_tenjin_router__hook', hooks: command(DENY_HOOK) },
      { matcher: 'mcp__plugin_tenjin_router__request', hooks: command(ALLOW_HOOK) },
    ]);
    expect(hooks.PostToolUse).toEqual([
      { matcher: 'WebSearch|WebFetch', hooks: leg('shortfall', 15) },
      { matcher: 'AskUserQuestion', hooks: leg('answer') },
    ]);
    expect(hooks.PostToolUseFailure).toEqual([
      { matcher: 'WebSearch|WebFetch', hooks: leg('shortfall', 15) },
    ]);
    expect(PLUGIN_SERVER).toBe('plugin:tenjin:router');
  });

  it('carry the alive leg as a SessionStart command with no matcher, run by node from the entry', () => {
    expect(renderPluginHooks().hooks.SessionStart).toEqual([
      { hooks: command({ command: 'node', args: [PLUGIN_ROOT_ENTRY, 'hook', 'alive'] }) },
    ]);
    expect(ALIVE_ARGS).toEqual(['hook', 'alive']);
    expect(PLUGIN_ROOT_ENTRY).toBe('${CLAUDE_PLUGIN_ROOT}/../../../index.js');
  });

  it('deny the hook tool to the model and allow the request tool, spawned with no shell', () => {
    // No stdin: the command never reads its event, and on Linux a child that
    // exits before Node writes the event fails the write with EPIPE.
    const answer = ({ command: file, args }: ExecLaunch) =>
      JSON.parse(
        execFileSync(file, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }),
      ) as {
        hookSpecificOutput: Record<string, string>;
      };
    expect(answer(DENY_HOOK).hookSpecificOutput).toEqual({
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `Only the Tenjin hooks call this tool. To make a lookup, call ${REQUEST_TOOL}.`,
    });
    expect(answer(ALLOW_HOOK).hookSpecificOutput).toMatchObject({
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
    });
    expect(PLUGIN_HOOK_TOOL).toBe('mcp__plugin_tenjin_router__hook');
    expect(REQUEST_TOOL).toBe('mcp__plugin_tenjin_router__request');
  });

  it('never name x402 anywhere the plugin shows', () => {
    // The mod's source names it in comments and in its own test of what a
    // surface may never draw; its surfaces are pinned by `claude plugin test`.
    expect(JSON.stringify(renderHostFiles('1.2.3'))).not.toMatch(/x402/i);
  });
});

describe("the plugin's server", () => {
  it('runs the CLI entry under node with a command line of its own, so Claude Code does not suppress it', () => {
    // A settings install registered `tenjin mcp`; Claude Code drops a plugin
    // server whose command and arguments match a configured one.
    expect(renderPluginMcp()).toEqual({
      mcpServers: {
        router: { command: 'node', args: [PLUGIN_ROOT_ENTRY, 'mcp', '--plugin'] },
      },
    });
    expect(renderPluginMcp('/opt/tenjin-cli/dist/index.js')).toEqual({
      mcpServers: {
        router: { command: 'node', args: ['/opt/tenjin-cli/dist/index.js', 'mcp', '--plugin'] },
      },
    });
  });
});

/**
 * NO SHELL ANYWHERE, so Windows runs the files macOS and Linux run: every
 * command hook and the server are exec form, and none names the `tenjin` shim.
 */
describe('every command the plugin carries', () => {
  const rendered = {
    template: Object.fromEntries(
      PLUGIN_FILES.map((p) => [p, readFileSync(join(HOSTS, PLUGIN_DIR, p), 'utf8')]),
    ),
    shipped: renderPluginFiles('1.2.3'),
    folder: renderPluginFiles('1.2.3', 'C:\\Users\\me\\tenjin-cli\\dist\\index.js'),
  };

  for (const [name, files] of Object.entries(rendered)) {
    it(`runs with no shell in the ${name} render`, () => {
      const hooks = JSON.parse(files['hooks/hooks.json']!) as unknown;
      const commands = handlersIn(hooks).filter((h) => commandForm(h) !== null);
      expect(commands).toHaveLength(3);
      for (const handler of commands) {
        expect(commandForm(handler)).toBe('exec');
        expect(shellDependence(handler)).toBeNull();
      }
      const { mcpServers } = JSON.parse(files['.mcp.json']!) as {
        mcpServers: Record<string, unknown>;
      };
      for (const server of Object.values(mcpServers)) expect(shellDependence(server)).toBeNull();
      expect(`${files['hooks/hooks.json']}${files['.mcp.json']}`).not.toMatch(/"tenjin(\.cmd)?"/);
    });
  }
});

/**
 * THE RUNTIME RENDER: the same plugin, with every command naming the runtime's
 * absolute Node and entry, and the `bin/` launchers beside it.
 */
describe('the runtime render', () => {
  const node = '/h/Jane Doe/.tenjin/runtime/node/24.0.0/bin/node';
  const entry = '/h/Jane Doe/.tenjin/runtime/versions/1.2.3/dist/index.js';
  const files = renderHostFiles('1.2.3', { launch: { node, entry, platform: 'linux' } });

  it('leaves the package render as it was when no launch is given', () => {
    expect(renderHostFiles('1.2.3', {})).toEqual(renderHostFiles('1.2.3'));
    expect(renderPluginFiles('1.2.3', undefined, {})).toEqual(renderPluginFiles('1.2.3'));
    expect(Object.keys(renderHostFiles('1.2.3')).some((p) => p.includes('/bin/'))).toBe(false);
    expect(DENY_HOOK.command).toBe('node');
    expect(ALLOW_HOOK.command).toBe('node');
  });

  /** One trailing options object, so another render option joins it rather than a new position. */
  it('takes the Node as an option of the last argument, on every render', () => {
    const folder = renderPluginFiles('1.2.3', entry, { node });
    expect(JSON.parse(folder['hooks/hooks.json']!)).toEqual(renderPluginHooks(entry, { node }));
    expect(JSON.parse(folder['.mcp.json']!)).toEqual(renderPluginMcp(entry, { node }));
    expect(cliLaunch(['hook', 'alive'], entry, { node })).toEqual({
      command: node,
      args: [entry, 'hook', 'alive'],
    });
    for (const [path, body] of Object.entries(folder)) {
      expect(files[`${PLUGIN_DIR}/${path}`], path).toBe(body);
    }
  });

  it('runs every command with the absolute node, the permission answers included', () => {
    const hooks = JSON.parse(files[`${PLUGIN_DIR}/hooks/hooks.json`]!) as unknown;
    const commands = handlersIn(hooks).filter((h) => commandForm(h) !== null) as ExecLaunch[];
    expect(commands).toHaveLength(3);
    for (const handler of commands) {
      expect(handler.command).toBe(node);
      expect(shellDependence(handler)).toBeNull();
    }
    expect(commands[0]!.args).toEqual([entry, 'hook', 'alive']);
    const mcp = JSON.parse(files[`${PLUGIN_DIR}/.mcp.json`]!) as {
      mcpServers: { router: ExecLaunch };
    };
    expect(mcp.mcpServers.router).toEqual({ command: node, args: [entry, 'mcp', '--plugin'] });
    expect(shellDependence(mcp.mcpServers.router)).toBeNull();
    const text = Object.values(files).join('');
    expect(text).not.toContain('${CLAUDE_PLUGIN_ROOT}');
    expect(text).not.toMatch(/"command": "node"/);
  });

  it('keeps every other byte of the package render', () => {
    const swap = (body: string) =>
      body.replaceAll(JSON.stringify(node), '"node"').replaceAll(entry, PLUGIN_ROOT_ENTRY);
    const plain = renderHostFiles('1.2.3');
    for (const [path, body] of Object.entries(plain)) expect(swap(files[path]!), path).toBe(body);
  });

  it('carries the mod as the package render does, beside the absolute Node', async () => {
    const mod = await checkedInMod();
    const withMod = renderHostFiles('1.2.3', { launch: { node, entry, platform: 'linux' }, mod });
    const swap = (body: string) =>
      body.replaceAll(JSON.stringify(node), '"node"').replaceAll(entry, PLUGIN_ROOT_ENTRY);
    const plain = renderHostFiles('1.2.3', { mod });
    expect(plain[`${PLUGIN_DIR}/hooks/register.tsx`]).toBe(mod['hooks/register.tsx']);
    for (const [path, body] of Object.entries(plain)) expect(swap(withMod[path]!), path).toBe(body);
    expect(withMod[`${PLUGIN_DIR}/bin/tenjin`]).toBe(files[`${PLUGIN_DIR}/bin/tenjin`]);
  });

  it('carries the sh launcher in bin/ and no .cmd off Windows', () => {
    expect(files[`${PLUGIN_DIR}/bin/tenjin`]).toBe(renderLauncherSh({ node, entry }));
    expect(files[`${PLUGIN_DIR}/bin/tenjin.cmd`]).toBeUndefined();
  });

  it('writes the sh launcher with both paths quoted and the missing-runtime sentence', () => {
    const sh = renderLauncherSh({ node: "/h/o'b/node", entry: '/h/e.js', platform: 'linux' });
    expect(sh.split('\n')).toEqual([
      '#!/bin/sh',
      `# ${LAUNCHER_MARKER}`,
      `node='/h/o'\\''b/node'`,
      `entry='/h/e.js'`,
      'if [ -x "$node" ] && [ -f "$entry" ]; then exec "$node" "$entry" "$@"; fi',
      `echo "tenjin: Tenjin's runtime is missing ($entry). Reinstall it with \\\`${RUNTIME_MISSING_FIX}\\\`, then start a new Claude Code session." >&2`,
      'exit 1',
      '',
    ]);
  });

  describe('on win32', () => {
    const home = 'C:\\Users\\Zoë';
    const winNode = `${home}\\.tenjin\\runtime\\node\\24.0.0\\node.exe`;
    const winEntry = `${home}\\.tenjin\\runtime\\versions\\1.2.3\\dist\\index.js`;
    const win = renderHostFiles('1.2.3', {
      launch: { node: winNode, entry: winEntry, platform: 'win32', home },
    });

    it('runs node.exe and carries a CRLF, ASCII .cmd built from %USERPROFILE%', () => {
      const mcp = JSON.parse(win[`${PLUGIN_DIR}/.mcp.json`]!) as {
        mcpServers: { router: ExecLaunch };
      };
      expect(mcp.mcpServers.router.command).toBe(winNode);
      expect(shellDependence(mcp.mcpServers.router)).toBeNull();
      const cmd = win[`${PLUGIN_DIR}/bin/tenjin.cmd`]!;
      expect([...cmd].every((c) => c.charCodeAt(0) < 0x80)).toBe(true);
      const lines = cmd.split('\r\n');
      expect(lines.join('')).not.toContain('\n');
      expect(lines).toEqual([
        '@echo off',
        `rem ${LAUNCHER_MARKER}`,
        'if exist "%USERPROFILE%\\.tenjin\\runtime\\node\\24.0.0\\node.exe" if exist "%USERPROFILE%\\.tenjin\\runtime\\versions\\1.2.3\\dist\\index.js" ( "%USERPROFILE%\\.tenjin\\runtime\\node\\24.0.0\\node.exe" "%USERPROFILE%\\.tenjin\\runtime\\versions\\1.2.3\\dist\\index.js" %* & exit /b )',
        `echo tenjin: Tenjin's runtime is missing (%USERPROFILE%\\.tenjin\\runtime\\versions\\1.2.3\\dist\\index.js). Reinstall it with \`${RUNTIME_MISSING_FIX}\`, then start a new Claude Code session. 1>&2`,
        'exit /b 1',
        '',
      ]);
      const paths = cmd.match(/%USERPROFILE%[^"\s)]*/g)!;
      for (const p of paths) expect(p.startsWith('%USERPROFILE%\\.tenjin\\runtime\\')).toBe(true);
    });

    it('writes the sh launcher with forward slashes for Git Bash', () => {
      const sh = win[`${PLUGIN_DIR}/bin/tenjin`]!;
      expect(sh).toContain(`node='C:/Users/Zoë/.tenjin/runtime/node/24.0.0/node.exe'`);
      expect(sh).toContain(`entry='C:/Users/Zoë/.tenjin/runtime/versions/1.2.3/dist/index.js'`);
    });

    it('refuses a path with % or ", one outside home, and a launch with no home', () => {
      const launch = { node: winNode, entry: winEntry, platform: 'win32' as const, home };
      expect(() => renderLauncherCmd({ ...launch, entry: `${home}\\100%\\index.js` })).toThrow();
      expect(() => renderLauncherCmd({ ...launch, entry: `${home}\\a"b\\index.js` })).toThrow();
      expect(() => renderLauncherCmd({ ...launch, entry: `${home}\\é\\index.js` })).toThrow();
      expect(() => renderLauncherCmd({ ...launch, node: 'D:\\node\\node.exe' })).toThrow();
      expect(() => renderLauncherCmd({ ...launch, node: 'C:\\Users\\Zoëx\\node.exe' })).toThrow();
      expect(() =>
        renderHostFiles('1.2.3', { launch: { node: winNode, entry: winEntry, platform: 'win32' } }),
      ).toThrow();
    });
  });
});

describe('the manifest and the marketplace', () => {
  it('stamp the CLI version at build time and carry the ownership marker', () => {
    expect(renderPluginManifest('1.2.3')).toMatchObject({
      name: 'tenjin',
      version: '1.2.3',
      metadata: { 'tenjin-cli': '1.2.3' },
    });
    expect(renderPluginManifest()).not.toHaveProperty('version');
    expect(renderMarketplace('1.2.3')).toMatchObject({
      name: 'tenjin',
      plugins: [{ name: 'tenjin', source: './tenjin', version: '1.2.3' }],
    });
  });
});

const CODEX_HOSTS = fileURLToPath(new URL('../../hosts/codex', import.meta.url));

describe('the checked-in hosts/codex templates', () => {
  it('are exactly what the renderer writes, file for file', () => {
    const rendered = renderCodexHostFiles();
    expect(filesUnder(CODEX_HOSTS)).toEqual(Object.keys(rendered).sort());
    for (const [path, body] of Object.entries(rendered)) {
      expect(JSON.parse(readFileSync(join(CODEX_HOSTS, path), 'utf8')), path).toEqual(
        JSON.parse(body),
      );
    }
  });

  it('carry the prompt leg, one web search before and after, and the request tool allow', () => {
    const { hooks } = renderCodexHooks();
    const cmd = (kind: string, timeout = 5) => [
      { type: 'command', command: `tenjin hook ${kind} --harness codex`, timeout },
    ];
    expect(hooks).toEqual({
      UserPromptSubmit: [{ hooks: cmd('prompt') }],
      PreToolUse: [{ matcher: 'webrun', hooks: cmd('native') }],
      PostToolUse: [{ matcher: 'webrun', hooks: cmd('shortfall', 15) }],
      PermissionRequest: [
        {
          matcher: 'mcp__router__request',
          hooks: [
            {
              type: 'command',
              command: CODEX_ALLOW_HOOK_COMMAND,
              commandWindows: CODEX_ALLOW_HOOK_COMMAND_WINDOWS,
              timeout: 5,
            },
          ],
        },
      ],
    });
  });

  it('allows the request tool with the static answer Codex documents for PermissionRequest', () => {
    expect(CODEX_ALLOW_HOOK_COMMAND).toBe(
      `echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'`,
    );
  });

  it('gives cmd.exe a bare echo, whose output is the same JSON answer', () => {
    const answer = {
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    };
    // Codex runs it as `cmd.exe /C "<command>"`; cmd's echo prints the rest of the line as is.
    expect(CODEX_ALLOW_HOOK_COMMAND_WINDOWS.startsWith('echo ')).toBe(true);
    const printed = CODEX_ALLOW_HOOK_COMMAND_WINDOWS.slice('echo '.length);
    expect(JSON.parse(printed)).toEqual(answer);
    expect(printed).not.toMatch(/[&|<>^%'!]/);
  });

  it("names #25's plugin and server, starts the server as Codex's, and never names x402", () => {
    expect(renderCodexMcp()).toEqual({
      mcpServers: { router: { command: 'tenjin', args: ['mcp', '--harness', 'codex'] } },
    });
    expect(renderCodexMarketplace()).toMatchObject({
      name: 'tenjin',
      plugins: [{ name: 'tenjin', source: { source: 'local', path: './tenjin' } }],
    });
    expect(JSON.stringify(renderCodexHostFiles())).not.toMatch(/x402/i);
  });

  it('carries no version, so every build ships the same bytes and hook trust holds', () => {
    const manifest = JSON.parse(renderCodexHostFiles()['tenjin/.codex-plugin/plugin.json']!);
    expect(manifest).toMatchObject({ name: 'tenjin', mcpServers: './.mcp.json' });
    expect(manifest).not.toHaveProperty('version');
    expect(renderCodexManifest()).not.toHaveProperty('version');
  });
});

/**
 * THE CODEX RUNTIME RENDER: every leg and the server run the launcher in the
 * runtime's own `bin/` by absolute path, so the hooks Codex trusts stay the
 * same bytes across updates.
 */
describe('the Codex runtime render', () => {
  const binDir = "/h/Jane O'Doe/.tenjin/runtime/codex/tenjin/bin";
  const at = (cli: string): CodexRuntime => ({
    launch: {
      node: '/h/n/node',
      entry: `/h/.tenjin/runtime/versions/${cli}/dist/index.js`,
      platform: 'linux',
    },
    binDir,
  });
  const files = renderCodexHostFiles(at('1.2.3'));
  const quoted = `'/h/Jane O'\\''Doe/.tenjin/runtime/codex/tenjin/bin/tenjin'`;

  it('runs each leg through the quoted launcher and keeps the allow hook', () => {
    const { hooks } = JSON.parse(files['tenjin/hooks/hooks.json']!) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>;
    };
    expect(hooks.UserPromptSubmit![0]!.hooks[0]!.command).toBe(
      `${quoted} hook prompt --harness codex`,
    );
    expect(hooks.PreToolUse![0]!.hooks[0]!.command).toBe(`${quoted} hook native --harness codex`);
    expect(hooks.PostToolUse![0]!.hooks[0]!.command).toBe(
      `${quoted} hook shortfall --harness codex`,
    );
    expect(hooks.PermissionRequest).toEqual(renderCodexHooks().hooks.PermissionRequest);
    for (const event of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse']) {
      expect(hooks[event]![0]!.hooks[0], event).not.toHaveProperty('commandWindows');
    }
    // sh reads the quoted word back as the path itself.
    if (process.platform !== 'win32') {
      const echoed = execFileSync('sh', ['-c', `printf %s ${quoted}`], { encoding: 'utf8' });
      expect(echoed).toBe(`${binDir}/tenjin`);
    }
  });

  it('starts the server as the launcher and carries the launchers in bin/', () => {
    expect(JSON.parse(files['tenjin/.mcp.json']!)).toEqual({
      mcpServers: { router: { command: `${binDir}/tenjin`, args: ['mcp', '--harness', 'codex'] } },
    });
    expect(files['tenjin/bin/tenjin']).toBe(renderPluginBin(at('1.2.3').launch)['bin/tenjin']);
    const plain = renderCodexHostFiles();
    for (const path of ['.agents/plugins/marketplace.json', 'tenjin/.codex-plugin/plugin.json']) {
      expect(files[path], path).toBe(plain[path]);
    }
  });

  it('keeps the hooks and the server the same bytes from one version to the next', () => {
    const next = renderCodexHostFiles(at('1.3.0'));
    expect(next['tenjin/hooks/hooks.json']).toBe(files['tenjin/hooks/hooks.json']);
    expect(next['tenjin/.mcp.json']).toBe(files['tenjin/.mcp.json']);
    expect(next['tenjin/bin/tenjin']).not.toBe(files['tenjin/bin/tenjin']);
  });

  it('leaves the package render as it was', () => {
    expect(codexHookCommand('prompt')).toBe('tenjin hook prompt --harness codex');
    expect(Object.keys(renderCodexHostFiles()).some((p) => p.includes('/bin/'))).toBe(false);
  });

  describe('on win32', () => {
    const home = 'C:\\Users\\Zoë Doe';
    const win: CodexRuntime = {
      launch: {
        node: `${home}\\.tenjin\\runtime\\node\\24.0.0\\node.exe`,
        entry: `${home}\\.tenjin\\runtime\\versions\\1.2.3\\dist\\index.js`,
        platform: 'win32',
        home,
      },
      binDir: `${home}\\.tenjin\\runtime\\codex\\tenjin\\bin`,
    };

    it('gives cmd the .cmd launcher from %USERPROFILE%, and the server its absolute path', () => {
      const rendered = renderCodexHostFiles(win);
      const { hooks } = JSON.parse(rendered['tenjin/hooks/hooks.json']!) as {
        hooks: Record<string, { hooks: { command: string; commandWindows?: string }[] }[]>;
      };
      expect(hooks.UserPromptSubmit![0]!.hooks[0]).toMatchObject({
        command: `'C:/Users/Zoë Doe/.tenjin/runtime/codex/tenjin/bin/tenjin' hook prompt --harness codex`,
        commandWindows:
          '"%USERPROFILE%\\.tenjin\\runtime\\codex\\tenjin\\bin\\tenjin.cmd" hook prompt --harness codex',
      });
      for (const leg of [...hooks.PreToolUse!, ...hooks.PostToolUse!]) {
        const windows = leg.hooks[0]!.commandWindows!;
        expect(windows.split('"')).toHaveLength(3);
        expect([...windows].every((c) => c.charCodeAt(0) < 0x80)).toBe(true);
      }
      expect(hooks.PermissionRequest).toEqual(renderCodexHooks().hooks.PermissionRequest);
      expect(JSON.parse(rendered['tenjin/.mcp.json']!)).toEqual({
        mcpServers: {
          router: { command: `${win.binDir}\\tenjin.cmd`, args: ['mcp', '--harness', 'codex'] },
        },
      });
      expect(rendered['tenjin/bin/tenjin.cmd']).toBe(renderPluginBin(win.launch)['bin/tenjin.cmd']);
    });

    it('refuses a launcher folder cmd cannot carry, as the .cmd launcher does', () => {
      expect(() => renderCodexHooks({ ...win, binDir: `${home}\\é\\tenjin\\bin` })).toThrow();
      expect(() => renderCodexHooks({ ...win, binDir: 'D:\\tenjin\\bin' })).toThrow();
    });
  });
});
