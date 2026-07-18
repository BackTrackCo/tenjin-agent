import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findLookupForResource,
  findStoredCandidate,
  latestLookup,
  loadLookups,
  recordLookup,
  type StoredLookup,
} from './lookup-store';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-lstore-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function entry(over: Partial<StoredLookup> = {}): StoredLookup {
  return {
    lookupId: '0197aaaa-bbbb-cccc-dddd-000000000001',
    at: '2026-07-18T00:00:00.000Z',
    question: 'q',
    decision: 'CANDIDATES',
    candidates: [
      { resourceId: 'res-1', url: 'https://x/api/read/a/b', title: 't', price: '100000' },
    ],
    ...over,
  };
}

describe('lookup-store', () => {
  it('records newest-first and latestLookup returns the most recent', async () => {
    await recordLookup(dir, entry({ lookupId: '0197aaaa-bbbb-cccc-dddd-000000000001' }));
    await recordLookup(dir, entry({ lookupId: '0197aaaa-bbbb-cccc-dddd-000000000002' }));
    const latest = await latestLookup(dir);
    expect(latest?.lookupId).toBe('0197aaaa-bbbb-cccc-dddd-000000000002');
  });

  it('resolves a candidate url by resourceId (buy <id>)', async () => {
    await recordLookup(dir, entry());
    const hit = await findStoredCandidate(dir, 'res-1');
    expect(hit?.url).toBe('https://x/api/read/a/b');
  });

  it('finds the lookupId that surfaced a resource (attribution)', async () => {
    await recordLookup(dir, entry({ lookupId: '0197aaaa-bbbb-cccc-dddd-000000000009' }));
    expect(await findLookupForResource(dir, { resourceId: 'res-1' })).toBe(
      '0197aaaa-bbbb-cccc-dddd-000000000009',
    );
    expect(await findLookupForResource(dir, { url: 'https://x/api/read/a/b' })).toBe(
      '0197aaaa-bbbb-cccc-dddd-000000000009',
    );
    expect(await findLookupForResource(dir, { resourceId: 'nope' })).toBeNull();
  });

  it('de-dupes a re-recorded lookupId', async () => {
    await recordLookup(dir, entry());
    await recordLookup(dir, entry());
    expect(await loadLookups(dir)).toHaveLength(1);
  });

  it('reads empty (never throws) on a corrupt store', async () => {
    await writeFile(join(dir, 'lookups.json'), 'not json', 'utf8');
    expect(await loadLookups(dir)).toEqual([]);
  });
});
