import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  foldTrust,
  parseHooksState,
  readCodexTrust,
  trustCodexHooks,
  trustKey,
} from './codex-trust';

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

describe('trustCodexHooks: list, upsert, and prove it took', () => {
  const KEY = '/h/hooks.json:session_start:0:0';
  const HASH = 'sha256:abc';
  const ours = (r: { command?: unknown; sourcePath?: unknown }): boolean =>
    typeof r.command === 'string' && r.command.includes('tenjin-shim.mjs');
  const listed = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    key: KEY,
    command: 'node "/d/hooks/tenjin-shim.mjs" --harness codex',
    sourcePath: '/h/hooks.json',
    enabled: true,
    trustStatus: 'untrusted',
    currentHash: HASH,
    ...over,
  });

  /** A scripted app server: each `hooks/list` answers the next queued page. */
  function server(pages: Record<string, unknown>[][], writeOk = true) {
    const calls: Array<{ method: string; params: unknown }> = [];
    let page = 0;
    const request = async (method: string, params: unknown): Promise<unknown> => {
      calls.push({ method, params });
      if (method === 'config/batchWrite') return writeOk ? {} : undefined;
      const rows = pages[Math.min(page++, pages.length - 1)] ?? [];
      return { data: [{ cwd: '/r', hooks: rows }] };
    };
    return { request, calls };
  }

  it('echoes back the hash Codex reported, for our keys only, and verifies', async () => {
    const theirs = listed({ key: '/h/hooks.json:stop:0:0', command: 'node other-tool.mjs' });
    const s = server([
      [listed(), theirs],
      [listed({ trustStatus: 'trusted' }), theirs],
    ]);
    const result = await trustCodexHooks('/home', [KEY], ours, { connect: s.request });
    expect(result.ok).toBe(true);
    expect(result.trusted).toEqual([KEY]);

    const write = s.calls.find((c) => c.method === 'config/batchWrite');
    const edit = (
      write?.params as {
        edits: { keyPath: string; value: Record<string, unknown>; mergeStrategy: string }[];
      }
    ).edits[0];
    expect(edit?.keyPath).toBe('hooks.state');
    expect(edit?.mergeStrategy).toBe('upsert');
    // Our key, carrying the hash CODEX gave us, and nothing else. Another
    // tool's row in the same file is never in the payload.
    expect(Object.keys(edit?.value ?? {})).toEqual([KEY]);
    expect(edit?.value[KEY]).toEqual({ trusted_hash: HASH, enabled: true });
    // Three round trips: the verifying read is part of the operation.
    expect(s.calls.map((c) => c.method)).toEqual(['hooks/list', 'config/batchWrite', 'hooks/list']);
  });

  it('fails at verify when Codex does not report the rows back as trusted', async () => {
    const s = server([[listed()], [listed({ trustStatus: 'untrusted' })]]);
    const result = await trustCodexHooks('/home', [KEY], ours, { connect: s.request });
    expect(result.ok).toBe(false);
    expect(result.failedAt).toBe('verify');
  });

  /** The write "succeeded" and the hash moved underneath it. Not trusted. */
  it('fails at verify when the hash came back different', async () => {
    const s = server([
      [listed()],
      [listed({ trustStatus: 'trusted', currentHash: 'sha256:other' })],
    ]);
    const result = await trustCodexHooks('/home', [KEY], ours, { connect: s.request });
    expect(result.ok).toBe(false);
    expect(result.failedAt).toBe('verify');
  });

  it('fails at write when batchWrite is refused', async () => {
    const s = server([[listed()], [listed({ trustStatus: 'trusted' })]], false);
    const result = await trustCodexHooks('/home', [KEY], ours, { connect: s.request });
    expect(result.ok).toBe(false);
    expect(result.failedAt).toBe('write');
  });

  it('fails at list when Codex does not report every entry we wrote', async () => {
    const s = server([[]]);
    const result = await trustCodexHooks('/home', [KEY], ours, { connect: s.request });
    expect(result.ok).toBe(false);
    expect(result.failedAt).toBe('list');
  });

  /** No hash, nothing honest to write: we never invent one. */
  it('refuses to write when Codex reported no currentHash', async () => {
    const s = server([[listed({ currentHash: undefined })]]);
    const result = await trustCodexHooks('/home', [KEY], ours, { connect: s.request });
    expect(result.ok).toBe(false);
    expect(result.failedAt).toBe('list');
    expect(s.calls.some((c) => c.method === 'config/batchWrite')).toBe(false);
  });

  it('never trusts a row that is not ours, even under one of our keys', async () => {
    const impostor = listed({ command: 'node /somewhere/else.mjs' });
    const s = server([[impostor], [impostor]]);
    const result = await trustCodexHooks('/home', [KEY], ours, { connect: s.request });
    expect(result.ok).toBe(false);
    expect(s.calls.some((c) => c.method === 'config/batchWrite')).toBe(false);
  });

  it('has nothing to do, and succeeds, when no entries were written', async () => {
    const s = server([[]]);
    expect(await trustCodexHooks('/home', [], ours, { connect: s.request })).toEqual({
      ok: true,
      trusted: [],
    });
    expect(s.calls).toHaveLength(0);
  });
});

describe('readCodexTrust: an unreadable config is not an untrusted one', () => {
  it('reports unknown when config.toml exists but cannot be read', async () => {
    // A directory where the file goes: it exists, and reading it fails with
    // EISDIR rather than ENOENT. Reporting that as "definitely untrusted"
    // hides a filesystem problem behind a remedy that would not touch it.
    await mkdir(join(home, '.codex', 'config.toml'), { recursive: true });
    const report = await readCodexTrust(home, ['k'], { env: {}, listHooks: async () => null });
    expect(report.state).toBe('unknown');
  });
});
