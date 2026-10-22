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
  DENY_HOOK,
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
} from './plugin-files';

const HOSTS = fileURLToPath(new URL('../../hosts/claude', import.meta.url));

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
  it('are exactly what the renderer writes, file for file', () => {
    const rendered = renderHostFiles();
    expect(filesUnder(HOSTS)).toEqual(Object.keys(rendered).sort());
    for (const [path, body] of Object.entries(rendered)) {
      // Parsed, so prettier's formatting of the checked-in copy is not drift.
      expect(JSON.parse(readFileSync(join(HOSTS, path), 'utf8')), path).toEqual(JSON.parse(body));
    }
  });

  it('list every plugin file the folder fallback and uninstall act on', () => {
    expect(filesUnder(join(HOSTS, PLUGIN_DIR))).toEqual([...PLUGIN_FILES].sort());
    // The manifest is written last, so a crash never leaves it pointing at parts not yet there.
    expect(PLUGIN_FILES.at(-1)).toBe('.claude-plugin/plugin.json');
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
  const files = renderHostFiles('1.2.3', { node, entry, platform: 'linux' });

  it('leaves the package render as it was when no launch is given', () => {
    expect(renderHostFiles('1.2.3', undefined)).toEqual(renderHostFiles('1.2.3'));
    expect(renderPluginFiles('1.2.3', undefined, undefined)).toEqual(renderPluginFiles('1.2.3'));
    expect(Object.keys(renderHostFiles('1.2.3')).some((p) => p.includes('/bin/'))).toBe(false);
    expect(DENY_HOOK.command).toBe('node');
    expect(ALLOW_HOOK.command).toBe('node');
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
      node: winNode,
      entry: winEntry,
      platform: 'win32',
      home,
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
        renderHostFiles('1.2.3', { node: winNode, entry: winEntry, platform: 'win32' }),
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
