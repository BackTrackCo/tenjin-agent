// The eval harness scores retrieval, so its own scoring has to be right: a
// mislabelled outcome would quietly turn a regression into a green table. These
// cover the pure decision logic (wire response -> outcome, similarity -> floor
// stats) plus the gold set's structural invariants.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DENSE_COSINE_SIMILARITY_FLOOR } from '@/lib/search/fuse';
import { GOLD_SET, REGISTERS, type GoldEntry } from './eval/lookup-gold-set';
import {
  FLOOR,
  FLOOR_MODE_SCOPE,
  formatResultLine,
  GOLD_IDENTITY_SQL,
  isLookupResponse,
  parseFlags,
  parseFloors,
  runOne,
  scoreEntry,
  SCORES_SQL,
  sweepFloor,
  type ApiResult,
  type LookupResponseWire,
  type Outcome,
  type QueryScores,
  evalGate,
} from './eval-lookup-recall';
import { canonicalClientProduct, resolveClientProduct } from '@/lib/client-product';
import { EVAL_CLIENT_NAME } from '@/lib/search/client-names';

const hitEntry: GoldEntry = {
  id: 't-hit',
  query: 'q',
  register: 'why-how',
  expected: 'HIT',
  expectedSlug: 'right-piece',
  expectedResourceId: 'id-right',
  source: 'test',
};

const missEntry: GoldEntry = {
  id: 't-miss',
  query: 'q',
  register: 'negative',
  expected: 'MISS',
  source: 'test',
};

function candidate(slug: string, resourceId: string) {
  return { resourceId, url: `https://tenjin.blog/api/read/0xabc/${slug}`, slug, title: slug };
}

/** A v3 decision body. There is no MISS envelope: an abstain is `items: []` with
 *  `matched: 0`, which is exactly what an empty `slugs` produces here. */
function response(slugs: [string, string][] = []): LookupResponseWire {
  const items = slugs.map(([slug, id]) => candidate(slug, id));
  return {
    schemaVersion: 3,
    calibration: 'hybrid-v1',
    items,
    matched: items.length,
    ...(items.length === 0 ? { hint: 'No matches. Browse the catalog at GET /api/articles.' } : {}),
  };
}

describe('floor-mode retrieval contract', () => {
  it('keeps cardless posts in both DB-direct samples without reviving completeness gates', () => {
    for (const query of [SCORES_SQL, GOLD_IDENTITY_SQL]) {
      expect(query).toMatch(/left join resource_metadata/i);
      expect(query).not.toMatch(/cache_eligible/i);
      expect(query).toMatch(/rm\.valid_until is null/i);
    }
  });

  it('sweeps the shipped cosine floor and says the sweep cannot settle it alone', () => {
    // Imported from lib/search/fuse.ts, never restated: a retune there must move
    // what this sweep grades against, or the eval scores a floor prod dropped.
    expect(FLOOR).toBe(DENSE_COSINE_SIMILARITY_FLOOR);
    expect(FLOOR_MODE_SCOPE).toContain('DENSE LEG ALONE');
    expect(FLOOR_MODE_SCOPE).toContain('confirm end to end with api mode');
  });
});

describe('evalGate', () => {
  const junkEntry: GoldEntry = {
    id: 'junk-x',
    query: 'write a haiku about ducks',
    register: 'junk',
    expected: 'MISS',
    source: 'test',
    prodOnly: true,
  };
  const result = (entry: GoldEntry, outcome: ApiResult['outcome']): ApiResult => ({
    entry,
    outcome,
    calibration: 'hybrid-v1',
    topSlug: null,
  });

  it('fails on a single junk-register FALSE-POS', () => {
    const v = evalGate([result(hitEntry, 'HIT@1'), result(junkEntry, 'FALSE-POS')]);
    expect(v.ok).toBe(false);
    expect(v.message).toContain('junk register');
  });

  it('passes with a FALSE-MISS, and says so: corpus churn is reported, not gated', () => {
    const v = evalGate([result(hitEntry, 'FALSE-MISS'), result(junkEntry, 'MISS-OK')]);
    expect(v.ok).toBe(true);
    expect(v.message).toContain('FALSE-MISS reported, not gated');
  });

  it('does not pass a run that scored nothing', () => {
    expect(evalGate([result(hitEntry, 'ERROR'), result(junkEntry, 'ERROR')]).ok).toBe(false);
  });

  it('ignores a negative-register FALSE-POS: those leaks are adjacent-topic, not the floor', () => {
    const neg: GoldEntry = { ...junkEntry, id: 'neg-x', register: 'negative' };
    expect(evalGate([result(neg, 'FALSE-POS'), result(junkEntry, 'MISS-OK')]).ok).toBe(true);
  });
});

