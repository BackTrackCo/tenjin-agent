import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  HERMES_PLUGIN_MANIFEST,
  HERMES_WEB_SEARCH_TOOL,
  hermesConfigPath,
  hermesPluginDir,
  readHermesIntegrationStatus,
  resolveHermesHome,
  resolveHermesHomeLenient,
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

  // Doctor is the command you reach for when something is already broken, so a
  // stray env var belonging to another tool must not take it down before a single
  // check runs. Only a run that explicitly targeted Hermes gets the refusal.
  it('the lenient resolver warns and falls back instead of throwing', () => {
    const resolved = resolveHermesHomeLenient(home, { HERMES_HOME: 'relative/hermes' });
    expect(resolved.home).toBe(join(home, '.hermes'));
    expect(resolved.warning).toContain('relative/hermes');
    expect(resolveHermesHomeLenient(home, {}).warning).toBeUndefined();
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

  // `command` is `process.argv[1]`, so an nvm switch, a pnpm-vs-npm global, or a
  // project-local install re-points on the next run. Nothing covered re-point at
  // all before: the preservation test above only exercised first insertion.
  describe('re-pointing an entry this CLI owns', () => {
    it('replaces the block in place instead of stacking marker comments', async () => {
      await wireHermesMcp(home, false, '/old/tenjin');
      expect((await wireHermesMcp(home, false, '/new/tenjin')).status).toBe('installed');
      const text = await readFile(hermesConfigPath(home), 'utf8');
      expect(text.match(/tenjin-cli:hermes-mcp/g)).toHaveLength(1);
      expect(text.match(/ {2}tenjin:/g)).toHaveLength(1);
      expect(text).toContain('command: "/new/tenjin"');
      expect(text).not.toContain('/old/tenjin');
    });

    it('leaves a following comment and blank line where the operator put them', async () => {
      await writeFile(
        hermesConfigPath(home),
        [
          'mcp_servers:',
          '  # tenjin-cli:hermes-mcp',
          '  tenjin:',
          '    command: "/old/tenjin"',
          '    args: ["mcp"]',
          '',
          '  # the notes app, no colon in this line',
          '  notes:',
          '    command: "notes-mcp"',
          '',
        ].join('\n'),
      );
      await wireHermesMcp(home, false, '/new/tenjin');
      const text = await readFile(hermesConfigPath(home), 'utf8');
      expect(text).toContain('  # the notes app, no colon in this line\n  notes:');
      expect(text).toContain('command: "notes-mcp"');
      expect(text.match(/tenjin-cli:hermes-mcp/g)).toHaveLength(1);
      // The whole diff is the one command line.
      expect(text.split('\n').filter((l) => l.includes('/old/tenjin'))).toEqual([]);
      expect(text.split('\n')).toHaveLength(10);
    });

    it('re-pointing back to the same command is a no-op', async () => {
      await wireHermesMcp(home, false, '/opt/tenjin');
      const before = await readFile(hermesConfigPath(home), 'utf8');
      expect((await wireHermesMcp(home, false, '/opt/tenjin')).status).toBe('up-to-date');
      expect(await readFile(hermesConfigPath(home), 'utf8')).toBe(before);
    });
  });
});

