import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findSearchForResource,
  findStoredCandidate,
  latestSearch,
  linkSearchesToDraft,
  loadSearches,
  markSearchResolved,
  recordSearch,
  searchesForDraft,
  type StoredSearch,
} from './search-store';
import { STATE_DB_FILE } from './state-store';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-lstore-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function entry(over: Partial<StoredSearch> = {}): StoredSearch {
  return {
    searchId: '0197aaaa-bbbb-cccc-dddd-000000000001',
    at: '2026-07-18T00:00:00.000Z',
    question: 'q',
    decision: 'CANDIDATES',
    candidates: [
      { resourceId: 'res-1', url: 'https://x/api/read/a/b', title: 't', price: '100000' },
    ],
    ...over,
  };
}

describe('search-store', () => {
  // The Stop hook reads this field to tell one session's open loops from a
  // sibling's; a schema that dropped it would silently un-scope every nag.
  it('round-trips a sessionId, and an entry without one still loads', async () => {
    await recordSearch(dir, entry({ sessionId: 'session-a' }));
    await recordSearch(
      dir,
      entry({ searchId: '0197aaaa-bbbb-cccc-dddd-000000000009', question: 'unstamped' }),
    );
    const loaded = await loadSearches(dir);
    expect(loaded).toHaveLength(2);
    expect(loaded.find((s) => s.question === 'unstamped')?.sessionId).toBeUndefined();
    expect(loaded.find((s) => s.sessionId !== undefined)?.sessionId).toBe('session-a');
  });

  it('records newest-first and latestSearch returns the most recent', async () => {
    await recordSearch(dir, entry({ searchId: '0197aaaa-bbbb-cccc-dddd-000000000001' }));
    await recordSearch(dir, entry({ searchId: '0197aaaa-bbbb-cccc-dddd-000000000002' }));
    const latest = await latestSearch(dir);
    expect(latest?.searchId).toBe('0197aaaa-bbbb-cccc-dddd-000000000002');
  });

  // `--last` means "the search I just ran". In auto mode the WebSearch hook
  // prepends an entry on EVERY web search, so without the source filter an
  // `outcome --last` after any web search would report against a ridealong query
  // the agent never chose (found in dogfooding).
  it('latestSearch skips hook-sourced entries: --last targets the last deliberate search', async () => {
    await recordSearch(dir, entry({ searchId: '0197aaaa-bbbb-cccc-dddd-000000000003' }));
    await recordSearch(
      dir,
      entry({ searchId: '0197aaaa-bbbb-cccc-dddd-000000000004', source: 'websearch-hook' }),
    );
    const latest = await latestSearch(dir);
    expect(latest?.searchId).toBe('0197aaaa-bbbb-cccc-dddd-000000000003');
  });

  it('latestSearch is null when only hook-sourced entries exist', async () => {
    await recordSearch(
      dir,
      entry({ searchId: '0197aaaa-bbbb-cccc-dddd-000000000005', source: 'websearch-hook' }),
    );
    expect(await latestSearch(dir)).toBeNull();
  });

  // The demand arm records what an agent was ABOUT to research, which is even
  // further from "the search I just ran" than a ridealong web search is.
  it('round-trips the dispatch source, and --last skips it too', async () => {
    await recordSearch(dir, entry({ searchId: '0197aaaa-bbbb-cccc-dddd-000000000006' }));
    await recordSearch(
      dir,
      entry({ searchId: '0197aaaa-bbbb-cccc-dddd-000000000007', source: 'dispatch-hook' }),
    );
    const loaded = await loadSearches(dir);
    expect(loaded.map((s) => s.source)).toContain('dispatch-hook');
    expect((await latestSearch(dir))?.searchId).toBe('0197aaaa-bbbb-cccc-dddd-000000000006');
  });

  it('resolves a candidate url by resourceId (buy <id>)', async () => {
    await recordSearch(dir, entry());
    const hit = await findStoredCandidate(dir, 'res-1');
    expect(hit?.url).toBe('https://x/api/read/a/b');
  });

  it('finds the searchId that surfaced a resource (attribution)', async () => {
    await recordSearch(dir, entry({ searchId: '0197aaaa-bbbb-cccc-dddd-000000000009' }));
    expect(await findSearchForResource(dir, { resourceId: 'res-1' })).toBe(
      '0197aaaa-bbbb-cccc-dddd-000000000009',
    );
    expect(await findSearchForResource(dir, { url: 'https://x/api/read/a/b' })).toBe(
      '0197aaaa-bbbb-cccc-dddd-000000000009',
    );
    expect(await findSearchForResource(dir, { resourceId: 'nope' })).toBeNull();
  });

  it('de-dupes a re-recorded searchId', async () => {
    await recordSearch(dir, entry());
    await recordSearch(dir, entry());
    expect(await loadSearches(dir)).toHaveLength(1);
  });

  it('round-trips paidBrowseCount and reads it as unknown on an entry written without it', async () => {
    const id2 = '0197aaaa-bbbb-cccc-dddd-000000000002';
    await recordSearch(dir, entry({ decision: 'MISS', candidates: [], paidBrowseCount: 3 }));
    expect((await latestSearch(dir))?.paidBrowseCount).toBe(3);

    // A row recorded without the field must stay `undefined` rather than default
    // to 0: `outcome` refuses purchase_declined on a zero and must not invent
    // that refusal for a search that never recorded whether it had a payable
    // browse tail. The upsert also must not CLEAR a count a later re-record
    // omits, which is what the COALESCE in the statement is for.
    await recordSearch(dir, entry({ searchId: id2, decision: 'MISS', candidates: [] }));
    const loaded = await loadSearches(dir);
    expect(loaded.find((s) => s.searchId === id2)?.paidBrowseCount).toBeUndefined();
    await recordSearch(dir, entry({ decision: 'MISS', candidates: [] }));
    expect(loaded.find((s) => s.searchId !== id2)?.paidBrowseCount).toBe(3);
  });

  it('reads empty (never throws) on a corrupt store', async () => {
    await writeFile(join(dir, STATE_DB_FILE), 'not a database', 'utf8');
    expect(await loadSearches(dir)).toEqual([]);
  });
});

