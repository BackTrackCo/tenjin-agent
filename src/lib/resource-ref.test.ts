import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveResourceRef, readApiUrl } from './resource-ref';
import { recordLookup, saveLibraryItem } from './state';
import { CliError } from './errors';

const BASE = 'https://tenjin.blog';
const UUID = 'a1b2c3d4-e5f6-4789-a012-3456789abcde';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-resource-ref-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function catchCliError(p: Promise<unknown>): Promise<CliError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(CliError);
    return e as CliError;
  }
  throw new Error('expected the call to throw');
}

describe('readApiUrl', () => {
  it('builds the read API url from base/handle/slug', () => {
    expect(readApiUrl(BASE, 'alice', 'piece-one')).toBe(
      'https://tenjin.blog/api/read/alice/piece-one',
    );
  });

  it.each([
    ['https://tenjin.blog/', 'https://tenjin.blog/api/read/alice/piece-one'],
    ['https://tenjin.blog///', 'https://tenjin.blog/api/read/alice/piece-one'],
    ['https://tenjin.blog', 'https://tenjin.blog/api/read/alice/piece-one'],
  ])('trims trailing slashes of base %s', (base, expected) => {
    expect(readApiUrl(base, 'alice', 'piece-one')).toBe(expected);
  });
});

describe('resolveResourceRef — uuid (resourceId)', () => {
  it('resolves through lookup history when a matching candidate exists', async () => {
    await recordLookup(dir, {
      lookupId: 'l1',
      decision: 'CANDIDATES',
      at: new Date().toISOString(),
      candidates: [
        {
          resourceId: UUID,
          url: `${BASE}/api/read/alice/piece-one`,
          title: 'Piece One',
          price: '0.05',
        },
      ],
    });
    const ref = await resolveResourceRef(UUID, BASE, dir);
    expect(ref).toEqual({
      url: `${BASE}/api/read/alice/piece-one`,
      handle: 'alice',
      slug: 'piece-one',
    });
  });

  it('resolves through the library when not in lookup history', async () => {
    await saveLibraryItem(
      dir,
      {
        resourceId: UUID,
        slug: 'piece-one',
        title: 'Piece One',
        url: `${BASE}/api/read/bob/piece-one`,
        priceAtomic: '50000',
        paidAtomic: '50000',
        txHash: '0xabc',
        entitlement: 'paid',
        creatorHandle: 'bob',
      },
      'body',
    );
    const ref = await resolveResourceRef(UUID, BASE, dir);
    expect(ref).toEqual({
      url: `${BASE}/api/read/bob/piece-one`,
      handle: 'bob',
      slug: 'piece-one',
    });
  });

  it('prefers lookup history over the library when both have the resource', async () => {
    await recordLookup(dir, {
      lookupId: 'l1',
      decision: 'CANDIDATES',
      at: new Date().toISOString(),
      candidates: [
        {
          resourceId: UUID,
          url: `${BASE}/api/read/from-lookup/piece-one`,
          title: 'Piece One',
          price: '0.05',
        },
      ],
    });
    await saveLibraryItem(
      dir,
      {
        resourceId: UUID,
        slug: 'piece-one',
        title: 'Piece One',
        url: `${BASE}/api/read/from-library/piece-one`,
        priceAtomic: '50000',
        paidAtomic: '50000',
        txHash: '0xabc',
        entitlement: 'paid',
        creatorHandle: 'from-library',
      },
      'body',
    );
    const ref = await resolveResourceRef(UUID, BASE, dir);
    expect(ref.handle).toBe('from-lookup');
  });

  it('an unknown uuid is USAGE with a fix mentioning lookup', async () => {
    const err = await catchCliError(resolveResourceRef(UUID, BASE, dir));
    expect(err.code).toBe('USAGE');
    expect(err.message).toContain(UUID);
    expect(err.fix?.toLowerCase()).toContain('lookup');
  });
});

describe('resolveResourceRef — https URL', () => {
  it.each([[`${BASE}/api/read/alice/piece-one`], [`${BASE}/a/alice/piece-one`]])(
    '%s on the same origin normalizes to the read API url',
    async (url) => {
      const ref = await resolveResourceRef(url, BASE, dir);
      expect(ref).toEqual({
        url: `${BASE}/api/read/alice/piece-one`,
        handle: 'alice',
        slug: 'piece-one',
      });
    },
  );

  it.each([[`${BASE}/api/read/alice/piece-one/`], [`${BASE}/a/alice/piece-one/`]])(
    'accepts a trailing slash on %s',
    async (url) => {
      const ref = await resolveResourceRef(url, BASE, dir);
      expect(ref).toEqual({
        url: `${BASE}/api/read/alice/piece-one`,
        handle: 'alice',
        slug: 'piece-one',
      });
    },
  );

  it('a different origin is refused as USAGE', async () => {
    const err = await catchCliError(
      resolveResourceRef('https://evil.example/api/read/alice/piece-one', BASE, dir),
    );
    expect(err.code).toBe('USAGE');
    expect(err.message).toContain('evil.example');
  });

  it('a non-resource path on the configured origin is USAGE', async () => {
    const err = await catchCliError(resolveResourceRef(`${BASE}/about`, BASE, dir));
    expect(err.code).toBe('USAGE');
  });
});

describe('resolveResourceRef — handle/slug shorthand', () => {
  it('resolves handle/slug directly to the read API url', async () => {
    const ref = await resolveResourceRef('alice/piece-one', BASE, dir);
    expect(ref).toEqual({
      url: `${BASE}/api/read/alice/piece-one`,
      handle: 'alice',
      slug: 'piece-one',
    });
  });
});

describe('resolveResourceRef — invalid input', () => {
  it('an empty reference is USAGE', async () => {
    const err = await catchCliError(resolveResourceRef('', BASE, dir));
    expect(err.code).toBe('USAGE');
  });

  it('a whitespace-only reference is USAGE', async () => {
    const err = await catchCliError(resolveResourceRef('   ', BASE, dir));
    expect(err.code).toBe('USAGE');
  });

  it.each([['garbage'], ['too/many/slashes'], ['ftp://tenjin.blog/alice/piece-one']])(
    'garbage input %s is USAGE',
    async (input) => {
      const err = await catchCliError(resolveResourceRef(input, BASE, dir));
      expect(err.code).toBe('USAGE');
    },
  );
});
