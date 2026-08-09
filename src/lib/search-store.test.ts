import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findSearchForResource,
  findStoredCandidate,
  latestSearch,
  loadSearches,
  markSearchResolved,
  recordSearch,
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
  it('records newest-first and latestSearch returns the most recent', async () => {
    await recordSearch(dir, entry({ searchId: '0197aaaa-bbbb-cccc-dddd-000000000001' }));
    await recordSearch(dir, entry({ searchId: '0197aaaa-bbbb-cccc-dddd-000000000002' }));
    const latest = await latestSearch(dir);
    expect(latest?.searchId).toBe('0197aaaa-bbbb-cccc-dddd-000000000002');
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
  it('never throws, even with no store and no data dir', async () => {
    await rm(dir, { recursive: true, force: true });
    await expect(markSearchResolved(dir, ID, 'candidate')).resolves.toBeUndefined();
  });

  it('leaves a corrupt store readable-as-empty rather than throwing', async () => {
    await writeFile(join(dir, 'searches.json'), 'not json', 'utf8');
    await expect(markSearchResolved(dir, ID, 'outcome')).resolves.toBeUndefined();
    expect(await loadSearches(dir)).toEqual([]);
  });

  it('round-trips through the schema, so a resolved entry still loads', async () => {
    await recordSearch(dir, entry());
    await markSearchResolved(dir, ID, 'candidate');
    expect(await latestSearch(dir)).toMatchObject({ searchId: ID, resolved: { by: 'candidate' } });
  });
});