describe('markSearchResolved', () => {
  const ID = '0197aaaa-bbbb-cccc-dddd-000000000001';

  it('records who closed the loop, leaving everything else alone', async () => {
    await recordSearch(dir, entry({ decision: 'MISS' }));
    await markSearchResolved(dir, ID, 'publish', '2026-08-09T10:00:00.000Z');

    const [stored] = await loadSearches(dir);
    expect(stored?.resolved).toEqual({ by: 'publish', at: '2026-08-09T10:00:00.000Z' });
    expect(stored?.question).toBe(entry().question);
    expect(stored?.candidates).toEqual(entry().candidates);
  });

  // A publish after an outcome report is still one closed loop; rewriting who
  // closed it would lose the fact that the reuse signal was already sent.
  it('keeps the first resolution and ignores later ones', async () => {
    await recordSearch(dir, entry());
    await markSearchResolved(dir, ID, 'outcome', '2026-08-09T10:00:00.000Z');
    await markSearchResolved(dir, ID, 'publish', '2026-08-09T11:00:00.000Z');
    expect((await loadSearches(dir))[0]?.resolved?.by).toBe('outcome');
  });

  it('touches nothing for a searchId this machine never recorded', async () => {
    await recordSearch(dir, entry());
    await markSearchResolved(dir, '0197aaaa-bbbb-cccc-dddd-000000000099', 'outcome');
    expect((await loadSearches(dir))[0]?.resolved).toBeUndefined();
  });

  // It is bookkeeping for a hook nudge, so it may never fail the verb that ran.
  // It still SAYS what happened, so a caller that reports the close does not
  // report one that did not land.
  // Bookkeeping for a hook nudge, so it may never fail the verb that ran. It
  // still SAYS what happened, so a caller that reports the close does not report
  // one that did not land — and with no data dir at all the honest answer is
  // `not-found` rather than `failed`: the store opens (creating the dir the way
  // every other write path does) and simply holds no such search. `failed` is
  // the answer when the store itself cannot be opened, which is the case below.
  it('never throws, even with no store and no data dir', async () => {
    await rm(dir, { recursive: true, force: true });
    await expect(markSearchResolved(dir, ID, 'candidate')).resolves.toBe('not-found');
  });

  it('leaves a corrupt store readable-as-empty rather than throwing', async () => {
    await writeFile(join(dir, STATE_DB_FILE), 'not a database', 'utf8');
    await expect(markSearchResolved(dir, ID, 'outcome')).resolves.toBe('failed');
    expect(await loadSearches(dir)).toEqual([]);
  });

  // The four outcomes, so a caller can tell "the loop is closed" from "I could
  // not close it" — the distinction publish's receipt is built on.
  it('reports resolved, then already-resolved, and never rewrites the first closer', async () => {
    await recordSearch(dir, entry());
    await expect(markSearchResolved(dir, ID, 'outcome')).resolves.toBe('resolved');
    await expect(markSearchResolved(dir, ID, 'publish')).resolves.toBe('already-resolved');
    expect((await loadSearches(dir))[0]?.resolved?.by).toBe('outcome');
  });

  // The #161 loop: a MISS closed as `regenerated` while the answer was still
  // being written, then published minutes later. The publish takes the loop over.
  it('relinks a resolution recorded by something else when asked', async () => {
    await recordSearch(dir, entry());
    await markSearchResolved(dir, ID, 'outcome', '2026-08-09T10:00:00.000Z');
    await expect(
      markSearchResolved(dir, ID, 'publish', '2026-08-09T11:00:00.000Z', { relink: true }),
    ).resolves.toBe('relinked');
    expect((await loadSearches(dir))[0]?.resolved).toEqual({
      by: 'publish',
      at: '2026-08-09T11:00:00.000Z',
    });
  });

  // Relinking is not re-stamping: the loop is already where it should be, so
  // nothing is written and nothing claims a change.
  it('reports already-resolved when the recorded closer is the same one', async () => {
    await recordSearch(dir, entry());
    await markSearchResolved(dir, ID, 'publish', '2026-08-09T10:00:00.000Z');
    await expect(
      markSearchResolved(dir, ID, 'publish', '2026-08-09T11:00:00.000Z', { relink: true }),
    ).resolves.toBe('already-resolved');
    expect((await loadSearches(dir))[0]?.resolved?.at).toBe('2026-08-09T10:00:00.000Z');
  });

  // The flag is opt-in, so an ordinary outcome report after a publish still
  // leaves the publish as the closer.
  it('leaves the first resolution alone without the flag', async () => {
    await recordSearch(dir, entry());
    await markSearchResolved(dir, ID, 'publish', '2026-08-09T10:00:00.000Z');
    await expect(markSearchResolved(dir, ID, 'outcome')).resolves.toBe('already-resolved');
    expect((await loadSearches(dir))[0]?.resolved?.by).toBe('publish');
  });

  it('relinking an unclosed loop is an ordinary resolve', async () => {
    await recordSearch(dir, entry());
    await expect(
      markSearchResolved(dir, ID, 'publish', '2026-08-09T10:00:00.000Z', { relink: true }),
    ).resolves.toBe('resolved');
  });

  it('reports not-found for an id the store does not carry', async () => {
    await recordSearch(dir, entry());
    await expect(
      markSearchResolved(dir, '0197ffff-ffff-4fff-8fff-ffffffffffff', 'publish'),
    ).resolves.toBe('not-found');
  });

  // The write cannot happen, and the caller is told so rather than being handed
  // a silent success. This used to be a lock nobody released, and it was the one
  // test in the file that had to wait out a 5s timeout; there is no lock any
  // more, so an unopenable store stands in for the same condition instantly.
  it('reports failed when the store cannot be opened', async () => {
    await rm(join(dir, STATE_DB_FILE), { force: true });
    await writeFile(join(dir, STATE_DB_FILE), 'not a database', 'utf8');
    await expect(markSearchResolved(dir, ID, 'publish')).resolves.toBe('failed');
  });

  it('round-trips through the schema, so a resolved entry still loads', async () => {
    await recordSearch(dir, entry());
    await markSearchResolved(dir, ID, 'candidate');
    expect(await latestSearch(dir)).toMatchObject({ searchId: ID, resolved: { by: 'candidate' } });
  });
});

