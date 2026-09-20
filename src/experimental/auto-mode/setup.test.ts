import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { writeBridgeSetup } from './setup';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

it('prepares the bridge without renewing payment authority or disturbing native settings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'auto-bridge-setup-'));
  directories.push(directory);
  const preserved = ['config.json', 'policy.json', 'settings.json'];
  for (const path of preserved) await writeFile(join(directory, path), `preserve:${path}`);
  const result = await writeBridgeSetup(
    join(directory, 'config.json'),
    '/node path',
    "/cli's file.mjs",
  );
  for (const path of preserved)
    expect(await readFile(join(directory, path), 'utf8')).toBe(`preserve:${path}`);
  const settings = JSON.parse(await readFile(result.settingsPath, 'utf8'));
  expect(settings.hooks.PreToolUse).toHaveLength(1);
  const hook = settings.hooks.PreToolUse[0];
  expect(new RegExp(hook.matcher).test('mcp__x402__search')).toBe(true);
  expect(new RegExp(hook.matcher).test('mcp__x402__fetch')).toBe(true);
  expect(new RegExp(hook.matcher).test('mcp__other__search')).toBe(false);
  expect(hook.hooks[0].command).toContain(
    "'/node path' '/cli'\\''s file.mjs' bridge-hook --config",
  );
  expect(settings.statusLine).toEqual({
    type: 'command',
    command: `'/node path' '/tenjin-auto-status.mjs' --config '${join(directory, 'config.json')}'`,
    refreshInterval: 1,
  });
  const mcp = JSON.parse(await readFile(result.mcpPath, 'utf8'));
  expect(Object.keys(mcp.mcpServers)).toEqual(['x402']);
  expect(mcp.mcpServers.x402.args).toEqual([
    "/cli's file.mjs",
    'bridge',
    '--config',
    join(directory, 'config.json'),
  ]);
});
