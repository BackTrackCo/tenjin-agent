import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  hermesConfigPath,
  hermesPluginDir,
  resolveHermesHome,
  wireHermesIntegration,
  wireHermesMcp,
} from './hermes';
import { CliError } from './errors';

const execFileAsync = promisify(execFile);
let home: string;
let dataDir: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'tenjin-hermes-'));
  dataDir = await mkdtemp(join(tmpdir(), 'tenjin-hermes-data-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

describe('resolveHermesHome', () => {
  it('defaults under HOME and honors an absolute HERMES_HOME', () => {
    expect(resolveHermesHome(home, {})).toBe(join(home, '.hermes'));
    expect(resolveHermesHome(home, { HERMES_HOME: join(home, 'custom') })).toBe(
      join(home, 'custom'),
    );
  });

  it('rejects a relative HERMES_HOME before any write', () => {
    expect(() => resolveHermesHome(home, { HERMES_HOME: 'relative/hermes' })).toThrow(CliError);
  });
});

describe('wireHermesMcp', () => {
  it('creates a private, idempotent MCP config without harness or wallet env coupling', async () => {
    const command = '/opt/tenjin/bin/tenjin';
    expect((await wireHermesMcp(home, false, command)).status).toBe('installed');
    const text = await readFile(hermesConfigPath(home), 'utf8');
    expect(text).toContain(`command: ${JSON.stringify(command)}`);
    expect(text).toContain('args: ["mcp"]');
    expect(text).not.toContain('TENJIN_HARNESS');
    expect((await stat(hermesConfigPath(home))).mode & 0o777).toBe(0o600);
    expect((await wireHermesMcp(home, false, command)).status).toBe('up-to-date');
  });

  it('preserves unrelated YAML while adding one child', async () => {
    await writeFile(
      hermesConfigPath(home),
      [
        'model: llama',
        'mcp_servers:',
        '  github:',
        '    command: "gh-mcp"',
        'theme: dark',
        '',
      ].join('\n'),
    );
    await wireHermesMcp(home, false, '/opt/tenjin');
    const text = await readFile(hermesConfigPath(home), 'utf8');
    expect(text).toContain('  github:\n    command: "gh-mcp"');
    expect(text).toContain('  tenjin:');
    expect(text).toContain('theme: dark');
    expect(text.match(/ {2}tenjin:/g)).toHaveLength(1);
  });

  it.each([
    ['four-space children', 'mcp_servers:\n    github:\n        command: "gh-mcp"\n'],
    ['a sequence', 'mcp_servers:\n  - command: "gh-mcp"\n'],
    ['inline YAML', 'mcp_servers: { github: { command: gh-mcp } }\n'],
  ])('leaves unsupported %s byte-identical', async (_label, yaml) => {
    await writeFile(hermesConfigPath(home), yaml);
    const result = await wireHermesMcp(home, false, '/opt/tenjin');
    expect(result.status).toBe('conflict');
    expect(await readFile(hermesConfigPath(home), 'utf8')).toBe(yaml);
  });

  it('refuses a user-owned Tenjin entry', async () => {
    const yaml = 'mcp_servers:\n  tenjin:\n    command: "custom"\n';
    await writeFile(hermesConfigPath(home), yaml);
    expect((await wireHermesMcp(home, false, '/opt/tenjin')).status).toBe('conflict');
    expect(await readFile(hermesConfigPath(home), 'utf8')).toBe(yaml);
  });

  it('refuses an inline user-owned Tenjin entry without appending a duplicate', async () => {
    const yaml = 'mcp_servers:\n  tenjin: { command: custom }\n';
    await writeFile(hermesConfigPath(home), yaml);
    expect((await wireHermesMcp(home, false, '/opt/tenjin')).status).toBe('conflict');
    expect(await readFile(hermesConfigPath(home), 'utf8')).toBe(yaml);
  });
});

describe('wireHermesIntegration', () => {
  const commands = { tenjinCommand: '/opt/tenjin', nodeCommand: process.execPath };

  it('writes a native plugin, shared scripts, MCP config, and explicit activation', async () => {
    const result = await wireHermesIntegration({
      hermesHome: home,
      dataDir,
      dryRun: false,
      explicit: true,
      ...commands,
    });
    expect(result.activation.status).toBe('installed');
    expect(await readFile(hermesConfigPath(home), 'utf8')).toContain(
      'plugins:\n  enabled:\n    - tenjin',
    );
    const plugin = await readFile(join(hermesPluginDir(home), '__init__.py'), 'utf8');
    expect(plugin).toContain('ctx.register_hook("pre_tool_call"');
    expect(plugin).toContain('ctx.register_hook("transform_tool_result"');
    expect(plugin).toContain('ctx.register_hook("transform_llm_output"');
    await execFileAsync('python3', [
      '-m',
      'py_compile',
      join(hermesPluginDir(home), '__init__.py'),
    ]);
    const probe = [
      'import importlib.util, json, sys',
      'spec = importlib.util.spec_from_file_location("tenjin_plugin", sys.argv[1])',
      'mod = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(mod)',
      'hooks = {}',
      'class Ctx:',
      '    def register_hook(self, name, callback): hooks[name] = callback',
      'mod.register(Ctx())',
      'mod._run = lambda script, payload, timeout: "listing" if script == mod.WEBSEARCH_SCRIPT else "publish"',
      'hooks["pre_tool_call"](tool_name="web_search", args={"query": "q"}, tool_call_id="c1")',
      'tool = hooks["transform_tool_result"](tool_name="web_search", result="web result", tool_call_id="c1")',
      'final = hooks["transform_llm_output"](response_text="answer")',
      'print(json.dumps({"names": sorted(hooks), "tool": tool, "final": final}))',
    ].join('\n');
    const { stdout } = await execFileAsync('python3', [
      '-c',
      probe,
      join(hermesPluginDir(home), '__init__.py'),
    ]);
    expect(JSON.parse(stdout)).toEqual({
      names: ['pre_tool_call', 'transform_llm_output', 'transform_tool_result'],
      tool: 'web result\n\n--- Tenjin marketplace context ---\nlisting\n--- end Tenjin context ---',
      final: 'answer\n\n--- Tenjin publish-back reminder ---\npublish',
    });
    expect(result.plugin.scriptPaths).toHaveLength(2);
  });

  it('keeps auto-detected code inert until explicitly enabled', async () => {
    const result = await wireHermesIntegration({
      hermesHome: home,
      dataDir,
      dryRun: false,
      explicit: false,
      ...commands,
    });
    expect(result.activation.status).toBe('disabled');
    expect(result.activation.warning).toContain('--harness hermes');
    expect(await readFile(hermesConfigPath(home), 'utf8')).not.toContain('plugins:');
  });

  it('never overrides an explicit plugins.disabled entry', async () => {
    await writeFile(hermesConfigPath(home), 'plugins:\n  disabled:\n    - tenjin\n');
    const result = await wireHermesIntegration({
      hermesHome: home,
      dataDir,
      dryRun: false,
      explicit: true,
      ...commands,
    });
    expect(result.activation.status).toBe('disabled');
    expect(await readFile(hermesConfigPath(home), 'utf8')).toContain('disabled:\n    - tenjin');
    expect(await readFile(hermesConfigPath(home), 'utf8')).not.toContain('enabled:');
  });

  it('honors an inline plugins.disabled list too', async () => {
    await writeFile(hermesConfigPath(home), 'plugins:\n  disabled: [tenjin, other]\n');
    const result = await wireHermesIntegration({
      hermesHome: home,
      dataDir,
      dryRun: false,
      explicit: true,
      ...commands,
    });
    expect(result.activation.status).toBe('disabled');
    const text = await readFile(hermesConfigPath(home), 'utf8');
    expect(text).toContain('disabled: [tenjin, other]');
    expect(text).not.toContain('enabled:');
  });

  it('writes nothing on dry-run', async () => {
    const result = await wireHermesIntegration({
      hermesHome: home,
      dataDir,
      dryRun: true,
      explicit: true,
      ...commands,
    });
    expect(result.mcp.status).toBe('would-install');
    expect(result.plugin.status).toBe('would-install');
    expect(result.activation.status).toBe('would-install');
    await expect(readFile(hermesConfigPath(home), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
