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
  MOD_FILES,
  PLUGIN_DIR,
  PLUGIN_FILES,
  renderHostFiles,
  renderMarketplace,
  renderPluginFiles,
  renderPluginHooks,
  renderPluginManifest,
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
const command = (text: string) => [{ type: 'command', command: text, timeout: 5 }];

describe('the checked-in hosts/claude templates', () => {
  it('are exactly what the renderer writes, file for file', async () => {
    const rendered = renderHostFiles(undefined, await checkedInMod());
    const shipped = filesUnder(HOSTS).filter((path) => !NOT_SHIPPED.test(path));
    expect(shipped).toEqual(Object.keys(rendered).sort());
    for (const [path, body] of Object.entries(rendered)) {
      const checkedIn = readFileSync(join(HOSTS, path), 'utf8');
      // Parsed, so prettier's formatting of the checked-in copy is not drift;
      // the mod's own files ship as written.
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
    const withMod = renderPluginFiles('1.2.3', mod);
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
    // The mod's source names it in comments and in its own test of what a
    // surface may never draw; its surfaces are pinned by `claude plugin test`.
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
