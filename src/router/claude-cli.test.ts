import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  aliveDir,
  readAliveStamp,
  removeAliveState,
  runAliveHook,
  sessionServedByPlugin,
} from './alive';
import {
  claudeConfigDir,
  findClaudeBinary,
  jsonList,
  jsonResult,
  meetsFloor,
  parseClaudeVersion,
  readClaudeCode,
  userMcpFile,
  userSettingsPath,
} from './claude-cli';
import { fakeClaude } from './claude-test-utils';
import { LEGACY_REQUEST_TOOL, REQUEST_TOOL, requestToolName } from './names';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'claude-cli-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("Claude Code's config directory", () => {
  it('is CLAUDE_CONFIG_DIR when set, for settings and the user MCP file alike', () => {
    const env = { CLAUDE_CONFIG_DIR: '/cfg' };
    expect(claudeConfigDir(env, '/home/u')).toBe('/cfg');
    expect(userSettingsPath(env, '/home/u')).toBe('/cfg/settings.json');
    expect(userMcpFile(env, '/home/u')).toBe('/cfg/.claude.json');
  });

  it('is ~/.claude otherwise, with ~/.claude.json beside it', () => {
    expect(claudeConfigDir({}, '/home/u')).toBe('/home/u/.claude');
    expect(userSettingsPath({}, '/home/u')).toBe('/home/u/.claude/settings.json');
    expect(userMcpFile({}, '/home/u')).toBe('/home/u/.claude.json');
  });
});

describe('finding the claude binary', () => {
  it('takes claude on PATH first, then CLAUDE_CODE_EXECPATH, then nothing', async () => {
    const fake = await fakeClaude(root);
    const empty = join(root, 'empty');
    await mkdir(empty);
    expect(findClaudeBinary({ PATH: fake.pathDir, CLAUDE_CODE_EXECPATH: '/nope' })).toEqual({
      path: fake.bin,
      source: 'path',
    });
    expect(findClaudeBinary({ PATH: empty, CLAUDE_CODE_EXECPATH: fake.bin })).toEqual({
      path: fake.bin,
      source: 'execpath',
    });
    expect(findClaudeBinary({ PATH: empty })).toBeNull();
    expect(findClaudeBinary({ PATH: empty, CLAUDE_CODE_EXECPATH: 'relative/claude' })).toBeNull();
  });

  it('reads the version and holds it to the 2.1.287 floor, with an in-session fix', async () => {
    const fake = await fakeClaude(root);
    expect(await readClaudeCode(fake.env, root)).toMatchObject({
      version: '2.1.296',
      meetsFloor: true,
    });
    await fake.respond('version', '2.1.286 (Claude Code)\n');
    const old = await readClaudeCode(fake.env, root);
    expect(old).toMatchObject({ version: '2.1.286', meetsFloor: false });
    expect(old.fix).toContain('Run `claude update` in this session');
    expect(old.fix).not.toMatch(/terminal/i);
  });
});

describe('reading the plugin commands', () => {
  it('parses versions and compares them to the floor', () => {
    expect(parseClaudeVersion('2.1.296 (Claude Code)')).toBe('2.1.296');
    expect(parseClaudeVersion('nonsense')).toBeNull();
    expect(meetsFloor('2.1.287')).toBe(true);
    expect(meetsFloor('2.1.286')).toBe(false);
    expect(meetsFloor('2.2.0')).toBe(true);
    expect(meetsFloor('3.0.0')).toBe(true);
    expect(meetsFloor('2.0.999')).toBe(false);
  });

  it('takes the last JSON object line, and a list wherever it starts', () => {
    expect(jsonResult('noise\n{"outcome":"ok"}\n')).toEqual({ outcome: 'ok' });
    expect(jsonResult('no json here')).toBeNull();
    expect(jsonList('Checking...\n[{"id":"tenjin@tenjin"}]')).toEqual([{ id: 'tenjin@tenjin' }]);
    expect(jsonList('{"not":"a list"}')).toBeNull();
  });
});

describe('the request tool name a process exposes', () => {
  it('is the plugin tool when the plugin launched it, else the settings install tool', () => {
    expect(requestToolName({ CLAUDE_PLUGIN_ROOT: '/p' })).toBe(REQUEST_TOOL);
    expect(requestToolName({})).toBe(LEGACY_REQUEST_TOOL);
    expect(REQUEST_TOOL).toBe('mcp__plugin_tenjin_router__request');
    expect(LEGACY_REQUEST_TOOL).toBe('mcp__x402__request');
  });
});

describe('the alive leg', () => {
  it('marks the session and stamps the machine, and the marker silences only that session', async () => {
    const data = join(root, 'data');
    await runAliveHook({ session_id: 'sess-1' }, { dataDir: data, version: '9.9.9' });
    expect(await sessionServedByPlugin(data, { session_id: 'sess-1' })).toBe(true);
    expect(await sessionServedByPlugin(data, { session_id: 'sess-2' })).toBe(false);
    expect(await sessionServedByPlugin(data, {})).toBe(false);
    expect(await readAliveStamp(data)).toMatchObject({ version: '9.9.9' });
  });

  it('prunes markers older than a week and never touches a file it did not write', async () => {
    const data = join(root, 'data');
    await runAliveHook({ session_id: 'old' }, { dataDir: data, version: '1' });
    const [marker] = (await readdir(aliveDir(data))).filter((n) => /^[0-9a-f]{32}$/.test(n));
    const longAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await utimes(join(aliveDir(data), marker!), longAgo, longAgo);
    await writeFile(join(aliveDir(data), 'mine.txt'), 'x');
    await runAliveHook({ session_id: 'new' }, { dataDir: data, version: '1' });
    expect(await sessionServedByPlugin(data, { session_id: 'old' })).toBe(false);
    expect(await sessionServedByPlugin(data, { session_id: 'new' })).toBe(true);
    expect(await removeAliveState(data)).toBe(true);
    expect(await readdir(aliveDir(data))).toEqual(['mine.txt']);
  });

  it('never fails the session: an unwritable data dir is swallowed', async () => {
    const file = join(root, 'not-a-dir');
    await writeFile(file, '');
    await expect(
      runAliveHook({ session_id: 's' }, { dataDir: file, version: '1' }),
    ).resolves.toBeUndefined();
  });
});
