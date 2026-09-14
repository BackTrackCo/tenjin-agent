// Pure-surface tests for the decision-view contracts in lib/search: the
// freshWithin parser, the request-schema bounds, and the fuse/rank pure stages.
// The response projection/budget lives in lib/search-response.test.ts; the
// DB-backed retrieval + gates in tests/integration/agent-search.test.ts.
import { describe, it, expect } from 'vitest';
import {
  bestPerPost,
  CREATOR_DIVERSITY_CAP,
  DENSE_COSINE_SIMILARITY_FLOOR,
  diversifyByCreator,
  freshWithinDays,
  fuseByRank,
  fuseLookups,
  lookupRequestSchema,
  type DenseRow,
  type LookupRow,
} from '@/lib/search';

// The bracket in tests/integration/lookup-hybrid.test.ts derives its fixtures FROM this
// constant, so it pins the gate (strict <, right direction) but is invariant to the
// value: every floor passes there, including a fat-fingered 0.053. This is the only
// assertion on the value, and it pins the reason rather than a copy.
//
// (0.4675, 0.4718] is the band the 2026-08-16 #628 sweep leaves, measured against
// content_embeddings rather than the card vectors #506 swept: the upper edge is the
// LOWEST expected-piece similarity in the gold set, so anything above it makes a
// genuine hit abstain, and the lower edge is the median MISS-entry noise, so anything
// at or below it starts admitting near-topic noise. Moving outside means a new sweep,
// so these edges move deliberately.
it('keeps the dense cosine floor inside the #628 sweep band', () => {
  expect(DENSE_COSINE_SIMILARITY_FLOOR).toBeGreaterThan(0.4675);
  expect(DENSE_COSINE_SIMILARITY_FLOOR).toBeLessThanOrEqual(0.4718);
});

describe('freshWithinDays', () => {
  it('maps units to whole-day windows (W=7, M=30, Y=365)', () => {
    expect(freshWithinDays('P30D')).toBe(30);
    expect(freshWithinDays('P2W')).toBe(14);
    expect(freshWithinDays('P3M')).toBe(90);
    expect(freshWithinDays('P1Y')).toBe(365);
  });
  it('rejects a zero window and malformed shapes', () => {
    expect(freshWithinDays('P0D')).toBeNull();
    expect(freshWithinDays('P0W')).toBeNull();
    expect(freshWithinDays('P1X')).toBeNull();
    expect(freshWithinDays('30D')).toBeNull();
    expect(freshWithinDays('P10000D')).toBeNull(); // 5 digits, out of \d{1,4}
    expect(freshWithinDays('')).toBeNull();
  });
});

