import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loopDbPath } from './paths';
import { withLoopDb } from './loop-db';
import {
  findSearchForResource,
  findStoredCandidate,
  getStoredSearch,
  linkSearchesToDraft,
  loadSearches,
  markSearchResolved,
  openSearches,
  recordSearch,
  searchesForDraft,
  searchFingerprint,
  type StoredSearch,
} from './searches';

/**
 * The CLI's search record, now on `loop.db`. Same rows, same semantics: these
 * came over with the code from the store this replaced, so a behaviour that
 * moved by accident fails here.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

let dataDir: string;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'tenjin-searches-'));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function agoIso(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

function entry(over: Partial<StoredSearch> = {}): StoredSearch {
  return {
    searchId: '0197aaaa-bbbb-cccc-dddd-000000000001',
    at: agoIso(60_000),
    question: 'q',
    decision: 'CANDIDATES',
    candidates: [
      { resourceId: 'res-1', url: 'https://x/api/read/a/b', title: 't', price: '100000' },
    ],
    ...over,
  };
}

/** Rows written straight through the file, for the volume cases: 500
 *  `recordSearch` calls would each open and close it. */
function seedRaw(count: number, id: (n: number) => string, at: (n: number) => number): void {
  withLoopDb(dataDir, (db) => {
    const stmt = db.prepare(
      `INSERT INTO searches (search_id, at, session, agent_id, question, fingerprint,
         decision, candidates, source, shelf_base_url, paid_browse_count)
       VALUES (?, ?, '', NULL, 'decoy', 'decoy', 'MISS', '[]', NULL, NULL, NULL)`,
    );
    for (let i = 0; i < count; i += 1) stmt.run(id(i), at(i));
  });
}

describe('recordSearch and the reads over it', () => {
  it('round-trips every field the commands read back', async () => {
    await recordSearch(
      dataDir,
      entry({
        source: 'cli',
        sessionId: 'session-a',
        agentId: 'agent-7',
        shelfBaseUrl: 'https://tenjin.blog',
        paidBrowseCount: 2,
      }),
    );
    const [stored] = await loadSearches(dataDir);
    expect(stored).toMatchObject({
      searchId: '0197aaaa-bbbb-cccc-dddd-000000000001',
      question: 'q',
      decision: 'CANDIDATES',
      source: 'cli',
      sessionId: 'session-a',
      agentId: 'agent-7',
      shelfBaseUrl: 'https://tenjin.blog',
      paidBrowseCount: 2,
    });
    expect(stored?.candidates).toEqual(entry().candidates);
  });

  // A turn-end ask reads this field to tell one session's open loops from a
  // sibling's; a shape that dropped it would silently un-scope every reminder.
  it('keeps a row with no sessionId loadable, with the field absent', async () => {
    await recordSearch(dataDir, entry({ sessionId: 'session-a' }));
    await recordSearch(
      dataDir,
      entry({ searchId: '0197aaaa-bbbb-cccc-dddd-000000000009', question: 'unstamped' }),
    );
    const loaded = await loadSearches(dataDir);
    expect(loaded).toHaveLength(2);
    expect(loaded.find((s) => s.question === 'unstamped')?.sessionId).toBeUndefined();
    expect(loaded.find((s) => s.sessionId !== undefined)?.sessionId).toBe('session-a');
  });

  it('records newest first', async () => {
    await recordSearch(dataDir, entry({ searchId: '0197aaaa-bbbb-cccc-dddd-000000000001' }));
    await recordSearch(
      dataDir,
      entry({ searchId: '0197aaaa-bbbb-cccc-dddd-000000000002', at: agoIso(0) }),
    );
    expect((await loadSearches(dataDir))[0]?.searchId).toBe('0197aaaa-bbbb-cccc-dddd-000000000002');
  });

  it('de-dupes a re-recorded searchId', async () => {
    await recordSearch(dataDir, entry());
    await recordSearch(dataDir, entry());
    expect(await loadSearches(dataDir)).toHaveLength(1);
  });

  it('reduces the question to a fingerprint the row carries', async () => {
    await recordSearch(dataDir, entry({ question: '  How   Do I ROTATE a key\n' }));
    expect(
      withLoopDb(dataDir, (db) => db.prepare('SELECT fingerprint FROM searches').get()),
    ).toMatchObject({ fingerprint: searchFingerprint('  How   Do I ROTATE a key\n') });
    expect(searchFingerprint('  How   Do I ROTATE a key\n')).toBe('how do i rotate a key');
  });

  it('round-trips paidBrowseCount and reads it as unknown on a row written without it', async () => {
    const id2 = '0197aaaa-bbbb-cccc-dddd-000000000002';
    await recordSearch(dataDir, entry({ decision: 'MISS', candidates: [], paidBrowseCount: 3 }));

    // A row recorded without the field stays `undefined` rather than defaulting
    // to 0: `outcome` refuses purchase_declined on a zero and must not invent
    // that refusal for a search that never recorded whether it had a payable
    // browse tail. The upsert also must not CLEAR a count a later re-record
    // omits, which is what the COALESCE in the statement is for.
    await recordSearch(dataDir, entry({ searchId: id2, decision: 'MISS', candidates: [] }));
    await recordSearch(dataDir, entry({ decision: 'MISS', candidates: [] }));
    const loaded = await loadSearches(dataDir);
    expect(loaded.find((s) => s.searchId === id2)?.paidBrowseCount).toBeUndefined();
    expect(loaded.find((s) => s.searchId !== id2)?.paidBrowseCount).toBe(3);
  });

  it('getStoredSearch is case-insensitive, and null for an id nothing recorded', async () => {
    await recordSearch(dataDir, entry({ searchId: '0197AAAA-BBBB-CCCC-DDDD-000000000012' }));
    expect((await getStoredSearch(dataDir, '0197aaaa-bbbb-cccc-dddd-000000000012'))?.question).toBe(
      'q',
    );
    expect(await getStoredSearch(dataDir, '0197ffff-ffff-4fff-8fff-ffffffffffff')).toBeNull();
  });
});

