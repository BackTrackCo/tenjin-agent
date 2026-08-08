import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOutcome } from './outcome';
import { recordSearch, type StoredSearch } from '../lib/search-store';
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

/** Record one search, defaulting to the shape the misfire in issue #100 hit: a
 *  MISS with no candidates and no browse tail, so nothing was ever buyable. */
async function record(over: Partial<StoredSearch> = {}): Promise<void> {
  await recordSearch(dir, {
    searchId: LOOKUP,
    at: new Date().toISOString(),
    question: 'how do I rotate a session key',
    decision: 'MISS',
    candidates: [],
    browseCount: 0,
    ...over,
  });
}

const CANDIDATE = {
  resourceId: '0197aaaa-bbbb-cccc-dddd-111111111111',
  url: 'https://preview.example/api/read/iris/one',
  title: 't',
  price: '100000',
};

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

// `--last` binds to the newest local search, which in a multi-search session is
// often not the one the agent means. The echo is the guard that makes that
// visible at the moment of the report rather than in the marketplace's data.
describe('runOutcome, the targeted search is echoed back', () => {
  it('echoes the question in the human line and the machine data', async () => {
    await record({ decision: 'CANDIDATES', candidates: [CANDIDATE] });
    const { fetch } = stub();
    const res = await runOutcome({ last: true, status: 'used' }, makeCtx(), { fetchImpl: fetch });
    expect(res.data).toMatchObject({ question: 'how do I rotate a session key' });
    expect(res.humanLines?.[0]).toBe(
      `Reported used for search ${LOOKUP} "how do I rotate a session key" (accepted 1).`,
    );
  });

  it('marks a truncated question so a cut one cannot read as a shorter one', async () => {
    await record({ question: 'x'.repeat(200) });
    const { fetch } = stub();
    const res = await runOutcome({ last: true, status: 'used' }, makeCtx(), { fetchImpl: fetch });
    const echoed = (res.data as { question: string }).question;
    expect(echoed).toHaveLength(80);
    expect(echoed.endsWith('…')).toBe(true);
    expect(res.humanLines?.[0]).toContain(echoed);
  });

  it('echoes an explicit --search-id the store knows about', async () => {
    await record({ decision: 'CANDIDATES', candidates: [CANDIDATE] });
    const { fetch } = stub();
    const res = await runOutcome({ searchId: LOOKUP, status: 'used' }, makeCtx(), {
      fetchImpl: fetch,
    });
    expect(res.data).toMatchObject({ question: 'how do I rotate a session key' });
  });

  // A searchId from another machine, or one aged out of the 50-entry store, is
  // still a valid capability. It reports with no echo rather than failing.
  it('reports a search the store has never seen, with no question', async () => {
    const { fetch, urls } = stub();
    const res = await runOutcome({ searchId: LOOKUP, status: 'purchase_declined' }, makeCtx(), {
      fetchImpl: fetch,
    });
    expect(res.data).not.toHaveProperty('question');
    expect(urls).toHaveLength(1);
  });
});

// The status-vs-search matrix (issue #100). Only `purchase_declined` has a
// precondition; the other four describe any search, including a bare MISS.
describe('runOutcome, locally incoherent statuses', () => {
  it('refuses purchase_declined on a search that offered nothing to buy', async () => {
    await record();
    const { fetch, urls } = stub();
    await expect(
      runOutcome({ last: true, status: 'purchase_declined' }, makeCtx(), { fetchImpl: fetch }),
    ).rejects.toMatchObject({ code: 'USAGE' });
    expect(urls).toHaveLength(0);
  });

  // The error has to name the search it would have hit, or it just tells the
  // agent it is wrong without telling it which search it was aimed at.
  it('names the search and its question in the refusal', async () => {
    await record();
    const { fetch } = stub();
    const call = runOutcome({ last: true, status: 'purchase_declined' }, makeCtx(), {
      fetchImpl: fetch,
    });
    await expect(call).rejects.toThrow(LOOKUP);
    await expect(call).rejects.toThrow('how do I rotate a session key');
    await expect(call).rejects.toThrow('MISS');
  });

  it.each([
    ['a payable browse tail', { browseCount: 2 }],
    ['candidates', { decision: 'CANDIDATES', candidates: [CANDIDATE] }],
  ])('allows purchase_declined when the search offered %s', async (_label, over) => {
    await record(over);
    const { fetch, urls } = stub();
    await runOutcome({ last: true, status: 'purchase_declined' }, makeCtx(), { fetchImpl: fetch });
    expect(urls).toHaveLength(1);
  });

  // The check is local knowledge only, so an entry that predates `browseCount`
  // cannot answer, and unknown must never become a refusal.
  it('allows purchase_declined on an entry written before browseCount existed', async () => {
    await writeFile(
      join(dir, 'searches.json'),
      JSON.stringify({
        schemaVersion: 1,
        searches: [
          {
            searchId: LOOKUP,
            at: new Date().toISOString(),
            question: 'q',
            decision: 'MISS',
            candidates: [],
          },
        ],
      }),
      'utf8',
    );
    const { fetch, urls } = stub();
    await runOutcome({ last: true, status: 'purchase_declined' }, makeCtx(), { fetchImpl: fetch });
    expect(urls).toHaveLength(1);
  });

  // A MISS's browse tail is readable and its free pieces are usable without any
  // purchase, and "nothing here helped, I wrote it myself" is exactly what a MISS
  // deserves to record. Blanket-gating on the decision would have killed all four.
  it.each(['used', 'partially_used', 'rejected', 'regenerated'])(
    'allows %s on a bare MISS',
    async (status) => {
      await record();
      const { fetch, urls } = stub();
      await runOutcome({ last: true, status }, makeCtx(), { fetchImpl: fetch });
      expect(urls).toHaveLength(1);
    },
  );

  it('still fails an unknown status as unknown, not as incoherent', async () => {
    await record();
    const { fetch } = stub();
    await expect(
      runOutcome({ last: true, status: 'loved-it' }, makeCtx(), { fetchImpl: fetch }),
    ).rejects.toThrow('Invalid outcome status');
  });
});
