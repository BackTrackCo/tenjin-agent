#!/usr/bin/env node
// Spawns every command the built Claude Code plugin carries the way Claude Code
// does: exec form, no shell, `${CLAUDE_PLUGIN_ROOT}` substituted with forward
// slashes. Each command hook must exit 0 (and print JSON when it prints), and
// the router server must answer an MCP `initialize`. CI runs it on Windows,
// where a shell-form hook or the `tenjin` .cmd shim fails to start.
//
//   node scripts/plugin-spawn-smoke.mjs <marketplace dir, e.g. dist/hosts/claude>
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';

const hosts = process.argv[2];
if (hosts === undefined) {
  console.error('usage: plugin-spawn-smoke.mjs <marketplace dir>');
  process.exit(2);
}
const root = resolve(hosts, 'tenjin').split(sep).join('/');
const sub = (value) => value.replaceAll('${CLAUDE_PLUGIN_ROOT}', root);
const data = mkdtempSync(join(tmpdir(), 'plugin-spawn-'));
const env = { ...process.env, TENJIN_DATA_DIR: data, CLAUDE_PLUGIN_ROOT: root };
const read = (path) => JSON.parse(readFileSync(join(hosts, 'tenjin', path), 'utf8'));

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
  `plugin-spawn-smoke: ${hooks} command hooks and the MCP server started with no shell (ok)`,
);