describe('scoreEntry', () => {
  it('scores the expected piece at rank 1 as HIT@1', () => {
    const r = scoreEntry(hitEntry, response([['right-piece', 'id-right']]));
    expect(r.outcome).toBe('HIT@1');
    expect(r.topSlug).toBe('right-piece');
  });

  it('separates HIT@n from HIT@1 so a demotion is visible', () => {
    const r = scoreEntry(
      hitEntry,
      response([
        ['other', 'id-other'],
        ['right-piece', 'id-right'],
      ]),
    );
    expect(r.outcome).toBe('HIT@n');
  });

  it('calls a candidate list without the expected piece WRONG', () => {
    expect(scoreEntry(hitEntry, response([['other', 'id-other']])).outcome).toBe('WRONG');
  });

  it('calls an abstain on an answerable query FALSE-MISS', () => {
    expect(scoreEntry(hitEntry, response()).outcome).toBe('FALSE-MISS');
  });

  it('matches on resourceId even when the slug was truncated differently', () => {
    expect(scoreEntry(hitEntry, response([['renamed', 'id-right']])).outcome).toBe('HIT@1');
  });

  it('carries truncated through to the result without changing the score', () => {
    const clipped: LookupResponseWire = {
      ...response([['other', 'id-other']]),
      truncated: true,
    };
    const r = scoreEntry(hitEntry, clipped);
    // Still WRONG: the dropped candidate might have been the expected piece, but
    // the harness does not get to guess. It reports the caveat instead.
    expect(r.outcome).toBe('WRONG');
    expect(r.truncated).toBe(true);
    expect(formatResultLine(r)).toContain('[truncated]');
  });

  it('leaves truncated unset when the page fit, so the marker means something', () => {
    const r = scoreEntry(hitEntry, response([['right-piece', 'id-right']]));
    expect(r.truncated).toBeUndefined();
    expect(formatResultLine(r)).not.toContain('[truncated]');
  });

  it('reads the slug off the item rather than parsing it back out of the url', () => {
    // An item carries slug precisely so clients stop splitting the url. A url whose
    // last segment disagrees must not win: the field is the source of truth.
    const r = scoreEntry(hitEntry, {
      schemaVersion: 3,
      calibration: 'hybrid-v1',
      matched: 1,
      items: [
        {
          resourceId: 'id-other',
          url: 'https://tenjin.blog/api/read/0xabc/right-piece',
          slug: 'actually-a-different-piece',
          title: 't',
        },
      ],
    });
    expect(r.outcome).toBe('WRONG');
    expect(r.topSlug).toBe('actually-a-different-piece');
  });

  it('reads the abstain off `items`, not off the `matched` count', () => {
    // A server that miscounts must not manufacture a hit or a miss: the outcome
    // rests on what actually came back. Both directions, since either would show
    // up as a retrieval move that never happened.
    const lying: LookupResponseWire = { ...response([['right-piece', 'id-right']]), matched: 0 };
    expect(scoreEntry(hitEntry, lying).outcome).toBe('HIT@1');
    const empty: LookupResponseWire = { ...response(), matched: 7 };
    expect(scoreEntry(missEntry, empty).outcome).toBe('MISS-OK');
  });

  it('scores negatives on abstention', () => {
    expect(scoreEntry(missEntry, response()).outcome).toBe('MISS-OK');
    expect(scoreEntry(missEntry, response([['any', 'id-any']])).outcome).toBe('FALSE-POS');
  });
});

