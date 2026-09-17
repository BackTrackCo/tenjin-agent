// The decision view's RELEVANCE FLOOR (lib/search/index.ts confidentEnough):
// a candidate is either semantically close (confidence medium or better) or
// corroborated (a lexical hit beside a dense one). A row that is `low` AND
// uncorroborated is refused before the top-K cut, so when nothing better exists
// the shortlist is empty and `decision` is MISS — the first time /api/search has
// been able to say no since #744 OR-joined terms and indexed the whole paid body.
//
// Geometry: the stub embedder places a query at an exact cosine to basis(0), and
// a fixture's chunks are registered at basis(0), so `atCosine(t)` IS the dense
// similarity the confidence bucket reads. Thresholds are derived from the
// constants, never pinned.
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { uuidv7 } from 'uuidv7';
import * as schema from '@/lib/db/schema';
import { withApi } from '@/lib/api';
import { __resetRateLimitForTest } from '@/lib/rate-limit';
import { __resetQueryCacheForTest } from '@/lib/search/query-cache';
import { type EmbeddingProvider } from '@/lib/embeddings';
import { contentChunks } from '@/lib/content-chunks';
import { embedPostContent } from '@/lib/content-embeddings';
import { DENSE_COSINE_SIMILARITY_FLOOR } from '@/lib/search';
import { FUSION_LIMIT } from '@/lib/search/retrieve/candidates';
import { CONFIDENCE_MEDIUM_SIMILARITY } from '@/lib/search/project';
import { createUnifiedSearchHandler } from '@/app/api/search/route';
import { atCosine, basis, concept, reset as resetStubEmbedder, stub } from './_support/embedder';
import { startTestDb, stopTestDb, describeIntegration, type TestDb } from './_support/db';
import { makeCreator, makePost } from './_support/fixtures';
import { must } from './_support/assert';
import { createInlineScheduler } from './_support/scheduler';

let tdb: TestDb;

beforeAll(async () => {
  tdb = await startTestDb();
}, 60_000);

afterAll(async () => {
  if (tdb) await stopTestDb(tdb);
});

beforeEach(async () => {
  __resetQueryCacheForTest();
  await tdb.db.execute(sql`TRUNCATE TABLE ${schema.creators}, ${schema.lookups} CASCADE`);
  __resetRateLimitForTest();
  resetStubEmbedder();
});

const { runInline } = createInlineScheduler();

interface Body {
  calibration: string;
  matched: number;
  items: Array<{
    resourceId?: string;
    slug?: string;
    matchReasons: string[];
    confidence?: string;
    corroborated?: boolean;
  }>;
}

