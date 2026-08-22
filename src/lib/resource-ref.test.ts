import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertOnBaseOrigin, resolveResourceRef } from './resource-ref';
import { CliError } from './errors';
import { recordSearch } from './search-store';
import { knownDeploymentOrigins } from './production-origin';

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

/**
 * The cutover property (tenjin#738). The server builds candidate urls from its
 * own global, so at the flip every candidate arrives on the other origin at once
 * and an installed CLI would refuse whole responses. What is widened is the
 * identity of ONE deployment, so the refusal branch has to behave identically
 * for everything outside the set.
 */
describe('assertOnBaseOrigin across the deployment alias set', () => {
  const SIBLINGS = knownDeploymentOrigins().filter((o) => o !== BASE);

  it('accepts a candidate on the deployment other origin', () => {
    for (const sibling of SIBLINGS) {
      expect(() =>
        assertOnBaseOrigin(`${sibling}/api/read/iris/slug`, BASE, 'search candidate URL'),
      ).not.toThrowError();
      // and symmetrically, once the config default flips to the new origin.
      expect(() =>
        assertOnBaseOrigin(`${BASE}/api/read/iris/slug`, sibling, 'search candidate URL'),
      ).not.toThrowError();
    }
  });

  it('resolves a stored candidate on the other origin against either base', async () => {
    const sibling = SIBLINGS[0];
    expect(sibling).toBeDefined();
    const url = `${sibling}/api/read/iris/slug`;
    await recordSearch(dir, {
      searchId: '0197aaaa-bbbb-cccc-dddd-000000000003',
      at: '2026-08-17T00:00:00.000Z',
      question: 'q',
      decision: 'CANDIDATES',
      candidates: [{ resourceId: RES, url, title: 't', price: '1' }],
    });
    // The re-assert runs against the CURRENT base, which is still the old origin
    // on an installed client; the URL is passed through unrewritten.
    await expect(resolveResourceRef(RES, dir, BASE)).resolves.toEqual({ url, resourceId: RES });
  });

  it('gives a self-hosted base no aliasing at all', () => {
    const SELF_HOSTED = 'https://notes.internal';
    for (const sibling of knownDeploymentOrigins()) {
      expect(() => assertOnBaseOrigin(`${sibling}/x`, SELF_HOSTED, 'resource URL')).toThrowError();
    }
    expect(() =>
      assertOnBaseOrigin(`${SELF_HOSTED}/x`, SELF_HOSTED, 'resource URL'),
    ).not.toThrowError();
  });

  it('refuses an origin outside the set with the same error it always gave', () => {
    for (const base of knownDeploymentOrigins()) {
      let err: CliError | undefined;
      try {
        assertOnBaseOrigin('https://evil.example/x', base, 'resource URL');
      } catch (e) {
        err = e as CliError;
      }
      expect(err).toBeInstanceOf(CliError);
      expect(err?.code).toBe('USAGE');
      expect(err?.message).toContain('https://evil.example');
      expect(err?.fix).toContain('tenjin config get baseUrl');
      expect(err?.fix).not.toContain('--base-url');
    }
  });

  it('does not let a lookalike host ride in on the alias set', () => {
    for (const base of knownDeploymentOrigins()) {
      const host = new URL(base).host;
      expect(() => assertOnBaseOrigin(`https://${host}.evil.example/x`, base, 'u')).toThrowError();
      expect(() => assertOnBaseOrigin(`https://evil-${host}/x`, base, 'u')).toThrowError();
    }
  });
});
