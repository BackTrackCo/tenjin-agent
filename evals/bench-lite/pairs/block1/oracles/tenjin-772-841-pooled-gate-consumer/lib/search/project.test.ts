// The inline free body and the `strong` flag on the projected candidate. Both are
// pure over the rows buildSearchResponse receives, so they pin here with
// synthetic rows; the DB-backed select and the read row live in
// tests/integration/agent-search.test.ts. The older projection cases (budget,
// inspect, match reasons) stay in lib/search-response.test.ts.
import { describe, expect, it } from 'vitest';
import {
  CONFIDENCE_MEDIUM_SIMILARITY,
  buildSearchResponse,
  searchBudgetChars,
} from '@/lib/search/project';
import { DENSE_COSINE_SIMILARITY_FLOOR } from '@/lib/search/fuse';
import type { LookupRow } from '@/lib/search';

function postId(i: number): string {
  return `0190a0b0-0000-7000-8000-${String(i).padStart(12, '0')}`;
}

const CREATOR = '0190a0b0-0000-7000-8000-0000000000c1';

function makeRow(over: Partial<LookupRow> = {}): LookupRow {
  return {
    postId: postId(1),
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

const freeRow = (i: number) => makeRow({ postId: postId(i), slug: `free-${i}`, price: 0n });
const paidRow = (i: number) => makeRow({ postId: postId(i), slug: `paid-${i}`, price: 250000n });
const bodyFor = (i: number, bodyMd: string) => ({ postId: postId(i), creatorId: CREATOR, bodyMd });

describe('inline free body', () => {
  it('rides every free row whatever its rank, and never a paid one', () => {
    const rows = [paidRow(1), freeRow(2), paidRow(3), freeRow(4)];
    const bodies = [
      bodyFor(1, 'paid one'),
      bodyFor(2, 'free two'),
      bodyFor(3, 'paid three'),
      bodyFor(4, 'free four'),
    ];
    const { response, bodiesServed } = buildSearchResponse(rows, 'lk', 'lexical-v1', null, bodies);
    const c = response.candidates!;
    expect('body' in c[0]!).toBe(false);
    expect(c[1]!.body).toEqual({ text: 'free two' });
    expect('body' in c[2]!).toBe(false);
    expect(c[3]!.body).toEqual({ text: 'free four' });
    expect(bodiesServed).toEqual([
      { postId: postId(2), creatorId: CREATOR },
      { postId: postId(4), creatorId: CREATOR },
    ]);
  });

  it('carries three bodies for three free rows', () => {
    const rows = [freeRow(1), freeRow(2), freeRow(3)];
    const bodies = rows.map((r, i) => bodyFor(i + 1, `piece ${i + 1} ${r.slug}`));
    const { response, bodiesServed } = buildSearchResponse(rows, 'lk', 'lexical-v1', null, bodies);
    expect(response.candidates!.map((c) => c.body?.text)).toEqual([
      'piece 1 free-1',
      'piece 2 free-2',
      'piece 3 free-3',
    ]);
    expect(bodiesServed).toHaveLength(3);
  });

  it('is absent, with nothing served, when no body was loaded', () => {
    const { response, bodiesServed } = buildSearchResponse([freeRow(1)], 'lk');
    expect('body' in response.candidates![0]!).toBe(false);
    expect(bodiesServed).toEqual([]);
    expect(buildSearchResponse([], 'lk').bodiesServed).toEqual([]);
  });

  it('drops a body off the page, and ships none for a free row the select skipped', () => {
    const { response, bodiesServed } = buildSearchResponse(
      [freeRow(1), freeRow(2)],
      'lk',
      'lexical-v1',
      null,
      [bodyFor(9, 'not on the page'), bodyFor(2, 'free two')],
    );
    const [a, b] = response.candidates!;
    expect('body' in a!).toBe(false);
    expect(b!.body).toEqual({ text: 'free two' });
    expect(bodiesServed).toEqual([{ postId: postId(2), creatorId: CREATOR }]);
  });

  it('sits outside the size backstop: a full page of long bodies is never truncated', () => {
    const rows = Array.from({ length: 10 }, (_, i) => freeRow(i + 1));
    const bodies = rows.map((_, i) => bodyFor(i + 1, `${'word '.repeat(2000)}end`));
    const { response, bodiesServed } = buildSearchResponse(rows, 'lk', 'lexical-v1', null, bodies);
    expect(response.candidates).toHaveLength(10);
    expect('truncated' in response).toBe(false);
    expect(bodiesServed).toHaveLength(10);
    // The page's own allowance is what the backstop measures; ten long bodies
    // dwarf it, so a body counted against it would have evicted rows.
    expect(JSON.stringify(response).length).toBeGreaterThan(searchBudgetChars(10));
    for (const c of response.candidates!) expect(c.body!.text.endsWith('end')).toBe(true);
  });
});

describe('strong', () => {
  const fused = (over: Partial<LookupRow>) => makeRow({ score: 0.05, ...over });
  const strongOf = (row: LookupRow, calibration: 'hybrid-v1' | 'lexical-v1' | 'key-v1') =>
    buildSearchResponse([row], 'lk', calibration).response.candidates![0]!;

  it('is true only when corroborated and confidence is not low', () => {
    const above = CONFIDENCE_MEDIUM_SIMILARITY + 0.05;
    const corroboratedMedium = strongOf(
      fused({ postHit: true, pooledSimilarity: above }),
      'hybrid-v1',
    );
    expect(corroboratedMedium.confidence).toBe('medium');
    expect(corroboratedMedium.corroborated).toBe(true);
    expect(corroboratedMedium.strong).toBe(true);

    // Corroborated, but the pooled score sits between the dense floor and the
    // medium bucket: `low` confidence keeps it off the delivery bar.
    const belowMedium = (DENSE_COSINE_SIMILARITY_FLOOR + CONFIDENCE_MEDIUM_SIMILARITY) / 2;
    const corroboratedLow = strongOf(
      fused({ postHit: true, pooledSimilarity: belowMedium }),
      'hybrid-v1',
    );
    expect(corroboratedLow.confidence).toBe('low');
    expect(corroboratedLow.corroborated).toBe(true);
    expect(corroboratedLow.strong).toBe(false);
  });

  it('is false on a high but uncorroborated row', () => {
    const c = strongOf(fused({ postHit: false, pooledSimilarity: 0.9 }), 'hybrid-v1');
    expect(c.confidence).toBe('high');
    expect(c.corroborated).toBe(false);
    expect(c.strong).toBe(false);
  });

  it('is absent on lexical-v1, like its two inputs', () => {
    const c = strongOf(makeRow({ postHit: true }), 'lexical-v1');
    expect('strong' in c).toBe(false);
    expect('confidence' in c).toBe(false);
  });

  it('is true on every key-v1 row', () => {
    const c = strongOf(makeRow({ keyHit: true }), 'key-v1');
    expect(c.confidence).toBe('high');
    expect(c.corroborated).toBe(true);
    expect(c.strong).toBe(true);
  });
});

// #839: the per-piece dense score the GATE reads is the MEAN of a post's top-3
// chunk cosines, not the max over its chunks. Max rises with chunk count by
// construction, so a long generic piece cleared a fixed threshold on one lucky
// passage. Ordering keeps max; only these three readers moved.
describe('pooled gate (#839)', () => {
  const fused = (over: Partial<LookupRow>) => makeRow({ score: 0.05, ...over });
  const candidateOf = (row: LookupRow) =>
    buildSearchResponse([row], 'lk', 'hybrid-v1').response.candidates![0]!;

  it('buckets on the pooled score, not the max, when the two disagree', () => {
    // The shape the issue is about: one hot chunk in a long piece. Its max is
    // above the `high` threshold, but only one of its twenty chunks is close,
    // so the mean of its best three lands under `medium`.
    const longGeneric = candidateOf(
      fused({
        postHit: true,
        semanticHit: true,
        similarity: 0.71,
        pooledSimilarity: 0.4,
        chunkCount: 20,
      }),
    );
    expect(longGeneric.confidence).toBe('low');
    // Below the dense floor once pooled, so the lexical hit no longer
    // corroborates a semantic one.
    expect(longGeneric.corroborated).toBe(false);
    expect(longGeneric.strong).toBe(false);
    // The reason still names the beam: `semanticHit` is window membership, a
    // fact about what the scan returned, and it is not a gate.
    expect(longGeneric.matchReasons).toEqual([
      'identifier/title/excerpt lexical match',
      'semantic match',
    ]);

    // The same piece off the beam claims no semantic match: the reason falls
    // back to the row's own score, and pooled is what that now means.
    const offBeam = candidateOf(
      fused({ postHit: true, similarity: 0.71, pooledSimilarity: 0.4, chunkCount: 20 }),
    );
    expect(offBeam.matchReasons).toEqual(['identifier/title/excerpt lexical match']);

    // The short piece the long one was outranking: two chunks, both hot, so
    // pooling over what it has leaves it where max did.
    const shortFocused = candidateOf(
      fused({
        postHit: true,
        semanticHit: true,
        similarity: 0.71,
        pooledSimilarity: 0.69,
        chunkCount: 2,
      }),
    );
    expect(shortFocused.confidence).toBe('high');
    expect(shortFocused.corroborated).toBe(true);
    expect(shortFocused.strong).toBe(true);
  });

  it('never serializes the pooled score or the chunk count', () => {
    // Same non-surfacing boundary the raw cosine sits behind (#628): both are
    // derived from the paid body, so neither may reach a caller.
    const c = candidateOf(
      fused({
        postHit: true,
        semanticHit: true,
        similarity: 0.8,
        pooledSimilarity: 0.75,
        chunkCount: 7,
      }),
    );
    expect('pooledSimilarity' in c).toBe(false);
    expect('chunkCount' in c).toBe(false);
    expect('similarity' in c).toBe(false);
    expect(JSON.stringify(c)).not.toContain('chunkCount');
  });

  it('is `low` with no pooled score at all, whatever the max says', () => {
    // A post with no vectors carries neither number. A row that somehow carries
    // only a max is judged the same way: the gate reads the pooled score, so
    // there is nothing here to bucket on.
    expect(candidateOf(fused({ postHit: true })).confidence).toBe('low');
    expect(candidateOf(fused({ postHit: true, similarity: 0.99 })).confidence).toBe('low');
  });
});