describe('sweepFloor', () => {
  const scored: QueryScores[] = [
    {
      entry: hitEntry,
      ranked: [
        { slug: 'right-piece', postId: 'id-right', similarity: 0.55, best: 0.55 },
        { slug: 'other', postId: 'id-other', similarity: 0.5, best: 0.5 },
      ],
    },
    {
      entry: missEntry,
      ranked: [{ slug: 'other', postId: 'id-other', similarity: 0.52, best: 0.52 }],
    },
  ];

  it('counts a correct top card and a negative false positive below both similarities', () => {
    expect(sweepFloor(scored, 0.45)).toEqual({
      at1: 1,
      wrong: 0,
      abstain: 0,
      falsePos: 1,
      missOk: 0,
    });
  });

  it('abstains everything above every similarity', () => {
    expect(sweepFloor(scored, 0.6)).toEqual({
      at1: 0,
      wrong: 0,
      abstain: 1,
      falsePos: 0,
      missOk: 1,
    });
  });

  it('drops the entries under the floor and keeps the ones over it', () => {
    // At 0.53 the expected piece is the only survivor for the HIT entry, and the
    // negative's 0.52 neighbour drops out.
    expect(sweepFloor(scored, 0.53)).toEqual({
      at1: 1,
      wrong: 0,
      abstain: 0,
      falsePos: 0,
      missOk: 1,
    });
  });

  it('counts a surviving top card that is the wrong piece as wrong, not a hit', () => {
    const inverted: QueryScores[] = [
      {
        entry: hitEntry,
        ranked: [
          { slug: 'other', postId: 'id-other', similarity: 0.6, best: 0.6 },
          { slug: 'right-piece', postId: 'id-right', similarity: 0.55, best: 0.55 },
        ],
      },
    ];
    expect(sweepFloor(inverted, 0.45)).toEqual({
      at1: 0,
      wrong: 1,
      abstain: 0,
      falsePos: 0,
      missOk: 0,
    });
  });
});

describe('parseFloors', () => {
  it('walks the range inclusively without float drift', () => {
    expect(parseFloors('0.35:0.50:0.05')).toEqual([0.35, 0.4, 0.45, 0.5]);
  });

  it('rejects a malformed spec instead of sweeping nothing', () => {
    expect(() => parseFloors('0.35:0.70')).toThrow(/from:to:step/);
    expect(() => parseFloors('0.35:0.70:0')).toThrow(/from:to:step/);
  });

  it('rejects a non-numeric bound, which would otherwise sweep an empty range', () => {
    expect(() => parseFloors('abc:0.70:0.05')).toThrow(/from:to:step/);
    expect(() => parseFloors('0.35:abc:0.05')).toThrow(/from:to:step/);
    expect(() => parseFloors('0.35:0.70:abc')).toThrow(/from:to:step/);
  });

  it('walks a sub-0.01 step instead of silently coarsening it to 0.01', () => {
    expect(parseFloors('0.44:0.46:0.005')).toEqual([0.44, 0.445, 0.45, 0.455, 0.46]);
  });

  it('rejects a step finer than the sweep resolution, which would never advance', () => {
    expect(() => parseFloors('0.35:0.70:0.0004')).toThrow(/resolution/);
  });

  it('rejects a reversed range instead of printing an empty table', () => {
    expect(() => parseFloors('0.70:0.35:0.05')).toThrow(/from <= to/);
  });
});

describe('parseFlags', () => {
  it('rejects a space-separated flag rather than falling back to the prod default', () => {
    expect(() => parseFlags(['--base', 'http://localhost:3000'])).toThrow(/--name=value/);
  });

  it('rejects an unknown flag', () => {
    expect(() => parseFlags(['--bse=http://localhost:3000'])).toThrow(/unknown flag/);
  });

  it('rejects a non-numeric delay, which would fire every request at once', () => {
    expect(() => parseFlags(['--delay=abc'])).toThrow(/--delay expects a number/);
    expect(() => parseFlags(['--delay=-1'])).toThrow(/--delay expects a number/);
  });

  it('rejects a non-numeric limit, which would score an empty run as all n/a', () => {
    expect(() => parseFlags(['--limit=abc'])).toThrow(/--limit expects a number/);
    expect(() => parseFlags(['--limit=0'])).toThrow(/--limit expects a number/);
  });

  it('takes a well-formed base and strips its trailing slash', () => {
    expect(parseFlags(['--base=http://localhost:3000/']).base).toBe('http://localhost:3000');
  });
});