describe('resolving a resource through a stored candidate', () => {
  it('resolves a candidate url by resourceId (buy <id>)', async () => {
    await recordSearch(dataDir, entry());
    expect((await findStoredCandidate(dataDir, 'res-1'))?.url).toBe('https://x/api/read/a/b');
    expect((await findStoredCandidate(dataDir, 'res-1'))?.title).toBe('t');
    expect(await findStoredCandidate(dataDir, 'res-absent')).toBeNull();
  });

  /**
   * The candidate blob is JSON, and `json_each` is what keeps `buy <id>` off a
   * 500-row scan through every recent search's array. It has to answer both
   * questions the callers ask — by id and by url — and it has to prefer the
   * NEWEST search that carried the piece, since that is the attribution a
   * purchase belongs to.
   */
  it('finds the searchId that surfaced a resource, by id and by url, newest first', async () => {
    const older = '0197aaaa-bbbb-cccc-dddd-000000000010';
    const newer = '0197aaaa-bbbb-cccc-dddd-000000000011';
    await recordSearch(dataDir, entry({ searchId: older, at: agoIso(2 * DAY_MS) }));
    await recordSearch(dataDir, entry({ searchId: newer, at: agoIso(DAY_MS) }));
    expect(await findSearchForResource(dataDir, { resourceId: 'res-1' })).toBe(newer);
    expect(await findSearchForResource(dataDir, { url: 'https://x/api/read/a/b' })).toBe(newer);
    // An empty match is not a wildcard: a caller asking by url alone must not
    // match a candidate whose resourceId happens to be absent.
    expect(await findSearchForResource(dataDir, {})).toBeNull();
    expect(await findSearchForResource(dataDir, { resourceId: 'nope' })).toBeNull();
  });

  /**
   * The bound counts ROWS and not days ON PURPOSE. A date floor lived here for a
   * while, and it made `buy <resourceId>` fail by the calendar: a piece an agent
   * had deliberately parked stopped resolving a month later, reported as "No
   * local search knows resource …". Age alone must never cost a resolution.
   */
  it('reaches an ancient row, and stops at the row bound', async () => {
    const ancient = '0197aaaa-bbbb-cccc-dddd-000000000030';
    await recordSearch(dataDir, entry({ searchId: ancient, at: agoIso(400 * DAY_MS) }));
    expect(await findSearchForResource(dataDir, { resourceId: 'res-1' })).toBe(ancient);

    // 500 newer searches carrying nothing push it out of the window.
    seedRaw(
      500,
      (i) => `0197bbbb-cccc-dddd-eeee-${String(i).padStart(12, '0')}`,
      (i) => Date.now() - 300 * DAY_MS + i,
    );
    expect(await findSearchForResource(dataDir, { resourceId: 'res-1' })).toBeNull();
    expect(await findStoredCandidate(dataDir, 'res-1')).toBeNull();
  });
});

