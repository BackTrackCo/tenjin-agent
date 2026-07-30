import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertOnBaseOrigin, resolveResourceRef } from './resource-ref';
import { CliError } from './errors';
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

  // This is the one place the CLI talks to the agent at the exact moment an
  // attacker-supplied URL fails the pin, on the paying path. The old copy said
  // "Pass --base-url if you meant a different deployment", which is the single
  // move that turns the pin into a formality, and the flag clears every
  // allowlisted verb. The fix line must send the reader to the CONFIGURED value.
  it('the off-origin fix reads the configured value and never coaches the flag', () => {
    let err: CliError | undefined;
    try {
      assertOnBaseOrigin('https://evil.example/x', BASE, 'resource URL');
    } catch (e) {
      err = e as CliError;
    }
    expect(err).toBeInstanceOf(CliError);
    expect(err?.fix).not.toContain('--base-url');
    expect(err?.fix).toContain('tenjin config get baseUrl');
    expect(err?.fix).toMatch(/do not re-point the CLI/i);
    // and the message still names both origins so the operator can tell them apart.
    expect(err?.message).toContain('https://evil.example');
    expect(err?.message).toContain('https://tenjin.blog');
  });
});