/**
 * The claim a `publish --draft --search-id` withholds from the wire and parks
 * locally, and the promotion that reads it back. Both halves live here because
 * the two commands only ever meet in this store: publish writes the link, and
 * `edit --status published` is the only reader.
 */
describe('draft claims', () => {
  const ID = '0197aaaa-bbbb-cccc-dddd-000000000001';
  const ID2 = '0197aaaa-bbbb-cccc-dddd-000000000002';
  const DRAFT = '0197dddd-eeee-4fff-8aaa-bbbbbbbbbbbb';
  const OTHER_DRAFT = '0197dddd-eeee-4fff-8aaa-cccccccccccc';

  it('parks the withheld claim and hands it back for the promotion', async () => {
    await recordSearch(dir, entry());
    await linkSearchesToDraft(dir, [ID], DRAFT);
    const parked = await searchesForDraft(dir, DRAFT);
    expect(parked.map((s) => s.searchId)).toEqual([ID]);
    expect(parked[0]?.draftPostId).toBe(DRAFT);
    expect(await searchesForDraft(dir, OTHER_DRAFT)).toEqual([]);
  });

  // The link is a session_state row, so every `loadSearches` caller reaches it
  // through the LEFT JOIN: it must carry the link where there is one and drop
  // neither the unlinked rows nor a row's own identity where there is not.
  it('rides loadSearches through the LEFT JOIN without dropping or duplicating a row', async () => {
    await recordSearch(dir, entry());
    await recordSearch(dir, entry({ searchId: ID2, question: 'unlinked' }));
    await linkSearchesToDraft(dir, [ID], DRAFT);
    const loaded = await loadSearches(dir);
    expect(loaded).toHaveLength(2);
    expect(loaded.find((s) => s.searchId === ID)?.draftPostId).toBe(DRAFT);
    expect(loaded.find((s) => s.searchId === ID2)?.draftPostId).toBeUndefined();
  });

  // A link to a row this ledger never recorded would never be read back, since
  // `searchesForDraft` joins on the searches table. Refused at the write.
  it('writes nothing for a searchId this machine never recorded', async () => {
    await recordSearch(dir, entry());
    await linkSearchesToDraft(dir, ['0197aaaa-bbbb-cccc-dddd-000000000099'], DRAFT);
    expect(await searchesForDraft(dir, DRAFT)).toEqual([]);
    expect((await loadSearches(dir))[0]?.draftPostId).toBeUndefined();
  });

  // `UUID_RE` takes a post id in either case and SQLite compares text as bytes,
  // so without the fold `edit 0197DDDD-… --status published` would find no
  // claim and lose the attribution behind a successful receipt.
  it('matches a post id in either case, in both directions', async () => {
    await recordSearch(dir, entry());
    await recordSearch(dir, entry({ searchId: ID2, question: 'parked in caps' }));
    await linkSearchesToDraft(dir, [ID], DRAFT);
    await linkSearchesToDraft(dir, [ID2], OTHER_DRAFT.toUpperCase());

    expect((await searchesForDraft(dir, DRAFT.toUpperCase())).map((s) => s.searchId)).toEqual([ID]);
    expect((await searchesForDraft(dir, OTHER_DRAFT)).map((s) => s.searchId)).toEqual([ID2]);
    // One spelling on the way out too, so nothing downstream echoes a post id
    // in a case the store does not hold.
    expect((await loadSearches(dir)).find((s) => s.searchId === ID2)?.draftPostId).toBe(
      OTHER_DRAFT,
    );
  });

  // Resolved entries are returned ON PURPOSE: an `outcome` that closed the loop
  // first does not change who ended up answering it, and the promotion is the
  // publish arriving late. This is the only route to a `relinked` receipt.
  it('includes a search something else already closed', async () => {
    await recordSearch(dir, entry());
    await linkSearchesToDraft(dir, [ID], DRAFT);
    await markSearchResolved(dir, ID, 'outcome', '2026-08-09T10:00:00.000Z');
    const parked = await searchesForDraft(dir, DRAFT);
    expect(parked.map((s) => s.searchId)).toEqual([ID]);
    expect(parked[0]?.resolved?.by).toBe('outcome');
    await expect(
      markSearchResolved(dir, ID, 'publish', '2026-08-09T11:00:00.000Z', { relink: true }),
    ).resolves.toBe('relinked');
  });

  it('records the link in one call when the caller already knows it', async () => {
    await recordSearch(dir, entry({ draftPostId: DRAFT.toUpperCase() }));
    expect((await searchesForDraft(dir, DRAFT)).map((s) => s.searchId)).toEqual([ID]);
  });

  it('never throws on a corrupt store, in either direction', async () => {
    await writeFile(join(dir, STATE_DB_FILE), 'not a database', 'utf8');
    await expect(linkSearchesToDraft(dir, [ID], DRAFT)).resolves.toBeUndefined();
    await expect(searchesForDraft(dir, DRAFT)).resolves.toEqual([]);
  });
});

