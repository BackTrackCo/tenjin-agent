import { describe, expect, it } from 'vitest';
import { CONFIG_DEFAULTS } from '../../lib/config';
import { PRODUCTION_ORIGIN } from '../../lib/production-origin';
import { question } from '../question';
import type { Deps, KernelConfig, LegResult, Question, Shelf } from '../types';
import { keysLeg, searchLeg } from './shelf';

/**
 * One leg against a stubbed `fetch`: no daemon, no store, no network. What is
 * under test is the leg's two promises — that it never throws, whatever comes
 * back, and that what it DOES throw away is recorded as a status a reviewer can
 * read off the ledger — plus the shape that replaced two requests with one:
 * ONE call, and a `LegResult` per candidate SET.
 */

const BASE = PRODUCTION_ORIGIN;
const SHELF = 'backtrack';

const CONFIG: KernelConfig = {
  hooks: CONFIG_DEFAULTS.hooks,
  loop: CONFIG_DEFAULTS.loop,
  team: CONFIG_DEFAULTS.team,
  baseUrl: BASE,
  shelf: SHELF,
  publish: CONFIG_DEFAULTS.publish,
};

const NO_SHELF: KernelConfig = { ...CONFIG, shelf: null };

const SEARCH_ID = '11111111-1111-4111-8111-111111111111';
const PUBLIC_SEARCH_ID = '55555555-5555-4555-8555-555555555555';

/** A `Deps` with only what a leg reads: the auth seam. */
function deps(auth: Deps['auth']): Deps {
  return { auth } as Deps;
}

const signed: Deps['auth'] = () =>
  Promise.resolve({ kind: 'signed', headers: { 'Tenjin-Session-Delegation': 'stub' } });
const noWallet: Deps['auth'] = () => Promise.resolve({ kind: 'no-wallet' });
const cannotSign: Deps['auth'] = () =>
  Promise.resolve({ kind: 'unauthenticated', detail: 'WALLET_LOCKED' });

function q(text: string): Question {
  return { text, questionKey: 'qk1' };
}

function candidate(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    resourceId: '22222222-2222-4222-8222-222222222222',
    url: `${BASE}/p/one`,
    slug: 'one',
    title: 'The collation flip',
    artifactType: 'finding',
    price: '0',
    asOf: null,
    validUntil: null,
    matchReasons: ['title'],
    estimatedTokens: 400,
    creator: { handle: 'ali' },
    excerpt: 'the image tag changed',
    ...over,
  };
}

function envelope(
  items: Array<Record<string, unknown>>,
  calibration = 'hybrid-v1',
  searchId = SEARCH_ID,
): unknown {
  return { schemaVersion: 3, searchId, calibration, items, matched: items.length };
}

/** The two-list body the shelf route answers with. */
function twoList(
  shelfItems: Array<Record<string, unknown>>,
  publicItems: null | Array<Record<string, unknown>>,
): unknown {
  return {
    shelf: envelope(shelfItems),
    public: publicItems === null ? null : envelope(publicItems, 'hybrid-v1', PUBLIC_SEARCH_ID),
  };
}

/** A stub `fetch` that records what it was asked and answers `res`. It refuses
 *  an aborted signal the way the real one does, so the abort path is real. */
