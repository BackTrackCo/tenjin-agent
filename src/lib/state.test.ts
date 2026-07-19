import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  recordLookup,
  readLookupHistory,
  lastLookup,
  findCandidate,
  saveLibraryItem,
  readLibraryMeta,
  findLibraryByResource,
  lookupHistoryPath,
  contentHashOf,
  libraryItemPaths,
} from './state';
import type { StoredLookup, LibraryMeta } from './state';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-state-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function fakeLookup(overrides: Partial<StoredLookup> = {}): StoredLookup {
  return {
    lookupId: overrides.lookupId ?? 'lookup-1',
    decision: overrides.decision ?? 'CANDIDATES',
    at: overrides.at ?? new Date().toISOString(),
    candidates: overrides.candidates ?? [
      {
        resourceId: 'res-1',
        url: 'https://tenjin.blog/api/read/alice/piece-one',
        title: 'Piece One',
        price: '0.05',
      },
    ],
  };
}

function fakeLibraryMeta(
  overrides: Partial<Omit<LibraryMeta, 'contentHash' | 'savedAt'>> = {},
): Omit<LibraryMeta, 'contentHash' | 'savedAt'> {
  return {
    resourceId: overrides.resourceId ?? 'res-1',
    slug: overrides.slug ?? 'piece-one',
    title: overrides.title ?? 'Piece One',
    url: overrides.url ?? 'https://tenjin.blog/api/read/alice/piece-one',
    priceAtomic: overrides.priceAtomic ?? '50000',
    paidAtomic: overrides.paidAtomic ?? '50000',
    txHash: overrides.txHash ?? '0xabc',
    entitlement: overrides.entitlement ?? 'paid',
    creatorHandle: overrides.creatorHandle ?? 'alice',
  };
}

describe('recordLookup / readLookupHistory', () => {
  it('round-trips a single entry', async () => {
    const entry = fakeLookup();
    await recordLookup(dir, entry);
    expect(await readLookupHistory(dir)).toEqual([entry]);
  });

  it('prepends newer entries before older ones', async () => {
    await recordLookup(dir, fakeLookup({ lookupId: 'l1' }));
    await recordLookup(dir, fakeLookup({ lookupId: 'l2' }));
    await recordLookup(dir, fakeLookup({ lookupId: 'l3' }));
    const history = await readLookupHistory(dir);
    expect(history.map((l) => l.lookupId)).toEqual(['l3', 'l2', 'l1']);
  });

  it('caps history at 20 entries, dropping the oldest', async () => {
    for (let i = 0; i < 25; i++) {
      await recordLookup(dir, fakeLookup({ lookupId: `l${i}` }));
    }
    const history = await readLookupHistory(dir);
    expect(history).toHaveLength(20);
    // Most recent 20 of 0..24 is 24 down to 5.
    expect(history[0]?.lookupId).toBe('l24');
    expect(history[19]?.lookupId).toBe('l5');
    expect(history.some((l) => l.lookupId === 'l4')).toBe(false);
  });

  it('returns [] when the history file is missing', async () => {
    expect(await readLookupHistory(dir)).toEqual([]);
  });

  it('returns [] when the history file is corrupt JSON', async () => {
    await recordLookup(dir, fakeLookup());
    await writeFile(lookupHistoryPath(dir), '{ not json');
    expect(await readLookupHistory(dir)).toEqual([]);
  });

  it('returns [] when the history file is valid JSON but fails the schema', async () => {
    await writeFile(lookupHistoryPath(dir), JSON.stringify({ lookups: [{ nope: true }] }));
    expect(await readLookupHistory(dir)).toEqual([]);
  });

  it('never stores question text: the raw file has no question field', async () => {
    await recordLookup(dir, fakeLookup());
    const raw = await readFile(lookupHistoryPath(dir), 'utf8');
    expect(raw).not.toContain('question');
    expect(JSON.parse(raw)).not.toHaveProperty('lookups.0.question');
  });
});

describe('lastLookup', () => {
  it('returns null on an empty history', async () => {
    expect(await lastLookup(dir)).toBeNull();
  });

  it('returns the most recently recorded lookup', async () => {
    await recordLookup(dir, fakeLookup({ lookupId: 'l1' }));
    await recordLookup(dir, fakeLookup({ lookupId: 'l2' }));
    expect((await lastLookup(dir))?.lookupId).toBe('l2');
  });
});