/**
 * What the 50-entry cap and the demand budget existed to protect.
 *
 * searches.json held 50 entries, so a wide subagent fan-out drained the slots
 * `buy <resourceId>` and `outcome --last` depend on; the answer was a
 * hand-rolled budget capping the two demand sources at 15 between them, written
 * twice — here and in the generated hook — so the bound belonged to the store
 * rather than to whichever process wrote last.
 *
 * The store is unbounded (plan 03, owner decision 2: no retention, no pruning),
 * so nothing evicts anything and both copies of the budget are gone. These pin
 * the property, not the mechanism.
 */
describe('search-store: a demand flood costs a deliberate search nothing', () => {
  const id = (n: number): string => `0197aaaa-bbbb-cccc-dddd-${String(n).padStart(12, '0')}`;

  it('keeps the deliberate entry, its candidate, and `--last`, under a 60-deep flood', async () => {
    const deliberate = entry({ searchId: id(1), source: 'cli' });
    await recordSearch(dir, deliberate);
    for (let i = 0; i < 60; i += 1) {
      await recordSearch(
        dir,
        entry({
          searchId: id(100 + i),
          source: 'dispatch-hook',
          at: new Date(Date.now() - (60 - i) * 1000).toISOString(),
          candidates: [],
        }),
      );
    }

    const loaded = await loadSearches(dir);
    expect(loaded.map((s) => s.searchId)).toContain(id(1));
    expect(loaded.filter((s) => s.source === 'dispatch-hook')).toHaveLength(60);
    // Still resolvable, which is what the slot was being taken from.
    expect(await findStoredCandidate(dir, 'res-1')).not.toBeNull();
    expect(await findSearchForResource(dir, { resourceId: 'res-1' })).toBe(id(1));
    // And `--last` still means "the search I ran", not the newest fan-out row.
    expect((await latestSearch(dir))?.searchId).toBe(id(1));
  });
});