function stub(res: () => Response): { fetchImpl: typeof fetch; calls: Request[] } {
  const calls: Request[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    if (init?.signal?.aborted === true) throw new DOMException('aborted', 'AbortError');
    calls.push(new Request(String(input), init));
    return res();
  };
  return { fetchImpl, calls };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function html(status: number): Response {
  return new Response('<!doctype html><title>Sign in</title>', {
    status,
    headers: { 'content-type': 'text/html' },
  });
}

async function body(calls: Request[]): Promise<Record<string, unknown>> {
  const call = calls[0];
  if (call === undefined) throw new Error('no request was made');
  return (await call.json()) as Record<string, unknown>;
}

function setOf(results: LegResult[], shelf: Shelf): LegResult | undefined {
  return results.find((r) => r.shelf === shelf);
}

describe('searchLeg: one call, two sets', () => {
  it('posts once to the shelf route, signed, and yields a team set and a public set', async () => {
    const { fetchImpl, calls } = stub(() =>
      json(200, twoList([candidate({ strong: true })], [candidate({ strong: true })])),
    );
    const results = await searchLeg('prompt', CONFIG, {}, fetchImpl).request(
      q('why the collation flipped'),
      2000,
      new AbortController().signal,
      deps(signed),
    );
    // EXACTLY ONE request. This is the whole change: it used to be two.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${BASE}/api/shelves/${SHELF}/search`);
    expect(calls[0]?.headers.get('tenjin-session-delegation')).toBe('stub');
    expect(results.map((r) => r.shelf)).toEqual(['team', 'public']);
    expect(setOf(results, 'team')?.searchId).toBe(SEARCH_ID);
    expect(setOf(results, 'public')?.searchId).toBe(PUBLIC_SEARCH_ID);
  });

  it('the slug is in the URL and nowhere in the body: no `shelf`, no `scope`', async () => {
    const { fetchImpl, calls } = stub(() => json(200, twoList([], [])));
    await searchLeg('research', CONFIG, {}, fetchImpl).request(
      q('why'),
      3200,
      new AbortController().signal,
      deps(signed),
    );
    const sent = await body(calls);
    expect(sent).toMatchObject({ trigger: 'research', limit: 3, budget_ms: 3200 });
    expect(sent.shelf).toBeUndefined();
    expect(sent.scope).toBeUndefined();
    // The shelf lifts identifiers out of the query itself; this side sends the
    // question and nothing it inferred from it.
    expect(sent.identifiers).toBeUndefined();
  });

  it('`team.publicFallback` sets includePublic on the body, and no longer drops a leg', async () => {
    const on = stub(() => json(200, twoList([], [])));
    await searchLeg('prompt', CONFIG, {}, on.fetchImpl).request(
      q('why'),
      2000,
      new AbortController().signal,
      deps(signed),
    );
    expect((await body(on.calls)).includePublic).toBe(true);

    const off = stub(() => json(200, twoList([], null)));
    const offCfg: KernelConfig = { ...CONFIG, team: { publicFallback: 'off' } };
    const results = await searchLeg('prompt', offCfg, {}, off.fetchImpl).request(
      q('why'),
      2000,
      new AbortController().signal,
      deps(signed),
    );
    expect((await body(off.calls)).includePublic).toBe(false);
    // One call either way; the server simply returns no public list.
    expect(off.calls).toHaveLength(1);
    expect(results.map((r) => r.shelf)).toEqual(['team']);
  });

  it('an explicit includePublic:false wins, which is how the failure round stays shelf-only', async () => {
    const { fetchImpl, calls } = stub(() => json(200, twoList([], null)));
    // `team.publicFallback` is on by DEFAULT, so the failure arm has to say so.
    await searchLeg('failure', CONFIG, { includePublic: false }, fetchImpl).request(
      q('Error: boom'),
      2000,
      new AbortController().signal,
      deps(signed),
    );
    expect((await body(calls)).includePublic).toBe(false);
  });

  it('an org policy of off is indistinguishable from asking for nothing: public: null, one row', async () => {
    const { fetchImpl, calls } = stub(() =>
      json(200, twoList([candidate({ strong: true })], null)),
    );
    const results = await searchLeg('prompt', CONFIG, {}, fetchImpl).request(
      q('why'),
      2000,
      new AbortController().signal,
      deps(signed),
    );
    // Asked for public and did not get it. No error, no retry, one `team` row.
    expect((await body(calls)).includePublic).toBe(true);
    expect(results.map((r) => r.shelf)).toEqual(['team']);
    expect(results[0]?.status).toBe('ok');
    expect(results[0]?.authError).toBeUndefined();
  });

  it('sends `Question.text` whole: the cut was made once, upstream', async () => {
    const { fetchImpl, calls } = stub(() => json(200, twoList([], [])));
    const asked = question('collation '.repeat(600).trim(), 'dispatch');
    expect(asked.text.length).toBeGreaterThan(512);
    const results = await searchLeg('dispatch', CONFIG, {}, fetchImpl).request(
      asked,
      4000,
      new AbortController().signal,
      deps(signed),
    );
    expect(results[0]?.status).toBe('ok');
    expect((await body(calls)).query).toBe(asked.text);
  });

  it('records the calibration and the top row per set', async () => {
    const { fetchImpl } = stub(() =>
      json(200, {
        shelf: envelope([candidate()], 'lexical-v1'),
        public: envelope([candidate({ title: 'A public one' })], 'hybrid-v1', PUBLIC_SEARCH_ID),
      }),
    );
    const results = await searchLeg('prompt', CONFIG, {}, fetchImpl).request(
      q('why'),
      2000,
      new AbortController().signal,
      deps(signed),
    );
    expect(setOf(results, 'team')).toMatchObject({
      status: 'ok',
      searchId: SEARCH_ID,
      calibration: 'lexical-v1',
      title: 'The collation flip',
      form: 'finding',
    });
    expect(setOf(results, 'public')).toMatchObject({
      title: 'A public one',
      calibration: 'hybrid-v1',
    });
  });

  it('copies the server’s shelf stamp onto the answer rather than inferring it', async () => {
    const { fetchImpl } = stub(() =>
      json(200, {
        shelf: envelope([candidate({ strong: true, shelf: { id: 'sh_1', slug: SHELF } })]),
        public: envelope([candidate({ strong: true, shelf: null })], 'hybrid-v1', PUBLIC_SEARCH_ID),
      }),
    );
    const results = await searchLeg('prompt', CONFIG, {}, fetchImpl).request(
      q('why'),
      2000,
      new AbortController().signal,
      deps(signed),
    );
    expect(setOf(results, 'team')?.answer?.shelfRef).toEqual({ id: 'sh_1', slug: SHELF });
    expect(setOf(results, 'public')?.answer?.shelfRef).toBeNull();
  });
});

/**
 * A CREDENTIAL PROBLEM NEVER WITHHOLDS A PUBLIC ANSWER (00-principles.md,
 * principle 4). In the old shape the public leg was already planned, so this was
 * structural; it is now a routing decision in one place, which is the first
 * thing to test and the first thing a refactor will drop.
 */
describe('searchLeg routing when the call cannot be signed', () => {
  it('no wallet: one unsigned call to /api/search, one public set, and no error', async () => {
    const { fetchImpl, calls } = stub(() => json(200, envelope([candidate({ strong: true })])));
    const results = await searchLeg('prompt', CONFIG, {}, fetchImpl).request(
      q('why'),
      2000,
      new AbortController().signal,
      deps(noWallet),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${BASE}/api/search`);
    expect(calls[0]?.headers.get('tenjin-session-delegation')).toBeNull();
    expect((await body(calls)).includePublic).toBeUndefined();
    expect(results.map((r) => r.shelf)).toEqual(['public']);
    // A valid configuration, so no error rides the row.
    expect(results[0]?.authError).toBeUndefined();
    expect(results[0]?.answer).not.toBeNull();
  });

  it('unauthenticated with a shelf set: the public answer is delivered and the row says why', async () => {
    const { fetchImpl, calls } = stub(() => json(200, envelope([candidate({ strong: true })])));
    const results = await searchLeg('prompt', CONFIG, {}, fetchImpl).request(
      q('why'),
      2000,
      new AbortController().signal,
      deps(cannotSign),
    );
    expect(calls).toHaveLength(1);
    // NEVER to the shelf route: an unsigned shelf request is a 401 and no answer.
    expect(calls[0]?.url).toBe(`${BASE}/api/search`);
    expect(results.map((r) => r.shelf)).toEqual(['public']);
    expect(results[0]?.answer).not.toBeNull();
    expect(results[0]?.authError).toBe('unauthenticated: WALLET_LOCKED');
  });

  it('no shelf configured: one unsigned public call, and auth is never consulted', async () => {
    const { fetchImpl, calls } = stub(() => json(200, envelope([])));
    let asked = 0;
    const counting: Deps['auth'] = () => {
      asked += 1;
      return signed({ method: 'GET', url: BASE });
    };
    const results = await searchLeg('prompt', NO_SHELF, {}, fetchImpl).request(
      q('why'),
      2000,
      new AbortController().signal,
      deps(counting),
    );
    expect(asked).toBe(0);
    expect(calls[0]?.url).toBe(`${BASE}/api/search`);
    expect(results.map((r) => r.shelf)).toEqual(['public']);
  });
});

describe('searchLeg statuses', () => {
  const cases: Array<[string, () => Response, string]> = [
    ['a 429', () => json(429, { error: 'slow down' }), 'http_429'],
    ['a 500', () => json(500, { error: 'boom' }), 'http_500'],
    // A 404 on the shelf route means "not a member, or no such shelf", which the
    // server answers identically on purpose; `tenjin doctor` is where a user
    // learns which. A rejected signature is the same class of fact.
    ['a 404', () => json(404, { error: 'no route' }), 'refused'],
    ['a gate page', () => html(401), 'refused'],
    ['HTML with a 200', () => html(200), 'bad_json'],
  ];
  for (const [name, res, status] of cases) {
    it(`${name} is ${status}, on BOTH sets the call would have carried`, async () => {
      const { fetchImpl } = stub(res);
      const results = await searchLeg('prompt', CONFIG, {}, fetchImpl).request(
        q('why'),
        2000,
        new AbortController().signal,
        deps(signed),
      );
      expect(results.map((r) => r.shelf)).toEqual(['team', 'public']);
      for (const r of results) {
        expect(r.status).toBe(status);
        expect(r.answer).toBeNull();
      }
    });
  }

  it('a candidate missing resourceId is bad_shape', async () => {
    const broken = candidate();
    delete broken.resourceId;
    const { fetchImpl } = stub(() => json(200, twoList([broken], [])));
    const results = await searchLeg('prompt', CONFIG, {}, fetchImpl).request(
      q('why'),
      2000,
      new AbortController().signal,
      deps(signed),
    );
    expect(results.every((r) => r.status === 'bad_shape')).toBe(true);
  });

  it('a flattened one-list response is bad_shape, not a silent half-answer', async () => {
    // The two-list envelope is what this parser is newly built on: a server that
    // went back to one list must fail loudly rather than look like an empty shelf.
    const { fetchImpl } = stub(() => json(200, envelope([candidate({ strong: true })])));
    const results = await searchLeg('prompt', CONFIG, {}, fetchImpl).request(
      q('why'),
      2000,
      new AbortController().signal,
      deps(signed),
    );
    expect(results.every((r) => r.status === 'bad_shape')).toBe(true);
  });

  it('a signal already aborted is aborted, not timeout', async () => {
    const { fetchImpl } = stub(() => json(200, twoList([], [])));
    const controller = new AbortController();
    controller.abort();
    const results = await searchLeg('prompt', CONFIG, {}, fetchImpl).request(
      q('why'),
      2000,
      controller.signal,
      deps(signed),
    );
    expect(results.every((r) => r.status === 'aborted')).toBe(true);
  });

  it('the leg deadline is timeout, and the leg still does not throw', async () => {
    const fetchImpl: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    // The signal `ask` hands every leg: the fire's abort OR the budget's own
    // timeout. The leg starts no timer of its own and reads the abort REASON,
    // so a `TimeoutError` is the deadline and anything else is the harness.
    const signal = AbortSignal.any([new AbortController().signal, AbortSignal.timeout(5)]);
    const results = await searchLeg('prompt', CONFIG, {}, fetchImpl).request(
      q('why'),
      5,
      signal,
      deps(signed),
    );
    expect(results.every((r) => r.status === 'timeout')).toBe(true);
  });

  it('a transport that never answers is error', async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    const results = await searchLeg('prompt', CONFIG, {}, fetchImpl).request(
      q('why'),
      2000,
      new AbortController().signal,
      deps(signed),
    );
    expect(results.every((r) => r.status === 'error')).toBe(true);
  });
});

describe('searchLeg verdict', () => {
  async function answerOf(items: Array<Record<string, unknown>>) {
    const { fetchImpl } = stub(() => json(200, twoList(items, null)));
    const results = await searchLeg('prompt', CONFIG, {}, fetchImpl).request(
      q('why'),
      2000,
      new AbortController().signal,
      deps(signed),
    );
    return results[0]?.answer ?? null;
  }

  it('no candidates is a miss', async () => {
    expect(await answerOf([])).toBeNull();
  });

  it('the strong candidate at rank 2 beats an un-strong rank 1', async () => {
    const answer = await answerOf([
      candidate({ resourceId: '33333333-3333-4333-8333-333333333333' }),
      candidate({ strong: true, title: 'The real one' }),
    ]);
    expect(answer).toMatchObject({
      shelf: 'team',
      title: 'The real one',
      searchId: SEARCH_ID,
      form: 'finding',
      price: '0',
      handle: 'ali',
      excerpt: 'the image tag changed',
    });
  });

  it('three candidates and no strong is a miss, and the row still names rank 1', async () => {
    // The client has no quality rule of its own: nothing the shelf vouched for
    // is nothing to say. The leg row keeps what the shelf DID offer, so the
    // ledger can count how often an offer came back with no vouch behind it.
    const { fetchImpl } = stub(() =>
      json(200, {
        shelf: envelope(
          [
            candidate({ title: 'Rank one' }),
            candidate({ resourceId: '33333333-3333-4333-8333-333333333333' }),
            candidate({ resourceId: '44444444-4444-4444-8444-444444444444' }),
          ],
          'lexical-v1',
        ),
        public: null,
      }),
    );
    const results = await searchLeg('prompt', CONFIG, {}, fetchImpl).request(
      q('why'),
      2000,
      new AbortController().signal,
      deps(signed),
    );
    expect(results[0]?.answer).toBeNull();
    // `lexical-v1` is the shelf saying the meaning step never ran, which is why
    // a spent embedding budget is not the same fact as an empty shelf.
    expect(results[0]).toMatchObject({
      status: 'ok',
      searchId: SEARCH_ID,
      calibration: 'lexical-v1',
      title: 'Rank one',
      url: `${BASE}/p/one`,
      form: 'finding',
    });
  });

  it('reads the candidate body into answer.text, and a strong row without one carries none', async () => {
    const withBody = await answerOf([
      candidate({ strong: true, body: { text: 'the collation flips on an image swap' } }),
    ]);
    expect(withBody?.text).toBe('the collation flips on an image swap');

    const bare = await answerOf([
      candidate({ resourceId: '44444444-4444-4444-8444-444444444444' }),
      candidate({ strong: true }),
    ]);
    expect(bare?.resourceId).toBe('22222222-2222-4222-8222-222222222222');
    expect(bare?.text).toBeUndefined();
  });
});

describe('keysLeg', () => {
  const KEYS = ['sig_v1:abc', 'sig_v1_test:def'];

  it('posts the fingerprints to the shelf keys route, signed', async () => {
    const { fetchImpl, calls } = stub(() => json(200, envelope([])));
    const leg = keysLeg(CONFIG, KEYS, fetchImpl);
    const results = await leg.request(
      q('ignored'),
      3000,
      new AbortController().signal,
      deps(signed),
    );
    expect(results.map((r) => r.shelf)).toEqual(['keys']);
    expect(results[0]?.status).toBe('ok');
    expect(leg.shelves).toEqual(['keys']);
    expect(calls[0]?.url).toBe(`${BASE}/api/shelves/${SHELF}/keys/resolve`);
    expect(calls[0]?.headers.get('tenjin-session-delegation')).toBe('stub');
    // Exactly `resolveRequestSchema`'s shape (a strict object): keys, trigger,
    // limit. No question, no budget: a key is not a search.
    expect(await body(calls)).toEqual({
      keys: [
        { kind: 'fingerprint', key: 'sig_v1:abc' },
        { kind: 'fingerprint', key: 'sig_v1_test:def' },
      ],
      trigger: 'failure',
      limit: 3,
    });
  });

  it('has no unsigned fallback: there is no public resolve to fall back to', async () => {
    const { fetchImpl, calls } = stub(() => json(200, envelope([])));
    const results = await keysLeg(CONFIG, KEYS, fetchImpl).request(
      q(''),
      3000,
      new AbortController().signal,
      deps(cannotSign),
    );
    expect(calls).toHaveLength(0);
    expect(results[0]).toMatchObject({
      shelf: 'keys',
      status: 'refused',
      authError: 'unauthenticated: WALLET_LOCKED',
    });
  });

  it('a 404 (keys not enabled) is one refused row, and nothing else remembers it', async () => {
    const { fetchImpl } = stub(() => json(404, { error: { code: 'not_enabled' } }));
    const results = await keysLeg(CONFIG, KEYS, fetchImpl).request(
      q(''),
      3000,
      new AbortController().signal,
      deps(signed),
    );
    expect(results).toEqual([{ shelf: 'keys', status: 'refused', answer: null }]);
  });

  it('a 200 with items is a hit on the first item, strong or not, calibration key-v1', async () => {
    const { fetchImpl } = stub(() =>
      json(200, envelope([candidate({ title: 'Fixed here' })], 'key-v1')),
    );
    const results = await keysLeg(CONFIG, KEYS, fetchImpl).request(
      q(''),
      3000,
      new AbortController().signal,
      deps(signed),
    );
    expect(results[0]).toMatchObject({ status: 'ok', calibration: 'key-v1', searchId: SEARCH_ID });
    expect(results[0]?.answer).toMatchObject({
      shelf: 'keys',
      title: 'Fixed here',
      searchId: SEARCH_ID,
      resourceId: '22222222-2222-4222-8222-222222222222',
    });
  });

  it('a 200 with no items is a miss', async () => {
    const { fetchImpl } = stub(() => json(200, envelope([], 'key-v1')));
    const results = await keysLeg(CONFIG, KEYS, fetchImpl).request(
      q(''),
      3000,
      new AbortController().signal,
      deps(signed),
    );
    expect(results[0]?.status).toBe('ok');
    expect(results[0]?.answer).toBeNull();
  });
});
