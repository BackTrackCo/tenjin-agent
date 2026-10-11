import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bodyPath,
  canonicalReadUrl,
  contentHash,
  findDelivered,
  findDeliveredByUrl,
  isSafeIdentity,
  parseReadPath,
  receiptPath,
  resourceDir,
  saveDelivery,
} from './library';
import { CliError } from './errors';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-lib-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const RESOURCE = '0197aaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function input(over: Partial<Parameters<typeof saveDelivery>[1]> = {}) {
  return {
    resourceId: RESOURCE,
    slug: 'my-slug',
    title: 'My Title',
    handle: 'iris',
    url: 'https://tenjin.blog/api/read/iris/my-slug',
    priceAtomic: '100000',
    entitlement: 'purchased' as const,
    bodyMd: '# Heading\n\nbody text\n',
    ...over,
  };
}

describe('saveDelivery + findDelivered', () => {
  it('writes the body under library/<resourceId>/<slug>.md and a receipt', async () => {
    const saved = await saveDelivery(dir, input());
    expect(saved.bodyPath).toBe(bodyPath(dir, RESOURCE, 'my-slug'));
    expect(await readFile(saved.bodyPath, 'utf8')).toBe('# Heading\n\nbody text\n');
    const receipt = JSON.parse(await readFile(receiptPath(dir, RESOURCE), 'utf8'));
    expect(receipt).toMatchObject({
      resourceId: RESOURCE,
      slug: 'my-slug',
      entitlement: 'purchased',
      contentHash: contentHash('# Heading\n\nbody text\n'),
    });
  });

  it('records the settlement tx hash when present', async () => {
    await saveDelivery(dir, input({ settlementTxHash: '0xdead' }));
    const found = await findDelivered(dir, RESOURCE);
    expect(found?.receipt.settlementTxHash).toBe('0xdead');
  });

  it('findDelivered returns the saved body + receipt (idempotent re-delivery source)', async () => {
    await saveDelivery(dir, input());
    const found = await findDelivered(dir, RESOURCE);
    expect(found).not.toBeNull();
    expect(found?.bodyMd).toBe('# Heading\n\nbody text\n');
    expect(found?.receipt.title).toBe('My Title');
  });

  it('findDelivered is null when nothing was saved', async () => {
    expect(await findDelivered(dir, RESOURCE)).toBeNull();
  });

  it('findDelivered is null (never throws) on a corrupt receipt', async () => {
    await mkdir(resourceDir(dir, RESOURCE), { recursive: true });
    await writeFile(receiptPath(dir, RESOURCE), '{ not json', 'utf8');
    expect(await findDelivered(dir, RESOURCE)).toBeNull();
  });

  it('re-saving overwrites (a free read can later become a purchase)', async () => {
    await saveDelivery(dir, input({ entitlement: 'free' }));
    await saveDelivery(dir, input({ entitlement: 'purchased' }));
    const found = await findDelivered(dir, RESOURCE);
    expect(found?.receipt.entitlement).toBe('purchased');
  });
});

describe('saveDelivery, path-traversal defense', () => {
  it('refuses a resourceId that escapes the library (CONTRACT_MISMATCH), writes nothing', async () => {
    const err = await saveDelivery(dir, input({ resourceId: '../../../../etc' })).catch(
      (e) => e as CliError,
    );
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe('CONTRACT_MISMATCH');
    // No directory was created outside the library.
    expect(await findDelivered(dir, '../../../../etc')).toBeNull();
  });

  it('refuses a slug carrying a traversal (CONTRACT_MISMATCH)', async () => {
    const err = await saveDelivery(dir, input({ slug: '../../evil' })).catch((e) => e as CliError);
    expect((err as CliError).code).toBe('CONTRACT_MISMATCH');
  });

  it('refuses a slug with a path separator', async () => {
    const err = await saveDelivery(dir, input({ slug: 'a/b' })).catch((e) => e as CliError);
    expect((err as CliError).code).toBe('CONTRACT_MISMATCH');
  });
});