describe('openSearches', () => {
  /**
   * The ask scopes to the session that is closing, and an UNSTAMPED row belongs
   * to no session — scoping must never make a loop unreachable everywhere at
   * once, so it stays in every scope.
   */
  it('scopes to a session, keeps unstamped rows, and drops resolved ones', async () => {
    const mine = '0197aaaa-bbbb-cccc-dddd-000000000020';
    const theirs = '0197aaaa-bbbb-cccc-dddd-000000000021';
    const unstamped = '0197aaaa-bbbb-cccc-dddd-000000000022';
    const closed = '0197aaaa-bbbb-cccc-dddd-000000000023';
    await recordSearch(dataDir, entry({ searchId: mine, sessionId: 's1' }));
    await recordSearch(dataDir, entry({ searchId: theirs, sessionId: 's2' }));
    await recordSearch(dataDir, entry({ searchId: unstamped }));
    await recordSearch(dataDir, entry({ searchId: closed, sessionId: 's1' }));
    await markSearchResolved(dataDir, closed, 'outcome');

    expect((await openSearches(dataDir, 's1')).map((s) => s.searchId).sort()).toEqual(
      [mine, unstamped].sort(),
    );
    // No session named is every session.
    expect((await openSearches(dataDir)).map((s) => s.searchId).sort()).toEqual(
      [mine, theirs, unstamped].sort(),
    );
  });

  /** The table never prunes, so the bound belongs to the query. This one feeds a
   *  reminder, not a report: a machine with ten thousand unresolved rows must
   *  not pull them all into JS to render a line about the newest few. */
  it('stops at the row bound, newest first', async () => {
    seedRaw(
      505,
      (i) => `0197aaaa-bbbb-cccc-dddd-${String(i).padStart(12, '0')}`,
      (i) => Date.now() - i * 1000,
    );
    const open = await openSearches(dataDir);
    expect(open).toHaveLength(500);
    expect(open[0]?.searchId).toBe('0197aaaa-bbbb-cccc-dddd-000000000000');
  });
});

