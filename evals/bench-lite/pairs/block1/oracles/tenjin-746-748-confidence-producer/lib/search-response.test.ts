// Pure-surface tests for lib/search-response.ts: the token estimate and the DB-free
// projection/budget contract (buildSearchResponse is pure over its `rows`, so the
// lean-hit shape, the honored limit, and matchReasons tiering are unit-testable
// without Postgres). The DB-backed retrieval + gates live in
// tests/integration/agent-search.test.ts; the request-schema bounds live in
// lib/lookup.test.ts.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildSearchResponse, estimatedTokens, searchBudgetChars } from '@/lib/search-response';
import { clampAsOf } from '@/lib/resource-metadata';
import { log } from '@/lib/log';
import type { ResourceClaims } from '@/lib/resource-write';
import { BROWSE_MAX, type BrowseRow, type LookupRow } from '@/lib/search';

describe('estimatedTokens', () => {
  it('is ceil(wordCount * 1.33)', () => {
    expect(estimatedTokens(0)).toBe(0);
    expect(estimatedTokens(3)).toBe(4); // 3.99 -> 4
    expect(estimatedTokens(100)).toBe(133);
    expect(estimatedTokens(1000)).toBe(1330);
  });
});

// Synthetic post ids. The last uuid group is 12 hex digits, so the index is
// zero-padded into it: a bare interpolation overflows the group at i >= 10 and
// silently yields a malformed uuid.
function postId(i: number, group = '0'): string {
  return `0190a0b0-0000-7000-8000-${group}${String(i).padStart(11, '0')}`;
}

function makeRow(over: Partial<LookupRow> = {}): LookupRow {
  return {
    postId: '0190a0b0-0000-7000-8000-000000000001',
    slug: 'a-post',
    title: 'A Post',
    price: 100000n,
    handle: 'alice',
    artifactType: 'document',
    excerpt: 'A short public excerpt.',
    temporalMode: 'evergreen',
    asOf: null,
    validUntil: null,
    wordCount: 300,
    cacheEligible: true,
    carded: true,
    postHit: true,
    ...over,
  };
}

// A long but entirely ordinary page: a 120-char title, a 100-char slug, both
// dates, both match tiers. Well inside every cap, so the budget must never touch
// it at any limit.
function longRows(n: number): LookupRow[] {
  return Array.from({ length: n }, (_, i) =>
    makeRow({
      postId: postId(i),
      slug: 's'.repeat(100),
      title: 'T'.repeat(120),
      handle: 'a-publisher',
      excerpt: `${'word '.repeat(50)}end`,
      temporalMode: 'snapshot',
      price: 250000n,
      asOf: new Date('2026-07-01T00:00:00Z'),
      validUntil: new Date('2027-07-01T00:00:00Z'),
      wordCount: 3000,
      postHit: true,
      semanticHit: true,
    }),
  );
}

// Every projection cap at once: title 200, handle 80, a 200-char slug (2.5x the
// 80-char slugify cap, reachable only by a direct insert since the DB column is
// untyped text), and an excerpt long enough to fill any tier. This is the shape
// PER_CANDIDATE_BUDGET_CHARS is derived from, so a full page of it must still
// come back whole — the excerpt tier, not eviction, is what absorbs the overflow.
function maximalRows(n: number): LookupRow[] {
  return Array.from({ length: n }, (_, i) =>
    makeRow({
      postId: postId(i),
      slug: 's'.repeat(200),
      title: 'T'.repeat(200),
      handle: 'h'.repeat(80),
      excerpt: `${'word '.repeat(400)}end`,
      temporalMode: 'maintained',
      price: 2500000n,
      asOf: new Date('2026-07-01T00:00:00Z'),
      validUntil: new Date('2027-07-01T00:00:00Z'),
      wordCount: 12000,
      postHit: true,
      semanticHit: true,
    }),
  );
}

