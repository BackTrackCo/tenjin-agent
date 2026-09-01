import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertOnBaseOrigin, resolveResourceRef, type ResourceRefNetOptions } from './resource-ref';
import { CliError } from './errors';
import {
  openStore,
  recordSearch,
  searchFingerprint,
  STATE_PAIRING_POST_PREFIX,
  STORE_SQL,
} from './state-store';
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
const DAY = 24 * 60 * 60 * 1000;

/** Fixture stamps are RELATIVE, always. An absolute date here dated the whole
 *  file: the candidate lookup once carried a 30-day floor, so these rows aged
 *  out of it by the calendar and three tests failed on a day nobody touched
 *  them. The floor is gone, and so is the way to reintroduce it unnoticed. */
function agoIso(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

/** Searches carrying no candidates, indexes `from`..`to`, stamped `startAtMs`
 *  onward — the newer rows a recency bound has to count past. Written through
 *  ONE handle: 500 `recordSearch` calls would each open and close the file. */
async function seedDecoySearches(
  dataDir: string,
  from: number,
  to: number,
  startAtMs: number,
): Promise<void> {
  const store = await openStore(dataDir);
  if (store === null) throw new Error('no store');
  try {
    for (let i = from; i < to; i += 1) {
      store.run(STORE_SQL.recordSearch, [
        `0197bbbb-cccc-dddd-eeee-${String(i).padStart(12, '0')}`,
        startAtMs + i,
        '',
        null,
        'decoy',
        searchFingerprint('decoy'),
        'MISS',
        '[]',
        null,
        null,
        null,
      ]);
    }
  } finally {
    store.close();
  }
}

describe('resolveResourceRef', () => {
  it('uses a full https URL verbatim', async () => {
    const ref = await resolveResourceRef('https://tenjin.blog/api/read/iris/slug', dir, BASE);
    expect(ref).toEqual({ url: 'https://tenjin.blog/api/read/iris/slug', shelfBaseUrl: BASE });
  });

  it('resolves a uuid to the stored candidate URL', async () => {
    await recordSearch(dir, {
      searchId: '0197aaaa-bbbb-cccc-dddd-000000000001',
      at: agoIso(2 * DAY),
      question: 'q',
      decision: 'CANDIDATES',
      candidates: [
        { resourceId: RES, url: 'https://tenjin.blog/api/read/iris/slug', title: 't', price: '1' },
      ],
    });
    const ref = await resolveResourceRef(RES, dir, BASE);
    expect(ref).toEqual({
      url: 'https://tenjin.blog/api/read/iris/slug',
      resourceId: RES,
      shelfBaseUrl: BASE,
    });
  });

  /**
   * `tenjin buy <resourceId>` resolves the payable URL out of whichever search
   * surfaced the piece, and an agent buys when it decides to, not inside a
   * window. The lookup carried an `at >= now - 30d` floor for a while, which
   * turned a months-old search into "No local search knows resource …" purely
   * by the calendar — a piece an agent had deliberately parked became unbuyable
   * with no way to tell why. The bound is a row count now (see
   * `STORE_SQL.searchForResource`), so age alone never costs a resolution.
   */
  it('resolves a search far older than the month a date floor used to allow', async () => {
    await recordSearch(dir, {
      searchId: '0197aaaa-bbbb-cccc-dddd-000000000004',
      at: agoIso(120 * DAY),
      question: 'q',
      decision: 'CANDIDATES',
      candidates: [
        { resourceId: RES, url: 'https://tenjin.blog/api/read/iris/slug', title: 't', price: '1' },
      ],
    });
    await expect(resolveResourceRef(RES, dir, BASE)).resolves.toEqual({
      url: 'https://tenjin.blog/api/read/iris/slug',
      resourceId: RES,
      shelfBaseUrl: BASE,
    });
  });

  /**
   * What replaced the floor, pinned at its exact edge: the scan reads the 500
   * most recent rows, so the 500th still resolves and the 501st does not. The
   * bound exists because `json_each` over an unpruned table is a full scan on
   * every MISS; it is deliberately about ACTIVITY, not time.
   */
  it('reaches the 500th most recent search and no further', async () => {
    const targetAt = Date.now() - 400 * DAY;
    await recordSearch(dir, {
      searchId: '0197aaaa-bbbb-cccc-dddd-000000000005',
      at: new Date(targetAt).toISOString(),
      question: 'q',
      decision: 'CANDIDATES',
      candidates: [
        { resourceId: RES, url: 'https://tenjin.blog/api/read/iris/slug', title: 't', price: '1' },
      ],
    });

    // 499 newer searches leave the target row 500th, the last one read.
    await seedDecoySearches(dir, 0, 499, targetAt + 1000);
    await expect(resolveResourceRef(RES, dir, BASE)).resolves.toMatchObject({ resourceId: RES });

    // One more pushes it to 501st, past the window the scan opens.
    await seedDecoySearches(dir, 499, 500, targetAt + 1000);
    await expect(resolveResourceRef(RES, dir, BASE)).rejects.toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
    });
  });

  it('fails RESOURCE_NOT_FOUND for an unknown uuid', async () => {
    await expect(resolveResourceRef(RES, dir, BASE)).rejects.toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
    });
  });

  /**
   * tenjin-agent#252: `tenjin sync` publishes a pairing to the team shelf and
   * links it under `pairing_post:<n>` (own: true), but never records it as a
   * search — so `inspect <id>`/`read <id>` on a post this machine's own CLI
   * just published refused with RESOURCE_NOT_FOUND, because `findStoredCandidate`
   * only ever looks at `searches`. This is the fallback: a pairing link that
   * carries a `url` (stamped from `publishPost`'s own response) resolves too.
   */
  it('resolves a uuid via an own-published pairing_post link when no search knows it', async () => {
    const store = await openStore(dir);
    if (store === null) throw new Error('no store');
    try {
      store.run(STORE_SQL.setState, [
        '',
        STATE_PAIRING_POST_PREFIX + '1',
        JSON.stringify({
          postId: RES,
          origin: BASE,
          at: Date.now(),
          own: true,
          url: 'https://tenjin.blog/api/read/team/fix-pairing',
          title: 'Fix: pnpm vitest run — TS2345',
          price: '0',
        }),
        Date.now(),
      ]);
    } finally {
      store.close();
    }
    await expect(resolveResourceRef(RES, dir, BASE)).resolves.toEqual({
      url: 'https://tenjin.blog/api/read/team/fix-pairing',
      resourceId: RES,
      shelfBaseUrl: BASE,
    });
  });

  /** A `held` link (a teammate's post whose slug this machine never fetched)
   *  carries no `url`, and there is no unauthenticated by-id route to fall
   *  through to — it stays RESOURCE_NOT_FOUND rather than inventing a request
   *  the server has nowhere to answer. */
  it('does not resolve a pairing_post link with no stored url', async () => {
    const store = await openStore(dir);
    if (store === null) throw new Error('no store');
    try {
      store.run(STORE_SQL.setState, [
        '',
        STATE_PAIRING_POST_PREFIX + '2',
        JSON.stringify({ postId: RES, origin: BASE, at: Date.now(), held: true }),
        Date.now(),
      ]);
    } finally {
      store.close();
    }
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

/** A fetch stub for the `getPostMetadata` fallback: records calls and answers
 *  one canned JSON response. */
function stubFetch(status: number, body: unknown): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fn = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetch: fn, calls };
}

