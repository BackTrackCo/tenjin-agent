import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertOnBaseOrigin, resolveResourceRef } from './resource-ref';
import { recordSearch } from './search-store';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-ref-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const RES = '0197aaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const BASE = 'https://tenjin.blog';

describe('resolveResourceRef', () => {
  it('uses a full https URL verbatim', async () => {
    const ref = await resolveResourceRef('https://tenjin.blog/api/read/iris/slug', dir, BASE);
    expect(ref).toEqual({ url: 'https://tenjin.blog/api/read/iris/slug' });
  });

  it('resolves a uuid to the stored candidate URL', async () => {
    await recordSearch(dir, {
      searchId: '0197aaaa-bbbb-cccc-dddd-000000000001',
      at: '2026-07-18T00:00:00.000Z',
      question: 'q',
      decision: 'CANDIDATES',
      candidates: [
        { resourceId: RES, url: 'https://tenjin.blog/api/read/iris/slug', title: 't', price: '1' },
      ],
    });
    const ref = await resolveResourceRef(RES, dir, BASE);
    expect(ref).toEqual({ url: 'https://tenjin.blog/api/read/iris/slug', resourceId: RES });
  });

  it('fails RESOURCE_NOT_FOUND for an unknown uuid', async () => {
    await expect(resolveResourceRef(RES, dir, BASE)).rejects.toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
    });
  });

  it('fails USAGE for something that is neither a URL nor a uuid', async () => {
    await expect(resolveResourceRef('iris/slug', dir, BASE)).rejects.toMatchObject({
      code: 'USAGE',
    });
  });
});

/**
 * A URL pasted with a trailing slash addresses the same piece — `parseReadPath`
 * has always treated it that way — but `fetchRead` pins redirects, and the read
 * route canonicalizes the slashed form away with a 3xx. Un-normalized, that URL
 * dies at the first probe of every verb that resolves through here. This is the
 * one place all of them do, so it is the one place the spelling is fixed.
 */
describe('trailing-slash canonicalization', () => {
  it('resolves a trailing-slash URL to the canonical no-slash form', async () => {
    const ref = await resolveResourceRef('https://tenjin.blog/api/read/iris/slug/', dir, BASE);
    expect(ref).toEqual({ url: 'https://tenjin.blog/api/read/iris/slug' });
  });

  it('canonicalizes a stored candidate URL on the same terms', async () => {
    await recordSearch(dir, {
      searchId: '0197aaaa-bbbb-cccc-dddd-000000000003',
      at: '2026-07-18T00:00:00.000Z',
      question: 'q',
      decision: 'CANDIDATES',
      candidates: [
        { resourceId: RES, url: 'https://tenjin.blog/api/read/iris/slug/', title: 't', price: '1' },
      ],
    });
    const ref = await resolveResourceRef(RES, dir, BASE);
    expect(ref).toEqual({ url: 'https://tenjin.blog/api/read/iris/slug', resourceId: RES });
  });

  it('still refuses an off-origin URL that arrives with a trailing slash', async () => {
    // Canonicalization runs BEFORE the origin check, so it must not be a way past
    // it: the string that gets checked is the string that gets sent.
    await expect(
      resolveResourceRef('https://evil.example/api/read/iris/slug/', dir, BASE),
    ).rejects.toMatchObject({ code: 'USAGE', exitCode: 2 });
  });

  it('leaves a non-read URL on the base origin alone', async () => {
    const ref = await resolveResourceRef('https://tenjin.blog/api/other/', dir, BASE);
    expect(ref).toEqual({ url: 'https://tenjin.blog/api/other/' });
  });
});

describe('origin pinning (SIWX/payment trust boundary)', () => {
  it('refuses a URL off the configured base origin', async () => {
    await expect(
      resolveResourceRef('https://evil.example/api/read/iris/slug', dir, BASE),
    ).rejects.toMatchObject({ code: 'USAGE', exitCode: 2 });
  });

  it('refuses a stored candidate whose URL no longer matches the base origin', async () => {
    await recordSearch(dir, {
      searchId: '0197aaaa-bbbb-cccc-dddd-000000000002',
      at: '2026-07-18T00:00:00.000Z',
      question: 'q',
      decision: 'CANDIDATES',
      candidates: [
        { resourceId: RES, url: 'https://evil.example/api/read/iris/slug', title: 't', price: '1' },
      ],
    });
    await expect(resolveResourceRef(RES, dir, BASE)).rejects.toMatchObject({ code: 'USAGE' });
  });

  it('assertOnBaseOrigin treats scheme and port as part of the origin', () => {
    expect(() => assertOnBaseOrigin('http://tenjin.blog/x', BASE, 'u')).toThrowError();
    expect(() => assertOnBaseOrigin('https://tenjin.blog:8443/x', BASE, 'u')).toThrowError();
    expect(() => assertOnBaseOrigin('https://tenjin.blog/x', BASE, 'u')).not.toThrowError();
  });
});
