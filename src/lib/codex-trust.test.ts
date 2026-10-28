import { describe, it, expect } from 'vitest';
import { trustCodexHooks } from './codex-trust';

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