/**
 * tenjin-agent#252 item 1 / tenjin#803: `tenjin publish` returns a resourceId
 * neither `findStoredCandidate` (no search ever ran) nor `findPairingCandidate`
 * (that link is for a machine's own `tenjin sync`, not `publish`) knows about,
 * so a bare `tenjin inspect <that-id>` used to refuse with RESOURCE_NOT_FOUND
 * even though the CLI itself had just printed the id. This is the fallback:
 * when a caller supplies network capability, a double local miss on a bare
 * uuid is checked against the public `GET /api/posts/<id>/public` route
 * (`getPostMetadata`) before giving up.
 */
describe('resolveResourceRef bare-id network fallback', () => {
  const POST = {
    id: RES,
    slug: 'fix-pnpm-enoent',
    title: 'Fix: pnpm — ENOENT',
    price: '100000',
    status: 'published',
    creator: { handle: 'iris' },
  };

  it('resolves via the public by-id route when both local sources miss', async () => {
    const { fetch } = stubFetch(200, POST);
    const net: ResourceRefNetOptions = { timeoutMs: 5000, fetchImpl: fetch };
    await expect(resolveResourceRef(RES, dir, BASE, undefined, net)).resolves.toEqual({
      url: `${BASE}/api/read/${POST.creator.handle}/${POST.slug}`,
      resourceId: RES,
      shelfBaseUrl: BASE,
    });
  });

  it('stays a clean RESOURCE_NOT_FOUND when the public route also 404s', async () => {
    const { fetch } = stubFetch(404, { error: 'not found' });
    const net: ResourceRefNetOptions = { timeoutMs: 5000, fetchImpl: fetch };
    await expect(resolveResourceRef(RES, dir, BASE, undefined, net)).rejects.toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
    });
  });

  it('never calls the network when a stored search candidate already resolves it', async () => {
    await recordSearch(dir, {
      searchId: '0197aaaa-bbbb-cccc-dddd-000000000006',
      at: agoIso(2 * DAY),
      question: 'q',
      decision: 'CANDIDATES',
      candidates: [
        { resourceId: RES, url: 'https://tenjin.blog/api/read/iris/slug', title: 't', price: '1' },
      ],
    });
    const { fetch, calls } = stubFetch(200, POST);
    const net: ResourceRefNetOptions = { timeoutMs: 5000, fetchImpl: fetch };
    await expect(resolveResourceRef(RES, dir, BASE, undefined, net)).resolves.toMatchObject({
      resourceId: RES,
    });
    expect(calls).toHaveLength(0);
  });

  it('never calls the network when a pairing_post link already resolves it', async () => {
    const store = await openStore(dir);
    if (store === null) throw new Error('no store');
    try {
      store.run(STORE_SQL.setState, [
        '',
        STATE_PAIRING_POST_PREFIX + '3',
        JSON.stringify({
          postId: RES,
          origin: BASE,
          at: Date.now(),
          own: true,
          url: 'https://tenjin.blog/api/read/team/fix-pairing',
        }),
        Date.now(),
      ]);
    } finally {
      store.close();
    }
    const { fetch, calls } = stubFetch(200, POST);
    const net: ResourceRefNetOptions = { timeoutMs: 5000, fetchImpl: fetch };
    await expect(resolveResourceRef(RES, dir, BASE, undefined, net)).resolves.toMatchObject({
      resourceId: RES,
    });
    expect(calls).toHaveLength(0);
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
    expect(ref).toEqual({ url: 'https://tenjin.blog/api/read/iris/slug', shelfBaseUrl: BASE });
  });

  it('canonicalizes a stored candidate URL on the same terms', async () => {
    await recordSearch(dir, {
      searchId: '0197aaaa-bbbb-cccc-dddd-000000000003',
      at: agoIso(2 * DAY),
      question: 'q',
      decision: 'CANDIDATES',
      candidates: [
        { resourceId: RES, url: 'https://tenjin.blog/api/read/iris/slug/', title: 't', price: '1' },
      ],
    });
    const ref = await resolveResourceRef(RES, dir, BASE);
    expect(ref).toEqual({
      url: 'https://tenjin.blog/api/read/iris/slug',
      resourceId: RES,
      shelfBaseUrl: BASE,
    });
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
    expect(ref).toEqual({ url: 'https://tenjin.blog/api/other/', shelfBaseUrl: BASE });
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
      at: agoIso(2 * DAY),
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
      at: agoIso(2 * DAY),
      question: 'q',
      decision: 'CANDIDATES',
      candidates: [{ resourceId: RES, url, title: 't', price: '1' }],
    });
    // The re-assert runs against the CURRENT base, which is still the old origin
    // on an installed client; the URL is passed through unrewritten.
    await expect(resolveResourceRef(RES, dir, BASE)).resolves.toEqual({
      url,
      resourceId: RES,
      shelfBaseUrl: BASE,
    });
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