async function search(body: unknown, embedder: EmbeddingProvider | null = stub): Promise<Body> {
  const res = await withApi(
    '/test',
    createUnifiedSearchHandler(tdb.db, runInline, embedder),
  )(
    new NextRequest('https://tenjin.xyz/api/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  return (await res.json()) as Body;
}

/** A carded, eligible, published post whose title carries `title` and whose
 *  chunks all sit at `vec` (default basis(0)). */
async function seed(title: string, vec: number[] = basis(0), embed = true) {
  const creator = must(await makeCreator(tdb), 'creator');
  const post = must(
    await makePost(tdb, creator, {
      status: 'published',
      publishedAt: new Date('2026-01-01T00:00:00Z'),
      title,
      bodyMd: `${title}\n\nfixture ${uuidv7()}`,
    }),
    'post',
  );
  await tdb.db
    .insert(schema.resourceMetadata)
    .values({ postId: post.id, cacheEligible: true, questionsAnswered: [title] });
  if (embed) {
    for (const chunk of contentChunks(post.title, post.bodyMd)) concept(chunk, vec);
    await embedPostContent(tdb.db, stub, post.id);
  }
  return post;
}

// Between the dense floor and the medium bucket: a genuine dense hit, bucketed low.
const LOW = (DENSE_COSINE_SIMILARITY_FLOOR + CONFIDENCE_MEDIUM_SIMILARITY) / 2;
const MEDIUM = CONFIDENCE_MEDIUM_SIMILARITY + 0.03;

describeIntegration('POST /api/search (decision) — relevance floor', () => {
  it('refuses a lexical-only row in a hybrid response: one shared word is not a candidate', async () => {
    await seed('Kubernetes scaling best practices');
    // The query shares the word but is FAR from every chunk (unregistered → FAR).
    const body = await search({ view: 'decision', query: 'kubernetes' });

    expect(body.calibration).toBe('hybrid-v1');
    expect(body.matched).toBe(0);
    expect(body.items).toEqual([]);
  });

  it('refuses a low-cosine dense hit with no lexical corroboration', async () => {
    await seed('Provisioning fresh signing credentials');
    concept('quarterly capacity planning', atCosine(LOW));

    const body = await search({ view: 'decision', query: 'quarterly capacity planning' });

    expect(body.calibration).toBe('hybrid-v1');
    expect(body.matched).toBe(0);
  });

  it('keeps a low-cosine dense hit that the words corroborate', async () => {
    const post = await seed('Kubernetes scaling best practices');
    concept('kubernetes', atCosine(LOW));

    const body = await search({ view: 'decision', query: 'kubernetes' });

    expect(body.matched).toBe(1);
    const cand = must(body.items[0], 'candidate');
    expect(cand.resourceId).toBe(post.id);
    expect(cand.confidence).toBe('low');
    expect(cand.corroborated).toBe(true);
  });

  it('keeps a medium dense hit and drops the lexical-only tail beside it', async () => {
    const near = await seed('Kubernetes scaling best practices');
    // Shares the word, sits on an orthogonal concept: lexical-only, refused.
    await seed('Kubernetes trivia night questions', basis(7));
    concept('kubernetes', atCosine(MEDIUM));

    const body = await search({ view: 'decision', query: 'kubernetes' });

    expect(body.matched).toBe(1);
    const cand = must(body.items[0], 'candidate');
    expect(cand.resourceId).toBe(near.id);
    expect(cand.confidence).toBe('medium');
  });

  it('does not floor a lexical-v1 response: with no dense leg nothing can corroborate', async () => {
    const post = await seed('Kubernetes scaling best practices');

    const body = await search({ view: 'decision', query: 'kubernetes' }, null);

    expect(body.calibration).toBe('lexical-v1');
    expect(body.matched).toBe(1);
    expect(must(body.items[0], 'candidate').resourceId).toBe(post.id);
  });

  /**
   * THE WINDOW FLAW, closed. The dense leg keeps its top-FUSION_LIMIT posts;
   * with 50 nearer pieces in front, a piece that genuinely matches on meaning
   * AND words never enters that window. Before the backfill it was refused as
   * "uncorroborated" (window membership stood in for evidence); now it is
   * scored on its own cosine and kept — ranked, not erased.
   */
  it('keeps a piece the dense window evicted, scored on its own cosine', async () => {
    concept('kubernetes', basis(0));
    // FUSION_LIMIT decoys at cosine 1, no shared word: they fill the window.
    for (let i = 0; i < FUSION_LIMIT; i += 1) await seed(`Decoy piece number ${i}`, basis(0));
    const target = await seed('Kubernetes scaling best practices', atCosine(MEDIUM));

    const body = await search({ view: 'decision', query: 'kubernetes', limit: 10 });

    expect(body.calibration).toBe('hybrid-v1');
    const cand = body.items.find((c) => c.resourceId === target.id);
    expect(cand).toBeDefined();
    expect(cand?.confidence).toBe('medium');
    expect(cand?.corroborated).toBe(true);
    expect(cand?.matchReasons).toEqual(['title/excerpt lexical match', 'semantic match']);
  });

  it('does not floor a fresh piece whose vectors have not landed yet', async () => {
    // Never embedded: content_embedded_at NULL, updated_at now. The lexical hit
    // stands on its own until the afterResponse embed or the sweep catches up.
    const post = await seed('Kubernetes scaling best practices', basis(0), false);

    const body = await search({ view: 'decision', query: 'kubernetes' });

    expect(body.matched).toBe(1);
    const cand = must(body.items[0], 'candidate');
    expect(cand.resourceId).toBe(post.id);
    expect(cand.confidence).toBe('low');
  });

  it('stops exempting an unembedded piece after a day, and never a reconciled empty one', async () => {
    const stale = await seed('Kubernetes scaling best practices', basis(0), false);
    await tdb.db
      .update(schema.posts)
      .set({ updatedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) })
      .where(eq(schema.posts.id, stale.id));
    expect((await search({ view: 'decision', query: 'kubernetes' })).matched).toBe(0);

    await tdb.db.execute(sql`TRUNCATE TABLE ${schema.creators}, ${schema.lookups} CASCADE`);
    __resetQueryCacheForTest();
    // Reconciled to zero chunks: the sweep stamped it, no vectors exist. Not a
    // gap — a body with nothing to embed — so a title word alone is not enough.
    const empty = await seed('Kubernetes scaling best practices', basis(0), false);
    await tdb.db
      .update(schema.posts)
      .set({ contentEmbeddedAt: sql`${schema.posts.updatedAt}` })
      .where(eq(schema.posts.id, empty.id));
    expect((await search({ view: 'decision', query: 'kubernetes' })).matched).toBe(0);
  });

  it('judges an embedded piece on its vectors even after a metadata-only edit', async () => {
    // Vectors present and FAR from the query; then a price change bumps
    // updated_at without any embed, so awaitingEmbed reads true. The word match
    // alone must not carry it: a piece with vectors is scored on them.
    const post = await seed('Kubernetes scaling best practices');
    await tdb.db
      .update(schema.posts)
      .set({ price: 250000n, updatedAt: new Date() })
      .where(eq(schema.posts.id, post.id));

    const body = await search({ view: 'decision', query: 'kubernetes' });

    expect(body.matched).toBe(0);
  });

  it('leaves the display view unfloored: the directory still lists a word match', async () => {
    const post = await seed('Kubernetes scaling best practices');

    const body = await search({ view: 'display', query: 'kubernetes' });

    expect(body.matched).toBeGreaterThan(0);
    expect(body.items.some((c) => c.slug === post.slug)).toBe(true);
  });
});