describe('formatResultLine', () => {
  // .github/workflows/lookup-eval.yml fails the weekly run on `grep -c '^ERROR'`,
  // so an ERROR line must start with the word and nothing else may. Without this,
  // an indent or a leading timestamp would leave the job permanently green.
  function line(outcome: Outcome, over: Partial<ApiResult> = {}): string {
    return formatResultLine({
      entry: outcome === 'MISS-OK' ? missEntry : hitEntry,
      outcome,
      calibration: 'hybrid-v1',
      topSlug: null,
      ...over,
    });
  }

  it('leads an ERROR line with the outcome, which is the workflow fail signal', () => {
    expect(line('ERROR', { calibration: '-', note: 'HTTP 429 (raise --delay)' })).toMatch(
      /^ERROR /,
    );
  });

  it('never starts a non-ERROR line with ERROR', () => {
    const others: Outcome[] = ['HIT@1', 'HIT@n', 'WRONG', 'FALSE-MISS', 'MISS-OK', 'FALSE-POS'];
    for (const outcome of others) expect(line(outcome).startsWith('ERROR')).toBe(false);
  });

  // The workflow also counts SCORED entries, to catch a run that errored or was
  // throttled end to end and would otherwise exit green having measured nothing.
  // That count greps the same six tokens, so each has to lead its own line.
  it('leads every line with its own outcome token, which the scored count greps', () => {
    const outcomes: Outcome[] = [
      'HIT@1',
      'HIT@n',
      'WRONG',
      'FALSE-MISS',
      'MISS-OK',
      'FALSE-POS',
      'ERROR',
    ];
    for (const outcome of outcomes) {
      expect(line(outcome).startsWith(`${outcome} `)).toBe(true);
    }
  });

  it('keeps the expected/got detail off the outcomes that made no comparison', () => {
    expect(line('HIT@1', { topSlug: 'right-piece' })).not.toContain('expected=');
    expect(line('MISS-OK')).not.toContain('expected=');
    // ERROR never reached a comparison, so `got=(miss)` would read as an abstain
    // the endpoint never made.
    expect(line('ERROR', { calibration: '-', note: 'HTTP 404 (no path)' })).not.toContain(
      'expected=',
    );
    expect(line('WRONG', { topSlug: 'other-piece' })).toContain(
      'expected=right-piece got=other-piece',
    );
  });
});