describe('lookupRequestSchema', () => {
  const base = { schemaVersion: 2 as const, question: 'does vercel respect .nvmrc' };

  it('parses a minimal request, defaulting limit to 5', () => {
    const r = lookupRequestSchema.parse(base);
    expect(r.limit).toBe(5);
    expect(r.question).toBe('does vercel respect .nvmrc');
  });

  it('trims the question and rejects an empty/oversize one', () => {
    expect(lookupRequestSchema.parse({ ...base, question: '  hi  ' }).question).toBe('hi');
    expect(lookupRequestSchema.safeParse({ ...base, question: '   ' }).success).toBe(false);
    expect(lookupRequestSchema.safeParse({ ...base, question: 'x'.repeat(513) }).success).toBe(
      false,
    );
  });

  it('STRIPS an unknown key but still rejects any schemaVersion but 2', () => {
    // Strict rejection killed 19 of 19 external calls over fields this endpoint
    // does not even read (#620), so an unknown key is stripped and reported in
    // `warnings` by the route. The version pin stays fatal: a v1-pinned client
    // must fail loudly rather than misparse a v2 body.
    const stripped = lookupRequestSchema.safeParse({ ...base, note: 'x' });
    expect(stripped.success).toBe(true);
    expect(stripped.data).not.toHaveProperty('note');
    expect(lookupRequestSchema.safeParse({ ...base, schemaVersion: 3 }).success).toBe(false);
    expect(lookupRequestSchema.safeParse({ ...base, schemaVersion: 0 }).success).toBe(false);
  });

  it('accepts query and q as spellings of question, question winning (#620)', () => {
    const q = lookupRequestSchema.safeParse({ q: 'stablecoin depeg' });
    expect(q.success && q.data.question).toBe('stablecoin depeg');
    const query = lookupRequestSchema.safeParse({ query: 'stablecoin depeg' });
    expect(query.success && query.data.question).toBe('stablecoin depeg');
    // Precedence, rather than rejection: a caller hedging with two spellings gets
    // a search, and the route reports the redundant one.
    const both = lookupRequestSchema.safeParse({ question: 'first', query: 'second' });
    expect(both.success && both.data.question).toBe('first');
    // None at all is still a 400: stripping must not turn a question-less body
    // into a silent catalog dump.
    expect(lookupRequestSchema.safeParse({ limit: 5 }).success).toBe(false);
  });

  it('defaults an omitted schemaVersion to the latest version', () => {
    const r = lookupRequestSchema.parse({ question: 'does vercel respect .nvmrc' });
    expect(r.schemaVersion).toBe(2);
  });

  it('treats an explicit null as a value, not an omission', () => {
    // .default() intercepts undefined only, so a null 400s. Deliberate: every other
    // optional here (limit included, which also carries a default) rejects null the
    // same way, and a client that serializes absent fields as null is already 400ing
    // on freshWithin/maxPrice/limit — making this one field nullish would not save it.
    const parsed = lookupRequestSchema.safeParse({ question: 'q', schemaVersion: null });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.flatten().fieldErrors.schemaVersion).toBeDefined();
  });

  it('rejects schemaVersion 1 outright, naming the field', () => {
    // v1 candidates carried answer-card fields v2 does not, so a pinned v1 client
    // has to fail loudly instead of parsing a v2 body as if it were v1.
    const parsed = lookupRequestSchema.safeParse({ ...base, schemaVersion: 1 });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.flatten().fieldErrors.schemaVersion).toBeDefined();
  });

  it('transforms freshWithin to a day count and rejects a zero window', () => {
    expect(lookupRequestSchema.parse({ ...base, freshWithin: 'P30D' }).freshWithin).toBe(30);
    expect(lookupRequestSchema.safeParse({ ...base, freshWithin: 'P0D' }).success).toBe(false);
  });

  it('rejects a non-canonical appliesTo key and an out-of-range limit', () => {
    expect(
      lookupRequestSchema.safeParse({ ...base, appliesTo: { Products: ['Vercel'] } }).success,
    ).toBe(false);
    expect(
      lookupRequestSchema.safeParse({ ...base, appliesTo: { products: ['Vercel'] } }).success,
    ).toBe(true);
    // An empty value array is a meaningless (no-op) constraint, not a filter.
    expect(lookupRequestSchema.safeParse({ ...base, appliesTo: { products: [] } }).success).toBe(
      false,
    );
    expect(lookupRequestSchema.safeParse({ ...base, limit: 0 }).success).toBe(false);
    expect(lookupRequestSchema.safeParse({ ...base, limit: 11 }).success).toBe(false);
  });

  it('enforces appliesTo bounds: ≤8 keys, ≤20 values/key, ≤120 chars/value', () => {
    const keys = (n: number): Record<string, string[]> =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, ['v']]));
    // Boundary: 8 keys / 20 values / 120-char value all pass.
    expect(lookupRequestSchema.safeParse({ ...base, appliesTo: keys(8) }).success).toBe(true);
    expect(
      lookupRequestSchema.safeParse({
        ...base,
        appliesTo: { products: Array.from({ length: 20 }, (_, i) => `v${i}`) },
      }).success,
    ).toBe(true);
    expect(
      lookupRequestSchema.safeParse({ ...base, appliesTo: { products: ['v'.repeat(120)] } })
        .success,
    ).toBe(true);
    // One past each bound is rejected.
    expect(lookupRequestSchema.safeParse({ ...base, appliesTo: keys(9) }).success).toBe(false);
    expect(
      lookupRequestSchema.safeParse({
        ...base,
        appliesTo: { products: Array.from({ length: 21 }, (_, i) => `v${i}`) },
      }).success,
    ).toBe(false);
    expect(
      lookupRequestSchema.safeParse({ ...base, appliesTo: { products: ['v'.repeat(121)] } })
        .success,
    ).toBe(false);
  });

  it('rejects a non-digit maxPrice', () => {
    expect(lookupRequestSchema.safeParse({ ...base, maxPrice: '100000' }).success).toBe(true);
    expect(lookupRequestSchema.safeParse({ ...base, maxPrice: '1.5' }).success).toBe(false);
  });
});

