import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ownMarketplace, recordedInstalls } from './plugin-registration';

let home: string;
const record = (body: string): void => {
  const dir = join(home, '.claude', 'plugins');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'installed_plugins.json'), body);
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'plugin-registration-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('recordedInstalls', () => {
  it("reads every tenjin@tenjin install in the lab's shape, whatever the key order", async () => {
    record(
      JSON.stringify({
        version: 2,
        plugins: {
          'tenjin@tenjin': [
            {
              scope: 'local',
              projectPath: '/work/a',
              installPath: '/stale/a',
              version: '0.1.0-alpha.30',
              installedAt: '2026-10-22T00:00:00.000Z',
            },
            {
              installedAt: '2026-10-22T00:00:00.000Z',
              version: '0.1.0-alpha.31',
              installPath: '/stale/b',
              projectPath: '/work/b/sub',
              scope: 'local',
            },
            { scope: 'user', installPath: '/stale/u', version: '0.1.0-alpha.31' },
          ],
          'other@market': [{ scope: 'user' }],
        },
      }),
    );
    expect(await recordedInstalls({}, home)).toEqual([
      { scope: 'local', projectPath: '/work/a' },
      { scope: 'local', projectPath: '/work/b/sub' },
      { scope: 'user', projectPath: null },
    ]);
  });

  it('reads CLAUDE_CONFIG_DIR when it is set', async () => {
    const dir = join(home, 'cfg', 'plugins');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'installed_plugins.json'),
      JSON.stringify({ version: 2, plugins: { 'tenjin@tenjin': [{ scope: 'user' }] } }),
    );
    expect(await recordedInstalls({ CLAUDE_CONFIG_DIR: join(home, 'cfg') }, home)).toEqual([
      { scope: 'user', projectPath: null },
    ]);
  });

  it('is [] with no file, and when only another plugin is recorded', async () => {
    expect(await recordedInstalls({}, home)).toEqual([]);
    record(JSON.stringify({ version: 2, plugins: { 'tenjin@skills-dir': [{ scope: 'user' }] } }));
    expect(await recordedInstalls({}, home)).toEqual([]);
  });

  it('skips scopes it does not remove and entries that are not objects', async () => {
    record(
      JSON.stringify({
        version: 2,
        plugins: {
          'tenjin@tenjin': [{ scope: 'project', projectPath: '/p' }, 7, null, { scope: 'local' }],
        },
      }),
    );
    expect(await recordedInstalls({}, home)).toEqual([]);
  });

  it('is null for malformed JSON or plugins that are not an object', async () => {
    record('{not json');
    expect(await recordedInstalls({}, home)).toBeNull();
    record(JSON.stringify({ version: 2, plugins: [] }));
    expect(await recordedInstalls({}, home)).toBeNull();
    record(JSON.stringify({ version: 2 }));
    expect(await recordedInstalls({}, home)).toBeNull();
  });
});

describe('ownMarketplace', () => {
  it('recognises a removed runtime/claude or package folder by its path, and nothing else that is gone', async () => {
    const gone = (path: string) => ownMarketplace({ source: 'directory', path });
    expect(await gone(join(home, '.tenjin', 'runtime', 'claude'))).toBe(true);
    expect(
      await gone(join(home, 'lib', 'node_modules', 'tenjin-cli', 'dist', 'hosts', 'claude')),
    ).toBe(true);
    expect(await gone(join(home, 'elsewhere', 'claude'))).toBe(false);
    expect(await ownMarketplace({ source: 'github', path: join(home, 'runtime', 'claude') })).toBe(
      false,
    );
  });
});
