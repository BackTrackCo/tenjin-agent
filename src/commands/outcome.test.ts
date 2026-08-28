import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOutcome } from './outcome';
import { loadSearches, recordSearch, type StoredSearch } from '../lib/state-store';
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
    paidBrowseCount: 0,
    ...over,
  });
}

const CANDIDATE = {
  resourceId: '0197aaaa-bbbb-cccc-dddd-111111111111',
  url: 'https://preview.example/api/read/iris/one',
  title: 't',
  price: '100000',
};

/** A Tenjin piece may be priced at zero, and `read` then delivers it for nothing. */
const FREE_CANDIDATE = {
  ...CANDIDATE,
  resourceId: '0197aaaa-bbbb-cccc-dddd-222222222222',
  price: '0',
};

describe('runOutcome', () => {
  it('reports against an explicit --search-id', async () => {
    const { fetch, urls } = stub();
    const res = await runOutcome({ searchId: LOOKUP, status: 'used' }, makeCtx(), {
      fetchImpl: fetch,
    });
    expect((res.data as { accepted: number }).accepted).toBe(1);
    expect(urls[0]).toBe(`https://preview.example/api/searches/${LOOKUP}/outcomes`);
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
    ['a payable browse tail', { paidBrowseCount: 2 }],
    ['a paid candidate', { decision: 'CANDIDATES', candidates: [CANDIDATE] }],
    [
      'one paid candidate among free ones',
      { decision: 'CANDIDATES', candidates: [FREE_CANDIDATE, CANDIDATE] },
    ],
  ])('allows purchase_declined when the search offered %s', async (_label, over) => {
    await record(over);
    const { fetch, urls } = stub();
    await runOutcome({ last: true, status: 'purchase_declined' }, makeCtx(), { fetchImpl: fetch });
    expect(urls).toHaveLength(1);
  });

  // A row is not an offer. A piece priced at zero is delivered by `read` with no
  // payment, so a result that was free end to end had no purchase to decline
  // however many candidates or browse pointers it listed.
  it.each([
    ['candidates that are all free', { decision: 'CANDIDATES', candidates: [FREE_CANDIDATE] }],
    ['a browse tail that is all free', { paidBrowseCount: 0 }],
  ])('refuses purchase_declined on a search offering %s', async (_label, over) => {
    await record(over);
    const { fetch, urls } = stub();
    await expect(
      runOutcome({ last: true, status: 'purchase_declined' }, makeCtx(), { fetchImpl: fetch }),
    ).rejects.toMatchObject({ code: 'USAGE' });
    expect(urls).toHaveLength(0);
  });

  // The check is local knowledge only, so an entry that predates `paidBrowseCount`
  // cannot answer, and unknown must never become a refusal.
  it('allows purchase_declined on an entry written before paidBrowseCount existed', async () => {
    // All free, so the candidates cannot answer the question either. The row is
    // written without the field that could, and unknown must stay unknown.
    await recordSearch(dir, {
      searchId: LOOKUP,
      at: new Date().toISOString(),
      question: 'q',
      decision: 'CANDIDATES',
      candidates: [FREE_CANDIDATE],
    });
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

  // The aggregate arm, with no --resource to name a candidate: a price the store
  // cannot read is not evidence the search was free, so it must not combine with
  // an empty browse tail into a refusal.
  it('allows purchase_declined when a stored price is unreadable', async () => {
    await record({
      decision: 'CANDIDATES',
      candidates: [{ ...CANDIDATE, price: 'not-a-price' }],
      paidBrowseCount: 0,
    });
    const { fetch, urls } = stub();
    await runOutcome({ last: true, status: 'purchase_declined' }, makeCtx(), { fetchImpl: fetch });
    expect(urls).toHaveLength(1);
  });

  // A paid sibling in the same result does not make a free piece purchasable, so
  // an explicit --resource the store knows is checked against its OWN price.
  describe('with --resource naming a candidate the store knows', () => {
    const MIXED = { decision: 'CANDIDATES', candidates: [FREE_CANDIDATE, CANDIDATE] };

    it('refuses a decline naming the free candidate', async () => {
      await record(MIXED);
      const { fetch, urls } = stub();
      const call = runOutcome(
        { last: true, status: 'purchase_declined', resource: FREE_CANDIDATE.resourceId },
        makeCtx(),
        { fetchImpl: fetch },
      );
      await expect(call).rejects.toMatchObject({ code: 'USAGE' });
      await expect(call).rejects.toThrow(FREE_CANDIDATE.resourceId);
      expect(urls).toHaveLength(0);
    });

    it('allows a decline naming the paid candidate in the same search', async () => {
      await record(MIXED);
      const { fetch, urls } = stub();
      await runOutcome(
        { last: true, status: 'purchase_declined', resource: CANDIDATE.resourceId },
        makeCtx(),
        { fetchImpl: fetch },
      );
      expect(urls).toHaveLength(1);
    });

    // On a CANDIDATES decision the stored candidates are the whole payable set the
    // agent saw: browse is MISS-only by contract, and the parser deletes the array
    // outright here rather than trust the server. So a uuid outside that set is a
    // typo or another search's, the server drops the item behind its 202, and
    // without this the CLI would report success for an outcome nobody recorded.
    it('refuses an id this CANDIDATES search never surfaced', async () => {
      await record({ decision: 'CANDIDATES', candidates: [CANDIDATE] });
      const { fetch, urls } = stub();
      const call = runOutcome(
        {
          last: true,
          status: 'purchase_declined',
          resource: '0197aaaa-bbbb-cccc-dddd-888888888888',
        },
        makeCtx(),
        { fetchImpl: fetch },
      );
      await expect(call).rejects.toMatchObject({ code: 'USAGE' });
      await expect(call).rejects.toThrow('0197aaaa-bbbb-cccc-dddd-888888888888');
      expect(urls).toHaveLength(0);
    });

    // Membership is not about price, so it cannot hang off purchase_declined:
    // the server drops an outcome naming an unsurfaced id whatever the status
    // says, and the CLI would report success for something nobody recorded.
    it('refuses an unsurfaced id on a CANDIDATES search for a non-decline status', async () => {
      await record({ decision: 'CANDIDATES', candidates: [CANDIDATE] });
      const { fetch, urls } = stub();
      const call = runOutcome(
        { last: true, status: 'used', resource: '0197aaaa-bbbb-cccc-dddd-888888888888' },
        makeCtx(),
        { fetchImpl: fetch },
      );
      await expect(call).rejects.toMatchObject({ code: 'USAGE' });
      await expect(call).rejects.toThrow('0197aaaa-bbbb-cccc-dddd-888888888888');
      expect(urls).toHaveLength(0);
    });

    // The price arm must not leak out of purchase_declined. A free piece really
    // is used, and reporting that is the honest thing this whole command exists
    // to collect.
    it('allows used on a known free candidate', async () => {
      await record({ decision: 'CANDIDATES', candidates: [FREE_CANDIDATE, CANDIDATE] });
      const { fetch, urls } = stub();
      await runOutcome(
        { last: true, status: 'used', resource: FREE_CANDIDATE.resourceId },
        makeCtx(),
        { fetchImpl: fetch },
      );
      expect(urls).toHaveLength(1);
    });

    // The MISS fail-open covers every status, not just the decline.
    it('passes through an unseen id on a MISS for a non-decline status', async () => {
      await record({ decision: 'MISS', paidBrowseCount: 0 });
      const { fetch, urls } = stub();
      await runOutcome(
        { last: true, status: 'used', resource: '0197aaaa-bbbb-cccc-dddd-888888888888' },
        makeCtx(),
        { fetchImpl: fetch },
      );
      expect(urls).toHaveLength(1);
    });

    // A MISS keeps the fail-open: its browse tail is payable and deliberately
    // never stored, so there an absent id is unknowable rather than wrong. It
    // falls back to the search's aggregate answer.
    it('passes through an id the store has never seen on a MISS', async () => {
      await record({ decision: 'MISS', paidBrowseCount: 2 });
      const { fetch, urls } = stub();
      await runOutcome(
        {
          last: true,
          status: 'purchase_declined',
          resource: '0197aaaa-bbbb-cccc-dddd-999999999999',
        },
        makeCtx(),
        { fetchImpl: fetch },
      );
      expect(urls).toHaveLength(1);
    });

    it('treats an unreadable stored price as unknown rather than free', async () => {
      await record({
        decision: 'CANDIDATES',
        candidates: [{ ...CANDIDATE, price: '-1' }],
        paidBrowseCount: 0,
      });
      const { fetch, urls } = stub();
      await runOutcome(
        { last: true, status: 'purchase_declined', resource: CANDIDATE.resourceId },
        makeCtx(),
        { fetchImpl: fetch },
      );
      expect(urls).toHaveLength(1);
    });
  });

  it('still fails an unknown status as unknown, not as incoherent', async () => {
    await record();
    const { fetch } = stub();
    await expect(
      runOutcome({ last: true, status: 'loved-it' }, makeCtx(), { fetchImpl: fetch }),
    ).rejects.toThrow('Invalid outcome status');
  });
});

// Our half of the merge: reporting an outcome is one of the three things that
// closes an open loop, so the Stop hook stops raising the search afterwards.
describe('runOutcome closes the open loop locally', () => {
  it('marks the search resolved, so the Stop hook stops raising it', async () => {
    await record();
    const { fetch } = stub();
    await runOutcome({ searchId: LOOKUP, status: 'regenerated' }, makeCtx(), { fetchImpl: fetch });
    expect((await loadSearches(dir))[0]?.resolved?.by).toBe('outcome');
  });

  it('marks the right search when --last resolved the target', async () => {
    await record();
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

  // Where the two halves of this merge actually meet: #106 refuses an incoherent
  // outcome BEFORE the request, so there is no report and the loop must stay open
  // for the Stop hook to raise. Marking on a refusal would silence a reminder for
  // a report that never happened.
  it('leaves the loop open when the coherence gate refused the report', async () => {
    await record({ decision: 'MISS', paidBrowseCount: 0 });
    const { fetch, urls } = stub();
    await expect(
      runOutcome({ last: true, status: 'purchase_declined' }, makeCtx(), { fetchImpl: fetch }),
    ).rejects.toMatchObject({ code: 'USAGE' });
    expect(urls).toHaveLength(0);
    expect((await loadSearches(dir))[0]?.resolved).toBeUndefined();
  });
});

// The other meeting point: a search the WebSearch hook recorded is an ordinary
// store entry, so #106's echo and coherence gate apply to it exactly as they do
// to a deliberate `tenjin search`, and reporting on it closes the loop. Reached
// by EXPLICIT --search-id only: `--last` skips hook entries, because in auto mode
// the hook prepends one on every web search and an unfiltered `--last` would
// re-target the agent's report at a ridealong query it never chose (found in
// dogfooding; the Stop hook's reminder hands the agent the explicit id).
describe('runOutcome over a websearch-hook-sourced search', () => {
  it('--last skips it and refuses when no deliberate search exists', async () => {
    await record({ source: 'websearch-hook', question: 'a query the hook rode along with' });
    const { fetch, urls } = stub();
    await expect(
      runOutcome({ last: true, status: 'regenerated' }, makeCtx(), { fetchImpl: fetch }),
    ).rejects.toMatchObject({ code: 'SEARCH_NOT_FOUND' });
    expect(urls).toHaveLength(0);
  });

  it('--last targets the deliberate search under a newer hook entry', async () => {
    await record({ question: 'the question the agent actually asked' });
    await record({
      source: 'websearch-hook',
      searchId: '0197aaaa-bbbb-cccc-dddd-222222222222',
      question: 'a query the hook rode along with',
    });
    const { fetch } = stub();
    const res = await runOutcome({ last: true, status: 'regenerated' }, makeCtx(), {
      fetchImpl: fetch,
    });
    expect(res.data).toMatchObject({ question: 'the question the agent actually asked' });
  });

  it('echoes it, resolves it, and keeps its source (by explicit --search-id)', async () => {
    await record({ source: 'websearch-hook', question: 'a query the hook rode along with' });
    const { fetch } = stub();
    const res = await runOutcome({ searchId: LOOKUP, status: 'regenerated' }, makeCtx(), {
      fetchImpl: fetch,
    });
    expect(res.data).toMatchObject({ question: 'a query the hook rode along with' });
    const [stored] = await loadSearches(dir);
    expect(stored?.resolved?.by).toBe('outcome');
    expect(stored?.source).toBe('websearch-hook');
  });

  it('refuses purchase_declined on one that offered nothing to buy', async () => {
    await record({ source: 'websearch-hook', decision: 'MISS', paidBrowseCount: 0 });
    const { fetch, urls } = stub();
    await expect(
      runOutcome({ searchId: LOOKUP, status: 'purchase_declined' }, makeCtx(), {
        fetchImpl: fetch,
      }),
    ).rejects.toMatchObject({ code: 'USAGE' });
    expect(urls).toHaveLength(0);
  });

  // The hook does not record `paidBrowseCount` (it would need a third mirrored
  // copy of the price predicate in a standalone script). Absent reads as unknown,
  // which is #106's documented fail-open: an honest report is never refused on a
  // guess. Pinned so a later change to the hook's writer is a deliberate one.
  it('fails open on a hook entry with no paidBrowseCount', async () => {
    await record({ source: 'websearch-hook', decision: 'MISS', paidBrowseCount: undefined });
    const { fetch, urls } = stub();
    const res = await runOutcome({ searchId: LOOKUP, status: 'purchase_declined' }, makeCtx(), {
      fetchImpl: fetch,
    });
    expect(res.data).toMatchObject({ status: 'purchase_declined' });
    expect(urls).toHaveLength(1);
  });
});

/** ONE STATUS, MANY SEARCHES: the two shapes that replace seventeen sequential
 *  closes, and the refusals that keep a blanket close from becoming a claim. */
describe('runOutcome, closing several searches at once', () => {
  const id = (n: number): string => `0197aaaa-bbbb-cccc-dddd-00000000000${n}`;

  async function seed(n: number, over: Partial<StoredSearch> = {}): Promise<string> {
    await recordSearch(dir, {
      searchId: id(n),
      at: new Date().toISOString(),
      question: `question ${n}`,
      decision: 'MISS',
      candidates: [],
      paidBrowseCount: 0,
      source: 'websearch-hook',
      ...over,
    });
    return id(n);
  }

  it('reports one status against every --search-id, and echoes each', async () => {
    await seed(1);
    await seed(2);
    const { fetch, urls } = stub();
    const res = await runOutcome({ searchId: [id(1), id(2)], status: 'regenerated' }, makeCtx(), {
      fetchImpl: fetch,
    });
    expect(urls).toHaveLength(2);
    expect(res.data).toMatchObject({ status: 'regenerated', closed: 2 });
    expect((res.data as { results: unknown[] }).results).toMatchObject([
      { searchId: id(1), accepted: 1, question: 'question 1' },
      { searchId: id(2), accepted: 1, question: 'question 2' },
    ]);
    const resolved = (await loadSearches(dir)).filter((s) => s.resolved?.by === 'outcome');
    expect(resolved).toHaveLength(2);
  });

  it('reports a repeated id once, not twice', async () => {
    await seed(1);
    const { fetch, urls } = stub();
    await runOutcome({ searchId: [id(1), id(1)], status: 'regenerated' }, makeCtx(), {
      fetchImpl: fetch,
    });
    expect(urls).toHaveLength(1);
  });

  it('keeps the single-search envelope every caller read before the batch', async () => {
    await seed(1);
    const { fetch } = stub();
    const res = await runOutcome({ searchId: [id(1)], status: 'regenerated' }, makeCtx(), {
      fetchImpl: fetch,
    });
    expect(res.data).toMatchObject({
      searchId: id(1),
      accepted: 1,
      question: 'question 1',
      closed: 1,
    });
  });

  it("--all-open closes the hook's open loops and leaves deliberate ones alone", async () => {
    await seed(1);
    await seed(2, { source: 'cli', question: 'a question I chose to ask' });
    await seed(3, { resolved: { by: 'publish', at: new Date().toISOString() } });
    const { fetch, urls } = stub();
    const res = await runOutcome({ allOpen: true, status: 'regenerated' }, makeCtx(), {
      fetchImpl: fetch,
    });
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain(id(1));
    expect(res.data).toMatchObject({ closed: 1, deliberateLeftOpen: 1 });
    expect(res.humanLines?.join('\n')).toContain('1 deliberate search(es) left open');
  });

  // The hook records CANDIDATES under the same source, and `regenerated` there
  // would overwrite the only positive attribution the loop collects.
  it('--all-open leaves a hook search Tenjin answered open, and counts it', async () => {
    await seed(1);
    await seed(2, { decision: 'CANDIDATES', candidates: [CANDIDATE] });
    const { fetch, urls } = stub();
    const res = await runOutcome({ allOpen: true, status: 'regenerated' }, makeCtx(), {
      fetchImpl: fetch,
    });
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain(id(1));
    expect(urls.join(' ')).not.toContain(id(2));
    expect(res.data).toMatchObject({ closed: 1, answeredLeftOpen: 1 });
    expect(res.humanLines?.join('\n')).toContain('1 hook search(es) Tenjin answered left open');
    const stored = await loadSearches(dir);
    expect(stored.find((s) => s.searchId === id(2))?.resolved).toBeUndefined();
  });

  // Per session by design: a session's loops are its own.
  it("--all-open sweeps this session's loops and never a sibling's", async () => {
    await seed(1, { sessionId: 'session-A' });
    await seed(2, { sessionId: 'session-B' });
    await seed(3);
    const { fetch, urls } = stub();
    const res = await runOutcome({ allOpen: true, status: 'regenerated' }, makeCtx(), {
      fetchImpl: fetch,
      env: { TENJIN_SESSION_ID: 'session-A' },
    });
    // This session's stamped entry and the unstamped one, never session-B's.
    expect(urls).toHaveLength(2);
    expect(urls.join(' ')).toContain(id(1));
    expect(urls.join(' ')).toContain(id(3));
    expect(urls.join(' ')).not.toContain(id(2));
    expect(res.data).toMatchObject({ closed: 2 });
    const stored = await loadSearches(dir);
    expect(stored.find((s) => s.searchId === id(2))?.resolved).toBeUndefined();
  });

  it('reads CLAUDE_CODE_SESSION_ID when no operator override is set', async () => {
    await seed(1, { sessionId: 'session-A' });
    await seed(2, { sessionId: 'session-B' });
    const { fetch, urls } = stub();
    await runOutcome({ allOpen: true, status: 'regenerated' }, makeCtx(), {
      fetchImpl: fetch,
      env: { CLAUDE_CODE_SESSION_ID: 'session-B' },
    });
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain(id(2));
  });

  // Raised in every session, so closable in every session: nothing strands.
  it('sweeps every open hook MISS when the harness names no session', async () => {
    await seed(1, { sessionId: 'session-A' });
    await seed(2);
    const { fetch, urls } = stub();
    await runOutcome({ allOpen: true, status: 'regenerated' }, makeCtx(), {
      fetchImpl: fetch,
      env: {},
    });
    expect(urls).toHaveLength(2);
  });

  // An entry written before sources existed was a deliberate search.
  it('--all-open leaves a sourceless entry open', async () => {
    await seed(1, { source: undefined });
    const { fetch, urls } = stub();
    const res = await runOutcome({ allOpen: true, status: 'regenerated' }, makeCtx(), {
      fetchImpl: fetch,
    });
    expect(urls).toHaveLength(0);
    expect(res.data).toMatchObject({ closed: 0, deliberateLeftOpen: 1 });
  });

  // A blanket `used` over queries nobody examined would be attribution the
  // marketplace is right to trust and wrong to believe.
  it.each(['used', 'partially_used', 'rejected', 'purchase_declined'])(
    '--all-open refuses --status %s before sending anything',
    async (status) => {
      await seed(1);
      const { fetch, urls } = stub();
      await expect(
        runOutcome({ allOpen: true, status }, makeCtx(), { fetchImpl: fetch }),
      ).rejects.toMatchObject({ code: 'USAGE' });
      expect(urls).toHaveLength(0);
    },
  );

  it.each([
    ['--search-id', { searchId: ['0197aaaa-bbbb-cccc-dddd-000000000001'] }],
    ['--last', { last: true }],
  ])('--all-open refuses to combine with %s', async (_label, over) => {
    await seed(1);
    const { fetch, urls } = stub();
    await expect(
      runOutcome({ allOpen: true, status: 'regenerated', ...over }, makeCtx(), {
        fetchImpl: fetch,
      }),
    ).rejects.toMatchObject({ code: 'USAGE' });
    expect(urls).toHaveLength(0);
  });

  it('--all-open with nothing open is a no-op, not an error', async () => {
    const { fetch, urls } = stub();
    const res = await runOutcome({ allOpen: true, status: 'regenerated' }, makeCtx(), {
      fetchImpl: fetch,
    });
    expect(urls).toHaveLength(0);
    expect(res.data).toMatchObject({ closed: 0 });
    expect(res.humanLines?.join('\n')).toContain('No open web-search loops in this session.');
  });

  it('refuses a --resource that cannot describe a batch', async () => {
    await seed(1);
    await seed(2);
    const { fetch, urls } = stub();
    await expect(
      runOutcome(
        { searchId: [id(1), id(2)], status: 'used', resource: CANDIDATE.resourceId },
        makeCtx(),
        { fetchImpl: fetch },
      ),
    ).rejects.toMatchObject({ code: 'USAGE' });
    expect(urls).toHaveLength(0);
  });

  // Otherwise a one-entry sweep attaches the resource to whatever it happened to
  // find, and a zero-entry sweep ignores it in silence.
  it('refuses --resource under --all-open, however many loops are open', async () => {
    await seed(1);
    const { fetch, urls } = stub();
    await expect(
      runOutcome(
        { allOpen: true, status: 'regenerated', resource: CANDIDATE.resourceId },
        makeCtx(),
        { fetchImpl: fetch },
      ),
    ).rejects.toMatchObject({ code: 'USAGE' });
    expect(urls).toHaveLength(0);
  });

  // Inside postOutcomes this check runs per id mid-batch, so a typo used to send
  // the ids before it and then fail as a network-class error nobody can retry.
  it('refuses a malformed id before any request, as USAGE', async () => {
    await seed(1);
    const { fetch, urls } = stub();
    const call = runOutcome({ searchId: [id(1), 'not-a-uuid'], status: 'regenerated' }, makeCtx(), {
      fetchImpl: fetch,
    });
    await expect(call).rejects.toMatchObject({ code: 'USAGE', exitCode: 2 });
    await expect(call).rejects.toThrow('not-a-uuid');
    expect(urls).toHaveLength(0);
  });

  // Half a report nobody meant to send is worse than none: the whole batch is
  // checked for coherence before the first request.
  it("refuses the whole batch when one target's status is incoherent", async () => {
    await seed(1, { decision: 'CANDIDATES', candidates: [CANDIDATE] });
    await seed(2);
    const { fetch, urls } = stub();
    await expect(
      runOutcome({ searchId: [id(1), id(2)], status: 'purchase_declined' }, makeCtx(), {
        fetchImpl: fetch,
      }),
    ).rejects.toMatchObject({ code: 'USAGE' });
    expect(urls).toHaveLength(0);
  });

  // Success would claim a close that never landed; failure alone hides the one
  // that did.
  it('names what closed and what failed when one id fails', async () => {
    await seed(1);
    await seed(2);
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(String(url));
      return String(url).includes(id(2))
        ? new Response('nope', { status: 500 })
        : new Response(JSON.stringify({ accepted: 1 }), {
            status: 202,
            headers: { 'content-type': 'application/json' },
          });
    }) as unknown as typeof fetch;
    const call = runOutcome({ searchId: [id(1), id(2)], status: 'regenerated' }, makeCtx(), {
      fetchImpl,
    });
    await expect(call).rejects.toMatchObject({
      details: {
        closed: 1,
        results: [
          { searchId: id(1), accepted: 1 },
          { searchId: id(2), accepted: 0 },
        ],
      },
    });
    expect(urls).toHaveLength(2);
    const stored = await loadSearches(dir);
    expect(stored.find((s) => s.searchId === id(1))?.resolved?.by).toBe('outcome');
    expect(stored.find((s) => s.searchId === id(2))?.resolved).toBeUndefined();
  });

  // The renderer prints `fix` and drops other shapes: ids must ride it.
  it('names the ids to retry in the fix line, not only in the envelope', async () => {
    await seed(1);
    await seed(2);
    const fetchImpl = (async (url: string) =>
      String(url).includes(id(2))
        ? new Response('nope', { status: 500 })
        : new Response(JSON.stringify({ accepted: 1 }), {
            status: 202,
            headers: { 'content-type': 'application/json' },
          })) as unknown as typeof fetch;
    const call = runOutcome({ searchId: [id(1), id(2)], status: 'regenerated' }, makeCtx(), {
      fetchImpl,
    });
    await expect(call).rejects.toMatchObject({ fix: `Retry with --search-id ${id(2)}` });
  });

  // One sweep can spend 50 of the 60/min budget. An open loop is the safe state:
  // the Stop hook raises it again.
  it('stops the sweep at the first rate limit and reports the rest untouched', async () => {
    for (const n of [1, 2, 3]) await seed(n);
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(String(url));
      return new Response('slow down', { status: 429, headers: { 'retry-after': '30' } });
    }) as unknown as typeof fetch;
    const call = runOutcome({ allOpen: true, status: 'regenerated' }, makeCtx(), { fetchImpl });
    await expect(call).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      details: { closed: 0 },
    });
    // One attempt, not three: the remainder never left the machine.
    expect(urls).toHaveLength(1);
    const stored = await loadSearches(dir);
    expect(stored.filter((s) => s.resolved !== undefined)).toHaveLength(0);
    const untouched = await call.catch(
      (e: { details: { results: { untouched?: true }[] } }) =>
        e.details.results.filter((r) => r.untouched === true).length,
    );
    expect(untouched).toBe(2);
  });

  // A transport failure is the server being unhealthy; a rejected id is not.
  it('keeps going past a failure that is about one id', async () => {
    for (const n of [1, 2, 3]) await seed(n);
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(String(url));
      return String(url).includes(id(2))
        ? new Response(JSON.stringify({ error: { message: 'no' } }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          })
        : new Response(JSON.stringify({ accepted: 1 }), {
            status: 202,
            headers: { 'content-type': 'application/json' },
          });
    }) as unknown as typeof fetch;
    await expect(
      runOutcome({ allOpen: true, status: 'regenerated' }, makeCtx(), { fetchImpl }),
    ).rejects.toMatchObject({ details: { closed: 2 } });
    expect(urls).toHaveLength(3);
  });
});

