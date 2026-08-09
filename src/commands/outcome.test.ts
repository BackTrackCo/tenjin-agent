import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOutcome } from './outcome';
import { loadSearches, recordSearch } from '../lib/search-store';
import type { CommandContext } from '../context';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-outcome-cmd-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeCtx(): CommandContext {
  const sink = () => ({ write: () => true }) as unknown as NodeJS.WritableStream;
  return {
    flags: { json: false, timeout: 5000, baseUrl: 'https://preview.example' },
    dataDir: dir,
    io: { stdout: sink(), stderr: sink(), isTTY: false },
  };
}

function stub(): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchFn = (async (url: string) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ accepted: 1 }), {
      status: 202,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetch: fetchFn, urls };
}

const LOOKUP = '0197aaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('runOutcome', () => {
  it('reports against an explicit --search-id', async () => {
    const { fetch, urls } = stub();
    const res = await runOutcome({ searchId: LOOKUP, status: 'used' }, makeCtx(), {
      fetchImpl: fetch,
    });
    expect((res.data as { accepted: number }).accepted).toBe(1);
    expect(urls[0]).toBe(`https://preview.example/api/agent/searches/${LOOKUP}/outcomes`);
  });

  it('--last targets the most recent local search', async () => {
    await recordSearch(dir, {
      searchId: LOOKUP,
      at: new Date().toISOString(),
      question: 'q',
      decision: 'CANDIDATES',
      candidates: [],
    });
    const { fetch, urls } = stub();
    await runOutcome({ last: true, status: 'regenerated' }, makeCtx(), { fetchImpl: fetch });
    expect(urls[0]).toContain(LOOKUP);
  });

  it('--last with no local search is a SEARCH_NOT_FOUND error', async () => {
    const { fetch } = stub();
    await expect(
      runOutcome({ last: true, status: 'used' }, makeCtx(), { fetchImpl: fetch }),
    ).rejects.toMatchObject({ code: 'SEARCH_NOT_FOUND', exitCode: 1 });
  });

  it('rejects passing neither --search-id nor --last', async () => {
    const { fetch, urls } = stub();
    await expect(
      runOutcome({ status: 'used' }, makeCtx(), { fetchImpl: fetch }),
    ).rejects.toMatchObject({ code: 'USAGE' });
    expect(urls).toHaveLength(0);
  });

  it('rejects passing both --search-id and --last', async () => {
    const { fetch } = stub();
    await expect(
      runOutcome({ searchId: LOOKUP, last: true, status: 'used' }, makeCtx(), { fetchImpl: fetch }),
    ).rejects.toMatchObject({ code: 'USAGE' });
  });

  it('rejects an unknown status before any request', async () => {
    const { fetch, urls } = stub();
    await expect(
      runOutcome({ searchId: LOOKUP, status: 'loved-it' }, makeCtx(), { fetchImpl: fetch }),
    ).rejects.toMatchObject({ code: 'USAGE' });
    expect(urls).toHaveLength(0);
  });
});

describe('runOutcome closes the open loop locally', () => {
  const seed = async (): Promise<void> => {
    await recordSearch(dir, {
      searchId: LOOKUP,
      at: new Date().toISOString(),
      question: 'a question nobody had answered',
      decision: 'MISS',
      candidates: [],
    });
  };

  it('marks the search resolved, so the Stop hook stops raising it', async () => {
    await seed();
    const { fetch } = stub();
    await runOutcome({ searchId: LOOKUP, status: 'regenerated' }, makeCtx(), { fetchImpl: fetch });
    expect((await loadSearches(dir))[0]?.resolved?.by).toBe('outcome');
  });

  it('marks the right search when --last resolved the target', async () => {
    await seed();
    const { fetch } = stub();
    await runOutcome({ last: true, status: 'used' }, makeCtx(), { fetchImpl: fetch });
    expect((await loadSearches(dir))[0]?.resolved?.by).toBe('outcome');
  });

  // The mark is local bookkeeping for a nudge; a search this machine never
  // recorded still reports fine.
  it('reports normally for a searchId with no local record', async () => {
    const { fetch } = stub();
    const res = await runOutcome({ searchId: LOOKUP, status: 'used' }, makeCtx(), {
      fetchImpl: fetch,
    });
    expect(res.data).toMatchObject({ searchId: LOOKUP, status: 'used' });
    expect(await loadSearches(dir)).toEqual([]);
  });
});