describe('markSearchResolved', () => {
  const ID = '0197aaaa-bbbb-cccc-dddd-000000000001';

  it('records who closed the loop, leaving everything else alone', async () => {
    await recordSearch(dataDir, entry({ decision: 'MISS' }));
    await markSearchResolved(dataDir, ID, 'publish', '2026-08-09T10:00:00.000Z');

    const [stored] = await loadSearches(dataDir);
    expect(stored?.resolved).toEqual({ by: 'publish', at: '2026-08-09T10:00:00.000Z' });
    expect(stored?.question).toBe(entry().question);
    expect(stored?.candidates).toEqual(entry().candidates);
  });

  // The lookup and the update have to agree on case, or the receipt lies: the
  // caller case-folds the id while the row carries the server's spelling, so an
  // update matching case-exactly closes nothing and still reports `resolved` —
  // and the ask then keeps raising a loop the agent was told was closed.
  it('closes a row recorded under a different case, and drops it from openSearches', async () => {
    const stored = '0197AAAA-BBBB-CCCC-DDDD-000000000031';
    const folded = '0197aaaa-bbbb-cccc-dddd-000000000031';
    await recordSearch(dataDir, entry({ searchId: stored, decision: 'MISS' }));
    await expect(markSearchResolved(dataDir, folded, 'outcome')).resolves.toBe('resolved');
    expect((await getStoredSearch(dataDir, folded))?.resolved?.by).toBe('outcome');
    expect(await openSearches(dataDir)).toEqual([]);
  });

  // The four outcomes, so a caller can tell "the loop is closed" from "I could
  // not close it" — the distinction publish's receipt is built on.
  it('reports resolved, then already-resolved, and never rewrites the first closer', async () => {
    await recordSearch(dataDir, entry());
    await expect(markSearchResolved(dataDir, ID, 'outcome')).resolves.toBe('resolved');
    await expect(markSearchResolved(dataDir, ID, 'publish')).resolves.toBe('already-resolved');
    expect((await loadSearches(dataDir))[0]?.resolved?.by).toBe('outcome');
  });

  // The #161 loop: a MISS closed as `regenerated` while the answer was still
  // being written, then published minutes later. The publish takes the loop over.
  it('relinks a resolution recorded by something else when asked', async () => {
    await recordSearch(dataDir, entry());
    await markSearchResolved(dataDir, ID, 'outcome', '2026-08-09T10:00:00.000Z');
    await expect(
      markSearchResolved(dataDir, ID, 'publish', '2026-08-09T11:00:00.000Z', { relink: true }),
    ).resolves.toBe('relinked');
    expect((await loadSearches(dataDir))[0]?.resolved).toEqual({
      by: 'publish',
      at: '2026-08-09T11:00:00.000Z',
    });
  });

  // Relinking is not re-stamping: the loop is already where it should be, so
  // nothing is written and nothing claims a change.
  it('reports already-resolved when the recorded closer is the same one', async () => {
    await recordSearch(dataDir, entry());
    await markSearchResolved(dataDir, ID, 'publish', '2026-08-09T10:00:00.000Z');
    await expect(
      markSearchResolved(dataDir, ID, 'publish', '2026-08-09T11:00:00.000Z', { relink: true }),
    ).resolves.toBe('already-resolved');
    expect((await loadSearches(dataDir))[0]?.resolved?.at).toBe('2026-08-09T10:00:00.000Z');
  });

  it('leaves the first resolution alone without the flag', async () => {
    await recordSearch(dataDir, entry());
    await markSearchResolved(dataDir, ID, 'publish', '2026-08-09T10:00:00.000Z');
    await expect(markSearchResolved(dataDir, ID, 'outcome')).resolves.toBe('already-resolved');
    expect((await loadSearches(dataDir))[0]?.resolved?.by).toBe('publish');
  });

  it('relinking an unclosed loop is an ordinary resolve', async () => {
    await recordSearch(dataDir, entry());
    await expect(
      markSearchResolved(dataDir, ID, 'publish', '2026-08-09T10:00:00.000Z', { relink: true }),
    ).resolves.toBe('resolved');
  });

  it('reports not-found for an id the store does not carry, and touches nothing', async () => {
    await recordSearch(dataDir, entry());
    await expect(
      markSearchResolved(dataDir, '0197ffff-ffff-4fff-8fff-ffffffffffff', 'publish'),
    ).resolves.toBe('not-found');
    expect((await loadSearches(dataDir))[0]?.resolved).toBeUndefined();
  });

  // Bookkeeping behind a verb the agent asked for, so it may never fail that
  // verb. With no data dir at all the honest answer is `not-found`: the file is
  // created the way every other write path creates it and simply holds no such
  // search.
  it('never throws, even with no store and no data dir', async () => {
    await rm(dataDir, { recursive: true, force: true });
    await expect(markSearchResolved(dataDir, ID, 'outcome')).resolves.toBe('not-found');
  });
});

/**
 * The claim a `publish --draft --search-id` withholds from the wire and parks
 * locally, and the promotion that reads it back. Both halves are here because
 * the two commands only ever meet in this record: publish writes the link, and
 * `edit --status published` is the only reader.
 */
