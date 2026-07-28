import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findSearchForResource,
  findStoredCandidate,
  latestSearch,
  loadSearches,
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