describe('buildSearchResponse', () => {
  it('returns MISS with no candidates key on zero rows', () => {
    const { response, decision, emitted } = buildSearchResponse([], 'lk');
    expect(response.schemaVersion).toBe(2);
    expect(response.decision).toBe('MISS');
    expect('candidates' in response).toBe(false);
    expect(decision).toBe('miss');
    expect(emitted).toEqual([]);
  });

  it('serializes the lean CANDIDATES contract (exact field set, digit price, payable URL)', () => {
    const { response, decision } = buildSearchResponse(
      [makeRow({ price: 250000n, asOf: new Date('2026-07-01T00:00:00Z') })],
      'lk',
    );
    expect(response.schemaVersion).toBe(2);
    expect(response.decision).toBe('CANDIDATES');
    expect(response.calibration).toBe('lexical-v1');
    expect(decision).toBe('candidates');
    const c = response.candidates![0]!;
    // The whole hit, pinned: depth beyond the excerpt lives behind the free
    // inspect fetch of `url` (or, for rank 1, the `inspect` block), so no card
    // field may creep back onto a candidate.
    expect(Object.keys(c).sort()).toEqual(
      [
        'artifactType',
        'asOf',
        'creator',
        'estimatedTokens',
        'excerpt',
        'matchReasons',
        'price',
        'resourceId',
        'slug',
        'temporalMode',
        'title',
        'url',
        'validUntil',
      ].sort(),
    );
    expect(c.price).toBe('250000');
    expect(c.url).toContain('/api/read/alice/a-post');
    // slug + creator.handle address a handle/slug API without parsing the url.
    expect(c.slug).toBe('a-post');
    expect(c.asOf).toBe('2026-07-01T00:00:00.000Z');
    expect(c.validUntil).toBeNull();
    expect(c.creator).toEqual({ handle: 'alice' });
    expect(c.estimatedTokens).toBe(estimatedTokens(300));
  });

  it('never names the answer card as a match reason (#628)', () => {
    // The card stopped being a ranking input on both legs, so no label may claim
    // it matched. Only the post lexical hit and the semantic hit remain.
    const postOnly = buildSearchResponse([makeRow({ postHit: true })], 'lk');
    expect(postOnly.response.candidates![0]!.matchReasons).toEqual(['title/excerpt lexical match']);
    expect(postOnly.emitted[0]!.reasons).toEqual(['title/excerpt lexical match']);
    for (const reason of postOnly.response.candidates![0]!.matchReasons) {
      expect(reason).not.toMatch(/card/i);
    }
  });

  it('appends `semantic match`, and carries it alone on a dense-only hit', () => {
    const fused = buildSearchResponse([makeRow({ postHit: true, semanticHit: true })], 'lk');
    expect(fused.response.candidates![0]!.matchReasons).toEqual([
      'title/excerpt lexical match',
      'semantic match',
    ]);
    const denseOnly = buildSearchResponse([makeRow({ postHit: false, semanticHit: true })], 'lk');
    expect(denseOnly.response.candidates![0]!.matchReasons).toEqual(['semantic match']);
  });

  it('derives confidence from the dense cosine alone and corroborated from both legs, never a raw score/similarity, omitted when fusion never ran', () => {
    // Both legs matched the same post: confidence still buckets on the dense
    // leg's own cosine (no longer forced to 'medium'), and corroborated is the
    // separate fact that the lexical leg agreed too.
    const both = buildSearchResponse(
      [makeRow({ postHit: true, semanticHit: true, score: 0.05, similarity: 0.7 })],
      'lk',
      'hybrid-v1',
    ).response.candidates![0]!;
    expect(both.confidence).toBe('high');
    expect(both.corroborated).toBe(true);
    expect('score' in both).toBe(false);
    expect('similarity' in both).toBe(false);

    // Dense-only (no lexical corroboration): same cosine bucket, corroborated
    // false — confidence and corroborated vary independently.
    const denseHigh = buildSearchResponse(
      [makeRow({ postHit: false, semanticHit: true, score: 0.05, similarity: 0.7 })],
      'lk',
      'hybrid-v1',
    ).response.candidates![0]!;
    expect(denseHigh.confidence).toBe('high');
    expect(denseHigh.corroborated).toBe(false);
    const denseMedium = buildSearchResponse(
      [makeRow({ postHit: false, semanticHit: true, score: 0.05, similarity: 0.55 })],
      'lk',
      'hybrid-v1',
    ).response.candidates![0]!;
    expect(denseMedium.confidence).toBe('medium');
    expect(denseMedium.corroborated).toBe(false);
    const denseLow = buildSearchResponse(
      [makeRow({ postHit: false, semanticHit: true, score: 0.05, similarity: 0.3 })],
      'lk',
      'hybrid-v1',
    ).response.candidates![0]!;
    expect(denseLow.confidence).toBe('low');
    expect(denseLow.corroborated).toBe(false);

    // Exact boundaries: both comparisons are inclusive (>=), so the constant
    // itself buckets into the tier it names, not the one below it.
    const denseAtHighBoundary = buildSearchResponse(
      [makeRow({ postHit: false, semanticHit: true, score: 0.05, similarity: 0.62 })],
      'lk',
      'hybrid-v1',
    ).response.candidates![0]!;
    expect(denseAtHighBoundary.confidence).toBe('high');
    const denseAtMediumBoundary = buildSearchResponse(
      [makeRow({ postHit: false, semanticHit: true, score: 0.05, similarity: 0.52 })],
      'lk',
      'hybrid-v1',
    ).response.candidates![0]!;
    expect(denseAtMediumBoundary.confidence).toBe('medium');

    // Lexical-only within a hybrid response (dense leg didn't contribute at
    // all): 'low', nothing to bucket a cosine on; corroborated false, since
    // the dense leg never confirmed it.
    const lexicalHitInHybrid = buildSearchResponse(
      [makeRow({ postHit: true, score: 0.05 })],
      'lk',
      'hybrid-v1',
    ).response.candidates![0]!;
    expect(lexicalHitInHybrid.confidence).toBe('low');
    expect(lexicalHitInHybrid.corroborated).toBe(false);

    // The lexical-only PATH never fuses at all, so a plain row carries
    // neither field — there is nothing to derive them from.
    const lexicalOnly = buildSearchResponse([makeRow({ postHit: true })], 'lk').response
      .candidates![0]!;
    expect('confidence' in lexicalOnly).toBe(false);
    expect('corroborated' in lexicalOnly).toBe(false);

    // A row carrying a stale `score` (e.g. a future pre-fused caller) still
    // omits both fields when the caller's own calibration says lexical-v1 —
    // the gate checks `calibration`, not just `row.score`.
    const staleScoreLexicalV1 = buildSearchResponse(
      [makeRow({ postHit: false, semanticHit: true, score: 0.05, similarity: 0.99 })],
      'lk',
      'lexical-v1',
    ).response.candidates![0]!;
    expect('confidence' in staleScoreLexicalV1).toBe(false);
    expect('corroborated' in staleScoreLexicalV1).toBe(false);

    // A non-finite similarity (a data bug, never a real cosine) buckets low
    // explicitly rather than falling through both `>=` comparisons unnoticed.
    const nonFiniteSimilarity = buildSearchResponse(
      [makeRow({ postHit: false, semanticHit: true, score: 0.05, similarity: NaN })],
      'lk',
      'hybrid-v1',
    ).response.candidates![0]!;
    expect(nonFiniteSimilarity.confidence).toBe('low');
  });

  it('never carries confidence on a browse-on-MISS item (a pointer, not a scored candidate)', () => {
    const browse: BrowseRow = {
      postId: postId(9),
      slug: 'a-browse',
      title: 'A Browse',
      price: 50_000n,
      handle: 'bob',
    };
    const { response } = buildSearchResponse([], 'lk', 'hybrid-v1', [browse]);
    const item = response.browse![0]!;
    expect('confidence' in item).toBe(false);
    expect('score' in item).toBe(false);
    expect('similarity' in item).toBe(false);
  });

  it('labels a bottom-tier candidate, and leaves an eligible one untouched', () => {
    // The only per-candidate way to tell the tiers apart: `inspect` covers rank 1
    // alone, and every other field of an uncarded candidate looks identical to a
    // carded one. The two false states stay distinct because the fix for each is.
    const uncarded = buildSearchResponse(
      [makeRow({ postHit: true, cacheEligible: false, carded: false })],
      'lk',
    );
    expect(uncarded.response.candidates![0]!.matchReasons).toEqual([
      'title/excerpt lexical match',
      'no answer card',
    ]);
    const thinCard = buildSearchResponse(
      [makeRow({ postHit: false, semanticHit: true, cacheEligible: false, carded: true })],
      'lk',
    );
    expect(thinCard.response.candidates![0]!.matchReasons).toEqual([
      'semantic match',
      'incomplete answer card',
    ]);
    // An ordinary candidate's reasons are byte-identical to what they always were.
    const eligible = buildSearchResponse([makeRow({ postHit: true })], 'lk');
    expect(eligible.response.candidates![0]!.matchReasons).toEqual(['title/excerpt lexical match']);
  });

  it('returns all 10 hits of a long-but-ordinary page, with no truncated flag (#499)', () => {
    // The regression the lean shape exists for: rich per-candidate cards used to
    // spend the budget by rank 3, so ranks 4..limit vanished. A 120-char-title,
    // 100-char-slug page is unremarkable and must come back whole.
    const { response, emitted } = buildSearchResponse(longRows(10), 'lk', 'hybrid-v1');
    expect(response.candidates).toHaveLength(10);
    expect('truncated' in response).toBe(false);
    expect(JSON.stringify(response).length).toBeLessThanOrEqual(searchBudgetChars(10));
    expect(emitted.map((e) => e.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('returns all 10 hits even at every projection cap (the budget derivation)', () => {
    // PER_CANDIDATE_BUDGET_CHARS is derived from this shape, so this test IS the
    // derivation: if a capped hit ever outgrows its allowance, this fails rather
    // than the ceiling quietly eating a rank.
    const { response } = buildSearchResponse(maximalRows(10), 'lk', 'hybrid-v1');
    expect(response.candidates).toHaveLength(10);
    expect('truncated' in response).toBe(false);
    expect(JSON.stringify(response).length).toBeLessThanOrEqual(searchBudgetChars(10));
  });

  it('honors the full limit at every limit, not just at 10', () => {
    // The budget scales with the requested page, so no limit is a cliff.
    for (const n of [1, 3, 5, 7, 10]) {
      const { response } = buildSearchResponse(maximalRows(n), 'lk');
      expect(response.candidates, `limit ${n}`).toHaveLength(n);
      expect('truncated' in response, `limit ${n}`).toBe(false);
      expect(JSON.stringify(response).length, `limit ${n}`).toBeLessThanOrEqual(
        searchBudgetChars(n),
      );
    }
  });

  it('flags `truncated` when an absurd slug overruns, ranking 1..n over what shipped', () => {
    // The one shape the per-candidate allowance cannot absorb: the slug is untyped
    // text in the DB, so nothing bounds it before projection.
    const rows = Array.from({ length: 10 }, (_, i) =>
      makeRow({ postId: postId(i), slug: 's'.repeat(4000) }),
    );
    const { response, emitted } = buildSearchResponse(rows, 'lk');
    expect(response.truncated).toBe(true);
    expect(response.candidates!.length).toBeLessThan(10);
    expect(JSON.stringify(response).length).toBeLessThanOrEqual(searchBudgetChars(10));
    // Telemetry records only what shipped, ranked 1..n.
    expect(emitted.map((e) => e.rank)).toEqual(response.candidates!.map((_, i) => i + 1));
    expect(emitted.map((e) => e.postId)).toEqual(
      response.candidates!.map((c) => c.resourceId as string),
    );
  });

  it('omits `truncated` entirely when a short list is simply all there was', () => {
    const { response } = buildSearchResponse(maximalRows(2), 'lk');
    expect(response.candidates).toHaveLength(2);
    expect('truncated' in response).toBe(false);
    expect(JSON.stringify(response)).not.toContain('truncated');
  });

  it('ships a lone over-ceiling candidate but flags it as truncated', () => {
    // A single lean hit over the ceiling means a pathological slug, not a rich
    // card: dropping it would answer CANDIDATES with an empty list. It still
    // breaches the budget, so the caller has to be told rather than handed an
    // oversized body that looks ordinary.
    const { response, emitted } = buildSearchResponse(
      [makeRow({ slug: 's'.repeat(searchBudgetChars(1)) })],
      'lk',
    );
    expect(response.decision).toBe('CANDIDATES');
    expect(response.candidates).toHaveLength(1);
    expect(emitted).toHaveLength(1);
    expect(JSON.stringify(response).length).toBeGreaterThan(searchBudgetChars(1));
    expect(response.truncated).toBe(true);
  });

  it('caps the title and the byline handle', () => {
    const c = buildSearchResponse(
      [makeRow({ title: 'T'.repeat(500), handle: 'h'.repeat(500) })],
      'lk',
    ).response.candidates![0]!;
    expect(c.title).toHaveLength(200);
    expect(c.creator.handle).toHaveLength(80);
  });
});

function makeBrowse(over: Partial<BrowseRow> = {}): BrowseRow {
  return {
    postId: '0190a0b0-0000-7000-8000-0000000000a1',
    slug: 'browse-post',
    title: 'A Browse Post',
    price: 50000n,
    handle: 'bob',
    ...over,
  };
}

describe('buildSearchResponse — browse-on-MISS (#460)', () => {
  it('carries a MISS `browse` list (decision stays MISS, no candidates, no matchReasons/confidence)', () => {
    const browse = [
      makeBrowse({ postId: '0190a0b0-0000-7000-8000-0000000000b1', slug: 'p1', price: 0n }),
      makeBrowse({ postId: '0190a0b0-0000-7000-8000-0000000000b2', slug: 'p2', price: 250000n }),
    ];
    const { response, decision, emitted } = buildSearchResponse([], 'lk', 'hybrid-v1', browse);
    expect(response.decision).toBe('MISS');
    expect('candidates' in response).toBe(false);
    expect(decision).toBe('miss');
    // Browse never rides the telemetry emitted set (never a candidate).
    expect(emitted).toEqual([]);
    expect(response.browse).toHaveLength(2);
    const first = response.browse![0]!;
    expect(first.url).toContain('/api/read/bob/p1');
    expect(first.price).toBe('0');
    expect(first.creator).toEqual({ handle: 'bob' });
    // No candidate-only signals leak onto a browse entry.
    expect('matchReasons' in first).toBe(false);
    expect('estimatedTokens' in first).toBe(false);
  });

  it('caps `browse` at BROWSE_MAX', () => {
    const browse = Array.from({ length: 6 }, (_, i) =>
      makeBrowse({ postId: postId(i), slug: `p-${i}` }),
    );
    const { response } = buildSearchResponse([], 'lk', 'lexical-v1', browse);
    expect(response.browse).toHaveLength(BROWSE_MAX);
  });

  it('omits `browse` entirely when empty, leaving a bare MISS at its four fields', () => {
    const bare = buildSearchResponse([], 'lk', 'lexical-v1', []);
    const legacy = buildSearchResponse([], 'lk');
    expect('browse' in bare.response).toBe(false);
    expect(JSON.stringify(bare.response)).toBe(JSON.stringify(legacy.response));
  });

  it('never attaches `browse` on the CANDIDATES path (never merged into candidates)', () => {
    const { response } = buildSearchResponse([makeRow()], 'lk', 'lexical-v1', [makeBrowse()]);
    expect(response.decision).toBe('CANDIDATES');
    expect('browse' in response).toBe(false);
  });

  it('keeps a maximal browse list under the budget on a MISS', () => {
    // Oversized titles/handles (truncated by projection) across more than the cap:
    // the whole serialized MISS response must still hold under the ceiling.
    const browse = Array.from({ length: BROWSE_MAX + 3 }, (_, i) =>
      makeBrowse({
        postId: postId(i, 'c'),
        slug: 's'.repeat(200),
        title: 'T'.repeat(2000),
        handle: 'h'.repeat(2000),
      }),
    );
    const { response } = buildSearchResponse([], 'lk', 'hybrid-v1', browse);
    expect(response.decision).toBe('MISS');
    expect(JSON.stringify(response).length).toBeLessThanOrEqual(searchBudgetChars(BROWSE_MAX));
  });
});

function makeCard(over: Partial<ResourceClaims> = {}): ResourceClaims {
  return {
    questionsAnswered: ['What should an agent do when a stablecoin depegs?'],
    scope: 'Stablecoin monitoring on Base',
    exclusions: 'Not legal advice',
    ...over,
  };
}

// The rank-1 card as buildSearchResponse takes it: paired with the post it was
// loaded for, so a mismatch is detectable rather than assumed away.
function rankOne(claims: ResourceClaims | null = makeCard(), postId = makeRow().postId) {
  return { postId, claims };
}

describe('candidate excerpt + temporalMode (#567)', () => {
  it('carries the excerpt and the temporal enum', () => {
    const c = buildSearchResponse(
      [makeRow({ excerpt: 'How to route around a depeg.', temporalMode: 'snapshot' })],
      'lk',
    ).response.candidates![0]!;
    expect(c.excerpt).toBe('How to route around a depeg.');
    expect(c.temporalMode).toBe('snapshot');
  });

  it('cuts a long excerpt at a word boundary, ellipsis included in the 280 cap', () => {
    const c = buildSearchResponse([makeRow({ excerpt: `${'alpha '.repeat(80)}omega` })], 'lk')
      .response.candidates![0]!;
    expect(c.excerpt.length).toBeLessThanOrEqual(280);
    expect(c.excerpt.endsWith('…')).toBe(true);
    // No half word before the ellipsis.
    expect(c.excerpt.slice(0, -1).endsWith('alpha')).toBe(true);
  });

  it('emits an empty string, never null, for a post with no excerpt', () => {
    const c = buildSearchResponse([makeRow({ excerpt: '' })], 'lk').response.candidates![0]!;
    expect(c.excerpt).toBe('');
  });

  it('hard-cuts a single unbroken word rather than emitting a bare ellipsis', () => {
    const c = buildSearchResponse([makeRow({ excerpt: 'x'.repeat(600) })], 'lk').response
      .candidates![0]!;
    expect(c.excerpt.length).toBe(280);
    expect(c.excerpt.endsWith('…')).toBe(true);
  });

  it('bounds temporalMode, which is an app-validated open registry', () => {
    const c = buildSearchResponse([makeRow({ temporalMode: 't'.repeat(500) })], 'lk').response
      .candidates![0]!;
    expect(c.temporalMode).toHaveLength(40);
  });
});

describe('budget degradation: shorten then drop excerpts before evicting (#501/#567)', () => {
  it('keeps every candidate at every projection cap by shortening the excerpt', () => {
    // maximalRows sits on every identity cap AND carries a 2kB excerpt, so the
    // full-excerpt page does not fit. No candidate may be lost to that.
    const { response } = buildSearchResponse(maximalRows(10), 'lk', 'hybrid-v1');
    expect(response.candidates).toHaveLength(10);
    expect('truncated' in response).toBe(false);
    expect(JSON.stringify(response).length).toBeLessThanOrEqual(searchBudgetChars(10));
    const excerpts = response.candidates!.map((c) => c.excerpt);
    // Shortened, not dropped, and uniformly across the page.
    expect(excerpts.every((e) => e.length > 0 && e.length <= 120)).toBe(true);
    expect(new Set(excerpts).size).toBe(1);
  });

  it('drops excerpts entirely before it evicts a candidate', () => {
    // Identity fields large enough that even the 120-char tier overruns: the last
    // tier empties the excerpt, and the whole page still ships.
    const rows = Array.from({ length: 10 }, (_, i) =>
      makeRow({
        postId: postId(i),
        slug: 's'.repeat(320),
        title: 'T'.repeat(200),
        handle: 'h'.repeat(80),
        excerpt: `${'word '.repeat(400)}end`,
      }),
    );
    const { response } = buildSearchResponse(rows, 'lk');
    expect(response.candidates).toHaveLength(10);
    expect(response.candidates!.every((c) => c.excerpt === '')).toBe(true);
    expect('truncated' in response).toBe(false);
  });

  it('still evicts, and flags truncated, when the identity fields alone overrun', () => {
    // Degradation is not a way out of a pathological slug: with excerpts already
    // empty the old eviction path is what runs.
    const rows = Array.from({ length: 10 }, (_, i) =>
      makeRow({ postId: postId(i), slug: 's'.repeat(4000), excerpt: 'e'.repeat(500) }),
    );
    const { response, emitted } = buildSearchResponse(rows, 'lk');
    expect(response.truncated).toBe(true);
    expect(response.candidates!.length).toBeLessThan(10);
    expect(response.candidates!.every((c) => c.excerpt === '')).toBe(true);
    expect(emitted.map((e) => e.rank)).toEqual(response.candidates!.map((_, i) => i + 1));
  });
});

describe('rank-1 inspect block (#528)', () => {
  it('inlines the bounded card subset bound to candidates[0]', () => {
    const { response, cardExposed } = buildSearchResponse(
      [makeRow({ price: 250000n }), makeRow({ postId: postId(2) })],
      'lk',
      'hybrid-v1',
      [],
      rankOne(),
    );
    const inspect = response.inspect!;
    expect(cardExposed).toBe(true);
    expect(Object.keys(inspect).sort()).toEqual(
      [
        'asOf',
        'exclusions',
        'free',
        'price',
        'questionsAnswered',
        'resourceId',
        'scope',
        'temporalMode',
        'url',
        'validUntil',
      ].sort(),
    );
    expect(inspect.resourceId).toBe(response.candidates![0]!.resourceId);
    expect(inspect.url).toBe(response.candidates![0]!.url);
    expect(inspect.questionsAnswered).toEqual([
      'What should an agent do when a stablecoin depegs?',
    ]);
    expect(inspect.scope).toBe('Stablecoin monitoring on Base');
    // The negative claim is mandatory: a block that can only say what a piece
    // covers is not a basis for a non-refundable buy (#528 amendment).
    expect(inspect.exclusions).toBe('Not legal advice');
    expect(inspect.free).toBe(false);
    expect(inspect.price).toBe('250000');
  });

  it('leaks no paid-adjacent card field', () => {
    const { response } = buildSearchResponse([makeRow()], 'lk', 'lexical-v1', [], rankOne());
    for (const field of [
      'tasksSupported',
      'appliesTo',
      'provenanceSummary',
      'methodologySummary',
      'cacheEligible',
      'body',
      'bodyMd',
    ]) {
      expect(field in response.inspect!).toBe(false);
    }
  });

  it('marks a zero-price piece free', () => {
    const { response } = buildSearchResponse(
      [makeRow({ price: 0n })],
      'lk',
      'lexical-v1',
      [],
      rankOne(),
    );
    expect(response.inspect!.free).toBe(true);
    expect(response.inspect!.price).toBe('0');
  });

  it('takes temporal fields from the candidate, so the two halves cannot disagree', () => {
    // The block reads its claims from the card and everything temporal from the
    // candidate, so there is no second source for the two to drift apart on.
    const { response } = buildSearchResponse(
      [makeRow({ temporalMode: 'snapshot', asOf: new Date('2026-07-01T00:00:00Z') })],
      'lk',
      'lexical-v1',
      [],
      rankOne(),
    );
    expect(response.inspect!.temporalMode).toBe('snapshot');
    expect(response.inspect!.asOf).toBe('2026-07-01T00:00:00.000Z');
    expect(response.inspect!.asOf).toBe(response.candidates![0]!.asOf);
  });

  it('bounds questionsAnswered and scope', () => {
    const { response } = buildSearchResponse(
      [makeRow()],
      'lk',
      'lexical-v1',
      [],
      rankOne(
        makeCard({
          questionsAnswered: Array.from({ length: 20 }, () => 'q'.repeat(500)),
          scope: 's'.repeat(2000),
        }),
      ),
    );
    expect(response.inspect!.questionsAnswered).toHaveLength(5);
    expect(response.inspect!.questionsAnswered.every((q) => q.length === 200)).toBe(true);
    // 500 is the write contract's own cap on scope, so a within-contract scope is
    // carried whole and only an over-contract one is cut.
    expect(response.inspect!.scope).toHaveLength(500);
  });

  it('omits `inspect` and reports no exposure when no card loaded', () => {
    const { response, cardExposed } = buildSearchResponse([makeRow()], 'lk');
    expect('inspect' in response).toBe(false);
    expect(cardExposed).toBe(false);
  });

  it('never rides a MISS', () => {
    const { response, cardExposed } = buildSearchResponse([], 'lk', 'lexical-v1', [], rankOne());
    expect(response.decision).toBe('MISS');
    expect('inspect' in response).toBe(false);
    expect(cardExposed).toBe(false);
  });

  it('costs no candidate: a full page fits with a maximal card inlined', () => {
    const maximalCard = makeCard({
      questionsAnswered: Array.from({ length: 20 }, () => 'q'.repeat(500)),
      scope: 's'.repeat(2000),
    });
    const { response } = buildSearchResponse(
      maximalRows(10),
      'lk',
      'hybrid-v1',
      [],
      rankOne(maximalCard, postId(0)),
    );
    expect(response.candidates).toHaveLength(10);
    expect('truncated' in response).toBe(false);
    expect(JSON.stringify(response).length).toBeLessThanOrEqual(searchBudgetChars(10, true));
    // Excerpt parity: the page degrades to exactly the same tier with and without
    // the card, so shrinking the block's allowance to zero fails here rather than
    // silently costing every candidate its excerpt.
    const bare = buildSearchResponse(maximalRows(10), 'lk', 'hybrid-v1');
    expect(response.candidates!.map((c) => c.excerpt)).toEqual(
      bare.response.candidates!.map((c) => c.excerpt),
    );
  });
});

describe('inspect block size (#528)', () => {
  // The write schemas cap claim LENGTH but not charset, and JSON.stringify turns
  // one control character into six (\u0001). So a card sitting inside every
  // SOURCE cap can serialize to several times the block's allowance. Before this
  // was measured, the excess was charged to the shared candidate page: the
  // reproduction dropped a 5-candidate page to 4 with truncated:true, which also
  // cost the evicted creator its lookup_candidates exposure row.
  const escapeHeavy = () =>
    makeCard({
      questionsAnswered: Array.from({ length: 4 }, () => '\u0001'.repeat(200)),
      scope: '\u0001'.repeat(400),
      exclusions: '\u0001'.repeat(500),
    });

  it('keeps an escape-heavy block inside its own serialized allowance', () => {
    const { response } = buildSearchResponse(
      [makeRow()],
      'lk',
      'lexical-v1',
      [],
      rankOne(escapeHeavy()),
    );
    // Either it degraded to fit, or it was dropped — never oversized.
    if (response.inspect) {
      // Derived from the exported budget rather than hard-coded, so the constant
      // and its guard move together.
      const allowance = searchBudgetChars(1, true) - searchBudgetChars(1);
      expect(JSON.stringify(response.inspect).length).toBeLessThanOrEqual(allowance);
    }
  });

  it('costs no candidate: an escape-heavy card evicts nobody', () => {
    // THE regression. Five candidates, rank 1 holding a card that is within every
    // source cap and wildly over budget once serialized.
    const rows = Array.from({ length: 5 }, (_, i) => makeRow({ postId: postId(i) }));
    const withCard = buildSearchResponse(
      rows,
      'lk',
      'lexical-v1',
      [],
      rankOne(escapeHeavy(), postId(0)),
    );
    const without = buildSearchResponse(rows, 'lk');
    expect(withCard.response.candidates).toHaveLength(5);
    expect('truncated' in withCard.response).toBe(false);
    // Same page, candidate for candidate, as if no card had been inlined.
    expect(withCard.response.candidates!.map((c) => c.resourceId)).toEqual(
      without.response.candidates!.map((c) => c.resourceId),
    );
    // And every emitted telemetry row survives, which is what an eviction costs
    // the creator who lost the slot.
    expect(withCard.emitted).toHaveLength(5);
  });

  it('drops claims before it drops the block, keeping the negative claim', () => {
    const { response } = buildSearchResponse(
      [makeRow()],
      'lk',
      'lexical-v1',
      [],
      rankOne(
        makeCard({
          questionsAnswered: Array.from({ length: 5 }, () => '\u0001'.repeat(200)),
          scope: 'plain scope',
          exclusions: 'plain exclusions',
        }),
      ),
    );
    expect(response.inspect).toBeDefined();
    expect(response.inspect!.questionsAnswered.length).toBeLessThan(5);
    expect(response.inspect!.exclusions).toBe('plain exclusions');
  });

  it('omits the block entirely when even a claimless one will not fit', () => {
    const { response, cardExposed } = buildSearchResponse(
      [makeRow()],
      'lk',
      'lexical-v1',
      [],
      rankOne(
        makeCard({
          questionsAnswered: [],
          scope: '\u0001'.repeat(400),
          exclusions: '\u0001'.repeat(500),
        }),
      ),
    );
    expect('inspect' in response).toBe(false);
    expect(cardExposed).toBe(false);
  });

  it('drops the block when the card belongs to a different post', () => {
    // A card loaded for another post would describe rank 1 with someone else's
    // claims, so the mismatch must drop the block rather than ship it.
    const { response, cardExposed } = buildSearchResponse(
      [makeRow()],
      'lk',
      'lexical-v1',
      [],
      rankOne(makeCard(), postId(9)),
    );
    expect('inspect' in response).toBe(false);
    expect(cardExposed).toBe(false);
  });
});

describe('surrogate safety', () => {
  // A lone high surrogate is not valid UTF-8: it survives JSON.stringify as an
  // unpaired \ud8xx escape and then fails the WHOLE parse in a strict client,
  // so one emoji at a cap boundary costs the caller every candidate.
  const PAIR = '\u{1F600}'; // 2 UTF-16 units

  const lone = (s: string) =>
    [...s].some((ch) => {
      const c = ch.charCodeAt(0);
      return c >= 0xd800 && c <= 0xdfff && ch.length === 1;
    });

  it('never cuts a title mid-pair', () => {
    for (let pad = 0; pad < 4; pad += 1) {
      const title = 'x'.repeat(pad) + PAIR.repeat(300);
      const c = buildSearchResponse([makeRow({ title })], 'lk').response.candidates![0]!;
      expect(lone(c.title), `pad ${pad}`).toBe(false);
      expect(JSON.parse(JSON.stringify(c.title))).toBe(c.title);
    }
  });

  it('never cuts an excerpt mid-pair', () => {
    for (let pad = 0; pad < 4; pad += 1) {
      const excerpt = 'x'.repeat(pad) + PAIR.repeat(300);
      const c = buildSearchResponse([makeRow({ excerpt })], 'lk').response.candidates![0]!;
      expect(lone(c.excerpt), `pad ${pad}`).toBe(false);
    }
  });
});

describe('clampAsOf (#449)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('passes a past asOf through untouched and null through as null', () => {
    expect(clampAsOf(new Date('2026-07-01T00:00:00Z')).iso).toBe('2026-07-01T00:00:00.000Z');
    expect(clampAsOf(new Date('2026-07-01T00:00:00Z')).clamped).toBe(false);
    expect(clampAsOf(null).iso).toBeNull();
  });

  it('clamps a future asOf to now and reports the clamp', () => {
    const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    const { iso, clamped } = clampAsOf(future);
    expect(clamped).toBe(true);
    expect(new Date(iso!).getTime()).toBeLessThan(future.getTime());
    expect(new Date(iso!).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('warns ONCE per request with a count, not once per clamped candidate', () => {
    // The endpoint is anonymous at 30/min, so a per-row warn is an amplifier a
    // caller controls: ten gamed rows must not buy ten log lines.
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const future = new Date(Date.now() + 60 * 60 * 1000);
    const rows = Array.from({ length: 10 }, (_, i) => makeRow({ postId: postId(i), asOf: future }));
    buildSearchResponse(rows, 'lk');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatchObject({ clamped: 10 });
  });

  it('clamps on the candidate, and the inspect block inherits it', () => {
    vi.spyOn(log, 'warn').mockImplementation(() => {});

    const future = new Date(Date.now() + 60 * 60 * 1000);
    const { response } = buildSearchResponse(
      [makeRow({ asOf: future })],
      'lk',
      'lexical-v1',
      [],
      rankOne(),
    );
    const asOf = response.candidates![0]!.asOf!;
    expect(new Date(asOf).getTime()).toBeLessThanOrEqual(Date.now());
    expect(response.inspect!.asOf).toBe(asOf);
  });
});