describe('runOne', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function respond(status: number) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status })));
  }

  // The workflow separates throttling from real failures with
  // `grep -c '^ERROR.*HTTP 429'`, and warns rather than failing on the former.
  // Driven through runOne rather than a hand-written note, so a change to how the
  // note is BUILT breaks this too, not just a change to how the line is laid out.
  it('renders a 429 into a line the workflow throttle-grep matches', async () => {
    respond(429);
    const result = await runOne('https://x.test', hitEntry);
    expect(result.outcome).toBe('ERROR');
    expect(formatResultLine(result)).toMatch(/^ERROR.*HTTP 429/);
  });

  it('leaves an unpromoted-path 404 out of the throttle-grep, so it stays a failure', async () => {
    respond(404);
    const rendered = formatResultLine(await runOne('https://x.test', hitEntry));
    expect(rendered).toMatch(/^ERROR /);
    expect(rendered).not.toMatch(/HTTP 429/);
  });

  // The likeliest red after a consolidation ships: the runner asks for v3 and the
  // target still enforces v2, which is a promotion gap and not a retrieval problem.
  it('names the version gap when a pre-v3 target rejects the request', async () => {
    respond(400);
    const result = await runOne('https://x.test', hitEntry);
    expect(result.outcome).toBe('ERROR');
    expect(result.note).toContain('older than the v3 consolidation');
  });

  // The #629 promotion signal: a target still routing the retired alias answers
  // 410 here, which is neither throttling nor drift and must say so.
  it('names a 410 as a retired-alias route rather than shape drift', async () => {
    respond(410);
    const result = await runOne('https://x.test', hitEntry);
    expect(result.outcome).toBe('ERROR');
    expect(result.note).toContain('retired alias');
  });

  // The whole path on one realistic body: v3 request out, full lean item back,
  // parsed, scored. The unit tests each cover a slice of this; without it nothing
  // proves the slices compose against the shape the server actually returns.
  it('scores a real v3 body end to end', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          schemaVersion: 3,
          searchId: '018f8e2e-0000-7000-8000-000000000000',
          calibration: 'hybrid-v1',
          matched: 1,
          items: [
            {
              resourceId: 'id-right',
              url: 'https://tenjin.blog/api/read/0xabc/right-piece',
              slug: 'right-piece',
              title: 'The right piece',
              artifactType: 'runbook',
              price: '250000',
              asOf: '2026-07-01T00:00:00.000Z',
              validUntil: null,
              matchReasons: ['title match'],
              estimatedTokens: 1800,
              creator: { handle: '0xabc' },
              confidence: 'high',
              corroborated: true,
            },
          ],
        }),
      ),
    );
    const result = await runOne('https://x.test', hitEntry);
    expect(result.outcome).toBe('HIT@1');
    expect(result.topSlug).toBe('right-piece');
    expect(result.calibration).toBe('hybrid-v1');
    expect(result.truncated).toBeUndefined();
  });

  // A version the harness does not know and a malformed body are different
  // problems. Sharing one note would send the reader hunting a broken payload
  // when the real answer is that the deploy moved to a contract this cannot score.
  it('names the version when a well-formed body is on another contract', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          schemaVersion: 2,
          searchId: 'id',
          decision: 'MISS',
          calibration: 'hybrid-v1',
        }),
      ),
    );
    const result = await runOne('https://x.test', hitEntry);
    expect(result.outcome).toBe('ERROR');
    expect(result.note).toBe('schemaVersion 2 != 3 (this harness scores v3 only)');
  });

  it('still reports a malformed body as shape drift, not as a version problem', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ nonsense: true })));
    const result = await runOne('https://x.test', hitEntry);
    expect(result.outcome).toBe('ERROR');
    expect(result.note).toContain('unexpected response shape');
  });

  it('sends the v3 decision request at the canonical path, with a stable eval identity', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    await runOne('https://x.test', hitEntry);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://x.test/api/search');
    const init = fetchMock.mock.calls[0]?.[1];
    const body: unknown = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      schemaVersion: 3,
      view: 'decision',
      query: hitEntry.query,
    });
    // The User-Agent is the whole identity now, and PROBE_CLIENT_NAMES filters on
    // the name it parses to, so a run that lost this header would silently publish
    // ~50 synthetic queries as real demand.
    expect(init?.headers).toMatchObject({ 'user-agent': 'tenjin-eval/1' });
    expect(init?.headers).not.toHaveProperty('x-tenjin-client');
    expect(
      canonicalClientProduct(resolveClientProduct(new Headers(init?.headers as HeadersInit))),
    ).toBe(EVAL_CLIENT_NAME);
  });
});