/**
 * TEAM-MODE ROUTING. A team-mode search asks the team shelf and falls through to
 * the public marketplace, and the two shelves have separate databases: the
 * searchId the public leg minted exists only there. A close posted to the
 * configured base is both a lie to the team shelf (which raises
 * `outcomes_dropped_no_parent`, its alarm for a broken fleet) and silence to the
 * marketplace whose demand signal is why the verb exists.
 */
describe('runOutcome routes to the shelf that answered', () => {
  const TEAM = 'https://team.example';
  const PUBLIC = 'https://public.example';
  const BYPASS_HEADER = 'x-vercel-protection-bypass';
  const SECRET = 'shelf-secret-abc123';

  interface Sent {
    url: string;
    headers: Record<string, string>;
  }

  function stubShelves(): { fetch: typeof fetch; sent: Sent[] } {
    const sent: Sent[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      sent.push({
        url: String(url),
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
      });
      return new Response(JSON.stringify({ accepted: 1 }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    return { fetch: fetchFn, sent };
  }

  /** No --base-url: the shelf config below decides where a close goes. */
  function teamCtx(): CommandContext {
    const sink = () => ({ write: () => true }) as unknown as NodeJS.WritableStream;
    return {
      flags: { json: false, timeout: 5000 },
      dataDir: dir,
      io: { stdout: sink(), stderr: sink(), isTTY: false },
    };
  }

  async function writeShelfConfig(): Promise<void> {
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ baseUrl: TEAM, publicShelfUrl: PUBLIC, shelfBypassSecret: SECRET }),
    );
  }

  it('posts a public-answered id to the public shelf, with no key', async () => {
    await writeShelfConfig();
    await record({ shelfBaseUrl: PUBLIC });
    const { fetch, sent } = stubShelves();

    await runOutcome({ searchId: LOOKUP, status: 'regenerated' }, teamCtx(), { fetchImpl: fetch });

    expect(sent).toHaveLength(1);
    expect(new URL(sent[0]!.url).origin).toBe(PUBLIC);
    // The door key is paired with the team origin, so the public shelf is told
    // nothing about it — the transport derives the header from the request URL,
    // and the route refuses to hand it over in the first place.
    expect(sent[0]!.headers[BYPASS_HEADER]).toBeUndefined();
    // Closed locally either way: the report landed.
    const stored = await loadSearches(dir);
    expect(stored[0]?.resolved?.by).toBe('outcome');
  });

  it('posts a team-answered id to the team shelf, with the key', async () => {
    await writeShelfConfig();
    await record({ shelfBaseUrl: TEAM });
    const { fetch, sent } = stubShelves();

    await runOutcome({ searchId: LOOKUP, status: 'used' }, teamCtx(), { fetchImpl: fetch });

    expect(new URL(sent[0]!.url).origin).toBe(TEAM);
    expect(sent[0]!.headers[BYPASS_HEADER]).toBe(SECRET);
  });

  it('falls back to the configured base for an entry written before the stamp', async () => {
    // Absent means the configured base, which is what those entries meant.
    await writeShelfConfig();
    await record();
    const { fetch, sent } = stubShelves();

    await runOutcome({ searchId: LOOKUP, status: 'used' }, teamCtx(), { fetchImpl: fetch });

    expect(new URL(sent[0]!.url).origin).toBe(TEAM);
    expect(sent[0]!.headers[BYPASS_HEADER]).toBe(SECRET);
  });

  it('refuses a foreign origin the config never named, and routes to the base instead', async () => {
    // `shelfBaseUrl` is an unvalidated optional string in the store schema and
    // the only writers are this CLI's own two configured values, so a third
    // origin is a planted or hand-edited row rather than a third shelf. Without
    // the allow-list one such row makes `outcome --search-id` POST the searchId
    // and status to a host the operator never configured. Fail open to the
    // configured shelf, never out to a foreign one.
    await writeShelfConfig();
    await record({ shelfBaseUrl: 'https://attacker.example' });
    const { fetch, sent } = stubShelves();

    await runOutcome({ searchId: LOOKUP, status: 'used' }, teamCtx(), { fetchImpl: fetch });

    expect(sent).toHaveLength(1);
    expect(new URL(sent[0]!.url).origin).not.toBe('https://attacker.example');
    expect(new URL(sent[0]!.url).origin).toBe(TEAM);
  });
});
