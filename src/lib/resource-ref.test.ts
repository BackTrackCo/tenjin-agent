import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveResourceRef } from './resource-ref';
import { recordLookup } from './lookup-store';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-ref-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const RES = '0197aaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('resolveResourceRef', () => {
  it('uses a full https URL verbatim', async () => {
    const ref = await resolveResourceRef('https://tenjin.blog/api/read/iris/slug', dir);
    expect(ref).toEqual({ url: 'https://tenjin.blog/api/read/iris/slug' });
  });

  it('resolves a uuid to the stored candidate URL', async () => {
    await recordLookup(dir, {
      lookupId: '0197aaaa-bbbb-cccc-dddd-000000000001',
      at: '2026-07-18T00:00:00.000Z',
      question: 'q',
      decision: 'CANDIDATES',
      candidates: [
        { resourceId: RES, url: 'https://tenjin.blog/api/read/iris/slug', title: 't', price: '1' },
      ],
    });
    const ref = await resolveResourceRef(RES, dir);
    expect(ref).toEqual({ url: 'https://tenjin.blog/api/read/iris/slug', resourceId: RES });
  });

  it('fails RESOURCE_NOT_FOUND for an unknown uuid', async () => {
    await expect(resolveResourceRef(RES, dir)).rejects.toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
    });
  });

  it('fails USAGE for something that is neither a URL nor a uuid', async () => {
    await expect(resolveResourceRef('iris/slug', dir)).rejects.toMatchObject({ code: 'USAGE' });
  });
});
