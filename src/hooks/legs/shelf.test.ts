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
/** The QUALIFIED name, which is the only form the config or the wire carries. */
const SHELF = 'backtrack/backtrack';

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

/** The two-list body a search naming a shelf answers with. */
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
  it('posts once to /api/search with the shelf in the body, signed, and yields both sets', async () => {
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
    // ONE ENDPOINT, and the shelf is a body field: there is no per-shelf path a
    // question could be sent down by mistake.
    expect(calls[0]?.url).toBe(`${BASE}/api/search`);
    expect(calls[0]?.headers.get('tenjin-session-delegation')).toBe('stub');
    expect((await calls[0]!.clone().json()) as Record<string, unknown>).toMatchObject({
      shelf: SHELF,
    });
    expect(results.map((r) => r.shelf)).toEqual(['team', 'public']);
    expect(setOf(results, 'team')?.searchId).toBe(SEARCH_ID);
    expect(setOf(results, 'public')?.searchId).toBe(PUBLIC_SEARCH_ID);
  });

  it('the shelf is a QUALIFIED name in the body, and there is still no `scope`', async () => {
    const { fetchImpl, calls } = stub(() => json(200, twoList([], [])));
    await searchLeg('research', CONFIG, {}, fetchImpl).request(
      q('why'),
      3200,
      new AbortController().signal,
      deps(signed),
    );
    const sent = await body(calls);
    expect(sent).toMatchObject({ trigger: 'research', limit: 3, budget_ms: 3200 });
    // The org half is what makes the name an identity: a bare `backtrack` would
    // name a different shelf in every org that has one.
    expect(sent.shelf).toBe(SHELF);
    expect(String(sent.shelf)).toContain('/');
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

  it('a public list the server withheld is a `withheld` ROW, not a missing one', async () => {
    const { fetchImpl, calls } = stub(() =>
      json(200, twoList([candidate({ strong: true })], null)),
    );
    const results = await searchLeg('prompt', CONFIG, {}, fetchImpl).request(
      q('why'),
      2000,
      new AbortController().signal,
      deps(signed),
    );
    // Asked for public and did not get it. No error and no retry — but the row
    // is filed, because the server deciding this question needed no public run
    // is a fact about this fire, and a dropped row said exactly what a round
    // that never planned the set says.
    expect((await body(calls)).includePublic).toBe(true);
    expect(results.map((r) => r.shelf)).toEqual(['team', 'public']);
    expect(results[0]?.status).toBe('ok');
    expect(results[1]).toEqual({ shelf: 'public', status: 'withheld', answer: null });
    // WHY it was withheld is still not inferred: an org policy of off and a
    // deployment that runs the marketplace only on a team miss are one status.
    expect(results[1]?.authError).toBeUndefined();
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
    // The same endpoint, with NO shelf in the body: an unsigned shelf request is
    // a 401 and no answer, so the fallback drops the field rather than the call.
    expect(calls[0]?.url).toBe(`${BASE}/api/search`);
    expect((await body(calls)).shelf).toBeUndefined();
    expect(results.map((r) => r.shelf)).toEqual(['public']);
    expect(results[0]?.answer).not.toBeNull();
    expect(results[0]?.authError).toBe('unauthenticated: WALLET_LOCKED');
  });

  /**
   * THE FALLBACK IS NOT UNCONDITIONAL. A round that asked for the shelf alone
   * has no marketplace to fall back to: the failure arm masks failure text and
   * sends it shelf-only on purpose (decision 13), and `publicFallback: off` is
   * a machine saying the same thing about every round. An expired session must
   * not turn either of those into a question for tenjin.blog.
   */
  it('unauthenticated on a shelf-only round asks nobody, and the row says why', async () => {
    const { fetchImpl, calls } = stub(() => json(200, envelope([candidate({ strong: true })])));
    const results = await searchLeg('failure', CONFIG, { includePublic: false }, fetchImpl).request(
      q('Error: the token ghp_x is invalid'),
      2000,
      new AbortController().signal,
      deps(cannotSign),
    );
    expect(calls).toHaveLength(0);
    expect(results.map((r) => r.shelf)).toEqual(['team']);
    expect(results[0]?.status).toBe('refused');
    expect(results[0]?.answer).toBeNull();
    expect(results[0]?.authError).toBe('unauthenticated: WALLET_LOCKED');
  });

  it('no wallet on a publicFallback:off machine asks nobody either', async () => {
    const offCfg: KernelConfig = { ...CONFIG, team: { publicFallback: 'off' } };
    const { fetchImpl, calls } = stub(() => json(200, envelope([])));
    const results = await searchLeg('prompt', offCfg, {}, fetchImpl).request(
      q('why'),
      2000,
      new AbortController().signal,
      deps(noWallet),
    );
    expect(calls).toHaveLength(0);
    expect(results.map((r) => r.shelf)).toEqual(['team']);
    expect(results[0]?.status).toBe('refused');
    expect(results[0]?.authError).toBeUndefined();
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
    // A 404 on a call that named a shelf means "not a member, or no such org or
    // shelf", which the server answers identically on purpose; `tenjin doctor`
    // is where a user learns which. A rejected signature is the same class of
    // fact. Both carry a REASON as well as a status; see the case below.
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

  /**
   * A REFUSAL IS NEVER SILENT. A status alone reads in the ledger like any other
   * empty answer; these two are an OPERATOR's problem, with two different
   * remedies, so each row carries the sentence that names which. It rides to
   * `fires.error`, the column doctor already reads.
   */
  it.each([
    [401, 'unauthenticated'],
    [403, 'unauthenticated'],
    [404, 'not-a-member'],
  ])('a %i on a shelf call files the reason on every row', async (status, reason) => {
    const { fetchImpl } = stub(() => json(status, { error: 'nope' }));
    const results = await searchLeg('prompt', CONFIG, {}, fetchImpl).request(
      q('why'),
      2000,
      new AbortController().signal,
      deps(signed),
    );
    expect(results.map((r) => r.shelf)).toEqual(['team', 'public']);
    for (const r of results) {
      expect(r.status).toBe('refused');
      expect(String(r.authError)).toContain(reason);
      expect(String(r.authError)).toContain(SHELF);
    }
  });

  /** And a machine on no shelf has no membership to be refused for: an
   *  anonymous public call that 404s is a bare status and nothing more. */
  it('files no reason for a public-only call, which has no shelf to be refused from', async () => {
    const { fetchImpl } = stub(() => json(404, { error: 'nope' }));
    const results = await searchLeg('prompt', NO_SHELF, {}, fetchImpl).request(
      q('why'),
      2000,
      new AbortController().signal,
      deps(noWallet),
    );
    expect(results).toEqual([{ shelf: 'public', status: 'refused', answer: null }]);
  });

  /**
   * THE OTHER POLARITY. The five cases above all run the default config, whose
   * `publicFallback` is on; a round that asked for the shelf ALONE must not
   * file a `public` row saying the marketplace failed a call it never made. The
   * failure arm's text round is exactly that round, every time it fires.
   */
  it('a failure on an includePublic:false round files ONE row, the team one', async () => {
    const { fetchImpl } = stub(() => json(500, { error: 'boom' }));
    const results = await searchLeg('failure', CONFIG, { includePublic: false }, fetchImpl).request(
      q('Error: boom'),
      2000,
      new AbortController().signal,
      deps(signed),
    );
    expect(results.map((r) => r.shelf)).toEqual(['team']);
    expect(results[0]?.status).toBe('http_500');
  });

  it('a shelf-only round drops a public list the server sent anyway', async () => {
    // Same rule read from the other end: the round declared one set, so one set
    // is what the ledger gets, whatever the server volunteered.
    const { fetchImpl } = stub(() =>
      json(200, twoList([candidate({ strong: true })], [candidate({ strong: true })])),
    );
    const results = await searchLeg('failure', CONFIG, { includePublic: false }, fetchImpl).request(
      q('Error: boom'),
      2000,
      new AbortController().signal,
      deps(signed),
    );
    expect(results.map((r) => r.shelf)).toEqual(['team']);
  });

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

  it('posts the fingerprints to /api/keys/resolve with the shelf named, signed', async () => {
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
    expect(calls[0]?.url).toBe(`${BASE}/api/keys/resolve`);
    expect(calls[0]?.headers.get('tenjin-session-delegation')).toBe('stub');
    // Exactly `resolveRequestSchema`'s shape (a strict object): keys, trigger,
    // limit and the shelf. No question, no budget: a key is not a search. No
    // `includePublic` either, because there is no public resolve to ask for.
    expect(await body(calls)).toEqual({
      keys: [
        { kind: 'fingerprint', key: 'sig_v1:abc' },
        { kind: 'fingerprint', key: 'sig_v1_test:def' },
      ],
      trigger: 'failure',
      limit: 3,
      shelf: SHELF,
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

  it('a 404 carrying not_enabled says KEYS ARE OFF, not that this creator is a stranger', async () => {
    const { fetchImpl } = stub(() => json(404, { error: { code: 'not_enabled' } }));
    const results = await keysLeg(CONFIG, KEYS, fetchImpl).request(
      q(''),
      3000,
      new AbortController().signal,
      deps(signed),
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ shelf: 'keys', status: 'refused', answer: null });
    /**
     * NEVER SILENT, AND NEVER THE WRONG REMEDY. A 404 on this endpoint has two
     * causes: not a member, or knowledge keys off on the shelf. The server said
     * which, so the row says which. Telling a member they are not in the org
     * sends them to an admin who has nothing to fix.
     */
    const reason = String(results[0]?.authError);
    expect(reason).toContain('keys-off');
    expect(reason).toContain('KNOWLEDGE_KEYS');
    expect(reason).not.toContain('not-a-member');
    expect(reason).toContain(SHELF);
  });

  it('a 404 with no code names BOTH causes rather than picking one', async () => {
    const { fetchImpl } = stub(() => json(404, { error: 'nope' }));
    const results = await keysLeg(CONFIG, KEYS, fetchImpl).request(
      q(''),
      3000,
      new AbortController().signal,
      deps(signed),
    );
    expect(results[0]).toMatchObject({ shelf: 'keys', status: 'refused', answer: null });
    // The ambiguous case is the one the old single sentence got wrong: with
    // nothing to tell the two apart, the row states both and names the shelf.
    const reason = String(results[0]?.authError);
    expect(reason).toContain('knowledge keys are off');
    expect(reason).toContain('not in that org');
    expect(reason).toContain(SHELF);
  });

  it('a 401 on the keys call reads the same as on search', async () => {
    const { fetchImpl } = stub(() => json(401, { error: 'nope' }));
    const results = await keysLeg(CONFIG, KEYS, fetchImpl).request(
      q(''),
      3000,
      new AbortController().signal,
      deps(signed),
    );
    expect(results[0]).toMatchObject({ shelf: 'keys', status: 'refused' });
    expect(String(results[0]?.authError)).toContain('unauthenticated');
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