describe('wireHermesIntegration', () => {
  const commands = {
    tenjinCommand: '/opt/tenjin',
    nodeCommand: process.execPath,
    hooks: { enabled: true, mode: 'auto' as const },
  };

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

  // The Python probe below builds its own Ctx, so no test can notice a manifest
  // Hermes would not read: pin it here instead. Against `hermes_cli/plugins.py`,
  // which parses `provides_hooks` and defaults `kind` to `standalone`.
  it('pins the manifest to the fields the Hermes loader parses', async () => {
    await wireHermesIntegration({
      hermesHome: home,
      dataDir,
      dryRun: false,
      explicit: true,
      ...commands,
    });
    const manifest = await readFile(join(hermesPluginDir(home), 'plugin.yaml'), 'utf8');
    expect(manifest).toBe(HERMES_PLUGIN_MANIFEST);
    expect(manifest).toContain('kind: standalone');
    expect(manifest).toContain('provides_hooks:\n  - pre_tool_call');
    expect(manifest).toContain('  - transform_tool_result');
    expect(manifest).toContain('  - transform_llm_output');
  });

  // A wrong tool identifier fails exactly the way a wrong manifest field would:
  // the callbacks register, never match, and the suite stays green.
  it('observes the tool Hermes actually names, and nothing else', async () => {
    await wireHermesIntegration({
      hermesHome: home,
      dataDir,
      dryRun: false,
      explicit: true,
      ...commands,
    });
    expect(HERMES_WEB_SEARCH_TOOL).toBe('web_search');
    const pluginPath = join(hermesPluginDir(home), '__init__.py');
    expect(await readFile(pluginPath, 'utf8')).toContain('tool_name != "web_search"');
    const probe = [
      'import importlib.util, json, sys',
      'spec = importlib.util.spec_from_file_location("tenjin_plugin", sys.argv[1])',
      'mod = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(mod)',
      'hooks = {}',
      'class Ctx:',
      '    def register_hook(self, name, callback): hooks[name] = callback',
      'mod.register(Ctx())',
      'mod._run = lambda script, payload, timeout: "listing"',
      // Hermes injects extra kwargs (telemetry_schema_version, task_id, ...), so the
      // callbacks have to tolerate them rather than only the documented names.
      'hooks["pre_tool_call"](tool_name="WebSearch", args={"query": "q"}, tool_call_id="c1", telemetry_schema_version=1)',
      'other = hooks["transform_tool_result"](tool_name="WebSearch", result="r", tool_call_id="c1", task_id="t")',
      'hooks["pre_tool_call"](tool_name="web_search", args={"query": "q"}, tool_call_id="c2", turn_id="t1", telemetry_schema_version=1)',
      'mine = hooks["transform_tool_result"](tool_name="web_search", result="r", tool_call_id="c2", duration_ms=3, status="ok")',
      'print(json.dumps({"other": other, "mine": mine}))',
    ].join('\n');
    const { stdout } = await execFileAsync('python3', ['-c', probe, pluginPath]);
    expect(JSON.parse(stdout)).toEqual({
      other: null,
      mine: 'r\n\n--- Tenjin marketplace context ---\nlisting\n--- end Tenjin context ---',
    });
  });

  // The README's `--no-hooks` row promises "writes no config", and the Claude path
  // honors it by writing no scripts at all. Withholding only the `plugins.enabled`
  // line would leave hook code on disk that the operator never consented to.
  it('writes no hook code at all when the hooks decision said no', async () => {
    const result = await wireHermesIntegration({
      hermesHome: home,
      dataDir,
      dryRun: false,
      explicit: true,
      ...commands,
      hooks: {
        enabled: false,
        mode: 'auto',
        fix: 'Enable them with `tenjin config set hooks.searchMode auto`.',
      },
    });
    // `skipped` is about THIS RUN. `disabled` is a claim about the target, and on a
    // re-run over a working install it would be a false one.
    expect(result.plugin.status).toBe('skipped');
    expect(result.plugin.scriptPaths).toEqual([]);
    expect(result.activation.status).toBe('skipped');
    // The warning names the blocker that has to move, not the command just run.
    expect(result.plugin.warning).toContain('hooks.searchMode auto');
    await expect(
      readFile(join(hermesPluginDir(home), '__init__.py'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      readFile(join(hermesPluginDir(home), 'plugin.yaml'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      readFile(join(dataDir, 'hooks', 'tenjin-websearch.mjs'), 'utf8'),
    ).rejects.toThrow();
    await expect(readFile(join(dataDir, 'hooks', 'tenjin-stop.mjs'), 'utf8')).rejects.toThrow();
    // The MCP entry is a server registration, not a hook, so it is still written.
    expect(result.mcp.status).toBe('installed');
    expect(await readFile(hermesConfigPath(home), 'utf8')).not.toContain('plugins:');
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
    // The envelope has to report what WOULD be written, which is the two scripts a
    // real run creates.
    expect(result.plugin.scriptPaths).toEqual([
      join(dataDir, 'hooks', 'tenjin-websearch.mjs'),
      join(dataDir, 'hooks', 'tenjin-stop.mjs'),
    ]);
    await expect(readFile(hermesConfigPath(home), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

describe('readHermesIntegrationStatus', () => {
  const commands = {
    tenjinCommand: process.execPath,
    nodeCommand: process.execPath,
    hooks: { enabled: true, mode: 'auto' as const },
  };

  it('a fully wired home reads back green', async () => {
    await wireHermesIntegration({
      hermesHome: home,
      dataDir,
      dryRun: false,
      explicit: true,
      ...commands,
    });
    expect(await readHermesIntegrationStatus(home)).toMatchObject({
      mcp: 'configured',
      plugin: 'installed',
      activation: 'enabled',
      mcpCommand: process.execPath,
    });
  });

  // `command` is `process.argv[1]`, so an `npx`/`pnpm dlx` run bakes a cache path
  // that can be pruned later. Deriving the verdict from the marker and a regex
  // alone reported Hermes green while Hermes silently failed to start the server.
  it('a baked command that no longer exists is stale, not configured', async () => {
    await wireHermesMcp(home, false, join(home, 'pruned', 'npx-cache', 'tenjin'));
    const status = await readHermesIntegrationStatus(home);
    expect(status.mcp).toBe('stale');
    expect(status.mcpCommand).toContain('npx-cache');
  });

  // One classifier for both sides. A reader more permissive than the writer calls
  // `not-enabled` on a shape `planPluginEnable` refuses, and its fix string then
  // sends the operator into a conflict it did not predict.
  it('reports the conflict the installer would raise, not a false not-enabled', async () => {
    await writeFile(hermesConfigPath(home), 'plugins:\n  enabled: [other]\n');
    expect((await readHermesIntegrationStatus(home)).activation).toBe('conflict');
    expect(
      (
        await wireHermesIntegration({
          hermesHome: home,
          dataDir,
          dryRun: false,
          explicit: true,
          ...commands,
        })
      ).activation.status,
    ).toBe('conflict');
  });

  it('an untouched home is missing across the board', async () => {
    expect(await readHermesIntegrationStatus(join(home, 'nothing'))).toMatchObject({
      mcp: 'missing',
      plugin: 'missing',
      activation: 'not-enabled',
    });
  });
});

// An agent reads install's JSON. Saying `disabled` about a plugin that is on disk
// and enabled makes it conclude the retrieval reflex is off while it is running,
// which is the one way a status field can be wrong without anything misbehaving.
describe('withholding a write does not misreport the machine', () => {
  const commands = {
    tenjinCommand: process.execPath,
    nodeCommand: process.execPath,
  };

  it('a --no-hooks re-run reports skipped and names the surviving plugin', async () => {
    await wireHermesIntegration({
      hermesHome: home,
      dataDir,
      dryRun: false,
      explicit: true,
      ...commands,
      hooks: { enabled: true, mode: 'auto' },
    });
    const again = await wireHermesIntegration({
      hermesHome: home,
      dataDir,
      dryRun: false,
      explicit: true,
      ...commands,
      hooks: { enabled: false, mode: 'auto', fix: 'Wire them with `tenjin install`.' },
    });
    expect(again.plugin.status).toBe('skipped');
    expect(again.activation.status).toBe('skipped');
    expect(again.plugin.warning).toContain('still in');
    expect(again.plugin.warning).toContain('keeps running');
    // Inert is the strongest thing on offer: no command deletes the plugin dir or
    // the `plugins.enabled` entry, so the note must not promise removal.
    expect(again.plugin.warning).toContain('Make it inert with');
    expect(again.plugin.warning).not.toMatch(/\bRemove it\b|\buninstall\b/i);
    // Install's envelope and doctor's now describe the same machine.
    expect(await readHermesIntegrationStatus(home)).toMatchObject({
      plugin: 'installed',
      activation: 'enabled',
    });
  });

  it('with the mode stored off the surviving plugin is named as inert, not running', async () => {
    await wireHermesIntegration({
      hermesHome: home,
      dataDir,
      dryRun: false,
      explicit: true,
      ...commands,
      hooks: { enabled: true, mode: 'auto' },
    });
    const again = await wireHermesIntegration({
      hermesHome: home,
      dataDir,
      dryRun: false,
      explicit: true,
      ...commands,
      hooks: { enabled: false, mode: 'off' },
    });
    expect(again.plugin.warning).toContain('inert');
    expect(again.plugin.warning).not.toContain('keeps running');
  });

  it('says nothing about a survivor when there is none', async () => {
    const result = await wireHermesIntegration({
      hermesHome: home,
      dataDir,
      dryRun: false,
      explicit: true,
      ...commands,
      hooks: { enabled: false, mode: 'auto' },
    });
    expect(result.plugin.status).toBe('skipped');
    expect(result.plugin.warning).not.toContain('still in');
  });
});