// Minimal LookupRow — only the fields fusion reads (postId) matter here; the rest
// are filler so the pure RRF math can be tested without a DB.
function row(postId: string, over: Partial<LookupRow> = {}): LookupRow {
  return {
    postId,
    slug: postId,
    title: postId,
    price: 0n,
    handle: 'h',
    artifactType: 'document',
    excerpt: '',
    temporalMode: 'evergreen',
    asOf: null,
    validUntil: null,
    wordCount: 0,
    cacheEligible: true,
    carded: true,
    postHit: false,
    ...over,
  };
}
const denseRow = (postId: string, similarity: number): DenseRow => ({
  ...row(postId),
  similarity,
});

describe('fuseLookups (RRF, k=60)', () => {
  it('ranks a both-legs post above single-leg posts (contributions sum)', () => {
    // lexOnly and denseOnly each sit at rank 1 of one leg; both is rank 1 of both.
    const lexical = [row('both'), row('lexOnly')];
    const dense = [denseRow('both', 0.9), denseRow('denseOnly', 0.8)];
    const fused = fuseLookups(lexical, dense, 10);
    expect(fused[0]!.postId).toBe('both');
    expect(new Set(fused.map((r) => r.postId))).toEqual(new Set(['both', 'lexOnly', 'denseOnly']));
  });

  it('marks a post that appeared in the dense leg with semanticHit', () => {
    const fused = fuseLookups([row('lexOnly')], [denseRow('lexOnly', 0.9), denseRow('d', 0.8)], 10);
    const byId = new Map(fused.map((r) => [r.postId, r]));
    // lexOnly was also a dense hit -> semanticHit true; a lexical-only post is false.
    expect(byId.get('lexOnly')!.semanticHit).toBe(true);
    expect(byId.get('d')!.semanticHit).toBe(true);
    const lexicalPure = fuseLookups([row('x')], [], 10);
    expect(lexicalPure[0]!.semanticHit).toBe(false);
  });

  it('honors the final limit after fusing a deeper list', () => {
    const lexical = Array.from({ length: 5 }, (_, i) => row(`l${i}`));
    const dense = Array.from({ length: 5 }, (_, i) => denseRow(`d${i}`, 0.9 - i * 0.01));
    expect(fuseLookups(lexical, dense, 3)).toHaveLength(3);
  });

  it('respects leg rank: an earlier lexical rank outscores a later one', () => {
    // No dense overlap; pure lexical order must survive fusion.
    const fused = fuseLookups([row('first'), row('second'), row('third')], [], 10);
    expect(fused.map((r) => r.postId)).toEqual(['first', 'second', 'third']);
  });

  it('carries the fused score on every row, and copies similarity only where the dense leg placed it', () => {
    const lexical = [row('both'), row('lexOnly')];
    const dense = [denseRow('both', 0.91), denseRow('denseOnly', 0.82)];
    const fused = fuseLookups(lexical, dense, 10);
    const byId = new Map(fused.map((r) => [r.postId, r]));
    // RRF sums a contribution for every fused row, including a lexical-only one.
    expect(byId.get('both')!.score).toBeGreaterThan(0);
    expect(byId.get('lexOnly')!.score).toBeGreaterThan(0);
    expect(byId.get('denseOnly')!.score).toBeGreaterThan(0);
    // 'both' keeps the PRIMARY (lexical) row object internally (fuseByRank never
    // overwrites `row` on a merge), so a correct similarity here proves it was
    // read back off `dense`, not assumed present on the merged object.
    expect(byId.get('both')!.similarity).toBeCloseTo(0.91);
    expect(byId.get('denseOnly')!.similarity).toBeCloseTo(0.82);
    expect(byId.get('lexOnly')!.similarity).toBeUndefined();
  });
});

// The generic fusion the candidate legs and the browse tail (lib/search-browse.ts
// queryBrowseTail) share, so neither can drift on k or the tie-break.
describe('fuseByRank', () => {
  it('sums both legs, flags the secondary, and returns the WHOLE fused list', () => {
    const fused = fuseByRank(
      [{ postId: 'both' }, { postId: 'primaryOnly' }],
      [{ postId: 'both' }, { postId: 'secondaryOnly' }],
    );
    expect(fused.map((f) => f.row.postId)).toEqual(['both', 'primaryOnly', 'secondaryOnly']);
    expect(fused.map((f) => f.inSecondary)).toEqual([true, false, true]);
  });

  it('tie-breaks an equal score on the primary leg rank', () => {
    // p2 and s1 both sit at 1/(60+2): p2 is primary rank 2, s1 has no primary
    // rank, so p2 wins the tie.
    const fused = fuseByRank(
      [{ postId: 'p1' }, { postId: 'p2' }],
      [{ postId: 's0' }, { postId: 's1' }],
    );
    expect(fused.map((f) => f.row.postId)).toEqual(['p1', 's0', 'p2', 's1']);
  });
});