describe('findCandidate', () => {
  it('matches by resourceId', async () => {
    await recordLookup(dir, fakeLookup());
    const hit = await findCandidate(dir, 'res-1');
    expect(hit?.candidate.resourceId).toBe('res-1');
    expect(hit?.lookup.lookupId).toBe('lookup-1');
  });

  it('matches by url', async () => {
    await recordLookup(dir, fakeLookup());
    const hit = await findCandidate(dir, 'https://tenjin.blog/api/read/alice/piece-one');
    expect(hit?.candidate.resourceId).toBe('res-1');
  });

  it('returns null when nothing matches', async () => {
    await recordLookup(dir, fakeLookup());
    expect(await findCandidate(dir, 'res-does-not-exist')).toBeNull();
  });

  it('prefers the most recent entry when the same resource appears in several lookups', async () => {
    await recordLookup(
      dir,
      fakeLookup({
        lookupId: 'older',
        candidates: [
          {
            resourceId: 'res-1',
            url: 'https://tenjin.blog/api/read/alice/old-slug',
            title: 'Old',
            price: '0.05',
          },
        ],
      }),
    );
    await recordLookup(
      dir,
      fakeLookup({
        lookupId: 'newer',
        candidates: [
          {
            resourceId: 'res-1',
            url: 'https://tenjin.blog/api/read/alice/new-slug',
            title: 'New',
            price: '0.05',
          },
        ],
      }),
    );
    const hit = await findCandidate(dir, 'res-1');
    expect(hit?.lookup.lookupId).toBe('newer');
    expect(hit?.candidate.url).toBe('https://tenjin.blog/api/read/alice/new-slug');
  });
});

describe('saveLibraryItem / readLibraryMeta / findLibraryByResource', () => {
  it('writes the body and a meta sidecar, and returns the completed meta', async () => {
    const body = '# Piece One\n\nBody text.\n';
    const meta = await saveLibraryItem(dir, fakeLibraryMeta(), body);
    expect(meta.resourceId).toBe('res-1');
    expect(meta.slug).toBe('piece-one');
    expect(typeof meta.savedAt).toBe('string');

    const paths = libraryItemPaths(dir, 'res-1', 'piece-one');
    expect(await readFile(paths.md, 'utf8')).toBe(body);
    expect(JSON.parse(await readFile(paths.meta, 'utf8'))).toEqual(meta);
  });

  it('computes contentHash as sha256 of the exact body utf8 bytes', async () => {
    const body = 'exact bytes, including unicode: café\n';
    const meta = await saveLibraryItem(dir, fakeLibraryMeta(), body);
    const expected = `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`;
    expect(meta.contentHash).toBe(expected);
    expect(contentHashOf(body)).toBe(expected);
  });

  it('readLibraryMeta round-trips what saveLibraryItem wrote', async () => {
    const saved = await saveLibraryItem(dir, fakeLibraryMeta(), 'body');
    const read = await readLibraryMeta(dir, 'res-1', 'piece-one');
    expect(read).toEqual(saved);
  });

  it('readLibraryMeta returns null when absent', async () => {
    expect(await readLibraryMeta(dir, 'res-1', 'piece-one')).toBeNull();
  });

  it('readLibraryMeta returns null on corrupt meta JSON', async () => {
    await saveLibraryItem(dir, fakeLibraryMeta(), 'body');
    await writeFile(libraryItemPaths(dir, 'res-1', 'piece-one').meta, '{ not json');
    expect(await readLibraryMeta(dir, 'res-1', 'piece-one')).toBeNull();
  });

  it('findLibraryByResource finds the meta for a resource without knowing the slug', async () => {
    const saved = await saveLibraryItem(dir, fakeLibraryMeta(), 'body');
    const found = await findLibraryByResource(dir, 'res-1');
    expect(found).toEqual(saved);
  });

  it('findLibraryByResource returns null when the resource directory is absent', async () => {
    expect(await findLibraryByResource(dir, 'res-does-not-exist')).toBeNull();
  });
});
