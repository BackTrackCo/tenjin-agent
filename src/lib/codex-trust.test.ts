import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { foldTrust, parseHooksState, readCodexTrust, trustKey } from './codex-trust';

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'tenjin-codex-trust-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const KEYS = ['/h/hooks.json:session_start:0:0', '/h/hooks.json:stop:0:0'];
const row = (key: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  key,
  enabled: true,
  trustStatus: 'trusted',
  ...over,
});

describe('trustKey: the address Codex files a handler under', () => {
  it('is the source path, the snake-case event, and the two indices', () => {
    expect(trustKey('/h/hooks.json', 'PreToolUse', 0, 0)).toBe('/h/hooks.json:pre_tool_use:0:0');
    expect(trustKey('/h/hooks.json', 'SubagentStop', 2, 1)).toBe('/h/hooks.json:subagent_stop:2:1');
  });

  it('has no key for an event this build does not know', () => {
    expect(trustKey('/h/hooks.json', 'Invented', 0, 0)).toBeNull();
  });
});

describe('foldTrust: worst news first, because each state has its own remedy', () => {
  it('is trusted only when every one of ours is', () => {
    expect(
      foldTrust(
        KEYS.map((k) => row(k)),
        KEYS,
      ),
    ).toBe('trusted');
  });

  it('counts a managed hook as one Codex will run', () => {
    expect(foldTrust([row(KEYS[0]!), row(KEYS[1]!, { trustStatus: 'managed' })], KEYS)).toBe(
      'trusted',
    );
  });

  /**
   * The state a file reader cannot see, and the reason this module asks Codex
   * rather than parsing config.toml: the row is there, the hash under it has
   * gone stale because hooks.json was rewritten, and Codex refuses the hook.
   * Reported as "recorded" it would read as working (tenjin-agent#342).
   */
  it('reports modified rather than trusted when the file changed underneath the trust', () => {
    expect(foldTrust([row(KEYS[0]!), row(KEYS[1]!, { trustStatus: 'modified' })], KEYS)).toBe(
      'modified',
    );
  });

  it('reports disabled ahead of everything else: it is trusted and switched off', () => {
    expect(
      foldTrust(
        [row(KEYS[0]!, { enabled: false }), row(KEYS[1]!, { trustStatus: 'modified' })],
        KEYS,
      ),
    ).toBe('disabled');
  });

  it('is untrusted when Codex knows of ours but has reviewed none', () => {
    expect(
      foldTrust(
        KEYS.map((k) => row(k, { trustStatus: 'untrusted' })),
        KEYS,
      ),
    ).toBe('untrusted');
  });

  it('is partial when only some are through', () => {
    expect(foldTrust([row(KEYS[0]!), row(KEYS[1]!, { trustStatus: 'untrusted' })], KEYS)).toBe(
      'partial',
    );
  });

  it('ignores hooks that are not ours', () => {
    const theirs = row('/h/hooks.json:stop:9:9', { trustStatus: 'untrusted' });
    expect(foldTrust([...KEYS.map((k) => row(k)), theirs], KEYS)).toBe('trusted');
  });

  it('is untrusted, never trusted, when Codex has never heard of ours', () => {
    expect(foldTrust([row('/other:stop:0:0')], KEYS)).toBe('untrusted');
  });
});

describe('readCodexTrust: asking Codex first, the file only as a fallback', () => {
  const listing = (rows: Record<string, unknown>[]) => async () => rows;

  it('takes the app server’s answer when there is one', async () => {
    const report = await readCodexTrust(home, KEYS, {
      env: {},
      listHooks: listing(KEYS.map((k) => row(k))),
    });
    expect(report).toMatchObject({ state: 'trusted', source: 'app-server', trusted: 2 });
  });

  /**
   * The fallback can see that a row exists; it cannot see whether the hash
   * under it still matches. So its best word is `partial`, never `trusted`:
   * claiming trust from a file read is the mistake this whole module avoids.
   */
  it('never says trusted from the config file alone', async () => {
    await mkdir(join(home, '.codex'), { recursive: true });
    await writeFile(
      join(home, '.codex', 'config.toml'),
      `[hooks.state]\n"${KEYS[0]}" = { enabled = true, trusted_hash = "sha256:aa" }\n` +
        `"${KEYS[1]}" = { enabled = true, trusted_hash = "sha256:bb" }\n`,
    );
    const report = await readCodexTrust(home, KEYS, { env: {}, listHooks: async () => null });
    expect(report.state).toBe('partial');
    expect(report.source).toBe('config-file');
  });

  it('reads an absent config file as untrusted, which is a real answer', async () => {
    const report = await readCodexTrust(home, KEYS, { env: {}, listHooks: async () => null });
    expect(report).toMatchObject({ state: 'untrusted', source: 'config-file' });
  });

  it('reads a config file it cannot follow as unknown, never as either verdict', async () => {
    await mkdir(join(home, '.codex'), { recursive: true });
    await writeFile(join(home, '.codex', 'config.toml'), '[hooks.state]\nnot a toml row at all\n');
    const report = await readCodexTrust(home, KEYS, { env: {}, listHooks: async () => null });
    expect(report.state).toBe('unknown');
  });

  it('has nothing to say when nothing of ours is registered', async () => {
    const report = await readCodexTrust(home, [], { env: {} });
    expect(report).toMatchObject({ state: 'unknown', source: 'none' });
  });
});

describe('parseHooksState: the narrow read of a file we must never write', () => {
  it('reads the inline-table form', () => {
    const rows = parseHooksState(
      `model = "gpt"\n[hooks.state]\n"a:stop:0:0" = { enabled = true, trusted_hash = "sha256:x" }\n`,
    );
    expect(rows?.get('a:stop:0:0')).toEqual({ enabled: true });
  });

  it('reads the sub-table form, and sees a hook switched off', () => {
    const rows = parseHooksState(
      `[hooks.state."a:stop:0:0"]\nenabled = false\ntrusted_hash = "sha256:x"\n`,
    );
    expect(rows?.get('a:stop:0:0')).toEqual({ enabled: false });
  });

  it('does not mistake another table’s rows for hook state', () => {
    const rows = parseHooksState(
      `[hooks.state]\n"a:stop:0:0" = { enabled = true }\n[other]\nb = 1\n`,
    );
    expect([...(rows?.keys() ?? [])]).toEqual(['a:stop:0:0']);
  });

  it('gives up rather than guess on a row it cannot follow', () => {
    expect(parseHooksState('[hooks.state]\nbare_key = 1\n')).toBeNull();
  });

  it('unescapes a quoted path', () => {
    const rows = parseHooksState('[hooks.state]\n"a\\"b:stop:0:0" = { enabled = true }\n');
    expect([...(rows?.keys() ?? [])]).toEqual(['a"b:stop:0:0']);
  });
});
