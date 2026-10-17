import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hookToolInput } from './hook-tool';
import { PLUGIN_HOOK_TOOL, PLUGIN_SERVER, REQUEST_TOOL } from './names';
import {
  ALIVE_COMMAND,
  ALLOW_HOOK_COMMAND,
  DENY_HOOK_COMMAND,
  PLUGIN_DIR,
  PLUGIN_FILES,
  renderHostFiles,
  renderMarketplace,
  renderPluginHooks,
  renderPluginManifest,
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
const command = (text: string) => [{ type: 'command', command: text, timeout: 5 }];

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
      { matcher: 'mcp__plugin_tenjin_router__hook', hooks: command(DENY_HOOK_COMMAND) },
      { matcher: 'mcp__plugin_tenjin_router__request', hooks: command(ALLOW_HOOK_COMMAND) },
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

  it('carry the alive leg as a SessionStart command with no matcher', () => {
    expect(renderPluginHooks().hooks.SessionStart).toEqual([{ hooks: command(ALIVE_COMMAND) }]);
    expect(ALIVE_COMMAND).toBe('tenjin hook alive');
  });

  it('deny the hook tool to the model and allow the request tool, as static answers', () => {
    // No stdin: the command never reads its event, and on Linux a child that
    // exits before Node writes the event fails the write with EPIPE.
    const answer = (cmd: string) =>
      JSON.parse(
        execFileSync('sh', ['-c', cmd], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }),
      ) as {
        hookSpecificOutput: Record<string, string>;
      };
    expect(answer(DENY_HOOK_COMMAND).hookSpecificOutput).toEqual({
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `Only the Tenjin hooks call this tool. To make a lookup, call ${REQUEST_TOOL}.`,
    });
    expect(answer(ALLOW_HOOK_COMMAND).hookSpecificOutput).toMatchObject({
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
  it('runs the CLI on PATH with a command line of its own, so Claude Code does not suppress it', async () => {
    const { renderPluginMcp } = await import('./plugin-files');
    // A settings install registered `tenjin mcp`; Claude Code drops a plugin
    // server whose command and arguments match a configured one.
    expect(renderPluginMcp()).toEqual({
      mcpServers: { router: { command: 'tenjin', args: ['mcp', '--plugin'] } },
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

  it('carry the prompt leg and one web search before and after, as command hooks', () => {
    const { hooks } = renderCodexHooks();
    const cmd = (kind: string, timeout = 5) => [
      { type: 'command', command: `tenjin hook ${kind} --harness codex`, timeout },
    ];
    expect(hooks).toEqual({
      UserPromptSubmit: [{ hooks: cmd('prompt') }],
      PreToolUse: [{ matcher: 'webrun', hooks: cmd('native') }],
      PostToolUse: [{ matcher: 'webrun', hooks: cmd('shortfall', 15) }],
    });
  });

  it("names #25's plugin and server, starts the server as Codex's, and never names x402", () => {
    expect(renderCodexMcp()).toEqual({
      mcpServers: { router: { command: 'tenjin', args: ['mcp', '--harness', 'codex'] } },
    });
    expect(renderCodexMarketplace()).toMatchObject({
      name: 'tenjin',
      plugins: [{ name: 'tenjin', source: { source: 'local', path: './tenjin' } }],
    });
    expect(JSON.stringify(renderCodexHostFiles('1.2.3'))).not.toMatch(/x402/i);
  });

  it('stamps the CLI version into the manifest and keeps the hooks free of it', () => {
    const files = renderCodexHostFiles('1.2.3');
    expect(JSON.parse(files['tenjin/.codex-plugin/plugin.json']!)).toMatchObject({
      name: 'tenjin',
      version: '1.2.3',
      mcpServers: './.mcp.json',
    });
    expect(renderCodexManifest()).not.toHaveProperty('version');
    // Codex trusts a hook by its hash: an update must not change these bytes.
    expect(files['tenjin/hooks/hooks.json']).toBe(
      renderCodexHostFiles('9.9.9')['tenjin/hooks/hooks.json'],
    );
  });
});