describe('draft claims', () => {
  const ID = '0197aaaa-bbbb-cccc-dddd-000000000001';
  const ID2 = '0197aaaa-bbbb-cccc-dddd-000000000002';
  const DRAFT = '0197dddd-eeee-4fff-8aaa-bbbbbbbbbbbb';
  const OTHER_DRAFT = '0197dddd-eeee-4fff-8aaa-cccccccccccc';

  it('parks the withheld claim and hands it back for the promotion', async () => {
    await recordSearch(dataDir, entry());
    await linkSearchesToDraft(dataDir, [ID], DRAFT);
    const parked = await searchesForDraft(dataDir, DRAFT);
    expect(parked.map((s) => s.searchId)).toEqual([ID]);
    expect(parked[0]?.draftPostId).toBe(DRAFT);
    expect(await searchesForDraft(dataDir, OTHER_DRAFT)).toEqual([]);
  });

  // The link is a `facts` row, so every `loadSearches` caller reaches it through
  // the LEFT JOIN: it must carry the link where there is one and drop neither
  // the unlinked rows nor a row's own identity where there is not.
  it('rides loadSearches through the LEFT JOIN without dropping or duplicating a row', async () => {
    await recordSearch(dataDir, entry());
    await recordSearch(dataDir, entry({ searchId: ID2, question: 'unlinked' }));
    await linkSearchesToDraft(dataDir, [ID], DRAFT);
    const loaded = await loadSearches(dataDir);
    expect(loaded).toHaveLength(2);
    expect(loaded.find((s) => s.searchId === ID)?.draftPostId).toBe(DRAFT);
    expect(loaded.find((s) => s.searchId === ID2)?.draftPostId).toBeUndefined();
  });

  // A link to a row this record never held would never be read back, since
  // `searchesForDraft` joins on the searches table. Refused at the write.
  it('writes nothing for a searchId this machine never recorded', async () => {
    await recordSearch(dataDir, entry());
    await linkSearchesToDraft(dataDir, ['0197aaaa-bbbb-cccc-dddd-000000000099'], DRAFT);
    expect(await searchesForDraft(dataDir, DRAFT)).toEqual([]);
    expect((await loadSearches(dataDir))[0]?.draftPostId).toBeUndefined();
  });

  // The command edge takes a post id in either case and SQLite compares text as
  // bytes, so without the fold `edit 0197DDDD-… --status published` would find no
  // claim and lose the attribution behind a successful receipt.
  it('matches a post id in either case, in both directions', async () => {
    await recordSearch(dataDir, entry());
    await recordSearch(dataDir, entry({ searchId: ID2, question: 'parked in caps' }));
    await linkSearchesToDraft(dataDir, [ID], DRAFT);
    await linkSearchesToDraft(dataDir, [ID2], OTHER_DRAFT.toUpperCase());

    expect((await searchesForDraft(dataDir, DRAFT.toUpperCase())).map((s) => s.searchId)).toEqual([
      ID,
    ]);
    expect((await searchesForDraft(dataDir, OTHER_DRAFT)).map((s) => s.searchId)).toEqual([ID2]);
    // One spelling on the way out too, so nothing downstream echoes a post id in
    // a case the record does not hold.
    expect((await loadSearches(dataDir)).find((s) => s.searchId === ID2)?.draftPostId).toBe(
      OTHER_DRAFT,
    );
  });

  // Resolved entries are returned ON PURPOSE: an `outcome` that closed the loop
  // first does not change who ended up answering it, and the promotion is the
  // publish arriving late. This is the only route to a `relinked` receipt.
  it('includes a search something else already closed', async () => {
    await recordSearch(dataDir, entry());
    await linkSearchesToDraft(dataDir, [ID], DRAFT);
    await markSearchResolved(dataDir, ID, 'outcome', '2026-08-09T10:00:00.000Z');
    const parked = await searchesForDraft(dataDir, DRAFT);
    expect(parked.map((s) => s.searchId)).toEqual([ID]);
    expect(parked[0]?.resolved?.by).toBe('outcome');
    await expect(
      markSearchResolved(dataDir, ID, 'publish', '2026-08-09T11:00:00.000Z', { relink: true }),
    ).resolves.toBe('relinked');
  });

  it('records the link in one call when the caller already knows it', async () => {
    await recordSearch(dataDir, entry({ draftPostId: DRAFT.toUpperCase() }));
    expect((await searchesForDraft(dataDir, DRAFT)).map((s) => s.searchId)).toEqual([ID]);
  });
});

/**
 * Bookkeeping behind a verb the agent asked for: a file that will not open costs
 * a stale reminder, never the publish that already landed or the search that was
 * already paid for. Every read answers empty and every write answers what it
 * actually did.
 */
describe('a loop.db that cannot be read', () => {
  const ID = '0197aaaa-bbbb-cccc-dddd-000000000001';

  beforeEach(async () => {
    await writeFile(loopDbPath(dataDir), 'not a database', 'utf8');
  });

  it('reads empty and never throws', async () => {
    expect(await loadSearches(dataDir)).toEqual([]);
    expect(await openSearches(dataDir)).toEqual([]);
    expect(await getStoredSearch(dataDir, ID)).toBeNull();
    expect(await findStoredCandidate(dataDir, 'res-1')).toBeNull();
    expect(await findSearchForResource(dataDir, { resourceId: 'res-1' })).toBeNull();
    expect(await searchesForDraft(dataDir, ID)).toEqual([]);
  });

  it('writes nothing and says so rather than claiming a close', async () => {
    await expect(recordSearch(dataDir, entry())).resolves.toBeUndefined();
    await expect(markSearchResolved(dataDir, ID, 'outcome')).resolves.toBe('failed');
    await expect(linkSearchesToDraft(dataDir, [ID], ID)).resolves.toBeUndefined();
  });
});
