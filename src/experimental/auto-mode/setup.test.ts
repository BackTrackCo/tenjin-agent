import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  NATIVE_FALLBACK_INSTRUCTIONS,
  nativeFallbackInstructions,
  writeBridgeSetup,
} from './setup';

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
  expect(settings.hooks.UserPromptSubmit).toBeUndefined();
  expect(settings.permissions).toBeUndefined();
  expect(result.note).toContain('--tools ""');
  expect(settings.hooks.PreToolUse).toHaveLength(1);
  const hook = settings.hooks.PreToolUse[0];
  expect(new RegExp(hook.matcher).test('mcp__x402__request')).toBe(true);
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

it('adds a fixed request-first instruction only for optional mixed native mode', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'auto-bridge-mixed-'));
  directories.push(directory);
  await writeFile(join(directory, 'policy.json'), 'preserved policy');
  const result = await writeBridgeSetup(
    join(directory, 'config.json'),
    '/node path',
    "/cli's file.mjs",
    { nativeFallback: true },
  );
  const settings = JSON.parse(await readFile(result.settingsPath, 'utf8'));
  expect(settings.hooks.UserPromptSubmit).toEqual([
    {
      hooks: [
        {
          type: 'command',
          command: `'/node path' '/cli'\\''s file.mjs' native-instructions --config '${join(directory, 'config.json')}'`,
          timeout: 10,
        },
      ],
    },
  ]);
  expect(settings.hooks.PreToolUse).toHaveLength(2);
  expect(new RegExp(settings.hooks.PreToolUse[0].matcher).test('WebSearch')).toBe(false);
  expect(new RegExp(settings.hooks.PreToolUse[0].matcher).test('WebFetch')).toBe(false);
  const native = settings.hooks.PreToolUse[1];
  expect(new RegExp(native.matcher).test('WebSearch')).toBe(true);
  expect(new RegExp(native.matcher).test('WebFetch')).toBe(true);
  expect(new RegExp(native.matcher).test('mcp__other__WebSearch')).toBe(false);
  expect(native.hooks).toEqual([
    {
      type: 'command',
      command: `'/node path' '/cli'\\''s file.mjs' native-hook --config '${join(directory, 'config.json')}'`,
      timeout: 90,
    },
  ]);
  expect(result.note).toContain('--tools "WebSearch,WebFetch"');
  expect(settings.permissions).toBeUndefined();
  expect(result.note).toContain('own Jev value check');
  expect(NATIVE_FALLBACK_INSTRUCTIONS).toContain('Before each external lookup');
  expect(NATIVE_FALLBACK_INSTRUCTIONS).toContain('do not duplicate');
  expect(await readFile(join(directory, 'policy.json'), 'utf8')).toBe('preserved policy');
  await writeBridgeSetup(join(directory, 'config.json'), '/node path', "/cli's file.mjs");
  expect(
    JSON.parse(await readFile(result.settingsPath, 'utf8')).hooks.UserPromptSubmit,
  ).toBeUndefined();
  expect(JSON.parse(await readFile(result.settingsPath, 'utf8')).hooks.PreToolUse).toHaveLength(1);
});

it('keeps native search available while page reads use the bridge without changing authority', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'auto-bridge-search-only-'));
  directories.push(directory);
  const preserved = ['config.json', 'policy.json', 'ledger.json'];
  for (const path of preserved) await writeFile(join(directory, path), `preserve:${path}`);
  const configPath = join(directory, 'config.json');
  const result = await writeBridgeSetup(configPath, '/node', '/cli.mjs', {
    nativeFallback: true,
    nativeWebFetch: false,
  });
  const settings = JSON.parse(await readFile(result.settingsPath, 'utf8'));
  expect(settings.permissions).toEqual({ deny: ['WebFetch'] });
  expect(settings.hooks.UserPromptSubmit).toHaveLength(1);
  const nativeMatcher = new RegExp(settings.hooks.PreToolUse[1].matcher);
  expect(nativeMatcher.test('WebSearch')).toBe(true);
  expect(nativeMatcher.test('WebFetch')).toBe(false);
  expect(nativeMatcher.test('mcp__other__WebSearch')).toBe(false);
  expect(result.note).toContain('--tools "WebSearch"');
  expect(result.note).toContain('including search-result links');
  expect(nativeFallbackInstructions(false)).toContain('Native WebSearch is available');
  expect(nativeFallbackInstructions(false)).toContain('native WebFetch is unavailable');
  expect(nativeFallbackInstructions(false)).toContain('including links returned by WebSearch');
  expect(nativeFallbackInstructions(false)).toContain('with the exact URL');
  expect(nativeFallbackInstructions(false)).not.toContain('requires WebFetch');
  for (const path of preserved)
    expect(await readFile(join(directory, path), 'utf8')).toBe(`preserve:${path}`);

  await writeBridgeSetup(configPath, '/node', '/cli.mjs', {
    nativeFallback: true,
    nativeWebFetch: true,
  });
  const restored = JSON.parse(await readFile(result.settingsPath, 'utf8'));
  expect(restored.permissions).toBeUndefined();
  expect(new RegExp(restored.hooks.PreToolUse[1].matcher).test('WebFetch')).toBe(true);
  expect(nativeFallbackInstructions(true)).toBe(NATIVE_FALLBACK_INSTRUCTIONS);
  expect(nativeFallbackInstructions()).toBe(NATIVE_FALLBACK_INSTRUCTIONS);
});