describe('isSafeIdentity', () => {
  it('accepts a uuid + a valid slug', () => {
    expect(isSafeIdentity(RESOURCE, 'my-slug')).toBe(true);
  });
  it('rejects traversal vectors', () => {
    expect(isSafeIdentity('../../x', 'my-slug')).toBe(false);
    expect(isSafeIdentity(RESOURCE, '../../evil')).toBe(false);
    expect(isSafeIdentity(RESOURCE, 'a/b')).toBe(false);
    expect(isSafeIdentity(RESOURCE, 'UPPER')).toBe(false);
  });
});

describe('parseReadPath + findDeliveredByUrl', () => {
  it('parses handle/slug from a read URL, ignoring base-url differences', () => {
    expect(parseReadPath('https://tenjin.blog/api/read/iris/my-slug')).toEqual({
      handle: 'iris',
      slug: 'my-slug',
    });
    expect(parseReadPath('http://localhost:3000/api/read/iris/my-slug/')).toEqual({
      handle: 'iris',
      slug: 'my-slug',
    });
    expect(parseReadPath('https://tenjin.blog/not-a-read')).toBeNull();
  });

  it('finds a delivered resource by URL (the buy <url> double-pay guard)', async () => {
    await saveDelivery(dir, input());
    const found = await findDeliveredByUrl(dir, 'https://other-host.example/api/read/iris/my-slug');
    expect(found?.receipt.resourceId).toBe(RESOURCE);
  });

  it('returns null when no saved receipt matches the URL', async () => {
    await saveDelivery(dir, input());
    expect(
      await findDeliveredByUrl(dir, 'https://tenjin.blog/api/read/iris/other-slug'),
    ).toBeNull();
  });
});

// `parseReadPath` tolerates a trailing slash, but `fetchRead` pins redirects, and
// the read route canonicalizes the slashed form away with a 3xx. This is the
// function that makes those two agree, so its edges are worth pinning exactly.
describe('canonicalReadUrl', () => {
  it('removes the trailing slash parseReadPath tolerates', () => {
    expect(canonicalReadUrl('https://tenjin.blog/api/read/iris/my-slug/')).toBe(
      'https://tenjin.blog/api/read/iris/my-slug',
    );
  });

  it('leaves an already-canonical read URL byte-identical', () => {
    const url = 'https://tenjin.blog/api/read/iris/my-slug';
    expect(canonicalReadUrl(url)).toBe(url);
  });

  it('agrees with parseReadPath: both spellings name the same piece', () => {
    const slashed = 'https://tenjin.blog/api/read/iris/my-slug/';
    expect(parseReadPath(slashed)).toEqual(parseReadPath(canonicalReadUrl(slashed)));
  });

  it('preserves the query and fragment, and never touches the origin', () => {
    expect(canonicalReadUrl('https://tenjin.blog/api/read/iris/my-slug/?a=1&b=2')).toBe(
      'https://tenjin.blog/api/read/iris/my-slug?a=1&b=2',
    );
    expect(canonicalReadUrl('https://tenjin.blog/api/read/iris/my-slug/#top')).toBe(
      'https://tenjin.blog/api/read/iris/my-slug#top',
    );
    expect(canonicalReadUrl('http://localhost:3000/api/read/iris/my-slug/')).toBe(
      'http://localhost:3000/api/read/iris/my-slug',
    );
  });

  it('leaves anything parseReadPath does not accept exactly as it came in', () => {
    // Not a read path, a doubled slash parseReadPath already rejects, and a
    // non-URL: canonicalization is not a general-purpose slash stripper.
    for (const url of [
      'https://tenjin.blog/not-a-read/',
      'https://tenjin.blog/api/read/iris/my-slug//',
      'https://tenjin.blog/',
      'not-a-url/',
    ]) {
      expect(canonicalReadUrl(url)).toBe(url);
    }
  });
});

describe('contentHash', () => {
  it('is the sha256 the outcome endpoint expects', () => {
    // sha256 of the empty string, "sha256:" prefixed.
    expect(contentHash('')).toBe(
      'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});