describe('bestPerPost', () => {
  // Rows arrive nearest-first, so the first row for a post is its best vector.
  const rows = [
    { postId: 'a', distance: 0.1 },
    { postId: 'b', distance: 0.4 },
    { postId: 'a', distance: 0.9 },
    { postId: 'c', distance: 0.8 },
  ];

  it('keeps the nearest vector per post and applies the floor', () => {
    const kept = bestPerPost(rows, 0.45);
    expect(kept.map((r) => r.postId)).toEqual(['a', 'b']);
    expect(kept[0]!.similarity).toBeCloseTo(0.9);
  });

  it('keeps every nearest neighbour when the floor is null (the browse tail)', () => {
    expect(bestPerPost(rows, null).map((r) => r.postId)).toEqual(['a', 'b', 'c']);
  });
});

describe('diversifyByCreator (#528)', () => {
  // Rank-ordered rows named by their creator, so a result reads as the shape of
  // the shortlist rather than a list of ids.
  const shortlist = (handles: string[]) => handles.map((handle, i) => ({ handle, id: i }));
  const handles = (rows: { handle: string }[]) => rows.map((r) => r.handle);

  it('caps one creator at 3 and promotes qualifying alternatives into the surplus slots', () => {
    const rows = shortlist(['a', 'a', 'a', 'a', 'a', 'b', 'c']);
    expect(handles(diversifyByCreator(rows, 5))).toEqual(['a', 'a', 'a', 'b', 'c']);
  });

  it('is a no-op when no alternative creator exists', () => {
    const rows = shortlist(['a', 'a', 'a', 'a', 'a']);
    expect(diversifyByCreator(rows, 5)).toEqual(rows);
  });

  it('falls back to the capped creator rather than under-filling the page', () => {
    // One alternative for two surplus slots: the last slot goes back to `a`
    // instead of returning four candidates.
    const rows = shortlist(['a', 'a', 'a', 'a', 'a', 'b']);
    expect(handles(diversifyByCreator(rows, 5))).toEqual(['a', 'a', 'a', 'b', 'a']);
  });

  it('keeps deferred rows in rank order when several fall back', () => {
    const rows = shortlist(['a', 'a', 'a', 'a', 'a', 'a', 'b']);
    const out = diversifyByCreator(rows, 6);
    expect(handles(out)).toEqual(['a', 'a', 'a', 'b', 'a', 'a']);
    expect(out.map((r) => r.id)).toEqual([0, 1, 2, 6, 3, 4]);
  });

  it('changes nothing when no creator is over the cap', () => {
    const rows = shortlist(['a', 'b', 'a', 'c', 'b']);
    expect(diversifyByCreator(rows, 5)).toEqual(rows);
  });

  it('applies the cap within the requested limit, not across the deeper list', () => {
    // A 4th `a` beyond the page is not a violation: only the emitted page is capped.
    const rows = shortlist(['a', 'a', 'a', 'b', 'a']);
    expect(handles(diversifyByCreator(rows, 3))).toEqual(['a', 'a', 'a']);
  });

  it('never returns more than the limit, and never invents rows', () => {
    const rows = shortlist(['a', 'a', 'a', 'a', 'b', 'b']);
    for (const limit of [1, 2, 3, 4, 5, 6, 10]) {
      const out = diversifyByCreator(rows, limit);
      expect(out.length, `limit ${limit}`).toBe(Math.min(limit, rows.length));
      expect(new Set(out.map((r) => r.id)).size, `limit ${limit}`).toBe(out.length);
    }
  });

  it('defaults to the exported cap', () => {
    const rows = shortlist(Array.from({ length: 10 }, () => 'a').concat(['b']));
    const capped = handles(diversifyByCreator(rows, 10)).filter((h) => h === 'a').length;
    expect(handles(diversifyByCreator(rows, 10)).indexOf('b')).toBe(CREATOR_DIVERSITY_CAP);
    expect(capped).toBe(9);
  });
});