describe('isLookupResponse', () => {
  it('accepts the shapes the endpoint actually returns', () => {
    expect(isLookupResponse(response())).toBe(true);
    expect(isLookupResponse(response([['a', 'id-a']]))).toBe(true);
    expect(isLookupResponse({ ...response([['a', 'id-a']]), truncated: true })).toBe(true);
  });

  it('rejects a drifted body so it scores as ERROR instead of a retrieval failure', () => {
    expect(isLookupResponse(null)).toBe(false);
    expect(isLookupResponse({ error: 'gone' })).toBe(false);
    // `items` absent is DRIFT, never an abstain: v3 always carries the array, so
    // accepting its absence would score a broken contract as a correct MISS.
    expect(isLookupResponse({ schemaVersion: 3, calibration: 'hybrid-v1', matched: 0 })).toBe(
      false,
    );
    expect(isLookupResponse({ schemaVersion: 3, items: [], matched: 0 })).toBe(false);
    expect(isLookupResponse({ schemaVersion: 3, calibration: 'hybrid-v1', items: [] })).toBe(false);
    expect(
      isLookupResponse({
        schemaVersion: 3,
        calibration: 'hybrid-v1',
        matched: 1,
        items: [{}],
      }),
    ).toBe(false);
  });

  // A pre-consolidation deploy answers a v3 request with a 400, so this path is
  // about a FUTURE bump: v4 must report as drift rather than being scored against
  // v3 rules.
  it('rejects a response whose schemaVersion is not the one this harness scores', () => {
    expect(isLookupResponse({ ...response(), schemaVersion: 2 })).toBe(false);
    expect(isLookupResponse({ ...response(), schemaVersion: 4 })).toBe(false);
    const versionless: Record<string, unknown> = { ...response() };
    delete versionless.schemaVersion;
    expect(isLookupResponse(versionless)).toBe(false);
  });

  // slug is one of the lean keys and scoring reads it directly, so a response that
  // drops it must not be scored as a retrieval failure.
  it('rejects an item missing slug', () => {
    expect(
      isLookupResponse({
        schemaVersion: 3,
        calibration: 'hybrid-v1',
        matched: 1,
        items: [{ resourceId: 'id-a', url: 'https://tenjin.blog/x', title: 'a' }],
      }),
    ).toBe(false);
  });

  it('rejects a truncated flag that is not the literal true the wire sends', () => {
    expect(isLookupResponse({ ...response(), truncated: false })).toBe(false);
  });

  // Transcribed from projectCandidate + SearchResultEnvelope in lib/search/project.ts
  // rather than from the shape this harness happens to want. The keys scoring
  // ignores are present on purpose: if the validator ever tightened into an
  // exact-key check, this is what would catch it.
  it('accepts the full decision-view item the v3 server actually sends', () => {
    expect(
      isLookupResponse({
        schemaVersion: 3,
        searchId: '018f8e2e-0000-7000-8000-000000000000',
        calibration: 'hybrid-v1',
        matched: 1,
        items: [
          {
            resourceId: '018f8e2e-0000-7000-8000-000000000001',
            url: 'https://tenjin.blog/api/read/0xabc/renovate-grouping',
            slug: 'renovate-grouping',
            title: 'Grouping Renovate updates',
            artifactType: 'runbook',
            excerpt: 'A public teaser.',
            temporalMode: 'snapshot',
            price: '250000',
            asOf: '2026-07-01T00:00:00.000Z',
            validUntil: null,
            matchReasons: ['title match'],
            estimatedTokens: 1800,
            creator: { handle: '0xabc' },
            confidence: 'high',
            corroborated: true,
          },
        ],
        inspect: { resourceId: '018f8e2e-0000-7000-8000-000000000001', free: false },
      }),
    ).toBe(true);
  });
});

describe('gold set', () => {
  it('has unique ids', () => {
    expect(new Set(GOLD_SET.map((e) => e.id)).size).toBe(GOLD_SET.length);
  });

  it('keeps every query inside the 512-char question cap', () => {
    for (const e of GOLD_SET) expect(e.query.length, e.id).toBeLessThanOrEqual(512);
  });

  it('pins a piece on every HIT and none on any MISS', () => {
    for (const e of GOLD_SET) {
      if (e.expected === 'HIT') {
        expect(e.expectedSlug, e.id).toBeTruthy();
        expect(e.expectedResourceId, e.id).toBeTruthy();
        expect(e.prodOnly, e.id).toBe(true);
      } else {
        expect(e.expectedSlug, e.id).toBeUndefined();
        expect(e.expectedResourceId, e.id).toBeUndefined();
      }
    }
  });

  it('covers every register, and every negative is an expected MISS', () => {
    const used = new Set(GOLD_SET.map((e) => e.register));
    for (const r of REGISTERS) expect(used.has(r), r).toBe(true);
    for (const e of GOLD_SET) {
      expect(e.register === 'negative' || e.register === 'junk', e.id).toBe(e.expected === 'MISS');
    }
  });

  it('carries a source note on every entry', () => {
    for (const e of GOLD_SET) expect(e.source.length, e.id).toBeGreaterThan(0);
  });
});
