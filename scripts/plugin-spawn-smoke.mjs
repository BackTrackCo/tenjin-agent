#!/usr/bin/env node
// Spawns every command the Claude Code plugin carries the way Claude Code
// does: exec form, no shell, `${CLAUDE_PLUGIN_ROOT}` substituted with forward
// slashes. Each command hook must exit 0 (and print JSON when it prints), and
// the router server must answer an MCP `initialize`. CI runs it on Windows,
// where a shell-form hook or the `tenjin` .cmd shim fails to start.
//
//   node scripts/plugin-spawn-smoke.mjs <marketplace dir, e.g. dist/hosts/claude>
//   node scripts/plugin-spawn-smoke.mjs --pinned <CLI entry, e.g. dist/index.js>
//
// `--pinned` runs `tenjin install` in a scratch home with no `claude`, so it
// writes the plugin folder with every command pinned to absolute paths, then
// spawns those commands with an EMPTY PATH: the PATH a Claude Code started
// before Node's install hands its children. Any command that still needs
// PATH (`node`, `tenjin`) fails to start here.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';

const pinned = process.argv[2] === '--pinned';
const target = pinned ? process.argv[3] : process.argv[2];
if (target === undefined) {
  console.error('usage: plugin-spawn-smoke.mjs <marketplace dir> | --pinned <CLI entry>');
  process.exit(2);
}
const data = mkdtempSync(join(tmpdir(), 'plugin-spawn-'));

/** The environment minus PATH under any casing (Windows carries `Path`). */
function withPath(path, extra) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PATH'),
  );
  return { ...env, ...extra, PATH: path };
}

let plugin;
let env;
if (pinned) {
  const home = join(data, 'home');
  const cfg = join(data, 'cfg');
  const emptyPath = join(data, 'empty-path');
  for (const dir of [home, cfg, emptyPath]) mkdirSync(dir, { recursive: true });
  const scratch = {
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: cfg,
    TENJIN_DATA_DIR: join(data, 'tenjin'),
    CI: '1',
  };
  // Node's own folder alone: no `claude`, so install writes the folder fallback.
  const install = spawnSync(
    process.execPath,
    [resolve(target), 'install', '--yes', '--no-wallet', '--json'],
    {
      env: withPath(dirname(process.execPath), { ...scratch, CLAUDE_CODE_EXECPATH: '' }),
      cwd: home,
      encoding: 'utf8',
      timeout: 60_000,
    },
  );
  if (install.status !== 0) {
    console.error(`plugin-spawn-smoke: FAIL: install exit ${install.status} ${install.stderr}`);
    rmSync(data, { recursive: true, force: true });
    process.exit(1);
  }
  plugin = join(cfg, 'skills', 'tenjin-router');
  env = withPath(emptyPath, scratch);
} else {
  plugin = resolve(target, 'tenjin');
  env = { ...process.env, TENJIN_DATA_DIR: data };
}
const root = plugin.split(sep).join('/');
env.CLAUDE_PLUGIN_ROOT = root;
const sub = (value) => value.replaceAll('${CLAUDE_PLUGIN_ROOT}', root);
const read = (path) => JSON.parse(readFileSync(join(plugin, path), 'utf8'));

function fail(message) {
  console.error(`plugin-spawn-smoke: FAIL: ${message}`);
  rmSync(data, { recursive: true, force: true });
  process.exit(1);
}

let hooks = 0;
for (const [event, groups] of Object.entries(read('hooks/hooks.json').hooks)) {
  for (const handler of groups.flatMap((g) => g.hooks)) {
    if (handler.type !== 'command') continue;
    if (!Array.isArray(handler.args)) fail(`${event}: \`${handler.command}\` is shell form`);
    if (pinned && !isAbsolute(handler.command)) fail(`${event}: \`${handler.command}\` needs PATH`);
    const run = spawnSync(sub(handler.command), handler.args.map(sub), {
      input: JSON.stringify({ session_id: 'smoke', hook_event_name: event }),
      env,
      encoding: 'utf8',
      timeout: 20_000,
    });
    if (run.error !== undefined || run.status !== 0) {
      fail(`${event}: exit ${run.status} ${run.error?.message ?? run.stderr.slice(0, 300)}`);
    }
    if (run.stdout.trim().length > 0) {
      try {
        JSON.parse(run.stdout);
      } catch {
        fail(`${event}: stdout is not JSON: ${run.stdout.slice(0, 200)}`);
      }
    }
    hooks += 1;
  }
}

for (const [name, server] of Object.entries(read('.mcp.json').mcpServers)) {
  if (pinned && !isAbsolute(server.command))
    fail(`MCP server ${name}: \`${server.command}\` needs PATH`);
  const child = spawn(sub(server.command), server.args.map(sub), { env, stdio: 'pipe' });
  const answered = await new Promise((done) => {
    const timer = setTimeout(() => done(false), 30_000);
    let out = '';
    child.on('error', () => done(false));
    child.stdout.on('data', (chunk) => {
      out += chunk;
      if (out.split('\n').some((line) => line.includes('"id":1') && line.includes('"result"'))) {
        clearTimeout(timer);
        done(true);
      }
    });
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'plugin-spawn-smoke', version: '0' },
        },
      })}\n`,
    );
  });
  child.kill();
  if (!answered) fail(`MCP server ${name} did not answer initialize`);
}

rmSync(data, { recursive: true, force: true });
console.log(
  `plugin-spawn-smoke: ${hooks} command hooks and the MCP server started with no shell${pinned ? ' and no PATH' : ''} (ok)`,
);
