import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findSearchForResource,
  findStoredCandidate,
  latestSearch,
  loadSearches,
  markSearchResolved,
  recordSearch,
  searchStoreLockPath,
  type StoredSearch,
} from './search-store';

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
    await recordSearch(dir, entry({ decision: 'MISS', candidates: [], paidBrowseCount: 3 }));
    expect((await latestSearch(dir))?.paidBrowseCount).toBe(3);

    // A store written by a CLI from before the field. It must still load, and the
    // missing count must stay `undefined` rather than default to 0: `outcome`
    // refuses purchase_declined on a zero and must not invent that refusal for an
    // entry that never recorded whether it had a payable browse tail.
    const legacy = {
      schemaVersion: 1,
      searches: [{ ...entry({ decision: 'MISS', candidates: [] }) }],
    };
    await writeFile(join(dir, 'searches.json'), JSON.stringify(legacy), 'utf8');
    const loaded = await loadSearches(dir);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.paidBrowseCount).toBeUndefined();
  });

  it('reads empty (never throws) on a corrupt store', async () => {
    await writeFile(join(dir, 'searches.json'), 'not json', 'utf8');
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
  it('never throws, even with no store and no data dir', async () => {
    await rm(dir, { recursive: true, force: true });
    await expect(markSearchResolved(dir, ID, 'candidate')).resolves.toBe('failed');
  });

  it('leaves a corrupt store readable-as-empty rather than throwing', async () => {
    await writeFile(join(dir, 'searches.json'), 'not json', 'utf8');
    await expect(markSearchResolved(dir, ID, 'outcome')).resolves.toBe('not-found');
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

  // A lock nobody releases: the write cannot happen, and the caller is told so
  // rather than being handed a silent success. Slow by construction (the lock
  // timeout is 5s), which is why it is the only test that waits.
  it('reports failed when the store lock cannot be taken', async () => {
    await recordSearch(dir, entry());
    await mkdir(searchStoreLockPath(dir), { recursive: true });
    try {
      await expect(markSearchResolved(dir, ID, 'publish')).resolves.toBe('failed');
      expect((await loadSearches(dir))[0]?.resolved).toBeUndefined();
    } finally {
      await rm(searchStoreLockPath(dir), { recursive: true, force: true });
    }
  }, 15_000);

  it('round-trips through the schema, so a resolved entry still loads', async () => {
    await recordSearch(dir, entry());
    await markSearchResolved(dir, ID, 'candidate');
    expect(await latestSearch(dir)).toMatchObject({ searchId: ID, resolved: { by: 'candidate' } });
  });
});
